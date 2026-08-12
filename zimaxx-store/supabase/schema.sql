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

-- Dueñas de una lista de precio (2026-07-09 como columna única
-- `price_lists.owner_vendedora_id`; 2026-08-04 pasó a esta tabla para poder
-- COMPARTIR una lista entre varias vendedoras, ver
-- migration-2026-08-04-shared-price-lists.sql). Tres estados posibles:
--
--   * sin filas acá  → lista general (us_min, special, etc.): la ve y la usa
--                      cualquier vendedora
--   * una fila       → lista "personal" (ej. Luzmar Quintero): solo ella la ve
--                      y todo cliente con esa lista queda asignado a ella
--   * varias filas   → lista compartida: solo esas vendedoras la ven, y cada
--                      cliente de la lista queda con UNA de ellas
--
-- `is_primary` (una sola por lista) es la dueña por defecto: la que se asigna
-- cuando el cliente entra a la lista con una vendedora que no es dueña.
create table if not exists public.price_list_owners (
  price_list_id uuid        not null references public.price_lists (id) on delete cascade,
  vendedora_id  uuid        not null references public.vendedores (id) on delete cascade,
  is_primary    boolean     not null default false,
  created_at    timestamptz not null default now(),
  primary key (price_list_id, vendedora_id)
);

create unique index if not exists price_list_owners_primary_key
  on public.price_list_owners (price_list_id) where is_primary;

create index if not exists price_list_owners_vendedora_idx
  on public.price_list_owners (vendedora_id);

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

-- Garantiza a nivel de base de datos que un cliente con una lista que tiene
-- dueñas (`price_list_owners`, ej. 'luzmar') SIEMPRE queda asignado a UNA de
-- ellas (2026-07-09, a pedido del usuario: evitar que un cliente con precios
-- especiales de Luzmar termine en la cuenta de otra vendedora; 2026-08-04
-- adaptado a listas compartidas entre varias). ClientsAdmin.jsx ya evita esto
-- en la UI (preselecciona y acota el selector), pero eso es solo UX — este
-- trigger es la garantía real, cubre también la carga por Excel, el sync y
-- cualquier escritura directa a la tabla que se le escape al frontend.
--
--   * lista sin dueñas → no se toca nada
--   * la vendedora que viene YA es dueña → se respeta (así se reparten los
--     clientes de una lista compartida entre sus dueñas)
--   * si no → se fuerza la dueña principal
--
-- Corre en TODO insert/update a propósito: si se le quita una dueña a una
-- lista, sus clientes quedan asignados a alguien que ya no es dueña, y esto
-- es lo que los endereza en la próxima escritura (una versión que se salteaba
-- los updates "irrelevantes" dejaba esas filas inconsistentes para siempre).
create or replace function public.enforce_owner_vendedora()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.price_list_id is null then
    return new;
  end if;

  if not public.price_list_has_owners(new.price_list_id) then
    return new;
  end if;

  if public.is_price_list_owner(new.price_list_id, new.vendedora_id) then
    return new;
  end if;

  new.vendedora_id := public.price_list_primary_owner(new.price_list_id);
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

-- Stock real del producto (2026-07-14, migration-2026-07-14-inventory-stock.sql
-- — mergeado acá 2026-08-04 al sumarle el descuento por pedido). Nullable:
-- null = "todavía no se sabe el stock" (producto cargado antes de que el sync
-- trajera InventoryAvailableQTY), distinto de 0 = "sin stock". NO se expone en
-- el catálogo del cliente (get_catalog arma el JSON con campos explícitos y no
-- la incluye), solo se ve en el panel admin.
alter table public.products
  add column if not exists stock int;

-- ¿Lo apagó la regla de stock 0? (2026-08-12,
-- migration-2026-08-12-hide-out-of-stock.sql). No es "está sin stock" —eso ya lo
-- dice products.stock— sino "esta regla fue la que lo despublicó", que es lo
-- único que habilita volver a prenderlo solo cuando entre stock.
--
--   true  → inactivo por falta de stock; vuelve SOLO cuando entre stock
--   false → si está inactivo, lo apagó una persona (o la exclusión de
--           no-catálogo) y solo una persona lo vuelve a prender
alter table public.products
  add column if not exists deactivated_by_stock boolean not null default false;

-- Disponibilidad y publicación derivadas del stock (2026-08-04,
-- migration-2026-08-04-order-stock.sql; ampliado 2026-08-12,
-- migration-2026-08-12-hide-out-of-stock.sql). La regla vivía duplicada en cada
-- camino de escritura (sync_upsert_products, resolveAvailability de
-- ProductsAdmin.jsx) y apply_price_list la pisaba sin querer; acá pasa a ser
-- una invariante de la tabla: no importa quién escriba (sync, Excel, carga
-- masiva, formulario, el descuento de un pedido atendido o un request
-- directo), un producto con stock 0 no puede quedar marcado Disponible ni
-- publicado en el catálogo.
--
--   stock null → no se toca (no se sabe el stock; manda availability)
--   stock >= 1 → 'available' + se reactiva si lo había apagado esta regla
--   stock <= 0 → 'preorder'  + INACTIVO (no sale en get_catalog)
--   'flash'    → la etiqueta se conserva siempre (el stock solo alterna
--                available↔preorder), pero con stock <= 0 también se
--                desactiva: la etiqueta 🔥 no publica nada
--
-- 2026-08-12 revierte a propósito media decisión de 2026-07-14 ("un producto
-- con stock 0 se MUESTRA como pre-order; ocultarlo es una acción manual
-- aparte"). Sigue quedando en 'preorder' —es el dato con el que la asesora sabe
-- que se puede reservar— pero deja de publicarse.
create or replace function public.products_availability_from_stock()
returns trigger
language plpgsql
as $$
begin
  -- Sin dato de stock no se deduce nada: null es "todavía no se sabe", no "0".
  if new.stock is null then
    return new;
  end if;

  if coalesce(new.availability, '') <> 'flash' then
    new.availability := case when new.stock >= 1 then 'available' else 'preorder' end;
  end if;

  if new.stock <= 0 then
    -- La bandera se marca solo cuando ESTA regla es la que apaga. Si la fila ya
    -- venía inactiva se deja como está: puede ser un producto que apagó el admin
    -- (false, no vuelve solo) o uno que esta regla ya apagó antes (true).
    if new.active then
      new.active               := false;
      new.deactivated_by_stock := true;
    end if;
  elsif new.deactivated_by_stock then
    new.active               := true;
    new.deactivated_by_stock := false;
  end if;

  return new;
end;
$$;

drop trigger if exists products_availability_from_stock on public.products;
create trigger products_availability_from_stock
  before insert or update on public.products
  for each row execute function public.products_availability_from_stock();

create table if not exists public.product_prices (
  product_id    uuid not null references public.products (id) on delete cascade,
  price_list_id uuid not null references public.price_lists (id) on delete cascade,
  price         numeric(10, 2) not null check (price >= 0),
  primary key (product_id, price_list_id)
);

-- ⚠ LEGADO (2026-08-07): la app ya NO usa esta tabla. Las "ofertas con
-- precio promo + cuenta regresiva" se eliminaron del producto — la pestaña
-- Flash Sales del panel y la sección del catálogo se borraron, y nada llama
-- más a get_flash_sales(). Hoy una Flash Sale es solo la ETIQUETA del
-- producto (products.availability = 'flash'), que se pone desde la pestaña
-- Productos y el cliente filtra con el chip 🔥.
-- La tabla, sus datos y las funciones que la leen se dejan en pie a
-- propósito: no se borró nada (es reversible) y compute_order_items todavía
-- la consulta para revalorizar una línea vieja marcada `flash` de un pedido
-- anterior — como ya no hay ofertas vigentes, cae al precio de lista, que es
-- justo lo que corresponde. No hace falta ninguna migración.
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

-- ¿Este pedido ya descontó su stock? (2026-08-04,
-- migration-2026-08-04-order-stock.sql.) Marcar Atendido descuenta las
-- cantidades de products.stock; reabrir o cancelar las devuelve. No se puede
-- deducir del estado: un pedido puede ir done → new → done varias veces, y la
-- bandera es la que evita el doble descuento.
alter table public.orders
  add column if not exists stock_applied boolean not null default false;

-- Idempotencia del alta (2026-08-05, migration-2026-08-05-order-capture.sql):
-- el navegador genera un uuid por CARRITO y lo manda en cada intento de ese
-- mismo pedido, así reintentar un envío que falló devuelve el pedido ya
-- guardado en vez de duplicarlo. Null en los pedidos previos al cambio y en
-- los que llegan de un frontend sin actualizar — de ahí que el índice sea
-- parcial: sin el `where`, dos pedidos sin request_id chocarían entre sí.
alter table public.orders
  add column if not exists request_id uuid;

create unique index if not exists orders_request_id_key
  on public.orders (request_id) where request_id is not null;

-- Blinda items/total/status/kind/stock_applied/request_id de un pedido para
-- que solo se editen a través de las RPC update_order_items/
-- update_order_status/convert_quote_to_order (2026-07-17, ampliado el mismo
-- día: originalmente solo cubría items/total; 2026-08-04 suma stock_applied;
-- 2026-08-05 suma request_id, que si se pudiera reescribir a mano permitiría
-- romper la idempotencia de arriba): así cualquier cambio queda auditado sí o
-- sí en admin_audit_log, igual que
-- reassign_client/delete_client/update_client_price_list. Cada RPC prende la
-- bandera de sesión app.allow_order_edit antes de escribir; sin esto, la
-- policy vendedora_update_own_orders (pensada para que una vendedora marque
-- sus pedidos atendido/nuevo) le hubiera permitido tocar cualquier columna
-- directo, sin auditar — incluida stock_applied, con lo que podría saltarse o
-- duplicar el descuento de stock.
create or replace function public.orders_guard_items_edit()
returns trigger
language plpgsql
as $$
begin
  if (new.items is distinct from old.items
      or new.total is distinct from old.total
      or new.status is distinct from old.status
      or new.kind is distinct from old.kind
      or new.stock_applied is distinct from old.stock_applied
      or new.request_id is distinct from old.request_id)
     and coalesce(current_setting('app.allow_order_edit', true), '') <> 'on' then
    raise exception 'los pedidos solo se editan via update_order_items/update_order_status/convert_quote_to_order';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_guard_items_edit on public.orders;
create trigger orders_guard_items_edit
  before update on public.orders
  for each row execute function public.orders_guard_items_edit();

-- Los pedidos que el cliente envió y NO entraron (2026-08-05,
-- migration-2026-08-05-order-capture.sql). Existe porque un pedido de ~10k se
-- perdió sin dejar rastro: create_order lo rechazó con un `return null` mudo
-- (superaba el tope de líneas de entonces, 200), el frontend igual abrió
-- WhatsApp y el cliente vio el ✓ de enviado. El único registro del rechazo era
-- un console.warn en el teléfono del cliente.
--
-- `items` se guarda solo cuando el token era válido (cliente real): con un
-- token inválido se registra el motivo y el conteo, si no cualquiera con la
-- anon key podría inflar la tabla mandando payloads enormes a repetición.
-- recover_order_failure (más abajo) los rescata sin que el cliente rearme nada.
create table if not exists public.order_failures (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references public.clients (id) on delete set null,
  token_hint  text,               -- primeros 8 caracteres, para rastrear sin guardar la credencial
  reason      text not null,
  line_count  int,
  kind        text,
  items       jsonb,              -- null cuando el token no era válido
  created_at  timestamptz not null default now()
);

-- Apunta al pedido creado al rescatar este fallo. Null = sin recuperar, que es
-- lo que muestra el aviso de OrdersAdmin.jsx.
alter table public.order_failures
  add column if not exists recovered_order_id uuid references public.orders (id) on delete set null;

create index if not exists order_failures_created_idx
  on public.order_failures (created_at desc);

alter table public.order_failures enable row level security;

create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- Superadmin (2026-08-05, migration-2026-08-05-superadmin.sql): un solo
-- perfil que puede hacer, desde el panel, lo que antes solo se podía hacer en
-- el SQL Editor o en el dashboard de Auth — nombrar admins, cambiar
-- contraseñas y asignar/desasignar listas de precio a vendedoras.
--
-- Por qué una tabla aparte y no una columna en `admins`: hasta esta migración
-- `admins` tenía la policy `admin_all`, o sea que cualquier admin podía
-- escribirla vía API. Si la marca de superadmin viviera ahí, cualquiera se
-- habría podido coronar. Esta tabla tiene RLS activo y CERO policies: desde la
-- app no existe: solo la leen las funciones SECURITY DEFINER (que corren como
-- el dueño y saltan RLS) y el SQL Editor. Sumar o quitar un superadmin es, a
-- propósito, una acción de SQL Editor — es la llave maestra, no un permiso más
-- del panel.
create table if not exists public.superadmins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.superadmins enable row level security;
revoke all on table public.superadmins from anon, authenticated;

-- Semilla del único superadmin. No-op si ese usuario todavía no existe en
-- Auth (instalación desde cero): se puede re-correr este archivo después de
-- crearlo. La migración equivalente sí corta con error si no lo encuentra,
-- porque ahí es el objetivo del cambio.
insert into public.superadmins (user_id)
select id from auth.users where lower(email) = lower('support5@firstchoiceonline.com')
on conflict do nothing;

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

-- La RLS de admin_audit_log vive en la sección "RLS" del final, junto con la
-- del resto de las tablas: la policy usa `is_admin()`, que se define más
-- abajo en este archivo, y una policy sí valida sus funciones al crearse.
-- Estuvo acá arriba entre 2026-07-15 y 2026-08-04 y rompía `schema.sql` en
-- una instalación desde cero ("function public.is_admin() does not exist") —
-- no se notó porque producción ya existía desde antes y nadie volvió a correr
-- el archivo completo.

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

-- Hace a Luzmar Quintero dueña principal de la lista 'luzmar' (por nombre,
-- sin distinguir mayúsculas — hay índice único sobre lower(name)). No-op si
-- todavía no existe esa vendedora: se puede re-correr después de crearla.
-- Para COMPARTIR la lista con otra vendedora, agregar otra fila a
-- price_list_owners con is_primary = false (ver
-- migration-2026-08-04-shared-price-lists.sql, al final tiene los queries).
insert into public.price_list_owners (price_list_id, vendedora_id, is_primary)
select pl.id, v.id, true
from public.price_lists pl, public.vendedores v
where pl.code = 'luzmar' and lower(v.name) = 'luzmar quintero'
on conflict (price_list_id, vendedora_id) do nothing;

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

-- ---------- Helper: es superadmin ----------
-- Va antes de is_admin() porque este lo llama y Postgres valida el cuerpo de
-- una función `language sql` al crearla.
create or replace function public.is_superadmin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.superadmins where user_id = auth.uid());
$$;

