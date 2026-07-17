-- ============================================================
-- Zimaxx Store — Esquema de Supabase
-- Ejecutar completo en el SQL Editor del proyecto de Supabase.
-- Es idempotente: se puede re-ejecutar sin romper datos.
-- ============================================================

-- Los ALTER TABLE de este script piden locks exclusivos que pueden chocar
-- con los RPC del sitio en producción (pasó el 2026-07-09: deadlock con
-- get_catalog leyendo products). Con lock_timeout el script falla rápido
-- y limpio si la tabla está ocupada — en ese caso, simplemente volver a
-- correrlo; la transacción se revierte entera, no queda nada a medias.
set lock_timeout = '10s';

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

-- Lista "personal" de una vendedora (2026-07-09, ej. Luzmar Quintero):
-- nullable, null en las listas de nivel general (us_min, special, etc.).
-- Cuando está seteado, el admin panel fuerza vendedora_id = este valor
-- al elegir esa lista para un cliente — evita que un cliente con precios
-- especiales de una vendedora quede asignado a otra por error.
alter table public.price_lists add column if not exists owner_vendedora_id uuid references public.vendedores (id);

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

-- Garantiza a nivel de base de datos que un cliente con una lista
-- "personal" (price_lists.owner_vendedora_id, ej. 'luzmar') SIEMPRE
-- queda con esa vendedora asignada (2026-07-09, a pedido del usuario:
-- evitar que un cliente con precios especiales de Luzmar termine en la
-- cuenta de otra vendedora). ClientsAdmin.jsx ya evita esto en la UI
-- (auto-completa y bloquea el selector), pero eso es solo UX — este
-- trigger es la garantía real, cubre también la carga por Excel y
-- cualquier escritura directa a la tabla que se le escape al frontend.
create or replace function public.enforce_owner_vendedora()
returns trigger
language plpgsql
as $$
declare
  v_owner uuid;
begin
  select owner_vendedora_id into v_owner
  from public.price_lists where id = new.price_list_id;

  if v_owner is not null then
    new.vendedora_id := v_owner;
  end if;
  return new;
end;
$$;

drop trigger if exists clients_enforce_owner_vendedora on public.clients;
create trigger clients_enforce_owner_vendedora
  before insert or update on public.clients
  for each row execute function public.enforce_owner_vendedora();

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
-- reservar) | 'flash' (2026-07-08: Flash Sale del Excel de inventario,
-- distinto de la tabla `flash_sales` de ofertas con precio promo — esto
-- es solo una etiqueta del producto, sin precio asociado). Se marca
-- desde el Excel de productos (columna Type/Tipo).
alter table public.products
  add column if not exists availability text not null default 'available';

-- Línea/tipo real del perfume (2026-07-08): ej. 'Perfume' (diseñador) vs
-- 'Perfume - Arabes' (dupes árabes) — viene de la columna PRODUCT_CATEGORY
-- de los exports de SellerCloud (ej. 119389.xlsx). Distinto de `category`,
-- que en este proyecto guarda la MARCA (Brand/PRODUCTBRAND), no esto.
-- Texto libre sin CHECK: el export trae también otros valores (Beauty,
-- Electronics, etc.) para productos que no son perfume.
alter table public.products
  add column if not exists product_line text;

-- Etiqueta "Nuevo" (2026-07-09): al crear un producto (alta manual o
-- carga masiva) el admin le pone new_until = ahora + ~10 días. Mientras
-- now() < new_until el catálogo muestra el badge y permite filtrar por
-- nuevos; después expira solo, sin limpieza manual. La fecha es editable
-- desde el formulario de edición del producto en el panel admin.
alter table public.products
  add column if not exists new_until timestamptz;

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

-- Agrupa las filas de una misma carga masiva por Excel (2026-07-09) para
-- poder desactivarlas todas juntas desde el admin. Null en las cargadas
-- a mano una por una (no forman parte de ningún grupo).
alter table public.flash_sales add column if not exists batch_id uuid;
create index if not exists flash_sales_batch_id_idx on public.flash_sales (batch_id) where batch_id is not null;

