-- ============================================================
-- 2026-08-20: favoritos del cliente EN LA BASE (tabla + RPC por token)
--
-- Contexto (a pedido del usuario, quinta tanda del día): la primera versión
-- de favoritos (misma fecha, cuarta tanda) vivía solo en localStorage del
-- teléfono. El usuario pidió pasarlos a una tabla con RPC por token "y así
-- queda un registro de los favoritos de cada uno de los clientes" — el
-- corazón deja de ser un dato del dispositivo y pasa a ser un dato del
-- negocio: sobrevive al cambio de teléfono y la vendedora/admin lo puede
-- consultar (hay policies de lectura listas; UI del panel, cuando se pida).
--
-- Las piezas:
--   * `client_favorites (client_id, product_id, created_at)` — RLS: lectura
--     para admin (todo) y vendedora (solo sus clientes), en la forma InitPlan
--     obligatoria desde migration-2026-08-20-rls-initplan.sql; SIN policy de
--     escritura para nadie — se escribe únicamente vía la RPC.
--   * `set_favorite(p_token, p_product_id, p_fav)` — el cliente del catálogo
--     corre como `anon` y se identifica por token, igual que create_order.
--     Idempotente (on conflict / delete if exists) y a prueba de basura:
--     token inválido, producto inexistente o apagado, o tope superado
--     devuelven null SIN excepción — un corazón jamás genera un 500.
--   * `get_catalog` devuelve `is_fav` por producto (las dos ramas): el
--     catálogo arranca con los corazones del SERVIDOR en el mismo
--     round-trip de siempre, sin una llamada extra.
--
-- ANTI-ABUSO (la RPC es pública por diseño, como log_event):
--   * sin token válido no se escribe NADA (ni rastro);
--   * tope de 500 favoritos por cliente — nadie tiene 500 favoritos reales y
--     sin tope la tabla sería inflable a costo cero;
--   * solo productos activos se pueden marcar (el catálogo no muestra otros);
--   * la tabla no se puede escribir por PostgREST (RLS sin policy de insert).
--
-- El FRONTEND queda con el localStorage como CACHÉ de arranque y fallback:
-- al cargar el catálogo pinta los corazones cacheados al instante, y cuando
-- llega get_catalog manda el servidor (is_fav) y se reescribe el caché. Si
-- esta migración no corrió, `is_fav` llega undefined y los favoritos siguen
-- funcionando exactamente como la v1 (solo dispositivo) — no bloquea deploy.
--
-- Idempotente (if not exists / create or replace). REQUIERE
-- migration-2026-08-20-top-by-line.sql (este get_catalog es copia del suyo
-- más `is_fav`); el preflight corta si falta.
-- ============================================================
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regprocedure('public.top_seller_ids_by_line(int, int)') is null then
    raise exception 'Falta correr migration-2026-08-20-top-by-line.sql (este get_catalog es copia del suyo) antes de esta';
  end if;
end $$;

begin;

