-- Ficha SellerCloud del cliente: empresa, grupo, account manager, salesman y
-- comentarios (2026-09-09, a pedido del usuario: "el cliente se debe crear con
-- los siguientes campos: business name, customer group, account manager,
-- salesmen y comments"). Hasta hoy el alta en SellerCloud mandaba solo
-- nombre/apellido/email y el teléfono en un segundo paso; el customer nacía
-- sin grupo, sin account manager, sin salesman y sin el comentario que el
-- negocio usa para marcar el tipo de cliente (Mayorista/Minorista/...).
--
-- Contrato de la API (Swagger real del servidor, /rest/swagger/docs/v1):
--   * POST /Customers (CreateCustomerRequest) acepta BusinessName.
--   * PUT  /Customers/{id} (UpdateCustomerRequest) acepta BusinessName,
--     AccountManager1Id (int), Salesman (texto), Comments (texto), Phone1.
--   * POST /Customers/CustomersGroups/{groupId}/Customers {CustomersIDs:[..]}
--     agrega el customer a un grupo. NO hay endpoint para listar grupos ni
--     para quitar de un grupo, ni para listar empleados (account managers).
--
-- Lo que se vio en los datos reales (export de 887 customers, 2026-09-09):
--   * El AccountManagerId de cada customer ES el ID de empleado de su
--     vendedora — el mismo número que ya vive en vendedores.sellercloud_rep_id
--     (verificado contra producción: 75427/79963/75429/75439/... coinciden
--     uno a uno). Por eso NO hay columna nueva de account manager por
--     vendedora: el account manager de un cliente se elige entre las
--     vendedoras con rep_id cargado.
--   * Cada vendedora tiene UN grupo de clientes ("Clientes <Vendedora>",
--     IDs 3..21). Como la API no los lista, el mapeo vive acá:
--     vendedores.sellercloud_group_id / sellercloud_group_name (editable en
--     la pestaña Vendedoras), sembrado abajo para las vendedoras conocidas.
--   * SalesMan es texto libre = el nombre de la vendedora.
--   * Comment es texto libre con el tipo de cliente: Mayorista (439),
--     Minorista (279), Inactive (63), Distribuidor (35), Zimaxx Box (12),
--     Zimaxx Plus, Por definir... con typos varios. Se guarda tal cual; el
--     panel sugiere los valores canónicos según la lista de precio.
--
-- Piezas:
--   (1) `clients` gana business_name, sc_customer_group_id,
--       sc_customer_group_name, sc_account_manager_id, sc_salesman y
--       sc_comments (todas nullable). Son la FOTO de lo que se mandó (o se
--       va a mandar) a SellerCloud y lo que muestra la vista completa de la
--       tabla de Clientes. Se llenan en el alta (insert directo, RLS) y se
--       editan con la RPC de (3).
--   (2) `vendedores` gana sellercloud_group_id + sellercloud_group_name, con
--       seed para las vendedoras conocidas (solo donde esté en null: re-correr
--       no pisa un valor corregido a mano).
--   (3) RPC `update_client_sc_profile(...)`: edita la ficha, audita como
--       'update_client_sc_profile' (solo las claves que cambiaron), admin
--       cualquiera, vendedora sus clientes Y solo con SU grupo / SU account
--       manager (asignar el account manager de otra es tocar comisiones
--       ajenas — nivel reassign, solo admin). No-op sin cambios = sin fila
--       de auditoría.
--
-- Compatibilidad: aditiva. Puede correr antes del deploy sin romper el
-- frontend viejo (columnas nullable, función nueva). El frontend nuevo sin
-- ella: el alta falla al insertar columnas inexistentes (42703) — por eso
-- esta migración va ANTES del deploy del frontend y del redeploy de la Edge
-- Function sellercloud-customers (que lee las columnas nuevas con fallback
-- al select viejo si no existen).
--
-- Requiere (preflight abajo):
--   * migration-2026-07-10-sellercloud-sync-v2.sql (clients.sellercloud_id).
--   * migration-2026-08-18-sellercloud-salesrep.sql (vendedores.sellercloud_rep_id).
--   * migration-2026-07-14-client-admin-actions.sql (admin_audit_log).
--   * is_vendedora() / current_vendedora_id() (schema.sql).
-- Idempotente: add column if not exists, seed solo sobre null, create or replace.
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
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'vendedores' and column_name = 'sellercloud_rep_id'
  ) then
    faltan := array_append(faltan, 'vendedores.sellercloud_rep_id (migration-2026-08-18-sellercloud-salesrep.sql)');
  end if;
  if to_regclass('public.admin_audit_log') is null then
    faltan := array_append(faltan, 'admin_audit_log (migration-2026-07-14-client-admin-actions.sql)');
  end if;
  if to_regprocedure('public.is_vendedora()') is null then
    faltan := array_append(faltan, 'is_vendedora()');
  end if;
  if to_regprocedure('public.current_vendedora_id()') is null then
    faltan := array_append(faltan, 'current_vendedora_id()');
  end if;
  if array_length(faltan, 1) is not null then
    raise exception 'faltan piezas previas: %', array_to_string(faltan, ' · ');
  end if;
