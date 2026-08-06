-- ============================================================
-- 2026-08-05: perfil SUPERADMIN
--
-- Contexto (a pedido del usuario): hay acciones que hoy solo se pueden hacer
-- metiéndose en el SQL Editor de Supabase (o en el dashboard de Auth) —
-- hacer admin a alguien, cambiar una contraseña, y desde el 2026-08-04
-- asignar/desasignar una lista de precio a una vendedora
-- (`price_list_owners`). Esta migración las mueve al panel, pero detrás de un
-- rol nuevo: **superadmin**, un solo perfil (support5@firstchoiceonline.com).
--
-- Por qué un rol nuevo y no "que lo haga cualquier admin":
--   * `admins` hoy tiene la policy `admin_all` (for all) — o sea que
--     CUALQUIER admin ya podía, vía API directa, insertar filas ahí y hacer
--     admin a quien quisiera. Nunca hubo UI, así que en la práctica no pasó,
--     pero el permiso estaba. Si además le ponemos UI, el agujero se vuelve
--     un botón. Esta migración le quita a `admins` el `admin_all` y deja la
--     escritura solo para el superadmin (los admins conservan lectura).
--   * Lo mismo con `price_list_owners`: era `admin_all`; ahora escritura solo
--     superadmin, lectura para admin (la necesita `ClientsAdmin.jsx`) y para
--     la vendedora dueña (policy que ya existía, sin cambios).
--
-- Dónde vive la marca de "soy superadmin": tabla `superadmins`, **con RLS
-- activo y sin NINGUNA policy** — nadie la lee ni la escribe desde la app, ni
-- el propio superadmin. A propósito: si la marca viviera en una columna de
-- `admins`, un admin cualquiera (que hasta hoy tenía `admin_all` ahí) podría
-- haberse puesto la corona a sí mismo. Sumar o quitar superadmins es una
-- acción de SQL Editor, y así queda: es la llave maestra, no un permiso más
-- del panel.
--
-- `is_admin()` pasa a ser "está en admins **o** es superadmin": así el
-- superadmin no puede quedarse afuera del panel ni por error (ej. borrándose
-- de `admins` desde la UI nueva) y todas las policies/RPC que ya usaban
-- `is_admin()` lo siguen dejando entrar sin tocarlas una por una.
-- `get_my_role()` sigue devolviendo 'admin' para el superadmin — el frontend
-- ya tiene ~6 lugares que comparan `role === 'admin'` para mostrar los
-- controles de edición, y devolver 'superadmin' ahí los habría dejado en modo
-- solo-lectura. El panel pregunta aparte con `is_superadmin()`.
--
-- Todas las acciones nuevas quedan en `admin_audit_log` (misma tabla y misma
-- pestaña Registro de movimientos), vía `sa_log()`: quién (auth.uid() + email
-- real de auth.users), qué, sobre qué y cuándo. Ninguna contraseña se guarda
-- ni se loguea.
--
-- REQUIERE, en este orden, que ya estén corridas:
--   1. migration-2026-07-14-client-admin-actions.sql  (crea admin_audit_log)
--   2. migration-2026-08-04-shared-price-lists.sql    (crea price_list_owners
--      y los helpers price_list_has_owners/is_price_list_owner/
--      price_list_primary_owner)
-- El bloque de preflight de abajo corta con un mensaje claro si falta alguna.
--
-- El cambio de contraseña y el alta de un admin desde cero NO se pueden hacer
-- desde Postgres: crear un usuario de Auth o cambiarle la contraseña necesita
-- la Admin API de GoTrue (service_role). Eso vive en la Edge Function
-- `supabase/functions/superadmin-users` y se apoya en las funciones de acá
-- (`is_superadmin`, `sa_register_new_admin`, `sa_log_password_change`) para
-- que la regla de "solo el superadmin" y la auditoría vivan en un solo lugar.
-- ============================================================

set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regclass('public.admin_audit_log') is null then
    raise exception 'Falta correr migration-2026-07-14-client-admin-actions.sql (crea admin_audit_log) antes de esta';
  end if;
  if to_regclass('public.price_list_owners') is null then
    raise exception 'Falta correr migration-2026-08-04-shared-price-lists.sql (crea price_list_owners) antes de esta';
  end if;
  if to_regprocedure('public.price_list_primary_owner(uuid)') is null then
    raise exception 'Falta correr migration-2026-08-04-shared-price-lists.sql (crea los helpers de dueñas) antes de esta';
  end if;
