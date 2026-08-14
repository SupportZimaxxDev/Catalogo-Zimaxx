-- 2026-08-13: recuperar un pedido perdido (order_failures) siempre crea una
-- COTIZACIÓN, sin importar si el intento original era un pedido o una
-- cotización.
--
-- Por qué: entre que el cliente armó el pedido y alguien lo rescata puede
-- pasar cualquier cosa con precios, stock o disponibilidad. Antes, un
-- rechazo cuyo intento original era 'order' se recuperaba directo como
-- pedido real (precio congelado en ese momento) sin que nadie del lado
-- humano lo revisara. Ahora entra como cotización — la vendedora confirma
-- con el cliente y recién ahí lo convierte en pedido con "Convertir en
-- pedido" (convert_quote_to_order, ya existente), exactamente el mismo flujo
-- que cualquier otra cotización. El motivo original (`order_failures.kind`,
-- lo que el cliente intentó de verdad) no se pierde: queda en
-- admin_audit_log como `original_kind`.
--
-- Idempotente, se puede re-correr. lock_timeout corto para fallar rápido y
-- limpio si un lock se traba contra producción.
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regprocedure('public.recover_order_failure(uuid)') is null then
    raise exception using message =
      'Falta recover_order_failure: corré primero migration-2026-08-05-order-capture.sql';
  end if;
end $$;

create or replace function public.recover_order_failure(p_failure_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fail    public.order_failures%rowtype;
  v_client  public.clients%rowtype;
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

  -- Siempre 'quote': ver el comentario de arriba del archivo.
  v_result := public.compute_order_items(v_client.id, v_fail.items, 'quote');
  v_items  := v_result->'items';

  if jsonb_array_length(v_items) = 0 then
    raise exception 'ninguno de los productos sigue activo';
  end if;

  insert into public.orders (client_id, items, total, kind)
  values (v_client.id, v_items, (v_result->>'total')::numeric, 'quote')
  returning id into v_order;

  update public.order_failures set recovered_order_id = v_order where id = p_failure_id;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('recover_order_failure', auth.uid(), v_email, v_client.id, v_client.name, v_order,
     jsonb_build_object(
       'failure_id',    p_failure_id,
       'reason',        v_fail.reason,
       'kind',          'quote',
       'original_kind', coalesce(v_fail.kind, 'order'),
       'items',         v_items,
       'total',         v_result->'total'
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
-- 1) Recuperar un fallo cuyo order_failures.kind sea 'order' y confirmar que
--    entra como cotización de todas formas:
-- select public.recover_order_failure('<failure_id con kind=order>');
-- select kind from public.orders where id = '<order_id devuelto arriba>';
-- -- Debe devolver 'quote', nunca 'order'.
--
-- 2) El motivo original queda en el audit log, no se pierde:
-- select detail->>'original_kind', detail->>'kind'
-- from public.admin_audit_log
-- where action = 'recover_order_failure'
-- order by created_at desc limit 1;
-- -- original_kind = 'order' (o lo que era), kind = 'quote' siempre.
