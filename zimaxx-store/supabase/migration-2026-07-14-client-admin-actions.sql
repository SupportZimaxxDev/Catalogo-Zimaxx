-- Reasignar y eliminar clientes con auditoría (2026-07-14, a pedido del
-- usuario). Dos acciones sensibles del panel de Clientes que ahora:
--   * son SOLO para admin (chequeo is_admin() dentro de cada función), y
--   * quedan REGISTRADAS en admin_audit_log (quién, qué, cuándo) — para
--     saber qué usuario reasignó o borró un cliente.
--
-- Se hacen vía RPC SECURITY DEFINER (no con update/delete directos desde el
-- frontend) justamente para que el registro de auditoría sea atómico e
-- imposible de saltear: no hay forma de reasignar/borrar sin dejar rastro.
--
-- Reglas de negocio:
--   * Reasignar: no se permite si el cliente tiene una lista "personal"
--     (price_lists.owner_vendedora_id, ej. 'luzmar') — el trigger
--     clients_enforce_owner_vendedora lo revertiría igual; mejor un error
--     claro. p_vendedora_id null = "Sin asignar" (permitido).
--   * Eliminar: se rechaza si el cliente tiene pedidos (orders.client_id)
--     — borrarlo perdería el historial de ventas (la FK es RESTRICT y
--     orders no guarda copia del nombre del cliente). El admin puede
--     reasignar o dejar el cliente sin tocar; solo se borran los que no
--     tienen pedidos (duplicados, pruebas, errores de carga).
--
-- Delta chico e idempotente (mismo criterio que las otras migraciones, sin
-- re-correr schema.sql).
set lock_timeout = '10s';

-- ---------- Tabla de auditoría ----------
-- Genérica (columna `action` texto) por si en el futuro se auditan más
-- acciones. `client_id` SIN FK a clients a propósito: la fila de auditoría
-- de un borrado tiene que sobrevivir al cliente borrado. `client_name` y
-- `detail` son un snapshot al momento de la acción.
create table if not exists public.admin_audit_log (
  id                 uuid primary key default gen_random_uuid(),
  action             text not null,
  performed_by       uuid,
  performed_by_email text,
  client_id          uuid,
  client_name        text,
  detail             jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);

-- RLS: como todas las tablas. Solo admins leen el historial; nadie lo
-- escribe directo (lo escriben las funciones SECURITY DEFINER de abajo, que
-- corren como owner y saltan RLS). Sin policy de insert/update/delete →
-- inmutable para cualquier usuario autenticado.
alter table public.admin_audit_log enable row level security;
drop policy if exists admin_read_audit on public.admin_audit_log;
create policy admin_read_audit on public.admin_audit_log
  for select to authenticated
  using (public.is_admin());

-- ---------- Reasignar cliente a otra vendedora ----------
-- p_vendedora_id null = dejar sin asignar. Devuelve {ok, from, to}.
create or replace function public.reassign_client(p_client_id uuid, p_vendedora_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   public.clients%rowtype;
  v_owner    uuid;
  v_old_name text;
  v_new_name text;
  v_email    text;
begin
  if not public.is_admin() then
    raise exception 'solo un admin puede reasignar clientes';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'cliente no encontrado';
  end if;

  -- Lista personal: no se puede reasignar (el trigger lo revertiría).
  select owner_vendedora_id into v_owner
  from public.price_lists where id = v_client.price_list_id;
  if v_owner is not null then
    raise exception 'el cliente tiene una lista personal y no se puede reasignar a otra vendedora';
  end if;

  -- Destino válido (null = sin asignar, permitido).
  if p_vendedora_id is not null
     and not exists (select 1 from public.vendedores where id = p_vendedora_id) then
    raise exception 'la vendedora destino no existe';
  end if;

  select name into v_old_name from public.vendedores where id = v_client.vendedora_id;
  select name into v_new_name from public.vendedores where id = p_vendedora_id;
  select email into v_email from auth.users where id = auth.uid();

  update public.clients set vendedora_id = p_vendedora_id where id = p_client_id;

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('reassign_client', auth.uid(), v_email, p_client_id, v_client.name,
     jsonb_build_object(
       'from_vendedora_id', v_client.vendedora_id,
       'from_vendedora',    v_old_name,
       'to_vendedora_id',   p_vendedora_id,
       'to_vendedora',      v_new_name
     ));

  return jsonb_build_object('ok', true, 'from', v_old_name, 'to', v_new_name);
end;
$$;

revoke execute on function public.reassign_client(uuid, uuid) from public;
grant execute on function public.reassign_client(uuid, uuid) to authenticated;

-- ---------- Eliminar cliente ----------
-- Se rechaza si tiene pedidos (protege el historial). Devuelve {ok}.
create or replace function public.delete_client(p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients%rowtype;
  v_orders int;
  v_vend   text;
  v_list   text;
  v_email  text;
begin
  if not public.is_admin() then
    raise exception 'solo un admin puede eliminar clientes';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'cliente no encontrado';
  end if;

  select count(*) into v_orders from public.orders where client_id = p_client_id;
  if v_orders > 0 then
    raise exception 'el cliente tiene % pedido(s): no se puede eliminar sin perder el historial de ventas', v_orders;
  end if;

  select name  into v_vend from public.vendedores where id = v_client.vendedora_id;
  select label into v_list from public.price_lists where id = v_client.price_list_id;
  select email into v_email from auth.users where id = auth.uid();

  -- Auditoría ANTES del delete (snapshot; la fila no tiene FK a clients, así
  -- que sobrevive al borrado).
  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('delete_client', auth.uid(), v_email, p_client_id, v_client.name,
     jsonb_build_object(
       'phone',     v_client.phone,
       'vendedora', v_vend,
       'lista',     v_list
     ));

  delete from public.clients where id = p_client_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.delete_client(uuid) from public;
grant execute on function public.delete_client(uuid) to authenticated;

-- ---------- Verificación manual (SQL Editor) ----------
-- Ojo: el SQL Editor corre como postgres, no como un usuario autenticado,
-- así que auth.uid() es null e is_admin() da false → estas funciones
-- lanzarán 'solo un admin...'. Para probarlas de verdad hay que llamarlas
-- desde la app logueado como admin. Lo que SÍ se puede revisar acá:
-- select * from public.admin_audit_log order by created_at desc limit 20;
