-- 2026-08-14: el UPC deja de ser un dato interno del panel y viaja al
-- catálogo del cliente y al PDF de cotización.
--
-- Contexto. `products.upc` existe desde migration-2026-07-14-product-upc.sql,
-- pero nació explícitamente como dato interno: se ve, se edita y se busca en
-- la pestaña Productos, y `get_catalog` nunca lo devolvía. A pedido del
-- usuario ahora sí se muestra al cliente (tarjeta del catálogo y carrito) y
-- se imprime como columna propia del PDF.
--
-- Dos funciones tocadas, las dos son copia exacta de la versión viva con una
-- sola clave nueva en el jsonb del producto/ítem:
--
--   1) get_catalog        → 'upc' en las dos ramas (lista 'quote' y lista con
--                           precios). De acá lo toma la tarjeta del catálogo,
--                           el carrito y el PDF que descarga el cliente.
--   2) compute_order_items → 'upc' en cada ítem guardado. Sin esto, el PDF que
--                           descarga la vendedora desde la pestaña Pedidos
--                           sale con la columna UPC vacía: esos ítems no
--                           vienen del carrito, los arma el servidor.
--
-- Compatibilidad. El frontend no depende de esta migración para no romperse:
-- si no está corrida, `product.upc`/`item.upc` llegan `undefined` y la línea
-- del UPC simplemente no se dibuja (misma salida que un producto sin UPC
-- cargado). O sea que se puede desplegar el frontend antes, y los pedidos ya
-- guardados —que no tienen la clave— siguen imprimiéndose igual, sin UPC.
--
-- No hay cambios de esquema ni de permisos: mismas firmas, mismos grants.
-- Idempotente, se puede re-correr. lock_timeout corto para fallar rápido y
-- limpio si un lock se traba contra producción.
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products' and column_name = 'upc'
  ) then
    raise exception using message =
      'Falta products.upc: corré primero migration-2026-07-14-product-upc.sql';
  end if;

  -- La copia de compute_order_items de acá abajo incluye el
  -- `or p.deactivated_by_stock` de 2026-08-12. Si esa columna no existiera, esta
  -- migración fallaría a mitad con un 42703 mucho menos claro que este mensaje.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products'
      and column_name = 'deactivated_by_stock'
  ) then
    raise exception using message =
      'Falta products.deactivated_by_stock: corré primero migration-2026-08-12-hide-out-of-stock.sql';
  end if;
end $$;

-- ---------- 1) get_catalog: el UPC viaja al catálogo ----------
-- Copia exacta de la versión viva (migration-2026-08-06-require-price.sql) con
-- un solo cambio: la clave 'upc' en las dos ramas.
create or replace function public.get_catalog(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_client          public.clients%rowtype;
  v_code            text;
  v_vendedora_name  text;
  v_vendedora_phone text;
  v_products        jsonb;
begin
  if p_token is null or length(p_token) = 0 then
    return null;
  end if;

  select * into v_client from public.clients where token = p_token;
  if not found then
    return null;
  end if;

  select code into v_code from public.price_lists where id = v_client.price_list_id;
  select name, phone into v_vendedora_name, v_vendedora_phone
  from public.vendedores where id = v_client.vendedora_id;

  if v_code = 'quote' then
    -- Catálogo de cotización: acá `price = null` es el diseño, no un dato
    -- faltante — el cliente ve todo el catálogo y el precio se arma después.
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',           p.id,
          'name',         p.name,
          'upc',          p.upc,
          'category',     p.category,
          'product_line', p.product_line,
          'image_url',    p.image_url,
          'availability', p.availability,
          'is_new',       (p.new_until is not null and now() < p.new_until),
          'price',        null
        )
        order by p.category nulls last, p.name
      ),
      '[]'::jsonb
    )
    into v_products
    from public.products p
    where p.active;
  else
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',           p.id,
          'name',         p.name,
          'upc',          p.upc,
          'category',     p.category,
          'product_line', p.product_line,
          'image_url',    p.image_url,
          'availability', p.availability,
          'is_new',       (p.new_until is not null and now() < p.new_until),
          'price',        pp.price
        )
        order by p.category nulls last, p.name
      ),
      '[]'::jsonb
    )
    into v_products
    from public.products p
    left join public.product_prices pp
      on pp.product_id = p.id
     and pp.price_list_id = v_client.price_list_id
    where p.active
      -- 2026-08-06: `> 0` y no `is not null`. Un precio 0 no es un precio: era
      -- la puerta por la que un producto entraba al catálogo en $0.00 y se
      -- podía pedir gratis.
      and pp.price > 0;
  end if;

  return jsonb_build_object(
    'client', jsonb_build_object(
      'name',            v_client.name,
      'vendedora',       v_vendedora_name,
      'vendedora_phone', v_vendedora_phone,
      'price_list_code', v_code,
      'is_quote_only',   v_code = 'quote'
    ),
    'products', v_products
  );
end;
$$;

revoke execute on function public.get_catalog(text) from public;
grant execute on function public.get_catalog(text) to anon, authenticated;

-- ---------- 2) compute_order_items: el UPC queda guardado en el ítem ----------
-- Copia exacta de la versión viva (migration-2026-08-12-hide-out-of-stock.sql)
-- con un solo cambio: la clave 'upc' del ítem.
--
-- Se guarda una copia del UPC en el pedido —igual que ya se hacía con `sku` y
-- `name`— en vez de resolverlo al vuelo contra `products`: el ítem de un pedido
-- es un recibo de lo que se pidió ese día, y si el UPC se corrige después, el
-- PDF de un pedido viejo no debería cambiar solo. Los pedidos ya guardados no
-- se tocan: siguen sin la clave y su PDF sale sin UPC.
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

    -- 2026-08-12: `or p.deactivated_by_stock`. Lo que salió del catálogo por
    -- falta de stock se sigue pudiendo pedir (es un pre-order); lo que apagó una
    -- persona, no. Sin esto, la línea se caía en silencio.
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
      'upc',   v_product.upc,
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
-- 1) El catálogo trae el UPC (usar un token de cliente real). Debe devolver
--    tantas filas con upc no nulo como productos con UPC cargado tenga la lista:
-- select count(*) filter (where e->>'upc' is not null) as con_upc,
--        count(*)                                      as total
-- from jsonb_array_elements(public.get_catalog('<token>')->'products') e;
--
-- 2) Un producto puntual, para comparar contra la pestaña Productos:
-- select e->>'name', e->>'upc'
-- from jsonb_array_elements(public.get_catalog('<token>')->'products') e
-- where e->>'name' ilike '%<parte del nombre>%';
--
-- 3) Los ítems de un pedido nuevo guardan el UPC. Con un cliente y un producto
--    con UPC cargado (no escribe nada: compute_order_items no inserta):
-- select public.compute_order_items(
--   (select id from public.clients where token = '<token>'),
--   jsonb_build_array(jsonb_build_object(
--     'id',  (select id from public.products where upc is not null and active limit 1),
--     'qty', 2)),
--   'order');
-- -- Esperado: cada ítem con las claves id/sku/upc/name/qty/price/flash.
--
-- 4) Una cotización ya guardada, recalculada con precio vigente, también lo
--    trae (get_quotes_live_pricing usa compute_order_items por dentro):
-- select jsonb_pretty(public.get_quotes_live_pricing(
--   array[(select id from public.orders where kind = 'quote' order by created_at desc limit 1)]));
