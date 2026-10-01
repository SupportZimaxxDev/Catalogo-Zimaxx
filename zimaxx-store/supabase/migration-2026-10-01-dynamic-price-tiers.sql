-- ============================================================
-- 2026-10-01: LISTAS DE PRECIO DINÁMICAS (niveles por total del carrito)
--
-- Contexto (a pedido del usuario): "un cliente tiene la lista de minimum
-- order, empieza a llenar su carrito, al superar la marca se le avisa que
-- ahora se le van a ajustar los precios a la lista de wholesale, y así
-- también cuando pase los 15k. En la barra de arriba le va a salir cuántos
-- dólares se ahorró gracias a superar ciertos precios y ajustarse a la
-- siguiente lista donde los productos le salen más baratos".
--
-- Hasta hoy la lista del cliente era fija: un cliente de US Minimum Order
-- pagaba precio de "minimum" aunque llenara un carrito de $5,000, y la única
-- forma de que pagara wholesale era que una persona le cambiara la lista en
-- el panel. Desde hoy la lista ASIGNADA sigue siendo la del cliente (es la
-- que ve al abrir el catálogo, la que decide su pedido mínimo y la que se
-- edita en el panel), pero el PRECIO que paga se decide por el total del
-- carrito: al superar la marca de la lista siguiente, el pedido entero se
-- cobra con esa lista.
--
-- Qué cambia:
--
--   1. `price_lists.upgrade_to_id` + `price_lists.upgrade_at` — la cadena de
--      niveles vive en la base, lista por lista: "a partir de `upgrade_at`
--      dólares (medidos con los precios de ESTA lista) los precios pasan a
--      ser los de `upgrade_to_id`". Las dos van juntas (check) o las dos en
--      null (= último nivel). Semilla SOLO la primera vez que corre (guard
--      por "la columna no existía", igual que min_order):
--
--        us_min       → us_wholesale  a partir de  2,000
--        us_wholesale → special       a partir de 15,000
--        ve_min       → ve_wholesale  a partir de  2,000
--        ve_wholesale → special       a partir de 15,000   (Special no
--                                                          distingue región)
--        special, luzmar, quote → sin nivel siguiente
--
--      Los umbrales salen de los nombres de las listas de siempre ("US
--      Minimum Order ($800+)", "US Wholesale ($2,000+)", "Special Order
--      ($15,000+)"). El pedido decía "al superar los 800" para el paso a
--      wholesale, pero $800 es el pedido MÍNIMO de la lista Minimum Order:
--      con la marca ahí, ningún pedido válido de esa lista se cobraría con
--      sus propios precios. Se tomó $2,000 (el `min_order` de wholesale);
--      cambiarlo es un update de una línea (ver verificación al final).
--
--   2. `price_list_tiers(p_list_id)` — helper interno: la cadena ordenada
--      desde la lista del cliente (idx 1, sin umbral) hasta el último nivel,
--      con corte por ciclo y tope de 6 niveles.
--
--   3. `compute_order_items` resuelve el nivel: trae el precio de cada ítem
--      en TODOS los niveles de la cadena (una consulta por ítem, como antes),
--      acumula un total por nivel y sube de a uno — "el total a precios del
--      nivel actual llega a la marca del siguiente" — hasta donde ya no
--      alcanza. Un producto sin precio en un nivel superior hereda el del
--      nivel anterior (nunca se cae del pedido por subir de nivel). El
--      resultado suma `base_total` (a precios de la lista del cliente) y
--      `pricing` (nivel efectivo, ahorro, siguiente marca y cuánto falta);
--      los ítems llevan `price` = precio cobrado y, si subió de nivel,
--      `base_price` = el de su lista. Sin cadena (lista sin siguiente, lista
--      `quote`, cliente sin lista) el comportamiento es el de siempre y
--      `pricing` es null.
--
--   4. `get_catalog` manda `client.tiers` (la cadena: code, label, umbral,
--      min_order) y, por producto, `tier_prices` (precio en cada nivel,
--      alineado con `tiers`, null donde no hay). Solo cuando hay más de un
--      nivel: para una lista sin siguiente, las dos claves van en null y el
--      frontend no cambia nada. Con eso el carrito calcula al instante el
--      nivel, el ahorro y la marca siguiente sin ir al servidor en cada
--      toque; el servidor vuelve a calcular TODO al registrar (manda él).
--
--   5. `orders.pricing jsonb` — con qué nivel se cobró el pedido (null =
--      con la lista del cliente, como todos los pedidos anteriores). La
--      escriben `create_order`, `create_manual_order` y
--      `convert_quote_to_order` (los tres caminos que ponen precio); está
--      blindada por `orders_guard_items_edit` como `items`/`total`.
--      `preview_manual_order` la devuelve para que la pantalla de carga
--      manual lo muestre antes de guardar.
--
-- Qué NO cambia: el pedido mínimo sigue siendo el de la lista ASIGNADA
-- (`client.min_order` / `create_order`), medido sobre el total cobrado. El
-- rechazo por producto sin precio sigue igual (sobre el precio cobrado).
-- Las cotizaciones (`kind = 'quote'`) siguen sin precio y sin nivel. Los
-- Excel de precios, el sync de n8n y el panel no se enteran: la lista del
-- cliente no se toca nunca por esto.
--
-- Cuerpos: `get_catalog` y `create_order` son copia exacta de
-- migration-2026-09-15-price-list-min-order.sql; `compute_order_items` de
-- migration-2026-08-14-catalog-upc.sql; `preview_manual_order` y
-- `create_manual_order` de migration-2026-08-17-manual-order.sql;
-- `convert_quote_to_order` de migration-2026-08-06-require-price.sql;
-- `orders_guard_items_edit` de migration-2026-08-05-order-capture.sql — más
-- las líneas marcadas "2026-10-01". Idempotente y re-corrible.
-- ============================================================

set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'price_lists' and column_name = 'min_order'
  ) then
    raise exception 'Falta correr migration-2026-09-15-price-list-min-order.sql (price_lists.min_order) antes de esta';
  end if;
  if position('pedido mínimo' in pg_get_functiondef('public.create_order(text, jsonb, numeric, text, uuid)'::regprocedure)) = 0 then
    raise exception 'El create_order vivo no es el de migration-2026-09-15-price-list-min-order.sql: revisar antes de reemplazarlo';
  end if;
  if position('min_order' in pg_get_functiondef('public.get_catalog(text)'::regprocedure)) = 0 then
    raise exception 'El get_catalog vivo no es el de migration-2026-09-15-price-list-min-order.sql: revisar antes de reemplazarlo';
  end if;
  if position('deactivated_by_stock' in pg_get_functiondef('public.compute_order_items(uuid, jsonb, text)'::regprocedure)) = 0
     or position('''upc''' in pg_get_functiondef('public.compute_order_items(uuid, jsonb, text)'::regprocedure)) = 0 then
    raise exception 'El compute_order_items vivo no es el de migration-2026-08-14-catalog-upc.sql: revisar antes de reemplazarlo';
  end if;
  if to_regprocedure('public.preview_manual_order(uuid, jsonb)') is null
     or to_regprocedure('public.create_manual_order(uuid, jsonb, uuid, text)') is null
     or to_regprocedure('public.manual_order_client(uuid)') is null then
    raise exception 'Falta correr migration-2026-08-17-manual-order.sql antes de esta';
  end if;
  if position('no tienen precio en la lista del cliente' in pg_get_functiondef('public.convert_quote_to_order(uuid)'::regprocedure)) = 0 then
    raise exception 'El convert_quote_to_order vivo no es el de migration-2026-08-06-require-price.sql: revisar antes de reemplazarlo';
  end if;
  if position('request_id' in pg_get_functiondef('public.orders_guard_items_edit()'::regprocedure)) = 0 then
    raise exception 'El orders_guard_items_edit vivo no es el de migration-2026-08-05-order-capture.sql: revisar antes de reemplazarlo';
  end if;
