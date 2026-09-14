-- Dirección del cliente para SellerCloud (2026-09-14, a pedido del usuario:
-- "es muy importante que el cliente se guarde con el address correcto, y que
-- ese campo no llegue vacío"). Decisiones del usuario: estado obligatorio
-- para todos los países; UNA dirección para envío y facturación; obligatoria
-- solo cuando el cliente se crea en SellerCloud (un cliente local o de
-- cotización puede no tenerla); y un flujo de n8n puede traer las
-- direcciones de los customers que ya existen allá.
--
-- Por qué hace falta: el alta en SellerCloud (POST /Customers) NO acepta
-- dirección — se carga aparte con PUT /Customers/{id}/Addresses — y hasta hoy
-- no la mandábamos ni la guardábamos en ningún lado. Consecuencia real: el
-- envío de órdenes lee la dirección del customer en SellerCloud y se rechaza
-- si viene vacía; 6 de los 9 pushes fallidos entre el 07 y el 14 de
-- septiembre fueron por eso (dos de los clientes se habían creado desde este
-- catálogo).
--
-- Contrato de la API (Swagger real, /rest/swagger/docs/v1):
--   * PUT /Customers/{id}/Addresses {Addresses: UserAddressDto[]}. Cada
--     dirección: ID (0 = nueva), AddressSource, AddressStatus,
--     IsShippingAddress, IsBillingAddress, Country, City, ZipCode, Address
--     (todos requeridos) + Address2, State, Region, ContactName, CompanyName,
--     Phone (opcionales).
--   * GET /Customers/{id} devuelve `Addresses: UserAddressDto[]` (con ID).
--
-- Piezas:
--   (1) `clients` gana la dirección (address_line1/2, address_city,
--       address_state, address_zip, address_country ISO-2) y el estado de su
--       sincronización con SellerCloud: sc_address_id (ID de la dirección
--       allá), sc_address_synced_at (cuándo se confirmó releyendo el
--       customer) y sc_address_error (último error al mandarla; null = ok).
--   (2) RPC `update_client_address(...)`: edita la dirección, exige que esté
--       COMPLETA (calle, ciudad, estado, código postal, país) o totalmente
--       vacía, no deja borrarla si ya está en SellerCloud, audita
--       'update_client_address' (solo lo que cambió), admin cualquiera,
--       vendedora sus clientes. Un cambio sobre una dirección ya sincronizada
--       deja sc_address_synced_at en null ("pendiente de mandar").
--   (3) RPC `mark_client_sc_address(...)`: la llama la Edge Function
--       sellercloud-customers con el JWT del caller después del PUT + la
--       relectura: éxito → sc_address_id + synced_at + audita
--       'sync_client_address'; fallo → sc_address_error.
--   (4) `sync_upsert_clients` (n8n, SellerCloud → acá) acepta por fila, de
--       forma OPCIONAL, address/address2/city/state/zip/country/sc_address_id:
--       si trae una dirección utilizable (calle + ciudad + código postal +
--       país, lo que SellerCloud exige), la guarda como sincronizada — viene
--       de allá, es la fuente de verdad para los customers existentes. Sin
--       esas claves el sync sigue exactamente igual que antes.
--
-- Compatibilidad: aditiva. Puede correr antes del deploy sin romper el
-- frontend viejo (columnas nullable, funciones nuevas, sync con claves
-- opcionales). El frontend nuevo sin ella: el alta con dirección falla al
-- insertar columnas inexistentes (42703) — por eso va ANTES del deploy del
-- frontend y del redeploy de sellercloud-customers (que lee las columnas con
-- fallback al select anterior si no existen).
--
-- Requiere (preflight abajo): migration-2026-09-09-client-sellercloud-profile.sql
-- (clients.business_name), migration-2026-07-10-sellercloud-sync-v2.sql
-- (clients.sellercloud_id, sync_normalize_name), migration-2026-07-10
-- (sync_generate_token), admin_audit_log, is_vendedora(),
-- current_vendedora_id(). Idempotente: add column if not exists, create or
-- replace, drop constraint if exists antes de crearlo.
set lock_timeout = '10s';

-- ---------- Preflight ----------
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
    where table_schema = 'public' and table_name = 'clients' and column_name = 'business_name'
  ) then
    faltan := array_append(faltan, 'clients.business_name (migration-2026-09-09-client-sellercloud-profile.sql)');
  end if;
  if to_regclass('public.admin_audit_log') is null then
    faltan := array_append(faltan, 'admin_audit_log (migration-2026-07-14-client-admin-actions.sql)');
  end if;
  if to_regprocedure('public.is_vendedora()') is null then
    faltan := array_append(faltan, 'is_vendedora()');
  end if;
  if to_regprocedure('public.current_vendedora_id()') is null then
    faltan := array_append(faltan, 'current_vendedora_id()');
  end if;
  if to_regprocedure('public.sync_normalize_name(text)') is null then
    faltan := array_append(faltan, 'sync_normalize_name(text) (migration-2026-07-10-sellercloud-sync-v2.sql)');
  end if;
  if to_regprocedure('public.sync_generate_token()') is null then
    faltan := array_append(faltan, 'sync_generate_token() (migration-2026-07-10-sellercloud-sync.sql)');
  end if;
  if array_length(faltan, 1) is not null then
    raise exception 'faltan piezas previas: %', array_to_string(faltan, ' · ');
  end if;
