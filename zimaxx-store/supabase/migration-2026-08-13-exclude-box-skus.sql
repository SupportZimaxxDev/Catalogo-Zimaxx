-- 2026-08-13: los SKU terminados en -BOX quedan fuera del catálogo (a pedido del
-- usuario: "los productos que terminen con sku -BOX automaticamente deben
-- desactivarse, nunca se deben mostrar en el sistema").
--
-- Qué es un -BOX y por qué no lo tapaba nada: en el export de SellerCloud
-- (119389.xlsx) hay 77 SKU así, y son el MISMO perfume que ya está en el
-- catálogo pero vendido por caja — `ZX_PE-AB-M-636268-ZX-BOX` y
-- `ZX_PE-AB-M-636268-ZX` son los dos "Blue Seduction 3.4 Oz Edt Men". A
-- diferencia de los -SPECIAL de 2026-07-13, su PRODUCT_CATEGORY es
-- `Perfume` / `Perfume - Arabes`, así que la mitad "por categoría" de la regla de
-- no-catálogo no los alcanzaba y el sync los venía jalando como productos
-- normales.
--
-- Tres capas, porque "nunca se deben mostrar" no lo garantiza desactivarlos una
-- vez:
--
--   1) La regla del SKU pasa a ser compartida y explícita (is_noncatalog_sku):
--      -SPECIAL (2026-07-13) + -BOX (hoy). Con eso el sync
--      (sync_upsert_products, vía sync_is_noncatalog_product) y el Excel de
--      productos del panel dejan de jalarlos.
--   2) Un trigger nuevo (products_enforce_noncatalog) los deja INACTIVOS
--      siempre, escriba quien escriba. Esta capa hacía falta de verdad, no es
--      cinturón y tirantes: la carga de precios (apply_price_list) escribe
--      `active = true` para todo lo que trae precio en el archivo, y los Excel de
--      precios salen del mismo export de SellerCloud — o sea que un -BOX se
--      republicaba solo en la próxima carga semanal. Lo mismo el botón Activar
--      del panel y cualquier request directo.
--   3) Backfill de los que hoy están publicados (paso 4).
--
-- Por qué el trigger mira SOLO el sufijo del SKU y no la regla completa de
-- no-catálogo: el sufijo es un dato estructural de SellerCloud que nadie escribe
-- a mano, y si algún día un -BOX tiene que venderse alcanza con editarle el SKU
-- desde el panel. La otra mitad de la regla (product_line = beauty / electronics
-- / support / packing and shipping supplies / test) es texto libre que viene de un
-- export y NO es editable desde el panel: clavarla en un trigger dejaría un
-- perfume mal categorizado imposible de activar, sin salida por la UI. Esa mitad
-- sigue funcionando como desde 2026-07-13 (no entra por el sync ni por el Excel)
-- y el backfill de abajo la vuelve a aplicar.
--
-- Idempotente, se puede re-correr. lock_timeout corto para fallar rápido y limpio
-- si un lock se traba contra producción.
set lock_timeout = '10s';

-- ---------- 1) La regla del SKU, en un solo lugar ----------
-- Se separa de sync_is_noncatalog_product porque ya no es solo del sync: la usan
-- el trigger de abajo y apply_price_list.
--
-- OJO con los permisos: esta función se llama DENTRO de un trigger, y el
-- privilegio EXECUTE de lo que se llama en el cuerpo de un trigger se chequea
-- contra el usuario que hace el UPDATE (el rol `authenticated` del panel), no
-- contra el dueño de la tabla. Por eso acá NO va el
-- `revoke execute ... from public` que llevan las funciones del sync, y sí un
-- grant explícito a los roles de Supabase: si `authenticated` se queda sin
-- EXECUTE, **cualquier** edición de producto se cae con "permission denied for
-- function is_noncatalog_sku" (probado a propósito en el cluster de prueba). No
-- expone nada: es un regex sobre el texto que le pasan, sin tocar ninguna tabla.
create or replace function public.is_noncatalog_sku(p_sku text)
returns boolean
language sql
immutable
as $$
  select coalesce(trim(p_sku) ~* '-(special|box)$', false);
