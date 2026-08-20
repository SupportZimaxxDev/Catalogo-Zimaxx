-- ============================================================
-- 2026-08-20: apply_price_list deja su resumen en system_logs
--
-- Parte de la instrumentación de logs de hoy (ver
-- migration-2026-08-20-system-logs.sql). Hasta ahora los contadores de una
-- carga de precios (aplicados, bloqueados por stock, no-catálogo,
-- desactivados por quedar fuera del archivo) solo existían en la respuesta
-- efímera de la RPC: se veían en el aviso verde del panel y desaparecían al
-- navegar. Ahora cada aplicación CONFIRMADA (p_commit = true) deja un `info`
-- `price_apply_summary` en system_logs con esos mismos contadores — el
-- preview (p_commit = false) no loguea nada, porque no escribió nada.
--
-- Es la MISMA función del 2026-08-13 (migration-2026-08-13-exclude-box-skus.sql,
-- sección 5) con un único agregado al final: el perform de log_event antes del
-- return. **Ni la firma ni el jsonb de retorno cambian**: el frontend viejo
-- sigue funcionando idéntico con la función nueva, y el nuevo con la vieja
-- (solo que sin resumen en el log).
--
-- Por qué el log va DENTRO de la función y no en el frontend: así comparte
-- transacción con la carga — si la carga commitea, el log queda; si algo
-- revienta a mitad, se revierten juntos y no queda un resumen de una carga
-- que no pasó.
--
-- Y por qué el caso de ERROR se loguea desde el frontend (PricesUpload.jsx) y
-- no acá: una excepción dentro de la función aborta la transacción entera de
-- PostgREST, INCLUIDO cualquier insert a system_logs hecho adentro — un
-- `exception when others` que loguee y re-lance dejaría el log revertido
-- junto con todo lo demás. El único lugar donde el error sobrevive es el
-- caller, que lo manda en un request nuevo (log_event con
-- `price_apply_failed`).
--
-- log_event NUNCA lanza (atrapa sus propios errores y devuelve null con
-- warning), así que este agregado no puede hacer fallar una carga que hasta
-- hoy funcionaba.
--
-- REQUIERE, en este orden:
--   1. migration-2026-08-13-exclude-box-skus.sql   (is_noncatalog_sku y la
--      versión de la función sobre la que se montó esta)
--   2. migration-2026-08-20-system-logs.sql        (log_event)
-- El preflight corta si falta cualquiera.
--
-- Idempotente (create or replace), aditiva: se puede correr antes o después
-- del deploy del frontend.
-- ============================================================
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regprocedure('public.is_noncatalog_sku(text)') is null then
    raise exception 'Falta correr migration-2026-08-13-exclude-box-skus.sql (crea is_noncatalog_sku) antes de esta';
  end if;
  if to_regprocedure('public.log_event(text, text, text, text, jsonb)') is null then
    raise exception 'Falta correr migration-2026-08-20-system-logs.sql (crea log_event) antes de esta';
  end if;
end $$;

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

    -- 2026-08-20: el resumen de la carga queda en system_logs (pestaña ⚙️
    -- Sistema). Mismos contadores que devuelve la RPC; comparte transacción
    -- con la carga, así que solo queda si la carga quedó. log_event no lanza
    -- nunca — un fallo del log no puede hacer fallar la carga.
    perform public.log_event(
      'info',
      'price_upload',
      'price_apply_summary',
      format('Lista %s: %s precios aplicados, %s desactivados por quedar fuera del archivo',
             v_list.code, v_to_upsert, v_to_deactivate),
      jsonb_build_object(
        'list_code',          v_list.code,
        'list_label',         v_list.label,
        'rows_in_file',       coalesce(jsonb_array_length(p_rows), 0),
        'to_upsert',          v_to_upsert,
        'to_reactivate',      v_to_reactivate,
        'blocked_by_stock',   v_blocked_by_stock,
        'blocked_noncatalog', v_blocked_noncatalog,
        'to_deactivate',      v_to_deactivate,
        'unknown_skus',       v_unknown_skus,
        'invalid_prices',     v_invalid_prices
      )
    );
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

-- ---------- Verificación manual (SQL Editor) ----------
-- El SQL Editor corre como postgres: is_admin() da false y la función tira la
-- excepción de permiso — la prueba real es desde la pestaña Precios. Chequeo
-- rápido de que el reemplazo quedó (debe nombrar log_event en el cuerpo):
-- select proname from pg_proc where proname = 'apply_price_list'
--   and prosrc like '%price_apply_summary%';
--
-- Después de una carga confirmada desde el panel:
-- select created_at, message, context from public.system_logs
-- where event = 'price_apply_summary' order by id desc limit 5;
