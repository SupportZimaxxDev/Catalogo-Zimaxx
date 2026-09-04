-- Detección y ajuste de cambios de precio en pedidos (2026-09-02, a pedido
-- del usuario). Un pedido (kind = 'order') congela el precio al crearse: los
-- ítems guardan una copia como recibo de ese día. Cuando la lista de precios
-- cambia después (llega mercancía, cambia el costo promedio), el pedido queda
-- con precios viejos y nadie se entera hasta compararlo a mano. Dos piezas:
--
--   (1) `get_orders_price_drift(uuid[])` — hermana de get_quotes_live_pricing
--       pero para kind = 'order': compara el precio congelado de cada línea
--       contra el que le tocaría HOY según la lista del cliente y devuelve
--       SOLO los pedidos con al menos una diferencia. Nada se ajusta solo:
--       esto es detección, el ajuste es el botón de (2) con revisión humana.
--
--   (2) `refresh_order_prices(uuid)` — recalcula los ítems del pedido a los
--       precios de hoy SIN tocar productos ni cantidades, auditado en
--       admin_audit_log ('refresh_order_prices', con total anterior y nuevo),
--       mismo patrón de permisos y escritura que update_order_items (que solo
--       edita cotizaciones y por eso no sirve tal cual para esto).
--
-- Elegibilidad (las dos piezas): kind = 'order' y status = 'new'. El pago
-- ocurre fuera de la app; el proxy de "todavía ajustable" es el estado — un
-- pedido 'done' (atendido) o 'cancelled' no se toca ni se reporta. Los
-- estados reales son exactamente 'new' | 'done' | 'cancelled'
-- (orders_status_check, migration-2026-07-15-order-status-cancelled.sql).
--
-- Permisos y tolerancia, calcados de get_quotes_live_pricing: SECURITY
-- DEFINER, solo authenticated (revoke public + grant explícito); admin ve
-- cualquier pedido, vendedora solo los de sus clientes; en la RPC de
-- detección los pedidos ajenos o no elegibles se OMITEN del resultado en vez
-- de tirar error, para poder pedir en bulk sin que uno ajeno tumbe el resto
-- (el frontend pide en tandas de 100, igual que el live pricing).
--
-- Cómo se resuelve el precio vigente: NO se duplica la fórmula — se llama a
-- compute_order_items (el mismo helper que usan create_order /
-- update_order_items / get_quotes_live_pricing / convert_quote_to_order), o
-- sea: flash vigente si la línea venía marcada flash, si no precio de la
-- lista del cliente con `pp.price > 0`, y producto resoluble solo si
-- `(active or deactivated_by_stock)`. En la detección se llama POR LÍNEA
-- (array de 1 ítem) y no una vez por pedido: compute_order_items DESCARTA en
-- silencio las líneas que no puede resolver (producto borrado o desactivado
-- a mano, ítem malformado), así que con una sola llamada el resultado no se
-- puede alinear 1 a 1 contra lo congelado — y una línea que se cae en
-- silencio es exactamente lo que esta pantalla existe para evitar.
--
-- Bordes (comportamiento explícito, ver también los asserts de la
-- verificación):
--   * Producto sin precio vigente resoluble (lo sacaron de la lista, precio
--     en 0, lo desactivaron a mano, lo borraron, o el cliente pasó a la
--     lista 'quote' que no lleva precios): la línea se REPORTA con
--     `current_price: null` y NO entra en `current_total` — la vendedora la
--     ve ("sin precio vigente — revisar") en vez de perderla en silencio.
--     refresh_order_prices en ese caso RECHAZA el pedido entero con los SKU
--     culpables (mismo criterio que create_order con require-price: un
--     pedido real no puede quedar con una línea sin precio, y mezclar
--     congelado con vigente en un mismo guardado sería peor de auditar).
--   * Producto deactivated_by_stock (salió del catálogo por stock): sigue
--     siendo pre-order pedible, compute_order_items lo resuelve normal — se
--     compara y se ajusta como cualquier otro.
--   * Cliente cuya lista cambió después del pedido: no hay caso especial —
--     "el precio que le tocaría hoy" es el de su lista ACTUAL, que es
--     exactamente lo que create_order haría con ese carrito hoy.
--   * `frozen_total` es orders.total (el recibo congelado), no una re-suma
--     de las líneas; `current_total` suma current_price × qty de TODAS las
--     líneas resolubles del pedido (no solo las que difieren), para que "el
--     total pasa de $X a $Y" hable del pedido completo.
--   * `delta` por línea = (current_price − frozen_price) × qty, redondeado a
--     2; null si la línea no tiene precio vigente.
--
-- Compatibilidad hacia atrás: solo agrega funciones nuevas (ninguna firma
-- existente cambia), así que puede correr ANTES del deploy sin romper el
-- frontend viejo, que simplemente no las llama. Idempotente: re-correrla
-- recrea las mismas funciones.
--
-- Requiere (preflight abajo, corta en limpio si falta algo):
--   * migration-2026-07-17-orders-edit-live-quotes.sql (compute_order_items,
--     admin_audit_log.order_id, trigger orders_guard_items_edit +
--     app.allow_order_edit).
--   * migration-2026-07-15-order-status-cancelled.sql (orders.status).
--   * Conviene que compute_order_items ya sea la versión de
--     migration-2026-08-12-hide-out-of-stock.sql (deactivated_by_stock) —
--     con una anterior las funciones corren igual, solo que un producto
--     desactivado por stock se reportaría como "sin precio vigente".
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
declare
  faltan text[] := '{}';