create table if not exists public.orders (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid references public.clients (id),
  items      jsonb not null,
  total      numeric(12, 2),
  kind       text not null default 'order', -- 'order' | 'quote' (special order)
  created_at timestamptz not null default now()
);

-- Ciclo de vida del pedido en el panel admin: 'new' (sin atender) | 'done'
-- | 'cancelled' (2026-07-15: el cliente arma el pedido y lo confirma, pero
-- a veces lo cancela después). El check se recrea aparte (no en el ADD
-- COLUMN) porque ese IF NOT EXISTS no vuelve a aplicarse una vez que la
-- columna ya existe en una instalación en producción.
alter table public.orders
  add column if not exists status text not null default 'new';
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new', 'done', 'cancelled'));

-- Blinda items/total de un pedido para que solo se editen a través de la
-- RPC update_order_items (2026-07-17): así el cambio queda auditado sí o
-- sí en admin_audit_log, igual que reassign_client/delete_client/
-- update_client_price_list. La RPC prende la bandera de sesión
-- app.allow_order_edit antes de escribir; cualquier otro update directo a
-- la tabla (ej. marcar atendido/cancelado, que no toca items/total) sigue
-- funcionando sin tocar el trigger.
create or replace function public.orders_guard_items_edit()
returns trigger
language plpgsql
as $$
begin
  if (new.items is distinct from old.items or new.total is distinct from old.total)
     and coalesce(current_setting('app.allow_order_edit', true), '') <> 'on' then
    raise exception 'los items de un pedido solo se editan via update_order_items';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_guard_items_edit on public.orders;
create trigger orders_guard_items_edit
  before update on public.orders
  for each row execute function public.orders_guard_items_edit();

create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- Auditoría de acciones sensibles sobre clientes (2026-07-14,
-- migration-2026-07-14-client-admin-actions.sql — agregada acá recién
-- 2026-07-15 al sumar update_client_price_list, que también audita acá;
-- schema.sql había quedado atrás desde el sync de SellerCloud). `action`
-- texto genérico por si se auditan más acciones a futuro. `client_id` SIN
-- FK a clients a propósito: la fila de auditoría de un borrado tiene que
-- sobrevivir al cliente borrado. `client_name`/`detail` son un snapshot al
-- momento de la acción.
create table if not exists public.admin_audit_log (
  id                 uuid primary key default gen_random_uuid(),
  action             text not null,
  performed_by       uuid,
  performed_by_email text,
  client_id          uuid,
  client_name        text,
  detail             jsonb,
  created_at         timestamptz not null default now()
);

-- order_id (2026-07-17, edit_order_items): igual criterio que client_id,
-- SIN FK a orders — la fila de auditoría sobrevive aunque el pedido se
-- borre en el futuro.
alter table public.admin_audit_log add column if not exists order_id uuid;

create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_order_idx
  on public.admin_audit_log (order_id) where order_id is not null;

alter table public.admin_audit_log enable row level security;
drop policy if exists admin_read_audit on public.admin_audit_log;
create policy admin_read_audit on public.admin_audit_log
  for select to authenticated
  using (public.is_admin());
-- Sin policy de insert/update/delete para nadie: inmutable para
-- cualquier usuario autenticado, solo lo escriben las funciones
-- SECURITY DEFINER (reassign_client/delete_client/update_client_price_list).

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
-- 'luzmar' (2026-07-09): lista de precio exclusiva de Luzmar Quintero
-- (jefa de vendedoras) a pedido del usuario — sus clientes se cotizan con
-- precios propios, distintos de 'special'. Es una lista más en el mismo
-- selector, sin lógica de negocio especial (a diferencia de 'quote'):
-- necesita que le suban precios en la pestaña Precios como a cualquier
-- otra, y se selecciona igual en el alta/edición de cliente.
insert into public.price_lists (code, label) values
  ('us_min',       'US Minimum Order'),
  ('us_wholesale', 'US Wholesale'),
  ('ve_min',       'VE Minimum Order'),
  ('ve_wholesale', 'VE Wholesale'),
  ('special',      'Special Order'),
  ('quote',        'Cotización (sin precio)'),
  ('luzmar',       'Luzmar - Precio Especial')
on conflict (code) do nothing;

