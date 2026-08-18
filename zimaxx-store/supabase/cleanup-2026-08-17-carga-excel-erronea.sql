-- ============================================================
-- 2026-08-17: revertir una carga de Excel equivocada en Productos
--
-- QUÉ PASÓ: un admin subió por la pestaña Productos un export general de
-- SellerCloud (124758.xlsx, 8272 filas) en vez del archivo de catálogo.
-- El filtro de no-catálogo de la carga (`isNonCatalog` en ProductsAdmin.jsx /
-- `sync_is_noncatalog_product` en SQL) descartó 1643 filas, pero dejó pasar
-- ~6600, y las que no existían se crearon como productos nuevos (~3k).
--
-- Simulando el archivo con la misma lógica de la carga, lo que entró fue:
--     3783  Perfume
--     1315  Perfume - Arabes
--      787  855696              <- categoría corrupta del export
--      390  855824              <- categoría corrupta del export
--      255  Beauty and Health   <- EXCLUDED_LINES tiene 'beauty', no esto
--       55  Office Supply
--       16  (sin categoría)
--        5  856208 / 5 Home / 4 Party / 1 Toys
--
-- ESTE SCRIPT NO ES UNA MIGRACIÓN. Es una limpieza de datos de una sola vez,
-- para correr a mano en el SQL Editor de Supabase, PASO POR PASO, leyendo el
-- resultado de cada uno antes de seguir. No lo corras entero de un saque.
--
-- QUÉ SE PUEDE Y QUÉ NO:
--   * Los productos CREADOS por la carga se revierten (esto).
--   * Los productos que YA EXISTÍAN y el archivo pisó (nombre, categoría,
--     imagen, activo, stock, upc) NO se recuperan acá: eso es backup/PITR de
--     Supabase o volver a subir el Excel bueno.
--   * Los pedidos históricos NO se tocan: `orders.items` es un snapshot jsonb,
--     no una FK a products (schema.sql:393).
--   * `product_prices` y `flash_sales` caen solas por `on delete cascade`
--     (schema.sql:358,377); igual se respaldan acá abajo.
-- ============================================================


-- ------------------------------------------------------------
-- PASO 1 — ¿cuándo fue la carga? (solo lee)
-- Las altas se agrupan por minuto: una carga masiva salta a la vista como
-- unos pocos minutos con cientos/miles de filas cada uno.
-- ------------------------------------------------------------
select date_trunc('minute', created_at)                        as minuto,
       count(*)                                                as productos,
       count(*) filter (where new_until is not null)            as con_tag_nuevo,
       min(sku)                                                as ejemplo_sku
from public.products
group by 1
order by 1 desc
limit 60;


-- ------------------------------------------------------------
-- PASO 2 — congelar el conjunto afectado en una tabla de respaldo
--
-- Definir la tanda UNA sola vez y guardarla evita que cada paso siguiente
-- vuelva a filtrar por fecha (y arrastre algo distinto). Además es el
-- rollback: mientras esta tabla exista, todo lo de abajo es reversible,
-- incluso el DELETE.
--
-- >>> AJUSTÁ LAS DOS FECHAS con lo que haya salido en el PASO 1 <<<
--     Poné el rango justo (ej. de 14:30 a 14:40), no el día entero.
--     Las fechas van en UTC, que es como guarda `created_at`.
-- ------------------------------------------------------------
drop table if exists public.backup_carga_erronea_20260817;

create table public.backup_carga_erronea_20260817 as
select *
from public.products
where created_at >= '2026-08-17 00:00:00+00'   -- <<< AJUSTAR
  and created_at <  '2026-08-18 00:00:00+00';  -- <<< AJUSTAR

-- Marca de qué se borra. Arranca en true (todo) y el PASO 3d permite
-- perdonar lo que sí debía entrar. Los PASOS 4 y 5 leen ESTA columna, no la
-- fecha ni el estado activo, así que los dos operan exactamente sobre el
-- mismo conjunto.
alter table public.backup_carga_erronea_20260817
  add column a_borrar boolean not null default true;

-- Los precios de esos productos (si tuvieran), que el cascade se llevaría.
drop table if exists public.backup_carga_erronea_precios_20260817;

create table public.backup_carga_erronea_precios_20260817 as
select pp.*
from public.product_prices pp
join public.backup_carga_erronea_20260817 b on b.id = pp.product_id;

-- Estas dos tablas viven en `public`, o sea que PostgREST las publica y los
-- grants por defecto de Supabase alcanzan a anon/authenticated. Sin esto, el
-- respaldo quedaría legible (y escribible) con la anon key que está en el
-- front. RLS activo y CERO policies = nadie entra salvo el SQL Editor y
-- service_role, que la saltean. Mismo patrón que la tabla `superadmins`.
alter table public.backup_carga_erronea_20260817          enable row level security;
alter table public.backup_carga_erronea_precios_20260817  enable row level security;
revoke all on public.backup_carga_erronea_20260817         from anon, authenticated;
revoke all on public.backup_carga_erronea_precios_20260817 from anon, authenticated;


-- ------------------------------------------------------------
-- PASO 3 — revisar qué quedó atrapado ANTES de tocar nada
-- ------------------------------------------------------------

