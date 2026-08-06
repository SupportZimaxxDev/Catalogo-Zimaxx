-- 2026-08-04: listas de precio COMPARTIDAS entre varias vendedoras.
--
-- Contexto (a pedido del usuario): la lista `luzmar` es "personal" — tiene
-- una dueña (`price_lists.owner_vendedora_id`, migration-2026-07-09-luzmar-
-- owner-link.sql) y el trigger `clients_enforce_owner_vendedora` garantiza
-- que cualquier cliente con esa lista quede asignado a ella. El usuario
-- necesita que esa misma lista la puedan usar **Luzmar y otra vendedora**, y
-- nadie más. Con una sola columna uuid eso era imposible: o se transfería la
-- lista (Luzmar la perdía) o se le soltaba el candado (la veían TODAS).
--
-- Solución: `price_lists.owner_vendedora_id` (una dueña) se reemplaza por la
-- tabla `price_list_owners` (N dueñas por lista), y todas las reglas que
-- dependían de la columna pasan a consultar esa tabla. Una lista puede quedar
-- en tres estados:
--
--   * sin dueñas    → lista general, la ve y la usa cualquier vendedora
--                     (como hoy `owner_vendedora_id is null`)
--   * una dueña     → lista personal, idéntico comportamiento al de hoy
--   * varias dueñas → lista compartida: solo esas vendedoras la ven en la
--                     matriz de Precios y en los selectores de lista, y un
--                     cliente con esa lista tiene que quedar asignado a UNA
--                     de ellas (cuál, lo elige quien carga el cliente)
--
-- `is_primary` marca la dueña **principal** (una sola por lista, índice único
-- parcial): es la que se asigna por defecto cuando un cliente entra a la
-- lista sin una dueña válida — ej. el admin mueve a un cliente de Maria a la
-- lista compartida. Sin ese default habría que elegir a mano en cada camino
-- de escritura (Excel, sync, RPC) y cualquier olvido tiraría una excepción;
-- con él, el comportamiento cuando hay una sola dueña es exactamente el de
-- hoy y nada se rompe.
--
-- **Al final del archivo está el query para agregar la segunda dueña** — la
-- migración sola no cambia nada funcional: deja a Luzmar como única dueña de
-- su lista, igual que antes.
--
-- Requiere: `migration-2026-07-09-luzmar-owner-link.sql` (crea la columna que
-- se migra acá) y `migration-2026-07-14-client-admin-actions.sql` (crea
-- `reassign_client`, que se reescribe acá). **Reemplaza por completo a
-- `migration-2026-07-15-restrict-vendedora-luzmar.sql`**: si esa nunca se
-- corrió (estaba pendiente), no hace falta correrla — esta deja las policies
-- equivalentes, ya adaptadas a varias dueñas.
--
-- Transacción explícita porque al final se DROPEA la columna vieja: si algo
-- falla antes, no queda a medio camino.
set lock_timeout = '10s';

begin;

-- ---------- 1) Tabla de dueñas ----------
create table if not exists public.price_list_owners (
  price_list_id uuid        not null references public.price_lists (id) on delete cascade,
  vendedora_id  uuid        not null references public.vendedores (id) on delete cascade,
  is_primary    boolean     not null default false,
  created_at    timestamptz not null default now(),
  primary key (price_list_id, vendedora_id)
);

-- Una sola dueña principal por lista.
create unique index if not exists price_list_owners_primary_key
  on public.price_list_owners (price_list_id) where is_primary;

create index if not exists price_list_owners_vendedora_idx
  on public.price_list_owners (vendedora_id);

-- ---------- 2) Migrar la dueña que ya existía ----------
-- La que estaba en la columna pasa a ser la dueña principal. Idempotente:
-- re-correr no duplica ni degrada a is_primary = false.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'price_lists'
      and column_name = 'owner_vendedora_id'
  ) then
    insert into public.price_list_owners (price_list_id, vendedora_id, is_primary)
    select id, owner_vendedora_id, true
    from public.price_lists
    where owner_vendedora_id is not null
    on conflict (price_list_id, vendedora_id) do update set is_primary = true;
  end if;
