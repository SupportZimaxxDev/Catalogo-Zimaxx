-- Outbox sin pérdidas silenciosas, lado servidor (2026-09-02, segunda
-- migración del día, a pedido del usuario). Hasta hoy, cuando el pedido
-- pendiente del navegador (orderOutbox.js) cumplía 24 h sin poder
-- registrarse, el outbox lo DESCARTABA dejando solo un log critical en
-- system_logs — que solo ve el superadmin. Acaba de pasar con una cotización
-- real de $286.30 y tries: 0: el cliente cerró la pestaña tras el fallo,
-- volvió después de 24 h, y el outbox tiró el pedido sin que nadie pudiera
-- actuar.
--
-- El cambio: expirar ya no significa borrar — significa ENTREGAR el payload a
-- order_failures, que es la red que ya existe para "pedido que no entró":
-- tiene su aviso rojo en la bandeja de Pedidos (RLS: la vendedora dueña lo
-- ve), y el botón "Recuperar" existente (recover_order_failure) lo remonta
-- como cotización con precios vigentes sin que el cliente rearme nada. El
-- navegador solo borra el pendiente de localStorage cuando este reporte tuvo
-- éxito; si sigue sin red, el ítem se queda y el reporte se reintenta.
--
--   (1) `order_failures.request_id` (nueva columna, nullable) + índice único
--       parcial: la idempotencia del reporte. El outbox puede intentar
--       reportar el mismo pendiente varias veces (expira, reporta, se corta
--       la red antes de la respuesta, reintenta) — reportar dos veces NO
--       duplica la fila. Las filas que inserta create_order quedan con null
--       (no chocan entre sí gracias al índice parcial).
--
--   (2) RPC `report_outbox_expired(p_token, p_request_id, p_items, p_kind)`:
--       ejecutable por anon (el catálogo del cliente corre sin sesión, igual
--       que create_order), valida el token contra clients igual que
--       create_order y devuelve jsonb {ok, ...} SIN lanzar nunca — el caller
--       es un navegador con mala señal, un raise sería solo otro fallo de red
--       para él. Con token inválido NO se inserta nada (a diferencia de
--       create_order, que sí registra el intento): acá no hay flujo legítimo
--       con token inválido — el frontend solo reporta pendientes cuyo
--       token_hint coincide con el token vigente de la página — así que
--       insertar sería regalar una vía para inflar la tabla con payloads de
--       hasta 1000 líneas usando la anon key.
--
--       Borde importante: si YA existe un pedido con ese request_id (un
--       intento con keepalive que llegó al servidor pero cuya respuesta el
--       navegador nunca vio), NO se crea el fallo — se contesta
--       already_registered con el order_id, y el navegador limpia el
--       pendiente. Es la misma idempotencia por request_id de create_order,
--       vista desde el otro lado.
--
--   (3) El shape de items que se guarda es EL MISMO que ya deja create_order
--       en order_failures (el array crudo del navegador: id/qty/flash como
--       mínimo — recover_order_failure / compute_order_items solo leen esas
--       tres llaves y descartan el resto, así que un payload con sku/nombre/
--       precio de más no molesta y ayuda al forense).
--
-- Compatibilidad hacia atrás: solo agrega una columna nullable, un índice
-- parcial y una función nueva — nada existente cambia de firma ni de
-- contrato. Puede correr ANTES del deploy sin romper el frontend viejo (no
-- la llama); y el frontend nuevo SIN esta migración degrada bien: el reporte
-- falla (PGRST202), el pendiente se queda en el teléfono y se reintenta —
-- que es exactamente el contrato de "expirado = pendiente de entregar".
--
-- Requiere (preflight abajo, corta en limpio si falta algo):
--   * migration-2026-08-05-order-capture.sql (order_failures y
--     orders.request_id).
--
-- Idempotente: re-correrla recrea la misma función; el add column/index
-- if not exists no hacen nada la segunda vez.
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
declare
  faltan text[] := '{}';
begin
  if to_regclass('public.order_failures') is null then
    faltan := array_append(faltan, 'order_failures (migration-2026-08-05-order-capture.sql)');
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'request_id'
  ) then
    faltan := array_append(faltan, 'orders.request_id (migration-2026-08-05-order-capture.sql)');
  end if;
  if array_length(faltan, 1) is not null then
    raise exception 'faltan piezas previas: %', array_to_string(faltan, ' · ');
  end if;
end $$;

-- ---------- (1) Idempotencia del reporte ----------
alter table public.order_failures
  add column if not exists request_id uuid;

