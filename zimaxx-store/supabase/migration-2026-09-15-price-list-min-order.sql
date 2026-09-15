-- ============================================================
-- 2026-09-15: pedido mínimo POR LISTA DE PRECIO (`price_lists.min_order`)
--
-- Contexto (a pedido del usuario): "sería bueno limitar la creación de
-- órdenes menores a 2000 al catálogo de 800$". Hasta hoy el mínimo era un
-- $800 plano para TODAS las listas y vivía solo en el navegador
-- (`VITE_MIN_ORDER` en CartDrawer.jsx): un cliente de US Wholesale ($2,000+)
-- podía mandar un pedido de $900 con precio mayorista, y nada del lado del
-- servidor lo impedía. Medido en producción el 2026-09-15 (pedidos reales no
-- cancelados desde el primero, 2026-07-27): 244 de 489 pedidos de
-- `us_wholesale` y 35 de 69 de `ve_wholesale` estaban por debajo de $2,000.
--
-- Qué cambia:
--
--   1. `price_lists.min_order numeric(12,2)` — pedido mínimo en USD de cada
--      lista. NULL = sin mínimo (la lista `quote`, que no tiene precios).
--      DEFAULT 800 para las listas que se creen a futuro desde el panel
--      superadmin (`sa_create_price_list` no lo pide): ninguna lista nueva
--      queda sin mínimo por olvido.
--
--      Semilla — SOLO la primera vez que corre (si la columna ya existe no se
--      toca ningún valor, así un ajuste a mano sobrevive a re-correr esto):
--
--        us_min, ve_min                              →  800  (el "catálogo de $800")
--        us_wholesale, ve_wholesale, special, luzmar → 2000
--        quote                                       → null
--        cualquier otra                              →  800
--
--      `special` y `luzmar` van a 2000 por la regla literal del pedido: un
--      pedido menor a $2,000 solo existe en el catálogo de $800, y esas dos
--      no lo son (Special es $15,000+; Luzmar es la "Lista VIP" con dueña).
--      Si el negocio quiere otra cosa para alguna, es un UPDATE de una línea:
--        update public.price_lists set min_order = 800 where code = 'luzmar';
--
--   2. `get_catalog` devuelve `client.min_order`: el carrito muestra el
--      mínimo de SU lista ("El pedido mínimo de tu lista es $2000.00 · Te
--      faltan $X") y bloquea el botón de WhatsApp por debajo. Antes 800 fijo.
--      Un frontend viejo ignora la clave; el frontend nuevo contra una base
--      sin esta migración cae al 800 de siempre (clave ausente).
--
--   3. `create_order` LO HACE CUMPLIR EN EL SERVIDOR — mismo criterio que el
--      recálculo de precios (2026-07-06): el navegador no decide. Un pedido
--      real (`kind = 'order'`) cuyo total RECALCULADO queda por debajo del
--      mínimo de la lista no se guarda: queda en `order_failures` con el
--      motivo ("total $1,900.00 por debajo del pedido mínimo de $2,000.00 de
--      la lista US Wholesale"), el payload y el kind, como cualquier otro
--      rechazo — la asesora lo ve en el cuadro rojo de Pedidos y lo puede
--      Recuperar (como cotización) o Descartar. Las cotizaciones (PDF del
--      carrito, lista `quote`) NO tienen mínimo, igual que hoy. El rechazo
--      por producto sin precio (2026-08-06) sigue teniendo prioridad.
--
-- Qué NO cambia: los caminos del panel (`create_manual_order`,
-- `convert_quote_to_order`, `update_order_items`) no chequean mínimo — ahí
-- decide una persona con el pedido a la vista, y hoy es justamente por donde
-- entran los pedidos chicos legítimos (en producción, 38 de los 47 pedidos
-- de us_wholesale por debajo de $800 son cotizaciones convertidas).
--
-- Borde asumido: los precios cambian dos veces al día y el servidor recalcula
-- el total con los vigentes, así que un carrito que el cliente vio en $2,010
-- puede recalcularse en $1,990 y rechazarse aunque el botón estuviera
-- habilitado. No se pierde: queda en `order_failures` con el motivo, mismo
-- trato que el rechazo por producto sin precio.
--
-- Cuerpos: `get_catalog` es copia exacta del de
-- migration-2026-08-20-client-favorites.sql y `create_order` del de
-- migration-2026-08-06-require-price.sql (verificado el 2026-09-15 contra
-- `pg_get_functiondef` de producción: idénticos al repo), más las líneas
-- marcadas "2026-09-15". Idempotente y re-corrible.
-- ============================================================

set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regclass('public.order_failures') is null then
    raise exception 'Falta correr migration-2026-08-05-order-capture.sql (order_failures) antes de esta';
  end if;
  if to_regprocedure('public.top_seller_ids_by_line(int, int)') is null
     or to_regclass('public.client_favorites') is null then
    raise exception 'Falta correr migration-2026-08-20-client-favorites.sql (este get_catalog es copia del suyo) antes de esta';
  end if;
  -- Si el get_catalog vivo no es el que se copia acá, pisarlo perdería algo.
  if position('is_fav' in pg_get_functiondef('public.get_catalog(text)'::regprocedure)) = 0 then
    raise exception 'El get_catalog vivo no es el de migration-2026-08-20-client-favorites.sql: revisar antes de reemplazarlo';
  end if;
end $$;

begin;

-- ---------- 1) price_lists.min_order ----------
-- Columna + semilla en el mismo bloque, guardado por "la columna no existía":
-- re-correr el archivo no vuelve a sembrar (un mínimo ajustado a mano queda).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'price_lists' and column_name = 'min_order'
  ) then
    alter table public.price_lists add column min_order numeric(12, 2);
    update public.price_lists
    set min_order = case
      when code in ('us_min', 've_min')                                then 800
      when code in ('us_wholesale', 've_wholesale', 'special', 'luzmar') then 2000
      when code = 'quote'                                              then null
      else 800
    end;
  end if;
