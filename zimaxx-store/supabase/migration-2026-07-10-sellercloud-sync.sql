-- Sincronización SellerCloud → Supabase vía n8n (2026-07-10).
-- Infraestructura para que un job automático (n8n con la service_role
-- key) mantenga productos, precios y clientes al día sin pasar por el
-- panel admin: una tabla de auditoría de corridas (`sync_runs`) y tres
-- funciones de upsert que replican el criterio de las cargas por Excel
-- ya existentes (match por sku / (product_id, price_list_id) / teléfono;
-- NUNCA borran filas ausentes del payload — un export viejo o parcial no
-- puede matar productos, precios ni tokens en uso).
--
-- Mismo criterio que las migraciones anteriores: delta chico e
-- idempotente para el SQL Editor de Supabase, SIN re-correr el
-- schema.sql completo (el script completo tomó locks sobre varias tablas
-- a la vez y ya causó un deadlock en producción una vez).
--
-- lock_timeout: el CREATE TABLE de abajo es inofensivo, pero si algún
-- día este archivo suma un ALTER TABLE, que falle rápido y limpio en vez
-- de quedarse esperando un lock — en ese caso solo hay que re-correrlo.
set lock_timeout = '5s';

-- ---------- Auditoría de corridas ----------
-- n8n inserta una fila al arrancar (status 'running'), llama a las tres
-- funciones de abajo, y cierra la fila con finished_at + status 'ok' (y
-- los contadores que devuelve cada función) o 'error' + error_detail.
-- La service_role key salta RLS, así que n8n escribe la tabla directo,
-- sin función aparte.
create table if not exists public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running', 'ok', 'error')),
  rows_products int,
  rows_prices   int,
  rows_clients  int,
  error_detail  text
);

-- RLS activo como en todas las tablas: anon/authenticated sin policy no
-- ven nada; solo se agrega lectura para admins (para revisar el historial
-- de corridas desde el SQL Editor o un futuro panel). service_role no
-- necesita policy (bypassea RLS).
alter table public.sync_runs enable row level security;

drop policy if exists admin_read_sync_runs on public.sync_runs;
create policy admin_read_sync_runs on public.sync_runs
  for select to authenticated
  using (public.is_admin());

-- ---------- Token server-side para clientes nuevos ----------
-- Equivalente SQL de generateToken() en src/utils/token.js: 10 caracteres
-- del mismo alfabeto sin ambiguos (sin 0/O ni 1/l), con entropía de
-- gen_random_uuid() (RNG fuerte de Postgres) en vez de random(), que no
-- es criptográfico — el token es lo único que protege el catálogo del
-- cliente. Solo la usan las funciones de sync; no es ejecutable por el
-- público.
create or replace function public.sync_generate_token()
returns text
language sql
volatile
as $$
  select string_agg(
    substr(
      'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789',
      1 + (get_byte(b.bytes, i) % 54),
      1
    ),
    '' order by i
  )
  from (select uuid_send(gen_random_uuid()) as bytes) b,
       generate_series(0, 9) as i
$$;

revoke execute on function public.sync_generate_token() from public;
grant execute on function public.sync_generate_token() to service_role;

