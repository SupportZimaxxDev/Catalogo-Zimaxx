-- Corrige clientes duplicados por formato de teléfono (2026-07-15,
-- detectado por el usuario: mismo cliente cargado dos veces porque un
-- lado tenía el teléfono con código de país y el otro sin él — en este
-- caso concreto, "51" de Perú). Dos partes:
--
--   (1) Limpieza de los ~180 duplicados que ya creó la corrida del sync de
--       hoy (2026-07-15 16:09:03): son filas con `price_list_id` null,
--       `sellercloud_id` no null y CERO pedidos — la huella exacta de
--       `sync_upsert_clients` creando un cliente nuevo en vez de adoptar
--       el ya cargado (que sí tiene lista, vendedora y a veces pedidos).
--       Cuatro pasos EN ESTE ORDEN (el primer intento de esta migración
--       falló con "duplicate key value violates unique constraint
--       clients_sellercloud_id_key" por hacerlo al revés — copiar el
--       sellercloud_id a la fila real ANTES de borrar la fila basura deja
--       un instante con las dos filas compartiendo el mismo valor):
--         1a. Backup completo de `clients` tal cual está ahora (red de
--             seguridad a pedido del usuario, antes de tocar nada).
--         1b. Capturar en tablas temporales qué fila basura borrar y
--             cuál `sellercloud_id` le corresponde adoptar a cada fila
--             real (sin tocar nada todavía).
--         1c. Borrar las filas basura (libera sus `sellercloud_id`).
--         1d. Recién ahí, copiar el `sellercloud_id` capturado a la fila
--             real — para entonces ya no hay ningún choque posible.
--
--   (2) `sync_upsert_clients` se reescribe (mismo cuerpo que
--       migration-2026-07-10-sellercloud-sync-v2.sql) para que el paso de
--       "adopción por teléfono" compare los ÚLTIMOS 10 DÍGITOS en vez del
--       string completo — mismo criterio que ya se aplicó en
--       ClientsAdmin.jsx (ver phoneKey() en el frontend). Sin este
--       cambio, la próxima corrida del sync volvería a duplicar
--       cualquier cliente cuyo teléfono en SellerCloud no coincida
--       carácter por carácter con el guardado acá.
--
--   (3) Índice único sobre el teléfono normalizado (últimos 10 dígitos):
--       ahora que no quedan duplicados "basura del sync", esto blinda a
--       nivel de base de datos contra que esto vuelva a pasar por
--       CUALQUIER camino (Excel, alta manual, sync) — un intento de
--       insertar un teléfono que ya existe en otro formato falla con
--       unique_violation, que sync_upsert_clients ya atrapa (cuenta en
--       phone_conflicts) y que el frontend ya evita de entrada (no llega
--       a intentarlo).
--
--       EXCEPCIÓN CONOCIDA (2026-07-15, confirmado con el usuario): al
--       revisar los duplicados a mano aparecieron 2 pares que NO son el
--       bug del sync — son clientes reales, cada uno con su propia lista
--       de precio y vendedora ya asignada desde la carga inicial del
--       2026-07-02, que comparten el mismo número de teléfono porque a
--       veces el mismo negocio se agenda una vez con nombre de persona y
--       otra con nombre de empresa. El usuario decidió mantenerlos como
--       2 clientes distintos, no fusionarlos. Por eso se agrega la
--       columna `clients.allow_shared_phone` (marcada `true` en esos 4
--       registros puntuales) y el índice es PARCIAL (`where not
--       allow_shared_phone`): no exige unicidad para las filas marcadas,
--       sí para el resto. Si en el futuro aparece otro caso legítimo
--       igual, se marca esa fila a mano con
--       `update clients set allow_shared_phone = true where id = '...'`
--       (no hay UI para esto todavía).
--
-- Nada de esto toca `orders` ni pedidos existentes; los clientes que se
-- borran tienen 0 pedidos y ninguna lista de precio asignada (ver regla
-- del DELETE más abajo). Los 4 clientes de la excepción de arriba NO se
-- tocan (no están en el patrón "basura del sync": ambas filas de cada
-- par tienen lista de precio propia).
set lock_timeout = '10s';

-- Transacción explícita (no confiar en que el editor mande todo el
-- script como una sola transacción implícita): las tablas temporales de
-- abajo son ON COMMIT DROP, así que tienen que sobrevivir hasta el
-- COMMIT final, no desaparecer statement por statement.
begin;

-- ---------- (1a) Backup de `clients` antes de tocar nada ----------
-- Tabla permanente (no temporal): sobrevive al commit para poder
-- inspeccionar o revertir a mano si algo sale mal. Nombre con fecha fija
-- para no pisar un backup de otro día; falla explícito (no
-- "if not exists") si ya existe uno con este nombre, para no taparlo
-- por error con un backup de una corrida distinta el mismo día.
create table public.clients_backup_20260715 as
select * from public.clients;

