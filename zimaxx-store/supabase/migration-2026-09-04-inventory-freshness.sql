-- ============================================================
-- 2026-09-04: frescura de inventario — registro unificado, refresco
-- on-demand y candado en Atendido/push
--
-- Contexto (a pedido del usuario). El stock entra hoy por la carga de Excel
-- de productos (dos veces al día, 8:30 y 16:30) y entre cargas el catálogo
-- queda desalineado con SellerCloud: las vendedoras marcan pedidos Atendidos
-- o los mandan a SellerCloud trabajando con stock viejo. Esta migración es el
-- lado base de datos de cuatro piezas:
--
--   1. `inventory_syncs`: registro unificado de actualizaciones de INVENTARIO
--      (la carga de Excel Y el refresco nuevo escriben acá).
--   2. RPCs del refresco on-demand (`inventory_sync_begin/finish`,
--      `refresh_stock_upsert`) que usa la Edge Function
--      `sellercloud-refresh-stock` — actualiza SOLO stock, por chunks.
--   3. `get_inventory_freshness()`: cuándo fue la última actualización buena
--      y si ya venció el umbral (`stock_freshness_minutes`, default 45,
--      editable solo por superadmin vía `sa_set_stock_freshness`).
--   4. Candado: `update_order_status` rechaza marcar Atendido un pedido real
--      con inventario vencido (errcode ZS001), salvo override explícito de
--      superadmin (auditado como `freshness_override`). El push a SellerCloud
--      tiene el mismo candado en la Edge Function `sellercloud-push-order`
--      (que consulta `get_inventory_freshness` y audita el override con
--      `audit_freshness_override`).
--
-- POR QUÉ UNA TABLA NUEVA Y NO `sync_runs`: sync_runs es la auditoría del
-- sync completo de n8n (productos + precios + clientes, escrita DIRECTO con
-- la service_role key, sin RPCs) y sus columnas hablan de eso
-- (rows_products/rows_prices/rows_clients). Acá se registra otra cosa —
-- corridas de inventario con contadores de stock (actualizados/desactivados/
-- reactivados) y un lock anti-concurrencia con recuperación de corridas
-- colgadas — y las escriben usuarios del panel vía RPC con su JWT. Meter las
-- dos semánticas en una tabla obligaría a n8n y al panel a esquivarse
-- mutuamente; separadas, ninguna puede romper a la otra.
--
-- POR QUÉ NO HAY "LÓGICA DE STOCK" NUEVA: desactivar por stock 0 y reactivar
-- al volver stock viven en el trigger `products_availability_from_stock`
-- (2026-08-12) + `products_enforce_noncatalog` (2026-08-13) — la invariante
-- está EN LA TABLA, no en cada camino de escritura. `refresh_stock_upsert`
-- solo escribe `products.stock` y deja que los triggers decidan, exactamente
-- igual que la carga de Excel (que también escribe stock y deja decidir al
-- trigger). Cero reglas nuevas.
--
-- CANDADO Y COMPATIBILIDAD (expand/contract): el candado NO se activa con
-- solo correr esta migración. La regla de frescura es "sin ninguna corrida
-- exitosa registrada, no hay candado" — y las corridas solo las registran el
-- frontend nuevo (carga de Excel) y las funciones nuevas (refresco). O sea:
--   * migración corrida + frontend viejo → inventory_syncs vacía → candado
--     inactivo → todo sigue funcionando igual que hoy.
--   * El candado se enciende solo cuando el mundo nuevo ya está desplegado y
--     registró su primera corrida.
-- ORDEN DE DEPLOY para que el push no ignore el candado sin saberlo:
--   1) esta migración → 2) `supabase functions deploy sellercloud-push-order`
--   y `... deploy sellercloud-refresh-stock` → 3) deploy del frontend.
--   Si el frontend nuevo saliera ANTES que el push nuevo, la primera carga de
--   Excel registrada activaría el candado de Atendido pero el push viejo lo
--   ignoraría — por eso las funciones van antes que el frontend.
--
-- El candado NO aplica a crear pedidos/cotizaciones, editar ítems, convertir
-- cotización ni al catálogo del cliente: solo a marcar Atendido un pedido
-- real (la transición que descuenta stock) y al push, que son los puntos de
-- contacto con el inventario real.
--
-- REQUIERE que ya estén corridas (el preflight corta si falta algo):
--   * migration-2026-07-14-inventory-stock.sql        (products.stock)
--   * migration-2026-08-12-hide-out-of-stock.sql      (deactivated_by_stock)
--   * migration-2026-08-05-superadmin.sql             (is_superadmin, sa_log)
--   * migration-2026-08-26-fix-apply-order-stock-missing.sql
--                                                     (apply_order_stock)
--   * migration-2026-07-14-client-admin-actions.sql   (admin_audit_log)
--
-- Idempotente, se puede re-correr. lock_timeout corto para fallar rápido y
-- limpio si un lock se traba contra producción.
-- ============================================================
set lock_timeout = '10s';

