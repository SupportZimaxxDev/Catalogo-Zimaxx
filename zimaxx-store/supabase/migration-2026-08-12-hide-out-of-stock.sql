-- 2026-08-12: un producto sin stock sale del catálogo (a pedido del usuario:
-- "cuando un producto quede con stock 0 en la base de datos, que se siga
-- poniendo en pre-order pero que se desactive, es decir, que no salga en el
-- catálogo").
--
-- Esto REVIERTE a propósito media decisión de 2026-07-14
-- (migration-2026-07-14-inventory-stock.sql, que decía textualmente: "Un
-- producto con stock 0 ahora se MUESTRA como pre-order (antes se ocultaba como
-- inactivo); ocultarlo es una acción manual aparte"). Lo que se mantiene de esa
-- decisión es la ETIQUETA: el producto sigue quedando en 'preorder', porque es
-- el dato con el que la asesora sabe que se puede reservar. Lo que cambia es la
-- PUBLICACIÓN: deja de aparecer en el catálogo del cliente.
--
--   stock null  → no se toca nada (no se sabe el stock; manda lo que se escriba)
--   stock >= 1  → 'available'  + activo si lo había apagado esta regla
--   stock <= 0  → 'preorder'   + INACTIVO (no sale en get_catalog)
--   'flash'     → la etiqueta 🔥 se conserva siempre, pero con stock <= 0
--                 también se desactiva (la etiqueta no publica nada)
--
-- Tres decisiones confirmadas con el usuario antes de escribir esto:
--
--   1) Vuelve solo cuando entra stock, pero SOLO el que apagó esta regla. Para
--      eso está la columna nueva products.deactivated_by_stock: es la memoria de
--      "a este lo apagó el stock, no una persona". Sin ella, reactivar por stock
--      resucitaría los productos que el admin apagó a mano y, peor, los de la
--      exclusión de no-catálogo (SKU -SPECIAL, beauty/electronics/support/
--      packing and shipping supplies/test — migration-2026-07-13-exclude-
--      noncatalog.sql), que tienen stock de sobra y no deben verse nunca.
--   2) Un producto 🔥 Flash Sale con stock 0 también se desactiva. Conserva la
--      etiqueta (el stock nunca la pisa), pero no se publica: la Flash Sale es
--      para mover inventario, y sin inventario no hay nada que mover.
--   3) Los que HOY ya están activos con stock <= 0 se apagan en esta misma
--      migración (paso 3), marcados con la bandera. Si no, seguirían visibles
--      hasta la próxima corrida del sync que les vuelva a escribir el stock.
--
-- Invariante que queda en la tabla, y que es lo único que hay que recordar para
-- no romper esto:
--
--   deactivated_by_stock = true  → está inactivo porque se quedó sin stock, y
--                                  se prende SOLO cuando entre stock
--   deactivated_by_stock = false → si está inactivo, lo apagó una persona (o la
--                                  exclusión de no-catálogo) y solo una persona
--                                  lo vuelve a prender
--
-- Idempotente, se puede re-correr. lock_timeout corto para fallar rápido y
-- limpio si un lock se traba contra producción.
set lock_timeout = '10s';

-- ---------- 1) Columna ----------
-- No es "el producto está sin stock" (eso ya lo dice products.stock): es "esta
-- regla fue la que lo apagó". Por eso es una bandera y no un cálculo.
alter table public.products
  add column if not exists deactivated_by_stock boolean not null default false;

comment on column public.products.deactivated_by_stock is
  'true = lo desactivó la regla de stock 0 (2026-08-12) y vuelve solo cuando entre stock. false = si está inactivo, lo apagó una persona o la exclusión de no-catálogo, y solo una persona lo reactiva.';

-- ---------- 2) Trigger ----------
-- La regla de la ETIQUETA (available/preorder/flash) es la de 2026-08-04, sin
-- tocar. Lo nuevo es el bloque de publicación al final.
--
-- Sigue viviendo en un trigger y no en cada camino de escritura: da igual quién
-- escriba (el sync de n8n, el Excel de productos, el Excel de precios, la carga
-- masiva del panel, el formulario, el descuento de un pedido atendido o un
-- request directo con la anon key), un producto en 0 no puede quedar publicado.
create or replace function public.products_availability_from_stock()
returns trigger
language plpgsql
as $$
begin
  -- Sin dato de stock no se deduce nada: null es "todavía no se sabe", no "0".
  if new.stock is null then
    return new;
  end if;

  -- Etiqueta. 'flash' se conserva siempre; el stock solo alterna
  -- available <-> preorder.
  if coalesce(new.availability, '') <> 'flash' then
    new.availability := case when new.stock >= 1 then 'available' else 'preorder' end;
  end if;

  -- Publicación (2026-08-12).
  if new.stock <= 0 then
    -- Solo se marca la bandera cuando ESTA regla es la que apaga. Si la fila ya
    -- venía inactiva, la bandera queda como está: puede ser un producto que el
    -- admin apagó a mano (false, no vuelve solo) o uno que esta regla ya apagó
    -- antes (true, sigue esperando stock).
    if new.active then
      new.active               := false;
      new.deactivated_by_stock := true;
    end if;
  elsif new.deactivated_by_stock then
    -- Entró stock y el que lo había apagado era el stock: vuelve al catálogo.
    new.active               := true;
    new.deactivated_by_stock := false;
  end if;

  return new;
