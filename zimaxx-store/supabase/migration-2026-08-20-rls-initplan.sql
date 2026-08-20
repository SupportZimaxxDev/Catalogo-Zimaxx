-- ============================================================
-- 2026-08-20: las policies RLS dejan de llamar funciones POR FILA
--
-- Contexto (análisis de rendimiento de hoy, medido EN PRODUCCIÓN). La query
-- más cara de todo el sistema era el badge de "pedidos nuevos" del panel:
-- contar 647 pedidos tardaba 770 ms promedio (5,423 llamadas acumuladas), y
-- cada página de product_prices ~850-1,050 ms. Un EXPLAIN ANALYZE como rol
-- authenticated mostró el porqué: de 245 ms, 230 se iban en el SubPlan de la
-- policy de orders, que recorre clients evaluando
-- `current_vendedora_id()` e `is_admin()` UNA VEZ POR CADA UNA de las 2,000
-- filas — son funciones SECURITY DEFINER, Postgres no puede inlinearlas ni
-- cachearlas, y cada llamada ejecuta sus propios EXISTS.
--
-- El costo crece LINEAL con clients + orders + product_prices: a ~5-10k filas
-- los reads del panel chocan con el statement_timeout de 8 s. El arreglo es
-- el patrón estándar de Supabase: envolver cada llamada sin argumentos en un
-- sub-select escalar — `(select is_admin())` en vez de `is_admin()` — para
-- que el planner la convierta en un InitPlan que se evalúa UNA vez por query
-- y se compara como constante fila a fila.
--
-- La excepción es `can_vendedora_use_price_list(price_list_id)`: recibe la
-- columna de la fila, así que no puede ser InitPlan. Se reemplaza en las
-- policies por pertenencia a un conjunto — `price_list_id in (select
-- vendedora_usable_price_list_ids())` — donde la función nueva (SECURITY
-- DEFINER, misma semántica: listas sin dueñas + listas donde la vendedora
-- actual es dueña) se ejecuta UNA vez y el resultado se hashea. NO se puede
-- inlinear la lógica directo en la policy: leería price_list_owners BAJO SU
-- PROPIO RLS (que es circular con esta regla) en vez de saltarlo como hace
-- la función DEFINER — cambiaría el comportamiento.
--
-- QUÉ NO CAMBIA: la semántica de las 25 policies es EXACTAMENTE la misma
-- (verificado con un snapshot de visibilidad por persona antes/después en un
-- cluster desechable, ver el pie). Solo cambia cuántas veces se evalúan las
-- funciones. `can_vendedora_use_price_list` queda viva (no la usa más
-- ninguna policy, pero es API pública con grant y podría llamarla algo más).
--
-- OJO con schema.sql: sigue teniendo las policies en la forma vieja (lenta).
-- Si algún día se re-corre schema.sql entero sobre esta base, las policies
-- vuelven a la forma lenta (mismo comportamiento, peor rendimiento) — basta
-- re-correr esta migración después. La fuente de verdad del rendimiento es
-- esta migración.
--
-- También se agrega el índice parcial del badge de pedidos nuevos: es la
-- query que se ejecuta en CADA cambio de pestaña del panel.
--
-- EXECUTE de las funciones en policies: se chequea contra el rol que hace la
-- consulta (authenticated), igual que en los triggers — por eso la función
-- nueva lleva grant explícito a authenticated (misma lección que
-- is_noncatalog_sku, 2026-08-13).
--
-- Idempotente (drop policy if exists + create). Aditiva en comportamiento:
-- se puede correr antes o después del deploy del frontend — el frontend no
-- cambia nada respecto de RLS.
--
-- REQUIERE (preflight abajo): los helpers de rol y las tablas de listas con
-- dueñas (migration-2026-08-04-shared-price-lists.sql).
-- ============================================================
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.is_superadmin()') is null
     or to_regprocedure('public.is_vendedora()') is null
     or to_regprocedure('public.current_vendedora_id()') is null then
    raise exception 'Faltan los helpers de rol (is_admin/is_superadmin/is_vendedora/current_vendedora_id)';
  end if;
  if to_regclass('public.price_list_owners') is null then
    raise exception 'Falta correr migration-2026-08-04-shared-price-lists.sql (crea price_list_owners) antes de esta';
  end if;