-- ---------- 0) Preflight ----------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products'
      and column_name = 'stock'
  ) then
    raise exception 'falta products.stock — correr migration-2026-07-14-inventory-stock.sql antes';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products'
      and column_name = 'deactivated_by_stock'
  ) then
    raise exception 'falta products.deactivated_by_stock — correr migration-2026-08-12-hide-out-of-stock.sql antes';
  end if;
  if to_regprocedure('public.is_superadmin()') is null
     or to_regprocedure('public.sa_log(text, text, jsonb)') is null then
    raise exception 'faltan is_superadmin()/sa_log() — correr migration-2026-08-05-superadmin.sql antes';
  end if;
  if to_regprocedure('public.apply_order_stock(uuid, integer)') is null then
    raise exception 'falta apply_order_stock — correr migration-2026-08-26-fix-apply-order-stock-missing.sql antes';
  end if;
  if to_regclass('public.admin_audit_log') is null then
    raise exception 'falta admin_audit_log — correr migration-2026-07-14-client-admin-actions.sql antes';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'admin_audit_log'
      and column_name = 'order_id'
  ) then
    raise exception 'falta admin_audit_log.order_id — correr migration-2026-08-17-sellercloud-push.sql antes';
  end if;
end $$;

begin;

-- ---------- 1) app_settings: configuración editable del proyecto ----------
-- No existía ninguna tabla de settings; se crea con el shape mínimo
-- (key/value jsonb) para que el próximo valor configurable no necesite otra
-- tabla. RLS activo y SIN policies: se lee vía funciones SECURITY DEFINER
-- (get_inventory_freshness expone el umbral al panel) y se escribe solo vía
-- sa_set_stock_freshness — mismo criterio que superadmins/system_logs.
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.app_settings enable row level security;
revoke all on table public.app_settings from anon, authenticated;

-- Umbral de frescura, en minutos. Default pedido: 45.
insert into public.app_settings (key, value)
values ('stock_freshness_minutes', to_jsonb(45))
on conflict (key) do nothing;

