-- ============================================================
-- 2026-08-20: "Más vendidos" en el catálogo del cliente
--
-- Contexto (a pedido del usuario): "quiero agregar un apartado de más
-- vendidos, en base al registro de ordenes que se han hecho y que se hacen, y
-- que salgan diferenciados con algun filtro o algo en el catalogo". El
-- catálogo gana un chip "⭐ Más vendidos" y un badge en la tarjeta; qué
-- productos lo llevan lo decide la base a partir de los pedidos REALES.
--
-- Qué cuenta como "vendido": pedidos `kind = 'order'` con `status <>
-- 'cancelled'` (una cotización no es una venta — cuenta recién cuando se
-- convierte; un cancelado deja de contar). La métrica son UNIDADES pedidas,
-- que es el idioma del negocio (mover inventario), en una ventana móvil de
-- los últimos 60 DÍAS — "más vendido" es un dato comercial de ahora, no un
-- ranking histórico eterno; hoy la ventana cubre el historial completo
-- (el primer pedido es del 2026-07-27) y a medida que pase el tiempo se
-- va renovando sola con "las ordenes que se hacen".
--
-- CÓMO se mantiene el dato (la parte no obvia):
--
--   * NO se agrega sobre orders.items en cada get_catalog: el catálogo se
--     abre miles de veces (11k llamadas al 2026-08-20) y agregar jsonb de
--     miles de pedidos por apertura es exactamente el tipo de costo lineal
--     que se acaba de sacar del panel con la migración de RLS.
--   * NO hay job programado: pg_cron no está habilitado en el proyecto.
--   * En su lugar, una tabla chica de cubetas por día —
--     `product_sales_daily(product_id, day, units)` — mantenida por un
--     trigger AFTER en orders con una invariante simple: si la versión VIEJA
--     de la fila contaba, se restan sus unidades; si la NUEVA cuenta, se
--     suman. Eso cubre TODOS los caminos con una sola regla: alta de pedido,
--     carga manual, convertir cotización (quote→order suma), cancelar
--     (resta), reabrir (vuelve a sumar), editar ítems (resta lo viejo y suma
--     lo nuevo) y hasta un DELETE. Las cubetas van por el DÍA DEL PEDIDO
--     (created_at, no now()): editar un pedido viejo ajusta su día original.
--   * El ranking se lee con un agregado sobre la tabla de cubetas (hoy
--     cientos de filas, a años vista decenas de miles): milisegundos.
--
-- REGLA DE ORO, la misma de system_logs: **la estadística jamás rompe un
-- pedido**. El cuerpo del trigger va envuelto — si algo falla, warning y el
-- pedido sigue. Ítems basura (qty no numérica, producto borrado, items que no
-- es array) suman 0 en vez de reventar.
--
-- PERMISOS: el trigger y su helper son SECURITY DEFINER — el UPDATE de una
-- vendedora (policy vendedora_update_own_orders) tiene que poder anotar la
-- estadística aunque `authenticated` no tenga ningún privilegio sobre
-- product_sales_daily. Y ni el helper ni el lector se exponen por la API
-- (revoke): si apply_product_sales fuera ejecutable por anon, cualquiera con
-- la anon key podría inflar el ranking.
--
-- get_catalog: copia exacta de la versión viva (migration-2026-08-14-
-- catalog-upc.sql, verificada en producción el 2026-08-19) con UNA clave
-- nueva por producto: `is_top` (¿está en el top 12 de los últimos 60 días?),
-- en las DOS ramas — el cliente de cotización también ve el chip (es
-- información comercial, no un precio).
--
-- COMPATIBILIDAD: aditiva. El frontend viejo ignora `is_top`; el frontend
-- nuevo sin esta migración recibe `is_top` undefined y el chip/badge
-- simplemente no aparecen (mismo patrón que el UPC del 2026-08-14). No
-- bloquea el deploy en ningún orden.
--
-- Idempotente: create or replace / if not exists, y el backfill TRUNCA y
-- reconstruye las cubetas desde orders — re-correrla deja el estado exacto.
-- ============================================================
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  -- El cuerpo nuevo de get_catalog es copia del de 2026-08-14 (con upc):
  -- si esa migración no corrió, esta lo "adelantaría" sin querer.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products' and column_name = 'upc'
  ) then
    raise exception 'Falta correr migration-2026-08-14-catalog-upc.sql (products.upc y el get_catalog del que esta versión es copia)';
  end if;
