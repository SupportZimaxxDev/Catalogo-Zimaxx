-- ============================================================
-- 2026-09-17: AVISO A LA VENDEDORA cuando se le recupera un pedido
--             + REGISTRO de cuándo y quién lo recuperó
--
-- Contexto (a pedido del usuario): "enviarle una notificación a la respectiva
-- vendedora cuando se les recupere una orden, para que les salga desde su
-- vista … y así además se puede llevar un registro de cuándo se hizo esa
-- recuperación". Hasta hoy, "Recuperar" en el cuadro rojo de Pedidos
-- (recover_order_failure) marcaba la fila con `recovered_order_id` y nada
-- más: la cotización resultante entraba a la bandeja sin ninguna marca, la
-- vendedora dueña del cliente no se enteraba (menos aún si lo recuperó un
-- admin), y el único rastro de CUÁNDO y QUIÉN vivía en admin_audit_log — que
-- la vendedora no puede leer (RLS solo admin).
--
-- Qué cambia:
--
--   1. Cuatro columnas nuevas en `order_failures`:
--        recovered_at        cuándo se recuperó
--        recovered_by        auth.users.id de quien lo hizo (sin FK, como
--                            admin_audit_log.performed_by: el registro
--                            sobrevive al usuario borrado)
--        recovered_by_email  snapshot del correo, para mostrarlo en el panel
--                            sin leer auth.users
--        recovery_seen_at    cuándo la vendedora dueña VIO la recuperación.
--                            NULL = aviso pendiente (la campanita del panel).
--      Backfill de las ya recuperadas, SOLO la primera vez que corre: fecha y
--      autor desde admin_audit_log (por order_id; si no, por
--      detail->>'failure_id'), si no hay auditoría la fecha del pedido
--      recuperado, y como último recurso now(). Y recovery_seen_at =
--      recovered_at para TODAS las históricas: el día del deploy ninguna
--      vendedora recibe un aluvión de "nuevos" viejos.
--
--   2. `recover_order_failure` llena las columnas nuevas. Si la recupera la
--      PROPIA dueña del cliente (o el cliente no tiene vendedora), nace ya
--      vista: no hay a quién avisar. Si la recupera otra persona (un admin),
--      queda pendiente. De paso el update pasa a ser compare-and-set
--      (`and recovered_order_id is null` + `if not found`): dos clicks
--      simultáneos sobre el mismo fallo ya no crean dos cotizaciones — el
--      segundo espera el lock, no encuentra la fila y su insert se revierte.
--      El retorno suma `recovered_at`.
--
--   3. RPC nueva `mark_recoveries_seen(uuid[]) → integer`: la vendedora marca
--      vistos sus avisos ("Marcar visto" / "Marcar todos como vistos"). Solo
--      toca filas recuperadas, pendientes y de SUS clientes; devuelve
--      cuántas. Un admin la puede llamar y recibe 0 (no tiene avisos
--      propios). Cada visto queda en admin_audit_log como `recovery_seen`
--      (el Registro de movimientos lo muestra como "Aviso de recuperación
--      visto"), y la recuperación suma al detail `notify_vendedora` /
--      `vendedora_id` para que el mismo Registro diga si quedó aviso.
--
-- Qué NO cambia: RLS (la vendedora ya lee las filas recuperadas de sus
-- clientes por `vendedora_read_own_failures`; el `grant select` es a nivel
-- tabla y cubre las columnas nuevas), `dismiss_order_failure`, y la
-- auditoría en admin_audit_log (sigue igual, además del registro nuevo).
--
-- Borde asumido: si el cliente cambia de vendedora entre la recuperación y
-- la vista, el aviso lo ve la dueña ACTUAL (la policy y la RPC usan la
-- vendedora vigente del cliente). Aceptable, y documentado en la columna.
--
-- Cuerpo de recover_order_failure: copia exacta del de
-- migration-2026-08-13-recover-as-quote.sql más las líneas marcadas
-- "2026-09-17". OJO (2026-09-17): al intentar correr esta migración se vio que
-- el recover_order_failure VIVO en producción era el del 08-05
-- (order-capture: recuperaba con el kind original, o sea un intento de pedido
-- volvía como pedido REAL con precio congelado) — la 08-13 NUNCA corrió allá
-- aunque el doc la daba por corrida desde el 08-19. Esta migración ABSORBE a
-- la 08-13: trae también el "siempre cotización" (la 08-13 quedó con un
-- guard para que no se corra después de esta, porque la desharía). El
-- preflight acepta las dos versiones conocidas del vivo (08-05 y 08-13) y
-- para ante cualquier otra. Aditiva: puede correr ANTES del deploy del frontend (el
-- frontend viejo hace `select *` y filtra `recovered_order_id is null`: ni ve
-- ni necesita las columnas). El frontend nuevo contra una base SIN esta
-- migración degrada: 42703 en la consulta de avisos → sin campanita ni
-- cuadro verde, el resto del panel igual. Idempotente y re-corrible.
-- ============================================================

set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
declare
  v_def text;
begin
  if to_regclass('public.order_failures') is null then
    raise exception 'Falta correr migration-2026-08-05-order-capture.sql (order_failures) antes de esta';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_failures' and column_name = 'dismissed_at'
  ) then
    raise exception 'Falta correr migration-2026-08-13-dismiss-order-failures.sql (order_failures.dismissed_at) antes de esta';
  end if;
  if to_regclass('public.admin_audit_log') is null then
    raise exception 'Falta admin_audit_log (migration-2026-07-14-client-admin-actions.sql): el backfill lee de ahí';
  end if;
  if to_regprocedure('public.recover_order_failure(uuid)') is null then
    raise exception 'Falta recover_order_failure: corré primero migration-2026-08-05-order-capture.sql y migration-2026-08-13-recover-as-quote.sql';
  end if;
  -- El cuerpo de acá abajo REEMPLAZA al vivo, así que el vivo tiene que ser
  -- una de las dos versiones conocidas: la del 08-13 (recover-as-quote, marca
  -- 'original_kind' — también la de este mismo archivo en una re-corrida) o la
  -- del 08-05 (order-capture, `case when v_fail.kind = 'quote' ...`), que es
  -- la que estaba viva en producción el 2026-09-17. Cualquier otra cosa →
  -- parar y mirar antes de pisarla.
  v_def := pg_get_functiondef('public.recover_order_failure(uuid)'::regprocedure);
  if position('original_kind' in v_def) > 0 then
    raise notice 'recovery-notifications: el recover_order_failure vivo es el del 08-13 (o esta misma migración)';
  elsif position('case when v_fail.kind = ''quote'' then ''quote'' else ''order'' end' in v_def) > 0 then
    raise notice 'recovery-notifications: el recover_order_failure vivo era el del 08-05 (recuperaba con el kind ORIGINAL). Desde ahora TODA recuperación crea una cotización (cambio del 08-13, absorbido acá)';
  else
    raise exception 'El recover_order_failure vivo no es ninguna versión conocida (ni 08-05 order-capture ni 08-13 recover-as-quote): revisar antes de reemplazarlo';
  end if;
  if to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.is_vendedora()') is null
     or to_regprocedure('public.current_vendedora_id()') is null then
    raise exception 'Faltan is_admin()/is_vendedora()/current_vendedora_id(): corré primero las migraciones del rol vendedora';
  end if;
