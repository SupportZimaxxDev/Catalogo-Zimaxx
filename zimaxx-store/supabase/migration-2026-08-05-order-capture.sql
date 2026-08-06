-- 2026-08-05: un pedido grande se envió por WhatsApp pero NO quedó registrado.
--
-- Qué pasó (diagnosticado y reproducido en un Postgres local con este mismo
-- schema): create_order rechazaba cualquier pedido de más de 200 líneas
-- distintas con un `return null` mudo. El frontend no bloquea el envío por
-- WhatsApp cuando el registro falla, así que la vendedora recibió el mensaje
-- completo con los productos y el cliente vio el ✓ de "pedido enviado" — pero
-- en la base no entró nada. Y como el rechazo es determinista, el segundo
-- intento del cliente falló idéntico.
--
-- El tope no tenía nada que ver con el monto: por eso pedidos MÁS caros sí
-- entraban (pocas referencias × mucha cantidad) y este de ~10k no (muchas
-- referencias × 1-2 unidades, el cliente que recorre el catálogo entero).
--
-- Medido con 4000 productos y precios cargados (compute_order_items, que es
-- el loop caro; el INSERT es despreciable al lado):
--
--     200 líneas →    48 ms        2000 líneas →  2421 ms
--     500 líneas →   232 ms        4000 líneas →  9782 ms
--    1000 líneas →   651 ms
--
-- O sea que el tope no se puede simplemente sacar: el costo crece
-- superlineal (el acumulador `v_items := v_items || ...` copia el jsonb
-- entero en cada vuelta, O(n²)), y pasando las ~2000 líneas se choca con el
-- statement_timeout que Supabase le pone al rol anon — volveríamos al mismo
-- fallo silencioso por otra puerta. 1000 deja 5x de aire sobre el caso real
-- que falló y se resuelve en ~0.65 s, bien lejos del timeout.
--
-- Tres cambios, entonces:
--   1) El tope pasa de 200 a 1000 líneas.
--   2) Todo rechazo deja rastro en order_failures (con el payload, para poder
--      recuperar el pedido perdido en vez de pedirle al cliente que lo rearme).
--      Sin esto no había forma de saber qué había pasado: el único registro
--      era un console.warn en el teléfono del cliente.
--   3) orders.request_id + índice único: el navegador manda un id por carrito,
--      así reintentar (a mano o automático) devuelve el pedido ya guardado en
--      vez de duplicarlo. Hace falta porque CartDrawer.jsx ahora sí reintenta.
--
-- Idempotente, se puede re-correr. lock_timeout corto para fallar rápido y
-- limpio si un lock se traba contra producción.
set lock_timeout = '10s';

-- ---------- 0) Preflight ----------
-- Corta antes de tocar nada si falta lo que esta migración da por hecho, en
-- vez de dejar la base a medias (mismo criterio que
-- migration-2026-08-05-superadmin.sql). compute_order_items lo usan la
-- create_order nueva y recover_order_failure.
do $$
begin
  if to_regprocedure('public.compute_order_items(uuid, jsonb, text)') is null then
    raise exception using message =
      'Falta compute_order_items: corré primero migration-2026-07-17-orders-edit-live-quotes.sql';
  end if;
  if to_regprocedure('public.is_vendedora()') is null
     or to_regprocedure('public.current_vendedora_id()') is null then
    raise exception using message =
      'Faltan is_vendedora()/current_vendedora_id(): corré primero las migraciones del rol vendedora';
  end if;
end $$;

-- Columnas de migraciones anteriores que esta da por hechas, repetidas con
-- `if not exists` para que funcione igual si aquellas nunca corrieron (mismo
-- criterio que migration-2026-08-04-order-stock.sql con products.stock):
--   * orders.stock_applied lo nombra el trigger orders_guard_items_edit que se
--     reescribe más abajo — sin la columna, el trigger compila igual pero
--     revienta en el primer UPDATE a orders con "record new has no field".
--   * admin_audit_log.order_id lo escribe recover_order_failure.
alter table public.orders
  add column if not exists stock_applied boolean not null default false;

alter table public.admin_audit_log
  add column if not exists order_id uuid;