end $$;

begin;

-- ---------- 1) price_lists.upgrade_to_id / upgrade_at ----------
-- Columnas + semilla en el mismo bloque, guardado por "la columna no
-- existía": re-correr el archivo no vuelve a sembrar (una cadena ajustada a
-- mano queda).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'price_lists' and column_name = 'upgrade_to_id'
  ) then
    alter table public.price_lists
      add column upgrade_to_id uuid references public.price_lists (id) on delete set null,
      add column upgrade_at    numeric(12, 2);

    update public.price_lists src
    set upgrade_to_id = nx.id,
        upgrade_at    = seed.at
    from (values
      ('us_min',       'us_wholesale',  2000),
      ('us_wholesale', 'special',      15000),
      ('ve_min',       've_wholesale',  2000),
      ('ve_wholesale', 'special',      15000)
    ) as seed(code, next_code, at)
    join public.price_lists nx on nx.code = seed.next_code
    where src.code = seed.code;
  end if;
end $$;

alter table public.price_lists drop constraint if exists price_lists_upgrade_check;
alter table public.price_lists add constraint price_lists_upgrade_check
  check (
    (upgrade_to_id is null) = (upgrade_at is null)
    and (upgrade_at is null or upgrade_at > 0)
    and (upgrade_to_id is null or upgrade_to_id <> id)
  );

