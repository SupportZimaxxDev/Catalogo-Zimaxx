-- 2026-07-17: edición auditada de pedidos + cotizaciones con precio
-- vigente (no congelado).
--
-- A pedido del usuario:
-- 1) Una vendedora (no solo el admin) puede editar los ítems de un
--    pedido una vez que llega a la sección Pedidos, y esa edición queda
--    auditada en admin_audit_log (acción 'edit_order_items') sí o sí —
--    un trigger en `orders` bloquea cualquier update directo de
--    items/total que no pase por la RPC update_order_items.
-- 2) El carrito del cliente (CartDrawer) ahora también registra un
--    pedido con kind = 'quote' cuando el cliente descarga el PDF (antes
--    "Descargar PDF" no tocaba la base — solo "Enviar pedido por
--    WhatsApp" lo hacía). Esto reutiliza create_order con
--    p_kind = 'quote' explícito, sin cambios de código acá (ya soportado
--    por la firma existente).
-- 3) Todas las cotizaciones (kind = 'quote', sin importar si vienen de un
--    cliente con lista 'quote' o de un cliente con lista real que pidió
--    PDF) se muestran en el panel con el precio VIGENTE del producto, no
--    el que tenía al momento de pedirla — get_quotes_live_pricing lo
--    recalcula al vuelo.
--
-- Aplicar en el SQL Editor de Supabase, de una sola vez (todo
-- idempotente, se puede re-correr sin romper nada).

-- ---------- 1) admin_audit_log: order_id ----------
alter table public.admin_audit_log add column if not exists order_id uuid;
create index if not exists admin_audit_log_order_idx
  on public.admin_audit_log (order_id) where order_id is not null;

-- ---------- 2) trigger: blindar items/total/status/kind de orders ----------
-- Blinda las 4 columnas que hoy se escriben desde RPC auditadas (2026-07-17,
-- segunda pasada del mismo día: originalmente solo cubría items/total —
-- se suma status/kind porque marcar atendido/cancelar/reabrir y convertir
-- una cotización en pedido también tienen que quedar auditados, y
-- `vendedora_update_own_orders` le da a una vendedora `update` crudo
-- sobre sus propios pedidos sin distinguir columna).
create or replace function public.orders_guard_items_edit()
returns trigger
language plpgsql
as $$
begin
  if (new.items is distinct from old.items
      or new.total is distinct from old.total
      or new.status is distinct from old.status
      or new.kind is distinct from old.kind)
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

