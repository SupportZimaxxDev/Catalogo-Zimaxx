-- ============================================================
-- Zimaxx Store — Esquema de Supabase
-- Ejecutar completo en el SQL Editor del proyecto de Supabase.
-- Es idempotente: se puede re-ejecutar sin romper datos.
-- ============================================================

-- ---------- Extensiones ----------
create extension if not exists pgcrypto;

-- ---------- Tablas ----------

create table if not exists public.price_lists (
  id    uuid primary key default gen_random_uuid(),
  code  text not null unique,
  label text not null
);

-- Vendedora asignada a los clientes: tabla propia en vez de texto libre
-- repetido por cliente, para poder editar su teléfono en un solo lugar y
-- gestionarla desde su propia pestaña del admin.
create table if not exists public.vendedores (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text,
  created_at timestamptz not null default now()
);

create unique index if not exists vendedores_name_idx on public.vendedores (lower(name));

-- Login propio de la vendedora (2026-07-06): vincula esta fila a un
-- usuario de Supabase Auth para que pueda entrar a /admin con una vista
-- restringida a sus propios clientes/pedidos. Nullable: una vendedora
-- puede existir solo como directorio (sin acceso) hasta que un admin la
-- vincule desde la pestaña Vendedoras. login_email es solo para mostrar
-- en esa pestaña; user_id es la fuente de verdad que usan las políticas RLS.
alter table public.vendedores add column if not exists user_id uuid references auth.users (id) on delete set null;
alter table public.vendedores add column if not exists login_email text;

create unique index if not exists vendedoras_user_id_idx on public.vendedores (user_id) where user_id is not null;

create table if not exists public.clients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  phone           text not null unique,
  token           text not null unique,
  price_list_id   uuid not null references public.price_lists (id),
  vendedora_id    uuid references public.vendedores (id),
  created_at      timestamptz not null default now()
);

-- 'create table if not exists' de arriba no toca una tabla que ya existía
-- (la mayoría de las instalaciones reales): hace falta este alter para
-- que 'clients' termine con la columna en instalaciones previas al
-- 2026-07-06.
alter table public.clients
  add column if not exists vendedora_id uuid references public.vendedores (id);

create index if not exists clients_token_idx on public.clients (token);

-- Migración: 'vendedora'/'vendedora_phone' eran texto libre repetido en
-- cada cliente (uno por fila del Excel importado). Se agrupan por nombre
-- (sin distinguir mayúsculas/espacios) en la tabla vendedores y se
-- reasignan los clientes por vendedora_id; las columnas viejas se borran
-- al final. No hace nada en instalaciones nuevas ni en una segunda corrida
-- (las columnas ya no existen).
do $$
declare
  r    record;
  v_id uuid;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'vendedora'
  ) then
    for r in
      select
        (array_agg(trim(vendedora) order by trim(vendedora)))[1] as name,
        max(nullif(trim(vendedora_phone), '')) as phone
      from public.clients
      where coalesce(trim(vendedora), '') <> ''
      group by lower(trim(vendedora))
    loop
      select id into v_id from public.vendedores where lower(name) = lower(r.name);
      if v_id is null then
        insert into public.vendedores (name, phone) values (r.name, r.phone)
        returning id into v_id;
      elsif r.phone is not null then
        update public.vendedores set phone = coalesce(phone, r.phone) where id = v_id;
      end if;
      update public.clients
        set vendedora_id = v_id
        where lower(trim(vendedora)) = lower(r.name);
    end loop;

    alter table public.clients drop column vendedora;
    alter table public.clients drop column vendedora_phone;
  end if;
end $$;