comment on column public.price_lists.upgrade_to_id is
  'Lista cuyos precios se cobran cuando el total del carrito (a precios de ESTA lista) llega a upgrade_at (2026-10-01). NULL = último nivel. La lista asignada al cliente no cambia; cambia el precio que paga ese pedido.';
comment on column public.price_lists.upgrade_at is
  'Total en USD, medido con los precios de esta lista, a partir del cual el pedido se cobra con upgrade_to_id (2026-10-01). Va junto con upgrade_to_id (las dos o ninguna).';

-- ---------- 2) orders.pricing + guard ----------
alter table public.orders add column if not exists pricing jsonb;

comment on column public.orders.pricing is
  'Con qué nivel de precios se cobró el pedido (2026-10-01): {base_code, base_label, list_code, list_label, tier_index, base_total, total, savings, ...} tal como lo devolvió compute_order_items. NULL = con la lista asignada del cliente (todos los pedidos anteriores a esa fecha, y los que no subieron de nivel). Blindada por orders_guard_items_edit.';

-- Copia de migration-2026-08-05-order-capture.sql + `pricing` (2026-10-01):
-- si se pudiera reescribir a mano, un pedido podría decir que se cobró con
-- un nivel que no fue.
create or replace function public.orders_guard_items_edit()
returns trigger
language plpgsql
as $$
begin
  if (new.items is distinct from old.items
      or new.total is distinct from old.total
      or new.status is distinct from old.status
      or new.kind is distinct from old.kind
      or new.stock_applied is distinct from old.stock_applied
      or new.request_id is distinct from old.request_id
      or new.pricing is distinct from old.pricing)
     and coalesce(current_setting('app.allow_order_edit', true), '') <> 'on' then
    raise exception 'los pedidos solo se editan via update_order_items/update_order_status/convert_quote_to_order';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_guard_items_edit on public.orders;
create trigger orders_guard_items_edit
  before update on public.orders
  for each row execute function public.orders_guard_items_edit();

-- ---------- 3) price_list_tiers: la cadena de niveles de una lista ----------
-- idx 1 = la lista del cliente (threshold null); idx 2.. = los niveles a los
-- que puede subir, cada uno con la marca (en dólares, a precios del nivel
-- anterior) que lo habilita. Corta si la cadena se muerde la cola o pasa de
-- 6 niveles (un dato mal cargado no puede colgar un pedido). Helper interno:
-- lo llaman compute_order_items y get_catalog; sin grant a la API.
create or replace function public.price_list_tiers(p_list_id uuid)
returns table (idx int, id uuid, code text, label text, threshold numeric, min_order numeric)
language sql
stable
set search_path = public
as $$
  with recursive chain as (
    select 1 as idx, pl.id, pl.code, pl.label, null::numeric as threshold, pl.min_order,
           array[pl.id] as seen
    from public.price_lists pl
    where pl.id = p_list_id
    union all
    select c.idx + 1, nx.id, nx.code, nx.label, cur.upgrade_at, nx.min_order,
           c.seen || nx.id
    from chain c
    join public.price_lists cur on cur.id = c.id
    join public.price_lists nx  on nx.id = cur.upgrade_to_id
    where cur.upgrade_at is not null
      and not (nx.id = any(c.seen))
      and c.idx < 6
  )
  select idx, id, code, label, threshold, min_order from chain order by idx
$$;

revoke execute on function public.price_list_tiers(uuid) from public;