-- 3a. Resumen de daño real: ¿los vio algún cliente?
-- Desde migration-2026-08-06-require-price.sql un producto sin precio > 0 no
-- sale en el catálogo. Si `con_precio_visible` da 0, nunca los vio nadie.
select count(*)                                             as total,
       count(*) filter (where active)                       as activos,
       count(*) filter (where exists (
         select 1 from public.product_prices pp
         where pp.product_id = b.id and pp.price > 0))      as con_precio_visible,
       count(*) filter (where exists (
         select 1 from public.flash_sales f
         where f.product_id = b.id))                        as en_flash_sale
from public.backup_carga_erronea_20260817 b;

-- 3b. Desglose por categoría: acá se decide qué se va y qué se queda.
select coalesce(product_line, '(sin categoría)') as product_line,
       count(*)                                  as productos,
       min(sku)                                  as ejemplo_sku,
       min(name)                                 as ejemplo_nombre
from public.backup_carga_erronea_20260817
group by 1
order by 2 desc;

-- 3c. ¿Alguno se coló en un pedido ya registrado? (debería dar 0 filas)
-- Si aparece alguno, el pedido NO se rompe al borrarlo —el ítem quedó
-- copiado en el jsonb— pero conviene saberlo antes de borrar.
select o.id as order_id, o.created_at, i->>'sku' as sku, i->>'name' as nombre
from public.orders o
cross join lateral jsonb_array_elements(o.items) i
where (i->>'id')::uuid in (select id from public.backup_carga_erronea_20260817)
order by o.created_at desc;

-- 3d. OPCIONAL — perdonar lo que sí debía entrar.
-- Si los perfumes nuevos son legítimos y lo único que sobra es el resto,
-- descomentá esto: quedan fuera del apagado Y del borrado.
--
-- update public.backup_carga_erronea_20260817
-- set a_borrar = false
-- where product_line like 'Perfume%';

-- 3e. Conteo final de lo que se va a tocar (leelo antes del PASO 4):
select a_borrar, count(*)
from public.backup_carga_erronea_20260817
group by 1;


-- ------------------------------------------------------------
-- PASO 4 — APAGAR (reversible, inmediato)
--
-- Los saca del catálogo del cliente y los deja filtrables como inactivos en
-- el panel. `deactivated_by_stock = false` es a propósito: con la bandera en
-- false el trigger products_availability_from_stock (schema.sql:280) NO los
-- vuelve a prender solo si algún día les entra stock. Quedan apagados hasta
-- que alguien los prenda a mano.
-- ------------------------------------------------------------
update public.products p
set active = false,
    deactivated_by_stock = false
where p.id in (select id from public.backup_carga_erronea_20260817 where a_borrar)
  and p.active;

-- Verificar que no quedó nada prendido de la tanda (debe dar 0):
select count(*) as todavia_activos
from public.products p
where p.id in (select id from public.backup_carga_erronea_20260817 where a_borrar)
  and p.active;


-- ============================================================
-- *** ACÁ SE PARA. ***
-- Revisá el panel y el catálogo con calma: que no falte nada del catálogo
-- bueno y que los 3k ya no aparezcan. Recién después seguí con el PASO 5.
-- ============================================================


-- ------------------------------------------------------------
-- PASO 5 — BORRADO DEFINITIVO
-- Sigue siendo reversible mientras existan las tablas de respaldo (PASO 7).
-- El cascade se lleva product_prices y flash_sales de esos productos.
-- ------------------------------------------------------------
delete from public.products p
where p.id in (select id from public.backup_carga_erronea_20260817 where a_borrar);

-- Verificar (debe dar 0):
select count(*) as siguen_existiendo
from public.products p
where p.id in (select id from public.backup_carga_erronea_20260817 where a_borrar);


-- ------------------------------------------------------------
-- PASO 6 — DESHACER (solo si algo salió mal)
-- Restaura productos y precios tal cual estaban, con los mismos id.
-- ------------------------------------------------------------
-- insert into public.products
-- select (jsonb_populate_record(null::public.products, to_jsonb(b) - 'a_borrar')).*
-- from public.backup_carga_erronea_20260817 b
-- on conflict (id) do nothing;
--
-- insert into public.product_prices
-- select * from public.backup_carga_erronea_precios_20260817
-- on conflict (product_id, price_list_id) do nothing;
--
-- Dos avisos sobre el deshacer:
--   * El rodeo por jsonb es para no depender del orden físico de las columnas
--     de `products` (que salió de un create + varios alter add column) ni
--     tener que sacar a mano la columna `a_borrar` que agregó el PASO 2.
--   * Al re-insertar, el trigger products_availability_from_stock vuelve a
--     correr sobre cada fila y recalcula availability desde stock; `active`
--     se restaura con el valor guardado salvo que stock <= 0, en cuyo caso lo
--     apaga (y marca deactivated_by_stock). Es el comportamiento normal de
--     cualquier alta, no un efecto del respaldo.


-- ------------------------------------------------------------
-- PASO 7 — limpiar el respaldo
-- Recién cuando esté todo verificado y no haya vuelta atrás que pedir.
-- Mientras estas tablas existan, el PASO 6 sigue disponible.
-- ------------------------------------------------------------
-- drop table public.backup_carga_erronea_20260817;
-- drop table public.backup_carga_erronea_precios_20260817;
