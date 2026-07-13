-- Sync SellerCloud → Supabase, v2 (2026-07-10, mismo día que la v1).
-- Ajusta el upsert de CLIENTES para usar el General.ID de SellerCloud
-- como llave real del sync automático, en vez del teléfono:
--
--   * Columna nueva `clients.sellercloud_id` (integer, unique, nullable).
--   * `sync_upsert_clients(p_rows)` reescrita: filas
--     {sellercloud_id, name, phone, salesman_name}, upsert por
--     sellercloud_id — NUNCA por teléfono en este flujo (el teléfono
--     sigue siendo el criterio de la carga manual por Excel en
--     ClientsAdmin.jsx, que no se toca y sigue funcionando igual).
--   * La vendedora se resuelve matcheando Internal.SalesMan contra
--     vendedores.name normalizando ambos lados (minúsculas + sin
--     acentos); sin match → vendedora_id null y contador
--     unmatched_salesman en el retorno (para loguear en
--     sync_runs.error_detail). A diferencia del Excel, acá NO se crean
--     vendedoras sobre la marcha: un typo de SellerCloud no debe generar
--     una vendedora fantasma.
--   * price_list_id NO se toca nunca (ni insert ni update): los precios
--     y la asignación de lista siguen siendo 100% manuales. Los clientes
--     nuevos del sync quedan con lista null (pendiente de asignación en
--     la pestaña Clientes) — por eso esta migración también suelta el
--     NOT NULL de esa columna. Un cliente sin lista ve el catálogo vacío
--     (get_catalog no encuentra precios) y create_order le devuelve null,
--     así que no puede pedir hasta que le asignen lista: comportamiento
--     intencional.
--
-- `sync_upsert_products` y `sync_upsert_prices` quedan SIN cambios (la
-- de precios queda sin uso por ahora — los precios siguen por Excel —
-- pero no se borra).
--
-- Idempotente; correr DESPUÉS de migration-2026-07-10-sellercloud-sync.sql
-- (ya corrida en producción — esta reemplaza solo sync_upsert_clients).
set lock_timeout = '5s';

-- ---------- Columna sellercloud_id ----------
-- El General.ID que devuelve SellerCloud por cliente. Nullable: los
-- clientes cargados a mano o por Excel no lo tienen (y no lo necesitan).
alter table public.clients
  add column if not exists sellercloud_id integer;

-- Único (los null no chocan entre sí); es el índice que usa el
-- ON CONFLICT del upsert de abajo.
create unique index if not exists clients_sellercloud_id_key
  on public.clients (sellercloud_id);

-- Los clientes nuevos del sync entran sin lista de precio (asignación
-- manual pendiente). DROP NOT NULL es no-op si ya se corrió antes.
alter table public.clients
  alter column price_list_id drop not null;

-- ---------- Normalizador de nombres ----------
-- Para matchear Internal.SalesMan de SellerCloud contra vendedores.name
-- tolerando mayúsculas y tildes ("María Pérez" == "maria perez"). Usa
-- unaccent() si la extensión está habilitada (Supabase la instala en el
-- schema `extensions`; también se contempla `public` por si se creó a
-- mano ahí); si no, un translate() manual con los acentos del español.
-- plpgsql resuelve cada rama recién al ejecutarla, así que la referencia
-- a unaccent no rompe la función cuando la extensión no existe.
create or replace function public.sync_normalize_name(p_name text)
returns text
language plpgsql
stable
as $$
begin
  if p_name is null then
    return null;
  end if;
  if to_regprocedure('extensions.unaccent(text)') is not null then
    return lower(trim(extensions.unaccent(p_name)));
  end if;
  if to_regprocedure('public.unaccent(text)') is not null then
    return lower(trim(public.unaccent(p_name)));
  end if;
  return translate(
    lower(trim(p_name)),
    'áàâäãéèêëíìîïóòôöõúùûüñç',
    'aaaaaeeeeiiiiooooouuuunc'
  );
end;
$$;

revoke execute on function public.sync_normalize_name(text) from public;
grant execute on function public.sync_normalize_name(text) to service_role;

