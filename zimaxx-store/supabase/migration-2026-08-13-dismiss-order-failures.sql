-- 2026-08-13: filas de `order_failures` que NUNCA se van a poder recuperar
-- (token inválido → sin cliente; o payload vacío/malformado → sin ítems) se
-- quedaban para siempre en el banner rojo de Pedidos, porque el botón
-- "Recuperar" ni siquiera aparece sin cliente e ítems — no hay a quién
-- asignárselo. Reportado por el usuario: una fila sin nombre lleva "un par
-- de días" ahí y no hay ninguna acción posible sobre ella.
--
-- Agrega la posibilidad de DESCARTARLA (no borrarla: queda igual en la
-- tabla, con `dismissed_at`, y la acción se audita en admin_audit_log — solo
-- deja de aparecer en el banner). No se auto-descarta nada: es una acción
-- explícita de admin/vendedora.
--
-- Idempotente, se puede re-correr.
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regclass('public.order_failures') is null then
    raise exception using message =
      'Falta order_failures: corré primero migration-2026-08-05-order-capture.sql';
  end if;
  if to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.is_vendedora()') is null
     or to_regprocedure('public.current_vendedora_id()') is null then
    raise exception using message =
      'Faltan is_admin()/is_vendedora()/current_vendedora_id(): corré primero las migraciones del rol vendedora';
  end if;
end $$;

alter table public.order_failures
  add column if not exists dismissed_at timestamptz;

-- ---------- RPC: dismiss_order_failure ----------
-- Mismos permisos que recover_order_failure: admin cualquiera, vendedora
-- solo los de sus propios clientes. Una fila sin client_id (token inválido)
-- solo la ve un admin (la policy de vendedora ya la excluye), así que en la
-- práctica solo un admin puede descartar esas.
create or replace function public.dismiss_order_failure(p_failure_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fail   public.order_failures%rowtype;
  v_client public.clients%rowtype;
  v_email  text;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  select * into v_fail from public.order_failures where id = p_failure_id;
  if not found then
    raise exception 'registro no encontrado';
  end if;

  if v_fail.recovered_order_id is not null then
    raise exception 'este pedido ya fue recuperado, no hace falta descartarlo';
  end if;

  if v_fail.dismissed_at is not null then
    raise exception 'ya estaba descartado';
  end if;

  if not public.is_admin() then
    if v_fail.client_id is null then
      raise exception 'no tenés permiso para descartar este registro';
    end if;
    select * into v_client from public.clients where id = v_fail.client_id;
    if not found or v_client.vendedora_id is distinct from public.current_vendedora_id() then
      raise exception 'no tenés permiso para descartar este registro';
    end if;
  end if;

  update public.order_failures set dismissed_at = now() where id = p_failure_id;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, detail)
  values
    ('dismiss_order_failure', auth.uid(), v_email, v_fail.client_id,
     jsonb_build_object(
       'failure_id', p_failure_id,
       'reason',     v_fail.reason,
       'token_hint', v_fail.token_hint,
       'kind',       v_fail.kind
     ));

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.dismiss_order_failure(uuid) from public;
grant execute on function public.dismiss_order_failure(uuid) to authenticated;

-- ---------- Selects de prueba (comentados) ----------
-- select id, reason, client_id, items, dismissed_at from public.order_failures
-- where recovered_order_id is null order by created_at desc limit 20;
--
-- select public.dismiss_order_failure('<id de una fila sin cliente>');
-- -- Debe devolver {"ok": true}; la fila deja de aparecer en el banner
-- -- (loadFailures ahora filtra dismissed_at is null) pero sigue en la tabla.
--
-- select detail from public.admin_audit_log
-- where action = 'dismiss_order_failure' order by created_at desc limit 1;
