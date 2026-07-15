-- Permite a una vendedora cambiar la lista de precio de SUS propios
-- clientes desde el panel (2026-07-15, a pedido del usuario) — hasta
-- ahora solo el admin podía hacerlo (select directo contra `clients`,
-- sin auditar). Requiere:
--   * migration-2026-07-14-client-admin-actions.sql ya corrida (crea
--     `admin_audit_log`, donde esta función también audita).
--
-- Por qué es una RPC SECURITY DEFINER y no una policy de UPDATE nueva:
--   (a) una vendedora no tiene ninguna policy de UPDATE en `clients` (solo
--       select/insert de lo suyo) — sin esto, ni con la UI habilitada
--       podría cambiar nada; una policy UPDATE lisa y llana tampoco
--       alcanzaría porque hay que impedir que asigne una lista "personal"
--       ajena (ej. luzmar), regla que no se puede expresar como `check`
--       sin una subquery a price_lists (se puede, pero mezclar esa regla
--       de negocio con RLS es más difícil de leer que un IF explícito).
--   (b) mismo criterio que reassign_client/delete_client: que el cambio
--       quede auditado en `admin_audit_log` SÍ O SÍ, para cualquiera que
--       lo haga (admin o vendedora) — antes este cambio ni se auditaba.
--
-- Idempotente (create or replace) y sin riesgo de deadlock: no toca
-- filas ni tipos, solo agrega una función.
set lock_timeout = '10s';

create or replace function public.update_client_price_list(p_client_id uuid, p_price_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   public.clients%rowtype;
  v_new_list public.price_lists%rowtype;
  v_old_list public.price_lists%rowtype;
  v_email    text;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'cliente no encontrado';
  end if;

  if not public.is_admin() then
    if not public.is_vendedora() or v_client.vendedora_id is distinct from public.current_vendedora_id() then
      raise exception 'no tenés permiso para cambiar la lista de este cliente';
    end if;
  end if;

  select * into v_new_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  if not public.is_admin()
     and v_new_list.owner_vendedora_id is not null
     and v_new_list.owner_vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no podés asignar esa lista';
  end if;

  select * into v_old_list from public.price_lists where id = v_client.price_list_id;
  select email into v_email from auth.users where id = auth.uid();

  update public.clients set price_list_id = p_price_list_id where id = p_client_id;

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('update_price_list', auth.uid(), v_email, p_client_id, v_client.name,
     jsonb_build_object(
       'from_list_id', v_client.price_list_id,
       'from_list',    v_old_list.label,
       'to_list_id',   p_price_list_id,
       'to_list',      v_new_list.label
     ));

  return jsonb_build_object('ok', true, 'from', v_old_list.label, 'to', v_new_list.label);
end;
$$;

revoke execute on function public.update_client_price_list(uuid, uuid) from public;
grant execute on function public.update_client_price_list(uuid, uuid) to authenticated;

-- ---------- Verificación manual (SQL Editor) ----------
-- El SQL Editor corre como postgres (no como un usuario authenticated),
-- así que is_admin()/is_vendedora() dan false acá y la función siempre
-- tira 'no tenés permiso' — para probarla de verdad hay que loguearse en
-- la app. Chequeo rápido de que quedó bien creada:
-- select proname, prosecdef from pg_proc where proname = 'update_client_price_list';