begin
  if to_regprocedure('public.compute_order_items(uuid, jsonb, text)') is null then
    faltan := array_append(faltan, 'compute_order_items (migration-2026-07-17-orders-edit-live-quotes.sql)');
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'status'
  ) then
    faltan := array_append(faltan, 'orders.status (migration-2026-07-15-order-status-cancelled.sql)');
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'admin_audit_log' and column_name = 'order_id'
  ) then
    faltan := array_append(faltan, 'admin_audit_log.order_id (migration-2026-07-17-orders-edit-live-quotes.sql)');
  end if;
  if to_regprocedure('public.is_vendedora()') is null then
    faltan := array_append(faltan, 'is_vendedora()');
  end if;
  if to_regprocedure('public.current_vendedora_id()') is null then
    faltan := array_append(faltan, 'current_vendedora_id()');
  end if;
  if array_length(faltan, 1) is not null then
    raise exception 'faltan piezas previas: %', array_to_string(faltan, ' · ');
  end if;
end $$;

-- ---------- (1) get_orders_price_drift ----------
-- Devuelve {order_id: {items: [{sku, name, qty, frozen_price, current_price,
-- delta}], frozen_total, current_total}} SOLO para los pedidos con al menos
-- una línea cuyo precio vigente difiere del congelado. `items` trae SOLO las
-- líneas que difieren (las demás no son ruido para revisar); sku/name/qty
-- son los del recibo congelado. Pedido sin diferencias, cotización, pedido
-- atendido/cancelado, pedido ajeno o cliente borrado: se omiten, sin error.
create or replace function public.get_orders_price_drift(p_order_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin  boolean := public.is_admin();
  v_vend_id   uuid    := public.current_vendedora_id();
  v_result    jsonb   := '{}'::jsonb;
  v_order     public.orders%rowtype;
  v_client    public.clients%rowtype;
  v_item      jsonb;
  v_line      jsonb;
  v_qty       int;
  v_frozen    numeric;
  v_current   numeric;
  v_drift     jsonb;
  v_total     numeric;
  v_has_cur   boolean;
begin
  if not (v_is_admin or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  for v_order in
    select * from public.orders
    where id = any(p_order_ids) and kind = 'order' and status = 'new'
  loop
    select * into v_client from public.clients where id = v_order.client_id;
    if not found then continue; end if;
    if not v_is_admin and v_client.vendedora_id is distinct from v_vend_id then
      continue;
    end if;
    if v_order.items is null or jsonb_typeof(v_order.items) <> 'array' then
      continue;
    end if;

    v_drift   := '[]'::jsonb;
    v_total   := 0;
    v_has_cur := false;

    for v_item in select value from jsonb_array_elements(v_order.items) loop
      -- Congelado, leído a la defensiva: los ítems los escribe siempre el
      -- servidor (id/sku/name/qty/price/flash), pero un price no numérico no
      -- tiene por qué tumbar el bulk entero.
      v_frozen := case when jsonb_typeof(v_item -> 'price') = 'number'
                       then (v_item ->> 'price')::numeric end;
      v_qty    := case when jsonb_typeof(v_item -> 'qty') = 'number'
                       then floor((v_item ->> 'qty')::numeric)::int end;

      -- Precio vigente de ESTA línea, con la misma lógica de siempre (ver
      -- encabezado: por qué por línea y no una llamada por pedido). Si
      -- compute la descarta (producto borrado/desactivado a mano, línea
      -- malformada) o la devuelve sin precio, queda current_price = null.
      v_line := public.compute_order_items(
        v_order.client_id, jsonb_build_array(v_item), 'order');
      if jsonb_array_length(v_line -> 'items') = 0 then
        v_current := null;
      else
        v_current := case when jsonb_typeof(v_line -> 'items' -> 0 -> 'price') = 'number'
                          then (v_line -> 'items' -> 0 ->> 'price')::numeric end;
      end if;

      if v_current is not null and v_qty is not null then
        v_total   := v_total + v_current * v_qty;
        v_has_cur := true;
      end if;

      if v_current is distinct from v_frozen then
        v_drift := v_drift || jsonb_build_object(
          'sku',           v_item ->> 'sku',
          'name',          v_item ->> 'name',
          'qty',           v_qty,
          'frozen_price',  v_frozen,
          'current_price', v_current,
          'delta',         case when v_current is not null and v_frozen is not null
                                     and v_qty is not null
                                then round((v_current - v_frozen) * v_qty, 2) end
        );
      end if;
    end loop;

    if jsonb_array_length(v_drift) > 0 then
      v_result := v_result || jsonb_build_object(v_order.id::text, jsonb_build_object(
        'items',         v_drift,
        'frozen_total',  v_order.total,
        'current_total', case when v_has_cur then round(v_total, 2) end
      ));
    end if;
  end loop;

  return v_result;
end;
$$;

revoke execute on function public.get_orders_price_drift(uuid[]) from public;
grant execute on function public.get_orders_price_drift(uuid[]) to authenticated;

-- ---------- (2) refresh_order_prices ----------
-- "Actualizar a precios vigentes": recalcula los ítems del pedido con
-- compute_order_items (mismos productos, mismas cantidades, mismo flag
-- flash; sku/name también se refrescan desde products, igual que hace
-- convert_quote_to_order) y guarda auditado. A diferencia de la detección,
-- acá los bordes CORTAN con error en vez de omitirse: es una acción puntual
-- con revisión humana, no un bulk — el que aprieta el botón tiene que saber
-- exactamente por qué no salió.
create or replace function public.refresh_order_prices(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order    public.orders%rowtype;
  v_client   public.clients%rowtype;
  v_result   jsonb;
  v_missing  text;
  v_no_price text;
  v_email    text;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'pedido no encontrado';
  end if;

  select * into v_client from public.clients where id = v_order.client_id;
  if not found then
    raise exception 'el cliente de este pedido ya no existe';
  end if;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso para editar este pedido';
  end if;

  -- Solo pedidos reales (una cotización ya se muestra siempre con precio
  -- vigente, no tiene nada que refrescar) y solo mientras siguen 'new' —
  -- atendido o cancelado no se toca, igual que la detección.
  if v_order.kind <> 'order' then
    raise exception 'solo se pueden actualizar pedidos reales (las cotizaciones ya se muestran con precio vigente)';
  end if;
  if v_order.status <> 'new' then
    raise exception 'solo se pueden actualizar pedidos sin atender';
  end if;

  v_result := public.compute_order_items(v_client.id, v_order.items, 'order');

  -- compute_order_items descarta en silencio las líneas que no puede
  -- resolver (producto borrado o desactivado a mano). "Sin tocar productos
  -- ni cantidades" significa que acá eso NO puede pasar: se corta con los
  -- SKU culpables para que se edite el pedido a mano primero.
  select string_agg(coalesce(s ->> 'sku', s ->> 'id'), ', ')
    into v_missing
  from jsonb_array_elements(v_order.items) s
  where not exists (
    select 1 from jsonb_array_elements(v_result -> 'items') r
    where r ->> 'id' = s ->> 'id'
      and coalesce((r ->> 'flash')::boolean, false)
          is not distinct from coalesce((s ->> 'flash')::boolean, false)
  );
  if v_missing is not null then
    raise exception 'hay líneas que ya no se pueden recalcular (producto desactivado o borrado): % — editá el pedido antes de actualizar precios', v_missing;
  end if;

  -- Mismo criterio que create_order (require-price, 2026-08-06): un pedido
  -- real no se guarda con una línea sin precio. Si la lista del cliente ya
  -- no tiene precio para algo (o pasó a la lista 'quote'), se corta con los
  -- SKU culpables — el panel los muestra como "sin precio vigente".
  select string_agg(e ->> 'sku', ', ' order by e ->> 'sku')
    into v_no_price
  from jsonb_array_elements(v_result -> 'items') e
  where e ->> 'price' is null;
  if v_no_price is not null then
    raise exception 'productos sin precio en la lista del cliente: %', v_no_price;
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('refresh_order_prices', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object(
       'before_items', v_order.items,
       'before_total', v_order.total,
       'after_items',  v_result -> 'items',
       'after_total',  v_result -> 'total'
     ));

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set items = v_result -> 'items', total = (v_result ->> 'total')::numeric
  where id = p_order_id;

  return v_result;
end;
$$;

revoke execute on function public.refresh_order_prices(uuid) from public;
grant execute on function public.refresh_order_prices(uuid) to authenticated;

-- ---------- Selects de prueba (comentados) ----------
-- Correr a mano en el SQL Editor antes de dar por buena la migración. Ojo:
-- is_admin()/is_vendedora() dan false corriendo como postgres, así que las
-- dos RPC van a tirar 'no autorizado' desde el SQL Editor — probarlas desde
-- la app, o simular el drift así:
--
-- 1) Buscar un pedido nuevo y subirle el precio a uno de sus productos:
-- select o.id, e->>'sku' as sku, e->>'price' as frozen
-- from public.orders o, jsonb_array_elements(o.items) e
-- where o.kind = 'order' and o.status = 'new' limit 5;
-- update public.product_prices set price = price + 1
-- where product_id = '<product_id>' and price_list_id =
--   (select price_list_id from public.clients where id =
--     (select client_id from public.orders where id = '<order_id>'));
--
-- 2) Desde la app (o con un JWT de admin):
-- select public.get_orders_price_drift(array['<order_id>']::uuid[]);
-- -- Debe devolver SOLO ese pedido, con la línea tocada (frozen vs current,
-- -- delta) y frozen_total/current_total. Un pedido sin drift, una
-- -- cotización o un pedido atendido/cancelado no aparecen.
--
-- 3) select public.refresh_order_prices('<order_id>');
-- -- El pedido queda con items/total a precio vigente, suma una fila en
-- -- admin_audit_log con action = 'refresh_order_prices' (before/after), y
-- -- get_orders_price_drift ya no lo devuelve.
--
-- 4) Deshacer el precio de prueba:
-- update public.product_prices set price = price - 1
-- where product_id = '<product_id>' and price_list_id = '<lista>';