end $$;

-- ---------- (1) Dirección en clients ----------
alter table public.clients
  add column if not exists address_line1        text,
  add column if not exists address_line2        text,
  add column if not exists address_city         text,
  add column if not exists address_state        text,
  add column if not exists address_zip          text,
  add column if not exists address_country      text,
  add column if not exists sc_address_id        integer,
  add column if not exists sc_address_synced_at timestamptz,
  add column if not exists sc_address_error     text;

-- País siempre como código ISO de dos letras en mayúsculas (US, VE, MX...):
-- es lo que viaja en `Country` a SellerCloud y lo que el selector del panel
-- ofrece. El sync de n8n normaliza antes de escribir.
alter table public.clients drop constraint if exists clients_address_country_iso2;
alter table public.clients
  add constraint clients_address_country_iso2
  check (address_country is null or address_country ~ '^[A-Z]{2}$');

comment on column public.clients.address_line1 is
  'Calle y número de la ÚNICA dirección del cliente (envío = facturación). Viaja como Address al PUT /Customers/{id}/Addresses de SellerCloud. Obligatoria solo para crear el customer allá.';
comment on column public.clients.address_line2 is
  'Segunda línea (apto, suite, local). Opcional. Address2 en SellerCloud.';
comment on column public.clients.address_city is
  'Ciudad. City en SellerCloud.';
comment on column public.clients.address_state is
  'Estado / provincia. Obligatorio para todos los países (decisión del usuario 2026-09-14). State en SellerCloud; para US el código de dos letras (FL).';
comment on column public.clients.address_zip is
  'Código postal. ZipCode en SellerCloud.';
comment on column public.clients.address_country is
  'País como código ISO-2 en mayúsculas (US, VE...). Country en SellerCloud.';
comment on column public.clients.sc_address_id is
  'ID de la dirección dentro del customer de SellerCloud (UserAddressDto.ID) una vez cargada y verificada releyendo el customer. Null = todavía no está allá (o no se sabe).';
comment on column public.clients.sc_address_synced_at is
  'Cuándo se confirmó por última vez que la dirección local está en SellerCloud. Null con dirección cargada y cliente vinculado = pendiente de mandar (cambio local o fallo).';
comment on column public.clients.sc_address_error is
  'Último error al cargar la dirección en SellerCloud (PUT o verificación). Null = sin error. El panel lo muestra en rojo con "Reintentar".';

