-- Carga de listas de precio, una lista por archivo (2026-07-17, a pedido
-- del usuario). Reemplaza el flujo anterior de PricesUpload.jsx (matriz
-- multi-columna con upsert directo a product_prices desde el frontend),
-- que reventaba con "ON CONFLICT DO UPDATE command cannot affect row a
-- second time" apenas el Excel traía un SKU repetido (pasó con el archivo
-- real de US Minimum Order, 2.758 filas, SKU ZX_PE-MA-U-599175 duplicado).
--
-- La deduplicación por SKU ahora vive del lado del servidor (última fila
-- del archivo gana), así que ese crash queda resuelto de raíz sin que el
-- frontend tenga que preocuparse por duplicados.
--
-- Contrato:
--   apply_price_list(p_price_list_code text, p_rows jsonb, p_commit boolean default false)
--     p_rows: [{ "sku": "...", "price": "20.02", "type": "Available" }, ...]
--     p_commit = false → solo preview, no escribe nada.
--     p_commit = true  → aplica los cambios.
--
-- Comportamiento intencional (decisión del usuario, no un bug):
--   * Producto en el archivo con SKU y precio válidos: upsert de precio en
--     esta lista + availability desde Type + se reactiva (active = true)
--     si estaba inactivo.
--   * Producto que HOY tiene precio en esta lista pero no aparece en el
--     archivo (o aparece con SKU/precio inválido): se le borra el precio
--     de ESTA lista y se pone active = false GLOBAL. Es una carga
--     "reemplaza todo" por lista, por eso el flujo obliga a mostrar un
--     preview con estos contadores antes de escribir nada.
--
-- Idempotente (create or replace); no toca datos existentes al correrla.
set lock_timeout = '10s';

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
  v_list              public.price_lists%rowtype;
  v_to_upsert         int;
  v_to_reactivate     int;
  v_to_deactivate     int;
  v_unknown_skus      int;
  v_invalid_prices    int;
  v_deactivate_sample jsonb;
  v_unknown_sample    jsonb;
begin
  if not public.is_admin() then
    raise exception 'no tenés permiso para aplicar listas de precio';
  end if;

  select * into v_list from public.price_lists where code = p_price_list_code;
  if not found then
    raise exception 'lista de precio no encontrada: %', p_price_list_code;
  end if;

  -- Evita choque si la función se llama dos veces en la misma transacción
  -- (ej. probando a mano en el SQL Editor); "on commit drop" ya la limpia
  -- al terminar cada llamada normal desde la app.
  drop table if exists pg_temp.tmp_price_rows;
  drop table if exists pg_temp.tmp_deactivate;

  -- Filas del archivo: dedupe por SKU (última fila gana), matcheadas
  -- contra products y con el precio/tipo ya validados.
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
      when d.price_raw ~ '^[0-9]+(\.[0-9]+)?$' then d.price_raw::numeric
      else null
    end as price,
    case
      when d.type_raw ~* 'pre.?order' then 'preorder'
      when d.type_raw ~* 'flash'      then 'flash'
      else 'available'
    end as availability,
    p.id     as product_id,
    p.name   as product_name,
    p.active as was_active
  from dedup d
  left join public.products p on lower(trim(p.sku)) = lower(d.sku);

  -- Productos con precio HOY en esta lista que no vinieron (con SKU/precio
  -- válidos) en el archivo: se les apaga el precio de esta lista y el
  -- producto entero.
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
  select count(*) into v_to_reactivate
    from tmp_price_rows where product_id is not null and price is not null and was_active = false;
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

    update public.products p
    set active = true,
        availability = t.availability
    from tmp_price_rows t
    where t.product_id = p.id
      and t.price is not null;

    delete from public.product_prices pp
    using tmp_deactivate d
    where pp.product_id = d.product_id
      and pp.price_list_id = v_list.id;

    update public.products p
    set active = false
    from tmp_deactivate d
    where p.id = d.product_id;
  end if;

  return jsonb_build_object(
    'committed',          p_commit,
    'list',               jsonb_build_object('code', v_list.code, 'label', v_list.label),
    'to_upsert',          v_to_upsert,
    'to_reactivate',      v_to_reactivate,
    'to_deactivate',      v_to_deactivate,
    'unknown_skus',       v_unknown_skus,
    'invalid_prices',     v_invalid_prices,
    'deactivate_sample',  v_deactivate_sample,
    'unknown_sample',     v_unknown_sample
  );
end;
$$;

revoke execute on function public.apply_price_list(text, jsonb, boolean) from public;
grant execute on function public.apply_price_list(text, jsonb, boolean) to authenticated;

-- ---------- Verificación manual (SQL Editor) ----------
-- El SQL Editor corre como postgres, no como un usuario authenticated:
-- is_admin() da false ahí y la función siempre tira la excepción de
-- permiso — para probarla de verdad hay que loguearse en la app. Chequeo
-- rápido de que quedó bien creada:
-- select proname, prosecdef from pg_proc where proname = 'apply_price_list';