$$;

-- Explícito, no por el default de PUBLIC: si el proyecto alguna vez endurece los
-- privilegios por defecto, el trigger tiene que seguir funcionando.
grant execute on function public.is_noncatalog_sku(text) to authenticated, anon, service_role;

comment on function public.is_noncatalog_sku(text) is
  'SKU de variante interna de SellerCloud que nunca se publica: -SPECIAL (2026-07-13) o -BOX (venta por caja, 2026-08-13). El trigger products_enforce_noncatalog lo mantiene inactivo.';

-- ---------- 2) La regla completa del sync sigue existiendo, ahora delega ----------
-- Mismo cuerpo que migration-2026-07-13-exclude-noncatalog.sql: lo único que
-- cambia es que el sufijo del SKU sale de is_noncatalog_sku (así -BOX entra sin
-- duplicar el regex). sync_upsert_products no se toca: llama a esta función, así
-- que hereda el -BOX sin reescribirla.
create or replace function public.sync_is_noncatalog_product(p_sku text, p_line text)
returns boolean
language sql
immutable
as $$
  select
    public.is_noncatalog_sku(p_sku)
    or lower(trim(regexp_replace(coalesce(p_line, ''), '\s+', ' ', 'g'))) = any (array[
      'test',
      'electronics',
      'packing and shipping supplies',
      'support',
      'beauty'
    ]);
$$;

revoke execute on function public.sync_is_noncatalog_product(text, text) from public;
grant execute on function public.sync_is_noncatalog_product(text, text) to service_role;

-- ---------- 3) Trigger: un -BOX no puede quedar publicado ----------
-- Mismo criterio que products_availability_from_stock (2026-08-04/08-12): la
-- invariante vive en la tabla, no en cada camino de escritura, porque los caminos
-- son muchos (sync de n8n, Excel de productos, Excel de precios, selección en
-- bloque, formulario, request directo).
--
-- `deactivated_by_stock := false` a propósito: la bandera significa "lo apagó la
-- regla de stock y vuelve solo cuando entre stock", y esto no es eso — a un -BOX
-- lo apaga su SKU y no vuelve nunca. Dejarla en true haría que la próxima entrada
-- de inventario intentara republicarlo (y que el panel lo mostrara con el 📦 de
-- "vuelve solo", que sería mentira).
--
-- ORDEN DE LOS TRIGGERS (importa): Postgres dispara los BEFORE ... FOR EACH ROW
-- por orden alfabético de nombre, y cada uno recibe el NEW que dejó el anterior.
-- `products_availability_from_stock` < `products_enforce_noncatalog`, así que este
-- tiene la última palabra sobre `active` — que es justo lo que hace falta, porque
-- el de stock prende (`active := true`) cuando entra inventario. Si alguna vez se
-- renombra alguno de los dos, mantener ese orden.
create or replace function public.products_enforce_noncatalog()
returns trigger
language plpgsql
as $$
begin
  if public.is_noncatalog_sku(new.sku) then
    new.active               := false;
    new.deactivated_by_stock := false;
  end if;
  return new;
end;
$$;

drop trigger if exists products_enforce_noncatalog on public.products;
create trigger products_enforce_noncatalog
  before insert or update on public.products
  for each row execute function public.products_enforce_noncatalog();

-- ---------- 4) Backfill ----------
-- Los que ya están cargados: el trigger solo actúa sobre escrituras, así que sin
-- esto los -BOX que hoy están publicados seguirían en el catálogo hasta que algo
-- les escribiera encima.
--
-- Nunca DELETE, igual que en 2026-07-13: active = false es reversible y no rompe
-- los precios ni los pedidos que los referencien.
do $$
declare
  v_box_total   int;
  v_box_pub     int;
  v_line_pub    int;
  v_open_orders int;