end $$;

begin;

-- ---------- 1) El conjunto de listas usables, una sola vez por query ----------
-- Reemplaza a can_vendedora_use_price_list(id) DENTRO de las policies (la
-- función vieja queda viva). SECURITY DEFINER a propósito: lee
-- price_list_owners entera, sin el RLS circular de esa tabla. Devuelve las
-- listas generales (sin dueñas) más las que la vendedora logueada tiene como
-- dueña — exactamente lo que la función vieja contestaba fila por fila.
create or replace function public.vendedora_usable_price_list_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select pl.id
  from public.price_lists pl
  where not exists (
          select 1 from public.price_list_owners o
          where o.price_list_id = pl.id
        )
     or exists (
          select 1 from public.price_list_owners o
          where o.price_list_id = pl.id
            and o.vendedora_id = public.current_vendedora_id()
        );
$$;

revoke execute on function public.vendedora_usable_price_list_ids() from public, anon;
grant execute on function public.vendedora_usable_price_list_ids() to authenticated;

comment on function public.vendedora_usable_price_list_ids() is
  'Listas de precio que la vendedora logueada puede usar (sin dueñas, o ella es dueña). La usan las policies de price_lists/product_prices/price_list_owners como conjunto hasheado — una ejecución por query, en vez de can_vendedora_use_price_list() por fila (2026-08-20).';

-- ---------- 2) Las 25 policies, recreadas en forma InitPlan ----------
-- Misma tabla, mismo nombre, mismo comando, mismo rol y misma semántica que
-- las vivas en producción (dump de pg_policies del 2026-08-20): lo ÚNICO que
-- cambia es (select f()) en lugar de f().

-- ····· admin_audit_log ·····
drop policy if exists admin_read_audit on public.admin_audit_log;
create policy admin_read_audit on public.admin_audit_log
  for select to authenticated
  using ((select public.is_admin()));

-- ····· admins ·····
drop policy if exists admin_read_only on public.admins;
create policy admin_read_only on public.admins
  for select to authenticated
  using ((select public.is_admin()));

drop policy if exists superadmin_all on public.admins;
create policy superadmin_all on public.admins
  for all to authenticated
  using ((select public.is_superadmin()))
  with check ((select public.is_superadmin()));

-- ····· clients ·····
drop policy if exists admin_all on public.clients;
create policy admin_all on public.clients
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists vendedora_insert_own_clients on public.clients;
create policy vendedora_insert_own_clients on public.clients
  for insert to authenticated
  with check (vendedora_id = (select public.current_vendedora_id()));

drop policy if exists vendedora_select_own_clients on public.clients;
create policy vendedora_select_own_clients on public.clients
  for select to authenticated
  using (vendedora_id = (select public.current_vendedora_id()));

-- ····· flash_sales (LEGADO, pero con RLS vivo) ·····
drop policy if exists admin_all on public.flash_sales;
create policy admin_all on public.flash_sales
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists vendedora_select_readonly on public.flash_sales;
create policy vendedora_select_readonly on public.flash_sales
  for select to authenticated
  using ((select public.is_vendedora()));

-- ····· order_failures ·····
drop policy if exists admin_read_failures on public.order_failures;
create policy admin_read_failures on public.order_failures
  for select to authenticated
  using ((select public.is_admin()));

-- El IN sigue siendo un SubPlan hasheado (una pasada por clients), pero ahora
-- el filtro interno compara contra el InitPlan en vez de llamar la función
-- por cada fila de clients — que era donde se iban 230 de los 245 ms.
drop policy if exists vendedora_read_own_failures on public.order_failures;
create policy vendedora_read_own_failures on public.order_failures
  for select to authenticated
  using (client_id in (
    select id from public.clients
    where vendedora_id = (select public.current_vendedora_id())
  ));

-- ····· orders ·····
drop policy if exists admin_all on public.orders;
create policy admin_all on public.orders
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists vendedora_select_own_orders on public.orders;
create policy vendedora_select_own_orders on public.orders
  for select to authenticated
  using (client_id in (
    select id from public.clients
    where vendedora_id = (select public.current_vendedora_id())
  ));

