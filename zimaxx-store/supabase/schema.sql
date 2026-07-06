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

create table if not exists public.clients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  phone           text not null unique,
  token           text not null unique,
  price_list_id   uuid not null references public.price_lists (id),
  vendedora       text,
  vendedora_phone text,
  created_at      timestamptz not null default now()
);

create index if not exists clients_token_idx on public.clients (token);

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
-- Niveles por región: Minimum Order ($800+), Wholesale ($2,000+) y
-- Special ($15,000+). "us" abarca todo el mundo salvo Venezuela ("ve").
-- "special" (sin región) es la lista aparte de cotización personalizada.
insert into public.price_lists (code, label) values
  ('us_min',       'US Minimum Order'),
  ('us_wholesale', 'US Wholesale'),
  ('us_special',   'US Special'),
  ('ve_min',       'VE Minimum Order'),
  ('ve_wholesale', 'VE Wholesale'),
  ('ve_special',   'VE Special'),
  ('special',      'Special Order')
on conflict (code) do nothing;

-- Migración: el nivel $15,000+ se llamó brevemente "distribuidor"; su
-- nombre real es Special. Renombra o fusiona sin perder clientes/precios.
do $$
declare
  v_old uuid;
  v_new uuid;
  m record;
begin
  for m in
    select * from (values
      ('us_distribuidor', 'us_special', 'US Special'),
      ('ve_distribuidor', 've_special', 'VE Special')
    ) as t(old_code, new_code, new_label)
  loop
    select id into v_old from public.price_lists where code = m.old_code;
    if v_old is null then continue; end if;
    select id into v_new from public.price_lists where code = m.new_code;
    if v_new is null then
      update public.price_lists set code = m.new_code, label = m.new_label where id = v_old;
    else
      update public.clients set price_list_id = v_new where price_list_id = v_old;
      update public.product_prices set price_list_id = v_new
        where price_list_id = v_old
          and not exists (
            select 1 from public.product_prices pp2
            where pp2.product_id = product_prices.product_id
              and pp2.price_list_id = v_new
          );
      delete from public.product_prices where price_list_id = v_old;
      delete from public.price_lists where id = v_old;
    end if;
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

-- ---------- RLS ----------
-- Regla no negociable: clients y product_prices NUNCA legibles por anon.
-- El catálogo público solo pasa por las RPC security definer.

alter table public.price_lists    enable row level security;
alter table public.clients        enable row level security;
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
  foreach t in array array['price_lists','clients','products','product_prices','flash_sales','orders','admins']
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

-- ---------- RPC: get_catalog ----------
-- Resuelve el cliente por token y devuelve SOLO los precios de su lista.
-- Token inválido => null (sin error descriptivo).
-- Clientes con lista 'special' reciben el catálogo sin precios (modo cotización).
create or replace function public.get_catalog(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_client   public.clients%rowtype;
  v_code     text;
  v_products jsonb;
begin
  if p_token is null or length(p_token) = 0 then
    return null;
  end if;

  select * into v_client from public.clients where token = p_token;
  if not found then
    return null;
  end if;

  select code into v_code from public.price_lists where id = v_client.price_list_id;

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
    -- lista 'special': todos los productos, sin precio.
    -- listas normales: solo productos con precio cargado en su lista.
    and (v_code = 'special' or pp.price is not null);

  return jsonb_build_object(
    'client', jsonb_build_object(
      'name',            v_client.name,
      'vendedora',       v_client.vendedora,
      'vendedora_phone', v_client.vendedora_phone,
      'price_list_code', v_code
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

  -- La lista 'special' siempre cotiza (sin precios); el resto respeta p_kind.
  v_kind := case
    when v_list_code = 'special' then 'quote'
    when p_kind = 'quote'        then 'quote'
    else 'order'
  end;

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

-- ============================================================
-- Primer usuario admin:
-- 1. Crear el usuario en Authentication -> Users (email + password).
-- 2. Ejecutar (reemplazando el email):
--
--    insert into public.admins (user_id)
--    select id from auth.users where email = 'admin@zimaxx.com'
--    on conflict do nothing;
-- ============================================================