end $$;

begin;

-- ---------- 1) Las cubetas de venta por producto y día ----------
create table if not exists public.product_sales_daily (
  product_id uuid not null references public.products (id) on delete cascade,
  day        date not null,
  units      bigint not null default 0,
  primary key (product_id, day)
);

comment on table public.product_sales_daily is
  'Unidades pedidas por producto y día (pedidos kind=order no cancelados). La mantiene el trigger orders_track_product_sales; la lee top_seller_ids() para el "Más vendidos" del catálogo (2026-08-20). Si alguna vez desconfía, se reconstruye re-corriendo el backfill de migration-2026-08-20-top-sellers.sql.';

-- Interna: nadie la toca por la API. Sin policies y sin grants — la escribe
-- el trigger (DEFINER) y la lee get_catalog (DEFINER).
alter table public.product_sales_daily enable row level security;
revoke all on table public.product_sales_daily from anon, authenticated;

-- ---------- 2) Aplicar los ítems de un pedido a las cubetas ----------
-- p_sign: +1 suma (la fila cuenta), -1 resta (dejó de contar). El join por
-- id::text valida en un solo paso que el id del ítem sea un uuid legal Y que
-- el producto exista (evita tanto el error de cast como la violación de FK
-- con un producto borrado: ese ítem simplemente no se cuenta).
create or replace function public.apply_product_sales(p_items jsonb, p_at timestamptz, p_sign int)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.product_sales_daily (product_id, day, units)
  select s.product_id, s.day, s.units
  from (
    select pr.id as product_id,
           (p_at at time zone 'utc')::date as day,
           sum(case when (i.value->>'qty') ~ '^[0-9]+(\.[0-9]+)?$'
                    then floor((i.value->>'qty')::numeric)::bigint
                    else 0
               end) * p_sign as units
    from jsonb_array_elements(
           case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end
         ) i
    join public.products pr on pr.id::text = i.value->>'id'
    group by pr.id
  ) s
  where s.units <> 0
  on conflict (product_id, day) do update
    set units = product_sales_daily.units + excluded.units;
$$;

-- Nunca por la API: ejecutable solo desde funciones DEFINER (el trigger).
revoke execute on function public.apply_product_sales(jsonb, timestamptz, int) from public, anon, authenticated;

-- ---------- 3) El trigger: una regla para todos los caminos ----------
create or replace function public.orders_track_product_sales()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Las anotaciones que no tocan lo contable (marcar enviado a SellerCloud,
  -- stock_applied, request_id...) salen gratis: restar y sumar lo mismo sería
  -- trabajo de más en cada update de la bandeja.
  if tg_op = 'UPDATE'
     and old.items is not distinct from new.items
     and old.kind is not distinct from new.kind
     and old.status is not distinct from new.status then
    return null;
  end if;

  begin
    if tg_op in ('UPDATE', 'DELETE')
       and old.kind = 'order' and old.status is distinct from 'cancelled' then
      perform public.apply_product_sales(old.items, old.created_at, -1);
    end if;
    if tg_op in ('INSERT', 'UPDATE')
       and new.kind = 'order' and new.status is distinct from 'cancelled' then
      perform public.apply_product_sales(new.items, new.created_at, +1);
    end if;
  exception when others then
    -- La regla de oro: la estadística jamás tumba un pedido. Si esto falla,
    -- el ranking queda un pedido desfasado y se endereza re-corriendo el
    -- backfill; un checkout caído por un contador no tiene arreglo.
    raise warning 'orders_track_product_sales: % (pedido %)',
      sqlerrm, coalesce(new.id, old.id);
  end;
  return null;