end $$;

begin;

-- ---------- 1) Tabla de superadmins ----------
create table if not exists public.superadmins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- RLS activo y CERO policies: desde la app esta tabla no existe. Solo la leen
-- las funciones SECURITY DEFINER (que corren como el dueño y saltan RLS) y el
-- SQL Editor. El revoke es cinturón + tirantes: en Supabase, anon/
-- authenticated reciben privilegios por default sobre las tablas nuevas de
-- `public`, y aunque RLS ya alcanzaría para bloquearlos, acá no hay ningún
-- caso de uso legítimo para que tengan el privilegio.
alter table public.superadmins enable row level security;
revoke all on table public.superadmins from anon, authenticated;

-- Semilla: el único superadmin. Si el email cambia o hace falta otro, se
-- agrega desde el SQL Editor (ver el final del archivo).
do $$
declare
  v_count int;
begin
  insert into public.superadmins (user_id)
  select id from auth.users where lower(email) = lower('support5@firstchoiceonline.com')
  on conflict do nothing;

  select count(*) into v_count from public.superadmins;
  if v_count = 0 then
    raise exception 'No existe ningún usuario en auth.users con el email support5@firstchoiceonline.com: creá ese usuario (Authentication -> Users) y volvé a correr esta migración, o cambiá el email de la semilla';
  end if;
end $$;

-- ---------- 2) Helper: es superadmin ----------
create or replace function public.is_superadmin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.superadmins where user_id = auth.uid());
$$;

revoke execute on function public.is_superadmin() from public, anon;
grant execute on function public.is_superadmin() to authenticated;

-- ---------- 3) is_admin() incluye al superadmin ----------
-- El superadmin es admin por definición: no depende de tener fila en `admins`,
-- así que no hay forma de que se deje afuera del panel con un click.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
      or public.is_superadmin();
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- 4) Policies: quién escribe admins / price_list_owners ----------
-- `admins`: la escritura era `admin_all` (cualquier admin podía nombrar
-- admins vía API). Ahora solo el superadmin escribe; los admins conservan
-- lectura (no la usa el frontend hoy, pero es inofensiva y evita sorpresas si
-- alguna vista futura la necesita).
drop policy if exists admin_all on public.admins;
drop policy if exists superadmin_all on public.admins;
create policy superadmin_all on public.admins
  for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

-- Mismo nombre de policy que usa schema.sql para las dos tablas
-- (`admin_read_only`): si mañana alguien re-corre el schema completo, lo
-- reemplaza en lugar de dejar dos policies equivalentes conviviendo.
drop policy if exists admin_read_only on public.admins;
create policy admin_read_only on public.admins
  for select to authenticated
  using (public.is_admin());

-- `price_list_owners`: misma idea. La lectura de admin sí la usa el frontend
-- (`ClientsAdmin.jsx` pide `price_lists(*, price_list_owners(...))` para saber
-- qué listas tienen dueña), así que se mantiene explícita.
drop policy if exists admin_all on public.price_list_owners;
drop policy if exists superadmin_all on public.price_list_owners;
create policy superadmin_all on public.price_list_owners
  for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

drop policy if exists admin_read_only on public.price_list_owners;
create policy admin_read_only on public.price_list_owners
  for select to authenticated
  using (public.is_admin());

-- La policy de vendedora (vendedora_select_price_list_owners) queda como
-- estaba: ve las filas de las listas que puede usar, sin escribir.

-- ---------- 5) Auditoría de las acciones de superadmin ----------
-- Escribe en la misma `admin_audit_log` que el resto del panel. `client_name`
-- se usa como "objetivo" de la acción (el email del usuario o el nombre de la
-- lista): la columna ya es un snapshot de texto libre y así el Registro de
-- movimientos sigue mostrando algo útil en esa columna y se puede filtrar
-- igual. Sin grant a authenticated: solo la llaman las funciones de abajo.
create or replace function public.sa_log(p_action text, p_target text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_name, detail)
  values
    (p_action, auth.uid(), v_email, p_target, p_detail);
end;
$$;

revoke execute on function public.sa_log(text, text, jsonb) from public, anon, authenticated;