-- Vincula la lista 'luzmar' a la fila de Luzmar Quintero en `vendedores`
-- (por nombre, sin distinguir mayúsculas — hay índice único sobre
-- lower(name)). No-op si todavía no existe esa vendedora: se puede
-- re-correr después de crearla.
update public.price_lists
set owner_vendedora_id = (select id from public.vendedores where lower(name) = 'luzmar quintero')
where code = 'luzmar'
  and owner_vendedora_id is null;

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

-- ---------- RPC: update_client_price_list ----------
-- Cambiar la lista de precio de un cliente (2026-07-15, a pedido del
-- usuario: una vendedora ahora puede cambiarle la lista a SUS propios
-- clientes, no solo el admin). SECURITY DEFINER y no un update directo
-- por dos motivos: (a) una vendedora no tiene policy de UPDATE en
-- `clients` (solo select/insert de lo suyo) — sin esta función no podría
-- hacerlo ni con la UI habilitada; (b) igual que reassign_client/
-- delete_client, así el cambio queda auditado sí o sí en
-- `admin_audit_log`, sin importar quién lo haga.
create or replace function public.update_client_price_list(p_client_id uuid, p_price_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   public.clients%rowtype;
  v_new_list public.price_lists%rowtype;
  v_old_list public.price_lists%rowtype;
  v_email    text;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'cliente no encontrado';
  end if;

  if not public.is_admin() then
    if not public.is_vendedora() or v_client.vendedora_id is distinct from public.current_vendedora_id() then
      raise exception 'no tenés permiso para cambiar la lista de este cliente';
    end if;
  end if;

  select * into v_new_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  -- Una vendedora (no admin) no puede asignar una lista "personal" ajena
  -- (ej. luzmar) a un cliente suyo — mismo candado que ya aplica
  -- selectablePriceLists en el frontend, reforzado acá server-side.
  if not public.is_admin()
     and v_new_list.owner_vendedora_id is not null
     and v_new_list.owner_vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no podés asignar esa lista';
  end if;

  select * into v_old_list from public.price_lists where id = v_client.price_list_id;
  select email into v_email from auth.users where id = auth.uid();

  update public.clients set price_list_id = p_price_list_id where id = p_client_id;
  -- El trigger clients_enforce_owner_vendedora corre acá mismo si la
  -- lista nueva tiene dueña, y pisa vendedora_id sin que haga falta
  -- replicar esa lógica en esta función.

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('update_price_list', auth.uid(), v_email, p_client_id, v_client.name,
     jsonb_build_object(
       'from_list_id', v_client.price_list_id,
       'from_list',    v_old_list.label,
       'to_list_id',   p_price_list_id,
       'to_list',      v_new_list.label
     ));

  return jsonb_build_object('ok', true, 'from', v_old_list.label, 'to', v_new_list.label);
end;
$$;

revoke execute on function public.update_client_price_list(uuid, uuid) from public;
grant execute on function public.update_client_price_list(uuid, uuid) to authenticated;
revoke execute on function public.get_my_role() from public, anon;
grant execute on function public.get_my_role() to authenticated;

-- ---------- RPC: apply_price_list ----------
-- Carga de listas de precio, una lista por archivo (2026-07-17,
-- migration-2026-07-17-apply-price-list.sql): reemplaza el upsert directo
-- a product_prices desde PricesUpload.jsx, que reventaba con "ON CONFLICT
-- DO UPDATE command cannot affect row a second time" si el Excel traía un
-- SKU repetido. Dedup por SKU (última fila gana) del lado del servidor.
--
-- p_commit = false: solo preview (no escribe). p_commit = true: aplica.
-- Comportamiento intencional: producto con precio hoy en la lista que no
-- viene en el archivo (o viene con SKU/precio inválido) pierde el precio
-- de ESA lista y queda active = false GLOBAL — por eso el frontend
-- muestra el preview con los contadores antes de confirmar.
create or replace function public.apply_price_list(
  p_price_list_code text,
  p_rows             jsonb,
  p_commit           boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list              public.price_lists%rowtype;
  v_to_upsert         int;
  v_to_reactivate     int;
  v_to_deactivate     int;
  v_unknown_skus      int;
  v_invalid_prices    int;
  v_deactivate_sample jsonb;
  v_unknown_sample    jsonb;
begin
  if not public.is_admin() then
    raise exception 'no tenés permiso para aplicar listas de precio';
  end if;

  select * into v_list from public.price_lists where code = p_price_list_code;
  if not found then
    raise exception 'lista de precio no encontrada: %', p_price_list_code;
  end if;

  drop table if exists pg_temp.tmp_price_rows;
  drop table if exists pg_temp.tmp_deactivate;

  create temporary table tmp_price_rows on commit drop as
  with raw as (
    select
      row_number() over ()             as rn,
      trim(elem->>'sku')                as sku,
      nullif(trim(elem->>'price'), '')  as price_raw,
      trim(elem->>'type')                as type_raw
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as elem
  ),
  dedup as (
    select distinct on (lower(sku)) sku, price_raw, type_raw
    from raw
    where sku is not null and sku <> ''
    order by lower(sku), rn desc
  )
  select
    d.sku,
    case
      when d.price_raw ~ '^[0-9]+(\.[0-9]+)?$' then d.price_raw::numeric
      else null
    end as price,
    case
      when d.type_raw ~* 'pre.?order' then 'preorder'
      when d.type_raw ~* 'flash'      then 'flash'
      else 'available'
    end as availability,
    p.id     as product_id,
    p.name   as product_name,
    p.active as was_active
  from dedup d
  left join public.products p on lower(trim(p.sku)) = lower(d.sku);

  create temporary table tmp_deactivate on commit drop as
  select pp.product_id, p.sku, p.name
  from public.product_prices pp
  join public.products p on p.id = pp.product_id
  where pp.price_list_id = v_list.id
    and pp.product_id not in (
      select product_id from tmp_price_rows
      where product_id is not null and price is not null
    );

  select count(*) into v_to_upsert
    from tmp_price_rows where product_id is not null and price is not null;
  select count(*) into v_to_reactivate
    from tmp_price_rows where product_id is not null and price is not null and was_active = false;
  select count(*) into v_unknown_skus
    from tmp_price_rows where product_id is null;
  select count(*) into v_invalid_prices
    from tmp_price_rows where product_id is not null and price is null;
  select count(*) into v_to_deactivate from tmp_deactivate;

  select coalesce(jsonb_agg(jsonb_build_object('sku', sku, 'name', name)), '[]'::jsonb)
    into v_deactivate_sample
    from (select sku, name from tmp_deactivate order by sku limit 50) s;

  select coalesce(jsonb_agg(sku), '[]'::jsonb)
    into v_unknown_sample
    from (select sku from tmp_price_rows where product_id is null order by sku limit 50) s;

  if p_commit then
    insert into public.product_prices (product_id, price_list_id, price)
    select product_id, v_list.id, price
    from tmp_price_rows
    where product_id is not null and price is not null
    on conflict (product_id, price_list_id) do update set price = excluded.price;

    update public.products p
    set active = true,
        availability = t.availability
    from tmp_price_rows t
    where t.product_id = p.id
      and t.price is not null;

    delete from public.product_prices pp
    using tmp_deactivate d
    where pp.product_id = d.product_id
      and pp.price_list_id = v_list.id;

    update public.products p
    set active = false
    from tmp_deactivate d
    where p.id = d.product_id;
  end if;

  return jsonb_build_object(
    'committed',          p_commit,
    'list',               jsonb_build_object('code', v_list.code, 'label', v_list.label),
    'to_upsert',          v_to_upsert,
    'to_reactivate',      v_to_reactivate,
    'to_deactivate',      v_to_deactivate,
    'unknown_skus',       v_unknown_skus,
    'invalid_prices',     v_invalid_prices,
    'deactivate_sample',  v_deactivate_sample,
    'unknown_sample',     v_unknown_sample
  );
end;
$$;

revoke execute on function public.apply_price_list(text, jsonb, boolean) from public;
grant execute on function public.apply_price_list(text, jsonb, boolean) to authenticated;

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

-- Catálogo/flash de solo lectura para cualquier vendedora (consulta, no
-- edición) — igual acceso de lectura que ya tienen los admins.
-- price_lists/product_prices NO van acá: tienen su propia policy más abajo
-- porque una lista "personal" (owner_vendedora_id, ej. 'luzmar') es de
-- lectura exclusiva de esa vendedora, no de cualquiera con el rol.
do $$
declare t text;
begin
  foreach t in array array['products','flash_sales']
  loop
    execute format('drop policy if exists vendedora_select_readonly on public.%I', t);
    execute format(
      'create policy vendedora_select_readonly on public.%I for select to authenticated using (public.is_vendedora())',
      t
    );
  end loop;
end $$;

-- price_lists/product_prices: cualquier vendedora ve las listas "generales"
-- (owner_vendedora_id null), pero una lista "personal" (ej. 'luzmar') solo
-- la ve su dueña — el resto de vendedoras no debe ver esa columna en la
-- matriz de precios ni esa opción en los selectores de lista (2026-07-15,
-- a pedido del usuario: son precios negociados en privado con esa vendedora).
drop policy if exists vendedora_select_readonly on public.price_lists;
drop policy if exists vendedora_select_price_lists on public.price_lists;
create policy vendedora_select_price_lists on public.price_lists
  for select to authenticated
  using (
    public.is_vendedora()
    and (owner_vendedora_id is null or owner_vendedora_id = public.current_vendedora_id())
  );

drop policy if exists vendedora_select_readonly on public.product_prices;
drop policy if exists vendedora_select_product_prices on public.product_prices;
create policy vendedora_select_product_prices on public.product_prices
  for select to authenticated
  using (
    public.is_vendedora()
    and exists (
      select 1 from public.price_lists pl
      where pl.id = product_prices.price_list_id
        and (pl.owner_vendedora_id is null or pl.owner_vendedora_id = public.current_vendedora_id())
    )
  );

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
          'product_line', p.product_line,
          'image_url',    p.image_url,
          'availability', p.availability,
          'is_new',       (p.new_until is not null and now() < p.new_until),
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
          'product_line', p.product_line,
          'image_url',    p.image_url,
          'availability', p.availability,
          'is_new',       (p.new_until is not null and now() < p.new_until),
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

-- ---------- helper: compute_order_items ----------
-- Recalcula id/sku/name/qty/price/flash de una lista de ítems para un
-- cliente dado (flash vigente si aplica, si no precio de su lista; nunca
-- precio si p_kind = 'quote'). Factorizado 2026-07-17 de lo que antes era
-- el cuerpo de create_order, para reusarlo también en update_order_items
-- (edición auditada de pedidos) y get_quotes_live_pricing (una
-- cotización siempre se recalcula con el precio VIGENTE, nunca el
-- congelado al momento del pedido). SECURITY INVOKER a propósito: solo la
-- llaman otras funciones SECURITY DEFINER (mismo dueño), nunca
-- directamente anon/authenticated.
create or replace function public.compute_order_items(
  p_client_id uuid,
  p_items     jsonb,
  p_kind      text
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_client    public.clients%rowtype;
  v_item      jsonb;
  v_id        uuid;
  v_qty       int;
  v_flash     boolean;
  v_product   public.products%rowtype;
  v_price     numeric;
  v_items     jsonb   := '[]'::jsonb;
  v_total     numeric := 0;
  v_has_price boolean := false;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    return jsonb_build_object('items', '[]'::jsonb, 'total', null);
  end if;

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
    if p_kind = 'order' then
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

  return jsonb_build_object(
    'items', v_items,
    'total', case when p_kind = 'order' and v_has_price then round(v_total, 2) else null end
  );
end;
$$;

revoke execute on function public.compute_order_items(uuid, jsonb, text) from public;

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
  v_result    jsonb;
  v_items     jsonb;
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
  -- 'quote' sin precio, sin importar lo que mande el frontend. Desde
  -- 2026-07-17 el frontend también manda p_kind = 'quote' explícito al
  -- descargar el PDF desde el carrito (sin importar la lista del
  -- cliente), para que quede registrado como cotización en el panel.
  v_kind := case when v_list_code = 'quote' or p_kind = 'quote' then 'quote' else 'order' end;

  v_result := public.compute_order_items(v_client.id, p_items, v_kind);
  v_items  := v_result->'items';

  if jsonb_array_length(v_items) = 0 then
    return null;
  end if;

  insert into public.orders (client_id, items, total, kind)
  values (v_client.id, v_items, (v_result->>'total')::numeric, v_kind)
  returning id into v_order_id;

  return v_order_id;
end;
$$;

revoke execute on function public.create_order(text, jsonb, numeric, text) from public;
grant execute on function public.create_order(text, jsonb, numeric, text) to anon, authenticated;

-- ---------- RPC: update_order_items ----------
-- Edición auditada de los ítems de un pedido (2026-07-17, a pedido del
-- usuario: una vendedora puede corregir un pedido ya recibido —
-- cantidades, productos agregados/quitados— sin tener que pedirle al
-- admin que entre a la base). SECURITY DEFINER + el trigger
-- orders_guard_items_edit (ver arriba, tabla orders) garantizan que la
-- única forma de tocar items/total de un pedido sea por acá, y que quede
-- registrado en admin_audit_log sí o sí — igual criterio que
-- reassign_client/delete_client/update_client_price_list.
create or replace function public.update_order_items(
  p_order_id uuid,
  p_items    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  public.orders%rowtype;
  v_client public.clients%rowtype;
  v_result jsonb;
  v_email  text;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'pedido no encontrado';
  end if;

  select * into v_client from public.clients where id = v_order.client_id;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso para editar este pedido';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'no se puede editar un pedido cancelado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 200 then
    raise exception 'items inválidos';
  end if;

  -- Igual que create_order: nunca se congela precio de una cotización,
  -- se recalcula siempre al vuelo (ver get_quotes_live_pricing).
  v_result := public.compute_order_items(v_client.id, p_items, v_order.kind);

  if jsonb_array_length(v_result->'items') = 0 then
    raise exception 'el pedido debe tener al menos un producto válido';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('edit_order_items', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object(
       'before_items', v_order.items,
       'before_total', v_order.total,
       'after_items',  v_result->'items',
       'after_total',  v_result->'total'
     ));

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set items = v_result->'items', total = (v_result->>'total')::numeric
  where id = p_order_id;

  return v_result;
end;
$$;

revoke execute on function public.update_order_items(uuid, jsonb) from public;
grant execute on function public.update_order_items(uuid, jsonb) to authenticated;

-- ---------- RPC: get_quotes_live_pricing ----------
-- Una cotización (kind = 'quote') nunca guarda precio congelado (ver
-- compute_order_items): el panel de Pedidos necesita calcularlo al vuelo
-- con el precio VIGENTE de cada producto en la lista del cliente, para
-- que se ajuste sola a cambios de precio posteriores (2026-07-17, a
-- pedido del usuario). Devuelve un objeto {order_id: {items, total}} —
-- se omiten los pedidos que el caller no tiene permiso de ver (RLS no
-- aplica acá por ser SECURITY DEFINER, se replica el mismo filtro a
-- mano) en vez de tirar error, para poder pedir varios de una sola vez
-- sin que uno ajeno tumbe el resto.
create or replace function public.get_quotes_live_pricing(p_order_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := public.is_admin();
  v_vend_id  uuid    := public.current_vendedora_id();
  v_result   jsonb   := '{}'::jsonb;
  v_order    public.orders%rowtype;
  v_client   public.clients%rowtype;
  v_priced   jsonb;
begin
  if not (v_is_admin or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  for v_order in
    select * from public.orders where id = any(p_order_ids) and kind = 'quote'
  loop
    select * into v_client from public.clients where id = v_order.client_id;
    if not found then continue; end if;
    if not v_is_admin and v_client.vendedora_id is distinct from v_vend_id then
      continue;
    end if;

    v_priced := public.compute_order_items(v_client.id, v_order.items, 'order');
    v_result := v_result || jsonb_build_object(v_order.id::text, v_priced);
  end loop;

  return v_result;
end;
$$;

revoke execute on function public.get_quotes_live_pricing(uuid[]) from public;
grant execute on function public.get_quotes_live_pricing(uuid[]) to authenticated;

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
