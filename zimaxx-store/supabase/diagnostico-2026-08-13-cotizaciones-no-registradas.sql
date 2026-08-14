-- ============================================================
-- Diagnóstico: "2-3 cotizaciones de anoche (2026-08-12 noche /
-- 2026-08-13 madrugada) no llegaron al sistema".
--
-- NO escribe nada. Correr los bloques EN ORDEN en el SQL Editor de Supabase
-- y pegar los resultados. Cada uno descarta una causa distinta.
--
-- Antes de correr nada: subí "Max rows" en el SQL Editor si vas a exportar.
-- ============================================================

-- ---------- 1) ¿Hubo algún rechazo registrado anoche? ----------
-- Desde migration-2026-08-05-order-capture.sql (ya corrida en producción)
-- TODO rechazo de create_order queda acá, con motivo. Si esto sale vacío
-- para la ventana de anoche, el rechazo NO pasó por el servidor — ver el
-- punto 4 más abajo.
select f.id                                              as id_fallo,
       f.created_at,
       coalesce(c.name, '(sin cliente / token inválido)') as cliente,
       f.reason                                          as motivo,
       f.line_count                                      as lineas_enviadas,
       f.kind,
       f.token_hint,
       f.recovered_order_id                              as ya_recuperado
from public.order_failures f
left join public.clients c on c.id = f.client_id
where f.created_at > now() - interval '18 hours'
order by f.created_at desc;

-- ---------- 2) ¿Se guardó alguna cotización/pedido anoche, aunque no la veas en el panel? ----------
-- Si aparece algo acá, el problema es de visualización (filtro de tipo
-- 'Cotización' vs 'Pedido', búsqueda, vendedora asignada), no de captura.
select o.id,
       o.created_at,
       o.kind,
       o.status,
       o.total,
       jsonb_array_length(o.items) as lineas,
       c.name                      as cliente,
       v.name                      as vendedora
from public.orders o
join public.clients c on c.id = o.client_id
left join public.vendedores v on v.id = c.vendedora_id
where o.created_at > now() - interval '18 hours'
order by o.created_at desc;

-- ---------- 3) Volumen general de anoche vs. noches anteriores ----------
-- Si aquí se ve actividad normal en otras franjas horarias pero un hueco
-- justo anoche, es sistémico (caída de red, deploy a mitad de la noche,
-- etc.) y no de un cliente puntual.
select date_trunc('hour', created_at) as hora,
       count(*)                       as total,
       count(*) filter (where kind = 'quote') as cotizaciones
from public.orders
where created_at > now() - interval '5 days'
group by 1
order by 1 desc;

-- ---------- 4) Si 1) y 2) salen VACÍOS: la pérdida fue client-side ----------
-- No hay nada más que consultar en la base — por diseño, create_order solo
-- deja rastro en order_failures cuando la llamada SÍ llegó al servidor y
-- fue rechazada. Si el navegador/app del cliente nunca completó esa llamada,
-- no queda ninguna fila en ningún lado. Causas típicas, todas client-side:
--   a) Cerró la pestaña/app o se quedó sin señal ANTES de que terminaran los
--      3 reintentos (handlePdf en CartDrawer.jsx reintenta con backoff de
--      700ms/1400ms — en una red mala de noche puede no alcanzar).
--   b) El teléfono se quedó sin conexión en el momento exacto del envío
--      (anoche/madrugada = típico de wifi que se cae o datos móviles flojos).
--   c) downloadOrderPdf tiró un error antes de llegar a guardar (un navegador
--      viejo generando un PDF grande) — el catch de handlePdf no lo cubre,
--      así que ni siquiera se intenta el registro.
-- Si el cliente vio el aviso rojo "⚠️ No se pudo guardar" en el carrito y
-- cerró sin tocar "Reintentar", el pedido sigue en su localStorage: puede
-- reabrir el catálogo desde el mismo enlace/teléfono y el carrito reaparece
-- con ese aviso, listo para reintentar.
