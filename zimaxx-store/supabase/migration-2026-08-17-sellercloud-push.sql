-- ============================================================
-- 2026-08-17: mandar el pedido a SellerCloud como orden On Hold
--
-- Contexto (a pedido del usuario). Hoy, cuando una vendedora cierra un pedido,
-- lo monta a mano en SellerCloud: descarga el Excel con el formato de
-- `UploadTemplate.xls` y lo sube al bulk-order upload. Este es el lado base de
-- datos de reemplazar ese paso por un botón: **"Enviar a SellerCloud"** en la
-- bandeja de Pedidos, que crea la orden allá y la deja **On Hold** para que la
-- vendedora la confirme desde SellerCloud, como siempre.
--
-- El HTTP lo hace la Edge Function `sellercloud-push-order` (el token de la API
-- de SellerCloud nunca puede tocar el navegador). Acá vive lo que tiene que
-- vivir en la base:
--   * dónde se anota el resultado (columnas nuevas en `orders`),
--   * quién tiene permiso y cómo queda auditado (`mark_order_sellercloud`).
--
-- Por qué el push NO es automático al crearse el pedido (decisión del
-- usuario): la vendedora revisa antes. Un pedido que entra solo a SellerCloud
-- sin que nadie lo mire es más difícil de deshacer que uno que no entró.
--
-- Idempotente, se puede re-correr.
-- ============================================================
set lock_timeout = '10s';

-- ---------- 0) Preflight ----------
do $$
begin
  if to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.is_vendedora()') is null
     or to_regprocedure('public.current_vendedora_id()') is null then
    raise exception using message = 'Faltan is_admin()/is_vendedora()/current_vendedora_id()';
  end if;
  if to_regclass('public.admin_audit_log') is null then
    raise exception using message = 'Falta admin_audit_log';
  end if;
end $$;

-- ---------- 1) Dónde se anota el resultado ----------
-- El id que devuelve SellerCloud al crear la orden. Es la marca de "esta ya
-- se mandó": mientras tenga valor, el botón no vuelve a mandarla (una orden
-- duplicada en SellerCloud hay que ir a cancelarla a mano allá).
alter table public.orders
  add column if not exists sellercloud_order_id integer;

alter table public.orders
  add column if not exists sellercloud_pushed_at timestamptz;

-- El último error, para mostrarlo en el panel en vez de dejar a la vendedora
-- adivinando por qué no salió. Se limpia solo cuando el envío sale bien.
alter table public.orders
  add column if not exists sellercloud_error text;

-- Un mismo id de SellerCloud no puede quedar pegado a dos pedidos distintos:
-- si eso pasa, alguien duplicó algo y hay que verlo, no dejarlo pasar.
create unique index if not exists orders_sellercloud_order_id_key
  on public.orders (sellercloud_order_id) where sellercloud_order_id is not null;

-- La escribe la auditoría de abajo; la crea migration-2026-08-05-order-capture,
-- repetida acá con `if not exists` para que esto funcione igual si aquella no
-- corrió (mismo criterio que el resto de las migraciones del proyecto).
alter table public.admin_audit_log
  add column if not exists order_id uuid;

-- El trigger orders_guard_items_edit (schema.sql) solo protege
-- items/total/status/kind/stock_applied/request_id, así que estas columnas se
-- pueden escribir con un update normal — que es justo lo que hace la RPC de
-- abajo. No hace falta tocar el guard ni pedirle `app.allow_order_edit`.

-- ---------- 2) Anotar el resultado, con permiso y auditoría ----------
-- La llama la Edge Function CON EL JWT DE QUIEN APRETÓ EL BOTÓN (no con la
-- service_role key), así el permiso y el rastro se deciden acá y no hay una
-- segunda copia de la regla del lado de Deno. Mismo criterio que
-- update_order_items y que la Edge Function admin-create-vendedora-user.
--
-- p_sellercloud_order_id null = el envío falló; se guarda el motivo y no se
-- marca nada como enviado.
create or replace function public.mark_order_sellercloud(
  p_order_id             uuid,
  p_sellercloud_order_id integer default null,
  p_error                text    default null
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

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'pedido no encontrado';
  end if;

  select * into v_client from public.clients where id = v_order.client_id;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso sobre este pedido';
  end if;

  if p_sellercloud_order_id is null then
    update public.orders
    set sellercloud_error = left(coalesce(p_error, 'error desconocido'), 2000)
    where id = p_order_id;
    return jsonb_build_object('ok', false);
  end if;

  -- Ya estaba mandada: no se pisa el id viejo ni se audita dos veces. Puede
  -- pasar si dos personas apretaron el botón a la vez.
  if v_order.sellercloud_order_id is not null then
    return jsonb_build_object(
      'ok', true,
      'already_pushed', true,
      'sellercloud_order_id', v_order.sellercloud_order_id
    );
  end if;

  update public.orders
  set sellercloud_order_id  = p_sellercloud_order_id,
      sellercloud_pushed_at = now(),
      sellercloud_error     = null
  where id = p_order_id;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('push_order_sellercloud', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object(
       'sellercloud_order_id', p_sellercloud_order_id,
       'total',                v_order.total,
       'line_count',           jsonb_array_length(v_order.items),
       -- Queda escrito que se mandó On Hold: si mañana aparece una orden
       -- confirmada que nadie recuerda haber tocado, esto dice de dónde salió.
       'status',               'on_hold'
     ));

  return jsonb_build_object(
    'ok', true,
    'already_pushed', false,
    'sellercloud_order_id', p_sellercloud_order_id
  );
end;
$$;

revoke execute on function public.mark_order_sellercloud(uuid, integer, text) from public;
grant execute on function public.mark_order_sellercloud(uuid, integer, text) to authenticated;

-- ---------- Comprobación rápida (no escribe nada) ----------
-- select id, sellercloud_order_id, sellercloud_pushed_at, sellercloud_error
-- from public.orders
-- where sellercloud_order_id is not null or sellercloud_error is not null
-- order by created_at desc limit 20;