end $$;

begin;

-- ---------- 1) Columnas + backfill (solo la primera vez) ----------
-- Todo en un solo bloque guardado por "no existe recovery_seen_at" (la
-- columna exclusiva de esta migración): re-correr el archivo no vuelve a
-- backfillear, así que una recuperación hecha entre corrida y corrida que
-- siga pendiente NO se marca vista por accidente.
do $$
declare
  v_n int;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_failures' and column_name = 'recovery_seen_at'
  ) then
    raise notice 'recovery-notifications: las columnas ya existían, sin backfill';
  else
    alter table public.order_failures
      add column if not exists recovered_at       timestamptz,
      add column if not exists recovered_by       uuid,
      add column if not exists recovered_by_email text,
      add column if not exists recovery_seen_at   timestamptz;

    -- Fecha y autor de las recuperaciones históricas. La fila de auditoría se
    -- busca primero por `order_id` (columna real, indexada; las dos versiones
    -- de la RPC la graban) y como fallback por `detail->>'failure_id'`
    -- comparado COMO TEXTO (un valor mal formado no lanza). Si hubiera dos
    -- (carrera de dos recuperaciones simultáneas, ver el compare-and-set de
    -- abajo), gana la que coincide con lo que quedó en `recovered_order_id`,
    -- y entre esas la más reciente. Sin auditoría, la fecha del pedido
    -- recuperado (left join: una FK `on delete set null` no puede apuntar a
    -- un pedido borrado, pero si faltara igual no queda pendiente para
    -- siempre). Último recurso: now().
    with src as (
      select f.id,
             coalesce(a.created_at, o.created_at, now()) as rec_at,
             a.performed_by,
             a.performed_by_email
      from public.order_failures f
      left join public.orders o on o.id = f.recovered_order_id
      left join lateral (
        select l.created_at, l.performed_by, l.performed_by_email
        from public.admin_audit_log l
        where l.action = 'recover_order_failure'
          and (l.order_id = f.recovered_order_id
               or l.detail->>'failure_id' = f.id::text)
        order by (l.order_id = f.recovered_order_id) desc nulls last, l.created_at desc
        limit 1
      ) a on true
      where f.recovered_order_id is not null
    )
    update public.order_failures f
    set recovered_at       = s.rec_at,
        recovered_by       = s.performed_by,
        recovered_by_email = s.performed_by_email,
        -- Históricas = vistas: el aviso es para lo que pase de acá en adelante.
        recovery_seen_at   = s.rec_at
    from src s
    where s.id = f.id;
    get diagnostics v_n = row_count;
    raise notice 'recovery-notifications: backfill de % recuperaciones históricas (todas marcadas vistas)', v_n;
  end if;
