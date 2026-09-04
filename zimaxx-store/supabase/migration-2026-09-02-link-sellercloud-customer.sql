-- Vinculación GUIADA de un cliente con su customer de SellerCloud
-- (2026-09-02, tercera migración del día, a pedido del usuario: la mayoría de
-- los clientes no tienen sellercloud_id y sin él "Enviar a SellerCloud"
-- rechaza sus pedidos; además el alta de clientes no asignaba el ID, así que
-- el problema se regeneraba).
--
-- RPC nueva `link_sellercloud_customer(p_client_id, p_sellercloud_id,
-- p_detail)`: guarda el vínculo Y lo audita como 'link_sellercloud_customer'.
-- Convive a propósito con `set_client_sellercloud_id`
-- (migration-2026-08-31-client-email-sellercloud-id.sql), que sigue SOLO
-- ADMIN y sigue siendo el único camino para QUITAR un vínculo:
--
--   * set_client_sellercloud_id = tipeo CRUDO del ID (admin-only por
--     decisión del 2026-08-31: un ID equivocado manda la orden al cliente
--     equivocado — nivel reassign/delete).
--   * link_sellercloud_customer = flujo GUIADO del panel: los IDs vienen de
--     una búsqueda o un alta contra la API real de SellerCloud (Edge Function
--     sellercloud-customers, que verifica que el customer exista allá antes
--     de llamar acá), no de un input libre. Por eso acá también puede una
--     VENDEDORA — solo sobre sus propios clientes — igual que puede crear
--     clientes y editarles nombre/teléfono (update_client_info).
--
-- `p_detail` es el contexto del vínculo para la auditoría (nombre/email del
-- customer elegido, por qué camino llegó: search/create/backfill). Se copian
-- SOLO las llaves esperadas y recortadas: el detail viene del navegador y un
-- jsonb arbitrario en la auditoría sería un vector para inflar la tabla.
--
-- Compatibilidad hacia atrás: solo agrega una función; puede correr antes o
-- después del deploy (el frontend viejo no la llama; el nuevo sin ella recibe
-- PGRST202 y muestra el error — la creación local del cliente nunca depende
-- de esto). Idempotente: re-correrla recrea la misma función.
--
-- Requiere (preflight abajo):
--   * migration-2026-07-10-sellercloud-sync-v2.sql (clients.sellercloud_id +
--     su índice único clients_sellercloud_id_key).
--   * migration-2026-07-14-client-admin-actions.sql (admin_audit_log).
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
declare
  faltan text[] := '{}';
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'sellercloud_id'
  ) then
    faltan := array_append(faltan, 'clients.sellercloud_id (migration-2026-07-10-sellercloud-sync-v2.sql)');
  end if;
  if to_regclass('public.admin_audit_log') is null then
    faltan := array_append(faltan, 'admin_audit_log (migration-2026-07-14-client-admin-actions.sql)');
  end if;
  if to_regprocedure('public.is_vendedora()') is null then
    faltan := array_append(faltan, 'is_vendedora()');
  end if;
  if array_length(faltan, 1) is not null then
    raise exception 'faltan piezas previas: %', array_to_string(faltan, ' · ');
  end if;
end $$;

-- ---------- RPC: link_sellercloud_customer ----------
create or replace function public.link_sellercloud_customer(
  p_client_id      uuid,
  p_sellercloud_id integer,
  p_detail         jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients%rowtype;
  v_owner  text;
  v_email  text;
  v_detail jsonb;
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
    raise exception 'no tenés permiso para vincular este cliente';
  end if;

  -- Este camino solo VINCULA: quitar un vínculo sigue siendo
  -- set_client_sellercloud_id (solo admin), ver cabecera.
  if p_sellercloud_id is null or p_sellercloud_id <= 0 then
    raise exception 'el ID de SellerCloud tiene que ser un entero positivo';
  end if;

  if p_sellercloud_id is not distinct from v_client.sellercloud_id then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  -- El índice único clients_sellercloud_id_key es la garantía real; el
  -- chequeo previo existe para decir QUIÉN lo tiene (mismo criterio que
  -- set_client_sellercloud_id), y el handler de unique_violation atrapa la
  -- carrera.
  select name into v_owner
  from public.clients
  where sellercloud_id = p_sellercloud_id and id <> p_client_id;
  if v_owner is not null then
    raise exception 'ese cliente de SellerCloud ya está vinculado a: %', v_owner;
  end if;

  -- Solo las llaves esperadas del detail, recortadas (viene del navegador).
  v_detail := jsonb_strip_nulls(jsonb_build_object(
    'sc_name',  left(p_detail ->> 'sc_name', 200),
    'sc_email', left(p_detail ->> 'sc_email', 200),
    'via',      case when p_detail ->> 'via' in ('search', 'create', 'backfill')
                     then p_detail ->> 'via' end
  ));

  select email into v_email from auth.users where id = auth.uid();

  begin
    update public.clients set sellercloud_id = p_sellercloud_id where id = p_client_id;
  exception when unique_violation then
    raise exception 'ese cliente de SellerCloud ya está vinculado a otro cliente';
  end;

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('link_sellercloud_customer', auth.uid(), v_email, p_client_id, v_client.name,
     jsonb_build_object(
       'from_sellercloud_id', v_client.sellercloud_id,
       'to_sellercloud_id',   p_sellercloud_id
     ) || v_detail);

  return jsonb_build_object('ok', true, 'changed', true, 'sellercloud_id', p_sellercloud_id);
end;
$$;

revoke execute on function public.link_sellercloud_customer(uuid, integer, jsonb) from public;
grant execute on function public.link_sellercloud_customer(uuid, integer, jsonb) to authenticated;

-- ---------- Selects de prueba (comentados) ----------
-- Ojo: is_admin()/is_vendedora() dan false en el SQL Editor — probar desde la
-- app, o simular con app.test_uid en un cluster de prueba.
--
-- 1) Vincular (como admin o como la vendedora dueña):
-- select public.link_sellercloud_customer('<client_id>', 12345,
--   '{"sc_name":"John Doe","sc_email":"jd@x.com","via":"search"}'::jsonb);
-- -- {ok:true, changed:true}; clients.sellercloud_id = 12345; fila en
-- -- admin_audit_log con action = 'link_sellercloud_customer'.
--
-- 2) Repetir el mismo select: {ok:true, changed:false} y SIN fila nueva de
-- -- auditoría (no-op).
--
-- 3) Con el ID de otro cliente ya vinculado: corta nombrando al dueño.
-- 4) Como vendedora sobre un cliente ajeno: corta con 'no tenés permiso...'.
-- 5) p_sellercloud_id null o <= 0: corta (quitar vínculos es solo-admin por
-- -- set_client_sellercloud_id).
