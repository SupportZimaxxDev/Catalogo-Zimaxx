-- =============================================================================
-- Migración 2026-08-18: Sales Rep de SellerCloud por vendedora
-- =============================================================================
-- La orden que se manda a SellerCloud ("Enviar a SellerCloud", 2026-08-17)
-- ahora viaja con el Sales Rep y el Marketing Source. El problema: la API de
-- creación (POST /rest/api/Orders/) los acepta SOLO como enteros —
-- OrderDetails.SalesRepresentative y OrderDetails.MarketingSource, verificado
-- contra el Swagger del propio servidor (fc2.api.sellercloud.com/rest/swagger/
-- docs/v1) — y no expone ningún endpoint para resolver un email o un nombre a
-- su ID. O sea que el mapeo tiene que vivir de este lado.
--
--   * Sales Rep: una columna en `vendedores`. Es un dato por vendedora, los
--     admins ya editan esa tabla desde el panel, y RLS ya deja que cada
--     vendedora lea su propia fila (vendedora_select_self) — que es exactamente
--     lo que necesita la Edge Function, porque lee CON EL JWT de quien apretó
--     el botón.
--   * Marketing Source: NO va acá. Es un solo valor global ("catalogo
--     online"), así que va como secret de la función
--     (SELLERCLOUD_MARKETING_SOURCE_ID), igual que COMPANY_ID.
--
-- El ID de empleado se saca de SellerCloud (Delta UI → Settings → Employees;
-- el ID aparece en la grilla y en la URL al abrir el empleado). Si la columna
-- queda en null la orden entra igual, solo que sin Sales Rep — mismo criterio
-- que todo el flujo: no perder la orden por un dato accesorio.
--
-- Idempotente: se puede correr más de una vez.
-- =============================================================================

alter table public.vendedores
  add column if not exists sellercloud_rep_id integer;

comment on column public.vendedores.sellercloud_rep_id is
  'ID de empleado en SellerCloud (Settings → Employees). Viaja como '
  'OrderDetails.SalesRepresentative al mandar un pedido con "Enviar a '
  'SellerCloud". Null = la orden entra sin Sales Rep.';

-- Sin cambios de RLS: admin_all ya deja a los admins leer/escribir la columna
-- desde el panel, y vendedora_select_self ya deja que la Edge Function la lea
-- con el JWT de la vendedora que aprieta el botón.

-- Verificación rápida:
--   select name, sellercloud_rep_id from public.vendedores order by name;
