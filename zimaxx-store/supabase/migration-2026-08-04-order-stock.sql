-- 2026-08-04: el stock se descuenta al marcar un pedido como Atendido, y la
-- disponibilidad (Disponible / Pre-Order) se deriva sola del stock.
--
-- Contexto (a pedido del usuario): el catálogo arrastra inventario viejo de
-- una de las primeras cargas, así que hay productos que se ven "disponibles"
-- cuando en realidad ya se agotaron. Para que dos clientes no pidan la misma
-- mercadería:
--
--   1) Al marcar un pedido como Atendido ('done'), las cantidades de ese
--      pedido se restan de products.stock. Ej.: stock 20 de Adidas Fresh, un
--      cliente pide 10, la asesora marca el pedido Atendido → queda stock 10.
--   2) Un producto que llega a 0 (o negativo) pasa automáticamente a
--      Pre-Order; cuando vuelve a entrar stock (sync, Excel o a mano) vuelve
--      solo a Disponible. 'flash' se conserva siempre (misma regla que
--      migration-2026-07-14-inventory-stock.sql).
--
-- Decisiones confirmadas con el usuario en esta sesión:
--   * Solo descuentan los pedidos reales (kind = 'order'). Una cotización
--     (kind = 'quote', ej. la que genera "Descargar PDF" del carrito, o
--     cualquier cliente con lista 'quote') NO toca el stock: primero hay que
--     pasarla a pedido con convert_quote_to_order, y recién cuando ESE pedido
--     se marca Atendido se descuenta. Si no fuera así, un cliente bajando 5
--     PDF mientras mira el catálogo vaciaría el inventario solo.
--   * Reabrir o cancelar un pedido ya atendido DEVUELVE el stock descontado
--     (marcar Atendido por error se puede deshacer). Volver a marcarlo
--     Atendido lo descuenta otra vez; nunca dos veces — la bandera
--     orders.stock_applied es la que decide, no el estado.
--   * Un producto con stock null ("todavía no se sabe", nunca sincronizado)
--     NO se toca: no se puede restar de un dato que no existe. Se cuenta
--     aparte en el detalle de auditoría (skipped) para que el admin lo vea.
--
-- OJO, requisito de datos: si migration-2026-07-14-inventory-stock.sql nunca
-- se corrió, esta migración crea igual products.stock (add column if not
-- exists) — pero la columna nace en null para TODOS los productos, así que el
-- descuento no tiene de dónde restar hasta que entre inventario real por el
-- sync (n8n: InventoryAvailableQTY → inventory), por el Excel de productos
-- (columna Inventory/Stock) o a mano desde el formulario del panel.
--
-- Idempotente, se puede re-correr. lock_timeout corto para fallar rápido y
-- limpio si un lock se traba contra producción.
set lock_timeout = '10s';

-- ---------- 1) Columnas ----------
-- products.stock: se repite acá (además de migration-2026-07-14-inventory-
-- stock.sql) para que esta migración funcione sola si aquella nunca corrió.
alter table public.products
  add column if not exists stock int;

-- orders.stock_applied: ¿este pedido ya descontó su stock? Evita el doble
-- descuento y habilita la devolución exacta al reabrir/cancelar. No se puede
-- deducir del estado: un pedido puede ir done → new → done varias veces.
alter table public.orders
  add column if not exists stock_applied boolean not null default false;

-- ---------- 2) Disponibilidad derivada del stock (trigger) ----------
-- Hasta ahora la regla "stock 0 → Pre-Order" vivía duplicada en cada camino
-- de escritura (sync_upsert_products en SQL y resolveAvailability en
-- ProductsAdmin.jsx) — y apply_price_list la pisaba sin querer: un Excel de
-- precios sin columna Type dejaba TODOS sus productos en 'available', con
-- stock 0 incluido. Con el trigger la regla pasa a ser una invariante de la
-- tabla: no importa quién escriba (sync, Excel, carga masiva, formulario, el
-- descuento de un pedido o un request directo), un producto con stock 0 no
-- puede quedar marcado Disponible.
--
--   stock null  → no se toca (no se sabe el stock; manda availability)
--   stock >= 1  → 'available'
--   stock <= 0  → 'preorder'
--   'flash'     → se conserva siempre (etiqueta de Flash Sale del Excel de
--                 inventario; el stock solo alterna available↔preorder)
create or replace function public.products_availability_from_stock()
returns trigger
language plpgsql
as $$
begin
  if new.stock is not null and coalesce(new.availability, '') <> 'flash' then
    new.availability := case when new.stock >= 1 then 'available' else 'preorder' end;
  end if;
  return new;
