-- 2026-08-26: fix — apply_order_stock nunca existió en producción.
--
-- Incidente: una vendedora convirtió una cotización YA MARCADA ATENDIDA en
-- pedido y el panel mostró "function public.apply_order_stock(uuid, integer)
-- does not exist".
--
-- Causa raíz: migration-2026-08-04-order-stock.sql NUNCA se corrió en
-- producción. La auditoría del 2026-08-12 la marcó como corrida usando
-- "orders.stock_applied existe" como evidencia, pero esa columna también la
-- crea migration-2026-08-05-order-capture.sql (add column if not exists), que
-- sí corrió — la evidencia probaba la migración equivocada. Encima quedó
-- latente: migration-2026-08-06-require-price.sql (sí corrida) reescribió
-- convert_quote_to_order llamando a apply_order_stock, pero PL/pgSQL solo
-- resuelve la llamada cuando la rama se ejecuta — y esa rama solo corre al
-- convertir una cotización con status = 'done' y stock_applied = false. Hoy
-- fue la primera vez que alguien pasó por ahí.
--
-- Estado real de producción verificado el 2026-08-26 con
-- `supabase db query --linked`:
--   * apply_order_stock                    → NO existe (esto rompe convert)
--   * update_order_status                  → versión 2026-07-17, SIN stock: o
--     sea que "Marcar atendido" NUNCA descontó stock en producción (nadie lo
--     notó porque el sync de n8n pisa products.stock con SellerCloud igual)
--   * convert_quote_to_order               → versión 2026-08-06 (la vigente,
--     llama a apply_order_stock) — NO se toca acá
--   * orders.stock_applied, guard trigger  → presentes (via 08-05)
--   * products_availability_from_stock     → versión ampliada 2026-08-12
--     (deactivated_by_stock) — NO se toca acá
--
-- OJO — NO re-correr migration-2026-08-04-order-stock.sql para arreglar esto:
-- su §2 pisaría el trigger de disponibilidad con la versión vieja (perdería
-- la desactivación por stock 0 del 08-12) y su §6 pisaría
-- convert_quote_to_order con una versión anterior a require-price (08-06).
-- Esta migración trae SOLO las dos piezas que faltan, copiadas de schema.sql
-- (que ya era la versión canónica de ambas).
--
-- Idempotente, se puede re-correr. lock_timeout corto para fallar rápido y
-- limpio si un lock se traba contra producción.
set lock_timeout = '10s';

-- ---------- 0) Preflight ----------
-- Corta en seco si falta algo de lo que estas dos funciones asumen (todo
-- verificado presente en producción el 2026-08-26; esto protege una corrida
-- futura en otro entorno).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'stock_applied'
  ) then
    raise exception 'falta orders.stock_applied — correr migration-2026-08-05-order-capture.sql antes';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products'
      and column_name = 'stock'
  ) then
    raise exception 'falta products.stock — correr migration-2026-07-14-inventory-stock.sql antes';
  end if;
  if to_regprocedure('public.is_vendedora()') is null then
    raise exception 'falta is_vendedora() — correr el schema base antes';
  end if;
  if to_regclass('public.admin_audit_log') is null then
    raise exception 'falta admin_audit_log — correr migration-2026-07-14-client-admin-actions.sql antes';
  end if;
end $$;

-- ---------- 1) apply_order_stock: mover el stock de un pedido ----------
-- Idéntica a schema.sql / migration-2026-08-04-order-stock.sql §4.
-- p_direction = -1 descuenta (pedido atendido), +1 devuelve (reabierto o
-- cancelado). Helper interno, sin grant a anon/authenticated: lo llaman solo
-- update_order_status y convert_quote_to_order, ambas SECURITY DEFINER del
-- mismo dueño (mismo patrón que compute_order_items).
--
-- La disponibilidad NO se calcula acá: la deriva el trigger
-- products_availability_from_stock, así el resultado es idéntico venga el
-- cambio de stock de donde venga.
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

-- ---------- 2) update_order_status: mueve el stock además del estado ----------
-- Idéntica a schema.sql / migration-2026-08-04-order-stock.sql §5. Reemplaza
-- la versión 2026-07-17 que seguía viva en producción (solo cambiaba el
-- estado): ahora Atendido descuenta stock, reabrir/cancelar lo devuelve, y la
-- bandera orders.stock_applied — no el estado — evita descontar dos veces.
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

-- ---------- Selects de prueba (comentados) ----------
-- Correr a mano en el SQL Editor después de la migración.
--
-- 1) Las dos funciones existen y con la firma correcta:
-- select p.proname, pg_get_function_identity_arguments(p.oid)
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname in ('apply_order_stock', 'update_order_status');
-- -- Esperado: 2 filas.
--
-- 2) La versión nueva de update_order_status quedó viva (mueve stock):
-- select prosrc like '%apply_order_stock%' as ok
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'update_order_status';
-- -- Esperado: true.
--
-- 3) Reintentar la conversión que falló hoy (desde el panel, la misma
--    cotización atendida): debe convertir y descontar stock. En
--    admin_audit_log la fila 'convert_quote_to_order' trae detail->'stock'
--    con moved/skipped.
--
-- OJO al dar por bueno el punto 3: los pedidos kind='order' marcados
-- Atendido ANTES de esta migración tienen stock_applied = false (la versión
-- vieja nunca descontó). NO hay que "corregirlos" descontando retroactivo:
-- el sync de n8n ya pisó products.stock con el valor real de SellerCloud
-- varias veces desde entonces. Reabrirlos tampoco devuelve nada (la bandera
-- en false lo impide), que es exactamente lo correcto.
