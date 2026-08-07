-- ============================================================
-- 2026-08-06: un producto sin precio NO sale en el catálogo
--
-- Contexto (a pedido del usuario): "si por alguna razón un producto no tiene
-- precio, que no salga en el catálogo".
--
-- `get_catalog` ya excluía los productos sin fila en `product_prices` para la
-- lista del cliente (`and pp.price is not null`). El agujero que quedaba es el
-- **precio 0**: `product_prices.price` es `numeric(10,2) not null
-- check (price >= 0)`, o sea que 0 es un valor perfectamente válido para la
-- tabla, y `apply_price_list` lo acepta sin chistar — su regex de parseo
-- (`^[0-9]+(\.[0-9]+)?$`) matchea "0" y "0.00" igual que cualquier otro número.
-- Una celda en 0 en el Excel de precios (o una columna corrida) alcanzaba para
-- que el producto entrara al catálogo mostrando **$0.00**, se pudiera agregar al
-- carrito y se registrara un pedido con esa línea en cero: create_order
-- recalcula el precio del lado del servidor, pero 0 es "un precio" para toda la
-- cadena, así que lo tomaba como bueno.
--
-- LA REGLA, de acá en adelante y en un solo enunciado:
--   ** un precio de 0 es lo mismo que no tener precio **
-- y un producto sin precio no se muestra, no se cotiza y no se puede pedir.
--
-- Se aplica en los cinco lugares donde tiene que valer, porque cada uno es una
-- puerta distinta a lo mismo:
--   1. get_catalog            → no aparece en el catálogo del cliente
--   2. get_flash_sales        → no aparece en la sección Flash Sale
--   3. compute_order_items    → no se le calcula precio (un 0 pasa a ser null,
--                               así todo lo que ya manejaba "sin precio" sigue
--                               funcionando igual sin tocarlo)
--   4. create_order /         → no se registra un pedido con líneas sin precio
--      convert_quote_to_order
--   5. apply_price_list       → un 0 en el Excel cuenta como precio inválido y
--                               no se carga
--
-- Lo que NO cambia:
--   * La lista 'quote' sigue devolviendo TODOS los productos activos con
--     `price = null` a propósito (catálogo de cotización sin precios, 2026-07-08).
--     Esa rama de get_catalog no se toca: ahí "sin precio" es la función, no un
--     error.
--   * Las cotizaciones (`kind = 'quote'`) siguen guardándose sin precio.
--   * No se borra ni se corrige ningún dato. Las filas con `price = 0` que ya
--     existan quedan donde están; simplemente dejan de publicar el producto.
--     Al final del archivo hay una consulta para listarlas.
--
-- REQUIERE que ya estén corridas:
--   * migration-2026-07-17-apply-price-list.sql   (crea apply_price_list)
--   * migration-2026-08-05-order-capture.sql      (crea order_failures, y
--                                                  create_order con p_request_id)
-- El preflight de abajo corta con un mensaje claro si falta alguna.
--
-- Re-corrible: son todos `create or replace function`.
-- ============================================================

set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regprocedure('public.apply_price_list(text, jsonb, boolean)') is null then
    raise exception 'Falta correr migration-2026-07-17-apply-price-list.sql (crea apply_price_list) antes de esta';
  end if;
  if to_regclass('public.order_failures') is null then
    raise exception 'Falta correr migration-2026-08-05-order-capture.sql (crea order_failures) antes de esta';
  end if;
  if to_regprocedure('public.create_order(text, jsonb, numeric, text, uuid)') is null then
    raise exception 'Falta correr migration-2026-08-05-order-capture.sql (create_order con p_request_id) antes de esta';
  end if;
  if to_regprocedure('public.compute_order_items(uuid, jsonb, text)') is null then
    raise exception 'Falta correr migration-2026-07-17-orders-edit-live-quotes.sql (crea compute_order_items) antes de esta';
  end if;
end $$;

begin;

-- ---------- 1) get_catalog: sin precio usable, el producto no se lista ----------
-- Único cambio respecto de la versión anterior: `pp.price > 0` donde antes
-- decía `pp.price is not null`. La rama de la lista 'quote' queda idéntica.
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

