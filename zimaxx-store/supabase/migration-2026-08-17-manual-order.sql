-- ============================================================
-- 2026-08-17: cargar a mano el pedido que llegó por WhatsApp y no al sistema
--
-- Contexto (a pedido del usuario). Hasta acá había dos redes:
--   * el pedido que LLEGA y el servidor rechaza → `order_failures` + botón
--     "Recuperar" en Pedidos (2026-08-05);
--   * el pedido que no llega por un problema de transporte → el pendiente que
--     guarda el navegador y reintenta al volver (2026-08-17, orderOutbox.js).
-- Queda un caso que ninguna de las dos cubre: el cliente **nunca vuelve** al
-- catálogo. Ahí el único rastro del pedido es el mensaje que la vendedora
-- tiene en el chat. Esto convierte ese mensaje en un pedido: se pega el texto
-- en el panel, se cruzan los productos por nombre y se crea.
--
-- Dos funciones, las dos delgadas sobre `compute_order_items` — o sea que el
-- precio y el total los calcula el servidor con la lista del cliente, igual
-- que en cualquier alta. Lo que diga el mensaje sobre precios NO se usa: la
-- vendedora lo ve al lado del vigente, nada más.
--   * preview_manual_order → arma el pedido y lo devuelve SIN guardar nada,
--     para revisarlo en pantalla. Existe porque una vendedora no puede leer
--     `product_prices` de una lista con dueñas: si el precio lo calculara el
--     navegador, la previsualización saldría vacía justo para ella.
--   * create_manual_order  → lo guarda y lo audita.
--
-- Permiso: admin (cualquier cliente) o vendedora (solo los suyos), el mismo
-- criterio de update_order_items. Idempotente por p_request_id, como
-- create_order: un doble click no crea dos pedidos.
--
-- Idempotente, se puede re-correr.
-- ============================================================
set lock_timeout = '10s';

-- ---------- 0) Preflight ----------
-- Corta antes de tocar nada si falta algo que esto da por hecho, en vez de
-- dejar la base a medias (mismo criterio que las migraciones de 2026-08-05).
do $$
begin
  if to_regprocedure('public.compute_order_items(uuid, jsonb, text)') is null then
    raise exception using message =
      'Falta compute_order_items: corré primero migration-2026-07-17-orders-edit-live-quotes.sql';
  end if;
  if to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.is_vendedora()') is null
     or to_regprocedure('public.current_vendedora_id()') is null then
    raise exception using message = 'Faltan is_admin()/is_vendedora()/current_vendedora_id()';
  end if;
  if to_regclass('public.order_failures') is null then
    raise exception using message =
      'Falta order_failures: corré primero migration-2026-08-05-order-capture.sql';
  end if;
end $$;

-- `orders.request_id` y `admin_audit_log.order_id` los crea
-- migration-2026-08-05-order-capture.sql; se repiten con `if not exists` para
-- que esto funcione igual si aquella nunca corrió (mismo criterio que ella).
alter table public.orders
  add column if not exists request_id uuid;

create unique index if not exists orders_request_id_key
  on public.orders (request_id) where request_id is not null;

alter table public.admin_audit_log
  add column if not exists order_id uuid;

-- ---------- 1) Helper de permiso ----------
-- Devuelve el cliente si quien llama puede cargarle un pedido, o corta.
-- Helper interno: sin grant a authenticated, igual que compute_order_items y
-- apply_order_stock — lo llaman solo las dos funciones de abajo, que son
-- SECURITY DEFINER del mismo dueño.
create or replace function public.manual_order_client(p_client_id uuid)
returns public.clients
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients%rowtype;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'cliente no encontrado';
  end if;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso para cargar pedidos de este cliente';
  end if;

  return v_client;
end;
$$;

revoke execute on function public.manual_order_client(uuid) from public;