-- ---------- Upsert de productos ----------
-- p_products: array jsonb de objetos
--   { sku, name, category, product_line, availability, image_url }
-- Match por sku (insert ... on conflict (sku) do update). Nunca borra ni
-- desactiva: `active` no se toca en ningún caso (apagar un producto sigue
-- siendo decisión del admin, no del export).
-- En el UPDATE, los campos opcionales (category, product_line, image_url,
-- availability) solo pisan el valor existente si vienen con dato — un
-- export sin fotos no borra las URLs que el admin cargó a mano (mismo
-- criterio que la carga de clientes por Excel con la columna vendedora).
-- Productos NUEVOS entran con new_until = now() + 10 días (misma etiqueta
-- ✨ Nuevo que el alta manual / carga masiva, NEW_TAG_DAYS en
-- ProductsAdmin.jsx); en updates new_until no se toca (re-sincronizar no
-- re-etiqueta como nuevo un producto viejo).
-- availability se normaliza a 'available' | 'preorder' | 'flash'; un
-- valor desconocido se ignora (conserva el existente; 'available' si el
-- producto es nuevo).
-- Devuelve jsonb: { inserted, updated, skipped } — la suma va en
-- sync_runs.rows_products.
create or replace function public.sync_upsert_products(p_products jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r           record;
  v_avail     text;
  v_is_insert boolean;
  v_inserted  int := 0;
  v_updated   int := 0;
  v_skipped   int := 0;
begin
  if p_products is null or jsonb_typeof(p_products) <> 'array' then
    raise exception 'p_products debe ser un array jsonb';
  end if;

  for r in
    select
      nullif(trim(x ->> 'sku'), '')          as sku,
      nullif(trim(x ->> 'name'), '')         as name,
      nullif(trim(x ->> 'category'), '')     as category,
      nullif(trim(x ->> 'product_line'), '') as product_line,
      nullif(trim(x ->> 'availability'), '') as availability,
      nullif(trim(x ->> 'image_url'), '')    as image_url
    from jsonb_array_elements(p_products) as x
  loop
    if r.sku is null or r.name is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_avail := case
      when lower(r.availability) in ('available', 'preorder', 'flash') then lower(r.availability)
      else null
    end;

    insert into public.products as p
      (sku, name, category, product_line, availability, image_url, new_until)
    values
      (r.sku, r.name, r.category, r.product_line,
       coalesce(v_avail, 'available'), r.image_url,
       now() + interval '10 days')
    on conflict (sku) do update set
      name         = r.name,
      category     = coalesce(r.category, p.category),
      product_line = coalesce(r.product_line, p.product_line),
      availability = coalesce(v_avail, p.availability),
      image_url    = coalesce(r.image_url, p.image_url)
    returning (xmax = 0) into v_is_insert;

    if v_is_insert then
      v_inserted := v_inserted + 1;
    else
      v_updated := v_updated + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated',  v_updated,
    'skipped',  v_skipped
  );
end;
$$;

revoke execute on function public.sync_upsert_products(jsonb) from public;
grant execute on function public.sync_upsert_products(jsonb) to service_role;