create table if not exists public.products (
  id         uuid primary key default gen_random_uuid(),
  sku        text not null unique,
  name       text not null,
  category   text,
  image_url  text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Disponibilidad: 'available' | 'preorder' (agotado pero se puede
-- reservar). Se marca desde el Excel de productos (columna Type/Tipo).
alter table public.products
  add column if not exists availability text not null default 'available';

create table if not exists public.product_prices (
  product_id    uuid not null references public.products (id) on delete cascade,
  price_list_id uuid not null references public.price_lists (id) on delete cascade,
  price         numeric(10, 2) not null check (price >= 0),
  primary key (product_id, price_list_id)
);

create table if not exists public.flash_sales (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  price      numeric(10, 2) not null check (price >= 0),
  starts_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  active     boolean not null default true
);

create table if not exists public.orders (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid references public.clients (id),
  items      jsonb not null,
  total      numeric(12, 2),
  kind       text not null default 'order', -- 'order' | 'quote' (special order)
  created_at timestamptz not null default now()
);

-- Ciclo de vida del pedido en el panel admin: 'new' (sin atender) | 'done'.
alter table public.orders
  add column if not exists status text not null default 'new'
  check (status in ('new', 'done'));

create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- ---------- Listas de precio fijas ----------
-- Niveles por región: Minimum Order ($800+) y Wholesale ($2,000+).
-- "us" abarca todo el mundo salvo Venezuela ("ve").
-- Special ($15,000+) NO se divide por región: a partir de ese monto
-- siempre es cotización personalizada (ver get_catalog), por eso es una
-- sola lista general "special".
-- 'quote' (2026-07-08) es una lista más en el mismo selector, pero sin
-- precio: get_catalog/create_order la detectan por code y devuelven el
-- catálogo completo (disponibles + pre-order) sin precio en ningún
-- lado. Se eligió como lista en vez de un flag aparte en clients para
-- que sea editable con el mismo selector "Lista" de siempre, sin un
-- alta de cliente especial ni un estado "sin asignar" que después no se
-- pueda tocar.
insert into public.price_lists (code, label) values
  ('us_min',       'US Minimum Order'),
  ('us_wholesale', 'US Wholesale'),
  ('ve_min',       'VE Minimum Order'),
  ('ve_wholesale', 'VE Wholesale'),
  ('special',      'Special Order'),
  ('quote',        'Cotización (sin precio)')
on conflict (code) do nothing;

-- Migración: el nivel $15,000+ pasó por los nombres "distribuidor" y
-- luego "Special" separados por región (us_special/ve_special). La
-- región no aplica a este nivel: se fusiona todo en la lista general
-- 'special' sin perder clientes. Los precios de esas listas se
-- descartan sin problema: 'special' nunca usa product_prices
-- (get_catalog devuelve el catálogo sin precio para esa lista).
do $$
declare
  v_new     uuid;
  v_old     uuid;
  old_code  text;
begin
  select id into v_new from public.price_lists where code = 'special';

  foreach old_code in array array['us_distribuidor', 've_distribuidor', 'us_special', 've_special']
  loop
    select id into v_old from public.price_lists where code = old_code;
    if v_old is null then continue; end if;

    update public.clients set price_list_id = v_new where price_list_id = v_old;
    delete from public.product_prices where price_list_id = v_old;
    delete from public.price_lists where id = v_old;
  end loop;
end $$;

-- ---------- Helper: es admin ----------
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- Helper: es vendedora / cuál vendedora ----------
-- Rol acotado (2026-07-06): una vendedora es un usuario autenticado
-- vinculado a una fila de vendedores, sin estar en admins. Solo ve sus
-- propios clientes/pedidos (políticas RLS más abajo) y el catálogo de
-- solo lectura.
create or replace function public.is_vendedora()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.vendedores where user_id = auth.uid());
$$;

create or replace function public.current_vendedora_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select id from public.vendedores where user_id = auth.uid();
$$;

-- Rol único para que el frontend decida qué UI mostrar con un solo RPC.
create or replace function public.get_my_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select case
    when public.is_admin()     then 'admin'
    when public.is_vendedora() then 'vendedora'
    else null
  end;
$$;

revoke execute on function public.is_vendedora() from public, anon;
grant execute on function public.is_vendedora() to authenticated;
revoke execute on function public.current_vendedora_id() from public, anon;
grant execute on function public.current_vendedora_id() to authenticated;
revoke execute on function public.get_my_role() from public, anon;
grant execute on function public.get_my_role() to authenticated;

-- ---------- RLS ----------
-- Regla no negociable: clients y product_prices NUNCA legibles por anon.
-- El catálogo público solo pasa por las RPC security definer.

alter table public.price_lists    enable row level security;
alter table public.clients        enable row level security;
alter table public.vendedores     enable row level security;
alter table public.products       enable row level security;
alter table public.product_prices enable row level security;
alter table public.flash_sales    enable row level security;
alter table public.orders         enable row level security;
alter table public.admins         enable row level security;

-- Admin autenticado: acceso total a todo (via is_admin, que es security
-- definer para evitar recursión de RLS sobre admins).
do $$
declare t text;
begin
  foreach t in array array['price_lists','clients','vendedores','products','product_prices','flash_sales','orders','admins']
  loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format(
      'create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
      t
    );
  end loop;
end $$;