-- ---------- 6) Usuarios y accesos ----------
-- `auth.users` no es legible desde el cliente: esta RPC es la única forma que
-- tiene el panel de listar los accesos existentes con su rol.
create or replace function public.sa_list_users()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede ver los usuarios';
  end if;

  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'user_id',        u.id,
               'email',          u.email,
               'created_at',     u.created_at,
               'last_sign_in_at', u.last_sign_in_at,
               'is_superadmin',  s.user_id is not null,
               'is_admin',       a.user_id is not null,
               'vendedora_id',   v.id,
               'vendedora_name', v.name
             ) order by lower(u.email))
    from auth.users u
    left join public.admins      a on a.user_id = u.id
    left join public.superadmins s on s.user_id = u.id
    left join public.vendedores  v on v.user_id = u.id
    where u.deleted_at is null
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.sa_list_users() from public, anon;
grant execute on function public.sa_list_users() to authenticated;

-- Dar o quitar el rol admin a un usuario que ya existe en Auth.
create or replace function public.sa_set_admin(p_user_id uuid, p_is_admin boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede dar o quitar el rol admin';
  end if;

  select email into v_email from auth.users where id = p_user_id and deleted_at is null;
  if v_email is null then
    raise exception 'usuario no encontrado';
  end if;

  -- Un superadmin es admin por definición (ver is_admin()): quitarle la fila
  -- de `admins` no le sacaría nada y dejaría el panel mostrando un estado que
  -- no es el real.
  if not p_is_admin and exists (select 1 from public.superadmins where user_id = p_user_id) then
    raise exception 'ese usuario es superadmin: su acceso de admin no se puede quitar';
  end if;

  if p_is_admin then
    insert into public.admins (user_id) values (p_user_id) on conflict do nothing;
  else
    delete from public.admins where user_id = p_user_id;
  end if;

  perform public.sa_log(
    'set_admin', v_email,
    jsonb_build_object('target_user_id', p_user_id, 'target_email', v_email, 'granted', p_is_admin)
  );

  return jsonb_build_object('ok', true, 'email', v_email, 'is_admin', p_is_admin);
end;
$$;

revoke execute on function public.sa_set_admin(uuid, boolean) from public, anon;
grant execute on function public.sa_set_admin(uuid, boolean) to authenticated;

-- La llama la Edge Function `superadmin-users` (acción create_admin) con el
-- JWT del superadmin, justo después de crear el usuario de Auth: registra el
-- rol admin y deja la auditoría en una sola fila con su acción propia.
create or replace function public.sa_register_new_admin(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede crear admins';
  end if;

  select email into v_email from auth.users where id = p_user_id and deleted_at is null;
  if v_email is null then
    raise exception 'usuario no encontrado';
  end if;

  insert into public.admins (user_id) values (p_user_id) on conflict do nothing;

  perform public.sa_log(
    'create_admin_user', v_email,
    jsonb_build_object('target_user_id', p_user_id, 'target_email', v_email)
  );

  return jsonb_build_object('ok', true, 'email', v_email);
end;
$$;

revoke execute on function public.sa_register_new_admin(uuid) from public, anon;
grant execute on function public.sa_register_new_admin(uuid) to authenticated;

-- La contraseña la cambia la Edge Function (GoTrue), no Postgres: esta RPC
-- solo deja el rastro. La contraseña nunca se manda ni se guarda acá.
create or replace function public.sa_log_password_change(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede cambiar contraseñas';
  end if;

  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then
    raise exception 'usuario no encontrado';
  end if;

  perform public.sa_log(
    'set_user_password', v_email,
    jsonb_build_object('target_user_id', p_user_id, 'target_email', v_email)
  );

  return jsonb_build_object('ok', true, 'email', v_email);
end;
$$;

revoke execute on function public.sa_log_password_change(uuid) from public, anon;
grant execute on function public.sa_log_password_change(uuid) to authenticated;

-- ---------- 7) Listas de precio: panorama ----------
-- Listas que siembra `schema.sql` y que el código da por existentes
-- (`LIST_ALIASES`/`LIST_ORDER` en PricesUpload.jsx, la detección de 'quote' y
-- 'special' en get_catalog/create_order, los alias de inversión en
-- ClientsAdmin.jsx). No se pueden borrar desde el panel: si se borraran, la
-- próxima corrida de schema.sql las recrearía vacías y el rastro de qué pasó
-- se perdería.
create or replace function public.sa_protected_price_list_codes()
returns text[]
language sql
immutable
as $$
  select array['us_min', 'us_wholesale', 've_min', 've_wholesale', 'special', 'quote', 'luzmar'];
$$;

revoke execute on function public.sa_protected_price_list_codes() from public, anon, authenticated;

-- Todo lo que el panel necesita de un saque: dueñas, cuántos clientes y
-- cuántos precios tiene cada lista, y cuántos clientes quedaron con una
-- vendedora que NO es dueña (el caso que documentaba a mano la migración de
-- listas compartidas). Los conteos se hacen acá y no en el frontend porque
-- `product_prices` pasa las 20,000 filas.
create or replace function public.sa_price_list_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede ver esta información';
  end if;

  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id',      pl.id,
               'code',    pl.code,
               'label',   pl.label,
               'protected', pl.code = any (public.sa_protected_price_list_codes()),
               'clients', (select count(*) from public.clients c where c.price_list_id = pl.id),
               'prices',  (select count(*) from public.product_prices pp where pp.price_list_id = pl.id),
               'owners',  (
                 select coalesce(jsonb_agg(
                          jsonb_build_object(
                            'vendedora_id', v.id,
                            'name',         v.name,
                            'is_primary',   o.is_primary
                          ) order by o.is_primary desc, v.name), '[]'::jsonb)
                 from public.price_list_owners o
                 join public.vendedores v on v.id = o.vendedora_id
                 where o.price_list_id = pl.id
               ),
               'misassigned', (
                 select count(*)
                 from public.clients c
                 where c.price_list_id = pl.id
                   and public.price_list_has_owners(pl.id)
                   and not public.is_price_list_owner(pl.id, c.vendedora_id)
               )
             ) order by pl.code)
    from public.price_lists pl
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.sa_price_list_overview() from public, anon;
grant execute on function public.sa_price_list_overview() to authenticated;