revoke execute on function public.is_superadmin() from public, anon;
grant execute on function public.is_superadmin() to authenticated;

-- ---------- Helper: es admin ----------
-- El superadmin es admin por definición (2026-08-05): así no puede quedarse
-- afuera del panel ni borrándose a sí mismo de `admins` desde la UI nueva, y
-- todas las policies/RPC que ya usaban is_admin() lo siguen dejando entrar sin
-- tocarlas una por una.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
      or public.is_superadmin();
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

-- ---------- Helpers: dueñas de una lista de precio ----------
-- (2026-08-04, migration-2026-08-04-shared-price-lists.sql.) SECURITY
-- DEFINER a propósito: los usan las policies RLS de price_lists/
-- product_prices y el trigger de clients, así que no pueden depender de que
-- quien pregunta tenga permiso de leer price_list_owners — si no, la policy
-- se muerde la cola. Mismo criterio que is_admin()/current_vendedora_id().
create or replace function public.price_list_has_owners(p_price_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.price_list_owners where price_list_id = p_price_list_id
  );
$$;

create or replace function public.is_price_list_owner(p_price_list_id uuid, p_vendedora_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_vendedora_id is not null and exists (
    select 1 from public.price_list_owners
    where price_list_id = p_price_list_id and vendedora_id = p_vendedora_id
  );
$$;

-- Dueña principal (null si la lista no tiene dueñas). El order by cubre el
-- caso raro de que ninguna esté marcada como principal.
create or replace function public.price_list_primary_owner(p_price_list_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select vendedora_id
  from public.price_list_owners
  where price_list_id = p_price_list_id
  order by is_primary desc, created_at, vendedora_id
  limit 1;
$$;

-- ¿La vendedora logueada puede usar esta lista? (general, o es una de sus
-- dueñas.) Es la regla que aplican las policies de price_lists/product_prices.
create or replace function public.can_vendedora_use_price_list(p_price_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not public.price_list_has_owners(p_price_list_id)
      or public.is_price_list_owner(p_price_list_id, public.current_vendedora_id());
$$;

revoke execute on function public.price_list_primary_owner(uuid) from public;
grant execute on function public.price_list_has_owners(uuid) to authenticated;
grant execute on function public.is_price_list_owner(uuid, uuid) to authenticated;
grant execute on function public.can_vendedora_use_price_list(uuid) to authenticated;

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

  -- Una vendedora (no admin) no puede asignar una lista con dueñas si no es
  -- una de ellas (ej. luzmar) — mismo candado que ya aplica
  -- selectablePriceLists en el frontend, reforzado acá server-side.
  if not public.is_admin()
     and public.price_list_has_owners(p_price_list_id)
     and not public.is_price_list_owner(p_price_list_id, public.current_vendedora_id()) then
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
  v_blocked_by_stock  int;   -- 2026-08-12
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
      -- 2026-08-06 (migration-2026-08-06-require-price.sql): se suma `> 0`. Un 0
      -- (o "0.00", o una columna corrida que dejó ceros) no es un precio: la fila
      -- pasa a contarse en `invalid_prices` en vez de publicar el producto en
      -- $0.00. Todo lo de abajo ya filtraba por `price is not null`, así que
      -- hereda la regla sin tocar una línea más. Efecto secundario buscado: un
      -- producto que hoy tiene precio y se sube con 0 cae en tmp_deactivate igual
      -- que si no viniera en el archivo — y eso sale en el conteo "a desactivar"
      -- del preview, así que no es silencioso.
      when d.price_raw ~ '^[0-9]+(\.[0-9]+)?$' and d.price_raw::numeric > 0
        then d.price_raw::numeric
      else null
    end as price,
    case
      when d.type_raw ~* 'pre.?order' then 'preorder'
      when d.type_raw ~* 'flash'      then 'flash'
      else 'available'
    end as availability,
    p.id     as product_id,
    p.name   as product_name,
    p.active as was_active,
    -- 2026-08-12: hace falta para saber a quién va a dejar apagado el trigger
    -- por no tener stock (ver los contadores más abajo).
    p.stock  as product_stock
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
  -- "A reactivar" = los que van a volver a verse DE VERDAD (2026-08-12). Los
  -- inactivos con stock <= 0 no vuelven con esta carga: el trigger los deja
  -- apagados y marcados para publicarse cuando entre stock, así que van a un
  -- contador propio en vez de inflar la promesa del preview.
  select count(*) into v_to_reactivate
    from tmp_price_rows
    where product_id is not null and price is not null and was_active = false
      and (product_stock is null or product_stock >= 1);
  select count(*) into v_blocked_by_stock
    from tmp_price_rows
    where product_id is not null and price is not null and was_active = false
      and product_stock is not null and product_stock <= 0;
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

    -- active = true a propósito, aunque el trigger apague lo que no tenga stock
    -- (2026-08-12): el archivo de precios dice "este producto se publica", y el
    -- trigger lo deja marcado para publicarse solo cuando entre stock.
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

    -- Sacar un producto de la lista es decisión de una persona, así que también
    -- cancela el regreso automático por stock (2026-08-12): sin el
    -- `deactivated_by_stock = false`, uno que la regla de stock había apagado
    -- volvería solo al catálogo en la próxima entrada de inventario,
    -- contradiciendo esta misma carga.
    update public.products p
    set active = false,
        deactivated_by_stock = false
    from tmp_deactivate d
    where p.id = d.product_id;
  end if;

  return jsonb_build_object(
    'committed',          p_commit,
    'list',               jsonb_build_object('code', v_list.code, 'label', v_list.label),
    'to_upsert',          v_to_upsert,
    'to_reactivate',      v_to_reactivate,
    'blocked_by_stock',   v_blocked_by_stock,
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

alter table public.price_lists       enable row level security;
alter table public.price_list_owners enable row level security;
alter table public.clients           enable row level security;
alter table public.vendedores        enable row level security;
alter table public.products          enable row level security;
alter table public.product_prices    enable row level security;
alter table public.flash_sales       enable row level security;
alter table public.orders            enable row level security;
alter table public.admins            enable row level security;
alter table public.admin_audit_log   enable row level security;

-- admin_audit_log: solo lectura para admin. Sin policy de insert/update/
-- delete para nadie — es inmutable para cualquier usuario autenticado, solo
-- la escriben las funciones SECURITY DEFINER (reassign_client/delete_client/
-- update_client_price_list/update_order_items/update_order_status/
-- convert_quote_to_order). Va acá y no junto a la tabla porque la policy
-- necesita que `is_admin()` ya exista.
drop policy if exists admin_read_audit on public.admin_audit_log;
create policy admin_read_audit on public.admin_audit_log
  for select to authenticated
  using (public.is_admin());

-- order_failures (2026-08-05): mismo criterio que admin_audit_log — solo
-- lectura, y solo la escribe create_order (SECURITY DEFINER). Una vendedora ve
-- los fallos de sus propios clientes; los que no tienen cliente resuelto
-- (token inválido) son solo para el admin. Sin policy de insert/update/delete
-- para nadie, y ninguna para anon.
drop policy if exists admin_read_failures on public.order_failures;
create policy admin_read_failures on public.order_failures
  for select to authenticated
  using (public.is_admin());

drop policy if exists vendedora_read_own_failures on public.order_failures;
create policy vendedora_read_own_failures on public.order_failures
  for select to authenticated
  using (client_id in (select id from public.clients where vendedora_id = public.current_vendedora_id()));

-- Explícito aunque los default privileges de Supabase ya cubran a
-- authenticated sobre todo public: quién puede leer una tabla nueva no debería
-- depender de un default que no está escrito en ningún lado. Las policies de
-- arriba son el control real.
grant select on public.order_failures to authenticated;

-- Admin autenticado: acceso total a todo (via is_admin, que es security
-- definer para evitar recursión de RLS sobre admins).
-- `admins` y `price_list_owners` NO están en esta lista desde 2026-08-05
-- (migration-2026-08-05-superadmin.sql): quién es admin y de quién es una
-- lista de precio lo escribe solo el superadmin, ver las policies más abajo.
do $$
declare t text;
begin
  foreach t in array array['price_lists','clients','vendedores','products','product_prices','flash_sales','orders']
  loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format(
      'create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
      t
    );
  end loop;
end $$;

-- Solo superadmin escribe; admin lee (2026-08-05). Antes las dos tablas
-- estaban en el loop de arriba, o sea que cualquier admin podía nombrar
-- admins o cambiar las dueñas de una lista con un request directo — nunca
-- hubo UI, pero el permiso estaba. La lectura de admin sobre
-- price_list_owners sí la usa el frontend (ClientsAdmin.jsx pide
-- `price_lists(*, price_list_owners(...))` para saber qué listas tienen dueña).
do $$
declare t text;
begin
  foreach t in array array['admins','price_list_owners']
  loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('drop policy if exists superadmin_all on public.%I', t);
    execute format(
      'create policy superadmin_all on public.%I for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin())',
      t
    );
    execute format('drop policy if exists admin_read_only on public.%I', t);
    execute format(
      'create policy admin_read_only on public.%I for select to authenticated using (public.is_admin())',
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
-- porque una lista con dueñas (`price_list_owners`, ej. 'luzmar') es de
-- lectura exclusiva de ellas, no de cualquiera con el rol.
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
-- (sin dueñas), pero una lista con dueñas (ej. 'luzmar') solo la ven ellas —
-- el resto de vendedoras no debe ver esa columna en la matriz de precios ni
-- esa opción en los selectores de lista (2026-07-15, a pedido del usuario:
-- son precios negociados en privado; 2026-08-04 adaptado a listas
-- compartidas entre varias vendedoras).
drop policy if exists vendedora_select_readonly on public.price_lists;
drop policy if exists vendedora_select_price_lists on public.price_lists;
create policy vendedora_select_price_lists on public.price_lists
  for select to authenticated
  using (
    public.is_vendedora()
    and public.can_vendedora_use_price_list(id)
  );

-- price_list_owners: una vendedora ve las filas de las listas que puede usar
-- (así el panel sabe con quién comparte su lista). No puede escribir —
-- agregar o quitar dueñas es acción de admin (hoy por SQL, ver
-- migration-2026-08-04-shared-price-lists.sql).
drop policy if exists vendedora_select_price_list_owners on public.price_list_owners;
create policy vendedora_select_price_list_owners on public.price_list_owners
  for select to authenticated
  using (
    public.is_vendedora()
    and public.can_vendedora_use_price_list(price_list_id)
  );

drop policy if exists vendedora_select_readonly on public.product_prices;
drop policy if exists vendedora_select_product_prices on public.product_prices;
create policy vendedora_select_product_prices on public.product_prices
  for select to authenticated
  using (
    public.is_vendedora()
    and public.can_vendedora_use_price_list(price_list_id)
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
      -- 2026-08-06 (migration-2026-08-06-require-price.sql): `> 0` y no
      -- `is not null`. Un precio 0 no es un precio — era la puerta por la que un
      -- producto entraba al catálogo en $0.00 y se podía pedir gratis
      -- (product_prices.price es `not null check (price >= 0)`, así que 0 es un
      -- valor válido para la tabla, y el Excel de precios lo aceptaba).
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

-- ---------- RPC: get_flash_sales ----------
-- ⚠ LEGADO (2026-08-07): sin llamadores. El catálogo dejó de pedirla al
-- eliminarse la sección de ofertas; se deja creada por si hiciera falta
-- volver atrás. Ver la nota sobre la tabla `flash_sales` más arriba.
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
    -- Mismo criterio que get_catalog (2026-08-06): una oferta en 0 no se
    -- publica. flash_sales.price tiene el mismo `check (price >= 0)`, así que
    -- una carga masiva con la columna de precio corrida podía llenar la sección
    -- Flash Sale de $0.00.
    and fs.price > 0
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

    -- 2026-08-12 (migration-2026-08-12-hide-out-of-stock.sql):
    -- `or p.deactivated_by_stock`. Desde que quedarse sin stock DESACTIVA, un
    -- producto que el cliente ya tenía en el carrito puede haber salido del
    -- catálogo entre que lo agregó y lo mandó — y una línea de producto inactivo
    -- se descarta acá en silencio (`continue`), o sea que el pedido entraría con
    -- menos ítems sin que nadie se entere. En este proyecto una línea que se cae
    -- en silencio ya costó un pedido de ~10k.
    -- La bandera es la diferencia que hace falta: lo que salió del catálogo por
    -- falta de stock se sigue pudiendo pedir (es un pre-order, "agotado pero se
    -- puede reservar", y el carrito ya avisa que la disponibilidad la confirma
    -- la asesora); lo que apagó una persona sigue sin poder pedirse.
    select p.* into v_product
    from public.products p
    where p.id = v_id
      and (p.active or p.deactivated_by_stock);
    if not found then continue; end if;

    v_price := null;
    if p_kind = 'order' then
      if v_flash then
        select fs.price into v_price
        from public.flash_sales fs
        where fs.product_id = v_id
          and fs.active
          and fs.price > 0
          and now() >= fs.starts_at
          and now() < fs.expires_at
        order by fs.price
        limit 1;
      end if;
      -- Sin flash vigente (o expiró entre carrito y checkout): precio de lista.
      -- `pp.price > 0` (2026-08-06): un 0 se comporta igual que "no hay fila",
      -- o sea que v_price queda null y todo lo que ya sabía tratar "sin precio"
      -- (el total que no suma, el '—' de la tabla de pedidos, el PDF sin
      -- precios) sigue funcionando sin cambios. El ítem NO se descarta a
      -- propósito: descartarlo lo haría desaparecer de la vista de cotizaciones
      -- con precio vigente sin decir nada. Quien decide qué hacer con una línea
      -- sin precio es el que crea el pedido — ver create_order y
      -- convert_quote_to_order.
      if v_price is null then
        select pp.price into v_price
        from public.product_prices pp
        where pp.product_id = v_id
          and pp.price_list_id = v_client.price_list_id
          and pp.price > 0;
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
--
-- 2026-08-05 (migration-2026-08-05-order-capture.sql), después de perderse un
-- pedido de ~10k: el tope de líneas pasó de 200 a 1000, todo rechazo queda en
-- order_failures en vez de desaparecer, y p_request_id hace idempotente el
-- alta. El tope no se puede sacar del todo: compute_order_items cuesta
-- ~48 ms con 200 líneas, 651 ms con 1000 y 2.4 s con 2000 (crece superlineal
-- porque el acumulador `v_items || ...` copia el jsonb entero en cada vuelta),
-- así que pasando las ~2000 se choca con el statement_timeout del rol anon y
-- volvería el mismo fallo silencioso por otra puerta.
create or replace function public.create_order(
  p_token      text,
  p_items      jsonb,
  p_total      numeric,
  p_kind       text default 'order',
  p_request_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client     public.clients%rowtype;
  v_list_code  text;
  v_kind       text;
  v_result     jsonb;
  v_items      jsonb;
  v_order_id   uuid;
  v_no_price   text;
  v_hint       text := left(coalesce(p_token, ''), 8);
  v_lines      int  := case when jsonb_typeof(p_items) = 'array'
                            then jsonb_array_length(p_items) end;
begin
  select * into v_client from public.clients where token = p_token;
  if not found then
    -- Token inválido: al cliente no se le explica nada, pero queda el rastro.
    -- Sin items, ver el comentario de la tabla.
    insert into public.order_failures (token_hint, reason, line_count, kind)
    values (v_hint, 'token inválido', v_lines, p_kind);
    return null;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
    values (v_client.id, v_hint, 'payload vacío o mal formado', v_lines, p_kind, p_items);
    return null;
  end if;

  if jsonb_array_length(p_items) > 1000 then
    insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
    values (v_client.id, v_hint,
            format('demasiadas líneas: %s (el tope es 1000)', v_lines),
            v_lines, p_kind, p_items);
    return null;
  end if;

  -- Reintento del mismo carrito: devolver el pedido que ya se guardó, no otro.
  -- Va después de las validaciones para que un payload inválido no se "cure"
  -- solo por traer un request_id conocido.
  if p_request_id is not null then
    select id into v_order_id from public.orders where request_id = p_request_id;
    if found then
      return v_order_id;
    end if;
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
    -- Todos los ítems se cayeron en compute_order_items: productos
    -- desactivados o borrados entre que el cliente armó el carrito y lo envió.
    insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
    values (v_client.id, v_hint, 'ningún ítem válido (productos inactivos o inexistentes)',
            v_lines, v_kind, p_items);
    return null;
  end if;

  -- 2026-08-06 (migration-2026-08-06-require-price.sql): un pedido real con una
  -- línea sin precio no se guarda. Con el filtro de get_catalog el cliente ya no
  -- puede ver un producto sin precio, pero queda como red: la sección Flash Sale
  -- se sirve sin token (no sabe la lista del cliente) y si una oferta expira
  -- entre el carrito y el checkout el precio cae a la lista, que puede no tener
  -- ese producto. Se rechaza el pedido ENTERO y queda en order_failures con los
  -- SKU culpables, en vez de guardar una línea en cero: el admin lo ve en el
  -- aviso rojo de Pedidos, carga el precio y le da "Recuperar". En una cotización
  -- no aplica — no llevan precio por definición.
  if v_kind = 'order' then
    select string_agg(e->>'sku', ', ' order by e->>'sku')
      into v_no_price
    from jsonb_array_elements(v_items) e
    where e->>'price' is null;

    if v_no_price is not null then
      insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
      values (v_client.id, v_hint,
              format('productos sin precio en la lista del cliente: %s', v_no_price),
              v_lines, v_kind, p_items);
      return null;
    end if;
  end if;

  -- Carrera entre dos envíos del mismo carrito (el cliente toca dos veces y
  -- los dos requests pasan las validaciones a la vez): el índice único deja
  -- entrar solo al primero y acá se devuelve ese mismo pedido.
  begin
    insert into public.orders (client_id, items, total, kind, request_id)
    values (v_client.id, v_items, (v_result->>'total')::numeric, v_kind, p_request_id)
    returning id into v_order_id;
  exception when unique_violation then
    select id into v_order_id from public.orders where request_id = p_request_id;
  end;

  return v_order_id;
end;
$$;

-- La firma vieja de 4 argumentos se dropea: si quedaran las dos, PostgREST no
-- sabría cuál llamar (sobrecarga ambigua) y devolvería 300.
drop function if exists public.create_order(text, jsonb, numeric, text);
revoke execute on function public.create_order(text, jsonb, numeric, text, uuid) from public;
grant execute on function public.create_order(text, jsonb, numeric, text, uuid) to anon, authenticated;

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

  -- Solo se editan cotizaciones (2026-07-17, a pedido del usuario: un
  -- pedido real ya confirmado no se toca desde acá) y solo mientras
  -- siguen 'new' — una vez atendida o cancelada, tampoco se edita.
  if v_order.kind <> 'quote' then
    raise exception 'solo se pueden editar cotizaciones';
  end if;
  if v_order.status <> 'new' then
    raise exception 'solo se pueden editar cotizaciones nuevas';
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

-- ---------- helper: apply_order_stock ----------
-- Mueve el stock de los productos de un pedido (2026-08-04,
-- migration-2026-08-04-order-stock.sql): p_direction = -1 descuenta (pedido
-- marcado Atendido), +1 devuelve (reabierto o cancelado). Helper interno, sin
-- grant a anon/authenticated — lo llaman solo update_order_status y
-- convert_quote_to_order, ambas SECURITY DEFINER del mismo dueño (mismo
-- patrón que compute_order_items).
--
-- La disponibilidad NO se calcula acá: la deriva el trigger
-- products_availability_from_stock, así el resultado es idéntico venga el
-- cambio de stock de donde venga.
create or replace function public.apply_order_stock(
  p_order_id  uuid,
  p_direction int
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_items   jsonb;
  v_agg     jsonb;
  v_moved   jsonb;
  v_skipped jsonb;
begin
  if p_direction not in (-1, 1) then
    raise exception 'p_direction debe ser -1 (descontar) o 1 (devolver)';
  end if;

  select items into v_items from public.orders where id = p_order_id;
  if v_items is null or jsonb_typeof(v_items) <> 'array' then
    return jsonb_build_object('direction', p_direction, 'moved', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;

  -- Un pedido puede traer el mismo producto en dos líneas (la clave del
  -- carrito es id+flash: una línea de oferta y otra a precio de lista), así
  -- que se suman las cantidades por producto ANTES de tocar el stock — si no,
  -- el segundo update pisaría al primero. El filtro de formato descarta ítems
  -- malformados sin tumbar el cambio de estado del pedido.
  select coalesce(jsonb_object_agg(product_id::text, qty), '{}'::jsonb)
    into v_agg
  from (
    select (e ->> 'id')::uuid                      as product_id,
           sum(floor((e ->> 'qty')::numeric)::int) as qty
    from jsonb_array_elements(v_items) as e
    where e ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and e ->> 'qty' ~ '^[0-9]+(\.[0-9]+)?$'
    group by 1
  ) s
  where qty > 0;

  if v_agg = '{}'::jsonb then
    return jsonb_build_object('direction', p_direction, 'moved', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;

  -- Lo que NO se puede ajustar: producto borrado, o stock null (nunca
  -- sincronizado — no se puede restar de un dato que no existe). Se calcula
  -- antes del update, mientras stock sigue en null.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'product_id', a.key,
               'sku',        p.sku,
               'qty',        a.value::int,
               'reason',     case when p.id is null then 'producto inexistente' else 'stock sin dato' end
             )
             order by p.sku nulls last
           ),
           '[]'::jsonb
         )
    into v_skipped
  from jsonb_each_text(v_agg) as a
  left join public.products p on p.id = a.key::uuid
  where p.id is null or p.stock is null;

  with agg as (
    select a.key::uuid as product_id, a.value::int as qty
    from jsonb_each_text(v_agg) as a
  ),
  upd as (
    update public.products p
    set stock = p.stock + (p_direction * a.qty)
    from agg a
    where p.id = a.product_id
      and p.stock is not null
    returning p.id, p.sku, a.qty, p.stock as stock_after, p.availability
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'product_id',   id,
               'sku',          sku,
               'qty',          qty,
               'stock_before', stock_after - (p_direction * qty),
               'stock_after',  stock_after,
               'availability', availability
             )
             order by sku
           ),
           '[]'::jsonb
         )
    into v_moved
  from upd;

  return jsonb_build_object(
    'direction', p_direction,
    'moved',     v_moved,
    'skipped',   v_skipped
  );
end;
$$;

revoke execute on function public.apply_order_stock(uuid, int) from public;

-- ---------- RPC: update_order_status ----------
-- Antes "Marcar atendido"/"Cancelar"/"Reabrir" hacían un update directo
-- (`vendedora_update_own_orders` ya lo permitía) sin dejar rastro. A
-- pedido del usuario (2026-07-17), ahora queda auditado igual que la
-- edición de ítems.
--
-- 2026-08-04, a pedido del usuario: además mueve el stock. Solo pedidos
-- reales (kind = 'order') — una cotización nunca descuenta, primero hay que
-- pasarla a pedido con convert_quote_to_order. Marcar Atendido descuenta;
-- salir de Atendido (reabrir/cancelar) devuelve. La bandera
-- orders.stock_applied — no el estado — evita descontar dos veces.
create or replace function public.update_order_status(
  p_order_id uuid,
  p_status   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders%rowtype;
  v_client  public.clients%rowtype;
  v_email   text;
  v_stock   jsonb   := null;
  v_applied boolean;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  if p_status not in ('new', 'done', 'cancelled') then
    raise exception 'estado inválido';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'pedido no encontrado';
  end if;

  select * into v_client from public.clients where id = v_order.client_id;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso para modificar este pedido';
  end if;

  if v_order.status = p_status then
    return jsonb_build_object('ok', true, 'status', p_status,
                              'stock_applied', coalesce(v_order.stock_applied, false));
  end if;

  v_applied := coalesce(v_order.stock_applied, false);
  if v_order.kind = 'order' then
    if p_status = 'done' and not v_applied then
      v_stock   := public.apply_order_stock(p_order_id, -1);
      v_applied := true;
    elsif p_status <> 'done' and v_applied then
      v_stock   := public.apply_order_stock(p_order_id, 1);
      v_applied := false;
    end if;
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('update_order_status', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object('from_status', v_order.status, 'to_status', p_status)
       || case when v_stock is null then '{}'::jsonb else jsonb_build_object('stock', v_stock) end);

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set status = p_status, stock_applied = v_applied
  where id = p_order_id;

  return jsonb_build_object(
    'ok',            true,
    'status',        p_status,
    'stock_applied', v_applied,
    'stock',         v_stock
  );
end;
$$;

revoke execute on function public.update_order_status(uuid, text) from public;
grant execute on function public.update_order_status(uuid, text) to authenticated;

-- ---------- RPC: convert_quote_to_order ----------
-- A pedido del usuario (2026-07-17): una cotización se puede "convertir"
-- en pedido real. A diferencia de una cotización (que nunca congela
-- precio, ver get_quotes_live_pricing), un pedido SÍ lo congela — desde
-- acá en adelante ya no se sigue ajustando a cambios de precio futuros.
--
-- 2026-08-04: borde de stock. Una cotización nunca descuenta stock, así que
-- si la que se está convirtiendo YA estaba marcada Atendida, el descuento
-- tiene que pasar acá mismo (si no, ese pedido quedaría done sin haber
-- descontado nunca). El camino normal — cotización nueva → pedido nuevo →
-- Atendido — sigue descontando en update_order_status.
create or replace function public.convert_quote_to_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order     public.orders%rowtype;
  v_client    public.clients%rowtype;
  v_list_code text;
  v_result    jsonb;
  v_email     text;
  v_no_price  text;
  v_stock     jsonb   := null;
  v_applied   boolean;
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
    raise exception 'no tenés permiso para modificar este pedido';
  end if;

  if v_order.kind <> 'quote' then
    raise exception 'solo se pueden convertir cotizaciones';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'no se puede convertir una cotización cancelada';
  end if;

  select code into v_list_code from public.price_lists where id = v_client.price_list_id;
  if v_list_code = 'quote' then
    raise exception 'asigná una lista de precio real al cliente antes de convertir la cotización en pedido';
  end if;

  v_result := public.compute_order_items(v_client.id, v_order.items, 'order');

  -- Misma regla que create_order, por la puerta del admin (2026-08-06,
  -- migration-2026-08-06-require-price.sql): sin esto, convertir una cotización
  -- que tiene un producto sin precio en la lista del cliente creaba un pedido con
  -- esa línea en null y un total que no la incluía — un pedido mal facturado, sin
  -- ningún aviso. Acá no hace falta order_failures: es una acción del panel, así
  -- que el mensaje se muestra tal cual y dice qué SKU arreglar.
  select string_agg(e->>'sku', ', ' order by e->>'sku')
    into v_no_price
  from jsonb_array_elements(v_result->'items') e
  where e->>'price' is null;

  if v_no_price is not null then
    raise exception 'estos productos no tienen precio en la lista del cliente: %. Cargá el precio en la pestaña Precios (o quitalos de la cotización con Editar) y volvé a convertirla.', v_no_price;
  end if;

  -- Mismo guard que update_order_items, que sí lo tenía: si todos los ítems se
  -- cayeron (productos desactivados), convertir dejaría un pedido vacío.
  if jsonb_array_length(v_result->'items') = 0 then
    raise exception 'la cotización no tiene ningún producto válido';
  end if;

  -- La conversión recalcula precios, no productos ni cantidades, así que
  -- apply_order_stock puede leer los ítems ya guardados (el update de abajo
  -- deja los mismos id/qty) sin cambiar el resultado.
  v_applied := coalesce(v_order.stock_applied, false);
  if v_order.status = 'done' and not v_applied then
    v_stock   := public.apply_order_stock(p_order_id, -1);
    v_applied := true;
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('convert_quote_to_order', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object(
       'items', v_result->'items',
       'total', v_result->'total'
     )
       || case when v_stock is null then '{}'::jsonb else jsonb_build_object('stock', v_stock) end);

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set kind          = 'order',
      items         = v_result->'items',
      total         = (v_result->>'total')::numeric,
      stock_applied = v_applied
  where id = p_order_id;

  return v_result || jsonb_build_object('stock_applied', v_applied, 'stock', v_stock);
end;
$$;

revoke execute on function public.convert_quote_to_order(uuid) from public;
grant execute on function public.convert_quote_to_order(uuid) to authenticated;

-- ---------- RPC: recover_order_failure ----------
-- Rescata un pedido que el cliente envió y no entró (order_failures), sin
-- pedirle que lo rearme: toma los ítems guardados y los mete como pedido de
-- ese mismo cliente. Los precios se recalculan con la lista VIGENTE (via
-- compute_order_items), no con los que veía cuando lo armó.
--
-- Mismos permisos y auditoría que el resto de las acciones del panel: admin
-- cualquiera, vendedora solo los de sus clientes, y queda en admin_audit_log.
create or replace function public.recover_order_failure(p_failure_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fail    public.order_failures%rowtype;
  v_client  public.clients%rowtype;
  v_kind    text;
  v_result  jsonb;
  v_items   jsonb;
  v_order   uuid;
  v_email   text;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  select * into v_fail from public.order_failures where id = p_failure_id;
  if not found then
    raise exception 'registro no encontrado';
  end if;

  if v_fail.recovered_order_id is not null then
    raise exception 'este pedido ya fue recuperado';
  end if;

  if v_fail.client_id is null or v_fail.items is null then
    raise exception 'no hay suficiente información para recuperarlo (token inválido)';
  end if;

  select * into v_client from public.clients where id = v_fail.client_id;
  if not found then
    raise exception 'el cliente ya no existe';
  end if;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso para recuperar este pedido';
  end if;

  -- Tope más alto que el de create_order (un admin decidiendo a mano no es un
  -- payload sospechoso), pero no infinito: arriba de esto compute_order_items
  -- tarda más que el statement_timeout y la recuperación fallaría a mitad.
  if jsonb_array_length(v_fail.items) > 2000 then
    raise exception 'el pedido tiene % líneas: hay que partirlo en dos', jsonb_array_length(v_fail.items);
  end if;

  v_kind   := case when v_fail.kind = 'quote' then 'quote' else 'order' end;
  v_result := public.compute_order_items(v_client.id, v_fail.items, v_kind);
  v_items  := v_result->'items';

  if jsonb_array_length(v_items) = 0 then
    raise exception 'ninguno de los productos sigue activo';
  end if;

  insert into public.orders (client_id, items, total, kind)
  values (v_client.id, v_items, (v_result->>'total')::numeric, v_kind)
  returning id into v_order;

  update public.order_failures set recovered_order_id = v_order where id = p_failure_id;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('recover_order_failure', auth.uid(), v_email, v_client.id, v_client.name, v_order,
     jsonb_build_object(
       'failure_id', p_failure_id,
       'reason',     v_fail.reason,
       'kind',       v_kind,
       'items',      v_items,
       'total',      v_result->'total'
     ));

  return jsonb_build_object('ok', true, 'order_id', v_order, 'total', v_result->'total',
                            'lines', jsonb_array_length(v_items));
end;
$$;

revoke execute on function public.recover_order_failure(uuid) from public;
grant execute on function public.recover_order_failure(uuid) to authenticated;

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
-- RPC del panel Superadmin (2026-08-05,
-- migration-2026-08-05-superadmin.sql)
--
-- Todas exigen is_superadmin() adentro (no alcanza con ocultar la pestaña) y
-- todas dejan rastro en admin_audit_log vía sa_log(). Lo que NO está acá es el
-- cambio de contraseña y el alta del usuario de Auth: eso necesita la Admin
-- API de GoTrue y vive en la Edge Function supabase/functions/superadmin-users,
-- que se apoya en sa_register_new_admin/sa_log_password_change para no
-- duplicar ni el candado ni la auditoría.
-- ============================================================

-- Auditoría de las acciones de superadmin. `client_name` se usa como
-- "objetivo" (email del usuario o nombre de la lista): la columna ya es texto
-- libre y así el Registro de movimientos muestra algo útil ahí — de ahí que la
-- pestaña titule esa columna "Cliente / objetivo". Sin grant a authenticated:
-- solo la llaman las funciones de abajo.
create or replace function public.sa_log(p_action text, p_target text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_name, detail)
  values
    (p_action, auth.uid(), v_email, p_target, p_detail);
end;
$$;

revoke execute on function public.sa_log(text, text, jsonb) from public, anon, authenticated;

-- auth.users no es legible desde el cliente: esta RPC es la única forma que
-- tiene el panel de listar los accesos existentes con su rol.
create or replace function public.sa_list_users()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede ver los usuarios';
  end if;

  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'user_id',        u.id,
               'email',          u.email,
               'created_at',     u.created_at,
               'last_sign_in_at', u.last_sign_in_at,
               'is_superadmin',  s.user_id is not null,
               'is_admin',       a.user_id is not null,
               'vendedora_id',   v.id,
               'vendedora_name', v.name
             ) order by lower(u.email))
    from auth.users u
    left join public.admins      a on a.user_id = u.id
    left join public.superadmins s on s.user_id = u.id
    left join public.vendedores  v on v.user_id = u.id
    where u.deleted_at is null
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.sa_list_users() from public, anon;
grant execute on function public.sa_list_users() to authenticated;

create or replace function public.sa_set_admin(p_user_id uuid, p_is_admin boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede dar o quitar el rol admin';
  end if;

  select email into v_email from auth.users where id = p_user_id and deleted_at is null;
  if v_email is null then
    raise exception 'usuario no encontrado';
  end if;

  -- Un superadmin es admin por definición (ver is_admin()): quitarle la fila
  -- de `admins` no le sacaría nada y dejaría el panel mostrando un estado que
  -- no es el real.
  if not p_is_admin and exists (select 1 from public.superadmins where user_id = p_user_id) then
    raise exception 'ese usuario es superadmin: su acceso de admin no se puede quitar';
  end if;

  if p_is_admin then
    insert into public.admins (user_id) values (p_user_id) on conflict do nothing;
  else
    delete from public.admins where user_id = p_user_id;
  end if;

  perform public.sa_log(
    'set_admin', v_email,
    jsonb_build_object('target_user_id', p_user_id, 'target_email', v_email, 'granted', p_is_admin)
  );

  return jsonb_build_object('ok', true, 'email', v_email, 'is_admin', p_is_admin);
end;
$$;

revoke execute on function public.sa_set_admin(uuid, boolean) from public, anon;
grant execute on function public.sa_set_admin(uuid, boolean) to authenticated;

-- La llama la Edge Function superadmin-users (acción create_admin) con el JWT
-- del superadmin, justo después de crear el usuario de Auth.
create or replace function public.sa_register_new_admin(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede crear admins';
  end if;

  select email into v_email from auth.users where id = p_user_id and deleted_at is null;
  if v_email is null then
    raise exception 'usuario no encontrado';
  end if;

  insert into public.admins (user_id) values (p_user_id) on conflict do nothing;

  perform public.sa_log(
    'create_admin_user', v_email,
    jsonb_build_object('target_user_id', p_user_id, 'target_email', v_email)
  );

  return jsonb_build_object('ok', true, 'email', v_email);
end;
$$;

revoke execute on function public.sa_register_new_admin(uuid) from public, anon;
grant execute on function public.sa_register_new_admin(uuid) to authenticated;

-- La contraseña la cambia la Edge Function (GoTrue), no Postgres: esta RPC
-- solo deja el rastro. La contraseña nunca se manda ni se guarda acá.
create or replace function public.sa_log_password_change(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede cambiar contraseñas';
  end if;

  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then
    raise exception 'usuario no encontrado';
  end if;

  perform public.sa_log(
    'set_user_password', v_email,
    jsonb_build_object('target_user_id', p_user_id, 'target_email', v_email)
  );

  return jsonb_build_object('ok', true, 'email', v_email);
end;
$$;

revoke execute on function public.sa_log_password_change(uuid) from public, anon;
grant execute on function public.sa_log_password_change(uuid) to authenticated;

-- Listas que siembra este archivo y que el código da por existentes
-- (LIST_ALIASES/LIST_ORDER en PricesUpload.jsx, la detección de 'quote' y
-- 'special' en get_catalog/create_order, los alias de inversión en
-- ClientsAdmin.jsx): no se pueden borrar desde el panel.
create or replace function public.sa_protected_price_list_codes()
returns text[]
language sql
immutable
as $$
  select array['us_min', 'us_wholesale', 've_min', 've_wholesale', 'special', 'quote', 'luzmar'];
$$;

revoke execute on function public.sa_protected_price_list_codes() from public, anon, authenticated;

-- Todo lo que el panel necesita de cada lista de un saque. Los conteos se
-- hacen acá y no en el frontend porque product_prices pasa las 20,000 filas.
-- `misassigned` = clientes de la lista que quedaron con una vendedora que NO
-- es dueña (el caso que la migración de listas compartidas documentaba para
-- revisar a mano).
create or replace function public.sa_price_list_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede ver esta información';
  end if;

  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id',      pl.id,
               'code',    pl.code,
               'label',   pl.label,
               'protected', pl.code = any (public.sa_protected_price_list_codes()),
               'clients', (select count(*) from public.clients c where c.price_list_id = pl.id),
               'prices',  (select count(*) from public.product_prices pp where pp.price_list_id = pl.id),
               'owners',  (
                 select coalesce(jsonb_agg(
                          jsonb_build_object(
                            'vendedora_id', v.id,
                            'name',         v.name,
                            'is_primary',   o.is_primary
                          ) order by o.is_primary desc, v.name), '[]'::jsonb)
                 from public.price_list_owners o
                 join public.vendedores v on v.id = o.vendedora_id
                 where o.price_list_id = pl.id
               ),
               'misassigned', (
                 select count(*)
                 from public.clients c
                 where c.price_list_id = pl.id
                   and public.price_list_has_owners(pl.id)
                   and not public.is_price_list_owner(pl.id, c.vendedora_id)
               )
             ) order by pl.code)
    from public.price_lists pl
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.sa_price_list_overview() from public, anon;
grant execute on function public.sa_price_list_overview() to authenticated;

-- Dueñas de una lista: reemplaza los INSERT/DELETE a mano que documentaba el
-- final de migration-2026-08-04-shared-price-lists.sql.
create or replace function public.sa_add_price_list_owner(
  p_price_list_id uuid,
  p_vendedora_id  uuid,
  p_is_primary    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list      public.price_lists%rowtype;
  v_vendedora text;
  v_first     boolean;
  v_primary   boolean;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede asignar listas de precio';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  select name into v_vendedora from public.vendedores where id = p_vendedora_id;
  if v_vendedora is null then
    raise exception 'vendedora no encontrada';
  end if;

  -- La primera dueña es siempre la principal: una lista con dueñas y sin
  -- principal funcionaría (price_list_primary_owner tiene fallback por
  -- created_at) pero deja el estado ambiguo para quien mire la tabla.
  v_first   := not public.price_list_has_owners(p_price_list_id);
  v_primary := p_is_primary or v_first;

  -- El índice único parcial deja una sola principal por lista: hay que bajar
  -- la anterior antes de subir la nueva.
  if v_primary then
    update public.price_list_owners
      set is_primary = false
      where price_list_id = p_price_list_id and is_primary;
  end if;

  insert into public.price_list_owners (price_list_id, vendedora_id, is_primary)
  values (p_price_list_id, p_vendedora_id, v_primary)
  on conflict (price_list_id, vendedora_id) do update set is_primary = excluded.is_primary;

  perform public.sa_log(
    'add_price_list_owner', v_list.label,
    jsonb_build_object(
      'price_list_id', p_price_list_id,
      'price_list',    v_list.label,
      'code',          v_list.code,
      'vendedora_id',  p_vendedora_id,
      'vendedora',     v_vendedora,
      'is_primary',    v_primary
    )
  );

  -- Si la lista era general y ahora tiene dueña, sus clientes de otras
  -- vendedoras quedan inconsistentes. NO se mueven acá a propósito (una
  -- reasignación masiva silenciosa es justo lo que no se quiere): el panel
  -- avisa con este contador y ofrece el botón que llama a
  -- sa_sync_price_list_clients.
  return jsonb_build_object(
    'ok', true,
    'vendedora', v_vendedora,
    'is_primary', v_primary,
    'misassigned', (
      select count(*)
      from public.clients c
      where c.price_list_id = p_price_list_id
        and not public.is_price_list_owner(p_price_list_id, c.vendedora_id)
    )
  );
end;
$$;

revoke execute on function public.sa_add_price_list_owner(uuid, uuid, boolean) from public, anon;
grant execute on function public.sa_add_price_list_owner(uuid, uuid, boolean) to authenticated;

create or replace function public.sa_remove_price_list_owner(
  p_price_list_id uuid,
  p_vendedora_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list        public.price_lists%rowtype;
  v_vendedora   text;
  v_was_primary boolean;
  v_next        uuid;
  v_next_name   text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede desasignar listas de precio';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  select o.is_primary, v.name into v_was_primary, v_vendedora
  from public.price_list_owners o
  join public.vendedores v on v.id = o.vendedora_id
  where o.price_list_id = p_price_list_id and o.vendedora_id = p_vendedora_id;

  if v_vendedora is null then
    raise exception 'esa vendedora no es dueña de esta lista';
  end if;

  delete from public.price_list_owners
  where price_list_id = p_price_list_id and vendedora_id = p_vendedora_id;

  -- Si se fue la principal y quedan dueñas, la más antigua toma el lugar
  -- (misma regla de orden que price_list_primary_owner, pero explícita en la
  -- tabla para que el panel no muestre una lista sin principal).
  if v_was_primary then
    select vendedora_id into v_next
    from public.price_list_owners
    where price_list_id = p_price_list_id
    order by created_at, vendedora_id
    limit 1;

    if v_next is not null then
      update public.price_list_owners
        set is_primary = true
        where price_list_id = p_price_list_id and vendedora_id = v_next;
      select name into v_next_name from public.vendedores where id = v_next;
    end if;
  end if;

  perform public.sa_log(
    'remove_price_list_owner', v_list.label,
    jsonb_build_object(
      'price_list_id', p_price_list_id,
      'price_list',    v_list.label,
      'code',          v_list.code,
      'vendedora_id',  p_vendedora_id,
      'vendedora',     v_vendedora,
      'new_primary',   v_next_name
    )
  );

  -- Los clientes que tenía asignados NO se mueven solos: si la lista quedó con
  -- otras dueñas, el panel avisa cuántos quedaron colgados y ofrece pasarlos a
  -- la principal. Si quedó sin dueñas, vuelve a ser general y no hay nada que
  -- corregir.
  return jsonb_build_object(
    'ok', true,
    'vendedora', v_vendedora,
    'new_primary', v_next_name,
    'misassigned', (
      select count(*)
      from public.clients c
      where c.price_list_id = p_price_list_id
        and public.price_list_has_owners(p_price_list_id)
        and not public.is_price_list_owner(p_price_list_id, c.vendedora_id)
    )
  );
end;
$$;

revoke execute on function public.sa_remove_price_list_owner(uuid, uuid) from public, anon;
grant execute on function public.sa_remove_price_list_owner(uuid, uuid) to authenticated;

create or replace function public.sa_set_primary_price_list_owner(
  p_price_list_id uuid,
  p_vendedora_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list      public.price_lists%rowtype;
  v_vendedora text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede cambiar la dueña principal';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  select v.name into v_vendedora
  from public.price_list_owners o
  join public.vendedores v on v.id = o.vendedora_id
  where o.price_list_id = p_price_list_id and o.vendedora_id = p_vendedora_id;

  if v_vendedora is null then
    raise exception 'esa vendedora no es dueña de esta lista';
  end if;

  update public.price_list_owners
    set is_primary = false
    where price_list_id = p_price_list_id and is_primary;

  update public.price_list_owners
    set is_primary = true
    where price_list_id = p_price_list_id and vendedora_id = p_vendedora_id;

  perform public.sa_log(
    'set_primary_price_list_owner', v_list.label,
    jsonb_build_object(
      'price_list_id', p_price_list_id,
      'price_list',    v_list.label,
      'code',          v_list.code,
      'vendedora_id',  p_vendedora_id,
      'vendedora',     v_vendedora
    )
  );

  return jsonb_build_object('ok', true, 'vendedora', v_vendedora);
end;
$$;

revoke execute on function public.sa_set_primary_price_list_owner(uuid, uuid) from public, anon;
grant execute on function public.sa_set_primary_price_list_owner(uuid, uuid) to authenticated;

-- Pasa a la dueña principal los clientes de la lista que quedaron con una
-- vendedora que no es dueña. Es la versión auditada del UPDATE que la
-- migración de listas compartidas dejaba comentado para correr a mano. El
-- trigger clients_enforce_owner_vendedora hace lo mismo, pero solo cuando el
-- cliente se toca por otra razón: esto lo resuelve de una para toda la lista.
create or replace function public.sa_sync_price_list_clients(p_price_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list  public.price_lists%rowtype;
  v_moved int;
  v_owner text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede reasignar los clientes de una lista';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  if not public.price_list_has_owners(p_price_list_id) then
    raise exception 'esa lista no tiene dueñas: es una lista general y sus clientes pueden estar con cualquier vendedora';
  end if;

  update public.clients c
    set vendedora_id = public.price_list_primary_owner(p_price_list_id)
    where c.price_list_id = p_price_list_id
      and not public.is_price_list_owner(p_price_list_id, c.vendedora_id);

  get diagnostics v_moved = row_count;

  select name into v_owner
  from public.vendedores
  where id = public.price_list_primary_owner(p_price_list_id);

  perform public.sa_log(
    'sync_price_list_clients', v_list.label,
    jsonb_build_object(
      'price_list_id', p_price_list_id,
      'price_list',    v_list.label,
      'code',          v_list.code,
      'to_vendedora',  v_owner,
      'moved',         v_moved
    )
  );

  return jsonb_build_object('ok', true, 'moved', v_moved, 'to_vendedora', v_owner);
end;
$$;

revoke execute on function public.sa_sync_price_list_clients(uuid) from public, anon;
grant execute on function public.sa_sync_price_list_clients(uuid) to authenticated;

-- Crear una lista era hasta 2026-08-05 un INSERT a mano en el SQL Editor (así
-- nacieron 'quote' y 'luzmar'). El code se valida porque es la llave que usan
-- los alias de la carga de precios y la detección de quote/special.
create or replace function public.sa_create_price_list(p_code text, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code  text := lower(trim(coalesce(p_code, '')));
  v_label text := trim(coalesce(p_label, ''));
  v_id    uuid;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede crear listas de precio';
  end if;

  if v_code !~ '^[a-z][a-z0-9_]{1,30}$' then
    raise exception 'el código tiene que empezar con una letra y llevar solo minúsculas, números o _ (ej: mayoreo_ve)';
  end if;
  if v_label = '' then
    raise exception 'falta el nombre visible de la lista';
  end if;
  if exists (select 1 from public.price_lists where code = v_code) then
    raise exception 'ya existe una lista con el código %', v_code;
  end if;

  insert into public.price_lists (code, label) values (v_code, v_label) returning id into v_id;

  perform public.sa_log(
    'create_price_list', v_label,
    jsonb_build_object('price_list_id', v_id, 'code', v_code, 'label', v_label)
  );

  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'label', v_label);
end;
$$;

revoke execute on function public.sa_create_price_list(text, text) from public, anon;
grant execute on function public.sa_create_price_list(text, text) to authenticated;

-- Solo el nombre visible. El code no se toca nunca: hay código que lo lee
-- (get_catalog/create_order para 'quote', PricesUpload.jsx para los alias) y
-- renombrarlo rompería esos caminos en silencio.
create or replace function public.sa_update_price_list(p_price_list_id uuid, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list  public.price_lists%rowtype;
  v_label text := trim(coalesce(p_label, ''));
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede renombrar listas de precio';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;
  if v_label = '' then
    raise exception 'falta el nombre visible de la lista';
  end if;
  if v_label = v_list.label then
    return jsonb_build_object('ok', true, 'label', v_label);
  end if;

  update public.price_lists set label = v_label where id = p_price_list_id;

  -- 'update_price_list_label' y no 'update_price_list': esa acción ya existe en
  -- admin_audit_log con otro significado (update_client_price_list, cuando se
  -- le cambia la lista a un cliente).
  perform public.sa_log(
    'update_price_list_label', v_label,
    jsonb_build_object(
      'price_list_id', p_price_list_id,
      'code',          v_list.code,
      'from_label',    v_list.label,
      'to_label',      v_label
    )
  );

  return jsonb_build_object('ok', true, 'label', v_label);
end;
$$;

revoke execute on function public.sa_update_price_list(uuid, text) from public, anon;
grant execute on function public.sa_update_price_list(uuid, text) to authenticated;

-- Borrar es para deshacer un alta con el código mal escrito, nada más: solo
-- listas creadas desde el panel (no las que siembra este archivo) y solo si
-- están completamente vacías. Sin borrado en cascada a propósito — si hay algo
-- colgando, el mensaje dice qué y se decide a mano.
create or replace function public.sa_delete_price_list(p_price_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list    public.price_lists%rowtype;
  v_clients int;
  v_prices  int;
  v_owners  int;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede eliminar listas de precio';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  if v_list.code = any (public.sa_protected_price_list_codes()) then
    raise exception 'la lista % es una de las listas base del sistema y no se puede eliminar', v_list.code;
  end if;

  select count(*) into v_clients from public.clients where price_list_id = p_price_list_id;
  if v_clients > 0 then
    raise exception 'la lista tiene % cliente(s) asignado(s): pasalos a otra lista antes de eliminarla', v_clients;
  end if;

  select count(*) into v_prices from public.product_prices where price_list_id = p_price_list_id;
  if v_prices > 0 then
    raise exception 'la lista tiene % precio(s) cargado(s): vaciala antes de eliminarla', v_prices;
  end if;

  select count(*) into v_owners from public.price_list_owners where price_list_id = p_price_list_id;
  if v_owners > 0 then
    raise exception 'la lista tiene % dueña(s) asignada(s): quitalas antes de eliminarla', v_owners;
  end if;

  delete from public.price_lists where id = p_price_list_id;

  perform public.sa_log(
    'delete_price_list', v_list.label,
    jsonb_build_object('price_list_id', p_price_list_id, 'code', v_list.code, 'label', v_list.label)
  );

  return jsonb_build_object('ok', true, 'code', v_list.code);
end;
$$;

revoke execute on function public.sa_delete_price_list(uuid) from public, anon;
grant execute on function public.sa_delete_price_list(uuid) to authenticated;

-- ============================================================
-- RPC de la pestaña Métricas (2026-08-06,
-- migration-2026-08-06-sa-metrics.sql)
--
-- Los KPIs del sistema de un saque, para MetricsAdmin.jsx (que la llama cada
-- 60s por polling). Solo superadmin, igual que las de arriba, pero es la única
-- sa_* que NO llama a sa_log(): es de solo lectura, y auditar cada refresco
-- llenaría admin_audit_log con una fila por minuto por pestaña abierta.
--
-- Los agregados cruzan TODAS las vendedoras, así que no pueden calcularse en
-- el cliente: con RLS, una vendedora ve solo sus pedidos y el número saldría
-- distinto según quién mira.
-- ============================================================

-- La ventana temporal de la RPC (`created_at >= now() - N days`) sin este
-- índice es un seq scan de orders cada 60 segundos por pestaña abierta.
create index if not exists orders_created_idx on public.orders (created_at desc);

-- Las filas de 'update_order_status' son la mayoría de admin_audit_log y la
-- subconsulta del tiempo de atención las busca por action + order_id.
create index if not exists admin_audit_log_order_status_idx
  on public.admin_audit_log (order_id, created_at)
  where action = 'update_order_status';

-- Cuentas de prueba excluidas de TODOS los agregados de métricas (no se borra
-- ni se toca nada: solo quedan afuera del cálculo). EDITAR ACÁ para sumar o
-- sacar una cuenta: es el único lugar donde vive la lista. La RPC devuelve
-- además los nombres que matchearon (`excluidas`) y el panel los muestra al
-- pie de la tabla, así que si alguna vendedora real cae en un patrón por
-- casualidad se nota en vez de desaparecer del ranking en silencio.
create or replace function public.sa_metrics_test_vendedora_patterns()
returns text[]
language sql
immutable
as $$
  select array[
    'systemspruebas%',  -- la cuenta de pruebas de sistemas (y sus variantes numeradas)
    '%prueba%',         -- "Prueba", "Pruebas", "Cuenta de prueba"
    '%demo%'
  ];
$$;

revoke execute on function public.sa_metrics_test_vendedora_patterns() from public, anon, authenticated;

create or replace function public.sa_is_test_vendedora(p_name text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_name, '') ilike any (public.sa_metrics_test_vendedora_patterns());
$$;

revoke execute on function public.sa_is_test_vendedora(text) from public, anon, authenticated;

-- Un único jsonb con todo lo que dibuja la pestaña. Convenciones de los
-- filtros, iguales en todas las secciones:
--   * "pedido"     = kind = 'order' and status <> 'cancelled'
--   * "cotización" = kind = 'quote'
--   * "cancelado"  = kind = 'order' and status = 'cancelled'
-- Un pedido cancelado no suma monto ni cuenta como pedido: se reporta aparte
-- en `cancelados`.
create or replace function public.sa_metrics_overview(p_days int default 14)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_days   int;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
begin
  if not public.is_superadmin() then
    raise exception 'not authorized';
  end if;

  -- El panel manda 7/14/30; el clamp es para que un p_days a mano (0, -5,
  -- 99999) no devuelva una ventana absurda ni un generate_series gigante.
  v_days := greatest(1, least(coalesce(p_days, 14), 365));
  v_to   := now();
  v_from := v_to - (v_days || ' days')::interval;

  with
  test_v as (
    select id, name
    from public.vendedores
    where public.sa_is_test_vendedora(name)
  ),
  -- Base común: los pedidos/cotizaciones del período con su vendedora, ya sin
  -- cuentas de prueba. LEFT JOIN en los dos saltos porque orders.client_id y
  -- clients.vendedora_id son nullable — un pedido sin vendedora es un pedido
  -- real y tiene que sumar en los totales (sale en la tabla con "—"), a
  -- diferencia de uno de prueba, que se descarta.
  base as (
    select o.id, o.kind, o.status, o.total, o.created_at, c.vendedora_id, v.name as vendedora
    from public.orders o
    left join public.clients    c on c.id = o.client_id
    left join public.vendedores v on v.id = c.vendedora_id
    where o.created_at >= v_from
      and (v.name is null or not public.sa_is_test_vendedora(v.name))
  ),
  totals as (
    select
      count(*) filter (where kind = 'order' and status <> 'cancelled')          as pedidos,
      count(*) filter (where kind = 'quote')                                    as cotizaciones,
      -- distinct sobre vendedora_id (no sobre el nombre): count(distinct)
      -- ignora los null, así que los pedidos sin vendedora no inflan el número.
      count(distinct vendedora_id) filter (where kind = 'order' and status <> 'cancelled')
                                                                                as vendedoras_activas,
      coalesce(sum(total) filter (where kind = 'order' and status <> 'cancelled'), 0)
                                                                                as monto_capturado,
      avg(total) filter (where kind = 'order' and status <> 'cancelled')         as ticket_promedio,
      count(*) filter (where kind = 'order' and status = 'cancelled')            as cancelados
    from base
  ),
  -- Agrupa por NOMBRE y no por id: vendedores tiene un índice único sobre
  -- lower(name), así que no hay dos vendedoras con el mismo nombre, y así el
  -- grupo de "sin vendedora" (null) sale solo, sin un coalesce que se pueda
  -- confundir con una vendedora que se llame "—".
  por_vendedora as (
    select
      vendedora,
      count(*) filter (where kind = 'order' and status <> 'cancelled')          as pedidos,
      coalesce(sum(total) filter (where kind = 'order' and status <> 'cancelled'), 0)
                                                                                as monto,
      avg(total) filter (where kind = 'order' and status <> 'cancelled')         as ticket,
      count(*) filter (where kind = 'quote')                                     as cotizaciones
    from base
    group by vendedora
  ),
  -- PRIMERA vez que cada pedido llegó a 'done'. min(created_at) y no el
  -- último: un pedido puede ir done → new → done varias veces (se reabre para
  -- corregirlo) y lo que se mide es cuánto tardó en atenderse la primera vez.
  -- Sin filtro de fecha acá a propósito: el período se aplica sobre
  -- orders.created_at, y el "done" de un pedido del borde de la ventana puede
  -- ser posterior.
  first_done as (
    select a.order_id, min(a.created_at) as done_at
    from public.admin_audit_log a
    where a.action = 'update_order_status'
      and a.detail->>'to_status' = 'done'
      and a.order_id is not null
    group by a.order_id
  ),
  -- Solo kind='order': una cotización no se "atiende", se convierte. Sin
  -- filtro de status — un pedido que se atendió y después se canceló igual
  -- tardó lo que tardó. Da null si ningún pedido del período llegó a 'done'
  -- todavía: el panel muestra "—".
  attend as (
    select avg((extract(epoch from (fd.done_at - b.created_at)) / 3600.0)::numeric) as horas
    from base b
    join first_done fd on fd.order_id = b.id
    where b.kind = 'order'
  ),
  -- Cotizaciones que se pasaron a pedido en el período. Se cuenta sobre
  -- admin_audit_log y no sobre orders porque después de convertirla la fila de
  -- orders ya dice kind='order' y no queda rastro de que fue cotización.
  convertidas as (
    select count(*) as n
    from public.admin_audit_log a
    left join public.clients    c on c.id = a.client_id
    left join public.vendedores v on v.id = c.vendedora_id
    where a.action = 'convert_quote_to_order'
      and a.created_at >= v_from
      and (v.name is null or not public.sa_is_test_vendedora(v.name))
  ),
  -- Pedidos que el cliente mandó y NO entraron, y cuántos se rescataron con
  -- recover_order_failure. client_id es null cuando el token no era válido:
  -- esos igual cuentan (son fallos reales), no hay vendedora que excluir.
  fallos as (
    select
      count(*)                                                 as total,
      count(*) filter (where f.recovered_order_id is not null)  as recuperados
    from public.order_failures f
    left join public.clients    c on c.id = f.client_id
    left join public.vendedores v on v.id = c.vendedora_id
    where f.created_at >= v_from
      and (v.name is null or not public.sa_is_test_vendedora(v.name))
  ),
  -- Un bucket por día para que el mini-gráfico no tenga huecos: los días sin
  -- ventas vienen en 0 y el front dibuja la barra vacía en vez de saltear la
  -- fecha. Son v_days + 1 buckets: la ventana arranca a la hora actual de hace
  -- N días, así que el primer día del gráfico es parcial (a propósito — el
  -- total del período es exactamente la suma de la serie).
  dias as (
    select d as day_start
    from generate_series(date_trunc('day', v_from), date_trunc('day', v_to), interval '1 day') d
  ),
  serie as (
    select
      d.day_start::date         as dia,
      coalesce(sum(b.total), 0) as monto,
      count(b.id)               as pedidos
    from dias d
    left join base b
           on b.created_at >= d.day_start
          and b.created_at <  d.day_start + interval '1 day'
          and b.kind = 'order'
          and b.status <> 'cancelled'
    group by d.day_start
  )
  select jsonb_build_object(
    'period', jsonb_build_object('days', v_days, 'from', v_from, 'to', v_to),
    'totals', (
      select jsonb_build_object(
        'pedidos',            pedidos,
        'cotizaciones',       cotizaciones,
        'vendedoras_activas', vendedoras_activas,
        'monto_capturado',    round(monto_capturado, 2),
        'ticket_promedio',    round(ticket_promedio, 2),
        'cancelados',         cancelados
      )
      from totals
    ),
    'por_vendedora', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'vendedora',    vendedora,
                 'pedidos',      pedidos,
                 'monto',        round(monto, 2),
                 'ticket',       round(ticket, 2),
                 'cotizaciones', cotizaciones
               )
               -- El desempate por nombre hace el orden estable entre refrescos:
               -- sin él, dos vendedoras en 0 podían intercambiar de lugar cada
               -- 60 segundos y la tabla "parpadeaba".
               order by monto desc, coalesce(vendedora, '') )
      from por_vendedora
    ), '[]'::jsonb),
    'tiempo_a_atender_horas',   (select round(horas, 2) from attend),
    'cotizaciones_convertidas', (select n from convertidas),
    'fallos', (
      select jsonb_build_object('total', total, 'recuperados', recuperados) from fallos
    ),
    'serie_diaria', coalesce((
      select jsonb_agg(
               jsonb_build_object('dia', dia, 'monto', round(monto, 2), 'pedidos', pedidos)
               order by dia)
      from serie
    ), '[]'::jsonb),
    'excluidas', coalesce((select jsonb_agg(name order by name) from test_v), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke execute on function public.sa_metrics_overview(int) from public, anon;
grant execute on function public.sa_metrics_overview(int) to authenticated;

-- ============================================================
-- Primer usuario admin:
-- 1. Crear el usuario en Authentication -> Users (email + password).
-- 2. Ejecutar (reemplazando el email):
--
--    insert into public.admins (user_id)
--    select id from auth.users where email = 'admin@zimaxx.com'
--    on conflict do nothing;
--
-- Desde 2026-08-05 el superadmin (support5@firstchoiceonline.com, sembrado
-- más arriba en este archivo) puede hacer esto mismo desde la pestaña
-- 🔐 Superadmin del panel, sin SQL: "+ Crear admin" (usuario nuevo, vía la
-- Edge Function superadmin-users) o "Hacer admin" sobre un usuario que ya
-- existe. Este bloque queda para el arranque desde cero y para el caso de que
-- se pierda el acceso del superadmin.
--
-- Sumar o quitar un superadmin sigue siendo solo por SQL, a propósito:
--
--    insert into public.superadmins (user_id)
--    select id from auth.users where lower(email) = lower('OTRO@EMAIL.COM')
--    on conflict do nothing;
-- ============================================================
