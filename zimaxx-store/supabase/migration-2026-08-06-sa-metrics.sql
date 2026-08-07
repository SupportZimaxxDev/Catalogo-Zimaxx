-- ============================================================
-- 2026-08-06: panel de MÉTRICAS (solo superadmin)
--
-- Contexto (a pedido del usuario): hasta hoy la única forma de saber cómo
-- viene el mes era abrir la pestaña Pedidos y contar a ojo, o pedirle un
-- SELECT al SQL Editor. Esta migración agrega **una** RPC que devuelve todos
-- los KPIs de un saque para la pestaña 📈 Métricas del panel
-- (src/pages/admin/MetricsAdmin.jsx), que se refresca por polling cada 60s.
--
-- Por qué una sola RPC y no consultas desde el cliente:
--   * Los agregados cruzan TODAS las vendedoras. Con RLS, una vendedora ve
--     solo sus pedidos y un admin común los ve todos — o sea que "sumar
--     orders desde el cliente" daría un número distinto según quién mira, y
--     además expondría el detalle de cada pedido para calcular un promedio.
--     Acá el cliente recibe SOLO los agregados ya cocinados.
--   * Son 7 consultas distintas (totales, ranking por vendedora, tiempo de
--     atención, conversión de cotizaciones, fallos, serie diaria). En una RPC
--     es un round-trip; desde el front serían 7 por cada refresco, cada 60s.
--
-- Es de SOLO LECTURA, así que **no** llama a sa_log(): mirar métricas no es
-- una acción sensible y auditar cada polling llenaría admin_audit_log con una
-- fila por minuto por cada pestaña abierta. El resto de las RPC sa_* sí
-- auditan porque escriben.
--
-- El candado es el mismo que el del resto del panel superadmin: is_superadmin()
-- como primera línea de la función. Ocultar la pestaña en AdminLayout.jsx es
-- cosmético — quien tenga la anon key puede llamar la RPC a mano, y ahí la
-- respuesta es 'not authorized'.
--
-- CUENTAS DE PRUEBA: los agregados excluyen a las vendedoras de prueba
-- (SystemsPruebas y compañía, ver sa_metrics_test_vendedora_patterns() más
-- abajo). No se borra ni se toca nada: solo quedan afuera del cálculo. Para
-- que la exclusión no sea invisible, la RPC devuelve además `excluidas` con
-- los nombres que efectivamente matchearon, y el panel los muestra al pie de
-- la tabla — si algún día una vendedora real cae en el patrón, se ve.
--
-- REQUIERE que ya estén corridas, en este orden:
--   1. migration-2026-07-14-client-admin-actions.sql  (crea admin_audit_log)
--   2. migration-2026-08-05-order-capture.sql         (crea order_failures)
--   3. migration-2026-08-05-superadmin.sql            (crea is_superadmin)
-- El preflight de abajo corta con un mensaje claro si falta alguna.
--
-- OJO con la 2: al 2026-08-06 `migration-2026-08-05-order-capture.sql` figura
-- como PENDIENTE en producción (es el arreglo del pedido de ~10k que se perdió
-- en silencio). Esta migración necesita su tabla `order_failures` para la
-- sección `fallos`, así que **hay que correr esa primero**. Se eligió cortar en
-- el preflight en vez de devolver `fallos: 0` cuando la tabla no existe:
-- plpgsql no valida las tablas al crear la función, así que sin el preflight la
-- RPC se crearía igual y recién explotaría en la primera llamada desde el
-- panel — un error en runtime, con la pestaña ya desplegada, en vez de uno
-- claro al correr el SQL.
--
-- Re-corrible: todo es create or replace / create index if not exists.
-- ============================================================

set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regprocedure('public.is_superadmin()') is null then
    raise exception 'Falta correr migration-2026-08-05-superadmin.sql (crea is_superadmin) antes de esta';
  end if;
  if to_regclass('public.admin_audit_log') is null then
    raise exception 'Falta correr migration-2026-07-14-client-admin-actions.sql (crea admin_audit_log) antes de esta';
  end if;
  if to_regclass('public.order_failures') is null then
    raise exception 'Falta correr migration-2026-08-05-order-capture.sql (crea order_failures) antes de esta';
  end if;
end $$;

begin;

-- ---------- 1) Índice de la ventana temporal ----------
-- Todas las secciones de la RPC arrancan con `orders.created_at >= now() - N
-- days`. Sin este índice es un seq scan de la tabla entera cada 60 segundos
-- por cada pestaña de métricas abierta. `desc` porque OrdersAdmin.jsx también
-- lista por created_at desc.
create index if not exists orders_created_idx on public.orders (created_at desc);

-- Las filas de 'update_order_status' son la mayoría de admin_audit_log y la
-- subconsulta del tiempo de atención las filtra por action + order_id. El
-- índice parcial evita recorrer todo el registro de movimientos para
-- encontrarlas.
create index if not exists admin_audit_log_order_status_idx
  on public.admin_audit_log (order_id, created_at)
  where action = 'update_order_status';

