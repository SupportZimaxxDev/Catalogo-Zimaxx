-- =============================================================================
-- Migración 2026-08-18: contador de órdenes enviadas a SellerCloud en Métricas
-- =============================================================================
-- A pedido del usuario, junto con el cambio de modalidad del envío (sin On
-- Hold, candado de Atendido): la pestaña 📈 Métricas muestra cuántos pedidos
-- salieron directo a SellerCloud.
--
-- Reemplaza `sa_metrics_overview` (la versión de
-- migration-2026-08-06-sa-metrics.sql) con tres agregados nuevos:
--   * totals.sellercloud_enviados — pedidos del PERÍODO con
--     `sellercloud_order_id` anotado (o sea: el push terminó y quedó el
--     número de orden de allá).
--   * sellercloud_total — lo mismo pero HISTÓRICO, sin ventana: el "cuántas
--     órdenes han salido directo a SellerCloud" pedido, que no depende del
--     rango elegido en la pantalla.
--   * (sin cambios en el resto: misma exclusión de vendedoras de prueba,
--     mismos nombres de claves, así el frontend viejo sigue andando.)
--
-- Se copia la función ENTERA porque create or replace reemplaza el cuerpo
-- completo; el diff real contra la v1 son las líneas marcadas con --> NUEVO.
--
-- Idempotente: se puede correr más de una vez.
-- =============================================================================

begin;

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
    select o.id, o.kind, o.status, o.total, o.created_at, c.vendedora_id, v.name as vendedora,
           o.sellercloud_order_id                                             --> NUEVO
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
      count(*) filter (where kind = 'order' and status = 'cancelled')            as cancelados,
      --> NUEVO: pedidos del período que ya salieron a SellerCloud. Sobre el
      --> número anotado y no sobre la fecha del push: si hay número, el push
      --> terminó. Sin excluir cancelados a propósito — un pedido que se envió
      --> y después se canceló acá igual salió a SellerCloud.
      count(*) filter (where kind = 'order' and sellercloud_order_id is not null)
                                                                                as sellercloud_enviados
    from base
  ),
  --> NUEVO: lo mismo pero histórico, sin ventana de fechas — responde
  --> "cuántas órdenes salieron directo a SellerCloud" sin depender del rango
  --> elegido en la pantalla. Misma exclusión de vendedoras de prueba.
  sc_total as (
    select count(*) as n
    from public.orders o
    left join public.clients    c on c.id = o.client_id
    left join public.vendedores v on v.id = c.vendedora_id
    where o.sellercloud_order_id is not null
      and (v.name is null or not public.sa_is_test_vendedora(v.name))
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
        'cancelados',         cancelados,
        'sellercloud_enviados', sellercloud_enviados          --> NUEVO
      )
      from totals
    ),
    'sellercloud_total', (select n from sc_total),            --> NUEVO
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

-- ---------- Verificación ----------
-- Igual que la v1: el SQL Editor corre como postgres (auth.uid() null), así
-- que la RPC tira 'not authorized'. Para verla igual:
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<UUID-DEL-SUPERADMIN>","role":"authenticated"}';
--   select jsonb_pretty(public.sa_metrics_overview(14));
-- Tienen que aparecer `totals.sellercloud_enviados` y `sellercloud_total`.