end $$;

-- ---------- (1) Ficha SellerCloud en clients ----------
alter table public.clients
  add column if not exists business_name          text,
  add column if not exists sc_customer_group_id   integer,
  add column if not exists sc_customer_group_name text,
  add column if not exists sc_account_manager_id  integer,
  add column if not exists sc_salesman            text,
  add column if not exists sc_comments            text;

comment on column public.clients.business_name is
  'Nombre de la empresa del cliente. Viaja como BusinessName al crear/actualizar el customer en SellerCloud (General.CorporateName allá). Null = sin empresa (SellerCloud usa el nombre).';
comment on column public.clients.sc_customer_group_id is
  'ID del grupo de clientes de SellerCloud al que se agrega el customer (POST /Customers/CustomersGroups/{id}/Customers). Normalmente el grupo de su vendedora (vendedores.sellercloud_group_id).';
comment on column public.clients.sc_customer_group_name is
  'Nombre del grupo (foto para mostrarlo sin ir a SellerCloud; la API no lista grupos).';
comment on column public.clients.sc_account_manager_id is
  'ID de empleado del account manager en SellerCloud (AccountManager1Id). Es el sellercloud_rep_id de una vendedora.';
comment on column public.clients.sc_salesman is
  'Texto Salesman del customer en SellerCloud (Internal.SalesMan). Normalmente el nombre de la vendedora.';
comment on column public.clients.sc_comments is
  'Texto Comments del customer en SellerCloud (Internal.Comment): el negocio lo usa para el tipo de cliente (Mayorista / Minorista / Distribuidor / Zimaxx Box / Zimaxx Plus).';

-- ---------- (2) Grupo de clientes por vendedora ----------
alter table public.vendedores
  add column if not exists sellercloud_group_id   integer,
  add column if not exists sellercloud_group_name text;

comment on column public.vendedores.sellercloud_group_id is
  'ID del grupo de clientes de esta vendedora en SellerCloud (Customers → Groups). Se propone como grupo al crear un cliente suyo. Null = sin grupo.';
comment on column public.vendedores.sellercloud_group_name is
  'Nombre del grupo (solo display; la API de SellerCloud no permite listarlos).';

-- Seed desde el export real de customers (2026-09-09): grupo observado en
-- los clientes de cada vendedora. Solo donde esté en null, por nombre exacto
-- (lower), y sin crear vendedoras: una que no exista acá simplemente no se
-- siembra.
update public.vendedores v
   set sellercloud_group_id   = s.gid,
       sellercloud_group_name = s.gname
  from (values
    ('adriana montilla',       4,  'Clientes Adriana Montilla'),
    ('daniela bohorquez',      3,  'Clientes Daniela Bohorquez'),
    ('edilmar sanchez',        6,  'Clientes Edilmar Sanchez'),
    ('genesis mercado',        7,  'Genesis Mercado'),
    ('jesus rodriguez',        19, 'Clientes Jesus Rodriguez'),
    ('luzmar quintero',        5,  'Clientes Luzmar Quintero'),
    ('luzmila ernandez',       18, 'Luzmila Ernandez'),
    ('manuela henriquez',      20, 'Clientes Manuela Henriquez'),
    ('maria fernanda sardua',  17, 'Clientes Maria Fernanda Sardua'),
    ('mitsy cordero',          9,  'Clientes Mitsy Cordero'),
    ('nathalie ravelo',        13, 'Clientes Nathalie Ravelo'),
    ('yusleidy romero',        21, 'Clientes Yusleidy Romero')
  ) as s(lname, gid, gname)
 where lower(btrim(v.name)) = s.lname
   and v.sellercloud_group_id is null;