end $$;

-- ---------- 3) Helpers ----------
-- SECURITY DEFINER a propósito: los usan las policies RLS de `price_lists` y
-- el trigger de `clients`, así que no pueden depender de que quien pregunta
-- tenga permiso de leer `price_list_owners` (si no, la policy se muerde la
-- cola). Mismo criterio que `is_admin()`/`current_vendedora_id()`.
create or replace function public.price_list_has_owners(p_price_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.price_list_owners where price_list_id = p_price_list_id
  );
$$;

create or replace function public.is_price_list_owner(p_price_list_id uuid, p_vendedora_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_vendedora_id is not null and exists (
    select 1 from public.price_list_owners
    where price_list_id = p_price_list_id and vendedora_id = p_vendedora_id
  );
$$;

-- Dueña principal de la lista (null si la lista no tiene dueñas). El order by
-- cubre el caso raro de que ninguna esté marcada como principal.
create or replace function public.price_list_primary_owner(p_price_list_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select vendedora_id
  from public.price_list_owners
  where price_list_id = p_price_list_id
  order by is_primary desc, created_at, vendedora_id
  limit 1;
$$;

-- ¿La vendedora logueada puede usar esta lista? (general, o es una de sus
-- dueñas.) Es la regla que aplican las policies de abajo.
create or replace function public.can_vendedora_use_price_list(p_price_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not public.price_list_has_owners(p_price_list_id)
      or public.is_price_list_owner(p_price_list_id, public.current_vendedora_id());
$$;

revoke execute on function public.price_list_primary_owner(uuid) from public;
grant execute on function public.price_list_has_owners(uuid) to authenticated;
grant execute on function public.is_price_list_owner(uuid, uuid) to authenticated;
grant execute on function public.can_vendedora_use_price_list(uuid) to authenticated;

-- ---------- 4) RLS de price_list_owners ----------
alter table public.price_list_owners enable row level security;

drop policy if exists admin_all on public.price_list_owners;
create policy admin_all on public.price_list_owners
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Una vendedora ve las filas de las listas que puede usar (así el panel sabe
-- con quién comparte su lista). No puede escribir: agregar o quitar dueñas es
-- acción de admin.
drop policy if exists vendedora_select_price_list_owners on public.price_list_owners;
create policy vendedora_select_price_list_owners on public.price_list_owners
  for select to authenticated
  using (
    public.is_vendedora()
    and public.can_vendedora_use_price_list(price_list_id)
  );

-- ---------- 5) Trigger: el cliente queda con una de las dueñas ----------
-- Reemplaza la versión de migration-2026-07-09-luzmar-owner-link.sql, que
-- pisaba `vendedora_id` con la única dueña posible. Ahora:
--
--   * lista sin dueñas    → no se toca nada
--   * la vendedora que viene YA es dueña → se respeta (esto es lo que permite
--     mover un cliente entre las dueñas de una lista compartida)
--   * si no → se fuerza la dueña principal (con una sola dueña, el
--     comportamiento es idéntico al de antes)
--
-- Corre en TODO insert/update, igual que la versión vieja. Una primera
-- versión de esta función se salteaba los updates que no tocaban
-- `price_list_id`/`vendedora_id` (un cambio de nombre no tiene por qué
-- reescribir la asignación) — se descartó porque rompía el arreglo de datos:
-- al quitarle una dueña a una lista compartida, sus clientes quedaban
-- asignados a alguien que ya no es dueña y ninguna escritura posterior los
-- corregía. Con la regla "si ya es dueña se respeta", que corra siempre no
-- pisa nada legítimo: solo endereza las filas que quedaron inconsistentes.
create or replace function public.enforce_owner_vendedora()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.price_list_id is null then
    return new;
  end if;

  if not public.price_list_has_owners(new.price_list_id) then
    return new;
  end if;

  if public.is_price_list_owner(new.price_list_id, new.vendedora_id) then
    return new;
  end if;

  new.vendedora_id := public.price_list_primary_owner(new.price_list_id);
  return new;
end;
$$;

drop trigger if exists clients_enforce_owner_vendedora on public.clients;
create trigger clients_enforce_owner_vendedora
  before insert or update on public.clients
  for each row execute function public.enforce_owner_vendedora();

-- ---------- 6) RLS de price_lists / product_prices ----------
-- Misma intención que migration-2026-07-15-restrict-vendedora-luzmar.sql
-- (pendiente de correr, ya no hace falta): una vendedora ve las listas
-- generales y las suyas, no las de otra. Lo nuevo es que "suya" ahora puede
-- ser compartida con otra vendedora.
drop policy if exists vendedora_select_readonly on public.price_lists;
drop policy if exists vendedora_select_price_lists on public.price_lists;
create policy vendedora_select_price_lists on public.price_lists
  for select to authenticated
  using (
    public.is_vendedora()
    and public.can_vendedora_use_price_list(id)
  );