-- ---------- 4) compute_order_items: el nivel lo decide el total ----------
-- Copia de migration-2026-08-14-catalog-upc.sql más los bloques 2026-10-01.
-- Mismo contrato de siempre ({items, total}) más `base_total` y `pricing`;
-- los ítems conservan sus claves (`price` = lo que se cobra) y suman
-- `base_price` solo cuando el pedido subió de nivel.
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
  v_client      public.clients%rowtype;
  v_item        jsonb;
  v_id          uuid;
  v_qty         int;
  v_flash       boolean;
  v_product     public.products%rowtype;
  v_flash_price numeric;
  v_prices      numeric[];   -- 2026-10-01: precio del ítem en cada nivel
  v_k           int;
  -- 2026-10-01: la cadena de niveles de la lista del cliente (idx 1 = la suya)
  v_tier_ids    uuid[];
  v_tier_codes  text[];
  v_tier_labels text[];
  v_tier_thr    numeric[];
  v_n           int;
  v_tot         numeric[];   -- total del pedido a precios de cada nivel
  v_idx         int := 1;    -- nivel efectivo
  v_raw         jsonb   := '[]'::jsonb;
  v_items       jsonb;
  v_has_price   boolean := false;
  v_total       numeric;
  v_base        numeric;
  v_pricing     jsonb   := null;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    return jsonb_build_object('items', '[]'::jsonb, 'total', null);
  end if;

  -- 2026-10-01: niveles. Sin lista (o lista borrada) queda un solo nivel
  -- "sin precios", que es exactamente lo que pasaba antes.
  select array_agg(t.id order by t.idx), array_agg(t.code order by t.idx),
         array_agg(t.label order by t.idx), array_agg(t.threshold order by t.idx)
    into v_tier_ids, v_tier_codes, v_tier_labels, v_tier_thr
  from public.price_list_tiers(v_client.price_list_id) t;
  v_n := coalesce(array_length(v_tier_ids, 1), 0);
  if v_n = 0 then
    v_tier_ids    := array[v_client.price_list_id];
    v_tier_codes  := array[null::text];
    v_tier_labels := array[null::text];
    v_tier_thr    := array[null::numeric];
    v_n           := 1;
  end if;
  v_tot := array_fill(0::numeric, array[v_n]);

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

    v_prices := array_fill(null::numeric, array[v_n]);
    if p_kind = 'order' then
      v_flash_price := null;
      if v_flash then
        select fs.price into v_flash_price
        from public.flash_sales fs
        where fs.product_id = v_id
          and fs.active
          and fs.price > 0
          and now() >= fs.starts_at
          and now() < fs.expires_at
        order by fs.price
        limit 1;
      end if;
      if v_flash_price is not null then
        -- Una oferta vigente vale en cualquier nivel (legado, ver tabla flash_sales).
        v_prices := array_fill(v_flash_price, array[v_n]);
      else
        -- 2026-10-01: el precio en cada nivel de la cadena, en una sola
        -- consulta por ítem (antes era una por ítem también, solo de su lista).
        -- `pp.price > 0` (2026-08-06): un 0 es "sin precio".
        v_prices := array(
          select pp.price
          from unnest(v_tier_ids) with ordinality t(id, i)
          left join public.product_prices pp
            on pp.product_id = v_id
           and pp.price_list_id = t.id
           and pp.price > 0
          order by t.i
        );
        -- Sin precio en un nivel superior → hereda el del nivel anterior: subir
        -- de nivel nunca deja una línea sin precio que antes sí lo tenía.
        for v_k in 2..v_n loop
          if v_prices[v_k] is null then v_prices[v_k] := v_prices[v_k - 1]; end if;
        end loop;
      end if;
    end if;

    v_raw := v_raw || jsonb_build_object(
      'id',          v_product.id,
      'sku',         v_product.sku,
      'upc',         v_product.upc,
      'name',        v_product.name,
      'qty',         v_qty,
      'flash',       v_flash,
      'tier_prices', to_jsonb(v_prices)
    );
    for v_k in 1..v_n loop
      if v_prices[v_k] is not null then
        v_tot[v_k] := v_tot[v_k] + v_prices[v_k] * v_qty;
      end if;
    end loop;
  end loop;

  -- 2026-10-01: subir de a un nivel mientras el total A PRECIOS DEL NIVEL
  -- ACTUAL llegue a la marca del siguiente (borde inclusivo). Con kind =
  -- 'quote' nada tiene precio, los totales son 0 y se queda en el nivel 1.
  while v_idx < v_n
        and v_tier_thr[v_idx + 1] is not null
        and v_tot[v_idx] >= v_tier_thr[v_idx + 1] loop
    v_idx := v_idx + 1;
  end loop;

  -- Los ítems definitivos: `price` = el del nivel efectivo (índice 0-based en
  -- el array JSON), `base_price` solo si subió de nivel.
  select coalesce(jsonb_agg(
           (o.e - 'tier_prices')
           || jsonb_build_object('price', (o.e->'tier_prices'->>(v_idx - 1))::numeric)
           || case when v_idx > 1
                then jsonb_build_object('base_price', (o.e->'tier_prices'->>0)::numeric)
                else '{}'::jsonb end
           order by o.ord), '[]'::jsonb)
    into v_items
  from jsonb_array_elements(v_raw) with ordinality o(e, ord);

  -- Todo precio es > 0 y toda qty >= 1: hay precio en el nivel efectivo si y
  -- solo si su total es > 0.
  v_has_price := p_kind = 'order' and v_tot[v_idx] > 0;
  v_total := case when v_has_price then round(v_tot[v_idx], 2) end;
  v_base  := case when v_has_price then round(v_tot[1], 2) end;

  if p_kind = 'order' and v_n > 1 then
    v_pricing := jsonb_build_object(
      'base_code',      v_tier_codes[1],
      'base_label',     v_tier_labels[1],
      'list_code',      v_tier_codes[v_idx],
      'list_label',     v_tier_labels[v_idx],
      'tier_index',     v_idx - 1,
      'base_total',     v_base,
      'total',          v_total,
      'savings',        case when v_has_price then round(v_tot[1] - v_tot[v_idx], 2) else 0 end,
      -- fuera de rango → null (último nivel): lo mismo que "no hay siguiente"
      'next_code',      v_tier_codes[v_idx + 1],
      'next_label',     v_tier_labels[v_idx + 1],
      'next_threshold', v_tier_thr[v_idx + 1],
      'next_missing',   case when v_idx < v_n then round(v_tier_thr[v_idx + 1] - v_tot[v_idx], 2) end
    );
  end if;

  return jsonb_build_object(
    'items',      v_items,
    'total',      v_total,
    'base_total', v_base,
    'pricing',    v_pricing
  );