-- ---------- 2) get_flash_sales: una oferta en 0 no se publica ----------
-- `flash_sales.price` tiene el mismo `check (price >= 0)`, así que una carga
-- masiva con la columna de precio corrida podía dejar la sección Flash Sale
-- llena de $0.00. Mismo criterio que arriba.
create or replace function public.get_flash_sales()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',           fs.id,
        'product_id',   p.id,
        'name',         p.name,
        'category',     p.category,
        'image_url',    p.image_url,
        'availability', p.availability,
        'price',        fs.price,
        'expires_at',   fs.expires_at
      )
      order by fs.expires_at
    ),
    '[]'::jsonb
  )
  from public.flash_sales fs
  join public.products p on p.id = fs.product_id and p.active
  where fs.active
    and fs.price > 0
    and now() >= fs.starts_at
    and now() < fs.expires_at;
$$;

revoke execute on function public.get_flash_sales() from public;
grant execute on function public.get_flash_sales() to anon, authenticated;

-- ---------- 3) compute_order_items: un 0 se comporta como "sin precio" ----------
-- Los dos lookups de precio (flash y lista) piden `> 0`. Así `v_price` queda en
-- null igual que cuando no hay fila, y TODO lo que ya sabía tratar "sin precio"
-- (el total que no suma, el '—' de la tabla de pedidos, el PDF sin precios)
-- sigue funcionando sin cambios.
--
-- A propósito el ítem NO se descarta: se guarda con `price: null`. Descartarlo
-- haría desaparecer la línea de la vista de cotizaciones con precio vigente
-- (get_quotes_live_pricing) sin decir nada, y en este proyecto una línea que se
-- cae en silencio ya costó un pedido de ~10k. Quien decide qué hacer con una
-- línea sin precio es el que crea el pedido — ver create_order y
-- convert_quote_to_order abajo.
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

    select * into v_product from public.products where id = v_id and active;
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
      -- Sin flash vigente (o expiró entre carrito y checkout): precio de lista.
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

