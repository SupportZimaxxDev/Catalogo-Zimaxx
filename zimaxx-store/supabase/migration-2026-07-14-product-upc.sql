-- UPC del producto (2026-07-14, a pedido del usuario): guardar el UPC en la
-- BD y poder verlo desde el panel de productos. Los exports de SellerCloud
-- (ej. 119389.xlsx) y el JSON de la API traen la columna UPC.
--
-- Delta chico e idempotente (mismo criterio que las otras migraciones, sin
-- re-correr schema.sql). Va DESPUÉS de migration-2026-07-14-inventory-stock.sql
-- (reescribe sync_upsert_products sobre esa versión, agregando solo el upc).
--
-- El UPC NO se expone en el catálogo del cliente (get_catalog arma el JSON
-- con campos explícitos y no lo incluye) — es un dato interno del admin,
-- como el sku y el stock.
--
-- lock_timeout para fallar rápido y limpio si un lock se traba contra el
-- sitio en producción.
set lock_timeout = '10s';

-- ---------- Columna UPC ----------
alter table public.products
  add column if not exists upc text;

-- ---------- Upsert de productos ----------
-- Igual que la versión de migration-2026-07-14-inventory-stock.sql (stock
-- controla la disponibilidad, active no se toca) más: leer y guardar `upc`.
-- En updates solo pisa si viene con dato (mismo criterio que los demás
-- campos opcionales — un export sin UPC no borra el ya cargado).
create or replace function public.sync_upsert_products(p_products jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r           record;
  v_avail     text;   -- disponibilidad entrante (Type) normalizada, o null
  v_stock     int;    -- InventoryAvailableQTY parseado, o null si no vino/no numérico
  v_avail_ins text;   -- disponibilidad final para el INSERT (fila nueva)
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
      nullif(trim(x ->> 'image_url'), '')    as image_url,
      nullif(trim(x ->> 'upc'), '')          as upc,
      nullif(trim(coalesce(x ->> 'inventory', x ->> 'inventory_available_qty')), '') as inventory
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

    -- Stock (InventoryAvailableQTY): entero, o null si no vino o no es
    -- numérico. floor() por si llega como "5.0".
    v_stock := null;
    if r.inventory is not null then
      begin
        v_stock := floor(r.inventory::numeric)::int;
      exception when others then
        v_stock := null;
      end;
    end if;

    -- Disponibilidad para el INSERT (fila nueva, sin valor previo): flash
    -- entrante se respeta; si no, el stock manda (>=1 available, si no
    -- preorder); si no hay stock, la disponibilidad entrante o 'available'.
    v_avail_ins := case
      when v_avail = 'flash' then 'flash'
      when v_stock is not null then case when v_stock >= 1 then 'available' else 'preorder' end
      else coalesce(v_avail, 'available')
    end;

    insert into public.products as p
      (sku, name, category, product_line, availability, image_url, stock, upc, new_until)
    values
      (r.sku, r.name, r.category, r.product_line,
       v_avail_ins, r.image_url, v_stock, r.upc,
       now() + interval '10 days')
    on conflict (sku) do update set
      name         = r.name,
      category     = coalesce(r.category, p.category),
      product_line = coalesce(r.product_line, p.product_line),
      image_url    = coalesce(r.image_url, p.image_url),
      upc          = coalesce(r.upc, p.upc),
      stock        = coalesce(v_stock, p.stock),
      -- flash (entrante o ya guardado) se conserva; si no, el stock manda
      -- cuando vino; si no, la disponibilidad entrante o la existente.
      -- `active` a propósito NO está acá: es decisión manual del admin.
      availability = case
        when coalesce(v_avail, p.availability) = 'flash' then 'flash'
        when v_stock is not null then case when v_stock >= 1 then 'available' else 'preorder' end
        else coalesce(v_avail, p.availability)
      end
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
-- El upc se guarda y, al re-correr sin upc, no se borra:
-- select public.sync_upsert_products('[
--   {"sku": "UPC-TEST", "name": "Prueba UPC", "product_line": "Perfume",
--    "upc": "6290360123456", "inventory": "3"}
-- ]'::jsonb);
-- select sku, upc, stock, availability from public.products where sku = 'UPC-TEST';
-- -- Re-correr sin upc NO lo borra (coalesce):
-- select public.sync_upsert_products('[
--   {"sku": "UPC-TEST", "name": "Prueba UPC", "inventory": "0"}
-- ]'::jsonb);
-- select sku, upc, stock, availability from public.products where sku = 'UPC-TEST';
-- -- Esperado: upc sigue 6290360123456, stock 0, availability preorder.
-- delete from public.products where sku = 'UPC-TEST';
