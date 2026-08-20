-- ============================================================
-- 2026-08-20: orders.units — la bandeja deja de bajar los ítems de todo
--
-- Contexto (análisis de rendimiento de hoy). OrdersAdmin bajaba TODOS los
-- pedidos CON su jsonb `items` completo (4.2 KB promedio por pedido, hasta
-- 69 KB) en cada visita a la pestaña: hoy son ~3 MB, y al ritmo real de ~250
-- pedidos/semana serían ~14 MB en 3 meses y ~55 MB al año — la bandeja se
-- muere mucho antes del año. El arreglo del frontend (misma fecha) es:
-- ventana de tiempo por defecto + traer `items` SOLO al desplegar o actuar
-- sobre un pedido.
--
-- Lo único que la FILA de la tabla mostraba de `items` era el total de
-- unidades ("N items"). Para no perder ese dato sin bajar el jsonb, esta
-- migración lo materializa: columna GENERADA `units`, calculada por Postgres
-- a partir de `items` en cada insert/update. No es una columna que alguien
-- pueda desincronizar: no se puede escribir, la deriva siempre la base.
--
-- La función del cálculo NO PUEDE FALLAR NUNCA: una excepción acá haría
-- fallar cualquier insert/update de orders (create_order incluido). Por eso
-- valida todo antes de castear — items null, no-array, elementos sin qty o
-- con qty basura suman 0 en vez de reventar.
--
-- EXECUTE: la expresión de una columna generada se evalúa con el rol que
-- escribe la fila (misma regla que triggers y policies — la lección de
-- is_noncatalog_sku, 2026-08-13): grant explícito a los tres roles de la API,
-- si no cualquier UPDATE de orders desde el panel se cae con
-- "permission denied for function order_items_units".
--
-- COMPATIBILIDAD: el frontend viejo (select *) recibe una columna de más y
-- la ignora. El frontend nuevo la nombra en su select, pero degrada solo: si
-- la columna todavía no existe (42703), reintenta con el select viejo con
-- items incluidos — o sea que esta migración NO bloquea el deploy en ningún
-- orden, solo conviene correrla pronto para cobrar el ahorro.
--
-- Idempotente (create or replace + add column if not exists). El ALTER
-- reescribe la tabla una vez (2 MB hoy, instantáneo) con lock exclusivo
-- breve — el lock_timeout corta limpio si choca con algo.
-- ============================================================
set lock_timeout = '10s';

-- ---------- 1) El cálculo, blindado ----------
-- immutable de verdad: puro sobre su argumento, sin tocar tablas — es
-- requisito de Postgres para usarla en una columna generada.
create or replace function public.order_items_units(p_items jsonb)
returns integer
language sql
immutable
as $$
  select coalesce(sum(
           case when (i->>'qty') ~ '^[0-9]+(\.[0-9]+)?$'
                then floor((i->>'qty')::numeric)::int
                else 0
           end), 0)::int
  from jsonb_array_elements(
         case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end
       ) i;
$$;

grant execute on function public.order_items_units(jsonb) to authenticated, anon, service_role;

comment on function public.order_items_units(jsonb) is
  'Total de unidades de un jsonb de ítems de pedido. Solo existe para la columna generada orders.units (2026-08-20); nunca lanza excepción — un error acá rompería todo insert/update de orders.';

-- ---------- 2) La columna ----------
-- `stored`: se calcula al escribir y se lee gratis — que es exactamente el
-- patrón de la bandeja (se escribe un pedido por checkout, se lee mil veces).
-- El backfill de las filas existentes lo hace el propio ALTER (reescritura).
alter table public.orders
  add column if not exists units integer
  generated always as (public.order_items_units(items)) stored;

comment on column public.orders.units is
  'Unidades totales del pedido (suma de qty de items). Generada — no se escribe. La lee la bandeja de Pedidos para no bajar el jsonb items completo (2026-08-20).';

-- ============================================================
-- Verificación manual (SQL Editor)
-- ============================================================
-- 1) El backfill quedó bien (debe dar 0 filas):
-- select count(*) from public.orders
-- where units is distinct from public.order_items_units(items);
--
-- 2) Un vistazo:
-- select id, units, jsonb_array_length(items) as lineas, total
-- from public.orders order by created_at desc limit 5;
--
-- 3) La columna no se puede escribir (debe fallar con "can only be updated
--    to DEFAULT"):
-- update public.orders set units = 999 where false;