-- Parcial: las filas de create_order (request_id null) no chocan entre sí.
create unique index if not exists order_failures_request_id_key
  on public.order_failures (request_id) where request_id is not null;

-- ---------- (2) RPC: report_outbox_expired ----------
create or replace function public.report_outbox_expired(
  p_token      text,
  p_request_id uuid,
  p_items      jsonb,
  p_kind       text default 'order'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client     public.clients%rowtype;
  -- Igual que create_order: el cliente no decide tipos raros — cualquier
  -- cosa que no sea 'quote' se registra como 'order'.
  v_kind       text := case when p_kind = 'quote' then 'quote' else 'order' end;
  v_order_id   uuid;
  v_failure_id uuid;
  v_lines      int := case when jsonb_typeof(p_items) = 'array'
                           then jsonb_array_length(p_items) end;
begin
  -- Token validado igual que create_order (lookup directo en clients). Sin
  -- cliente no se inserta nada — ver el encabezado por qué difiere de
  -- create_order en esto.
  select * into v_client from public.clients where token = p_token;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'token inválido');
  end if;

  if p_request_id is null then
    -- Sin request_id no hay idempotencia posible: mejor rechazar que aceptar
    -- un reporte que se duplicaría en cada reintento.
    return jsonb_build_object('ok', false, 'reason', 'request_id requerido');
  end if;

  -- Mismo tope de líneas que create_order (1000): esta RPC es pública por
  -- diseño y el payload viaja al jsonb de la tabla.
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 1000 then
    return jsonb_build_object('ok', false, 'reason', 'payload vacío o mal formado');
  end if;

  -- ¿En realidad SÍ entró? (keepalive que llegó sin que el navegador viera
  -- la respuesta): no hay nada que reportar, el pedido existe.
  select id into v_order_id from public.orders where request_id = p_request_id;
  if v_order_id is not null then
    return jsonb_build_object('ok', true, 'already_registered', true, 'order_id', v_order_id);
  end if;

  -- ¿Ya se reportó? (doble expiración, reintento tras respuesta perdida):
  -- se contesta la fila existente, no se duplica.
  select id into v_failure_id from public.order_failures where request_id = p_request_id;
  if v_failure_id is not null then
    return jsonb_build_object('ok', true, 'failure_id', v_failure_id, 'already_reported', true);
  end if;

  begin
    insert into public.order_failures
      (client_id, token_hint, reason, line_count, kind, items, request_id)
    values
      (v_client.id,
       left(coalesce(p_token, ''), 8),
       'expiró en el teléfono del cliente sin poder registrarse (outbox del navegador)',
       v_lines, v_kind, p_items, p_request_id)
    returning id into v_failure_id;
  exception when unique_violation then
    -- Carrera entre dos reportes del mismo pendiente: gana el primero y acá
    -- se devuelve esa misma fila.
    select id into v_failure_id from public.order_failures where request_id = p_request_id;
    return jsonb_build_object('ok', true, 'failure_id', v_failure_id, 'already_reported', true);
  end;

  return jsonb_build_object('ok', true, 'failure_id', v_failure_id, 'already_reported', false);
end;
$$;

revoke execute on function public.report_outbox_expired(text, uuid, jsonb, text) from public;
grant execute on function public.report_outbox_expired(text, uuid, jsonb, text) to anon, authenticated;

-- ---------- Selects de prueba (comentados) ----------
-- 1) Reportar un pendiente expirado (token real de un cliente):
-- select public.report_outbox_expired(
--   '<token>', gen_random_uuid(),
--   '[{"id":"<product_id>","qty":2,"flash":false}]'::jsonb, 'quote');
-- -- {ok:true, failure_id:..., already_reported:false} y la fila aparece en
-- -- el aviso rojo de la bandeja de Pedidos (sin recovered/dismissed).
--
-- 2) Repetir el MISMO select (mismo request_id): already_reported:true y
-- -- ninguna fila nueva:
-- select count(*) from public.order_failures where request_id = '<request_id>';
--
-- 3) Con el request_id de un pedido que SÍ existe en orders:
-- -- {ok:true, already_registered:true, order_id:...} y ninguna fila nueva.
--
-- 4) Token inválido:
-- select public.report_outbox_expired('no-existe', gen_random_uuid(),
--   '[{"id":"x","qty":1}]'::jsonb, 'order');
-- -- {ok:false, reason:'token inválido'} y ninguna fila nueva.
--
-- 5) El fallo reportado se recupera con el botón de siempre:
-- select public.recover_order_failure('<failure_id>');
-- -- Crea la cotización con precios VIGENTES (compute_order_items) y marca
-- -- recovered_order_id.