-- ---------- 1) La tabla ----------
create table if not exists public.client_favorites (
  client_id  uuid not null references public.clients (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (client_id, product_id)
);

comment on table public.client_favorites is
  'Favoritos del catálogo por cliente (2026-08-20). Se escriben SOLO vía set_favorite (por token, como create_order); los lee get_catalog (is_fav) y, con RLS, el panel (admin todo, vendedora sus clientes). El created_at dice desde cuándo le interesa.';

alter table public.client_favorites enable row level security;

-- Lectura para el panel, en la forma InitPlan (regla del proyecto desde
-- migration-2026-08-20-rls-initplan.sql: (select f()) y nunca f() pelada).
-- Sin policy de INSERT/UPDATE/DELETE para nadie: la única escritura es la RPC.
drop policy if exists admin_read_favorites on public.client_favorites;
create policy admin_read_favorites on public.client_favorites
  for select to authenticated
  using ((select public.is_admin()));

drop policy if exists vendedora_read_own_client_favorites on public.client_favorites;
create policy vendedora_read_own_client_favorites on public.client_favorites
  for select to authenticated
  using (client_id in (
    select id from public.clients
    where vendedora_id = (select public.current_vendedora_id())
  ));

-- Explícito, mismo criterio que order_failures: la puerta la abren las
-- policies; anon no recibe nada (escribe por la RPC DEFINER).
grant select on public.client_favorites to authenticated;
revoke all on table public.client_favorites from anon;

-- ---------- 2) La RPC de escritura ----------
-- Devuelve el estado FINAL (true = quedó como favorito, false = quedó
-- quitado) o null si no se pudo (token inválido, producto no publicable,
-- tope). Nunca lanza por diseño: un corazón no puede romper nada ni generar
-- un 500 — el frontend la dispara fire-and-forget.
create or replace function public.set_favorite(
  p_token      text,
  p_product_id uuid,
  p_fav        boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
begin
  if p_token is null or p_product_id is null then
    return null;
  end if;

  select id into v_client from public.clients where token = p_token;
  if not found then
    -- Token inválido: sin rastro, igual que get_catalog (a diferencia de
    -- create_order, acá no hay nada que rescatar después).
    return null;
  end if;

  if coalesce(p_fav, false) then
    -- Solo lo que el catálogo puede mostrar: un producto apagado o
    -- inexistente no se marca (y así tampoco puede explotar la FK).
    if not exists (select 1 from public.products where id = p_product_id and active) then
      return null;
    end if;
    -- Tope anti-abuso (espejo del MAX_FAVS del frontend): el conteo es por
    -- cliente y la tabla tiene PK (client, product), así que un token robado
    -- no puede inflar la tabla más allá de esto.
    if (select count(*) from public.client_favorites where client_id = v_client) >= 500 then
      return null;
    end if;
    insert into public.client_favorites (client_id, product_id)
    values (v_client, p_product_id)
    on conflict (client_id, product_id) do nothing;
    return true;
  else
    delete from public.client_favorites
    where client_id = v_client and product_id = p_product_id;
    return false;
  end if;
end;
$$;

revoke execute on function public.set_favorite(text, uuid, boolean) from public;
grant execute on function public.set_favorite(text, uuid, boolean) to anon, authenticated;

-- ---------- 3) get_catalog: is_fav viaja con el catálogo ----------
-- Copia exacta de la versión de migration-2026-08-20-top-by-line.sql con un
-- solo cambio: la clave 'is_fav' en las dos ramas, resuelta UNA vez por
-- llamada (v_favs) — los corazones llegan en el mismo round-trip de siempre.
create or replace function public.get_catalog(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_client          public.clients%rowtype;
  v_code            text;
  v_vendedora_name  text;
  v_vendedora_phone text;
  v_products        jsonb;
  -- Ventana y tamaño del "Más vendidos" del catálogo (global y por línea).
  -- Si algún día se quiere otro corte, se cambia ACÁ (es el único lugar).
  v_top             uuid[] := array(select public.top_seller_ids(60, 12));
  v_top_line        uuid[] := array(select public.top_seller_ids_by_line(60, 12));
  v_favs            uuid[];
begin
  if p_token is null or length(p_token) = 0 then
    return null;
  end if;

  select * into v_client from public.clients where token = p_token;
  if not found then
    return null;
  end if;

  select code into v_code from public.price_lists where id = v_client.price_list_id;
  select name, phone into v_vendedora_name, v_vendedora_phone
  from public.vendedores where id = v_client.vendedora_id;

  -- Los favoritos DEL cliente resuelto por el token (después del not found:
  -- un token inválido nunca llega acá).
  v_favs := array(
    select product_id from public.client_favorites where client_id = v_client.id
  );

  if v_code = 'quote' then
    -- Catálogo de cotización: acá `price = null` es el diseño, no un dato
    -- faltante — el cliente ve todo el catálogo y el precio se arma después.
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',           p.id,
          'name',         p.name,
          'upc',          p.upc,
          'category',     p.category,
          'product_line', p.product_line,
          'image_url',    p.image_url,
          'availability', p.availability,
          'is_new',       (p.new_until is not null and now() < p.new_until),
          'is_top',       (p.id = any(v_top)),
          'is_top_line',  (p.id = any(v_top_line)),
          'is_fav',       (p.id = any(v_favs)),
          'price',        null
        )
        order by p.category nulls last, p.name
      ),
      '[]'::jsonb
    )
    into v_products
    from public.products p
    where p.active;
  else
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',           p.id,
          'name',         p.name,
          'upc',          p.upc,
          'category',     p.category,
          'product_line', p.product_line,
          'image_url',    p.image_url,
          'availability', p.availability,
          'is_new',       (p.new_until is not null and now() < p.new_until),
          'is_top',       (p.id = any(v_top)),
          'is_top_line',  (p.id = any(v_top_line)),
          'is_fav',       (p.id = any(v_favs)),
          'price',        pp.price
        )
        order by p.category nulls last, p.name
      ),
      '[]'::jsonb
    )
    into v_products
    from public.products p
    left join public.product_prices pp
      on pp.product_id = p.id
     and pp.price_list_id = v_client.price_list_id
    where p.active
      -- 2026-08-06: `> 0` y no `is not null`. Un precio 0 no es un precio: era
      -- la puerta por la que un producto entraba al catálogo en $0.00 y se
      -- podía pedir gratis.
      and pp.price > 0;
  end if;

  return jsonb_build_object(
    'client', jsonb_build_object(
      'name',            v_client.name,
      'vendedora',       v_vendedora_name,
      'vendedora_phone', v_vendedora_phone,
      'price_list_code', v_code,
      'is_quote_only',   v_code = 'quote'
    ),
    'products', v_products
  );
end;
$$;

revoke execute on function public.get_catalog(text) from public;
grant execute on function public.get_catalog(text) to anon, authenticated;

commit;

-- ============================================================
-- Verificación manual (SQL Editor)
-- ============================================================
-- 1) Marcar y desmarcar con un token real (idempotente):
-- select public.set_favorite('<token>', (select id from public.products where active limit 1), true);   -- true
-- select public.set_favorite('<token>', (select id from public.products where active limit 1), true);   -- true (sin duplicar)
-- select public.set_favorite('<token>', (select id from public.products where active limit 1), false);  -- false
-- select public.set_favorite('token-falso', gen_random_uuid(), true);                                    -- null, sin rastro
--
-- 2) El catálogo lo trae:
-- select count(*) filter (where (e->>'is_fav')::boolean) as favoritos
-- from jsonb_array_elements(public.get_catalog('<token>')->'products') e;
--
-- 3) El registro por cliente (lo que pidió el usuario):
-- select c.name as cliente, p.name as producto, f.created_at
-- from public.client_favorites f
-- join public.clients c on c.id = f.client_id
-- join public.products p on p.id = f.product_id
-- order by f.created_at desc limit 20;