-- ---------- 2) Qué es una "cuenta de prueba" ----------
-- Patrones ILIKE contra `vendedores.name`. EDITAR ACÁ para sumar o sacar una
-- cuenta de la exclusión: es el único lugar donde vive la lista.
--
-- Las cuentas reales son nombres de personas, así que estos patrones no las
-- tocan. Aun así, la RPC devuelve los nombres que matchearon (`excluidas`) y
-- el panel los muestra: si alguna vendedora real cae acá por casualidad, se
-- nota a la primera mirada en vez de desaparecer del ranking en silencio.
--
-- Sin grant a authenticated: la usa solo sa_metrics_overview (SECURITY
-- DEFINER, corre como el dueño).
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

-- ---------- 3) La RPC ----------
-- Un único jsonb con todo lo que dibuja la pestaña. Secciones:
--   period                 { days, from, to }
--   totals                 los 6 KPIs cabecera
--   por_vendedora          ranking por monto (tabla "Adopción por vendedora")
--   tiempo_a_atender_horas promedio de horas hasta el primer "Atendido"
--   cotizaciones_convertidas
--   fallos                 { total, recuperados }
--   serie_diaria           [{ dia, monto, pedidos }] para el mini-gráfico
--   excluidas              nombres de las cuentas de prueba que quedaron afuera
--
-- Convenciones de los filtros, iguales en todas las secciones:
--   * "pedido"      = kind = 'order' and status <> 'cancelled'
--   * "cotización"  = kind = 'quote'
--   * "cancelado"   = kind = 'order' and status = 'cancelled'
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
  -- Las vendedoras de prueba, resueltas una sola vez.
  test_v as (
    select id, name
    from public.vendedores
    where public.sa_is_test_vendedora(name)
  ),
  -- Base común: los pedidos/cotizaciones del período con su vendedora, ya
  -- sin cuentas de prueba. LEFT JOIN en los dos saltos porque
  -- orders.client_id y clients.vendedora_id son nullable — un pedido sin
  -- vendedora es un pedido real y tiene que sumar en los totales (aparece en
  -- la tabla con "—"), a diferencia de uno de prueba, que se descarta.
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
  -- corregirlo), y lo que se quiere medir es cuánto tardó en atenderse la
  -- primera vez. Sin filtro de fecha acá a propósito: el período se aplica
  -- sobre orders.created_at, y el "done" de un pedido del borde de la ventana
  -- puede ser posterior.
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
  -- tardó lo que tardó en atenderse.
  -- Da null si ningún pedido del período llegó a 'done' todavía (instalación
  -- nueva, o período corto): el panel muestra "—".
  attend as (
    select avg((extract(epoch from (fd.done_at - b.created_at)) / 3600.0)::numeric) as horas
    from base b
    join first_done fd on fd.order_id = b.id
    where b.kind = 'order'
  ),
  -- Cotizaciones que se pasaron a pedido en el período. Se cuenta sobre
  -- admin_audit_log y no sobre orders porque después de convertirla la fila
  -- de orders ya dice kind='order' y no queda rastro de que fue cotización.
  -- Mismo criterio de exclusión: el detalle del cliente vive en la fila de
  -- auditoría (client_id), que sobrevive incluso si el cliente se borró.
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
  -- esos casos igual cuentan (son fallos reales), no hay vendedora que excluir.
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

commit;

-- ============================================================
-- Después de correr esto
-- ============================================================
-- No hay nada más que hacer en la base. Entrar a /admin con
-- support5@firstchoiceonline.com: aparece la pestaña 📈 Métricas al lado de
-- 🔐 Superadmin. Con cualquier otro admin NO aparece, y entrar por
-- /admin/metrics redirige a Productos.
--
-- El frontend se puede desplegar ANTES de correr esta migración: sin la RPC,
-- la pestaña muestra el aviso "Falta correr la migración …" en vez de romper.
--
-- ---------- Verificación ----------
-- Ojo: el SQL Editor corre como `postgres`, así que auth.uid() es null,
-- is_superadmin() da false y la RPC tira 'not authorized'. Es lo esperado —
-- se prueba desde el panel, logueado como superadmin.
--
-- Para verlo igual desde el SQL Editor, suplantando al superadmin:
--
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<UUID-DEL-SUPERADMIN>","role":"authenticated"}';
--   select jsonb_pretty(public.sa_metrics_overview(14));
--
-- (el UUID sale de: select user_id from public.superadmins;)
--
-- Qué cuentas están quedando afuera del cálculo:
-- select name from public.vendedores where public.sa_is_test_vendedora(name) order by name;
--
-- Qué patrones se están aplicando:
-- select public.sa_metrics_test_vendedora_patterns();
