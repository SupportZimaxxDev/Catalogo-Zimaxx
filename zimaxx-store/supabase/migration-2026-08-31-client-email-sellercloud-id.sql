-- Email del cliente visible/editable + vínculo SellerCloud asignable a mano
-- (2026-08-31, a pedido del usuario). Tres piezas:
--
--   (1) Columna `clients.email` (nullable). Hasta hoy el correo vivía SOLO en
--       SellerCloud (la Edge Function lo lee de allá al enviar la orden, y eso
--       no cambia — para el push el de allá sigue mandando). Esta copia es
--       para VERLO desde la lista de Clientes sin ir a SellerCloud. Se llena
--       por tres caminos: el sync de n8n (si empieza a mandar `email`, ver
--       (3)), la edición manual (2) y el alta manual del panel.
--
--   (2) `update_client_info` gana `p_email` (cuarto parámetro). El panel ya
--       editaba nombre y teléfono por acá (migration-2026-08-25); mismo
--       criterio de permisos (admin cualquiera, vendedora solo los suyos) y
--       misma auditoría, ahora con from_email/to_email en el detail. Email
--       vacío/null = borrar el correo (el form del panel siempre manda el
--       campo). Se DROPEA la firma vieja de 3 parámetros: dos overloads de la
--       misma RPC rompen PostgREST (PGRST203, "could not choose the best
--       candidate function").
--
--   (3) RPC nueva `set_client_sellercloud_id` (SOLO ADMIN): asignar, cambiar
--       o quitar el `clients.sellercloud_id` de un cliente desde el panel.
--       Hasta hoy ese vínculo solo lo escribía el sync de n8n (por match de
--       teléfono en la adopción one-shot del 2026-07-10/15), así que un
--       cliente cargado a mano cuyo teléfono no coincidiera con el de
--       SellerCloud quedaba sin vínculo para siempre — y sin vínculo, el
--       botón "Enviar a SellerCloud" rechaza sus pedidos ("este cliente
--       todavía no está sincronizado"). Admin-only a propósito (a diferencia
--       de update_client_info): un ID equivocado manda la orden AL CLIENTE
--       EQUIVOCADO en SellerCloud — es del nivel de reassign/delete, no de
--       corregir un teléfono. Auditada como 'set_client_sellercloud_id'.
--
--   (4) `sync_upsert_clients` se reescribe (mismo cuerpo que la versión viva,
--       migration-2026-07-15-fix-duplicate-client-phones.sql) aceptando un
--       `email` OPCIONAL por fila. Con email inválido o ausente la fila entra
--       igual y el email guardado NO se toca (coalesce) — así el flujo de n8n
--       actual, que no manda email, sigue corriendo sin cambios y sin borrar
--       lo cargado a mano. Para que el correo se llene solo, hay que agregar
--       `email` al payload del workflow de n8n (Email del cliente en
--       SellerCloud); si lo manda, pisa el guardado — para clientes del sync,
--       SellerCloud es la fuente de verdad, igual que con name/phone.
--
-- Requiere (preflight abajo, corta en limpio si falta algo):
--   * migration-2026-07-10-sellercloud-sync-v2.sql (clients.sellercloud_id).
--   * migration-2026-07-15-fix-duplicate-client-phones.sql
--     (allow_shared_phone; también es la versión viva del sync que acá se
--     reescribe).
--   * migration-2026-07-14-client-admin-actions.sql (admin_audit_log).
--   * Conviene correr ANTES migration-2026-08-25-update-client-info.sql para
--     mantener el orden histórico, pero no es obligatorio: esta migración
--     dropea esa firma si existe y crea la definitiva.
--
-- Idempotente: re-correrla dropea y recrea las mismas funciones y el
-- add column if not exists no hace nada la segunda vez.
set lock_timeout = '10s';

-- ---------- Preflight ----------
-- array_append y no `faltan || 'texto'`: con un literal de tipo unknown a la
-- derecha, Postgres resuelve el || como array||array e intenta parsear el
-- texto como array literal ("malformed array literal") — pescado probando la
-- migración contra una base a la que le faltaban las piezas.
do $$
declare
  faltan text[] := '{}';
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'sellercloud_id'
  ) then
    faltan := array_append(faltan, 'clients.sellercloud_id (migration-2026-07-10-sellercloud-sync-v2.sql)');
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'allow_shared_phone'
  ) then
    faltan := array_append(faltan, 'clients.allow_shared_phone (migration-2026-07-15-fix-duplicate-client-phones.sql)');
  end if;
  if to_regclass('public.admin_audit_log') is null then
    faltan := array_append(faltan, 'admin_audit_log (migration-2026-07-14-client-admin-actions.sql)');
  end if;
  if to_regprocedure('public.is_vendedora()') is null then
    faltan := array_append(faltan, 'is_vendedora()');
  end if;
  if array_length(faltan, 1) is not null then
    raise exception 'faltan piezas previas: %', array_to_string(faltan, ' · ');
  end if;