-- ---------- 1) Idempotencia del alta ----------
-- El navegador genera un uuid por carrito y lo manda en cada intento de ese
-- mismo pedido. Null en los pedidos viejos y en los que llegan de un frontend
-- sin actualizar (el índice es parcial justamente por eso: sin `where ... is
-- not null` un segundo pedido sin request_id chocaría contra el primero).
alter table public.orders
  add column if not exists request_id uuid;

create unique index if not exists orders_request_id_key
  on public.orders (request_id) where request_id is not null;

-- ---------- 2) Guard de orders: sumar request_id ----------
-- Mismo trigger de 2026-07-17 (ampliado con stock_applied el 2026-08-04), más
-- request_id: si se pudiera reescribir a mano, se podría romper la idempotencia
-- de arriba — colgarle a un pedido el request_id de otro para que el reintento
-- del cliente devuelva el pedido equivocado.
create or replace function public.orders_guard_items_edit()
returns trigger
language plpgsql
as $$
begin
  if (new.items is distinct from old.items
      or new.total is distinct from old.total
      or new.status is distinct from old.status
      or new.kind is distinct from old.kind
      or new.stock_applied is distinct from old.stock_applied
      or new.request_id is distinct from old.request_id)
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

-- ---------- 3) order_failures: los pedidos que NO entraron ----------
-- Un pedido rechazado desaparecía sin dejar nada. Ahora queda acá con el
-- payload, así que se puede ver qué pidió el cliente y recuperarlo.
--
-- `items` se guarda solo cuando el token era válido (cliente real). Con un
-- token inválido se registra únicamente el motivo y el conteo: si no, alguien
-- con la anon key podría inflar la tabla mandando payloads enormes a repetición.
create table if not exists public.order_failures (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references public.clients (id) on delete set null,
  token_hint  text,               -- primeros 8 caracteres, para rastrear sin guardar la credencial
  reason      text not null,
  line_count  int,
  kind        text,
  items       jsonb,              -- null cuando el token no era válido
  created_at  timestamptz not null default now()
);

-- Apunta al pedido que se creó al rescatar este fallo (recover_order_failure,
-- más abajo). Null = todavía sin recuperar, que es lo que el panel muestra.
alter table public.order_failures
  add column if not exists recovered_order_id uuid references public.orders (id) on delete set null;

create index if not exists order_failures_created_idx
  on public.order_failures (created_at desc);

alter table public.order_failures enable row level security;

-- Igual criterio que admin_audit_log: solo lectura, y solo la escribe
-- create_order (SECURITY DEFINER). Sin policy de insert/update/delete para
-- nadie, y sin ninguna policy para anon.
drop policy if exists admin_read_failures on public.order_failures;
create policy admin_read_failures on public.order_failures
  for select to authenticated
  using (public.is_admin());

-- Una vendedora ve los fallos de sus propios clientes (los que no tienen
-- cliente resuelto — token inválido — son solo para el admin).
drop policy if exists vendedora_read_own_failures on public.order_failures;
create policy vendedora_read_own_failures on public.order_failures
  for select to authenticated
  using (client_id in (select id from public.clients where vendedora_id = public.current_vendedora_id()));

-- Explícito a propósito, aunque los default privileges de Supabase ya le den
-- acceso a authenticated sobre todo public: es una tabla nueva y quién puede
-- leerla no debería depender de un default que no está escrito en ningún lado.
-- Las policies de arriba son el control real; esto solo abre la puerta. anon
-- no recibe nada: la escribe create_order (SECURITY DEFINER), no el cliente.
grant select on public.order_failures to authenticated;

-- ---------- 4) create_order ----------
-- Se dropea la firma de 4 argumentos antes de crear la de 5: si quedaran las
-- dos, PostgREST no sabría cuál llamar (sobrecarga ambigua) y devolvería 300.
-- Un frontend sin actualizar sigue funcionando: manda 3-4 argumentos con
-- nombre y p_request_id toma su default.
drop function if exists public.create_order(text, jsonb, numeric, text);