end;
$$;

drop trigger if exists products_availability_from_stock on public.products;
create trigger products_availability_from_stock
  before insert or update on public.products
  for each row execute function public.products_availability_from_stock();

-- ---------- 3) Backfill ----------
-- Los que hoy están publicados con stock <= 0. El update dispara el trigger, así
-- que la bandera y la etiqueta las pone él; el `set` explícito está para que la
-- fila cambie (un update que no cambia nada igual dispara el trigger, pero así
-- el `where` y el efecto se leen juntos).
do $$
declare
  v_before int;
  v_after  int;
begin
  select count(*) into v_before
  from public.products
  where active and stock is not null and stock <= 0;

  update public.products
  set active = false, deactivated_by_stock = true
  where active and stock is not null and stock <= 0;

  select count(*) into v_after
  from public.products
  where active and stock is not null and stock <= 0;

  raise notice 'backfill: % productos activos con stock <= 0 → desactivados. Quedan activos con stock <= 0: %', v_before, v_after;
  raise notice 'inactivos por stock (vuelven solos cuando entre stock): %',
    (select count(*) from public.products where deactivated_by_stock);
end;
$$;

-- ---------- 4) apply_price_list: que el preview no prometa de más ----------
-- Copia exacta de la función de schema.sql (verificada con un diff ignorando
-- comentarios) con dos cambios de comportamiento. El primero: el contador "a
-- reactivar" del preview dejaba de ser cierto con la regla nueva. La carga de precios sigue
-- escribiendo active = true para todo lo que trae precio en el archivo — está
-- bien, es "este producto se publica" — pero el trigger deja apagado lo que
-- tenga stock <= 0 (con la bandera puesta, o sea que se publica solo cuando
-- entre stock). Sin este cambio el preview decía "12 a reactivar" y volvían 7.
--
-- El segundo: el UPDATE que desactiva lo que el archivo dejó fuera de la lista
-- ahora apaga también la bandera. Es una decisión de una persona, así que tiene
-- que cancelar el regreso automático por stock — si no, la próxima entrada de
-- inventario republicaría justo lo que esta carga sacó.
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
  v_blocked_by_stock  int;   -- 2026-08-12
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
    p.stock  as product_stock
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
  -- "A reactivar" = los que van a volver a verse de verdad. Los que están
  -- inactivos con stock <= 0 no vuelven ahora (van al contador de abajo).
  select count(*) into v_to_reactivate
    from tmp_price_rows
    where product_id is not null and price is not null and was_active = false
      and (product_stock is null or product_stock >= 1);
  select count(*) into v_blocked_by_stock
    from tmp_price_rows
    where product_id is not null and price is not null and was_active = false
      and product_stock is not null and product_stock <= 0;
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
    'committed',          p_commit,
    'list',               jsonb_build_object('code', v_list.code, 'label', v_list.label),
    'to_upsert',          v_to_upsert,
    'to_reactivate',      v_to_reactivate,
    'blocked_by_stock',   v_blocked_by_stock,
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