-- ---------- (3) update_client_sc_profile ----------
-- Todos los parámetros son el valor NUEVO completo de la ficha (el form del
-- panel siempre manda los seis). Vacío/null = quitar. Devuelve
-- {ok, changed, changes: [claves que cambiaron]}; el caller usa `changed`
-- para decidir si vale la pena sincronizar con SellerCloud.
create or replace function public.update_client_sc_profile(
  p_client_id           uuid,
  p_business_name       text,
  p_customer_group_id   integer,
  p_customer_group_name text,
  p_account_manager_id  integer,
  p_salesman            text,
  p_comments            text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   public.clients%rowtype;
  v_me       public.vendedores%rowtype;
  v_email    text;
  v_business text := nullif(btrim(coalesce(p_business_name, '')), '');
  v_gname    text := nullif(btrim(coalesce(p_customer_group_name, '')), '');
  v_salesman text := nullif(btrim(coalesce(p_salesman, '')), '');
  v_comments text := nullif(btrim(coalesce(p_comments, '')), '');
  v_gid      integer := p_customer_group_id;
  v_amid     integer := p_account_manager_id;
  v_changes  text[] := '{}';
  v_detail   jsonb := '{}'::jsonb;
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

  if v_gid is not null and v_gid <= 0 then
    raise exception 'el ID del grupo de SellerCloud tiene que ser un entero positivo';
  end if;
  if v_amid is not null and v_amid <= 0 then
    raise exception 'el ID del account manager tiene que ser un entero positivo';
  end if;
  -- Sin grupo no hay nombre de grupo que guardar (evita un nombre huérfano).
  if v_gid is null then
    v_gname := null;
  elsif v_gname is null then
    -- Nombre desde la vendedora que tenga ese grupo, si alguna lo tiene.
    select sellercloud_group_name into v_gname
      from public.vendedores where sellercloud_group_id = v_gid limit 1;
  end if;

  -- Una vendedora solo puede usar SU grupo y SU account manager: asignar el
  -- account manager de otra vendedora es tocar comisiones ajenas (nivel
  -- reassign_client, solo admin). Quitar (null) sí puede.
  if not public.is_admin() then
    select * into v_me from public.vendedores where id = public.current_vendedora_id();
    if v_gid is not null and v_gid is distinct from v_me.sellercloud_group_id then
      raise exception 'solo podés asignar tu propio grupo de SellerCloud';
    end if;
    if v_amid is not null and v_amid is distinct from v_me.sellercloud_rep_id then
      raise exception 'solo podés asignarte a vos misma como account manager';
    end if;
  end if;

  -- Solo lo que cambió va a la auditoría (mismo criterio que el detalle de
  -- update_client_info en el Registro de movimientos).
  if v_business is distinct from v_client.business_name then
    v_changes := array_append(v_changes, 'business_name');
    v_detail := v_detail || jsonb_build_object('from_business_name', v_client.business_name, 'to_business_name', v_business);
  end if;
  if v_gid is distinct from v_client.sc_customer_group_id
     or v_gname is distinct from v_client.sc_customer_group_name then
    v_changes := array_append(v_changes, 'customer_group');
    v_detail := v_detail || jsonb_build_object(
      'from_group_id', v_client.sc_customer_group_id, 'to_group_id', v_gid,
      'from_group_name', v_client.sc_customer_group_name, 'to_group_name', v_gname);
  end if;
  if v_amid is distinct from v_client.sc_account_manager_id then
    v_changes := array_append(v_changes, 'account_manager');
    v_detail := v_detail || jsonb_build_object('from_account_manager_id', v_client.sc_account_manager_id, 'to_account_manager_id', v_amid);
  end if;
  if v_salesman is distinct from v_client.sc_salesman then
    v_changes := array_append(v_changes, 'salesman');
    v_detail := v_detail || jsonb_build_object('from_salesman', v_client.sc_salesman, 'to_salesman', v_salesman);
  end if;
  if v_comments is distinct from v_client.sc_comments then
    v_changes := array_append(v_changes, 'comments');
    v_detail := v_detail || jsonb_build_object('from_comments', v_client.sc_comments, 'to_comments', v_comments);
  end if;

  if coalesce(array_length(v_changes, 1), 0) = 0 then
    return jsonb_build_object('ok', true, 'changed', false, 'changes', '[]'::jsonb);
  end if;

  update public.clients
     set business_name          = v_business,
         sc_customer_group_id   = v_gid,
         sc_customer_group_name = v_gname,
         sc_account_manager_id  = v_amid,
         sc_salesman            = v_salesman,
         sc_comments            = v_comments
   where id = p_client_id;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, detail)
  values
    ('update_client_sc_profile', auth.uid(), v_email, p_client_id, v_client.name,
     v_detail || jsonb_build_object('changes', to_jsonb(v_changes)));

  return jsonb_build_object('ok', true, 'changed', true, 'changes', to_jsonb(v_changes));
end;
$$;

revoke execute on function public.update_client_sc_profile(uuid, text, integer, text, integer, text, text) from public;
grant execute on function public.update_client_sc_profile(uuid, text, integer, text, integer, text, text) to authenticated;

-- ---------- Verificación manual (SQL Editor) ----------
-- Columnas nuevas:
-- select column_name from information_schema.columns
-- where table_name = 'clients' and column_name like 'sc_%' or column_name = 'business_name';
--
-- Grupos sembrados:
-- select name, sellercloud_rep_id, sellercloud_group_id, sellercloud_group_name
-- from public.vendedores order by name;
--
-- La RPC (is_admin()/is_vendedora() dan false en el SQL Editor — probar
-- desde la app). Auditoría después de un cambio real:
-- select client_name, detail from public.admin_audit_log
-- where action = 'update_client_sc_profile' order by created_at desc limit 10;
