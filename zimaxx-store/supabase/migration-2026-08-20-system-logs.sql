-- ============================================================
-- 2026-08-20: system_logs — logs de errores y eventos operativos
--
-- Contexto (a pedido del usuario). Hasta hoy los errores del sistema viven
-- dispersos y cada uno se mira en un lugar distinto: los pedidos rechazados en
-- `order_failures`, el último fallo de un push en `orders.sellercloud_error`,
-- los contadores de una carga de precios en la respuesta efímera de
-- `apply_price_list`, el sync en `sync_runs` — y los errores de JavaScript del
-- navegador del cliente no quedan en NINGUNA parte (la lección del pedido de
-- ~10k del 2026-08-05: lo único que había era un console.warn en el teléfono
-- del cliente). Esta migración crea el lugar único y consultable:
--
--   * tabla `system_logs` (severity info/warning/error/critical + source +
--     event + context jsonb),
--   * RPC `log_event` para escribir desde cualquier lado (el catálogo corre
--     como `anon`, así que anon puede loguear — ver anti-abuso abajo),
--   * RPC `get_system_logs` para leerla desde la pestaña ⚙️ Sistema del panel
--     (solo superadmin, mismo candado que 📈 Métricas),
--   * `purge_system_logs()` para la retención (30 días info/warning, 90
--     error/critical), lista para programar con pg_cron.
--
-- Las tablas existentes NO se tocan ni se reemplazan: `order_failures` sigue
-- guardando el payload recuperable, `sellercloud_error` sigue en el pedido.
-- system_logs es la vista transversal, no el registro de verdad de cada flujo.
--
-- REGLA DE ORO de log_event: **nunca lanza excepción hacia el caller**. Un log
-- jamás puede romper el flujo que lo llama — si el insert falla, hace
-- `raise warning` y devuelve null. Por eso también las llamadas del frontend
-- van con fire-and-forget (src/utils/systemLog.js).
--
-- ANTI-ABUSO (log_event es ejecutable por anon, no hay forma de evitarlo si el
-- catálogo del cliente tiene que poder loguear):
--   * message se trunca a 2,000 caracteres y context a ~8 KB — un payload
--     gigante no infla la tabla (mismo criterio que order_failures, que solo
--     guarda items con token válido).
--   * la tabla no la lee nadie por API (RLS sin policies; lectura solo vía
--     get_system_logs, que exige superadmin) — no sirve como canal de datos.
--   * la retención la vacía sola (purge_system_logs).
--
-- COMPATIBILIDAD: aditiva y re-corrible (if not exists / create or replace).
-- Se puede correr ANTES del deploy del frontend sin romper la versión vieja
-- (nada existente cambia), y el frontend nuevo degrada con gracia si esta
-- migración no corrió (los logs se pierden en silencio y la pestaña ⚙️
-- Sistema muestra "falta correr la migración", igual que hizo Métricas).
--
-- REQUIERE que ya esté corrida:
--   migration-2026-08-05-superadmin.sql  (crea is_superadmin, el candado de
--                                         get_system_logs)
-- ============================================================
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regprocedure('public.is_superadmin()') is null then
    raise exception 'Falta correr migration-2026-08-05-superadmin.sql (crea is_superadmin) antes de esta';
  end if;
end $$;

begin;

-- ---------- 1) La tabla ----------
-- bigint identity y no uuid: los logs son secuenciales por naturaleza, el id
-- ordenado desempata filas con el mismo created_at (dos log_event de la misma
-- transacción comparten now()) y ocupa la mitad que un uuid en los índices.
create table if not exists public.system_logs (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  severity   text not null check (severity in ('info', 'warning', 'error', 'critical')),
  -- Quién lo emitió. Sin CHECK a propósito (a diferencia de severity): sumar
  -- una fuente nueva no puede requerir una migración. Valores en uso:
  --   order_capture, order_outbox, sellercloud_push, price_upload,
  --   product_upload, sync, frontend
  source     text not null,
  -- Identificador corto del evento (order_create_failed, push_ok,
  -- price_apply_summary, js_error...). El detalle variable va en context.
  event      text not null,
  message    text,
  context    jsonb not null default '{}'::jsonb,
  -- Del header User-Agent del request (lo extrae log_event): distingue el
  -- teléfono de un cliente del navegador del panel sin guardar nada más.
  user_agent text
);