drop policy if exists vendedora_update_own_orders on public.orders;
create policy vendedora_update_own_orders on public.orders
  for update to authenticated
  using (client_id in (
    select id from public.clients
    where vendedora_id = (select public.current_vendedora_id())
  ))
  with check (client_id in (
    select id from public.clients
    where vendedora_id = (select public.current_vendedora_id())
  ));

-- ····· price_list_owners ·····
drop policy if exists admin_read_only on public.price_list_owners;
create policy admin_read_only on public.price_list_owners
  for select to authenticated
  using ((select public.is_admin()));

drop policy if exists superadmin_all on public.price_list_owners;
create policy superadmin_all on public.price_list_owners
  for all to authenticated
  using ((select public.is_superadmin()))
  with check ((select public.is_superadmin()));

drop policy if exists vendedora_select_price_list_owners on public.price_list_owners;
create policy vendedora_select_price_list_owners on public.price_list_owners
  for select to authenticated
  using ((select public.is_vendedora())
         and price_list_id in (select public.vendedora_usable_price_list_ids()));

-- ····· price_lists ·····
drop policy if exists admin_all on public.price_lists;
create policy admin_all on public.price_lists
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists vendedora_select_price_lists on public.price_lists;
create policy vendedora_select_price_lists on public.price_lists
  for select to authenticated
  using ((select public.is_vendedora())
         and id in (select public.vendedora_usable_price_list_ids()));

-- ····· product_prices ·····
drop policy if exists admin_all on public.product_prices;
create policy admin_all on public.product_prices
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists vendedora_select_product_prices on public.product_prices;
create policy vendedora_select_product_prices on public.product_prices
  for select to authenticated
  using ((select public.is_vendedora())
         and price_list_id in (select public.vendedora_usable_price_list_ids()));

-- ····· products ·····
drop policy if exists admin_all on public.products;
create policy admin_all on public.products
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists vendedora_select_readonly on public.products;
create policy vendedora_select_readonly on public.products
  for select to authenticated
  using ((select public.is_vendedora()));

-- ····· sync_runs ·····
drop policy if exists admin_read_sync_runs on public.sync_runs;
create policy admin_read_sync_runs on public.sync_runs
  for select to authenticated
  using ((select public.is_admin()));

-- ····· vendedores ·····
drop policy if exists admin_all on public.vendedores;
create policy admin_all on public.vendedores
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists vendedora_select_self on public.vendedores;
create policy vendedora_select_self on public.vendedores
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------- 3) Índice parcial del badge de pedidos nuevos ----------
-- `select count(*) from orders where status = 'new'` corre en CADA cambio de
-- pestaña del panel (AdminLayout). Los 'new' son siempre pocos (lo pendiente
-- de atender): el índice parcial deja el count en un index-only scan chico en
-- vez de recorrer la tabla entera, que con los pedidos creciendo ~250 por
-- semana deja de ser gratis.
create index if not exists orders_status_new_idx
  on public.orders (status) where status = 'new';

commit;

-- ============================================================
-- Verificación manual (SQL Editor, no escribe nada)
-- ============================================================
-- 1) Las 25 policies quedaron en forma InitPlan (todas deben tener el
--    sub-select; ninguna debe llamar can_vendedora_use_price_list):
-- select tablename, policyname,
--        (qual is null or qual like '%( SELECT%' or qual like '%(SELECT%') as qual_ok
-- from pg_policies where schemaname = 'public'
-- order by tablename, policyname;
-- select count(*) from pg_policies
-- where schemaname = 'public' and (qual like '%can_vendedora_use%' or with_check like '%can_vendedora_use%');
-- -- esperado: 0
--
-- 2) El plan del badge ya no llama funciones por fila (debe verse "InitPlan"
--    y el filtro comparando contra $N, no is_admin()):
--   set local role authenticated;
--   explain select count(*) from public.orders where status = 'new';
--
-- 3) Qué listas ve una vendedora (suplantando su JWT, igual que en
--    migration-2026-08-06-sa-metrics.sql):
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<UUID-DE-SU-USER>","role":"authenticated"}';
--   select code from public.price_lists order by code;
-- -- esperado: las generales + las suyas, idéntico a antes de la migración.