end $$;

-- ---------- (1) Columna email ----------
-- Nullable y sin unique: en SellerCloud varios clientes de un mismo negocio
-- pueden compartir correo, y acá no es llave de nada — el match del sync es
-- por sellercloud_id y el de Excel por teléfono, y eso no cambia.
alter table public.clients
  add column if not exists email text;

-- ---------- (2) update_client_info con email ----------
-- La firma vieja (3 parámetros, migration-2026-08-25) se dropea SIEMPRE:
-- si conviviera con la nueva, PostgREST no puede elegir entre las dos
-- (PGRST203) y el botón Editar moriría para todos los casos.
drop function if exists public.update_client_info(uuid, text, text);

create or replace function public.update_client_info(
  p_client_id uuid,
  p_name text,
  p_phone text,
  p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client    public.clients%rowtype;
  v_name      text := btrim(coalesce(p_name, ''));
  v_phone     text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  -- Email en minúsculas (es case-insensitive en la práctica y así los
  -- duplicados visuales no dependen de cómo se tipeó). Vacío → null.
  v_new_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_email     text;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'cliente no encontrado';
  end if;

  if not public.is_admin() then
    if not public.is_vendedora() or v_client.vendedora_id is distinct from public.current_vendedora_id() then
      raise exception 'no tenés permiso para editar este cliente';
    end if;
  end if;

  if v_name = '' then
    raise exception 'el nombre no puede quedar vacío';
  end if;
  if length(v_phone) < 7 then
    raise exception 'el teléfono tiene que tener al menos 7 dígitos';
  end if;
  -- Laxa a propósito (algo@algo.algo): atajar el typo obvio sin rechazar
  -- correos raros pero reales. La misma regla que el form del panel.
  if v_new_email is not null and v_new_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'el email no tiene un formato válido';
  end if;

  -- Sin cambios reales: no ensuciar la auditoría con una fila que no
  -- cambió nada (el guardado repetido del mismo valor es un no-op).
  if v_name = v_client.name and v_phone = v_client.phone
     and v_new_email is not distinct from v_client.email then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  -- Duplicado por últimos 10 dígitos. Un cliente marcado allow_shared_phone
  -- se salta el chequeo (compartir con su par es justamente lo legítimo);
  -- para todos los demás se compara contra TODOS los clientes, incluidos
  -- los marcados — a propósito MÁS estricto que el índice parcial (que
  -- ignora las filas marcadas en ambas puntas): un tercer cliente con el
  -- número del par rompería la deduplicación por teléfono del Excel, y es
  -- la misma regla que ya aplica el alta manual en el frontend.
  if not v_client.allow_shared_phone and exists (
    select 1 from public.clients c
    where c.id <> p_client_id
      and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(v_phone, 10)
  ) then
    raise exception 'ya existe otro cliente con ese teléfono';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  begin
    update public.clients
      set name = v_name, phone = v_phone, email = v_new_email
      where id = p_client_id;
  exception when unique_violation then
    raise exception 'ya existe otro cliente con ese teléfono';
  end;

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('update_client_info', auth.uid(), v_email, p_client_id, v_client.name,
     jsonb_build_object(
       'from_name',  v_client.name,
       'to_name',    v_name,
       'from_phone', v_client.phone,
       'to_phone',   v_phone,
       'from_email', v_client.email,
       'to_email',   v_new_email
     ));

  return jsonb_build_object('ok', true, 'changed', true);
end;
$$;

revoke execute on function public.update_client_info(uuid, text, text, text) from public;
grant execute on function public.update_client_info(uuid, text, text, text) to authenticated;

-- ---------- (3) set_client_sellercloud_id (solo admin) ----------
-- p_sellercloud_id null = quitar el vínculo (para deshacer un mal vínculo;
-- el próximo sync puede re-adoptar por teléfono si corresponde). El índice
-- único clients_sellercloud_id_key sigue siendo la garantía real contra dos
-- clientes con el mismo ID; acá se replica el chequeo solo para dar un
-- mensaje que diga QUIÉN lo tiene, y el handler de unique_violation atrapa
-- la carrera.
create or replace function public.set_client_sellercloud_id(
  p_client_id uuid,
  p_sellercloud_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients%rowtype;
  v_owner  text;
  v_email  text;
begin
  if not public.is_admin() then
    raise exception 'solo un admin puede cambiar el vínculo con SellerCloud';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'cliente no encontrado';
  end if;

  if p_sellercloud_id is not null and p_sellercloud_id <= 0 then
    raise exception 'el ID de SellerCloud tiene que ser un entero positivo';
  end if;

  if p_sellercloud_id is not distinct from v_client.sellercloud_id then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  if p_sellercloud_id is not null then
    select name into v_owner
    from public.clients
    where sellercloud_id = p_sellercloud_id and id <> p_client_id;
    if v_owner is not null then
      raise exception 'ese ID de SellerCloud ya pertenece a otro cliente: %', v_owner;
    end if;
  end if;

  select email into v_email from auth.users where id = auth.uid();

  begin
    update public.clients set sellercloud_id = p_sellercloud_id where id = p_client_id;
  exception when unique_violation then
    raise exception 'ese ID de SellerCloud ya pertenece a otro cliente';
  end;

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('set_client_sellercloud_id', auth.uid(), v_email, p_client_id, v_client.name,
     jsonb_build_object(
       'from_sellercloud_id', v_client.sellercloud_id,
       'to_sellercloud_id',   p_sellercloud_id
     ));

  return jsonb_build_object('ok', true, 'changed', true);
end;
$$;

revoke execute on function public.set_client_sellercloud_id(uuid, integer) from public;
grant execute on function public.set_client_sellercloud_id(uuid, integer) to authenticated;

-- ---------- (4) sync_upsert_clients con email opcional ----------
-- Mismo cuerpo que migration-2026-07-15-fix-duplicate-client-phones.sql;
-- único cambio real: cada fila puede traer `email`, y si lo trae (y parece
-- un email) se guarda — si no lo trae o viene inválido, el guardado queda
-- como está (coalesce), nunca se borra por un payload viejo de n8n.
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
  v_email           text;
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
      nullif(trim(x ->> 'salesman_name'), '')  as salesman,
      nullif(trim(x ->> 'email'), '')          as email
    from jsonb_array_elements(p_rows) as x
  loop
    begin
      v_scid := r.scid_raw::integer;
    exception when others then
      v_scid := null;
    end;

    -- cleanPhone() de format.js: solo dígitos.
    v_phone := regexp_replace(coalesce(r.phone, ''), '\D', '', 'g');

    -- Email opcional (2026-08-31): minúsculas, y si no parece un email se
    -- descarta EL EMAIL, no la fila — un dato accesorio mal cargado allá no
    -- puede costar el alta/update del cliente.
    v_email := lower(r.email);
    if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      v_email := null;
    end if;

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
      -- (sellercloud_id null) con el mismo teléfono. Comparado por los
      -- últimos 10 dígitos (2026-07-15): el número nacional real, sin
      -- importar si un lado trae código de país y el otro no.
      select id into v_client_id
      from public.clients where sellercloud_id = v_scid;

      if v_client_id is null then
        select id into v_client_id
        from public.clients
        where sellercloud_id is null
          and right(regexp_replace(phone, '\D', '', 'g'), 10) = right(v_phone, 10);

        if v_client_id is not null then
          update public.clients set
            sellercloud_id = v_scid,
            name           = r.name,
            email          = coalesce(v_email, email),
            vendedora_id   = coalesce(v_vendedora_id, vendedora_id)
          where id = v_client_id;
          v_linked := v_linked + 1;
          continue;
        end if;
      end if;

      -- price_list_id: null en el insert, intacto en el update — la
      -- asignación de lista es siempre manual.
      insert into public.clients as c
        (sellercloud_id, name, phone, email, token, price_list_id, vendedora_id)
      values
        (v_scid, r.name, v_phone, v_email, public.sync_generate_token(), null, v_vendedora_id)
      on conflict (sellercloud_id) do update set
        name         = r.name,
        phone        = v_phone,
        email        = coalesce(v_email, c.email),
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

-- ---------- Verificación manual (SQL Editor) ----------
-- Las dos RPC nuevas/reescritas quedaron con una sola firma cada una (si
-- update_client_info aparece DOS veces, PostgREST va a fallar con PGRST203):
-- select proname, pg_get_function_identity_arguments(oid), prosecdef
-- from pg_proc where proname in
--   ('update_client_info', 'set_client_sellercloud_id', 'sync_upsert_clients');
--
-- La columna nueva:
-- select column_name from information_schema.columns
-- where table_name = 'clients' and column_name = 'email';
--
-- is_admin()/is_vendedora() dan false en el SQL Editor (corre como
-- postgres), así que las RPC de edición siempre van a tirar 'no tenés
-- permiso...' / 'solo un admin...' desde acá — probarlas desde la app.
-- Auditoría después de un cambio real:
-- select action, client_name, detail from public.admin_audit_log
-- where action in ('update_client_info', 'set_client_sellercloud_id')
-- order by created_at desc limit 10;