-- ---------- 3) helper: compute_order_items ----------
-- Factorizado del cuerpo que antes tenía create_order, para reusarlo acá
-- y en update_order_items/get_quotes_live_pricing. SECURITY INVOKER: solo
-- la llaman otras funciones SECURITY DEFINER (mismo dueño), nunca
-- directo anon/authenticated.
create or replace function public.compute_order_items(
  p_client_id uuid,
  p_items     jsonb,
  p_kind      text
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_client    public.clients%rowtype;
  v_item      jsonb;
  v_id        uuid;
  v_qty       int;
  v_flash     boolean;
  v_product   public.products%rowtype;
  v_price     numeric;
  v_items     jsonb   := '[]'::jsonb;
  v_total     numeric := 0;
  v_has_price boolean := false;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    return jsonb_build_object('items', '[]'::jsonb, 'total', null);
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_id    := (v_item->>'id')::uuid;
      v_qty   := floor((v_item->>'qty')::numeric)::int;
      v_flash := coalesce((v_item->>'flash')::boolean, false);
    exception when others then
      continue;
    end;
    if v_qty is null or v_qty < 1 then continue; end if;
    if v_qty > 9999 then v_qty := 9999; end if;

    select * into v_product from public.products where id = v_id and active;
    if not found then continue; end if;

    v_price := null;
    if p_kind = 'order' then
      if v_flash then
        select fs.price into v_price
        from public.flash_sales fs
        where fs.product_id = v_id
          and fs.active
          and now() >= fs.starts_at
          and now() < fs.expires_at
        order by fs.price
        limit 1;
      end if;
      if v_price is null then
        select pp.price into v_price
        from public.product_prices pp
        where pp.product_id = v_id
          and pp.price_list_id = v_client.price_list_id;
      end if;
    end if;

    v_items := v_items || jsonb_build_object(
      'id',    v_product.id,
      'sku',   v_product.sku,
      'name',  v_product.name,
      'qty',   v_qty,
      'price', v_price,
      'flash', v_flash
    );
    if v_price is not null then
      v_total     := v_total + v_price * v_qty;
      v_has_price := true;
    end if;
  end loop;

  return jsonb_build_object(
    'items', v_items,
    'total', case when p_kind = 'order' and v_has_price then round(v_total, 2) else null end
  );
end;
$$;

revoke execute on function public.compute_order_items(uuid, jsonb, text) from public;

-- ---------- 4) create_order: ahora usa el helper ----------
-- Mismo comportamiento externo (firma y semántica intactas), cuerpo
-- reescrito para llamar a compute_order_items en vez de repetir la
-- lógica de precios.
create or replace function public.create_order(
  p_token text,
  p_items jsonb,
  p_total numeric,
  p_kind  text default 'order'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client    public.clients%rowtype;
  v_list_code text;
  v_kind      text;
  v_result    jsonb;
  v_items     jsonb;
  v_order_id  uuid;
begin
  select * into v_client from public.clients where token = p_token;
  if not found then
    return null;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 200 then
    return null;
  end if;

  select code into v_list_code from public.price_lists where id = v_client.price_list_id;
  v_kind := case when v_list_code = 'quote' or p_kind = 'quote' then 'quote' else 'order' end;

  v_result := public.compute_order_items(v_client.id, p_items, v_kind);
  v_items  := v_result->'items';

  if jsonb_array_length(v_items) = 0 then
    return null;
  end if;

  insert into public.orders (client_id, items, total, kind)
  values (v_client.id, v_items, (v_result->>'total')::numeric, v_kind)
  returning id into v_order_id;

  return v_order_id;
end;
$$;

revoke execute on function public.create_order(text, jsonb, numeric, text) from public;
grant execute on function public.create_order(text, jsonb, numeric, text) to anon, authenticated;

-- ---------- 5) update_order_items: edición auditada ----------
create or replace function public.update_order_items(
  p_order_id uuid,
  p_items    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  public.orders%rowtype;
  v_client public.clients%rowtype;
  v_result jsonb;
  v_email  text;
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
    raise exception 'no tenés permiso para editar este pedido';
  end if;

  -- Solo se editan cotizaciones (2026-07-17, a pedido del usuario: un
  -- pedido real ya confirmado no se toca desde acá) y solo mientras
  -- siguen 'new' — una vez atendida o cancelada, tampoco se edita.
  if v_order.kind <> 'quote' then
    raise exception 'solo se pueden editar cotizaciones';
  end if;
  if v_order.status <> 'new' then
    raise exception 'solo se pueden editar cotizaciones nuevas';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 200 then
    raise exception 'items inválidos';
  end if;

  v_result := public.compute_order_items(v_client.id, p_items, v_order.kind);

  if jsonb_array_length(v_result->'items') = 0 then
    raise exception 'el pedido debe tener al menos un producto válido';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('edit_order_items', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object(
       'before_items', v_order.items,
       'before_total', v_order.total,
       'after_items',  v_result->'items',
       'after_total',  v_result->'total'
     ));

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set items = v_result->'items', total = (v_result->>'total')::numeric
  where id = p_order_id;

  return v_result;
end;
$$;

revoke execute on function public.update_order_items(uuid, jsonb) from public;
grant execute on function public.update_order_items(uuid, jsonb) to authenticated;

-- ---------- 5b) update_order_status: cambio de estado auditado ----------
-- Antes "Marcar atendido"/"Cancelar"/"Reabrir" hacían un update directo
-- (`vendedora_update_own_orders` ya lo permitía) sin dejar rastro. A
-- pedido del usuario, ahora queda auditado igual que la edición de
-- ítems.
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
  v_order  public.orders%rowtype;
  v_client public.clients%rowtype;
  v_email  text;
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
    return jsonb_build_object('ok', true, 'status', p_status);
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('update_order_status', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object('from_status', v_order.status, 'to_status', p_status));

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders set status = p_status where id = p_order_id;

  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