-- Lectura del umbral con default duro: si la fila falta o alguien guardó
-- basura, el sistema sigue con 45 en vez de romperse. Sin grant: la llaman
-- solo las funciones de acá (SECURITY DEFINER, corren como el dueño).
create or replace function public.stock_freshness_minutes()
returns int
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v int;
begin
  begin
    select (value #>> '{}')::int into v
    from public.app_settings
    where key = 'stock_freshness_minutes';
  exception when others then
    v := null;
  end;
  return coalesce(v, 45);
end;
$$;

revoke execute on function public.stock_freshness_minutes() from public, anon, authenticated;

-- Editar el umbral: solo superadmin, auditado con sa_log (mismo rastro que el
-- resto de las acciones 🔐). Entre 5 minutos y 24 horas: menos de 5 haría
-- imposible trabajar (ninguna corrida es instantánea) y más de un día ya no
-- es un umbral de frescura, es apagarlo — para eso mejor decirlo explícito.
create or replace function public.sa_set_stock_freshness(p_minutes int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from int;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede cambiar el umbral de frescura de inventario';
  end if;
  if p_minutes is null or p_minutes < 5 or p_minutes > 1440 then
    raise exception 'el umbral tiene que estar entre 5 y 1440 minutos';
  end if;

  v_from := public.stock_freshness_minutes();

  insert into public.app_settings (key, value, updated_at, updated_by)
  values ('stock_freshness_minutes', to_jsonb(p_minutes), now(), auth.uid())
  on conflict (key) do update
    set value = excluded.value, updated_at = now(), updated_by = auth.uid();

  perform public.sa_log(
    'set_stock_freshness', 'stock_freshness_minutes',
    jsonb_build_object('from_minutes', v_from, 'to_minutes', p_minutes)
  );

  return jsonb_build_object('ok', true, 'minutes', p_minutes);
end;
$$;

revoke execute on function public.sa_set_stock_freshness(int) from public, anon;
grant execute on function public.sa_set_stock_freshness(int) to authenticated;

-- ---------- 2) inventory_syncs: registro unificado ----------
-- Una fila por corrida de actualización de inventario, venga de donde venga:
--   * 'excel_upload'   — la carga de Excel de productos del panel, cuando el
--                        archivo trae columna de stock (la registra el
--                        frontend vía inventory_sync_begin/finish).
--   * 'manual_refresh' — el botón "🔄 Refrescar stock" (Edge Function
--                        sellercloud-refresh-stock).
-- El ciclo es running → ok/error. Una corrida que quedó 'running' colgada
-- (proceso muerto, pestaña cerrada) la marca 'error' el próximo begin — ver
-- inventory_sync_begin.
create table if not exists public.inventory_syncs (
  id                uuid primary key default gen_random_uuid(),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  source            text not null check (source in ('excel_upload', 'manual_refresh')),
  status            text not null default 'running' check (status in ('running', 'ok', 'error')),
  -- Contadores. Nullables a propósito: la carga de Excel reporta lo que sabe
  -- (sus upserts tocan más campos que el stock y el conteo fino de
  -- desactivados/reactivados lo hacen los triggers); el refresco los reporta
  -- todos porque refresh_stock_upsert los devuelve exactos.
  products_updated  int,
  deactivated_count int,
  reactivated_count int,
  error_message     text,
  started_by        uuid,
  started_by_email  text
);

-- La frescura pregunta "la última exitosa" y el lock "¿hay una running?":
-- los dos accesos, un índice.
create index if not exists inventory_syncs_status_started_idx
  on public.inventory_syncs (status, started_at desc);

-- RLS: lectura para el panel de admins (mismo criterio que sync_runs);
-- escritura SOLO vía las RPCs de abajo (SECURITY DEFINER). El revoke es
-- cinturón + tirantes.
alter table public.inventory_syncs enable row level security;
revoke all on table public.inventory_syncs from anon, authenticated;

drop policy if exists admin_read_inventory_syncs on public.inventory_syncs;
create policy admin_read_inventory_syncs on public.inventory_syncs
  for select to authenticated
  using (public.is_admin());

-- ---------- 3) Ciclo de vida de una corrida ----------
-- Abre una corrida y devuelve su id. Lock anti-concurrencia:
--   * si hay una corrida 'running' de menos de 10 minutos → rechaza con
--     errcode ZS002 ("ya hay una actualización en curso"). 10 minutos cubre
--     de sobra el peor caso real de las dos vías (el refresco pagina ~3,500
--     SKUs a 50 por página y la carga de Excel sube ~2 tandas de upsert;
--     ninguna llega a 2-3 minutos) y es menor que cualquier timeout de Edge
--     Function, así que una corrida viva jamás se marca colgada.
--   * una 'running' de MÁS de 10 minutos está colgada (pestaña cerrada,
--     función abortada): se marca 'error' acá mismo y se permite continuar.
-- El advisory lock transaccional serializa dos begin simultáneos — sin él,
-- los dos verían "no hay running" y entrarían los dos.
create or replace function public.inventory_sync_begin(p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock_minutes constant int := 10;
  v_running      public.inventory_syncs%rowtype;
  v_recovered    int := 0;
  v_id           uuid;
  v_email        text;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;
  if p_source not in ('excel_upload', 'manual_refresh') then
    raise exception 'source inválido: % (excel_upload | manual_refresh)', p_source;
  end if;

  perform pg_advisory_xact_lock(hashtext('inventory_sync_begin'));

  -- Recuperación de corridas colgadas: más viejas que el lock y todavía
  -- 'running'. Se marcan error con motivo explícito — quedan visibles en el
  -- historial en vez de bloquear para siempre.
  update public.inventory_syncs
  set status        = 'error',
      finished_at   = now(),
      error_message = 'corrida colgada: seguía en running después de ' || v_lock_minutes
                      || ' minutos; marcada como error por un intento nuevo'
  where status = 'running'
    and started_at < now() - make_interval(mins => v_lock_minutes);
  get diagnostics v_recovered = row_count;

  select * into v_running
  from public.inventory_syncs
  where status = 'running'
  order by started_at desc
  limit 1;

  if found then
    raise exception using
      errcode = 'ZS002',
      message = format(
        'Ya hay una actualización de inventario en curso (empezó hace %s min): esperá a que termine.',
        greatest(0, floor(extract(epoch from (now() - v_running.started_at)) / 60))::int
      );
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.inventory_syncs (source, started_by, started_by_email)
  values (p_source, auth.uid(), v_email)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'recovered_stale', v_recovered);
