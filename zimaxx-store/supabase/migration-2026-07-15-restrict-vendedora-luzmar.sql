-- Restringir el acceso de las vendedoras a la lista "personal" de otra
-- vendedora (2026-07-15, a pedido del usuario). Hasta ahora
-- `vendedora_select_readonly` daba a CUALQUIER vendedora autenticada
-- lectura de TODAS las filas de `price_lists` y `product_prices` — sin
-- distinguir listas "generales" de listas "personales"
-- (`price_lists.owner_vendedora_id`, ej. 'luzmar', ver
-- migration-2026-07-09-luzmar-owner-link.sql). Eso filtraba la columna
-- "Luzmar - Precio Especial" (y sus precios reales) en la matriz de
-- PricesUpload.jsx y en el selector de listas a cualquier otra vendedora.
--
-- Regla nueva: una vendedora ve una fila de `price_lists`/`product_prices`
-- si la lista es general (`owner_vendedora_id is null`) o si la lista es
-- suya (`owner_vendedora_id = current_vendedora_id()`). Los admins no se
-- tocan (siguen con `admin_all`, que es aditiva y ya cubre todo).
--
-- Idempotente (drop + create de las mismas policies) y sin riesgo de
-- deadlock: solo toca policies, no filas ni columnas.
set lock_timeout = '10s';

-- La policy vieja cubría price_lists/product_prices en el mismo loop que
-- products/flash_sales; se borra acá para las dos tablas que cambian.
drop policy if exists vendedora_select_readonly on public.price_lists;
drop policy if exists vendedora_select_price_lists on public.price_lists;
create policy vendedora_select_price_lists on public.price_lists
  for select to authenticated
  using (
    public.is_vendedora()
    and (owner_vendedora_id is null or owner_vendedora_id = public.current_vendedora_id())
  );

drop policy if exists vendedora_select_readonly on public.product_prices;
drop policy if exists vendedora_select_product_prices on public.product_prices;
create policy vendedora_select_product_prices on public.product_prices
  for select to authenticated
  using (
    public.is_vendedora()
    and exists (
      select 1 from public.price_lists pl
      where pl.id = product_prices.price_list_id
        and (pl.owner_vendedora_id is null or pl.owner_vendedora_id = public.current_vendedora_id())
    )
  );

-- ---------- Verificación manual (SQL Editor) ----------
-- El SQL Editor corre como postgres (no como un usuario authenticated), así
-- que is_vendedora() da false y estas policies no aplican ahí — para
-- probar de verdad hay que loguearse en la app como una vendedora que NO
-- sea Luzmar y confirmar que en Precios no aparece la columna/opción
-- "Luzmar - Precio Especial". Chequeo rápido de que las policies quedaron:
-- select tablename, policyname, qual from pg_policies
-- where tablename in ('price_lists', 'product_prices') and policyname like 'vendedora_select%';
