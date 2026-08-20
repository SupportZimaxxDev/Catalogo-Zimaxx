-- ============================================================
-- 2026-08-20: "Más vendidos" POR LÍNEA (árabes / diseñador) en el catálogo
--
-- Contexto (a pedido del usuario, cuarta tanda del día: "agregar filtros de
-- mas vendidos arabes, mas vendidos diseñador"). El chip ⭐ Más vendidos del
-- catálogo marca el top GLOBAL; si una línea domina las ventas, el top de la
-- otra queda invisible. Esta migración agrega el ranking POR LÍNEA: el top 12
-- de cada `product_line` en la misma ventana de 60 días, sobre las mismas
-- cubetas de `product_sales_daily` (migration-2026-08-20-top-sellers.sql).
--
-- El catálogo recibe UNA clave nueva por producto: `is_top_line` = ¿está en
-- el top 12 DE SU línea? El frontend arma los chips cruzándola con
-- `product_line`, que ya viaja: "Más vendidos árabes" = is_top_line +
-- 'Perfume - Arabes', "Más vendidos diseñador" = is_top_line + 'Perfume'.
-- Así la base no queda casada con los nombres de las dos líneas de hoy: si
-- mañana aparece otra línea, su top ya viene marcado y solo falta el chip.
-- Los productos con `product_line` null (hoy 3 activos) no rankean por línea:
-- no hay chip que pueda mostrarlos.
--
-- `is_top` (global) no cambia: el chip y el badge ⭐ de siempre siguen igual.
--
-- get_catalog: copia exacta de la versión de migration-2026-08-20-
-- top-sellers.sql con la clave nueva en las DOS ramas (la lista quote
-- también). El top por línea se resuelve UNA vez por llamada, igual que el
-- global.
--
-- COMPATIBILIDAD: aditiva. Frontend viejo ignora `is_top_line`; frontend
-- nuevo sin esta migración recibe undefined y los chips por línea no
-- aparecen (mismo patrón que is_top/upc). No bloquea el deploy.
--
-- Idempotente (create or replace). REQUIERE migration-2026-08-20-
-- top-sellers.sql (las cubetas y el get_catalog del que este es copia); el
-- preflight corta si falta.
-- ============================================================
set lock_timeout = '10s';

-- ---------- Preflight ----------
do $$
begin
  if to_regclass('public.product_sales_daily') is null
     or to_regprocedure('public.top_seller_ids(int, int)') is null then
    raise exception 'Falta correr migration-2026-08-20-top-sellers.sql (crea product_sales_daily y top_seller_ids) antes de esta';
  end if;
end $$;

begin;

-- ---------- 1) El ranking por línea ----------
-- Top p_limit de CADA product_line por unidades pedidas en p_days días.
-- Mismo criterio que top_seller_ids: solo suma positiva, desempate por id
-- para que el corte sea estable entre llamadas.
create or replace function public.top_seller_ids_by_line(p_days int default 60, p_limit int default 12)
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select id
  from (
    select p.id,
           row_number() over (
             partition by p.product_line
             order by s.units desc, p.id
           ) as rn
    from (
      select product_id, sum(units) as units
      from public.product_sales_daily
      where day >= (now() at time zone 'utc')::date - greatest(coalesce(p_days, 60), 1)
      group by product_id
      having sum(units) > 0
    ) s
    join public.products p on p.id = s.product_id
    where p.product_line is not null
  ) t
  where t.rn <= greatest(coalesce(p_limit, 12), 1);
$$;

-- Solo la llama get_catalog (DEFINER): no se expone por la API.
revoke execute on function public.top_seller_ids_by_line(int, int) from public, anon, authenticated;

comment on function public.top_seller_ids_by_line(int, int) is
  'Top p_limit por unidades pedidas (p_days días) DENTRO de cada product_line, desde product_sales_daily. Alimenta is_top_line en get_catalog — los chips "Más vendidos árabes/diseñador" del catálogo (2026-08-20).';

-- ---------- 2) get_catalog: is_top_line viaja al cliente ----------
-- Copia exacta de la versión de migration-2026-08-20-top-sellers.sql con un
-- solo cambio: la clave 'is_top_line' en las dos ramas.
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
  -- Ventana y tamaño del "Más vendidos" del catálogo (global y por línea).
  -- Si algún día se quiere otro corte, se cambia ACÁ (es el único lugar).
  v_top             uuid[] := array(select public.top_seller_ids(60, 12));
  v_top_line        uuid[] := array(select public.top_seller_ids_by_line(60, 12));
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
          'is_top',       (p.id = any(v_top)),
          'is_top_line',  (p.id = any(v_top_line)),
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

commit;

-- ============================================================
-- Verificación manual (SQL Editor)
-- ============================================================
-- 1) El top por línea, con nombre (lo que van a marcar los chips):
-- select p.product_line, p.name, sum(d.units) as unidades
-- from public.product_sales_daily d join public.products p on p.id = d.product_id
-- where d.day >= (now() at time zone 'utc')::date - 60 and p.product_line is not null
-- group by p.product_line, p.name
-- order by p.product_line, unidades desc;
--
-- 2) El catálogo lo trae (token real): cuántos marcados por línea:
-- select e->>'product_line' as linea,
--        count(*) filter (where (e->>'is_top_line')::boolean) as top_de_su_linea
-- from jsonb_array_elements(public.get_catalog('<token>')->'products') e
-- group by 1;
-- -- esperado: hasta 12 por línea (menos si algún top no tiene precio en esa lista).