end $$;

alter table public.price_lists alter column min_order set default 800;

alter table public.price_lists drop constraint if exists price_lists_min_order_check;
alter table public.price_lists add constraint price_lists_min_order_check
  check (min_order is null or min_order >= 0);

comment on column public.price_lists.min_order is
  'Pedido mínimo en USD de la lista (2026-09-15). NULL = sin mínimo (lista quote). get_catalog lo devuelve como client.min_order para avisar en el carrito; create_order lo hace cumplir para kind = ''order'' (total recalculado < min_order → order_failures). Las cotizaciones y los caminos del panel no lo chequean.';

-- ---------- 2) get_catalog: + client.min_order ----------
-- Copia exacta de migration-2026-08-20-client-favorites.sql, más
-- `v_min_order` (una lectura más de la misma fila de price_lists) y la clave
-- `min_order` en el objeto `client`. Las dos ramas devuelven el mismo objeto
-- `client`, así que el cambio es uno solo.
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
      'is_quote_only',   v_code = 'quote',
      -- 2026-09-15: pedido mínimo de la lista (null = sin mínimo). El
      -- frontend, si no encuentra la clave, asume el 800 de siempre.
      'min_order',       v_min_order
    ),
    'products', v_products
  );
end;
$$;

revoke execute on function public.get_catalog(text) from public;
grant execute on function public.get_catalog(text) to anon, authenticated;

-- ---------- 3) create_order: rechazo por debajo del mínimo de la lista ----------
-- Copia exacta de migration-2026-08-06-require-price.sql más el bloque
-- marcado 2026-09-15. Va DESPUÉS del chequeo de productos sin precio (ese
-- motivo es más útil para la asesora y, además, un total con líneas sin
-- precio no es comparable) y ANTES del insert.
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

commit;

-- ============================================================
-- Verificación (solo lectura, SQL Editor o `supabase db query --linked`)
-- ============================================================
-- 1) La semilla:
-- select code, label, min_order from public.price_lists order by code;
-- -- esperado: us_min/ve_min 800.00, us_wholesale/ve_wholesale/special/luzmar
-- -- 2000.00, quote null.
--
-- 2) El catálogo la trae (token de un cliente real):
-- select public.get_catalog('<token>')->'client'->>'min_order';
--
-- 3) La función viva es esta (busca el marcador):
-- select position('pedido mínimo' in pg_get_functiondef('public.create_order(text, jsonb, numeric, text, uuid)'::regprocedure)) > 0;
--
-- 4) Cambiar el mínimo de una lista (escribe):
-- update public.price_lists set min_order = 800 where code = 'luzmar';