drop policy if exists vendedora_select_readonly on public.product_prices;
drop policy if exists vendedora_select_product_prices on public.product_prices;
create policy vendedora_select_product_prices on public.product_prices
  for select to authenticated
  using (
    public.is_vendedora()
    and public.can_vendedora_use_price_list(price_list_id)
  );

-- ---------- 7) reassign_client: permitir mover entre las dueñas ----------
-- Antes rechazaba de plano cualquier cliente con lista personal (el trigger
-- lo revertiría igual). Ahora, con una lista compartida, reasignar ENTRE sus
-- dueñas es justamente lo que hay que poder hacer; a una vendedora que no es
-- dueña sigue prohibido.
create or replace function public.reassign_client(p_client_id uuid, p_vendedora_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   public.clients%rowtype;
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

  -- Destino válido (null = sin asignar, permitido salvo lista con dueñas).
  if p_vendedora_id is not null
     and not exists (select 1 from public.vendedores where id = p_vendedora_id) then
    raise exception 'la vendedora destino no existe';
  end if;

  if public.price_list_has_owners(v_client.price_list_id)
     and not public.is_price_list_owner(v_client.price_list_id, p_vendedora_id) then
    raise exception 'el cliente tiene una lista con dueña: solo se puede reasignar entre las vendedoras dueñas de esa lista';
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

-- ---------- 8) update_client_price_list: candado por dueñas ----------
-- Mismo cuerpo de 2026-07-15, con el chequeo de lista ajena pasado a los
-- helpers (antes comparaba `owner_vendedora_id` contra current_vendedora_id).
create or replace function public.update_client_price_list(p_client_id uuid, p_price_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   public.clients%rowtype;
  v_old_list public.price_lists%rowtype;
  v_new_list public.price_lists%rowtype;
  v_email    text;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

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

  -- Una vendedora (no admin) no puede asignar una lista con dueñas si no es
  -- una de ellas — mismo candado que aplica selectablePriceLists en el
  -- frontend, reforzado acá server-side.
  if not public.is_admin()
     and public.price_list_has_owners(p_price_list_id)
     and not public.is_price_list_owner(p_price_list_id, public.current_vendedora_id()) then
    raise exception 'no podés asignar esa lista';
  end if;

  select * into v_old_list from public.price_lists where id = v_client.price_list_id;
  select email into v_email from auth.users where id = auth.uid();

  update public.clients set price_list_id = p_price_list_id where id = p_client_id;
  -- El trigger clients_enforce_owner_vendedora corre acá mismo: si la lista
  -- nueva tiene dueñas y la vendedora actual del cliente no es una de ellas,
  -- lo pasa a la dueña principal.

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

-- ---------- 9) Chau columna vieja ----------
-- Ya está migrada a price_list_owners y ninguna policy/función la usa. Se
-- borra para que no queden dos fuentes de verdad (un lector que se olvide de
-- la tabla nueva y siga leyendo la columna vería "lista general" y saltearía
-- el candado). Si algún código quedó leyéndola, va a fallar fuerte y claro
-- en vez de silenciosamente.
alter table public.price_lists drop column if exists owner_vendedora_id;