end;
$$;

drop trigger if exists products_availability_from_stock on public.products;
create trigger products_availability_from_stock
  before insert or update on public.products
  for each row execute function public.products_availability_from_stock();

-- ---------- 3) Guard de orders: sumar stock_applied ----------
-- Mismo trigger de 2026-07-17, ampliado: stock_applied también se blinda.
-- Sin esto, la policy vendedora_update_own_orders (update crudo sobre sus
-- propios pedidos) le permitiría a una vendedora prender/apagar la bandera a
-- mano y saltarse o duplicar el descuento de stock sin dejar rastro.
create or replace function public.orders_guard_items_edit()
returns trigger
language plpgsql
as $$
begin
  if (new.items is distinct from old.items
      or new.total is distinct from old.total
      or new.status is distinct from old.status
      or new.kind is distinct from old.kind
      or new.stock_applied is distinct from old.stock_applied)
     and coalesce(current_setting('app.allow_order_edit', true), '') <> 'on' then
    raise exception 'los pedidos solo se editan via update_order_items/update_order_status/convert_quote_to_order';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_guard_items_edit on public.orders;
create trigger orders_guard_items_edit
  before update on public.orders
  for each row execute function public.orders_guard_items_edit();

-- ---------- 4) apply_order_stock: mover el stock de un pedido ----------
-- p_direction = -1 descuenta (pedido atendido), +1 devuelve (reabierto o
-- cancelado). Helper interno, sin grant a anon/authenticated: lo llaman solo
-- update_order_status y convert_quote_to_order, ambas SECURITY DEFINER del
-- mismo dueño (mismo patrón que compute_order_items).
--
-- La disponibilidad NO se calcula acá: la deriva el trigger de arriba, así el
-- resultado es idéntico venga el cambio de stock de donde venga.
create or replace function public.apply_order_stock(
  p_order_id  uuid,
  p_direction int
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_items   jsonb;
  v_agg     jsonb;
  v_moved   jsonb;
  v_skipped jsonb;
begin
  if p_direction not in (-1, 1) then
    raise exception 'p_direction debe ser -1 (descontar) o 1 (devolver)';
  end if;

  select items into v_items from public.orders where id = p_order_id;
  if v_items is null or jsonb_typeof(v_items) <> 'array' then
    return jsonb_build_object('direction', p_direction, 'moved', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;

  -- Un pedido puede traer el mismo producto en dos líneas (la clave del
  -- carrito es id+flash: una línea de oferta y otra a precio de lista), así
  -- que se suman las cantidades por producto ANTES de tocar el stock — si no,
  -- el segundo update pisaría al primero. El filtro de formato descarta ítems
  -- malformados sin tumbar el cambio de estado del pedido.
  select coalesce(jsonb_object_agg(product_id::text, qty), '{}'::jsonb)
    into v_agg
  from (
    select (e ->> 'id')::uuid                                    as product_id,
           sum(floor((e ->> 'qty')::numeric)::int)               as qty
    from jsonb_array_elements(v_items) as e
    where e ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and e ->> 'qty' ~ '^[0-9]+(\.[0-9]+)?$'
    group by 1
  ) s
  where qty > 0;

  if v_agg = '{}'::jsonb then
    return jsonb_build_object('direction', p_direction, 'moved', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;

  -- Lo que NO se puede ajustar: producto borrado, o stock null (nunca
  -- sincronizado). Se calcula antes del update, mientras stock sigue en null.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'product_id', a.key,
               'sku',        p.sku,
               'qty',        a.value::int,
               'reason',     case when p.id is null then 'producto inexistente' else 'stock sin dato' end
             )
             order by p.sku nulls last
           ),
           '[]'::jsonb
         )
    into v_skipped
  from jsonb_each_text(v_agg) as a
  left join public.products p on p.id = a.key::uuid
  where p.id is null or p.stock is null;

  with agg as (
    select a.key::uuid as product_id, a.value::int as qty
    from jsonb_each_text(v_agg) as a
  ),
  upd as (
    update public.products p
    set stock = p.stock + (p_direction * a.qty)
    from agg a
    where p.id = a.product_id
      and p.stock is not null
    returning p.id, p.sku, a.qty, p.stock as stock_after, p.availability
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'product_id',   id,
               'sku',          sku,
               'qty',          qty,
               'stock_before', stock_after - (p_direction * qty),
               'stock_after',  stock_after,
               'availability', availability
             )
             order by sku
           ),
           '[]'::jsonb
         )
    into v_moved
  from upd;

  return jsonb_build_object(
    'direction', p_direction,
    'moved',     v_moved,
    'skipped',   v_skipped
  );