-- ---------- 5) compute_order_items: no perder la línea del carrito ----------
-- Copia exacta de la función de schema.sql con un solo cambio: el producto se
-- busca con `(p.active or p.deactivated_by_stock)` en vez de solo `active`.
--
-- Por qué. La línea de un producto inactivo se descarta en silencio (`if not
-- found then continue`), y desde hoy quedarse sin stock DESACTIVA. Sin este
-- cambio, un cliente que tiene el producto en el carrito y lo manda dos minutos
-- después de que el sync bajó el stock a 0 pierde esa línea sin que nadie se
-- entere: el pedido entra con menos ítems y el aviso del carrito ("la
-- disponibilidad y el precio hay que confirmarlos con la asesora") queda en
-- nada. En este proyecto una línea que se cae en silencio ya costó un pedido de
-- ~10k.
--
-- La bandera es justo la diferencia que hace falta: se sigue pudiendo pedir lo
-- que salió del catálogo por falta de stock (es un pre-order, "agotado pero se
-- puede reservar"), y lo que apagó una persona sigue sin poder pedirse. Para
-- volver atrás alcanza con sacar el `or p.deactivated_by_stock`.
create or replace function public.compute_order_items(
  p_client_id uuid,
  p_items     jsonb,
  p_kind      text
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_client    public.clients%rowtype;
  v_item      jsonb;
  v_id        uuid;
  v_qty       int;
  v_flash     boolean;
  v_product   public.products%rowtype;
  v_price     numeric;
  v_items     jsonb   := '[]'::jsonb;
  v_total     numeric := 0;
  v_has_price boolean := false;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    return jsonb_build_object('items', '[]'::jsonb, 'total', null);
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_id    := (v_item->>'id')::uuid;
      v_qty   := floor((v_item->>'qty')::numeric)::int;
      v_flash := coalesce((v_item->>'flash')::boolean, false);
    exception when others then
      continue; -- ítem malformado: se descarta, no tumba el pedido
    end;
    -- ojo: least/greatest ignoran null, por eso el chequeo va antes del tope
    if v_qty is null or v_qty < 1 then continue; end if;
    if v_qty > 9999 then v_qty := 9999; end if;

    -- 2026-08-12: `or p.deactivated_by_stock` (ver el comentario de arriba).
    select p.* into v_product
    from public.products p
    where p.id = v_id
      and (p.active or p.deactivated_by_stock);
    if not found then continue; end if;

    v_price := null;
    if p_kind = 'order' then
      if v_flash then
        select fs.price into v_price
        from public.flash_sales fs
        where fs.product_id = v_id
          and fs.active
          and fs.price > 0
          and now() >= fs.starts_at
          and now() < fs.expires_at
        order by fs.price
        limit 1;
      end if;
      if v_price is null then
        select pp.price into v_price
        from public.product_prices pp
        where pp.product_id = v_id
          and pp.price_list_id = v_client.price_list_id
          and pp.price > 0;
      end if;
    end if;

    v_items := v_items || jsonb_build_object(
      'id',    v_product.id,
      'sku',   v_product.sku,
      'name',  v_product.name,
      'qty',   v_qty,
      'price', v_price,
      'flash', v_flash
    );
    if v_price is not null then
      v_total     := v_total + v_price * v_qty;
      v_has_price := true;
    end if;
  end loop;

  return jsonb_build_object(
    'items', v_items,
    'total', case when p_kind = 'order' and v_has_price then round(v_total, 2) else null end
  );
end;
$$;

revoke execute on function public.compute_order_items(uuid, jsonb, text) from public;

-- ---------- Selects de prueba (comentados) ----------
-- Correr a mano en el SQL Editor después de aplicar la migración.
--
-- 0) Producto de prueba con stock:
-- insert into public.products (sku, name, stock) values ('OOS-TEST', 'Test sin stock', 5);
-- select sku, stock, availability, active, deactivated_by_stock
-- from public.products where sku = 'OOS-TEST';
-- -- Esperado: 5 / available / true / false.
--
-- 1) Se queda sin stock → pre-order + inactivo + bandera:
-- update public.products set stock = 0 where sku = 'OOS-TEST';
-- -- Esperado: 0 / preorder / false / true.
--
-- 2) Activarlo a mano NO alcanza mientras siga en 0 (queda marcado para
--    publicarse cuando entre stock):
-- update public.products set active = true where sku = 'OOS-TEST';
-- -- Esperado: sigue active = false, deactivated_by_stock = true.
--
-- 3) Entra stock → vuelve solo:
-- update public.products set stock = 3 where sku = 'OOS-TEST';
-- -- Esperado: 3 / available / true / false.
--
-- 4) El que apagó una persona NO vuelve por stock:
-- update public.products set active = false, deactivated_by_stock = false where sku = 'OOS-TEST';
-- update public.products set stock = 0  where sku = 'OOS-TEST';   -- sigue apagado, bandera false
-- update public.products set stock = 10 where sku = 'OOS-TEST';   -- sigue apagado
-- -- Esperado en los dos: active = false, deactivated_by_stock = false.
--
-- 5) 🔥 conserva la etiqueta pero tampoco se publica sin stock:
-- update public.products set active = true, deactivated_by_stock = false, availability = 'flash', stock = 0
-- where sku = 'OOS-TEST';
-- -- Esperado: availability 'flash', active = false, deactivated_by_stock = true.
--
-- 6) El catálogo no lo trae (usar un token de cliente real):
-- select count(*) from jsonb_array_elements(public.get_catalog('<token>')->'products') e
-- where (e->>'id')::uuid = (select id from public.products where sku = 'OOS-TEST');
-- -- Esperado: 0.
--
-- Limpieza:
-- delete from public.products where sku = 'OOS-TEST';
--
-- 7) Cuántos productos tapó la regla (para mirar después de la primera corrida
--    del sync):
-- select count(*) from public.products where deactivated_by_stock;
-- select sku, name, stock from public.products where deactivated_by_stock order by name limit 50;