-- ---------- 2) Armado en seco ----------
-- Mismo cálculo que el alta, pero sin escribir. Devuelve, además de los ítems
-- con su precio vigente y el total:
--   * `dropped`  → los ids que se cayeron en compute_order_items (producto
--                  apagado a mano o borrado). Se informan porque una línea
--                  que desaparece en silencio ya costó un pedido en este
--                  proyecto: la vendedora tiene que verlo antes de guardar.
--   * `no_price` → los SKU sin precio en la lista del cliente. Con esos el
--                  alta se rechaza (misma regla que create_order desde
--                  migration-2026-08-06-require-price.sql), así que conviene
--                  saberlo en la pantalla de revisión y no al confirmar.
create or replace function public.preview_manual_order(
  p_client_id uuid,
  p_items     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   public.clients%rowtype;
  v_code     text;
  v_kind     text;
  v_result   jsonb;
  v_items    jsonb;
  v_dropped  jsonb;
  v_no_price jsonb;
begin
  v_client := public.manual_order_client(p_client_id);

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'no hay ítems para armar el pedido';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'demasiadas líneas: % (el tope es 1000)', jsonb_array_length(p_items);
  end if;

  select code into v_code from public.price_lists where id = v_client.price_list_id;
  -- Igual que create_order: la lista 'quote' manda. Acá no hay un p_kind que
  -- pueda pedir otra cosa — el tipo lo decide el cliente, no quien carga.
  v_kind := case when v_code = 'quote' then 'quote' else 'order' end;

  v_result := public.compute_order_items(v_client.id, p_items, v_kind);
  v_items  := v_result->'items';

  select coalesce(jsonb_agg(e->>'id'), '[]'::jsonb)
    into v_dropped
  from jsonb_array_elements(p_items) e
  where (e->>'id') is not null
    and not exists (
      select 1 from jsonb_array_elements(v_items) k where k->>'id' = e->>'id'
    );

  select coalesce(jsonb_agg(e->>'sku' order by e->>'sku'), '[]'::jsonb)
    into v_no_price
  from jsonb_array_elements(v_items) e
  where v_kind = 'order' and e->>'price' is null;

  return jsonb_build_object(
    'kind',        v_kind,
    'client_name', v_client.name,
    'items',       v_items,
    'total',       v_result->'total',
    'dropped',     v_dropped,
    'no_price',    v_no_price
  );
end;
$$;

revoke execute on function public.preview_manual_order(uuid, jsonb) from public;
grant execute on function public.preview_manual_order(uuid, jsonb) to authenticated;

-- ---------- 3) Alta ----------
create or replace function public.create_manual_order(
  p_client_id  uuid,
  p_items      jsonb,
  p_request_id uuid default null,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   public.clients%rowtype;
  v_code     text;
  v_kind     text;
  v_result   jsonb;
  v_items    jsonb;
  v_order_id uuid;
  v_no_price text;
  v_email    text;
begin
  v_client := public.manual_order_client(p_client_id);

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'no hay ítems para crear el pedido';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'demasiadas líneas: % (el tope es 1000)', jsonb_array_length(p_items);
  end if;

  -- Doble click, o la pantalla que reintenta después de perder la respuesta:
  -- devuelve el pedido que ya se creó en vez de otro igual. Mismo mecanismo
  -- que create_order (índice único sobre orders.request_id).
  if p_request_id is not null then
    select id into v_order_id from public.orders where request_id = p_request_id;
    if found then
      return jsonb_build_object('order_id', v_order_id, 'already_existed', true);
    end if;
  end if;

  select code into v_code from public.price_lists where id = v_client.price_list_id;
  v_kind := case when v_code = 'quote' then 'quote' else 'order' end;

  v_result := public.compute_order_items(v_client.id, p_items, v_kind);
  v_items  := v_result->'items';

  if jsonb_array_length(v_items) = 0 then
    raise exception 'ningún ítem válido: los productos están inactivos o ya no existen';
  end if;

  -- Misma regla que create_order (migration-2026-08-06-require-price.sql): un
  -- pedido real con una línea sin precio no se guarda. Acá el mensaje del
  -- error sí importa — del otro lado hay una persona que puede cargar el
  -- precio y volver a intentar, no un cliente al que no se le explica nada.
  if v_kind = 'order' then
    select string_agg(e->>'sku', ', ' order by e->>'sku')
      into v_no_price
    from jsonb_array_elements(v_items) e
    where e->>'price' is null;

    if v_no_price is not null then
      raise exception 'sin precio en la lista del cliente: %', v_no_price;
    end if;
  end if;

  begin
    insert into public.orders (client_id, items, total, kind, request_id)
    values (v_client.id, v_items, (v_result->>'total')::numeric, v_kind, p_request_id)
    returning id into v_order_id;
  exception when unique_violation then
    -- Carrera entre dos envíos con el mismo request_id: gana el primero.
    select id into v_order_id from public.orders where request_id = p_request_id;
    return jsonb_build_object('order_id', v_order_id, 'already_existed', true);
  end;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('create_manual_order', auth.uid(), v_email, v_client.id, v_client.name, v_order_id,
     jsonb_build_object(
       'kind',       v_kind,
       'items',      v_items,
       'total',      v_result->'total',
       'line_count', jsonb_array_length(v_items),
       -- El mensaje pegado, tal cual llegó: es la prueba de dónde salió este
       -- pedido si mañana alguien pregunta por qué está cargado a mano.
       'source_message', p_note
     ));

  return jsonb_build_object(
    'order_id',        v_order_id,
    'kind',            v_kind,
    'total',           v_result->'total',
    'items',           v_items,
    'already_existed', false
  );
end;
$$;

revoke execute on function public.create_manual_order(uuid, jsonb, uuid, text) from public;
grant execute on function public.create_manual_order(uuid, jsonb, uuid, text) to authenticated;

-- ---------- Comprobación rápida (opcional, no escribe nada) ----------
-- select public.preview_manual_order(
--   (select id from public.clients limit 1),
--   jsonb_build_array(jsonb_build_object(
--     'id', (select id from public.products where active limit 1), 'qty', 2, 'flash', false))
-- );
