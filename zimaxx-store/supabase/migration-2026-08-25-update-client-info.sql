-- Editar nombre y teléfono de un cliente desde el panel (2026-08-25, a
-- pedido del usuario) — hasta ahora los únicos caminos para corregir un
-- dato mal cargado eran re-subir un Excel (matchea por teléfono, así que
-- un teléfono mal cargado ni siquiera se puede corregir por ahí: crea un
-- duplicado) o entrar a la base a mano. Requiere:
--   * migration-2026-07-14-client-admin-actions.sql (crea `admin_audit_log`).
--   * migration-2026-07-15-fix-duplicate-client-phones.sql (columna
--     `allow_shared_phone` + índice único por últimos 10 dígitos, cuya
--     regla esta función replica para dar un error claro).
--
-- Mismo criterio que update_client_price_list, y por los mismos motivos:
--   (a) RPC SECURITY DEFINER y no un update directo: una vendedora no tiene
--       policy de UPDATE en `clients`, y aunque el admin sí la tiene, por
--       acá el cambio queda auditado en `admin_audit_log` SÍ O SÍ, sea
--       quien sea que lo haga.
--   (b) admin edita cualquier cliente; una vendedora solo los suyos
--       (`vendedora_id = current_vendedora_id()`).
--
-- El teléfono se guarda normalizado (solo dígitos, igual que cleanPhone en
-- el frontend). El duplicado se chequea por los últimos 10 dígitos — la
-- misma regla que el índice único parcial clients_phone_normalized_key
-- (un mismo número con y sin código de país es el mismo teléfono) — para
-- devolver un mensaje claro en vez del error crudo del índice; el índice
-- sigue siendo la garantía real y el handler de unique_violation atrapa
-- la carrera.
--
-- Idempotente (create or replace) y sin riesgo de deadlock: solo agrega
-- una función, no toca filas ni tipos.
set lock_timeout = '10s';

create or replace function public.update_client_info(p_client_id uuid, p_name text, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients%rowtype;
  v_name   text := btrim(coalesce(p_name, ''));
  v_phone  text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_email  text;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'cliente no encontrado';
  end if;

  if not public.is_admin() then
    if not public.is_vendedora() or v_client.vendedora_id is distinct from public.current_vendedora_id() then
      raise exception 'no tenés permiso para editar este cliente';
    end if;
  end if;

  if v_name = '' then
    raise exception 'el nombre no puede quedar vacío';
  end if;
  if length(v_phone) < 7 then
    raise exception 'el teléfono tiene que tener al menos 7 dígitos';
  end if;

  -- Sin cambios reales: no ensuciar la auditoría con una fila que no
  -- cambió nada (el guardado repetido del mismo valor es un no-op).
  if v_name = v_client.name and v_phone = v_client.phone then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  -- Duplicado por últimos 10 dígitos. Un cliente marcado allow_shared_phone
  -- se salta el chequeo (compartir con su par es justamente lo legítimo);
  -- para todos los demás se compara contra TODOS los clientes, incluidos
  -- los marcados — a propósito MÁS estricto que el índice parcial (que
  -- ignora las filas marcadas en ambas puntas): un tercer cliente con el
  -- número del par rompería la deduplicación por teléfono del Excel, y es
  -- la misma regla que ya aplica el alta manual en el frontend.
  if not v_client.allow_shared_phone and exists (
    select 1 from public.clients c
    where c.id <> p_client_id
      and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(v_phone, 10)
  ) then
    raise exception 'ya existe otro cliente con ese teléfono';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  begin
    update public.clients set name = v_name, phone = v_phone where id = p_client_id;
  exception when unique_violation then
    raise exception 'ya existe otro cliente con ese teléfono';
  end;

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('update_client_info', auth.uid(), v_email, p_client_id, v_client.name,
     jsonb_build_object(
       'from_name',  v_client.name,
       'to_name',    v_name,
       'from_phone', v_client.phone,
       'to_phone',   v_phone
     ));

  return jsonb_build_object('ok', true, 'changed', true);
end;
$$;

revoke execute on function public.update_client_info(uuid, text, text) from public;
grant execute on function public.update_client_info(uuid, text, text) to authenticated;

-- ---------- Verificación manual (SQL Editor) ----------
-- El SQL Editor corre como postgres (no como usuario authenticated), así
-- que is_admin()/is_vendedora() dan false y la función siempre tira
-- 'no tenés permiso...' — para probarla de verdad hay que loguearse en la
-- app. Chequeo rápido de que quedó bien creada:
-- select proname, prosecdef from pg_proc where proname = 'update_client_info';
-- Y de la auditoría después de un cambio real:
-- select * from public.admin_audit_log where action = 'update_client_info'
-- order by created_at desc limit 10;