-- ---------- 8) Dueñas de una lista: agregar / quitar / principal ----------
-- Reemplaza los INSERT/DELETE a mano que documentaba el final de
-- migration-2026-08-04-shared-price-lists.sql.
create or replace function public.sa_add_price_list_owner(
  p_price_list_id uuid,
  p_vendedora_id  uuid,
  p_is_primary    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list       public.price_lists%rowtype;
  v_vendedora  text;
  v_first      boolean;
  v_primary    boolean;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede asignar listas de precio';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  select name into v_vendedora from public.vendedores where id = p_vendedora_id;
  if v_vendedora is null then
    raise exception 'vendedora no encontrada';
  end if;

  -- La primera dueña es siempre la principal: una lista con dueñas y sin
  -- principal funcionaría (price_list_primary_owner tiene fallback por
  -- created_at) pero deja el estado ambiguo para el que mire la tabla.
  v_first   := not public.price_list_has_owners(p_price_list_id);
  v_primary := p_is_primary or v_first;

  -- El índice único parcial deja una sola principal por lista: hay que bajar
  -- la anterior antes de subir la nueva.
  if v_primary then
    update public.price_list_owners
      set is_primary = false
      where price_list_id = p_price_list_id and is_primary;
  end if;

  insert into public.price_list_owners (price_list_id, vendedora_id, is_primary)
  values (p_price_list_id, p_vendedora_id, v_primary)
  on conflict (price_list_id, vendedora_id) do update set is_primary = excluded.is_primary;

  perform public.sa_log(
    'add_price_list_owner', v_list.label,
    jsonb_build_object(
      'price_list_id', p_price_list_id,
      'price_list',    v_list.label,
      'code',          v_list.code,
      'vendedora_id',  p_vendedora_id,
      'vendedora',     v_vendedora,
      'is_primary',    v_primary
    )
  );

  -- `misassigned`: si la lista era general y ahora tiene dueña, sus clientes
  -- de otras vendedoras quedan inconsistentes. NO se mueven acá a propósito
  -- (una reasignación masiva silenciosa es justo lo que no se quiere): el
  -- panel avisa y ofrece el botón que llama a sa_sync_price_list_clients.
  return jsonb_build_object(
    'ok', true,
    'vendedora', v_vendedora,
    'is_primary', v_primary,
    'misassigned', (
      select count(*)
      from public.clients c
      where c.price_list_id = p_price_list_id
        and not public.is_price_list_owner(p_price_list_id, c.vendedora_id)
    )
  );
end;
$$;

revoke execute on function public.sa_add_price_list_owner(uuid, uuid, boolean) from public, anon;
grant execute on function public.sa_add_price_list_owner(uuid, uuid, boolean) to authenticated;

create or replace function public.sa_remove_price_list_owner(
  p_price_list_id uuid,
  p_vendedora_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list      public.price_lists%rowtype;
  v_vendedora text;
  v_was_primary boolean;
  v_next      uuid;
  v_next_name text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede desasignar listas de precio';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  select o.is_primary, v.name into v_was_primary, v_vendedora
  from public.price_list_owners o
  join public.vendedores v on v.id = o.vendedora_id
  where o.price_list_id = p_price_list_id and o.vendedora_id = p_vendedora_id;

  if v_vendedora is null then
    raise exception 'esa vendedora no es dueña de esta lista';
  end if;

  delete from public.price_list_owners
  where price_list_id = p_price_list_id and vendedora_id = p_vendedora_id;

  -- Si se fue la principal y quedan dueñas, la más antigua toma el lugar
  -- (misma regla de orden que price_list_primary_owner, pero explícita en la
  -- tabla para que el panel no muestre una lista sin principal).
  if v_was_primary then
    select vendedora_id into v_next
    from public.price_list_owners
    where price_list_id = p_price_list_id
    order by created_at, vendedora_id
    limit 1;

    if v_next is not null then
      update public.price_list_owners
        set is_primary = true
        where price_list_id = p_price_list_id and vendedora_id = v_next;
      select name into v_next_name from public.vendedores where id = v_next;
    end if;
  end if;

  perform public.sa_log(
    'remove_price_list_owner', v_list.label,
    jsonb_build_object(
      'price_list_id',  p_price_list_id,
      'price_list',     v_list.label,
      'code',           v_list.code,
      'vendedora_id',   p_vendedora_id,
      'vendedora',      v_vendedora,
      'new_primary',    v_next_name
    )
  );

  -- Los clientes que tenía asignados NO se mueven solos: si la lista quedó
  -- con otras dueñas, el panel avisa cuántos quedaron colgados y ofrece
  -- pasarlos a la principal. Si la lista quedó sin dueñas, vuelve a ser
  -- general y no hay nada que corregir.
  return jsonb_build_object(
    'ok', true,
    'vendedora', v_vendedora,
    'new_primary', v_next_name,
    'misassigned', (
      select count(*)
      from public.clients c
      where c.price_list_id = p_price_list_id
        and public.price_list_has_owners(p_price_list_id)
        and not public.is_price_list_owner(p_price_list_id, c.vendedora_id)
    )
  );
end;
$$;

revoke execute on function public.sa_remove_price_list_owner(uuid, uuid) from public, anon;
grant execute on function public.sa_remove_price_list_owner(uuid, uuid) to authenticated;

create or replace function public.sa_set_primary_price_list_owner(
  p_price_list_id uuid,
  p_vendedora_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list      public.price_lists%rowtype;
  v_vendedora text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede cambiar la dueña principal';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  select v.name into v_vendedora
  from public.price_list_owners o
  join public.vendedores v on v.id = o.vendedora_id
  where o.price_list_id = p_price_list_id and o.vendedora_id = p_vendedora_id;

  if v_vendedora is null then
    raise exception 'esa vendedora no es dueña de esta lista';
  end if;

  update public.price_list_owners
    set is_primary = false
    where price_list_id = p_price_list_id and is_primary;

  update public.price_list_owners
    set is_primary = true
    where price_list_id = p_price_list_id and vendedora_id = p_vendedora_id;

  perform public.sa_log(
    'set_primary_price_list_owner', v_list.label,
    jsonb_build_object(
      'price_list_id', p_price_list_id,
      'price_list',    v_list.label,
      'code',          v_list.code,
      'vendedora_id',  p_vendedora_id,
      'vendedora',     v_vendedora
    )
  );

  return jsonb_build_object('ok', true, 'vendedora', v_vendedora);
end;
$$;

revoke execute on function public.sa_set_primary_price_list_owner(uuid, uuid) from public, anon;
grant execute on function public.sa_set_primary_price_list_owner(uuid, uuid) to authenticated;

-- Pasa a la dueña principal los clientes de la lista que quedaron con una
-- vendedora que no es dueña. Es la versión con auditoría del UPDATE que la
-- migración de listas compartidas dejaba comentado al final para correr a
-- mano. El trigger clients_enforce_owner_vendedora hace lo mismo en cada
-- escritura, pero solo cuando el cliente se toca por otra razón: esto lo
-- resuelve de una para toda la lista.
create or replace function public.sa_sync_price_list_clients(p_price_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list  public.price_lists%rowtype;
  v_moved int;
  v_owner text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede reasignar los clientes de una lista';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  if not public.price_list_has_owners(p_price_list_id) then
    raise exception 'esa lista no tiene dueñas: es una lista general y sus clientes pueden estar con cualquier vendedora';
  end if;

  update public.clients c
    set vendedora_id = public.price_list_primary_owner(p_price_list_id)
    where c.price_list_id = p_price_list_id
      and not public.is_price_list_owner(p_price_list_id, c.vendedora_id);

  get diagnostics v_moved = row_count;

  select name into v_owner
  from public.vendedores
  where id = public.price_list_primary_owner(p_price_list_id);

  perform public.sa_log(
    'sync_price_list_clients', v_list.label,
    jsonb_build_object(
      'price_list_id', p_price_list_id,
      'price_list',    v_list.label,
      'code',          v_list.code,
      'to_vendedora',  v_owner,
      'moved',         v_moved
    )
  );

  return jsonb_build_object('ok', true, 'moved', v_moved, 'to_vendedora', v_owner);
end;
$$;

revoke execute on function public.sa_sync_price_list_clients(uuid) from public, anon;
grant execute on function public.sa_sync_price_list_clients(uuid) to authenticated;

-- ---------- 9) Listas de precio: crear / renombrar / borrar ----------
-- Crear una lista era hasta hoy un INSERT a mano en el SQL Editor (así
-- nacieron 'quote' y 'luzmar'). El `code` se valida porque es la llave que
-- usan los alias de la carga de precios y la detección de 'quote'/'special'.
create or replace function public.sa_create_price_list(p_code text, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code  text := lower(trim(coalesce(p_code, '')));
  v_label text := trim(coalesce(p_label, ''));
  v_id    uuid;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede crear listas de precio';
  end if;

  if v_code !~ '^[a-z][a-z0-9_]{1,30}$' then
    raise exception 'el código tiene que empezar con una letra y llevar solo minúsculas, números o _ (ej: mayoreo_ve)';
  end if;
  if v_label = '' then
    raise exception 'falta el nombre visible de la lista';
  end if;
  if exists (select 1 from public.price_lists where code = v_code) then
    raise exception 'ya existe una lista con el código %', v_code;
  end if;

  insert into public.price_lists (code, label) values (v_code, v_label) returning id into v_id;

  perform public.sa_log(
    'create_price_list', v_label,
    jsonb_build_object('price_list_id', v_id, 'code', v_code, 'label', v_label)
  );

  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'label', v_label);
end;
$$;

revoke execute on function public.sa_create_price_list(text, text) from public, anon;
grant execute on function public.sa_create_price_list(text, text) to authenticated;

-- Solo el nombre visible. El `code` no se toca nunca: hay código que lo lee
-- (get_catalog/create_order para 'quote', PricesUpload.jsx para los alias) y
-- renombrarlo rompería esos caminos en silencio.
create or replace function public.sa_update_price_list(p_price_list_id uuid, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list  public.price_lists%rowtype;
  v_label text := trim(coalesce(p_label, ''));
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede renombrar listas de precio';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;
  if v_label = '' then
    raise exception 'falta el nombre visible de la lista';
  end if;
  if v_label = v_list.label then
    return jsonb_build_object('ok', true, 'label', v_label);
  end if;

  update public.price_lists set label = v_label where id = p_price_list_id;

  -- 'update_price_list_label' y no 'update_price_list': esa acción ya existe
  -- en admin_audit_log con otro significado (update_client_price_list, cuando
  -- se le cambia la lista a un cliente) y el Registro de movimientos las
  -- mostraría mezcladas.
  perform public.sa_log(
    'update_price_list_label', v_label,
    jsonb_build_object(
      'price_list_id', p_price_list_id,
      'code',          v_list.code,
      'from_label',    v_list.label,
      'to_label',      v_label
    )
  );

  return jsonb_build_object('ok', true, 'label', v_label);
end;
$$;

revoke execute on function public.sa_update_price_list(uuid, text) from public, anon;
grant execute on function public.sa_update_price_list(uuid, text) to authenticated;

-- Borrar es para deshacer un alta con el código mal escrito, nada más: solo
-- listas creadas desde el panel (no las que siembra schema.sql) y solo si
-- están completamente vacías. Sin borrado en cascada de precios ni de dueñas
-- a propósito — si hay algo colgando, el mensaje dice qué y se decide a mano.
create or replace function public.sa_delete_price_list(p_price_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list    public.price_lists%rowtype;
  v_clients int;
  v_prices  int;
  v_owners  int;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede eliminar listas de precio';
  end if;

  select * into v_list from public.price_lists where id = p_price_list_id;
  if not found then
    raise exception 'lista de precio no encontrada';
  end if;

  if v_list.code = any (public.sa_protected_price_list_codes()) then
    raise exception 'la lista % es una de las listas base del sistema y no se puede eliminar', v_list.code;
  end if;

  select count(*) into v_clients from public.clients where price_list_id = p_price_list_id;
  if v_clients > 0 then
    raise exception 'la lista tiene % cliente(s) asignado(s): pasalos a otra lista antes de eliminarla', v_clients;
  end if;

  select count(*) into v_prices from public.product_prices where price_list_id = p_price_list_id;
  if v_prices > 0 then
    raise exception 'la lista tiene % precio(s) cargado(s): vaciala antes de eliminarla', v_prices;
  end if;

  select count(*) into v_owners from public.price_list_owners where price_list_id = p_price_list_id;
  if v_owners > 0 then
    raise exception 'la lista tiene % dueña(s) asignada(s): quitalas antes de eliminarla', v_owners;
  end if;

  delete from public.price_lists where id = p_price_list_id;

  perform public.sa_log(
    'delete_price_list', v_list.label,
    jsonb_build_object('price_list_id', p_price_list_id, 'code', v_list.code, 'label', v_list.label)
  );

  return jsonb_build_object('ok', true, 'code', v_list.code);
end;
$$;

revoke execute on function public.sa_delete_price_list(uuid) from public, anon;
grant execute on function public.sa_delete_price_list(uuid) to authenticated;

commit;

-- ============================================================
-- Después de correr esto
-- ============================================================
-- 1. Desplegar la Edge Function del cambio de contraseña / alta de admin
--    (una sola vez, desde `zimaxx-store/`):
--
--      supabase functions deploy superadmin-users
--
--    Sin eso, el panel funciona igual salvo esos dos botones (avisan con el
--    error que devuelve la invocación).
-- 2. Entrar a /admin con support5@firstchoiceonline.com: aparece la pestaña
--    🔐 Superadmin. Con cualquier otro admin NO aparece, y entrar por
--    /admin/superadmin redirige a Productos.
--
-- ---------- Sumar o quitar un superadmin (solo SQL Editor) ----------
-- A propósito no hay UI: es la llave maestra.
--
-- insert into public.superadmins (user_id)
-- select id from auth.users where lower(email) = lower('OTRO@EMAIL.COM')
-- on conflict do nothing;
--
-- delete from public.superadmins
-- where user_id = (select id from auth.users where lower(email) = lower('OTRO@EMAIL.COM'));
--
-- ---------- Verificación ----------
-- Quién es superadmin:
-- select u.email, s.created_at from public.superadmins s join auth.users u on u.id = s.user_id;
--
-- Quién es admin (el superadmin puede no tener fila acá y entrar igual):
-- select u.email from public.admins a join auth.users u on u.id = a.user_id order by u.email;
--
-- Policies de las dos tablas que cambiaron (admins debe tener superadmin_all
-- + admin_read_admins, y NO admin_all):
-- select tablename, policyname, cmd from pg_policies
-- where tablename in ('admins', 'price_list_owners', 'superadmins')
-- order by tablename, policyname;
--
-- Ojo al probar en el SQL Editor: corre como `postgres`, así que auth.uid()
-- es null y `is_superadmin()` da false — las RPC sa_* van a tirar "solo el
-- superadmin puede...". Es lo esperado: se prueban desde el panel, logueado.