-- ---------- Upsert de clientes, v2 ----------
-- p_rows: array jsonb de { sellercloud_id, name, phone, salesman_name }.
-- insert ... on conflict (sellercloud_id) do update. Nunca borra.
--
-- Caso especial, solo la PRIMERA vez que aparece cada cliente: si el
-- sellercloud_id todavía no existe en la tabla pero SÍ hay un cliente
-- con ese mismo teléfono y sellercloud_id null (cargado por Excel antes
-- de que existiera el sync), se ADOPTA esa fila (se le graba el
-- sellercloud_id) en vez de insertar un duplicado — sin esto, la primera
-- corrida chocaría contra el unique de clients.phone con cada cliente ya
-- cargado, y quedarían clientes duplicados imposibles de vincular. A
-- partir de ahí ese cliente se matchea siempre por sellercloud_id.
-- Se cuenta aparte (linked_by_phone) para que la primera corrida sea
-- auditable.
--
-- vendedora_id: si salesman_name matchea una vendedora (normalizado), se
-- asigna; si no matchea, en INSERT queda null y en UPDATE se conserva la
-- asignación que el cliente ya tenía (una reasignación manual del admin
-- no debe borrarse por un typo en SellerCloud) — en ambos casos suma a
-- unmatched_salesman. El trigger clients_enforce_owner_vendedora sigue
-- corriendo sin cambios en estos insert/update: si el cliente ya tiene
-- una lista con dueña (ej. 'luzmar'), el trigger pisa vendedora_id con
-- la dueña sin importar lo que diga SellerCloud, y eso está bien.
--
-- Si el teléfono entrante ya pertenece a OTRO cliente con OTRO
-- sellercloud_id (datos inconsistentes en SellerCloud), la fila se salta
-- y se cuenta en phone_conflicts en vez de tumbar la corrida.
--
-- Devuelve jsonb:
--   { created, updated, linked_by_phone, skipped, phone_conflicts,
--     unmatched_salesman, unmatched_names (primeros 20, distintos) }
-- — pensado para loguearlo entero en sync_runs.error_detail (o repartir
-- created+updated+linked_by_phone en rows_clients).
create or replace function public.sync_upsert_clients(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r                 record;
  v_scid            integer;
  v_phone           text;
  v_vendedora_id    uuid;
  v_client_id       uuid;
  v_is_insert       boolean;
  v_created         int := 0;
  v_updated         int := 0;
  v_linked          int := 0;
  v_skipped         int := 0;
  v_phone_conflicts int := 0;
  v_unmatched       int := 0;
  v_unmatched_names text[] := '{}';
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows debe ser un array jsonb';
  end if;

  for r in
    select
      nullif(trim(x ->> 'sellercloud_id'), '') as scid_raw,
      nullif(trim(x ->> 'name'), '')           as name,
      nullif(trim(x ->> 'phone'), '')          as phone,
      nullif(trim(x ->> 'salesman_name'), '')  as salesman
    from jsonb_array_elements(p_rows) as x
  loop
    begin
      v_scid := r.scid_raw::integer;
    exception when others then
      v_scid := null;
    end;

    -- cleanPhone() de format.js: solo dígitos.
    v_phone := regexp_replace(coalesce(r.phone, ''), '\D', '', 'g');

    -- Mínimos: sellercloud_id válido, nombre, y teléfono de 7+ dígitos
    -- (name/phone son NOT NULL en la tabla). Lo demás se omite sin
    -- tumbar la corrida.
    if v_scid is null or r.name is null or length(v_phone) < 7 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Vendedora por nombre normalizado. Sin match → null + contador;
    -- NUNCA se crea una vendedora nueva desde acá.
    v_vendedora_id := null;
    if r.salesman is not null then
      select id into v_vendedora_id
      from public.vendedores
      where public.sync_normalize_name(name) = public.sync_normalize_name(r.salesman);
      if v_vendedora_id is null then
        v_unmatched := v_unmatched + 1;
        if not (r.salesman = any (v_unmatched_names))
           and coalesce(array_length(v_unmatched_names, 1), 0) < 20 then
          v_unmatched_names := v_unmatched_names || r.salesman;
        end if;
      end if;
    end if;

    begin
      -- Adopción one-shot por teléfono (ver comentario de arriba): solo
      -- si este sellercloud_id no existe aún Y hay un cliente por Excel
      -- (sellercloud_id null) con el mismo teléfono.
      select id into v_client_id
      from public.clients where sellercloud_id = v_scid;

      if v_client_id is null then
        select id into v_client_id
        from public.clients
        where sellercloud_id is null
          and regexp_replace(phone, '\D', '', 'g') = v_phone;

        if v_client_id is not null then
          update public.clients set
            sellercloud_id = v_scid,
            name           = r.name,
            vendedora_id   = coalesce(v_vendedora_id, vendedora_id)
          where id = v_client_id;
          v_linked := v_linked + 1;
          continue;
        end if;
      end if;

      -- price_list_id: null en el insert, intacto en el update — la
      -- asignación de lista es siempre manual.
      insert into public.clients as c
        (sellercloud_id, name, phone, token, price_list_id, vendedora_id)
      values
        (v_scid, r.name, v_phone, public.sync_generate_token(), null, v_vendedora_id)
      on conflict (sellercloud_id) do update set
        name         = r.name,
        phone        = v_phone,
        vendedora_id = coalesce(v_vendedora_id, c.vendedora_id)
      returning (xmax = 0) into v_is_insert;

      if v_is_insert then
        v_created := v_created + 1;
      else
        v_updated := v_updated + 1;
      end if;
    exception when unique_violation then
      -- El teléfono ya es de otro cliente con otro sellercloud_id (o el
      -- update quiso pisarle el teléfono a otro): se salta la fila, no
      -- se tumba la corrida.
      v_phone_conflicts := v_phone_conflicts + 1;
    end;
  end loop;

  return jsonb_build_object(
    'created',            v_created,
    'updated',            v_updated,
    'linked_by_phone',    v_linked,
    'skipped',            v_skipped,
    'phone_conflicts',    v_phone_conflicts,
    'unmatched_salesman', v_unmatched,
    'unmatched_names',    to_jsonb(v_unmatched_names)
  );
end;
$$;

revoke execute on function public.sync_upsert_clients(jsonb) from public;
grant execute on function public.sync_upsert_clients(jsonb) to service_role;

-- ---------- Prueba manual (correr en el SQL Editor ANTES de conectar n8n) ----------
-- Tres filas: una con salesman que SÍ existe en vendedores (ajustar
-- 'Luzmar Quintero' si hace falta — con tildes/mayúsculas distintas
-- igual matchea), una con salesman inexistente (debe sumar a
-- unmatched_salesman y quedar sin vendedora) y una sin salesman.
-- Esperado la primera vez:
--   {"created": 3, "updated": 0, "linked_by_phone": 0, "skipped": 0,
--    "phone_conflicts": 0, "unmatched_salesman": 1,
--    "unmatched_names": ["Vendedora Que No Existe"]}
-- Re-corriendo lo mismo: {"updated": 3, ...} con el mismo unmatched.
--
-- select public.sync_upsert_clients('[
--   {"sellercloud_id": 990001, "name": "Cliente Sync V2 A",
--    "phone": "1 (305) 555-0197", "salesman_name": "LUZMAR QUINTERO"},
--   {"sellercloud_id": 990002, "name": "Cliente Sync V2 B",
--    "phone": "13055550196", "salesman_name": "Vendedora Que No Existe"},
--   {"sellercloud_id": 990003, "name": "Cliente Sync V2 C",
--    "phone": "13055550195", "salesman_name": null}
-- ]'::jsonb);
--
-- Verificar: A con vendedora Luzmar, B y C sin vendedora, los tres SIN
-- lista de precio (se asigna a mano en la pestaña Clientes):
-- select c.sellercloud_id, c.name, c.price_list_id, v.name as vendedora
-- from public.clients c
-- left join public.vendedores v on v.id = c.vendedora_id
-- where c.sellercloud_id in (990001, 990002, 990003)
-- order by c.sellercloud_id;
--
-- Limpieza de las filas de prueba:
-- delete from public.clients where sellercloud_id in (990001, 990002, 990003);