end;
$$;

revoke execute on function public.compute_order_items(uuid, jsonb, text) from public;

-- ---------- 5) get_catalog: + client.tiers y tier_prices por producto ----------
-- Copia exacta de migration-2026-09-15-price-list-min-order.sql más los
-- bloques 2026-10-01. Las dos claves nuevas van en null cuando la lista no
-- tiene nivel siguiente (y en la rama `quote`), así el frontend de un
-- cliente Special/VIP/quote no cambia nada.
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
  v_min_order       numeric;   -- 2026-09-15
  v_vendedora_name  text;
  v_vendedora_phone text;
  v_products        jsonb;
  -- Ventana y tamaño del "Más vendidos" del catálogo (global y por línea).
  -- Si algún día se quiere otro corte, se cambia ACÁ (es el único lugar).
  v_top             uuid[] := array(select public.top_seller_ids(60, 12));
  v_top_line        uuid[] := array(select public.top_seller_ids_by_line(60, 12));
  v_favs            uuid[];
  -- 2026-10-01: la cadena de niveles de la lista del cliente
  v_tier_ids        uuid[];
  v_tiers           jsonb;
  v_n               int;
begin
  if p_token is null or length(p_token) = 0 then
    return null;
  end if;

  select * into v_client from public.clients where token = p_token;
  if not found then
    return null;
  end if;

  -- 2026-09-15: el mínimo viaja junto con el código de la lista.
  select code, min_order into v_code, v_min_order
  from public.price_lists where id = v_client.price_list_id;
  select name, phone into v_vendedora_name, v_vendedora_phone
  from public.vendedores where id = v_client.vendedora_id;

  -- 2026-10-01: niveles (solo si hay más de uno).
  select array_agg(t.id order by t.idx),
         jsonb_agg(jsonb_build_object(
           'code', t.code, 'label', t.label, 'threshold', t.threshold, 'min_order', t.min_order
         ) order by t.idx)
    into v_tier_ids, v_tiers
  from public.price_list_tiers(v_client.price_list_id) t;
  v_n := coalesce(array_length(v_tier_ids, 1), 0);
  if v_n < 2 then
    v_tiers := null;
  end if;

  -- Los favoritos DEL cliente resuelto por el token (después del not found:
  -- un token inválido nunca llega acá).
  v_favs := array(
    select product_id from public.client_favorites where client_id = v_client.id
  );

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
          'is_top',       (p.id = any(v_top)),
          'is_top_line',  (p.id = any(v_top_line)),
          'is_fav',       (p.id = any(v_favs)),
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
          'is_top',       (p.id = any(v_top)),
          'is_top_line',  (p.id = any(v_top_line)),
          'is_fav',       (p.id = any(v_favs)),
          'price',        pp.price,
          -- 2026-10-01: el precio en cada nivel de la cadena, alineado con
          -- client.tiers (null donde ese nivel no tiene precio; el carrito
          -- hereda el del nivel anterior, igual que compute_order_items).
          'tier_prices',  case when v_n > 1 then (
            select jsonb_agg(coalesce(to_jsonb(x.price), 'null'::jsonb) order by t.i)
            from unnest(v_tier_ids) with ordinality t(id, i)
            left join public.product_prices x
              on x.product_id = p.id
             and x.price_list_id = t.id
             and x.price > 0
          ) end
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
      'is_quote_only',   v_code = 'quote',
      -- 2026-09-15: pedido mínimo de la lista (null = sin mínimo). El
      -- frontend, si no encuentra la clave, asume el 800 de siempre.
      'min_order',       v_min_order,
      -- 2026-10-01: la cadena de niveles ([{code, label, threshold, min_order}],
      -- el primero es la lista del cliente con threshold null). null = sin
      -- niveles: el carrito se comporta como siempre.
      'tiers',           v_tiers
    ),
    'products', v_products
  );