end;
$$;

revoke execute on function public.inventory_sync_begin(text) from public, anon;
grant execute on function public.inventory_sync_begin(text) to authenticated;

-- Cierra una corrida. Solo cierra filas que sigan 'running': si otra corrida
-- ya la marcó colgada (o alguien la cerró dos veces), devuelve ok:false sin
-- pisar nada — el resultado de una corrida cerrada no se reescribe.
create or replace function public.inventory_sync_finish(
  p_id                uuid,
  p_status            text,
  p_products_updated  int  default null,
  p_deactivated_count int  default null,
  p_reactivated_count int  default null,
  p_error             text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;
  if p_status not in ('ok', 'error') then
    raise exception 'status inválido: % (ok | error)', p_status;
  end if;

  update public.inventory_syncs
  set status            = p_status,
      finished_at       = now(),
      products_updated  = p_products_updated,
      deactivated_count = p_deactivated_count,
      reactivated_count = p_reactivated_count,
      error_message     = left(p_error, 2000)
  where id = p_id and status = 'running';
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'la corrida no estaba en running (ya cerrada, o marcada colgada por otro intento)'
    );
  end if;

  return jsonb_build_object('ok', true, 'id', p_id, 'status', p_status);
end;
$$;

revoke execute on function public.inventory_sync_finish(uuid, text, int, int, int, text) from public, anon;
grant execute on function public.inventory_sync_finish(uuid, text, int, int, int, text) to authenticated;