-- La pestaña Sistema lista "lo último" y filtra por severity: los dos accesos
-- que existen, cada uno con su índice.
create index if not exists system_logs_created_idx
  on public.system_logs (created_at desc);
create index if not exists system_logs_severity_created_idx
  on public.system_logs (severity, created_at desc);

-- ---------- 2) RLS: nadie entra directo ----------
-- Habilitado y SIN policies: por PostgREST no se puede ni leer ni escribir la
-- tabla. La escritura entra solo por log_event y la lectura solo por
-- get_system_logs (las dos SECURITY DEFINER: corren como el dueño de la tabla,
-- que bypassea RLS). El revoke es explícito aunque las policies vacías ya
-- nieguen todo — quién accede no debe depender de un default no escrito
-- (mismo criterio que order_failures).
alter table public.system_logs enable row level security;
revoke all on table public.system_logs from anon, authenticated;

-- ---------- 3) log_event: la única puerta de escritura ----------
-- Devuelve el id insertado, o null si no se pudo (severity inválida o fallo
-- del insert) — NUNCA una excepción: un log jamás rompe el flujo que lo llama.
create or replace function public.log_event(
  p_severity text,
  p_source   text,
  p_event    text,
  p_message  text  default null,
  p_context  jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_severity text := lower(trim(coalesce(p_severity, '')));
  v_source   text := left(coalesce(nullif(trim(p_source), ''), 'unknown'), 60);
  v_event    text := left(coalesce(nullif(trim(p_event), ''), 'unknown'), 120);
  v_message  text := left(p_message, 2000);
  v_context  jsonb;
  v_ua       text;
  v_id       bigint;
begin
  -- Severity fuera de la lista: se descarta con aviso en el log de Postgres.
  -- Descartar y no "corregir" a un valor inventado — una severidad adivinada
  -- miente en el panel, y las llamadas reales usan literales que se prueban.
  if v_severity not in ('info', 'warning', 'error', 'critical') then
    raise warning 'log_event: severity inválida (%) — evento descartado: %/%',
      coalesce(p_severity, '(null)'), v_source, v_event;
    return null;
  end if;

  -- context: siempre un objeto, y con tope de tamaño (~8 KB). No se puede
  -- "truncar" un jsonb sin romperlo, así que uno gigante se reemplaza por un
  -- marcador con los primeros bytes como texto — alcanza para ver qué era.
  begin
    v_context := coalesce(p_context, '{}'::jsonb);
    if jsonb_typeof(v_context) <> 'object' then
      v_context := jsonb_build_object('value', v_context);
    end if;
    if octet_length(v_context::text) > 8192 then
      v_context := jsonb_build_object(
        '_truncated', true,
        '_original_bytes', octet_length(v_context::text),
        '_preview', left(v_context::text, 2000)
      );
    end if;
  exception when others then
    v_context := '{}'::jsonb;
  end;

  -- User-Agent del request, si PostgREST lo expone. Best-effort declarado:
  -- si el GUC no está (SQL Editor, pg_cron) o no parsea, queda null y ya.
  begin
    v_ua := left(current_setting('request.headers', true)::jsonb ->> 'user-agent', 400);
  exception when others then
    v_ua := null;
  end;

  begin
    insert into public.system_logs (severity, source, event, message, context, user_agent)
    values (v_severity, v_source, v_event, v_message, v_context, v_ua)
    returning id into v_id;
    return v_id;
  exception when others then
    raise warning 'log_event: no se pudo insertar (%): %/%', sqlerrm, v_source, v_event;
    return null;
  end;
end;
$$;

-- anon incluido a propósito: el catálogo del cliente corre como anon y es
-- justamente el lugar donde hoy los errores no dejan rastro. service_role para
-- que las Edge Functions y el sync puedan loguear por la misma puerta.
revoke execute on function public.log_event(text, text, text, text, jsonb) from public;
grant execute on function public.log_event(text, text, text, text, jsonb)
  to anon, authenticated, service_role;

-- ---------- 4) get_system_logs: la única puerta de lectura ----------
-- Solo superadmin (mismo candado que sa_metrics_overview: la función corta,
-- ocultar la pestaña en el panel es cosmético). Paginación por cursor sobre
-- created_at: la primera página va sin p_before, y "Cargar más" manda el
-- created_at de la última fila recibida. El corte es estricto (<), así que si
-- dos filas comparten el timestamp JUSTO en el borde de página la segunda se
-- salta — con precisión de microsegundos solo pasa entre logs de la misma
-- transacción, y para un visor de logs es un costo aceptable a cambio de no
-- complicar la firma con un segundo cursor.
create or replace function public.get_system_logs(
  p_severity text        default null,
  p_source   text        default null,
  p_limit    int         default 100,
  p_before   timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 100), 500));
  v_rows  jsonb;