end;
$$;

revoke execute on function public.apply_order_stock(uuid, int) from public;

-- ---------- 5) update_order_status: mueve el stock además del estado ----------
-- Misma firma y mismos permisos/auditoría que 2026-07-17; lo nuevo es el
-- bloque de stock y que el retorno informa qué se movió (OrdersAdmin.jsx lo
-- muestra al confirmar).
create or replace function public.update_order_status(
  p_order_id uuid,
  p_status   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders%rowtype;
  v_client  public.clients%rowtype;
  v_email   text;
  v_stock   jsonb   := null;
  v_applied boolean;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  if p_status not in ('new', 'done', 'cancelled') then
    raise exception 'estado inválido';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'pedido no encontrado';
  end if;

  select * into v_client from public.clients where id = v_order.client_id;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso para modificar este pedido';
  end if;

  if v_order.status = p_status then
    return jsonb_build_object('ok', true, 'status', p_status,
                              'stock_applied', coalesce(v_order.stock_applied, false));
  end if;

  -- Stock (2026-08-04): solo pedidos reales. Atendido descuenta; salir de
  -- Atendido (reabrir/cancelar) devuelve. La bandera stock_applied — no el
  -- estado — es la que evita descontar dos veces.
  v_applied := coalesce(v_order.stock_applied, false);
  if v_order.kind = 'order' then
    if p_status = 'done' and not v_applied then
      v_stock   := public.apply_order_stock(p_order_id, -1);
      v_applied := true;
    elsif p_status <> 'done' and v_applied then
      v_stock   := public.apply_order_stock(p_order_id, 1);
      v_applied := false;
    end if;
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('update_order_status', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object('from_status', v_order.status, 'to_status', p_status)
       || case when v_stock is null then '{}'::jsonb else jsonb_build_object('stock', v_stock) end);

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set status = p_status, stock_applied = v_applied
  where id = p_order_id;

  return jsonb_build_object(
    'ok',            true,
    'status',        p_status,
    'stock_applied', v_applied,
    'stock',         v_stock
  );
end;
$$;

revoke execute on function public.update_order_status(uuid, text) from public;
grant execute on function public.update_order_status(uuid, text) to authenticated;

-- ---------- 6) convert_quote_to_order: caso cotización ya atendida ----------
-- Igual que 2026-07-17, más un borde: una cotización nunca descuenta stock,
-- así que si la que se está convirtiendo YA estaba marcada Atendida, el
-- descuento tiene que pasar acá mismo (si no, ese pedido quedaría done sin
-- haber descontado nunca). El camino normal — cotización nueva → pedido nuevo
-- → Atendido — sigue descontando en update_order_status.
create or replace function public.convert_quote_to_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order     public.orders%rowtype;
  v_client    public.clients%rowtype;
  v_list_code text;
  v_result    jsonb;
  v_email     text;
  v_stock     jsonb   := null;
  v_applied   boolean;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'pedido no encontrado';
  end if;

  select * into v_client from public.clients where id = v_order.client_id;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso para modificar este pedido';
  end if;

  if v_order.kind <> 'quote' then
    raise exception 'solo se pueden convertir cotizaciones';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'no se puede convertir una cotización cancelada';
  end if;

  select code into v_list_code from public.price_lists where id = v_client.price_list_id;
  if v_list_code = 'quote' then
    raise exception 'asigná una lista de precio real al cliente antes de convertir la cotización en pedido';
  end if;

  v_result := public.compute_order_items(v_client.id, v_order.items, 'order');

  -- La conversión recalcula precios, no productos ni cantidades, así que
  -- apply_order_stock puede leer los ítems ya guardados (el update de abajo
  -- deja los mismos id/qty) sin cambiar el resultado.
  v_applied := coalesce(v_order.stock_applied, false);
  if v_order.status = 'done' and not v_applied then
    v_stock   := public.apply_order_stock(p_order_id, -1);
    v_applied := true;
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('convert_quote_to_order', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object(
       'items', v_result->'items',
       'total', v_result->'total'
     )
       || case when v_stock is null then '{}'::jsonb else jsonb_build_object('stock', v_stock) end);

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set kind          = 'order',
      items         = v_result->'items',
      total         = (v_result->>'total')::numeric,
      stock_applied = v_applied
  where id = p_order_id;

  return v_result || jsonb_build_object('stock_applied', v_applied, 'stock', v_stock);