-- ---------- 4) refresh_stock_upsert: SOLO stock, en lote ----------
-- Un chunk de inventario de SellerCloud: array jsonb de { sku, qty }. Toca
-- únicamente products.stock — nunca precio, nombre, foto ni estado — y los
-- triggers de la tabla (products_availability_from_stock +
-- products_enforce_noncatalog) derivan disponibilidad y publicación, EXACTO
-- igual que cuando el stock entra por Excel.
--
-- Criterios copiados de la carga de Excel (ProductsAdmin.jsx):
--   * match por SKU sin distinguir mayúsculas (lower(trim())), dedup dentro
--     del chunk quedándose con la última fila;
--   * SKUs que no están en el catálogo → se ignoran (unknown_skus);
--   * -SPECIAL/-BOX (is_noncatalog_sku) → se saltean, la carga tampoco los
--     jala (el trigger de no-catálogo los mantendría inactivos igual, pero
--     no hay motivo para escribirles stock que Excel nunca escribe);
--   * qty no numérico → fila inválida, se cuenta y no tumba el chunk.
-- Un UPDATE en lote y no uno por SKU: con ~3,500 productos el refresco entero
-- son ~7 chunks de 500, no 3,500 round-trips.
-- `stock is distinct from qty` evita reescribir filas sin cambio (menos WAL,
-- y products_updated cuenta cambios reales, no filas procesadas).
create or replace function public.refresh_stock_upsert(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated     int := 0;
  v_deactivated int := 0;
  v_reactivated int := 0;
  v_matched     int := 0;
  v_unknown     int := 0;
  v_invalid     int := 0;
  v_noncatalog  int := 0;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows debe ser un array jsonb de {sku, qty}';
  end if;

  drop table if exists pg_temp.tmp_refresh_rows;
  drop table if exists pg_temp.tmp_refresh_pre;

  create temporary table tmp_refresh_rows on commit drop as
  with raw as (
    select
      row_number() over ()            as rn,
      nullif(trim(x ->> 'sku'), '')   as sku,
      nullif(trim(x ->> 'qty'), '')   as qty_raw
    from jsonb_array_elements(p_rows) as x
  ),
  dedup as (
    select distinct on (lower(sku)) sku, qty_raw
    from raw
    where sku is not null
    order by lower(sku), rn desc
  )
  select
    d.sku,
    case
      when d.qty_raw ~ '^-?[0-9]+(\.[0-9]+)?$' then floor(d.qty_raw::numeric)::int
      else null
    end      as qty,
    p.id     as product_id,
    p.sku    as product_sku
  from dedup d
  left join public.products p on lower(trim(p.sku)) = lower(d.sku);

  select count(*) into v_invalid    from tmp_refresh_rows where qty is null;
  select count(*) into v_unknown    from tmp_refresh_rows where qty is not null and product_id is null;
  select count(*) into v_noncatalog from tmp_refresh_rows
    where qty is not null and product_id is not null and public.is_noncatalog_sku(product_sku);
  select count(*) into v_matched    from tmp_refresh_rows
    where qty is not null and product_id is not null and not public.is_noncatalog_sku(product_sku);

  -- Foto previa SOLO de las filas que van a cambiar: contra ella se cuentan
  -- los efectos del trigger (desactivados por quedarse en 0, reactivados por
  -- volver stock).
  create temporary table tmp_refresh_pre on commit drop as
  select p.id, p.active, p.deactivated_by_stock
  from public.products p
  join tmp_refresh_rows t on t.product_id = p.id
  where t.qty is not null
    and not public.is_noncatalog_sku(t.product_sku)
    and p.stock is distinct from t.qty;

  update public.products p
  set stock = t.qty
  from tmp_refresh_rows t
  where p.id = t.product_id
    and t.qty is not null
    and not public.is_noncatalog_sku(t.product_sku)
    and p.stock is distinct from t.qty;
  get diagnostics v_updated = row_count;

  select
    count(*) filter (where pre.active and not p.active),
    count(*) filter (where pre.deactivated_by_stock and p.active)
  into v_deactivated, v_reactivated
  from tmp_refresh_pre pre
  join public.products p on p.id = pre.id;

  return jsonb_build_object(
    'updated',            v_updated,
    'unchanged',          v_matched - v_updated,
    'deactivated',        v_deactivated,
    'reactivated',        v_reactivated,
    'unknown_skus',       v_unknown,
    'invalid_rows',       v_invalid,
    'skipped_noncatalog', v_noncatalog
  );
end;
$$;

revoke execute on function public.refresh_stock_upsert(jsonb) from public, anon;
grant execute on function public.refresh_stock_upsert(jsonb) to authenticated;

-- ---------- 5) get_inventory_freshness ----------
-- Todo lo que el panel necesita de un saque: la última corrida EXITOSA
-- (error/running no cuentan — un refresco que falló no volvió fresco a
-- nadie), hace cuántos minutos fue, el umbral, si ya venció, y si hay una
-- corrida en curso (para deshabilitar el botón). La usa todo el panel
-- (indicador del header, cada 60 s) y la Edge Function del push.
--
-- REGLA DE ACTIVACIÓN: sin ninguna corrida exitosa registrada, is_stale =
-- false. Es lo que hace el deploy seguro (ver cabecera): con el frontend
-- viejo la tabla queda vacía y el candado no existe; la primera corrida
-- registrada por el mundo nuevo lo enciende.
create or replace function public.get_inventory_freshness()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_last      public.inventory_syncs%rowtype;
  v_running   public.inventory_syncs%rowtype;
  v_threshold int := public.stock_freshness_minutes();
  v_minutes   int := null;
  v_stale     boolean := false;
begin
  select * into v_last
  from public.inventory_syncs
  where status = 'ok'
  order by finished_at desc
  limit 1;

  if found then
    v_minutes := greatest(0, floor(extract(epoch from (now() - v_last.finished_at)) / 60))::int;
    v_stale   := v_minutes > v_threshold;
  end if;

  select * into v_running
  from public.inventory_syncs
  where status = 'running'
  order by started_at desc
  limit 1;

  return jsonb_build_object(
    'last_sync', case when v_last.id is null then null else jsonb_build_object(
      'id',                v_last.id,
      'source',            v_last.source,
      'finished_at',       v_last.finished_at,
      'products_updated',  v_last.products_updated,
      'deactivated_count', v_last.deactivated_count,
      'reactivated_count', v_last.reactivated_count
    ) end,
    'minutes_ago',       v_minutes,
    'threshold_minutes', v_threshold,
    'is_stale',          v_stale,
    'running', case when v_running.id is null then null else jsonb_build_object(
      'id',         v_running.id,
      'source',     v_running.source,
      'started_at', v_running.started_at
    ) end
  );