commit;

-- ---------- CÓMO AGREGAR LA SEGUNDA DUEÑA ----------
-- La migración de arriba NO cambia nada funcional: deja a Luzmar como única
-- dueña (principal) de su lista. Para compartirla, correr esto aparte,
-- reemplazando el nombre:
--
-- insert into public.price_list_owners (price_list_id, vendedora_id, is_primary)
-- select pl.id, v.id, false
-- from public.price_lists pl, public.vendedores v
-- where pl.code = 'luzmar'
--   and lower(v.name) = lower('NOMBRE EXACTO DE LA OTRA VENDEDORA')
-- on conflict (price_list_id, vendedora_id) do nothing;
--
-- Si no inserta ninguna fila, el nombre no coincide — verlos con:
-- select id, name from public.vendedores order by name;
--
-- Para QUITAR una dueña:
-- delete from public.price_list_owners
-- where price_list_id = (select id from public.price_lists where code = 'luzmar')
--   and vendedora_id  = (select id from public.vendedores where lower(name) = lower('NOMBRE'));
--
-- Ojo: los clientes que ya estaban asignados a esa vendedora NO se mueven
-- solos (a propósito: a dónde van es decisión del admin). Para pasarlos a la
-- dueña principal de la lista:
-- update public.clients c
-- set vendedora_id = public.price_list_primary_owner(c.price_list_id)
-- where c.price_list_id = (select id from public.price_lists where code = 'luzmar')
--   and not public.is_price_list_owner(c.price_list_id, c.vendedora_id);
--
-- Para ver si quedó alguno inconsistente (debe devolver 0 filas):
-- select c.name, v.name as vendedora
-- from public.clients c
-- left join public.vendedores v on v.id = c.vendedora_id
-- where public.price_list_has_owners(c.price_list_id)
--   and not public.is_price_list_owner(c.price_list_id, c.vendedora_id);
--
-- Para cambiar cuál es la principal (las dos sentencias juntas):
-- update public.price_list_owners set is_primary = false
--   where price_list_id = (select id from public.price_lists where code = 'luzmar');
-- update public.price_list_owners set is_primary = true
--   where price_list_id = (select id from public.price_lists where code = 'luzmar')
--     and vendedora_id  = (select id from public.vendedores where lower(name) = lower('NOMBRE'));

-- ---------- Verificación ----------
-- Quién es dueña de qué:
-- select pl.code, pl.label, v.name as duena, o.is_primary
-- from public.price_list_owners o
-- join public.price_lists pl on pl.id = o.price_list_id
-- join public.vendedores  v  on v.id  = o.vendedora_id
-- order by pl.code, o.is_primary desc, v.name;
--
-- Clientes de la lista compartida y con qué vendedora quedaron (todos tienen
-- que estar con una de las dueñas):
-- select c.name, v.name as vendedora
-- from public.clients c
-- left join public.vendedores v on v.id = c.vendedora_id
-- where c.price_list_id = (select id from public.price_lists where code = 'luzmar')
-- order by v.name, c.name;
--
-- Las policies quedaron (el SQL Editor corre como postgres, así que
-- is_vendedora() da false y no aplican ahí — probar en la app con un login de
-- vendedora que NO sea dueña y confirmar que no ve la lista en Precios):
-- select tablename, policyname from pg_policies
-- where tablename in ('price_lists', 'product_prices', 'price_list_owners')
-- order by tablename, policyname;