end;
$$;

revoke execute on function public.convert_quote_to_order(uuid) from public;
grant execute on function public.convert_quote_to_order(uuid) to authenticated;

-- ---------- Selects de prueba (comentados) ----------
-- Correr a mano en el SQL Editor antes de dar por buena la migración.
--
-- 0) Producto de prueba con stock conocido:
-- insert into public.products (sku, name, stock) values ('STK-TEST', 'Test stock', 20);
-- select sku, stock, availability from public.products where sku = 'STK-TEST';
-- -- Esperado: stock 20, availability 'available' (lo puso el trigger).
--
-- 1) El trigger manda sobre la disponibilidad escrita a mano:
-- update public.products set stock = 0, availability = 'available' where sku = 'STK-TEST';
-- select sku, stock, availability from public.products where sku = 'STK-TEST';
-- -- Esperado: availability 'preorder' aunque el update pidió 'available'.
--
-- 2) Y vuelve solo a Disponible cuando entra stock:
-- update public.products set stock = 7 where sku = 'STK-TEST';
-- select sku, stock, availability from public.products where sku = 'STK-TEST';
-- -- Esperado: 'available'.
--
-- 3) 'flash' se conserva con stock 0:
-- update public.products set availability = 'flash', stock = 0 where sku = 'STK-TEST';
-- select sku, stock, availability from public.products where sku = 'STK-TEST';
-- -- Esperado: 'flash' (el stock solo alterna available↔preorder).
--
-- 4) Descuento por pedido atendido (usar un pedido real kind='order'):
-- select public.update_order_status('<order_id>', 'done');
-- -- Debe devolver stock_applied = true y un objeto 'stock' con moved/skipped;
-- -- products.stock de cada ítem baja por su qty y el que llegue a 0 pasa a
-- -- 'preorder'. En admin_audit_log queda la fila con detail->'stock'.
--
-- 5) Idempotencia: volver a marcar Atendido no descuenta de nuevo:
-- select public.update_order_status('<order_id>', 'new');   -- devuelve el stock
-- select public.update_order_status('<order_id>', 'done');  -- lo descuenta otra vez
-- select public.update_order_status('<order_id>', 'done');  -- no-op, sin movimiento
--
-- 6) Una cotización no toca el stock:
-- select public.update_order_status('<quote_order_id>', 'done');
-- -- Debe devolver 'stock': null y no cambiar ningún products.stock.
--
-- 7) La bandera no se puede tocar a mano:
-- update public.orders set stock_applied = false where id = '<order_id>';
-- -- Debe fallar con "los pedidos solo se editan via update_order_items/...".
--
-- Limpieza:
-- delete from public.products where sku = 'STK-TEST';