end;
$$;

revoke execute on function public.get_inventory_freshness() from public, anon;
grant execute on function public.get_inventory_freshness() to authenticated;

-- ---------- 6) audit_freshness_override ----------
-- La usa la Edge Function `sellercloud-push-order` cuando el superadmin
-- fuerza un push con inventario vencido (la API de SellerCloud caída es el
-- caso de uso: no se puede refrescar y el pedido tiene que salir igual). La
-- edad del inventario se calcula ACÁ, no la manda el caller — un override
-- auditado con datos del cliente no sería auditoría. update_order_status
-- audita su propio override adentro (misma acción 'freshness_override', vía
-- distinta en el detail).
create or replace function public.audit_freshness_override(
  p_via      text,
  p_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fresh jsonb;
  v_email text;
begin
  if not public.is_superadmin() then
    raise exception 'solo el superadmin puede saltear el candado de inventario';
  end if;

  v_fresh := public.get_inventory_freshness();

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, order_id, client_name, detail)
  values
    ('freshness_override', auth.uid(), v_email, p_order_id,
     coalesce(nullif(trim(p_via), ''), 'sin_via'),
     jsonb_build_object(
       'via',                   coalesce(nullif(trim(p_via), ''), 'sin_via'),
       'inventory_age_minutes', v_fresh -> 'minutes_ago',
       'threshold_minutes',     v_fresh -> 'threshold_minutes',
       'last_source',           v_fresh #> '{last_sync,source}',
       'order_id',              p_order_id
     ));

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.audit_freshness_override(text, uuid) from public, anon;
grant execute on function public.audit_freshness_override(text, uuid) to authenticated;

-- ---------- 7) update_order_status: el candado ----------
-- Misma función que migration-2026-08-26 (estado + stock + auditoría) MÁS el
-- candado de frescura en LA transición que toca inventario: pedido real
-- (kind = 'order') pasando a Atendido con stock todavía sin descontar.
-- Reabrir/cancelar (devuelven stock) y las cotizaciones (no tocan stock)
-- pasan siempre — bloquear la devolución de stock por inventario viejo solo
-- empeoraría el desalineo.
--
-- El parámetro nuevo p_override es EXPLÍCITO y jamás default: solo lo manda
-- el frontend cuando un superadmin aprieta "forzar" después del rechazo.
-- Con inventario fresco, p_override no hace nada (ni audita: no salteó nada).
--
-- CAMBIO DE FIRMA: se elimina la versión (uuid, text) y se crea
-- (uuid, text, boolean default false). El frontend viejo sigue llamando con
-- dos argumentos con nombre y PostgREST resuelve contra la firma nueva por el
-- default — pero NO pueden convivir las dos (PostgREST no sabría cuál elegir:
-- "Could not choose the best candidate function"). Por eso el DROP explícito.
drop function if exists public.update_order_status(uuid, text);