begin
  select count(*) into v_box_total
  from public.products where public.is_noncatalog_sku(sku);

  -- Publicados = activos, o marcados para volver cuando entre stock (esa marca
  -- también hay que apagarla: un -BOX no vuelve nunca).
  select count(*) into v_box_pub
  from public.products
  where public.is_noncatalog_sku(sku) and (active or deactivated_by_stock);

  update public.products
  set active = false, deactivated_by_stock = false
  where public.is_noncatalog_sku(sku) and (active or deactivated_by_stock);

  raise notice 'no-catálogo por SKU (-BOX/-SPECIAL): % en la tabla, % estaban publicados o marcados para volver → desactivados', v_box_total, v_box_pub;

  -- De paso, la otra mitad de la regla de 2026-07-13 (categorías). El UPDATE de
  -- esa migración corrió una sola vez, pero apply_price_list escribe
  -- `active = true` para todo lo que trae precio: si un beauty/electronics vino en
  -- un Excel de precios desde entonces, hoy está publicado otra vez. Se reporta
  -- aparte para que el número se vea y no quede escondido en el total.
  select count(*) into v_line_pub
  from public.products
  where not public.is_noncatalog_sku(sku)
    and public.sync_is_noncatalog_product(sku, product_line)
    and (active or deactivated_by_stock);

  update public.products
  set active = false, deactivated_by_stock = false
  where not public.is_noncatalog_sku(sku)
    and public.sync_is_noncatalog_product(sku, product_line)
    and (active or deactivated_by_stock);

  raise notice 'no-catálogo por categoría (beauty/electronics/support/packing/test) que habían vuelto a publicarse: % → desactivados', v_line_pub;

  -- Diagnóstico, no acción: si un -BOX está en un pedido/cotización sin atender,
  -- la línea se cae en silencio al recalcular precios (compute_order_items solo
  -- mira `active or deactivated_by_stock`). Si esto da > 0, conviene revisar esos
  -- pedidos con la asesora antes de que los edite.
  select count(distinct o.id) into v_open_orders
  from public.orders o
  cross join lateral jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) as it
  where o.status = 'new'
    and public.is_noncatalog_sku(it->>'sku');

  raise notice 'pedidos sin atender que tienen alguna línea -BOX/-SPECIAL: % (0 = nada que revisar)', v_open_orders;
end;
$$;