-- ---------- (1b) Capturar qué borrar y a quién adoptar ----------
-- Ojo con el orden: NO se puede copiar sellercloud_id a la fila real
-- todavía teniendo la fila basura sin borrar — las dos filas quedarían
-- con el mismo valor al mismo tiempo y el índice único de
-- `sellercloud_id` lo rechaza (pasó al primer intento: "duplicate key
-- value violates unique constraint clients_sellercloud_id_key"). Por
-- eso primero se captura el mapeo en una tabla temporal, DESPUÉS se
-- borra la fila basura (libera el valor) y RECIÉN ENTONCES se actualiza
-- la fila real con el valor ya capturado.
--
-- `distinct on (k.id)` por si hubiera más de una fila basura para el
-- mismo cliente real (2+ corridas del sync duplicando lo mismo): solo
-- una le presta su sellercloud_id a la fila real (la más nueva); el
-- resto igual se borra en el paso siguiente, simplemente sin aportar
-- ningún sellercloud_id (la fila real se vincula con esa igual).
create temporary table _dup_merge_map on commit drop as
select distinct on (k.id)
  k.id as keep_id,
  j.id as junk_id,
  j.sellercloud_id as junk_scid
from public.clients j
join public.clients k
  on k.id <> j.id
 and k.price_list_id is not null
 and k.sellercloud_id is null
 and right(regexp_replace(k.phone, '\D', '', 'g'), 10)
   = right(regexp_replace(j.phone, '\D', '', 'g'), 10)
where j.price_list_id is null
  and j.sellercloud_id is not null
  and not exists (select 1 from public.orders o where o.client_id = j.id)
order by k.id, j.created_at desc;

-- Todas las filas basura a borrar (no solo las elegidas para adoptar en
-- _dup_merge_map — puede haber más de una fila basura por cliente real).
create temporary table _dup_junk_ids on commit drop as
select distinct j.id
from public.clients j
where j.price_list_id is null
  and j.sellercloud_id is not null
  and not exists (select 1 from public.orders o where o.client_id = j.id)
  and exists (
    select 1 from public.clients k
    where k.id <> j.id
      and k.price_list_id is not null
      and right(regexp_replace(k.phone, '\D', '', 'g'), 10)
        = right(regexp_replace(j.phone, '\D', '', 'g'), 10)
  );

-- ---------- (1c) Borrar las filas basura (libera sus sellercloud_id) ----------
delete from public.clients c
using _dup_junk_ids d
where c.id = d.id;

-- ---------- (1d) Recién ahora, adoptar el sellercloud_id en la fila real ----------
update public.clients k
set sellercloud_id = m.junk_scid
from _dup_merge_map m
where k.id = m.keep_id
  and k.sellercloud_id is null;

-- ---------- (2) sync_upsert_clients con match de teléfono normalizado ----------
-- Mismo cuerpo que migration-2026-07-10-sellercloud-sync-v2.sql; único
-- cambio real es el WHERE de la adopción por teléfono (right(...,10) en
-- vez de comparar el string completo).
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

-- ---------- (3) Columna de excepción + índice único parcial ----------
-- `allow_shared_phone`: marca clientes que legítimamente comparten
-- teléfono con otro (confirmado con el usuario, ver comentario grande de
-- arriba) — el índice único de abajo los ignora. Nadie más debería tener
-- este flag en `true` salvo los 2 pares marcados a continuación.
alter table public.clients
  add column if not exists allow_shared_phone boolean not null default false;

update public.clients set allow_shared_phone = true
where id in (
  '1ce21d8a-f03f-4e54-8d75-1f796f00fab9', -- Cruz Fuentes (tel. 4129751412)
  '56311ebb-74fd-4c6f-afa2-19957c8e0e37', -- CJEPERFUMES (tel. 4129751412)
  '3848e279-9c23-4b99-ba4e-2ba36438fee4', -- José Alonso Sifuentes Vega (tel. 7862051018)
  'e93b0463-c567-4b74-965c-9ff5fb2d8f44'  -- JH IMPORT (tel. 7862051018)
);

-- Ahora que no quedan duplicados "basura del sync" (pasos 1a-1d ya
-- corridos arriba) y que la excepción legítima está marcada, esto blinda
-- a nivel de base de datos contra que el bug vuelva a colarse por
-- CUALQUIER camino (Excel, alta manual, sync) — un intento de insertar
-- un teléfono que ya existe en otro formato choca con unique_violation,
-- que sync_upsert_clients ya atrapa (cuenta en phone_conflicts) y que el
-- frontend ya evita de entrada. Parcial (`where not allow_shared_phone`):
-- las filas marcadas arriba quedan fuera de la regla de unicidad.
create unique index if not exists clients_phone_normalized_key
  on public.clients (right(regexp_replace(phone, '\D', '', 'g'), 10))
  where not allow_shared_phone;

commit;

-- ---------- Verificación manual (SQL Editor) ----------
-- No deberían quedar duplicados FUERA de la excepción conocida (los 2
-- pares marcados allow_shared_phone deben ser los únicos con count > 1):
-- select right(regexp_replace(phone, '\D', '', 'g'), 10) as tel, count(*)
-- from public.clients group by 1 having count(*) > 1;
--
-- Confirmar que la excepción quedó marcada (4 filas, allow_shared_phone
-- en true):
-- select id, name, phone, allow_shared_phone from public.clients
-- where id in (
--   '1ce21d8a-f03f-4e54-8d75-1f796f00fab9', '56311ebb-74fd-4c6f-afa2-19957c8e0e37',
--   '3848e279-9c23-4b99-ba4e-2ba36438fee4', 'e93b0463-c567-4b74-965c-9ff5fb2d8f44'
-- );
--
-- Confirmar que las filas viejas quedaron con sellercloud_id:
-- select name, phone, sellercloud_id, price_list_id
-- from public.clients
-- where phone in ('51902191277', '51902444369') -- ajustar a algún caso real
-- order by phone;
--
-- El backup (`clients_backup_20260715`) queda como tabla normal en la
-- misma base — no se borra solo. Una vez confirmado que todo quedó bien
-- (algunos días de margen, no hace falta apurarse), se puede borrar a
-- mano con:
-- drop table public.clients_backup_20260715;
