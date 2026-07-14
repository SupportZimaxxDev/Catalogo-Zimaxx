-- Stock en la BD + disponibilidad automática por stock (2026-07-14, a
-- pedido del usuario). Reemplaza al borrador anterior
-- (migration-2026-07-14-inventory-active.sql, que hacía que el inventario
-- controlara `active` — descartado: ahora el stock controla la
-- DISPONIBILIDAD, no el estado activo).
--
-- El JSON de la API de SellerCloud que jala el sync (n8n) trae
-- InventoryAvailableQTY por producto. Se registra en una columna nueva
-- `products.stock` (NO se expone en el catálogo del cliente — get_catalog
-- arma el JSON con campos explícitos y no la incluye) y, en cada corrida,
-- decide la disponibilidad:
--
--   * stock >= 1 → 'available' (disponible; deja de ser pre-order)
--   * stock  = 0 (o < 0)  → 'preorder' (agotado pero se puede reservar)
--   * EXCEPCIÓN: si el producto está marcado 'flash' (Type = Flash Sale,
--     entrante o ya guardado), se conserva 'flash' — el stock solo alterna
--     entre available/preorder.
--
-- `active` (activo/inactivo) YA NO lo toca el sync: es decisión 100% manual
-- del admin (selección por casillas + activar/desactivar en bloque en
-- ProductsAdmin.jsx) más la exclusión de no-catálogo
-- (sync_is_noncatalog_product, que saltea esos productos sin insertarlos).
-- Un producto con stock 0 ahora se MUESTRA como pre-order (antes se ocultaba
-- como inactivo); ocultarlo es una acción manual aparte.
--
-- Sólido ante campo ausente: si una fila no trae inventario (null/no
-- numérico), `stock` y `availability` no se pisan (se conserva lo que haya;
-- mismo criterio "solo pisa si trae dato" del resto de la función).
--
-- Nota: no hay backfill de los productos ya cargados — `products` no tenía
-- la cantidad de stock hasta ahora, y el único lugar donde vive ese dato es
-- el JSON de SellerCloud. Los productos que hoy se ven sin stock se
-- corrigen en la primera corrida del sync que traiga InventoryAvailableQTY
-- (o se apagan a mano con el bulk mientras tanto).
--
-- Idempotente. lock_timeout para fallar rápido y limpio si un lock se traba
-- contra el sitio en producción (ya pasó una vez con el schema.sql completo).
set lock_timeout = '10s';

-- ---------- Columna de stock ----------
-- Nullable: null = "todavía no sabemos el stock" (producto cargado antes de
-- que el sync trajera inventario), distinto de 0 = "sin stock".
alter table public.products
  add column if not exists stock int;

-- ---------- Upsert de productos ----------
-- Misma función que migration-2026-07-13-exclude-noncatalog.sql (con el
-- skip de no-catálogo) más: registrar `stock` y derivar `availability` del
-- stock (respetando 'flash'). `active` deja de tocarse.
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
      (sku, name, category, product_line, availability, image_url, stock, new_until)
    values
      (r.sku, r.name, r.category, r.product_line,
       v_avail_ins, r.image_url, v_stock,
       now() + interval '10 days')
    on conflict (sku) do update set
      name         = r.name,
      category     = coalesce(r.category, p.category),
      product_line = coalesce(r.product_line, p.product_line),
      image_url    = coalesce(r.image_url, p.image_url),
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
-- Stock 0 → preorder, stock >=1 → available, flash se conserva, active NO
-- se toca. Esperado: {"inserted": 3, "updated": 0, "skipped": 0}.
-- select public.sync_upsert_products('[
--   {"sku": "STK-0",     "name": "Sin stock",   "product_line": "Perfume", "inventory": "0"},
--   {"sku": "STK-5",     "name": "Con stock",   "product_line": "Perfume", "inventory": "5"},
--   {"sku": "STK-FLASH", "name": "Flash",       "product_line": "Perfume", "inventory": "0",
--    "availability": "flash"}
-- ]'::jsonb);
-- select sku, stock, availability, active from public.products
-- where sku in ('STK-0', 'STK-5', 'STK-FLASH') order by sku;
-- -- Esperado: STK-0 preorder, STK-5 available, STK-FLASH flash; los tres active=true.
--
-- Re-correr con el stock invertido: STK-5 pasa a preorder, STK-0 a
-- available, STK-FLASH sigue flash aunque ahora tenga stock:
-- select public.sync_upsert_products('[
--   {"sku": "STK-0",     "name": "Sin stock", "inventory": "9"},
--   {"sku": "STK-5",     "name": "Con stock", "inventory": "0"},
--   {"sku": "STK-FLASH", "name": "Flash",     "inventory": "20"}
-- ]'::jsonb);
-- select sku, stock, availability from public.products
-- where sku in ('STK-0', 'STK-5', 'STK-FLASH') order by sku;
-- -- Esperado: STK-0 available, STK-5 preorder, STK-FLASH flash (stock 20).
--
-- Limpieza:
-- delete from public.products where sku in ('STK-0', 'STK-5', 'STK-FLASH');