-- ---------- 5) apply_price_list: que el preview no prometa de más ----------
-- Copia de la función de schema.sql (versión 2026-08-12) con un solo tema nuevo:
-- los SKU no-catálogo del archivo. Antes contaban como "a reactivar" y el UPDATE
-- les escribía active = true; con el trigger nuevo eso queda en nada, así que el
-- preview prometía productos que no vuelven — el mismo problema que 2026-08-12
-- arregló para el stock 0, y se resuelve igual: contador propio
-- (`blocked_noncatalog`) y afuera de `to_reactivate`.
--
-- El precio SÍ se sigue guardando para esas filas: es un dato inerte (no publica
-- nada por sí mismo) y no escribirlo las mandaría al lote de "sacar de la lista",
-- inflando el contador de desactivados con productos que ya están inactivos.
create or replace function public.apply_price_list(
  p_price_list_code text,
  p_rows             jsonb,
  p_commit           boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list                public.price_lists%rowtype;
  v_to_upsert           int;
  v_to_reactivate       int;
  v_blocked_by_stock    int;   -- 2026-08-12
  v_blocked_noncatalog  int;   -- 2026-08-13
  v_to_deactivate       int;
  v_unknown_skus        int;
  v_invalid_prices      int;
  v_deactivate_sample   jsonb;
  v_unknown_sample      jsonb;
begin
  if not public.is_admin() then
    raise exception 'no tenés permiso para aplicar listas de precio';
  end if;

  select * into v_list from public.price_lists where code = p_price_list_code;
  if not found then
    raise exception 'lista de precio no encontrada: %', p_price_list_code;
  end if;

  drop table if exists pg_temp.tmp_price_rows;
  drop table if exists pg_temp.tmp_deactivate;

  create temporary table tmp_price_rows on commit drop as
  with raw as (
    select
      row_number() over ()             as rn,
      trim(elem->>'sku')                as sku,
      nullif(trim(elem->>'price'), '')  as price_raw,
      trim(elem->>'type')                as type_raw
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as elem
  ),
  dedup as (
    select distinct on (lower(sku)) sku, price_raw, type_raw
    from raw
    where sku is not null and sku <> ''
    order by lower(sku), rn desc
  )
  select
    d.sku,
    case
      when d.price_raw ~ '^[0-9]+(\.[0-9]+)?$' and d.price_raw::numeric > 0
        then d.price_raw::numeric
      else null
    end as price,
    case
      when d.type_raw ~* 'pre.?order' then 'preorder'
      when d.type_raw ~* 'flash'      then 'flash'
      else 'available'
    end as availability,
    p.id     as product_id,
    p.name   as product_name,
    p.active as was_active,
    -- 2026-08-12: hace falta para saber a quién va a dejar apagado el trigger.
    p.stock  as product_stock,
    -- 2026-08-13: -BOX/-SPECIAL nunca se publican, pase lo que pase.
    public.is_noncatalog_sku(d.sku) as noncatalog
  from dedup d
  left join public.products p on lower(trim(p.sku)) = lower(d.sku);

  create temporary table tmp_deactivate on commit drop as
  select pp.product_id, p.sku, p.name
  from public.product_prices pp
  join public.products p on p.id = pp.product_id
  where pp.price_list_id = v_list.id
    and pp.product_id not in (
      select product_id from tmp_price_rows
      where product_id is not null and price is not null
    );

  select count(*) into v_to_upsert
    from tmp_price_rows where product_id is not null and price is not null;
  -- "A reactivar" = los que van a volver a verse de verdad. Los inactivos con
  -- stock <= 0 y los no-catálogo no vuelven con esta carga: cada uno tiene su
  -- contador, así los tres números no se pisan.
  select count(*) into v_to_reactivate
    from tmp_price_rows
    where product_id is not null and price is not null and was_active = false
      and not noncatalog
      and (product_stock is null or product_stock >= 1);
  select count(*) into v_blocked_by_stock
    from tmp_price_rows
    where product_id is not null and price is not null and was_active = false
      and not noncatalog
      and product_stock is not null and product_stock <= 0;
  -- Acá no se filtra por was_active: el interesante es cuántas filas del archivo
  -- son variantes internas que no se publican, estén como estén hoy.
  select count(*) into v_blocked_noncatalog
    from tmp_price_rows
    where product_id is not null and price is not null and noncatalog;
  select count(*) into v_unknown_skus
    from tmp_price_rows where product_id is null;
  select count(*) into v_invalid_prices
    from tmp_price_rows where product_id is not null and price is null;
  select count(*) into v_to_deactivate from tmp_deactivate;

  select coalesce(jsonb_agg(jsonb_build_object('sku', sku, 'name', name)), '[]'::jsonb)
    into v_deactivate_sample
    from (select sku, name from tmp_deactivate order by sku limit 50) s;

  select coalesce(jsonb_agg(sku), '[]'::jsonb)
    into v_unknown_sample
    from (select sku from tmp_price_rows where product_id is null order by sku limit 50) s;

  if p_commit then
    insert into public.product_prices (product_id, price_list_id, price)
    select product_id, v_list.id, price
    from tmp_price_rows
    where product_id is not null and price is not null
    on conflict (product_id, price_list_id) do update set price = excluded.price;

    -- active = true a propósito, aunque el trigger apague lo que no tenga
    -- stock: el archivo de precios dice "este producto se publica", y el
    -- trigger lo deja marcado para publicarse solo cuando entre stock.
    -- Los no-catálogo quedan fuera del UPDATE (2026-08-13): el trigger
    -- products_enforce_noncatalog revertiría el active = true igual, y así
    -- tampoco se les pisa la etiqueta con la del archivo.
    update public.products p
    set active = true,
        availability = t.availability
    from tmp_price_rows t
    where t.product_id = p.id
      and t.price is not null
      and not t.noncatalog;

    delete from public.product_prices pp
    using tmp_deactivate d
    where pp.product_id = d.product_id
      and pp.price_list_id = v_list.id;

    -- Sacar un producto de la lista es decisión de una persona, así que también
    -- cancela el regreso automático por stock: sin el
    -- `deactivated_by_stock = false`, uno que la regla de stock había apagado
    -- volvería solo al catálogo en la próxima entrada de inventario,
    -- contradiciendo esta misma carga.
    update public.products p
    set active = false,
        deactivated_by_stock = false
    from tmp_deactivate d
    where p.id = d.product_id;
  end if;

  return jsonb_build_object(
    'committed',           p_commit,
    'list',                jsonb_build_object('code', v_list.code, 'label', v_list.label),
    'to_upsert',           v_to_upsert,
    'to_reactivate',       v_to_reactivate,
    'blocked_by_stock',    v_blocked_by_stock,
    'blocked_noncatalog',  v_blocked_noncatalog,
    'to_deactivate',       v_to_deactivate,
    'unknown_skus',        v_unknown_skus,
    'invalid_prices',      v_invalid_prices,
    'deactivate_sample',   v_deactivate_sample,
    'unknown_sample',      v_unknown_sample
  );
end;
$$;

revoke execute on function public.apply_price_list(text, jsonb, boolean) from public;
grant execute on function public.apply_price_list(text, jsonb, boolean) to authenticated;

-- ---------- Selects de prueba (comentados) ----------
-- Correr a mano en el SQL Editor después de aplicar la migración.
--
-- 0) Cuántos -BOX hay y cómo quedaron (esperado: ninguno activo):
-- select count(*) filter (where active) as activos,
--        count(*) filter (where deactivated_by_stock) as marcados_por_stock,
--        count(*) as total
-- from public.products where public.is_noncatalog_sku(sku);
--
-- 1) Un -BOX nuevo entra inactivo aunque se pida activo y con stock:
-- insert into public.products (sku, name, stock, active) values ('BOX-TEST-BOX', 'Prueba caja', 50, true);
-- select sku, stock, availability, active, deactivated_by_stock from public.products where sku = 'BOX-TEST-BOX';
-- -- Esperado: 50 / available / false / false.
--
-- 2) Activarlo a mano no alcanza (lo revierte el trigger):
-- update public.products set active = true where sku = 'BOX-TEST-BOX';
-- -- Esperado: sigue active = false.
--
-- 3) Entrar stock tampoco lo publica:
-- update public.products set stock = 0 where sku = 'BOX-TEST-BOX';
-- update public.products set stock = 99 where sku = 'BOX-TEST-BOX';
-- -- Esperado en los dos: active = false, deactivated_by_stock = false.
--
-- 4) El sync no lo jala (esperado {"inserted": 0, "updated": 0, "skipped": 1}):
-- select public.sync_upsert_products('[
--   {"sku": "OTRO-BOX", "name": "No debe entrar", "product_line": "Perfume", "inventory": "10"}
-- ]'::jsonb);
-- select count(*) from public.products where sku = 'OTRO-BOX';   -- esperado 0
--
-- 5) Cambiarle el SKU es la salida si alguna vez hay que venderlo:
-- update public.products set sku = 'BOX-TEST-OK', active = true where sku = 'BOX-TEST-BOX';
-- -- Esperado: active = true (ya no matchea la regla).
--
-- Limpieza:
-- delete from public.products where sku in ('BOX-TEST-BOX', 'BOX-TEST-OK', 'OTRO-BOX');
--
-- 6) Preview de una lista de precio con un -BOX adentro (no commitea):
-- select public.apply_price_list('us_wholesale', '[
--   {"sku": "ZX_PE-AB-M-636268-ZX-BOX", "price": "100", "type": "Available"}
-- ]'::jsonb, false);
-- -- Esperado: blocked_noncatalog = 1 y to_reactivate = 0.