revoke execute on function public.update_order_status(uuid, text) from public;
grant execute on function public.update_order_status(uuid, text) to authenticated;

-- ---------- 5c) convert_quote_to_order: cerrar una cotización como pedido real ----------
-- A pedido del usuario: una cotización se puede "convertir" en pedido
-- real. A diferencia de una cotización (que nunca congela precio, ver
-- get_quotes_live_pricing), un pedido SÍ lo congela — desde acá en
-- adelante ya no se sigue ajustando a cambios de precio futuros.
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

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('convert_quote_to_order', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object(
       'items', v_result->'items',
       'total', v_result->'total'
     ));

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set kind = 'order', items = v_result->'items', total = (v_result->>'total')::numeric
  where id = p_order_id;

  return v_result;
end;
$$;

revoke execute on function public.convert_quote_to_order(uuid) from public;
grant execute on function public.convert_quote_to_order(uuid) to authenticated;

-- ---------- 6) get_quotes_live_pricing: precio vigente para cotizaciones ----------
create or replace function public.get_quotes_live_pricing(p_order_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean := public.is_admin();
  v_vend_id  uuid    := public.current_vendedora_id();
  v_result   jsonb   := '{}'::jsonb;
  v_order    public.orders%rowtype;
  v_client   public.clients%rowtype;
  v_priced   jsonb;
begin
  if not (v_is_admin or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  for v_order in
    select * from public.orders where id = any(p_order_ids) and kind = 'quote'
  loop
    select * into v_client from public.clients where id = v_order.client_id;
    if not found then continue; end if;
    if not v_is_admin and v_client.vendedora_id is distinct from v_vend_id then
      continue;
    end if;

    v_priced := public.compute_order_items(v_client.id, v_order.items, 'order');
    v_result := v_result || jsonb_build_object(v_order.id::text, v_priced);
  end loop;

  return v_result;
end;
$$;

revoke execute on function public.get_quotes_live_pricing(uuid[]) from public;
grant execute on function public.get_quotes_live_pricing(uuid[]) to authenticated;

-- ---------- Selects de prueba (comentados) ----------
-- Correr a mano en el SQL Editor antes de dar por buena la migración.
--
-- 1) Editar una cotización nueva propia (como la vendedora dueña, o como admin):
-- select public.update_order_items(
--   '<quote_order_id>',
--   '[{"id": "<product_id>", "qty": 3, "flash": false}]'::jsonb
-- );
-- -- Debe devolver {items:[...], total:...} y sumar una fila en
-- -- admin_audit_log con action = 'edit_order_items'.
--
-- 2) Confirmar que un pedido real (kind='order') no se puede editar:
-- select public.update_order_items('<order_kind_order_id>', '[]'::jsonb);
-- -- Debe fallar con "solo se pueden editar cotizaciones".
--
-- 3) Confirmar el bloqueo de update directo (items/total/status/kind):
-- update public.orders set items = '[]'::jsonb where id = '<order_id>';
-- update public.orders set status = 'done' where id = '<order_id>';
-- -- Ambos deben fallar con "los pedidos solo se editan via update_order_items/...".
--
-- 4) Cambiar estado auditado:
-- select public.update_order_status('<order_id>', 'done');
-- -- Debe sumar una fila en admin_audit_log con action = 'update_order_status'.
--
-- 5) Convertir una cotización en pedido:
-- select public.convert_quote_to_order('<quote_order_id>');
-- -- El pedido debe quedar con kind='order' y precio congelado; sumar una
-- -- fila en admin_audit_log con action = 'convert_quote_to_order'.
--
-- 6) Precio vigente de una cotización:
-- select public.get_quotes_live_pricing(array['<quote_order_id>']::uuid[]);
-- -- Cambiar el precio del producto en product_prices y volver a correr:
-- -- el total tiene que reflejar el nuevo precio, no el guardado en orders.items.
