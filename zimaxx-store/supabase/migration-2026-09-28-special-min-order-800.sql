-- ============================================================
-- Pedido mínimo de la lista Special: $2,000 → $800 (2026-09-28)
-- ============================================================
-- A pedido del usuario: "la lista de precios especial es para todos los
-- clientes de estados unidos, sin diferencia, es decir, hay que cambiar la
-- logica para que el minimo de compra para la lista especial sea de 800 en
-- adelante". La 09-15 la había dejado en 2,000 por la regla literal de aquel
-- pedido (ver su comentario, que ya preveía este UPDATE de una línea).
--
-- Solo datos: `create_order`, `get_catalog` y el carrito leen
-- `price_lists.min_order`, así que no cambia ninguna función ni el frontend.
-- Idempotente: re-correrla no hace nada si ya está en 800.
--
-- Preflight: exige la columna de la 09-15 (sin ella no hay nada que ajustar).
-- ============================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'price_lists' and column_name = 'min_order'
  ) then
    raise exception 'falta migration-2026-09-15-price-list-min-order.sql (price_lists.min_order no existe)';
  end if;
  if not exists (select 1 from public.price_lists where code = 'special') then
    raise exception 'no existe la lista special';
  end if;
end $$;

update public.price_lists
set min_order = 800
where code = 'special' and min_order is distinct from 800;

-- ============================================================
-- Verificación (solo lectura)
-- ============================================================
-- select code, min_order from public.price_lists order by code;
-- -- esperado: us_min/ve_min/special 800.00, us_wholesale/ve_wholesale/luzmar
-- -- 2000.00, quote null.
--
-- Rollback: update public.price_lists set min_order = 2000 where code = 'special';
