-- ============================================================
-- Diagnóstico: "las órdenes del cliente no aparecen en Pedidos"
-- Caso reportado 2026-08-12 — cliente Robert Carlos Pacheco.
--
-- NO escribe nada (salvo el paso 0, que es opcional y borra una fila de
-- prueba mía). Correr los bloques EN ORDEN en el SQL Editor de Supabase y
-- pegarme los resultados; cada uno descarta una causa distinta.
--
-- Antes de correr nada: subí "Max rows" en el SQL Editor si vas a exportar,
-- que ya nos jugó una mala pasada (2026-07-16).
-- ============================================================

-- ---------- 0) Limpieza de mi fila de prueba (opcional) ----------
-- Para saber qué versión de create_order estaba viva hice una llamada de
-- prueba con un token inventado; eso dejó UN registro de fallo sin cliente
-- ("Cliente desconocido · token inválido", sin botón Recuperar) en el banner
-- rojo de Pedidos. No es un pedido perdido: es mío. Se borra así.
delete from public.order_failures
where token_hint = '__diag__' and client_id is null and items is null;

-- ---------- 1) El cliente: ¿existe? ¿está duplicado? ¿tiene lista? ----------
-- Qué mirar:
--   * Más de una fila = cliente duplicado; los pedidos pueden estar colgando
--     de la OTRA fila (ya pasó en este proyecto, 2026-07-15/16).
--   * lista = null → el catálogo le sale vacío y no puede armar carrito.
--   * token_empieza tiene que coincidir con el link que le mandó la vendedora.
select c.id,
       c.name,
       c.phone,
       c.sellercloud_id,
       pl.code                 as lista,
       v.name                  as vendedora,
       left(c.token, 6) || '…' as token_empieza,
       c.created_at
from public.clients c
left join public.price_lists pl on pl.id = c.price_list_id
left join public.vendedores  v  on v.id  = c.vendedora_id
where c.name ilike '%pacheco%'
   or c.name ilike '%robert%carlos%'
order by c.created_at;

-- ---------- 2) ¿Tiene pedidos guardados, aunque no los veas en el panel? ----------
-- Sin filtro de estado ni de fecha: si acá aparecen, el pedido SÍ se registró y
-- el problema es de visualización (filtros de la pestaña, vendedora asignada),
-- no de captura.
select o.id,
       o.created_at,
       o.kind,
       o.status,
       o.total,
       jsonb_array_length(o.items) as lineas,
       c.name                      as cliente
from public.orders o
join public.clients c on c.id = o.client_id
where c.name ilike '%pacheco%'
   or c.name ilike '%robert%carlos%'
order by o.created_at desc;

-- ---------- 3) LA CLAVE: ¿quedó registrado el rechazo? ----------
-- create_order nunca falla en silencio desde 2026-08-05: todo rechazo escribe
-- acá con el motivo exacto. Los últimos 50, de todos los clientes.
--
-- Motivos posibles y qué significan:
--   'token inválido'                     → el link que usó no corresponde a
--                                          ningún cliente (link viejo/mal copiado)
--   'payload vacío o mal formado'        → llegó sin ítems
--   'demasiadas líneas: N (el tope 1000)'→ pedido gigante (contar LÍNEAS, no monto)
--   'ningún ítem válido …'               → todos sus productos estaban inactivos
--   'productos sin precio en la lista …' → falta precio en SU lista → se rechaza
--                                          el pedido entero (regla de 2026-08-06)
select f.id                                              as id_fallo,
       f.created_at,
       coalesce(c.name, '(sin cliente / token inválido)') as cliente,
       f.reason                                          as motivo,
       f.line_count                                      as lineas_enviadas,
       f.kind,
       f.token_hint,
       f.recovered_order_id                              as ya_recuperado,
       jsonb_array_length(coalesce(f.items, '[]'::jsonb)) as lineas_en_payload
from public.order_failures f
left join public.clients c on c.id = f.client_id
order by f.created_at desc
limit 50;

-- ---------- 4) ¿El sistema está registrando pedidos en general? ----------
-- Si acá hay actividad normal, el problema es de este cliente; si se cortó
-- todo desde una fecha, es sistémico.
select date_trunc('day', created_at)::date as dia,
       count(*)                            as pedidos,
       count(*) filter (where kind = 'quote') as cotizaciones
from public.orders
where created_at > now() - interval '21 days'
group by 1
order by 1 desc;

-- ---------- 5) Detalle de UN fallo puntual ----------
-- Reemplazar <ID_FALLO> por el id_fallo del paso 3 (el del cliente).
-- Muestra, producto por producto, POR QUÉ se cayó: si está inactivo, sin
-- stock, o sin precio en la lista de ese cliente. Es el que responde
-- "¿qué hay que arreglar para que su pedido entre?".
/*
select p.sku,
       p.name,
       p.active                       as activo,
       p.availability                 as etiqueta,
       p.stock,
       pp.price                       as precio_en_su_lista,
       (e->>'qty')::int               as cantidad_pedida
from public.order_failures f
cross join lateral jsonb_array_elements(f.items) e
left join public.products p on p.id = (e->>'id')::uuid
left join public.product_prices pp
       on pp.product_id    = p.id
      and pp.price_list_id = (select price_list_id from public.clients where id = f.client_id)
where f.id = '<ID_FALLO>'
order by (pp.price is null) desc, p.active, p.name;
*/

-- ---------- 6) Recuperar el pedido perdido ----------
-- Lo normal es hacerlo desde el panel: pestaña Pedidos → banner rojo
-- "⚠️ Pedidos que no se registraron" → botón "Recuperar", que lo carga como
-- pedido con los precios VIGENTES y marca el fallo como recuperado.
-- Ojo: el botón solo aparece si el fallo tiene cliente e ítems (un
-- 'token inválido' no se puede recuperar: no se sabe de quién era).
--
-- Importante: primero arreglar la causa del paso 5 (cargar el precio que
-- falta, reactivar el producto), porque "Recuperar" vuelve a pasar por las
-- mismas validaciones y rebotaría igual.