-- ---------- Upsert de precios de una lista ----------
-- p_price_list_code: code de price_lists ('us_min', 'us_wholesale',
-- 've_min', 've_wholesale', 'special', 'luzmar'...). 'quote' se rechaza:
-- esa lista no lleva precios (get_catalog los ignora y PricesUpload.jsx
-- también la excluye).
-- p_rows: array jsonb de { sku, price }.
-- Upsert por (product_id, price_list_id) resolviendo el producto por sku;
-- SKUs desconocidos y precios inválidos/negativos se cuentan como
-- omitidos sin tumbar la corrida (mismo criterio que la carga de Excel de
-- precios). Nunca borra precios ausentes del payload.
-- Devuelve jsonb: { upserted, skipped, skipped_skus (primeros 50) } — el
-- total de upserted va en sync_runs.rows_prices.
create or replace function public.sync_upsert_prices(p_price_list_code text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list_id      uuid;
  r              record;
  v_product_id   uuid;
  v_price        numeric(10, 2);
  v_upserted     int := 0;
  v_skipped      int := 0;
  v_skipped_skus text[] := '{}';
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows debe ser un array jsonb';
  end if;

  if p_price_list_code = 'quote' then
    raise exception 'la lista quote no lleva precios';
  end if;

  select id into v_list_id from public.price_lists where code = p_price_list_code;
  if v_list_id is null then
    raise exception 'lista de precio desconocida: %', p_price_list_code;
  end if;

  for r in
    select
      nullif(trim(x ->> 'sku'), '')   as sku,
      nullif(trim(x ->> 'price'), '') as price_raw
    from jsonb_array_elements(p_rows) as x
  loop
    begin
      v_price := r.price_raw::numeric(10, 2);
    exception when others then
      v_price := null;
    end;

    if r.sku is null or v_price is null or v_price < 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    select id into v_product_id from public.products where sku = r.sku;
    if v_product_id is null then
      v_skipped := v_skipped + 1;
      if array_length(v_skipped_skus, 1) is null or array_length(v_skipped_skus, 1) < 50 then
        v_skipped_skus := v_skipped_skus || r.sku;
      end if;
      continue;
    end if;

    insert into public.product_prices (product_id, price_list_id, price)
    values (v_product_id, v_list_id, v_price)
    on conflict (product_id, price_list_id) do update set
      price = excluded.price;

    v_upserted := v_upserted + 1;
  end loop;

  return jsonb_build_object(
    'upserted',     v_upserted,
    'skipped',      v_skipped,
    'skipped_skus', to_jsonb(v_skipped_skus)
  );
end;
$$;

revoke execute on function public.sync_upsert_prices(text, jsonb) from public;
grant execute on function public.sync_upsert_prices(text, jsonb) to service_role;

-- ---------- Upsert de clientes ----------
-- p_rows: array jsonb de { name, phone, price_list_code, vendedora }
--   (vendedora opcional: nombre, se resuelve/crea en `vendedores` igual
--   que la carga por Excel; no acepta teléfono de vendedora — esa
--   columna tiene validación de código de país en el admin y se completa
--   a mano en la pestaña Vendedoras).
-- Mismo criterio que ClientsAdmin.jsx: match por teléfono (solo dígitos,
-- como cleanPhone()), crea nuevos con token automático, actualiza
-- existentes, NUNCA borra clientes ausentes del payload. Si la fila no
-- trae vendedora, no toca la asignación existente del cliente.
-- Listas "personales" (price_lists.owner_vendedora_id, ej. 'luzmar'): la
-- función no hace nada especial a propósito — el trigger ya existente
-- clients_enforce_owner_vendedora corre en estos insert/update igual que
-- en cualquier otro y pisa vendedora_id con la dueña de la lista, sin
-- importar qué vendedora traiga el payload.
-- Devuelve jsonb: { created, updated, skipped } — la suma de
-- created+updated va en sync_runs.rows_clients.
create or replace function public.sync_upsert_clients(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r              record;
  v_phone        text;
  v_list_id      uuid;
  v_vendedora_id uuid;
  v_client_id    uuid;
  v_created      int := 0;
  v_updated      int := 0;
  v_skipped      int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows debe ser un array jsonb';
  end if;

  for r in
    select
      nullif(trim(x ->> 'name'), '')            as name,
      nullif(trim(x ->> 'phone'), '')           as phone,
      nullif(trim(x ->> 'price_list_code'), '') as price_list_code,
      nullif(trim(x ->> 'vendedora'), '')       as vendedora
    from jsonb_array_elements(p_rows) as x
  loop
    -- cleanPhone() de format.js: solo dígitos.
    v_phone := regexp_replace(coalesce(r.phone, ''), '\D', '', 'g');

    select id into v_list_id from public.price_lists where code = r.price_list_code;

    -- Mismos mínimos que la carga por Excel: nombre, teléfono de 7+
    -- dígitos y lista conocida; lo demás se omite sin tumbar la corrida.
    if r.name is null or length(v_phone) < 7 or v_list_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Vendedora por nombre (sin distinguir mayúsculas, mismo índice único
    -- lower(name) de la tabla); se crea sobre la marcha si falta, sin
    -- teléfono (se completa a mano en la pestaña Vendedoras).
    v_vendedora_id := null;
    if r.vendedora is not null then
      select id into v_vendedora_id
      from public.vendedores where lower(name) = lower(r.vendedora);
      if v_vendedora_id is null then
        insert into public.vendedores (name) values (r.vendedora)
        returning id into v_vendedora_id;
      end if;
    end if;

    -- Match por teléfono limpio contra el teléfono limpio guardado (la
    -- app ya guarda solo dígitos, el regexp del lado de la tabla es solo
    -- por si quedó alguna fila vieja con formato).
    select id into v_client_id
    from public.clients
    where regexp_replace(phone, '\D', '', 'g') = v_phone;

    if v_client_id is null then
      insert into public.clients (name, phone, token, price_list_id, vendedora_id)
      values (r.name, v_phone, public.sync_generate_token(), v_list_id, v_vendedora_id);
      v_created := v_created + 1;
    else
      update public.clients set
        name          = r.name,
        price_list_id = v_list_id,
        vendedora_id  = coalesce(v_vendedora_id, vendedora_id)
      where id = v_client_id;
      v_updated := v_updated + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'created', v_created,
    'updated', v_updated,
    'skipped', v_skipped
  );
end;
$$;

revoke execute on function public.sync_upsert_clients(jsonb) from public;
grant execute on function public.sync_upsert_clients(jsonb) to service_role;

-- ---------- Pruebas manuales (correr en el SQL Editor ANTES de conectar n8n) ----------
-- El SQL Editor de Supabase corre como postgres (superusuario), así que
-- puede llamar estas funciones directo aunque el grant sea solo para
-- service_role. Verificar después de cada una con los selects de abajo, y
-- limpiar las filas de prueba a mano si hace falta.
--
-- 1) Productos — debe devolver {"inserted": 1, "updated": 0, "skipped": 1}
--    la primera vez (la segunda fila no trae sku) y {"updated": 1} si se
--    re-corre:
-- select public.sync_upsert_products('[
--   {"sku": "SYNC-TEST-1", "name": "Producto de prueba sync", "category": "Marca Prueba",
--    "product_line": "Perfume", "availability": "available", "image_url": null},
--   {"name": "Fila sin sku, debe omitirse"}
-- ]'::jsonb);
-- select sku, name, availability, new_until from public.products where sku = 'SYNC-TEST-1';
--
-- 2) Precios — debe devolver {"upserted": 1, ...} y el precio quedar en
--    la lista us_wholesale (re-correr con otro precio debe pisarlo):
-- select public.sync_upsert_prices('us_wholesale', '[
--   {"sku": "SYNC-TEST-1", "price": "19.99"},
--   {"sku": "SKU-QUE-NO-EXISTE", "price": "5"}
-- ]'::jsonb);
-- select p.sku, pl.code, pp.price
-- from public.product_prices pp
-- join public.products p on p.id = pp.product_id
-- join public.price_lists pl on pl.id = pp.price_list_id
-- where p.sku = 'SYNC-TEST-1';
--
-- 3) Clientes — debe devolver {"created": 1, ...} la primera vez y
--    {"updated": 1} si se re-corre; el cliente queda con token generado:
-- select public.sync_upsert_clients('[
--   {"name": "Cliente Prueba Sync", "phone": "1 (305) 555-0199",
--    "price_list_code": "us_wholesale", "vendedora": null}
-- ]'::jsonb);
-- select name, phone, token, price_list_id, vendedora_id
-- from public.clients where phone = '13055550199';
--
-- 4) Lista personal — un cliente con lista 'luzmar' debe quedar asignado
--    a Luzmar aunque el payload diga otra vendedora (lo pisa el trigger
--    clients_enforce_owner_vendedora):
-- select public.sync_upsert_clients('[
--   {"name": "Cliente Prueba Luzmar", "phone": "13055550198",
--    "price_list_code": "luzmar", "vendedora": "Otra Vendedora"}
-- ]'::jsonb);
-- select c.name, v.name as vendedora
-- from public.clients c left join public.vendedores v on v.id = c.vendedora_id
-- where c.phone = '13055550198';
--
-- 5) Auditoría — ciclo completo como lo haría n8n:
-- insert into public.sync_runs default values returning id;  -- guardar el id
-- update public.sync_runs
-- set finished_at = now(), status = 'ok',
--     rows_products = 1, rows_prices = 1, rows_clients = 2
-- where id = 'EL_ID_DE_ARRIBA';
-- select * from public.sync_runs order by started_at desc limit 5;
--
-- Limpieza de las filas de prueba:
-- delete from public.clients where phone in ('13055550199', '13055550198');
-- delete from public.products where sku = 'SYNC-TEST-1';  -- borra su precio en cascada