create or replace function public.update_order_status(
  p_order_id uuid,
  p_status   text,
  p_override boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders%rowtype;
  v_client  public.clients%rowtype;
  v_email   text;
  v_stock   jsonb   := null;
  v_applied boolean;
  v_fresh   jsonb;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
  end if;

  if p_status not in ('new', 'done', 'cancelled') then
    raise exception 'estado inválido';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'pedido no encontrado';
  end if;

  select * into v_client from public.clients where id = v_order.client_id;

  if not public.is_admin()
     and v_client.vendedora_id is distinct from public.current_vendedora_id() then
    raise exception 'no tenés permiso para modificar este pedido';
  end if;

  if v_order.status = p_status then
    return jsonb_build_object('ok', true, 'status', p_status,
                              'stock_applied', coalesce(v_order.stock_applied, false));
  end if;

  v_applied := coalesce(v_order.stock_applied, false);

  -- Candado de frescura (2026-09-04): solo la transición que va a DESCONTAR
  -- stock. El chequeo va ANTES de mover nada — un rechazo no deja efectos a
  -- medias. errcode ZS001 = identificable por el frontend (error.code), con
  -- la edad en el mensaje.
  if v_order.kind = 'order' and p_status = 'done' and not v_applied then
    v_fresh := public.get_inventory_freshness();
    if (v_fresh ->> 'is_stale')::boolean then
      if not p_override then
        raise exception using
          errcode = 'ZS001',
          message = format(
            'Inventario desactualizado (hace %s min, umbral %s min): refrescá el stock para continuar.',
            v_fresh ->> 'minutes_ago', v_fresh ->> 'threshold_minutes'
          );
      end if;
      if not public.is_superadmin() then
        raise exception 'solo el superadmin puede saltear el candado de inventario';
      end if;
      -- Cada uso del escape queda auditado, con la edad calculada acá.
      select email into v_email from auth.users where id = auth.uid();
      insert into public.admin_audit_log
        (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
      values
        ('freshness_override', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
         jsonb_build_object(
           'via',                   'update_order_status',
           'to_status',             p_status,
           'inventory_age_minutes', v_fresh -> 'minutes_ago',
           'threshold_minutes',     v_fresh -> 'threshold_minutes',
           'last_source',           v_fresh #> '{last_sync,source}'
         ));
    end if;
  end if;

  if v_order.kind = 'order' then
    if p_status = 'done' and not v_applied then
      v_stock   := public.apply_order_stock(p_order_id, -1);
      v_applied := true;
    elsif p_status <> 'done' and v_applied then
      v_stock   := public.apply_order_stock(p_order_id, 1);
      v_applied := false;
    end if;
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('update_order_status', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object('from_status', v_order.status, 'to_status', p_status)
       || case when v_stock is null then '{}'::jsonb else jsonb_build_object('stock', v_stock) end);

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set status = p_status, stock_applied = v_applied
  where id = p_order_id;

  return jsonb_build_object(
    'ok',            true,
    'status',        p_status,
    'stock_applied', v_applied,
    'stock',         v_stock
  );
end;
$$;

revoke execute on function public.update_order_status(uuid, text, boolean) from public;
grant execute on function public.update_order_status(uuid, text, boolean) to authenticated;

commit;

-- ============================================================
-- Después de correr esto (ORDEN DE DEPLOY, importa):
--   1. Esta migración (ya corrida si estás leyendo esto desde el SQL Editor).
--      El candado queda DORMIDO: inventory_syncs está vacía.
--   2. supabase functions deploy sellercloud-push-order    (candado en push)
--      supabase functions deploy sellercloud-refresh-stock (refresco nuevo)
--   3. Deploy del frontend (indicador, botón de refresco, registro de la
--      carga de Excel).
--   La primera corrida registrada (primer refresco o primera carga de Excel
--   con columna de stock desde el frontend nuevo) enciende el candado.
--
-- ---------- Selects de prueba (comentados) ----------
-- 1) Frescura sin corridas (candado dormido):
-- select public.get_inventory_freshness();
-- -- Esperado: last_sync null, is_stale false, threshold_minutes 45.
--
-- 2) Ciclo completo de una corrida:
-- select public.inventory_sync_begin('manual_refresh');           -- guardar el id
-- select public.refresh_stock_upsert('[{"sku": "UN-SKU-REAL", "qty": "7"}]'::jsonb);
-- select public.inventory_sync_finish('EL_ID', 'ok', 1, 0, 0, null);
-- select public.get_inventory_freshness();
-- -- Esperado: last_sync con source manual_refresh, minutes_ago 0, is_stale false.
--
-- 3) Lock: con una corrida running abierta, otro begin debe rechazar:
-- select public.inventory_sync_begin('manual_refresh');
-- select public.inventory_sync_begin('excel_upload');
-- -- Esperado: ERROR ZS002 "Ya hay una actualización de inventario en curso".
-- -- Cerrarla: select public.inventory_sync_finish('EL_ID', 'error', null, null, null, 'prueba');
--
-- 4) El umbral solo lo cambia el superadmin (desde el panel; en el SQL Editor
--    auth.uid() es null y da "solo el superadmin puede..."):
-- select public.sa_set_stock_freshness(60);
--
-- Ojo al probar en el SQL Editor: corre como postgres, así que
-- is_admin()/is_vendedora() dan false y los begin/finish/upsert tiran
-- "no autorizado". Probar desde el panel logueado, o en un entorno de prueba
-- con app.test_uid.