-- Sin políticas para anon: con RLS activo, anon no puede leer ni escribir
-- ninguna tabla directamente. Todo el acceso público es vía RPC.

-- Vendedora autenticada: solo lectura de lo suyo (aditivas a admin_all,
-- que ya cubre a los admins para todo; Postgres combina políticas
-- permisivas del mismo comando con OR). Sin política de insert/update/
-- delete propia => una vendedora no puede escribir nada salvo el status
-- de sus propios pedidos (policy siguiente).
drop policy if exists vendedora_select_self on public.vendedores;
create policy vendedora_select_self on public.vendedores
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists vendedora_select_own_clients on public.clients;
create policy vendedora_select_own_clients on public.clients
  for select to authenticated
  using (vendedora_id = public.current_vendedora_id());

-- Alta individual de clientes (2026-07-07): una vendedora puede crear
-- clientes propios desde el panel, pero solo si se auto-asigna (no puede
-- crear un cliente "suelto" ni asignárselo a otra vendedora). El admin ya
-- puede insertar cualquier cosa via admin_all.
drop policy if exists vendedora_insert_own_clients on public.clients;
create policy vendedora_insert_own_clients on public.clients
  for insert to authenticated
  with check (vendedora_id = public.current_vendedora_id());

drop policy if exists vendedora_select_own_orders on public.orders;
create policy vendedora_select_own_orders on public.orders
  for select to authenticated
  using (client_id in (select id from public.clients where vendedora_id = public.current_vendedora_id()));

-- Permite marcar sus propios pedidos como atendido/nuevo desde
-- OrdersAdmin.jsx (misma llamada que ya usa un admin, sin RPC dedicada:
-- es personal interno de confianza y el "with check" impide reasignar
-- el pedido a otro cliente).
drop policy if exists vendedora_update_own_orders on public.orders;
create policy vendedora_update_own_orders on public.orders
  for update to authenticated
  using (client_id in (select id from public.clients where vendedora_id = public.current_vendedora_id()))
  with check (client_id in (select id from public.clients where vendedora_id = public.current_vendedora_id()));

-- Catálogo/precios/flash de solo lectura para cualquier vendedora
-- (consulta, no edición) — igual acceso de lectura que ya tienen los admins.
do $$
declare t text;
begin
  foreach t in array array['price_lists','products','product_prices','flash_sales']
  loop
    execute format('drop policy if exists vendedora_select_readonly on public.%I', t);
    execute format(
      'create policy vendedora_select_readonly on public.%I for select to authenticated using (public.is_vendedora())',
      t
    );
  end loop;
end $$;

-- ---------- RPC: get_catalog ----------
-- Resuelve el cliente por token y devuelve SOLO los precios de su lista.
-- Token inválido => null (sin error descriptivo). 'special' es una lista
-- de precio normal (2026-07-06): ya no tiene trato especial acá.
-- Catálogo de cotización (2026-07-08): la lista 'quote' es la única
-- excepción — devuelve TODOS los productos activos (disponibles y
-- pre-order) con price = null siempre, sin importar product_prices.
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
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',           p.id,
          'name',         p.name,
          'category',     p.category,
          'image_url',    p.image_url,
          'availability', p.availability,
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
          'category',     p.category,
          'image_url',    p.image_url,
          'availability', p.availability,
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
      and pp.price is not null;
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

-- ---------- RPC: get_flash_sales ----------
-- Pública, sin token. Devuelve solo ofertas vigentes.
create or replace function public.get_flash_sales()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',           fs.id,
        'product_id',   p.id,
        'name',         p.name,
        'category',     p.category,
        'image_url',    p.image_url,
        'availability', p.availability,
        'price',        fs.price,
        'expires_at',   fs.expires_at
      )
      order by fs.expires_at
    ),
    '[]'::jsonb
  )
  from public.flash_sales fs
  join public.products p on p.id = fs.product_id and p.active
  where fs.active
    and now() >= fs.starts_at
    and now() < fs.expires_at;
$$;

revoke execute on function public.get_flash_sales() from public;
grant execute on function public.get_flash_sales() to anon, authenticated;