end;
$$;

revoke execute on function public.get_catalog(text) from public;
grant execute on function public.get_catalog(text) to anon, authenticated;

-- ---------- 6) create_order: guarda con qué nivel se cobró ----------
-- Copia exacta de migration-2026-09-15-price-list-min-order.sql más la
-- columna `pricing` en el insert (2026-10-01). El mínimo sigue siendo el de
-- la lista ASIGNADA, sobre el total cobrado: un cliente de Minimum Order
-- ($800) con $2,000 a sus precios paga wholesale (digamos $1,850) y entra,
-- porque $1,850 >= $800.
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
  v_list_label text;      -- 2026-09-15
  v_min_order  numeric;   -- 2026-09-15
  v_total      numeric;   -- 2026-09-15
  v_kind       text;
  v_result     jsonb;
  v_items      jsonb;
  v_pricing    jsonb;     -- 2026-10-01
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

  -- 2026-09-15: además del código, el nombre (para el motivo del rechazo) y
  -- el pedido mínimo de la lista.
  select code, label, min_order into v_list_code, v_list_label, v_min_order
  from public.price_lists where id = v_client.price_list_id;

  -- El cliente nunca decide esto: la lista 'quote' siempre guarda
  -- 'quote' sin precio, sin importar lo que mande el frontend. Desde
  -- 2026-07-17 el frontend también manda p_kind = 'quote' explícito al
  -- descargar el PDF desde el carrito (sin importar la lista del
  -- cliente), para que quede registrado como cotización en el panel.
  v_kind := case when v_list_code = 'quote' or p_kind = 'quote' then 'quote' else 'order' end;

  v_result := public.compute_order_items(v_client.id, p_items, v_kind);
  v_items  := v_result->'items';
  -- 2026-10-01: solo se guarda si el pedido subió de nivel; null = "con la
  -- lista del cliente", como todos los pedidos anteriores.
  v_pricing := case when coalesce((v_result->'pricing'->>'tier_index')::int, 0) > 0
                    then v_result->'pricing' end;

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

    -- 2026-09-15: pedido mínimo de la lista, sobre el total RECALCULADO (el
    -- p_total del navegador se sigue ignorando). Solo pedidos reales: una
    -- cotización no tiene mínimo. NULL en la lista = sin mínimo. El borde es
    -- inclusivo: un total igual al mínimo entra.
    v_total := (v_result->>'total')::numeric;
    if v_min_order is not null and coalesce(v_total, 0) < v_min_order then
      insert into public.order_failures (client_id, token_hint, reason, line_count, kind, items)
      values (v_client.id, v_hint,
              format('total $%s por debajo del pedido mínimo de $%s de la lista %s',
                     to_char(coalesce(v_total, 0), 'FM999,999,990.00'),
                     to_char(v_min_order, 'FM999,999,990.00'),
                     coalesce(v_list_label, v_list_code, '?')),
              v_lines, v_kind, p_items);
      return null;
    end if;
  end if;

  -- Carrera entre dos envíos del mismo carrito (el cliente toca dos veces y
  -- los dos requests pasan las validaciones a la vez): el índice único deja
  -- entrar solo al primero y acá se devuelve ese mismo pedido.
  begin
    insert into public.orders (client_id, items, total, kind, request_id, pricing)
    values (v_client.id, v_items, (v_result->>'total')::numeric, v_kind, p_request_id, v_pricing)
    returning id into v_order_id;
  exception when unique_violation then
    select id into v_order_id from public.orders where request_id = p_request_id;
  end;

  return v_order_id;
end;
$$;

revoke execute on function public.create_order(text, jsonb, numeric, text, uuid) from public;
grant execute on function public.create_order(text, jsonb, numeric, text, uuid) to anon, authenticated;

