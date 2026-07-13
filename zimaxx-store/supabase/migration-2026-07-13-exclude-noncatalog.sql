-- Excluir del catálogo los productos que NO son perfumes vendibles
-- (2026-07-13, a pedido del usuario). Dos cosas de un mismo problema:
--
--   (1) DESACTIVAR los que ya se cargaron a la tabla `products` (entraron
--       por la carga manual de Excel en ProductsAdmin.jsx, porque el sync
--       de n8n todavía no existe): set active = false, NUNCA delete — así
--       es reversible y no rompe precios/pedidos que los referencien.
--
--   (2) Que el UPSERT del sync (sync_upsert_products) NO los vuelva a
--       jalar: las filas que caen en la regla se cuentan en `skipped` y no
--       se insertan/actualizan.
--
-- La regla de "no-catálogo" (misma para ambos, ver sync_is_noncatalog_product):
--   * SKU que termina en -SPECIAL (variante interna de SellerCloud), o
--   * PRODUCT_CATEGORY del export (que en este esquema se guarda en
--     products.product_line, NO en category que es la marca/Brand) igual a
--     una de: test, electronics, packing and shipping supplies, support,
--     beauty. Se compara normalizado (minúsculas, sin espacios de más y
--     recortado) para tolerar mayúsculas y dobles espacios del export.
--
-- El mismo criterio está replicado del lado del cliente en
-- ProductsAdmin.jsx (constantes EXCLUDED_LINES / SPECIAL_SKU_PATTERN) para
-- la carga manual por Excel — si se cambia la lista acá, cambiarla también
-- allá.
--
-- Idempotente. lock_timeout para que un ALTER/UPDATE trabado falle rápido
-- y limpio en vez de deadlockear contra el sitio en producción (ya pasó
-- una vez con el schema.sql completo).
set lock_timeout = '10s';

-- ---------- Predicado compartido "no-catálogo" ----------
-- Puro/immutable: lo usan tanto el UPDATE de abajo como
-- sync_upsert_products. Un solo lugar donde vive la regla.
create or replace function public.sync_is_noncatalog_product(p_sku text, p_line text)
returns boolean
language sql
immutable
as $$
  select
    coalesce(p_sku ~* '-special$', false)
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

-- ---------- (1) Desactivar los ya cargados ----------
-- Solo toca los que están activos (así el conteo devuelto es el de los que
-- realmente se apagaron, y no se re-escribe una fila ya inactiva).
-- Para revertir un producto puntual: update products set active = true where sku = '...';
update public.products
set active = false
where active = true
  and public.sync_is_noncatalog_product(sku, product_line);

-- ---------- (2) Que el sync no los vuelva a jalar ----------
-- Misma función que la v1 (migration-2026-07-10-sellercloud-sync.sql) con
-- un único agregado: el skip por sync_is_noncatalog_product justo después
-- del check de sku/name nulos. El resto del cuerpo es idéntico.
create or replace function public.sync_upsert_products(p_products jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r           record;
  v_avail     text;
  v_is_insert boolean;
  v_inserted  int := 0;
  v_updated   int := 0;
  v_skipped   int := 0;
begin
  if p_products is null or jsonb_typeof(p_products) <> 'array' then
    raise exception 'p_products debe ser un array jsonb';
  end if;

  for r in
    select
      nullif(trim(x ->> 'sku'), '')          as sku,
      nullif(trim(x ->> 'name'), '')         as name,
      nullif(trim(x ->> 'category'), '')     as category,
      nullif(trim(x ->> 'product_line'), '') as product_line,
      nullif(trim(x ->> 'availability'), '') as availability,
      nullif(trim(x ->> 'image_url'), '')    as image_url
    from jsonb_array_elements(p_products) as x
  loop
    if r.sku is null or r.name is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- No-catálogo (SKU -SPECIAL o categoría excluida): no se jala.
    if public.sync_is_noncatalog_product(r.sku, r.product_line) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_avail := case
      when lower(r.availability) in ('available', 'preorder', 'flash') then lower(r.availability)
      else null
    end;

    insert into public.products as p
      (sku, name, category, product_line, availability, image_url, new_until)
    values
      (r.sku, r.name, r.category, r.product_line,
       coalesce(v_avail, 'available'), r.image_url,
       now() + interval '10 days')
    on conflict (sku) do update set
      name         = r.name,
      category     = coalesce(r.category, p.category),
      product_line = coalesce(r.product_line, p.product_line),
      availability = coalesce(v_avail, p.availability),
      image_url    = coalesce(r.image_url, p.image_url)
    returning (xmax = 0) into v_is_insert;

    if v_is_insert then
      v_inserted := v_inserted + 1;
    else
      v_updated := v_updated + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated',  v_updated,
    'skipped',  v_skipped
  );
end;
$$;

revoke execute on function public.sync_upsert_products(jsonb) from public;
grant execute on function public.sync_upsert_products(jsonb) to service_role;

-- ---------- Verificación manual (SQL Editor) ----------
-- Cuántos quedaron activos/inactivos por categoría (los excluidos deben
-- quedar todos en active = false tras correr el UPDATE de arriba):
-- select product_line, active, count(*)
-- from public.products
-- where public.sync_is_noncatalog_product(sku, product_line)
-- group by product_line, active
-- order by product_line, active;
--
-- El upsert debe saltarse un SKU -SPECIAL y una categoría excluida
-- (esperado {"inserted": 1, "updated": 0, "skipped": 2}):
-- select public.sync_upsert_products('[
--   {"sku": "OK-CATALOGO-1", "name": "Perfume de prueba", "product_line": "Perfume"},
--   {"sku": "ALGO-SPECIAL",  "name": "Debe saltarse por -SPECIAL", "product_line": "Perfume"},
--   {"sku": "OK-2",          "name": "Debe saltarse por categoria", "product_line": "Beauty"}
-- ]'::jsonb);
-- select sku, name, active from public.products
-- where sku in ('OK-CATALOGO-1', 'ALGO-SPECIAL', 'OK-2');
-- -- Limpieza:
-- delete from public.products where sku in ('OK-CATALOGO-1', 'ALGO-SPECIAL', 'OK-2');