-- ---------- 4a) create_order: no se guarda un pedido con líneas sin precio ----
-- Con el filtro de get_catalog esto ya es un caso de borde (el cliente no puede
-- ver un producto sin precio), pero queda como red: la sección Flash Sale se
-- sirve sin token, así que no sabe la lista del cliente, y si una oferta expira
-- entre el carrito y el checkout el precio cae a la lista — que puede no tener
-- ese producto.
--
-- Se rechaza el pedido ENTERO y se registra en `order_failures` con los SKU
-- culpables, en vez de guardar un pedido con una línea en cero. Así el admin lo
-- ve en el aviso rojo de la pestaña Pedidos, carga el precio que falta y le da
-- "Recuperar" (recover_order_failure lo recalcula con los precios vigentes):
-- exactamente el mecanismo que se construyó en 2026-08-05 para que un pedido
-- rechazado no desaparezca sin dejar rastro.
create or replace function public.create_order(
  p_token      text,
  p_items      jsonb,
  p_total      numeric,
  p_kind       text default 'order',
  p_request_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client     public.clients%rowtype;
  v_list_code  text;
  v_kind       text;
  v_result     jsonb;
  v_items      jsonb;
  v_order_id   uuid;
  v_no_price   text;
  v_hint       text := left(coalesce(p_token, ''), 8);
  v_lines      int  := case when jsonb_typeof(p_items) = 'array'
                            then jsonb_array_length(p_items) end;
begin
  select * into v_client from public.clients where token = p_token;
  if not found then
    -- Token inválido: al cliente no se le explica nada, pero queda el rastro.
    -- Sin items, ver el comentario de la tabla.
    insert into public.order_failures (token_hint, reason, line_count, kind)
    values (v_hint, 'token inválido', v_lines, p_kind);
    return null;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
    values (v_client.id, v_hint, 'payload vacío o mal formado', v_lines, p_kind, p_items);
    return null;
  end if;

  if jsonb_array_length(p_items) > 1000 then
    insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
    values (v_client.id, v_hint,
            format('demasiadas líneas: %s (el tope es 1000)', v_lines),
            v_lines, p_kind, p_items);
    return null;
  end if;

  -- Reintento del mismo carrito: devolver el pedido que ya se guardó, no otro.
  -- Va después de las validaciones para que un payload inválido no se "cure"
  -- solo por traer un request_id conocido.
  if p_request_id is not null then
    select id into v_order_id from public.orders where request_id = p_request_id;
    if found then
      return v_order_id;
    end if;
  end if;

  select code into v_list_code from public.price_lists where id = v_client.price_list_id;

  -- El cliente nunca decide esto: la lista 'quote' siempre guarda
  -- 'quote' sin precio, sin importar lo que mande el frontend. Desde
  -- 2026-07-17 el frontend también manda p_kind = 'quote' explícito al
  -- descargar el PDF desde el carrito (sin importar la lista del
  -- cliente), para que quede registrado como cotización en el panel.
  v_kind := case when v_list_code = 'quote' or p_kind = 'quote' then 'quote' else 'order' end;

  v_result := public.compute_order_items(v_client.id, p_items, v_kind);
  v_items  := v_result->'items';

  if jsonb_array_length(v_items) = 0 then
    -- Todos los ítems se cayeron en compute_order_items: productos
    -- desactivados o borrados entre que el cliente armó el carrito y lo envió.
    insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
    values (v_client.id, v_hint, 'ningún ítem válido (productos inactivos o inexistentes)',
            v_lines, v_kind, p_items);
    return null;
  end if;

  -- 2026-08-06: un pedido real con una línea sin precio no se guarda. En una
  -- cotización sí es normal (no llevan precio por definición).
  if v_kind = 'order' then
    select string_agg(e->>'sku', ', ' order by e->>'sku')
      into v_no_price
    from jsonb_array_elements(v_items) e
    where e->>'price' is null;

    if v_no_price is not null then
      insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
      values (v_client.id, v_hint,
              format('productos sin precio en la lista del cliente: %s', v_no_price),
              v_lines, v_kind, p_items);
      return null;
    end if;
  end if;

  -- Carrera entre dos envíos del mismo carrito (el cliente toca dos veces y
  -- los dos requests pasan las validaciones a la vez): el índice único deja
  -- entrar solo al primero y acá se devuelve ese mismo pedido.
  begin
    insert into public.orders (client_id, items, total, kind, request_id)
    values (v_client.id, v_items, (v_result->>'total')::numeric, v_kind, p_request_id)
    returning id into v_order_id;
  exception when unique_violation then
    select id into v_order_id from public.orders where request_id = p_request_id;
  end;

  return v_order_id;
end;
$$;

revoke execute on function public.create_order(text, jsonb, numeric, text, uuid) from public;
grant execute on function public.create_order(text, jsonb, numeric, text, uuid) to anon, authenticated;

-- ---------- 4b) convert_quote_to_order: misma regla, por la puerta del admin --
-- Acá no hace falta `order_failures`: es una acción del panel, así que el
-- mensaje del `raise exception` se muestra tal cual y dice qué SKU arreglar.
create or replace function public.convert_quote_to_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order     public.orders%rowtype;
  v_client    public.clients%rowtype;
  v_list_code text;
  v_result    jsonb;
  v_email     text;
  v_no_price  text;
  v_stock     jsonb   := null;
  v_applied   boolean;
begin
  if not (public.is_admin() or public.is_vendedora()) then
    raise exception 'no autorizado';
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

  if v_order.kind <> 'quote' then
    raise exception 'solo se pueden convertir cotizaciones';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'no se puede convertir una cotización cancelada';
  end if;

  select code into v_list_code from public.price_lists where id = v_client.price_list_id;
  if v_list_code = 'quote' then
    raise exception 'asigná una lista de precio real al cliente antes de convertir la cotización en pedido';
  end if;

  v_result := public.compute_order_items(v_client.id, v_order.items, 'order');

  -- 2026-08-06: sin esto, convertir una cotización que tiene un producto sin
  -- precio en la lista del cliente creaba un pedido con esa línea en null y un
  -- total que no la incluía — un pedido mal facturado, sin ningún aviso.
  select string_agg(e->>'sku', ', ' order by e->>'sku')
    into v_no_price
  from jsonb_array_elements(v_result->'items') e
  where e->>'price' is null;

  if v_no_price is not null then
    raise exception 'estos productos no tienen precio en la lista del cliente: %. Cargá el precio en la pestaña Precios (o quitalos de la cotización con Editar) y volvé a convertirla.', v_no_price;
  end if;

  -- Mismo guard que update_order_items, que sí lo tenía: si todos los ítems se
  -- cayeron (productos desactivados), convertir dejaría un pedido vacío.
  if jsonb_array_length(v_result->'items') = 0 then
    raise exception 'la cotización no tiene ningún producto válido';
  end if;

  -- La conversión recalcula precios, no productos ni cantidades, así que
  -- apply_order_stock puede leer los ítems ya guardados (el update de abajo
  -- deja los mismos id/qty) sin cambiar el resultado.
  v_applied := coalesce(v_order.stock_applied, false);
  if v_order.status = 'done' and not v_applied then
    v_stock   := public.apply_order_stock(p_order_id, -1);
    v_applied := true;
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('convert_quote_to_order', auth.uid(), v_email, v_client.id, v_client.name, p_order_id,
     jsonb_build_object(
       'items', v_result->'items',
       'total', v_result->'total'
     )
       || case when v_stock is null then '{}'::jsonb else jsonb_build_object('stock', v_stock) end);

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set kind          = 'order',
      items         = v_result->'items',
      total         = (v_result->>'total')::numeric,
      stock_applied = v_applied
  where id = p_order_id;

  return v_result || jsonb_build_object('stock_applied', v_applied, 'stock', v_stock);