-- ---------- 7) preview_manual_order / create_manual_order ----------
-- Copias exactas de migration-2026-08-17-manual-order.sql más `pricing`
-- (2026-10-01): el pedido cargado a mano para un cliente de Minimum Order
-- que supera la marca se cobra con wholesale igual que desde el catálogo —
-- es la misma regla de negocio, y la pantalla lo muestra antes de guardar.
create or replace function public.preview_manual_order(
  p_client_id uuid,
  p_items     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   public.clients%rowtype;
  v_code     text;
  v_kind     text;
  v_result   jsonb;
  v_items    jsonb;
  v_dropped  jsonb;
  v_no_price jsonb;
begin
  v_client := public.manual_order_client(p_client_id);

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'no hay ítems para armar el pedido';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'demasiadas líneas: % (el tope es 1000)', jsonb_array_length(p_items);
  end if;

  select code into v_code from public.price_lists where id = v_client.price_list_id;
  -- Igual que create_order: la lista 'quote' manda. Acá no hay un p_kind que
  -- pueda pedir otra cosa — el tipo lo decide el cliente, no quien carga.
  v_kind := case when v_code = 'quote' then 'quote' else 'order' end;

  v_result := public.compute_order_items(v_client.id, p_items, v_kind);
  v_items  := v_result->'items';

  select coalesce(jsonb_agg(e->>'id'), '[]'::jsonb)
    into v_dropped
  from jsonb_array_elements(p_items) e
  where (e->>'id') is not null
    and not exists (
      select 1 from jsonb_array_elements(v_items) k where k->>'id' = e->>'id'
    );

  select coalesce(jsonb_agg(e->>'sku' order by e->>'sku'), '[]'::jsonb)
    into v_no_price
  from jsonb_array_elements(v_items) e
  where v_kind = 'order' and e->>'price' is null;

  return jsonb_build_object(
    'kind',        v_kind,
    'client_name', v_client.name,
    'items',       v_items,
    'total',       v_result->'total',
    'dropped',     v_dropped,
    'no_price',    v_no_price,
    'pricing',     v_result->'pricing'   -- 2026-10-01
  );
end;
$$;

revoke execute on function public.preview_manual_order(uuid, jsonb) from public;
grant execute on function public.preview_manual_order(uuid, jsonb) to authenticated;

create or replace function public.create_manual_order(
  p_client_id  uuid,
  p_items      jsonb,
  p_request_id uuid default null,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   public.clients%rowtype;
  v_code     text;
  v_kind     text;
  v_result   jsonb;
  v_items    jsonb;
  v_pricing  jsonb;   -- 2026-10-01
  v_order_id uuid;
  v_no_price text;
  v_email    text;
begin
  v_client := public.manual_order_client(p_client_id);

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'no hay ítems para crear el pedido';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'demasiadas líneas: % (el tope es 1000)', jsonb_array_length(p_items);
  end if;

  -- Doble click, o la pantalla que reintenta después de perder la respuesta:
  -- devuelve el pedido que ya se creó en vez de otro igual. Mismo mecanismo
  -- que create_order (índice único sobre orders.request_id).
  if p_request_id is not null then
    select id into v_order_id from public.orders where request_id = p_request_id;
    if found then
      return jsonb_build_object('order_id', v_order_id, 'already_existed', true);
    end if;
  end if;

  select code into v_code from public.price_lists where id = v_client.price_list_id;
  v_kind := case when v_code = 'quote' then 'quote' else 'order' end;

  v_result := public.compute_order_items(v_client.id, p_items, v_kind);
  v_items  := v_result->'items';
  v_pricing := case when coalesce((v_result->'pricing'->>'tier_index')::int, 0) > 0
                    then v_result->'pricing' end;

  if jsonb_array_length(v_items) = 0 then
    raise exception 'ningún ítem válido: los productos están inactivos o ya no existen';
  end if;

  -- Misma regla que create_order (migration-2026-08-06-require-price.sql): un
  -- pedido real con una línea sin precio no se guarda. Acá el mensaje del
  -- error sí importa — del otro lado hay una persona que puede cargar el
  -- precio y volver a intentar, no un cliente al que no se le explica nada.
  if v_kind = 'order' then
    select string_agg(e->>'sku', ', ' order by e->>'sku')
      into v_no_price
    from jsonb_array_elements(v_items) e
    where e->>'price' is null;

    if v_no_price is not null then
      raise exception 'sin precio en la lista del cliente: %', v_no_price;
    end if;
  end if;

  begin
    insert into public.orders (client_id, items, total, kind, request_id, pricing)
    values (v_client.id, v_items, (v_result->>'total')::numeric, v_kind, p_request_id, v_pricing)
    returning id into v_order_id;
  exception when unique_violation then
    -- Carrera entre dos envíos con el mismo request_id: gana el primero.
    select id into v_order_id from public.orders where request_id = p_request_id;
    return jsonb_build_object('order_id', v_order_id, 'already_existed', true);
  end;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.admin_audit_log
    (action, performed_by, performed_by_email, client_id, client_name, order_id, detail)
  values
    ('create_manual_order', auth.uid(), v_email, v_client.id, v_client.name, v_order_id,
     jsonb_build_object(
       'kind',       v_kind,
       'items',      v_items,
       'total',      v_result->'total',
       'pricing',    v_pricing,   -- 2026-10-01
       'line_count', jsonb_array_length(v_items),
       -- El mensaje pegado, tal cual llegó: es la prueba de dónde salió este
       -- pedido si mañana alguien pregunta por qué está cargado a mano.
       'source_message', p_note
     ));

  return jsonb_build_object(
    'order_id',        v_order_id,
    'kind',            v_kind,
    'total',           v_result->'total',
    'items',           v_items,
    'pricing',         v_pricing,   -- 2026-10-01
    'already_existed', false
  );
end;
$$;

revoke execute on function public.create_manual_order(uuid, jsonb, uuid, text) from public;
grant execute on function public.create_manual_order(uuid, jsonb, uuid, text) to authenticated;

-- ---------- 8) convert_quote_to_order: también guarda el nivel ----------
-- Copia exacta de migration-2026-08-06-require-price.sql más `pricing` en el
-- update (2026-10-01).
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
  v_pricing   jsonb;   -- 2026-10-01
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
  v_pricing := case when coalesce((v_result->'pricing'->>'tier_index')::int, 0) > 0
                    then v_result->'pricing' end;

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
       'items',   v_result->'items',
       'total',   v_result->'total',
       'pricing', v_pricing   -- 2026-10-01
     )
       || case when v_stock is null then '{}'::jsonb else jsonb_build_object('stock', v_stock) end);

  perform set_config('app.allow_order_edit', 'on', true);
  update public.orders
  set kind          = 'order',
      items         = v_result->'items',
      total         = (v_result->>'total')::numeric,
      stock_applied = v_applied,
      pricing       = v_pricing
  where id = p_order_id;

  return v_result || jsonb_build_object('stock_applied', v_applied, 'stock', v_stock);