end;
$$;

drop trigger if exists orders_track_product_sales on public.orders;
create trigger orders_track_product_sales
  after insert or update or delete on public.orders
  for each row execute function public.orders_track_product_sales();

-- ---------- 4) Backfill: "las ordenes que se han hecho" ----------
-- Truncar y reconstruir hace la migración re-corrible y es también el botón
-- de "recalcular todo" si algún día el contador desconfía.
truncate table public.product_sales_daily;

insert into public.product_sales_daily (product_id, day, units)
select pr.id,
       (o.created_at at time zone 'utc')::date,
       sum(case when (i.value->>'qty') ~ '^[0-9]+(\.[0-9]+)?$'
                then floor((i.value->>'qty')::numeric)::bigint
                else 0
           end)
from public.orders o
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
) i
join public.products pr on pr.id::text = i.value->>'id'
where o.kind = 'order'
  and o.status is distinct from 'cancelled'
group by pr.id, (o.created_at at time zone 'utc')::date
having sum(case when (i.value->>'qty') ~ '^[0-9]+(\.[0-9]+)?$'
                then floor((i.value->>'qty')::numeric)::bigint
                else 0
           end) <> 0;

-- ---------- 5) El ranking ----------
-- Los N más vendidos de los últimos p_days días. greatest(sum, 0): una cubeta
-- puede quedar negativa en teoría (resta sin su suma por un fallo parcial) y
-- un "más vendido" negativo no tiene sentido — having > 0 ya lo excluye.
-- Desempate por product_id para que el corte del top sea estable entre
-- llamadas.
create or replace function public.top_seller_ids(p_days int default 60, p_limit int default 12)
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select product_id
  from public.product_sales_daily
  where day >= (now() at time zone 'utc')::date - greatest(coalesce(p_days, 60), 1)
  group by product_id
  having sum(units) > 0
  order by sum(units) desc, product_id
  limit greatest(coalesce(p_limit, 12), 1);
$$;

-- Solo la llama get_catalog (DEFINER): no se expone por la API.
revoke execute on function public.top_seller_ids(int, int) from public, anon, authenticated;

-- ---------- 6) get_catalog: is_top viaja al cliente ----------
-- Copia exacta de la versión viva (migration-2026-08-14-catalog-upc.sql) con
-- un solo cambio: la clave 'is_top' en las dos ramas, contra el top 12 de los
-- últimos 60 días resuelto UNA vez por llamada (v_top).
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
  -- Ventana y tamaño del "Más vendidos" del catálogo. Si algún día se quiere
  -- otro corte, se cambia ACÁ (es el único lugar).
  v_top             uuid[] := array(select public.top_seller_ids(60, 12));
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
-- 1) El backfill cargó cubetas (con los pedidos reales debe dar filas):
-- select count(*) as cubetas, coalesce(sum(units), 0) as unidades
-- from public.product_sales_daily;
--
-- 2) El top actual, con nombre (lo que va a marcar el catálogo):
-- select p.name, sum(d.units) as unidades
-- from public.product_sales_daily d join public.products p on p.id = d.product_id
-- where d.day >= (now() at time zone 'utc')::date - 60
-- group by p.name order by 2 desc limit 12;
--
-- 3) El catálogo lo trae (token de un cliente real):
-- select count(*) filter (where (e->>'is_top')::boolean) as marcados
-- from jsonb_array_elements(public.get_catalog('<token>')->'products') e;
-- -- esperado: hasta 12 (menos si algún top no tiene precio en esa lista).
--
-- 4) El contador acompaña los cambios: cancelar un pedido de prueba desde la
--    bandeja resta sus unidades; reabrirlo las vuelve a sumar (comparar la
--    consulta 1 antes y después).