create or replace function public.create_order(
  p_token      text,
  p_items      jsonb,
  p_total      numeric,
  p_kind       text default 'order',
  p_request_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client     public.clients%rowtype;
  v_list_code  text;
  v_kind       text;
  v_result     jsonb;
  v_items      jsonb;
  v_order_id   uuid;
  v_hint       text := left(coalesce(p_token, ''), 8);
  v_lines      int  := case when jsonb_typeof(p_items) = 'array'
                            then jsonb_array_length(p_items) end;
begin
  select * into v_client from public.clients where token = p_token;
  if not found then
    -- Token inválido: al cliente no se le explica nada (igual que antes), pero
    -- queda el rastro. Sin items, ver el comentario de la tabla.
    insert into public.order_failures (token_hint, reason, line_count, kind)
    values (v_hint, 'token inválido', v_lines, p_kind);
    return null;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
    values (v_client.id, v_hint, 'payload vacío o mal formado', v_lines, p_kind, p_items);
    return null;
  end if;

  -- Tope anti-abuso, 1000 desde 2026-08-05 (antes 200, que rechazaba pedidos
  -- reales). Ver la cabecera para por qué no es más alto.
  if jsonb_array_length(p_items) > 1000 then
    insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
    values (v_client.id, v_hint,
            format('demasiadas líneas: %s (el tope es 1000)', v_lines),
            v_lines, p_kind, p_items);
    return null;
  end if;

  -- Reintento del mismo carrito: devolver el pedido que ya se guardó, no otro.
  -- Va después de las validaciones para que un payload inválido no se "cure"
  -- solo por traer un request_id conocido.
  if p_request_id is not null then
    select id into v_order_id from public.orders where request_id = p_request_id;
    if found then
      return v_order_id;
    end if;
  end if;

  select code into v_list_code from public.price_lists where id = v_client.price_list_id;

  -- El cliente nunca decide esto: la lista 'quote' siempre guarda
  -- 'quote' sin precio, sin importar lo que mande el frontend. Desde
  -- 2026-07-17 el frontend también manda p_kind = 'quote' explícito al
  -- descargar el PDF desde el carrito (sin importar la lista del
  -- cliente), para que quede registrado como cotización en el panel.
  v_kind := case when v_list_code = 'quote' or p_kind = 'quote' then 'quote' else 'order' end;

  v_result := public.compute_order_items(v_client.id, p_items, v_kind);
  v_items  := v_result->'items';

  if jsonb_array_length(v_items) = 0 then
    -- Todos los ítems se cayeron en compute_order_items: productos
    -- desactivados o borrados entre que el cliente armó el carrito y lo envió.
    insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
    values (v_client.id, v_hint, 'ningún ítem válido (productos inactivos o inexistentes)',
            v_lines, v_kind, p_items);
    return null;
  end if;

  -- Carrera entre dos envíos del mismo carrito (el cliente toca dos veces y
  -- los dos requests pasan las validaciones a la vez): el índice único deja
  -- entrar solo al primero y acá se devuelve ese mismo pedido.
  begin
    insert into public.orders (client_id, items, total, kind, request_id)
    values (v_client.id, v_items, (v_result->>'total')::numeric, v_kind, p_request_id)
    returning id into v_order_id;
  exception when unique_violation then
    select id into v_order_id from public.orders where request_id = p_request_id;
  end;

  return v_order_id;
end;
$$;

revoke execute on function public.create_order(text, jsonb, numeric, text, uuid) from public;
grant execute on function public.create_order(text, jsonb, numeric, text, uuid) to anon, authenticated;

-- ---------- 5) recover_order_failure ----------
-- Rescata un pedido rechazado sin pedirle al cliente que lo rearme: toma los
-- ítems guardados en order_failures y los mete como pedido de ese mismo
-- cliente. Los precios se recalculan con la lista VIGENTE del cliente (via
-- compute_order_items), no con los que veía cuando lo armó.
--
-- Mismos permisos y auditoría que el resto de las acciones del panel: admin
-- cualquiera, vendedora solo los de sus clientes, y queda en admin_audit_log.
create or replace function public.recover_order_failure(p_failure_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fail    public.order_failures%rowtype;
  v_client  public.clients%rowtype;
  v_kind    text;
  v_result  jsonb;
  v_items   jsonb;
  v_order   uuid;
  v_email   text;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  select * into v_fail from public.order_failures where id = p_failure_id;
  if not found then
    raise exception 'registro no encontrado';
  end if;

  if v_fail.recovered_order_id is not null then
    raise exception 'este pedido ya fue recuperado';
  end if;

  if v_fail.client_id is null or v_fail.items is null then
    raise exception 'no hay suficiente información para recuperarlo (token inválido)';
  end if;

  select * into v_client from public.clients where id = v_fail.client_id;
  if not found then
    raise exception 'el cliente ya no existe';
  end if;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso para recuperar este pedido';
  end if;

  -- Tope más alto que el de create_order (un admin decidiendo a mano no es un
  -- payload sospechoso), pero no infinito: arriba de esto compute_order_items
  -- tarda más que el statement_timeout y la recuperación fallaría a mitad.
  if jsonb_array_length(v_fail.items) > 2000 then
    raise exception 'el pedido tiene % líneas: hay que partirlo en dos', jsonb_array_length(v_fail.items);
  end if;

  v_kind   := case when v_fail.kind = 'quote' then 'quote' else 'order' end;
  v_result := public.compute_order_items(v_client.id, v_fail.items, v_kind);
  v_items  := v_result->'items';

  if jsonb_array_length(v_items) = 0 then
    raise exception 'ninguno de los productos sigue activo';
  end if;

  insert into public.orders (client_id, items, total, kind)
  values (v_client.id, v_items, (v_result->>'total')::numeric, v_kind)
  returning id into v_order;

  update public.order_failures set recovered_order_id = v_order where id = p_failure_id;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('recover_order_failure', auth.uid(), v_email, v_client.id, v_client.name, v_order,
     jsonb_build_object(
       'failure_id', p_failure_id,
       'reason',     v_fail.reason,
       'kind',       v_kind,
       'items',      v_items,
       'total',      v_result->'total'
     ));

  return jsonb_build_object('ok', true, 'order_id', v_order, 'total', v_result->'total',
                            'lines', jsonb_array_length(v_items));
end;
$$;

revoke execute on function public.recover_order_failure(uuid) from public;
grant execute on function public.recover_order_failure(uuid) to authenticated;

-- ---------- Selects de prueba (comentados) ----------
-- Correr a mano en el SQL Editor después de aplicar la migración.
--
-- 1) Los pedidos que se perdieron antes de este arreglo NO están en ninguna
--    parte (por eso existe order_failures). Lo único que queda de ellos es el
--    mensaje de WhatsApp que recibió la vendedora: el último número de la
--    lista es la cantidad de líneas. Más de 200 => era este bug.
--
-- 2) De ahora en más, los rechazos se ven acá:
-- select created_at, reason, line_count, client_id, jsonb_array_length(items) as lineas
-- from public.order_failures order by created_at desc limit 20;
--
-- 3) Recuperar un pedido rechazado sin pedirle al cliente que lo rearme
--    (toma el token del cliente y el payload guardado):
-- select public.create_order(
--          (select token from public.clients c
--            where c.id = (select client_id from public.order_failures where id = '<failure_id>')),
--          (select items from public.order_failures where id = '<failure_id>'),
--          0, 'order', gen_random_uuid());
--
-- 4) El tope nuevo (necesita un cliente con lista de precio real):
-- select public.create_order('<token>', <payload de 1000 líneas>, 0, 'order', gen_random_uuid());
-- -- Debe devolver un uuid. Con 1001 líneas debe devolver null y dejar una
-- -- fila en order_failures con reason 'demasiadas líneas: 1001 (el tope es 1000)'.
--
-- 5) Idempotencia: el mismo request_id dos veces devuelve el MISMO uuid y deja
--    un solo pedido:
-- select public.create_order('<token>', '[{"id":"<product_id>","qty":2}]'::jsonb, 0, 'order',
--                            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
-- select public.create_order('<token>', '[{"id":"<product_id>","qty":2}]'::jsonb, 0, 'order',
--                            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
-- -- Mismo uuid las dos veces; select count(*) from orders where request_id = 'aaaa...' => 1
--
-- 6) La bandera no se puede tocar a mano:
-- update public.orders set request_id = gen_random_uuid() where id = '<order_id>';
-- -- Debe fallar con "los pedidos solo se editan via update_order_items/...".