end;
$$;

revoke execute on function public.convert_quote_to_order(uuid) from public;
grant execute on function public.convert_quote_to_order(uuid) to authenticated;

commit;

-- ============================================================
-- Verificación (solo lectura, SQL Editor o `supabase db query --linked`)
-- ============================================================
-- 1) La cadena sembrada:
-- select src.code, src.upgrade_at, nx.code as upgrade_to
-- from public.price_lists src left join public.price_lists nx on nx.id = src.upgrade_to_id
-- order by src.code;
-- -- esperado: us_min → us_wholesale 2000; us_wholesale → special 15000;
-- -- ve_min → ve_wholesale 2000; ve_wholesale → special 15000; el resto null.
--
-- 2) El catálogo la trae (token de un cliente de us_min):
-- select public.get_catalog('<token>')->'client'->'tiers';
-- select public.get_catalog('<token>')->'products'->0->'tier_prices';
--
-- 3) Las funciones vivas son estas:
-- select position('tier_prices' in pg_get_functiondef('public.compute_order_items(uuid, jsonb, text)'::regprocedure)) > 0,
--        position('tiers' in pg_get_functiondef('public.get_catalog(text)'::regprocedure)) > 0,
--        position('pricing' in pg_get_functiondef('public.create_order(text, jsonb, numeric, text, uuid)'::regprocedure)) > 0;
--
-- Ajustar una marca (por ejemplo, wholesale a partir de $1,500 para us_min):
-- update public.price_lists set upgrade_at = 1500 where code = 'us_min';
-- Quitar un nivel (special ya no se alcanza desde ve_wholesale):
-- update public.price_lists set upgrade_to_id = null, upgrade_at = null where code = 've_wholesale';
--
-- Rollback (solo datos; las funciones vuelven re-corriendo las migraciones
-- de origen listadas en el encabezado):
-- update public.price_lists set upgrade_to_id = null, upgrade_at = null;