-- ---------- (2) update_client_address ----------
-- Todos los parámetros son el valor NUEVO completo (el form manda los seis).
-- Regla: o la dirección viene COMPLETA (calle, ciudad, estado, código
-- postal, país) o viene toda vacía — nunca a medias, porque una dirección a
-- medias es justamente lo que SellerCloud rechaza y lo que hoy hace rebotar
-- las órdenes. Borrarla (todo vacío) solo si todavía no está en SellerCloud.
-- Devuelve {ok, changed, changes, complete}.
create or replace function public.update_client_address(
  p_client_id uuid,
  p_line1     text,
  p_line2     text,
  p_city      text,
  p_state     text,
  p_zip       text,
  p_country   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client  public.clients%rowtype;
  v_email   text;
  v_line1   text := nullif(btrim(coalesce(p_line1, '')), '');
  v_line2   text := nullif(btrim(coalesce(p_line2, '')), '');
  v_city    text := nullif(btrim(coalesce(p_city, '')), '');
  v_state   text := nullif(btrim(coalesce(p_state, '')), '');
  v_zip     text := nullif(btrim(coalesce(p_zip, '')), '');
  v_country text := nullif(upper(btrim(coalesce(p_country, ''))), '');
  v_empty   boolean;
  v_missing text[] := '{}';
  v_changes text[] := '{}';
  v_detail  jsonb := '{}'::jsonb;
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

  v_empty := v_line1 is null and v_line2 is null and v_city is null
             and v_state is null and v_zip is null and v_country is null;

  if v_empty then
    if v_client.sc_address_id is not null then
      raise exception 'este cliente ya tiene dirección en SellerCloud: se puede corregir, no borrar';
    end if;
  else
    if v_line1 is null then v_missing := array_append(v_missing, 'calle'); end if;
    if v_city is null then v_missing := array_append(v_missing, 'ciudad'); end if;
    if v_state is null then v_missing := array_append(v_missing, 'estado'); end if;
    if v_zip is null then v_missing := array_append(v_missing, 'código postal'); end if;
    if v_country is null then v_missing := array_append(v_missing, 'país'); end if;
    if array_length(v_missing, 1) is not null then
      raise exception 'dirección incompleta: falta %', array_to_string(v_missing, ', ');
    end if;
    if v_country !~ '^[A-Z]{2}$' then
      raise exception 'el país va como código de dos letras (US, VE, MX...)';
    end if;
    if length(v_zip) < 3 or length(v_zip) > 12 then
      raise exception 'el código postal tiene que tener entre 3 y 12 caracteres';
    end if;
    -- Estado de US: el código de dos letras en mayúsculas (FL, no fl).
    if v_country = 'US' and v_state ~ '^[A-Za-z]{2}$' then
      v_state := upper(v_state);
    end if;
  end if;

  if v_line1 is distinct from v_client.address_line1 then
    v_changes := array_append(v_changes, 'line1');
    v_detail := v_detail || jsonb_build_object('from_line1', v_client.address_line1, 'to_line1', v_line1);
  end if;
  if v_line2 is distinct from v_client.address_line2 then
    v_changes := array_append(v_changes, 'line2');
    v_detail := v_detail || jsonb_build_object('from_line2', v_client.address_line2, 'to_line2', v_line2);
  end if;
  if v_city is distinct from v_client.address_city then
    v_changes := array_append(v_changes, 'city');
    v_detail := v_detail || jsonb_build_object('from_city', v_client.address_city, 'to_city', v_city);
  end if;
  if v_state is distinct from v_client.address_state then
    v_changes := array_append(v_changes, 'state');
    v_detail := v_detail || jsonb_build_object('from_state', v_client.address_state, 'to_state', v_state);
  end if;
  if v_zip is distinct from v_client.address_zip then
    v_changes := array_append(v_changes, 'zip');
    v_detail := v_detail || jsonb_build_object('from_zip', v_client.address_zip, 'to_zip', v_zip);
  end if;
  if v_country is distinct from v_client.address_country then
    v_changes := array_append(v_changes, 'country');
    v_detail := v_detail || jsonb_build_object('from_country', v_client.address_country, 'to_country', v_country);
  end if;

  if coalesce(array_length(v_changes, 1), 0) = 0 then
    return jsonb_build_object('ok', true, 'changed', false, 'changes', '[]'::jsonb, 'complete', not v_empty);
  end if;

  update public.clients
     set address_line1   = v_line1,
         address_line2   = v_line2,
         address_city    = v_city,
         address_state   = v_state,
         address_zip     = v_zip,
         address_country = v_country,
         -- Cambió lo local: lo que hay en SellerCloud (si hay) quedó viejo
         -- hasta que la Edge Function la vuelva a mandar y verificar.
         sc_address_synced_at = null
   where id = p_client_id;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('update_client_address', auth.uid(), v_email, p_client_id, v_client.name,
     v_detail || jsonb_build_object('changes', to_jsonb(v_changes), 'sellercloud_id', v_client.sellercloud_id));

  return jsonb_build_object('ok', true, 'changed', true, 'changes', to_jsonb(v_changes), 'complete', not v_empty);
end;
$$;

revoke execute on function public.update_client_address(uuid, text, text, text, text, text, text) from public;
grant execute on function public.update_client_address(uuid, text, text, text, text, text, text) to authenticated;

-- ---------- (3) mark_client_sc_address ----------
-- Resultado del PUT /Customers/{id}/Addresses + relectura, anotado por la
-- Edge Function con el JWT de quien apretó el botón (misma regla de permisos
-- que link_sellercloud_customer). p_error null = la dirección está allá y se
-- verificó: guarda el ID y la hora, limpia el error y audita
-- 'sync_client_address'. p_error con texto = no entró: queda el motivo para
-- mostrarlo en rojo con "Reintentar" (el detalle largo ya va a system_logs).
create or replace function public.mark_client_sc_address(
  p_client_id     uuid,
  p_sc_address_id integer,
  p_error         text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients%rowtype;
  v_email  text;
  v_error  text := nullif(left(btrim(coalesce(p_error, '')), 2000), '');
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'cliente no encontrado';
  end if;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso para editar este cliente';
  end if;

  if v_error is not null then
    update public.clients
       set sc_address_error     = v_error,
           sc_address_synced_at = null
     where id = p_client_id;
    return jsonb_build_object('ok', true, 'synced', false);
  end if;

  if p_sc_address_id is not null and p_sc_address_id <= 0 then
    raise exception 'el ID de la dirección en SellerCloud tiene que ser un entero positivo';
  end if;

  update public.clients
     set sc_address_id        = coalesce(p_sc_address_id, sc_address_id),
         sc_address_synced_at = now(),
         sc_address_error     = null
   where id = p_client_id;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('sync_client_address', auth.uid(), v_email, p_client_id, v_client.name,
     jsonb_strip_nulls(jsonb_build_object(
       'sellercloud_id', v_client.sellercloud_id,
       'sc_address_id',  coalesce(p_sc_address_id, v_client.sc_address_id),
       'line1',          v_client.address_line1,
       'line2',          v_client.address_line2,
       'city',           v_client.address_city,
       'state',          v_client.address_state,
       'zip',            v_client.address_zip,
       'country',        v_client.address_country
     )));

  return jsonb_build_object('ok', true, 'synced', true,
                            'sc_address_id', coalesce(p_sc_address_id, v_client.sc_address_id));
end;
$$;

revoke execute on function public.mark_client_sc_address(uuid, integer, text) from public;
grant execute on function public.mark_client_sc_address(uuid, integer, text) to authenticated;

-- ---------- (4) sync_upsert_clients con dirección opcional ----------
-- Mismo cuerpo que migration-2026-08-31-client-email-sellercloud-id.sql; lo
-- nuevo es que cada fila PUEDE traer la dirección del customer tal como está
-- en SellerCloud (Addresses[] → la de envío por defecto, o la única):
--   address, address2, city, state, zip, country, sc_address_id
-- Si trae calle + ciudad + código postal + país (lo que SellerCloud exige;
-- el estado puede faltar en un customer viejo) se guarda COMO SINCRONIZADA
-- (synced_at = now(), error = null) y pisa lo local — para un customer que ya
-- existe allá, SellerCloud es la fuente de verdad. Si no trae dirección
-- utilizable, las columnas de dirección no se tocan (coalesce), igual que el
-- email. El país se normaliza a ISO-2; un nombre que no se reconoce descarta
-- LA DIRECCIÓN de esa fila, no la fila (contador `addresses_skipped`).
create or replace function public.sync_country_iso2(p_country text)
returns text
language sql
immutable
as $$
  select case
    when p_country is null then null
    when btrim(p_country) ~ '^[A-Za-z]{2}$' then upper(btrim(p_country))
    else (
      select code from (values
        ('US', array['united states','united states of america','usa','estados unidos','eeuu','ee.uu.']),
        ('VE', array['venezuela','republica bolivariana de venezuela','república bolivariana de venezuela']),
        ('MX', array['mexico','méxico']),
        ('CO', array['colombia']),
        ('PA', array['panama','panamá']),
        ('DO', array['dominican republic','republica dominicana','república dominicana']),
        ('EC', array['ecuador']),
        ('PE', array['peru','perú']),
        ('CL', array['chile']),
        ('AR', array['argentina']),
        ('BR', array['brazil','brasil']),
        ('GT', array['guatemala']),
        ('HN', array['honduras']),
        ('SV', array['el salvador']),
        ('NI', array['nicaragua']),
        ('CR', array['costa rica']),
        ('BO', array['bolivia']),
        ('PY', array['paraguay']),
        ('UY', array['uruguay']),
        ('TT', array['trinidad and tobago','trinidad y tobago']),
        ('AW', array['aruba']),
        ('CW', array['curacao','curaçao']),
        ('CA', array['canada','canadá']),
        ('ES', array['spain','españa'])
      ) as m(code, names)
      where lower(btrim(p_country)) = any (m.names)
      limit 1
    )
  end
$$;

revoke execute on function public.sync_country_iso2(text) from public;
grant execute on function public.sync_country_iso2(text) to service_role;

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
  -- Dirección (2026-09-14)
  v_has_addr        boolean;
  v_country         text;
  v_scaddr          integer;
  v_addresses       int := 0;
  v_addr_skipped    int := 0;
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
      nullif(trim(x ->> 'email'), '')          as email,
      nullif(trim(x ->> 'address'), '')        as address,
      nullif(trim(x ->> 'address2'), '')       as address2,
      nullif(trim(x ->> 'city'), '')           as city,
      nullif(trim(x ->> 'state'), '')          as state,
      nullif(trim(x ->> 'zip'), '')            as zip,
      nullif(trim(x ->> 'country'), '')        as country,
      nullif(trim(x ->> 'sc_address_id'), '')  as scaddr_raw
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

    -- Dirección opcional (2026-09-14): utilizable solo si trae lo que
    -- SellerCloud exige y el país se reconoce; si no, se descarta LA
    -- DIRECCIÓN y la fila sigue.
    v_country := public.sync_country_iso2(r.country);
    v_has_addr := r.address is not null and r.city is not null and r.zip is not null
                  and v_country is not null and length(r.zip) between 3 and 12;
    if not v_has_addr and (r.address is not null or r.city is not null or r.zip is not null or r.country is not null) then
      v_addr_skipped := v_addr_skipped + 1;
    end if;
    v_scaddr := null;
    if v_has_addr and r.scaddr_raw is not null then
      begin
        v_scaddr := nullif(r.scaddr_raw::integer, 0);
      exception when others then
        v_scaddr := null;
      end;
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
          v_unmatched_names := array_append(v_unmatched_names, r.salesman);
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
            sellercloud_id       = v_scid,
            name                 = r.name,
            email                = coalesce(v_email, email),
            vendedora_id         = coalesce(v_vendedora_id, vendedora_id),
            address_line1        = case when v_has_addr then r.address  else address_line1 end,
            address_line2        = case when v_has_addr then r.address2 else address_line2 end,
            address_city         = case when v_has_addr then r.city     else address_city end,
            address_state        = case when v_has_addr then r.state    else address_state end,
            address_zip          = case when v_has_addr then r.zip      else address_zip end,
            address_country      = case when v_has_addr then v_country  else address_country end,
            sc_address_id        = case when v_has_addr then coalesce(v_scaddr, sc_address_id) else sc_address_id end,
            sc_address_synced_at = case when v_has_addr then now() else sc_address_synced_at end,
            sc_address_error     = case when v_has_addr then null else sc_address_error end
          where id = v_client_id;
          v_linked := v_linked + 1;
          if v_has_addr then v_addresses := v_addresses + 1; end if;
          continue;
        end if;
      end if;

      -- price_list_id: null en el insert, intacto en el update — la
      -- asignación de lista es siempre manual.
      insert into public.clients as c
        (sellercloud_id, name, phone, email, token, price_list_id, vendedora_id,
         address_line1, address_line2, address_city, address_state, address_zip, address_country,
         sc_address_id, sc_address_synced_at, sc_address_error)
      values
        (v_scid, r.name, v_phone, v_email, public.sync_generate_token(), null, v_vendedora_id,
         case when v_has_addr then r.address  end,
         case when v_has_addr then r.address2 end,
         case when v_has_addr then r.city     end,
         case when v_has_addr then r.state    end,
         case when v_has_addr then r.zip      end,
         case when v_has_addr then v_country  end,
         case when v_has_addr then v_scaddr   end,
         case when v_has_addr then now()      end,
         null)
      on conflict (sellercloud_id) do update set
        name                 = r.name,
        phone                = v_phone,
        email                = coalesce(v_email, c.email),
        vendedora_id         = coalesce(v_vendedora_id, c.vendedora_id),
        address_line1        = case when v_has_addr then r.address  else c.address_line1 end,
        address_line2        = case when v_has_addr then r.address2 else c.address_line2 end,
        address_city         = case when v_has_addr then r.city     else c.address_city end,
        address_state        = case when v_has_addr then r.state    else c.address_state end,
        address_zip          = case when v_has_addr then r.zip      else c.address_zip end,
        address_country      = case when v_has_addr then v_country  else c.address_country end,
        sc_address_id        = case when v_has_addr then coalesce(v_scaddr, c.sc_address_id) else c.sc_address_id end,
        sc_address_synced_at = case when v_has_addr then now() else c.sc_address_synced_at end,
        sc_address_error     = case when v_has_addr then null else c.sc_address_error end
      returning (xmax = 0) into v_is_insert;

      if v_is_insert then
        v_created := v_created + 1;
      else
        v_updated := v_updated + 1;
      end if;
      if v_has_addr then v_addresses := v_addresses + 1; end if;
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
    'unmatched_names',    to_jsonb(v_unmatched_names),
    'addresses',          v_addresses,
    'addresses_skipped',  v_addr_skipped
  );
end;
$$;

revoke execute on function public.sync_upsert_clients(jsonb) from public;
grant execute on function public.sync_upsert_clients(jsonb) to service_role;

-- ---------- Verificación manual (SQL Editor) ----------
-- Columnas nuevas:
-- select column_name from information_schema.columns
-- where table_name = 'clients' and (column_name like 'address_%' or column_name like 'sc_address_%');
--
-- Firmas únicas (si alguna aparece dos veces, PostgREST falla con PGRST203):
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc
-- where proname in ('update_client_address', 'mark_client_sc_address', 'sync_upsert_clients', 'sync_country_iso2');
--
-- is_admin()/is_vendedora() dan false en el SQL Editor — probar las RPC desde
-- la app. Auditoría después de un cambio real:
-- select action, client_name, detail from public.admin_audit_log
-- where action in ('update_client_address', 'sync_client_address')
-- order by created_at desc limit 10;
--
-- Contrato para el flujo de n8n (SellerCloud → acá), por fila, todo opcional:
--   { "sellercloud_id": 1817629, "name": "...", "phone": "...", "salesman_name": "...",
--     "email": "...", "address": "123 NW 1st St", "address2": "Suite 4",
--     "city": "Miami", "state": "FL", "zip": "33101", "country": "US",
--     "sc_address_id": 45678 }
-- De Addresses[] del customer, mandar la marcada IsShippingAddress (o la
-- única); Address → address, Address2 → address2, City → city, State →
-- state, ZipCode → zip, Country → country, ID → sc_address_id.
