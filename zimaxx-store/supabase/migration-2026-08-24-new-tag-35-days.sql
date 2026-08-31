-- Etiqueta ✨ Nuevo: de 10 días a 5 semanas (2026-08-24, a pedido del
-- usuario: "extiéndelo a que dure 1 mes/5 semanas aprox"). El único lugar
-- del lado base donde vive la duración es el INSERT de sync_upsert_products
-- (los productos nuevos del sync entran con new_until = now() + intervalo);
-- el alta manual y el Excel de productos la calculan en el frontend
-- (NEW_TAG_DAYS en ProductsAdmin.jsx, cambiada a 35 en el mismo commit).
--
-- Delta chico e idempotente (mismo criterio que las otras migraciones, sin
-- re-correr schema.sql). Reescribe sync_upsert_products IGUAL a la versión
-- viva de migration-2026-07-14-product-upc.sql cambiando SOLO el intervalo:
-- interval '10 days' → interval '35 days'. (La migración del 2026-08-13,
-- exclude-box-skus, no tocó esta función — solo sync_is_noncatalog_product,
-- que esta versión sigue llamando igual.)
--
-- TAMBIÉN extiende las etiquetas vigentes (segunda iteración del mismo día,
-- a pedido del usuario: "si extiende los que ya tienen la etiqueta"): a todo
-- new_until en el futuro se le suman los 25 días de diferencia (10 → 35),
-- venga del sync, del Excel, del alta manual o del ✨ en bloque. Las
-- expiradas no reviven y las null no se tocan. El backfill es idempotente
-- por un guard, no por naturaleza: se salta a sí mismo si la función viva ya
-- dice '35 days' (o sea, si esta migración ya corrió) — sin eso, re-correrla
-- sumaría 25 días otra vez. Por eso va ANTES del create or replace.
--
-- Independiente del deploy del frontend: sin correrla, los productos nuevos
-- del sync siguen entrando con 10 días (nada se rompe); el frontend nuevo ya
-- pone 35 en el alta manual/Excel/bloque desde que se despliegue.
--
-- lock_timeout para fallar rápido y limpio si un lock se traba contra el
-- sitio en producción.
set lock_timeout = '10s';

-- ---------- Backfill: extender las etiquetas ✨ vigentes ----------
-- Va ANTES de reescribir la función: el guard usa el cuerpo vivo de
-- sync_upsert_products como marca de "esta migración ya corrió" (si ya dice
-- '35 days', el backfill ya se aplicó y volver a sumar duplicaría los 25
-- días). En una instalación sin el sync (to_regprocedure null) no hay marca,
-- pero tampoco historia que duplicar: el UPDATE corre sobre lo que haya.
-- El UPDATE dispara los triggers de products (availability_from_stock,
-- enforce_noncatalog), que recalculan a los mismos valores — sin efecto.
do $$
declare
  v_count int;
begin
  if to_regprocedure('public.sync_upsert_products(jsonb)') is not null
     and pg_get_functiondef('public.sync_upsert_products(jsonb)'::regprocedure)
         like '%35 days%' then
    raise notice 'backfill saltado: sync_upsert_products ya está en 35 días (la migración ya corrió)';
    return;
  end if;

  update public.products
     set new_until = new_until + interval '25 days'
   where new_until > now();
  get diagnostics v_count = row_count;
  raise notice 'etiquetas ✨ Nuevo vigentes extendidas +25 días: %', v_count;
end $$;

-- ---------- Upsert de productos ----------
-- Igual que la versión de migration-2026-07-14-product-upc.sql; solo cambia
-- el new_until del INSERT (fila nueva): now() + interval '35 days'.
-- En updates new_until sigue sin tocarse (re-sincronizar no re-etiqueta).
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
       now() + interval '35 days')
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
-- El backfill: ANTES de correr la migración, anotar cuántas etiquetas hay
-- vivas — select count(*) from public.products where new_until > now(); —
-- y comparar con el número del NOTICE ("extendidas +25 días: N"). Re-correr
-- la migración entera tiene que decir "backfill saltado" (guard por el
-- cuerpo de la función) y no mover ninguna fecha.
--
-- Un producto nuevo entra con la etiqueta ✨ Nuevo por ~35 días:
-- select public.sync_upsert_products('[
--   {"sku": "NEW35-TEST", "name": "Prueba etiqueta 35 días", "inventory": "3"}
-- ]'::jsonb);
-- select sku, new_until,
--        new_until between now() + interval '34 days' and now() + interval '36 days' as ok_35d
--   from public.products where sku = 'NEW35-TEST';
-- -- Re-correr el upsert NO pisa el new_until existente:
-- select public.sync_upsert_products('[
--   {"sku": "NEW35-TEST", "name": "Prueba etiqueta 35 días", "inventory": "0"}
-- ]'::jsonb);
-- select sku, new_until from public.products where sku = 'NEW35-TEST'; -- igual que antes
-- delete from public.products where sku = 'NEW35-TEST';