-- ---------- RPC: create_order ----------
-- INSERT público de pedidos, pero validado por token (más estricto que
-- abrir INSERT directo sobre la tabla). El cliente nunca puede leer,
-- actualizar ni borrar orders.
--
-- El navegador solo aporta producto, cantidad y si venía de flash sale:
-- precio unitario y total se recalculan aquí con la lista del cliente
-- (y flash sales vigentes), así la tabla orders es fuente de verdad
-- aunque alguien manipule el payload. p_total se ignora; se mantiene en
-- la firma para no romper clientes ya desplegados.
create or replace function public.create_order(
  p_token text,
  p_items jsonb,
  p_total numeric,
  p_kind  text default 'order'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client    public.clients%rowtype;
  v_list_code text;
  v_kind      text;
  v_item      jsonb;
  v_id        uuid;
  v_qty       int;
  v_flash     boolean;
  v_product   public.products%rowtype;
  v_price     numeric;
  v_items     jsonb   := '[]'::jsonb;
  v_total     numeric := 0;
  v_has_price boolean := false;
  v_order_id  uuid;
begin
  select * into v_client from public.clients where token = p_token;
  if not found then
    return null; -- token inválido: no registra ni explica
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 200 then
    return null;
  end if;

  select code into v_list_code from public.price_lists where id = v_client.price_list_id;

  -- El cliente nunca decide esto: la lista 'quote' siempre guarda
  -- 'quote' sin precio, sin importar lo que mande el frontend.
  v_kind := case when v_list_code = 'quote' or p_kind = 'quote' then 'quote' else 'order' end;

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_id    := (v_item->>'id')::uuid;
      v_qty   := floor((v_item->>'qty')::numeric)::int;
      v_flash := coalesce((v_item->>'flash')::boolean, false);
    exception when others then
      continue; -- ítem malformado: se descarta, no tumba el pedido
    end;
    -- ojo: least/greatest ignoran null, por eso el chequeo va antes del tope
    if v_qty is null or v_qty < 1 then continue; end if;
    if v_qty > 9999 then v_qty := 9999; end if;

    select * into v_product from public.products where id = v_id and active;
    if not found then continue; end if;

    v_price := null;
    if v_kind = 'order' then
      if v_flash then
        select fs.price into v_price
        from public.flash_sales fs
        where fs.product_id = v_id
          and fs.active
          and now() >= fs.starts_at
          and now() < fs.expires_at
        order by fs.price
        limit 1;
      end if;
      -- Sin flash vigente (o expiró entre carrito y checkout): precio de lista.
      if v_price is null then
        select pp.price into v_price
        from public.product_prices pp
        where pp.product_id = v_id
          and pp.price_list_id = v_client.price_list_id;
      end if;
    end if;

    v_items := v_items || jsonb_build_object(
      'id',    v_product.id,
      'sku',   v_product.sku,
      'name',  v_product.name,
      'qty',   v_qty,
      'price', v_price,
      'flash', v_flash
    );
    if v_price is not null then
      v_total     := v_total + v_price * v_qty;
      v_has_price := true;
    end if;
  end loop;

  if jsonb_array_length(v_items) = 0 then
    return null;
  end if;

  insert into public.orders (client_id, items, total, kind)
  values (
    v_client.id,
    v_items,
    case when v_kind = 'order' and v_has_price then round(v_total, 2) else null end,
    v_kind
  )
  returning id into v_order_id;

  return v_order_id;
end;
$$;

revoke execute on function public.create_order(text, jsonb, numeric, text) from public;
grant execute on function public.create_order(text, jsonb, numeric, text) to anon, authenticated;

-- ---------- RPC: link_vendedora_login ----------
-- Vincula una vendedora a un usuario ya existente en Supabase Auth (el
-- admin lo crea a mano en el dashboard, igual que hoy se crea un admin,
-- y después usa este RPC desde la pestaña Vendedoras para no tener que
-- ir al SQL Editor). Solo admins pueden llamarlo. Devuelve false si el
-- email no corresponde a ningún usuario de auth.users.
create or replace function public.link_vendedora_login(p_vendedora_id uuid, p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select id into v_user_id from auth.users where email = p_email;
  if v_user_id is null then
    return false;
  end if;

  update public.vendedores
    set user_id = v_user_id, login_email = p_email
    where id = p_vendedora_id;

  return true;
end;
$$;

revoke execute on function public.link_vendedora_login(uuid, text) from public, anon;
grant execute on function public.link_vendedora_login(uuid, text) to authenticated;

-- ============================================================
-- Primer usuario admin:
-- 1. Crear el usuario en Authentication -> Users (email + password).
-- 2. Ejecutar (reemplazando el email):
--
--    insert into public.admins (user_id)
--    select id from auth.users where email = 'admin@zimaxx.com'
--    on conflict do nothing;
-- ============================================================