end $$;

comment on column public.order_failures.recovered_at is
  'Cuándo se recuperó este fallo (2026-09-17, migration-2026-09-17-recovery-notifications.sql). La escribe recover_order_failure; para las recuperaciones anteriores a la migración, backfill desde admin_audit_log (o la fecha del pedido recuperado).';
comment on column public.order_failures.recovered_by is
  'auth.users.id de quien lo recuperó (2026-09-17). Sin FK a propósito, igual que admin_audit_log.performed_by: el registro sobrevive al usuario borrado.';
comment on column public.order_failures.recovered_by_email is
  'Correo de quien lo recuperó, copiado en el momento (2026-09-17): el panel lo muestra sin leer auth.users.';
comment on column public.order_failures.recovery_seen_at is
  'Cuándo la vendedora dueña del cliente vio la recuperación (2026-09-17). NULL = aviso pendiente (campanita del panel). Nace = recovered_at si la recupera la propia dueña o el cliente no tiene vendedora (no hay a quién avisar); las históricas anteriores a la migración también quedaron vistas. Lo marca mark_recoveries_seen. Borde: si el cliente cambia de vendedora antes de verse, el aviso lo ve la dueña actual.';

-- ---------- 2) recover_order_failure: registro + aviso ----------
-- Copia exacta de migration-2026-08-13-recover-as-quote.sql más las líneas
-- marcadas 2026-09-17: el `select email` sube antes del update, el update
-- llena las columnas nuevas y es compare-and-set, y el retorno suma
-- `recovered_at`.
create or replace function public.recover_order_failure(p_failure_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fail    public.order_failures%rowtype;
  v_client  public.clients%rowtype;
  v_result  jsonb;
  v_items   jsonb;
  v_order   uuid;
  v_email   text;
  v_seen    timestamptz;   -- 2026-09-17
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

  -- Siempre 'quote': ver migration-2026-08-13-recover-as-quote.sql.
  v_result := public.compute_order_items(v_client.id, v_fail.items, 'quote');
  v_items  := v_result->'items';

  if jsonb_array_length(v_items) = 0 then
    raise exception 'ninguno de los productos sigue activo';
  end if;

  insert into public.orders (client_id, items, total, kind)
  values (v_client.id, v_items, (v_result->>'total')::numeric, 'quote')
  returning id into v_order;

  select email into v_email from auth.users where id = auth.uid();

  -- 2026-09-17: el aviso a la vendedora dueña. Si la recupera la PROPIA dueña
  -- del cliente — o el cliente no tiene vendedora — nace ya visto: no hay a
  -- quién avisar. Si la recupera otra persona (un admin: current_vendedora_id()
  -- es null), queda pendiente y la campanita del panel lo muestra hasta que
  -- ella lo marque con mark_recoveries_seen.
  v_seen := case
    when v_client.vendedora_id is not distinct from public.current_vendedora_id() then now()
    else null
  end;

  -- 2026-09-17: compare-and-set. Dos clicks simultáneos sobre el mismo fallo
  -- pasaban los dos el chequeo de arriba (la fila no estaba bloqueada) y
  -- creaban dos cotizaciones; ahora el segundo espera el lock, ya no
  -- encuentra la fila sin recuperar, y su insert se revierte con la excepción.
  update public.order_failures
  set recovered_order_id = v_order,
      recovered_at       = now(),
      recovered_by       = auth.uid(),
      recovered_by_email = v_email,
      recovery_seen_at   = v_seen
  where id = p_failure_id
    and recovered_order_id is null;
  if not found then
    raise exception 'este pedido ya fue recuperado';
  end if;

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('recover_order_failure', auth.uid(), v_email, v_client.id, v_client.name, v_order,
     jsonb_build_object(
       'failure_id',    p_failure_id,
       'reason',        v_fail.reason,
       'kind',          'quote',
       'original_kind', coalesce(v_fail.kind, 'order'),
       'items',         v_items,
       'total',         v_result->'total',
       -- 2026-09-17: para el Registro de movimientos — a quién le quedó el
       -- aviso y si quedó pendiente (false = la recuperó la propia dueña o el
       -- cliente no tiene vendedora).
       'vendedora_id',     v_client.vendedora_id,
       'notify_vendedora', (v_seen is null)
     ));

  return jsonb_build_object('ok', true, 'order_id', v_order, 'total', v_result->'total',
                            'lines', jsonb_array_length(v_items),
                            'recovered_at', now());   -- 2026-09-17
end;
$$;

revoke execute on function public.recover_order_failure(uuid) from public;
grant execute on function public.recover_order_failure(uuid) to authenticated;

-- ---------- 3) RPC: mark_recoveries_seen ----------
-- "Marcar visto" de la campanita / cuadro de recuperados. Mismo gate que
-- recover/dismiss (admin o vendedora; cualquier otro rol → 'no autorizado'),
-- pero el update solo alcanza filas recuperadas, pendientes y de los
-- clientes de la vendedora que llama: un admin puro (current_vendedora_id()
-- null) recibe 0 — no tiene avisos propios —, una vendedora no puede "leer"
-- los de otra, y marcar dos veces devuelve 0 la segunda. Cada visto queda en
-- admin_audit_log como `recovery_seen` (a pedido del usuario: todo lo de esta
-- tanda tiene que verse en el Registro de movimientos, identificado como
-- tal) — una fila por fallo, con el pedido recuperado, quién y cuándo lo
-- había recuperado.
create or replace function public.mark_recoveries_seen(p_failure_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n     integer;
  v_email text;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  if p_failure_ids is null or cardinality(p_failure_ids) = 0 then
    return 0;
  end if;

  -- El panel manda de a uno o "todos" los que tiene en pantalla (tope 50):
  -- un array absurdo no es un uso legítimo.
  if cardinality(p_failure_ids) > 500 then
    raise exception 'demasiados avisos de una vez: % (el tope es 500)', cardinality(p_failure_ids);
  end if;

  select email into v_email from auth.users where id = auth.uid();

  -- El update y su auditoría en una sola sentencia: se audita exactamente lo
  -- que se marcó (y nada si no se marcó nada).
  with upd as (
    update public.order_failures f
    set recovery_seen_at = now()
    where f.id = any(p_failure_ids)
      and f.recovered_order_id is not null
      and f.recovery_seen_at is null
      and f.client_id in (
        select id from public.clients where vendedora_id = public.current_vendedora_id()
      )
    returning f.id, f.client_id, f.kind, f.reason, f.recovered_order_id, f.recovered_at, f.recovered_by_email
  )
  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  select 'recovery_seen', auth.uid(), v_email, u.client_id, c.name, u.recovered_order_id,
         jsonb_build_object(
           'failure_id',         u.id,
           'kind',               u.kind,
           'reason',             u.reason,
           'recovered_at',       u.recovered_at,
           'recovered_by_email', u.recovered_by_email
         )
  from upd u
  left join public.clients c on c.id = u.client_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.mark_recoveries_seen(uuid[]) from public;
grant execute on function public.mark_recoveries_seen(uuid[]) to authenticated;

commit;

-- ============================================================
-- Verificación (solo lectura, SQL Editor o `supabase db query --linked`)
-- ============================================================
-- 1) Las cuatro columnas (esperado: 4 filas):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'order_failures'
--   and column_name in ('recovered_at', 'recovered_by', 'recovered_by_email', 'recovery_seen_at');
--
-- 2) La función viva es esta (true) y sigue siendo la 08-13 por dentro (true):
-- select position('recovery_seen_at' in pg_get_functiondef('public.recover_order_failure(uuid)'::regprocedure)) > 0,
--        position('original_kind'    in pg_get_functiondef('public.recover_order_failure(uuid)'::regprocedure)) > 0;
--
-- 3) La RPC nueva y sus grants (esperado: true, false, true):
-- select to_regprocedure('public.mark_recoveries_seen(uuid[])') is not null,
--        has_function_privilege('anon',          'public.mark_recoveries_seen(uuid[])', 'execute'),
--        has_function_privilege('authenticated', 'public.mark_recoveries_seen(uuid[])', 'execute');
--
-- 4) El backfill: el día de la migración sin_fecha = 0 y pendientes = 0;
--    sin_autor = las que no tenían fila de auditoría (cayeron a la fecha del pedido):
-- select count(*) filter (where recovered_order_id is not null)                              as recuperadas,
--        count(*) filter (where recovered_order_id is not null and recovered_at is null)     as sin_fecha,
--        count(*) filter (where recovered_order_id is not null and recovery_seen_at is null) as pendientes,
--        count(*) filter (where recovered_order_id is not null and recovered_by is null)     as sin_autor
-- from public.order_failures;
--
-- 5) Lo que ve la campanita de una vendedora (como ella, desde el panel):
-- select id, client_id, kind, recovered_at, recovered_by_email
-- from public.order_failures
-- where recovered_order_id is not null and recovery_seen_at is null
-- order by recovered_at desc;