begin
  if not public.is_superadmin() then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc, s.id desc), '[]'::jsonb)
  into v_rows
  from (
    select id, created_at, severity, source, event, message, context, user_agent
    from public.system_logs
    where (p_severity is null or severity = p_severity)
      and (p_source   is null or source   = p_source)
      and (p_before   is null or created_at < p_before)
    order by created_at desc, id desc
    limit v_limit
  ) s;

  return v_rows;
end;
$$;

revoke execute on function public.get_system_logs(text, text, int, timestamptz) from public, anon;
grant execute on function public.get_system_logs(text, text, int, timestamptz) to authenticated;

-- ---------- 5) Retención ----------
-- info/warning son ruido operativo (resúmenes de cargas, reintentos que al
-- final entraron): 30 días alcanzan. error/critical son los que se investigan
-- después: 90. Devuelve cuántas filas borró cada tramo, para que la corrida
-- programada deje su propio rastro en el log de pg_cron.
create or replace function public.purge_system_logs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_low  int;
  v_high int;
begin
  delete from public.system_logs
  where severity in ('info', 'warning')
    and created_at < now() - interval '30 days';
  get diagnostics v_low = row_count;

  delete from public.system_logs
  where severity in ('error', 'critical')
    and created_at < now() - interval '90 days';
  get diagnostics v_high = row_count;

  return jsonb_build_object(
    'info_warning_deleted',   v_low,
    'error_critical_deleted', v_high
  );
end;
$$;

-- Sin grant a ningún rol de API: la corre pg_cron (como postgres, que es el
-- dueño y no necesita grant) o un admin a mano desde el SQL Editor.
revoke execute on function public.purge_system_logs() from public, anon, authenticated;

commit;

-- ============================================================
-- Programar la retención con pg_cron
-- ============================================================
-- pg_cron NO se asume habilitado. Cuando se quiera programar la limpieza:
--   1. Dashboard de Supabase → Database → Extensions → habilitar `pg_cron`.
--   2. En el SQL Editor:
--        select cron.schedule(
--          'purge-system-logs',          -- nombre del job
--          '30 6 * * *',                 -- todos los días 06:30 UTC
--          'select public.purge_system_logs()'
--        );
--   3. Ver que quedó:      select jobname, schedule from cron.job;
--      Última corrida:     select * from cron.job_run_details order by start_time desc limit 5;
--      Desprogramar:       select cron.unschedule('purge-system-logs');
-- Mientras pg_cron no esté, la tabla crece sin purga — correr
-- `select public.purge_system_logs();` a mano de vez en cuando.

-- ============================================================
-- Verificación manual (SQL Editor)
-- ============================================================
-- 1) Escribir y NO poder romper nada:
-- select public.log_event('info', 'sync', 'prueba', 'hola', '{"a": 1}'::jsonb);     -- devuelve un id
-- select public.log_event('grave', 'sync', 'prueba');                               -- severity inválida => null + warning
-- select public.log_event('error', 'sync', 'prueba', repeat('x', 99999));           -- message queda en 2,000 chars
--
-- 2) La tabla no se lee por API (el SQL Editor como postgres SÍ la ve; probar
--    con la anon key da 0 filas / permission denied):
-- select severity, source, event, message, created_at from public.system_logs order by id desc limit 20;
--
-- 3) get_system_logs desde el SQL Editor da 'not authorized' (auth.uid() es
--    null ahí) — se prueba desde la pestaña ⚙️ Sistema logueado como
--    superadmin, o suplantando el JWT igual que con sa_metrics_overview:
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<UUID-DEL-SUPERADMIN>","role":"authenticated"}';
--   select jsonb_pretty(public.get_system_logs(null, null, 20, null));
--
-- 4) Limpiar las filas de prueba:
-- delete from public.system_logs where source = 'sync' and event = 'prueba';