end;
$$;

revoke execute on function public.convert_quote_to_order(uuid) from public;
grant execute on function public.convert_quote_to_order(uuid) to authenticated;

-- ---------- 5) apply_price_list: un 0 en el Excel es un precio inválido -------
-- Un solo cambio, en el CASE que parsea la celda: si el número es <= 0, `price`
-- queda en null. Todo lo que ya venía después filtra por `price is not null`, así
-- que hereda la regla sin tocar una línea más — la fila pasa a contarse en
-- `invalid_prices` (el contador que el preview ya muestra antes de confirmar) y
-- ni se upsertea ni activa el producto.
--
-- Efecto secundario buscado: si un producto que HOY tiene precio se sube con 0,
-- cae en `tmp_deactivate` igual que si no viniera en el archivo — se le borra el
-- precio de esa lista y se desactiva. Sale en el conteo "a desactivar" del
-- preview, así que no es silencioso.
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
      -- 2026-08-06: se suma `> 0`. Un 0 (o "0.00", o una columna corrida que
      -- dejó ceros) no es un precio: la fila pasa a contarse en
      -- `invalid_prices` en vez de publicar el producto en $0.00. Es el ÚNICO
      -- cambio de esta función; todo lo de abajo ya filtraba por
      -- `price is not null`, así que hereda la regla sin tocar una línea más.
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
    p.active as was_active
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

commit;

-- ============================================================
-- Después de correr esto
-- ============================================================
-- No hace falta desplegar nada más para que el catálogo deje de mostrar los
-- productos sin precio: get_catalog es server-side y el efecto es inmediato.
-- El frontend de esta misma tanda solo cambia la pestaña Precios, para que sus
-- contadores "con precios / sin precios" cuenten un 0 como "sin precio" y digan
-- lo mismo que el catálogo.
--
-- ---------- Qué productos deja de mostrar (correr ANTES para verlo) ----------
-- Filas con precio 0 que hasta ahora publicaban el producto en $0.00:
--
-- select pl.code as lista, p.sku, p.name, pp.price
-- from public.product_prices pp
-- join public.products p     on p.id = pp.product_id
-- join public.price_lists pl on pl.id = pp.price_list_id
-- where pp.price <= 0
-- order by pl.code, p.sku;
--
-- Ofertas flash en 0 (dejan de aparecer en la sección Flash Sale):
--
-- select p.sku, p.name, fs.price, fs.expires_at
-- from public.flash_sales fs
-- join public.products p on p.id = fs.product_id
-- where fs.price <= 0
-- order by p.sku;
--
-- Esta migración NO borra ni corrige ninguna de esas filas a propósito: el dato
-- queda para poder revisarlo. Si después de mirarlo se quieren limpiar, es un
-- delete a mano:
--
--   delete from public.product_prices where price <= 0;
--
-- ---------- Verificación ----------
-- Un producto con precio 0 no puede salir en ningún catálogo:
-- select count(*) from public.clients c,
--   lateral jsonb_array_elements(public.get_catalog(c.token)->'products') e
-- where (e->>'price')::numeric <= 0;    -- tiene que dar 0
--
-- (ojo: la lista 'quote' devuelve price = null, que no entra en esa cuenta —
-- es lo correcto, ahí el catálogo sin precios es la función.)
