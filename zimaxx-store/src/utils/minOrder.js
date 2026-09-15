// Pedido mínimo que aplica al cliente del catálogo (2026-09-15).
//
// El mínimo es POR LISTA DE PRECIO y lo decide la base: `price_lists.min_order`
// (us_min/ve_min 800, wholesale/special/luzmar 2000, quote sin mínimo), y
// llega al navegador en `client.min_order` de `get_catalog`. El servidor
// (`create_order`) hace cumplir exactamente lo mismo — esto existe para
// avisarle al cliente ANTES de que mande el pedido, no como control.
//
// Tres casos para el valor que llega:
//   * número → ese es el mínimo.
//   * null   → sin mínimo (lista `quote`, que además no tiene precios).
//   * clave ausente (`undefined`) → base sin
//     migration-2026-09-15-price-list-min-order.sql: se asume el 800 de
//     siempre, que era el único mínimo hasta ese día.

// Antes era el ÚNICO mínimo (plano para todas las listas); ahora es solo el
// fallback para una base sin migrar.
export const DEFAULT_MIN_ORDER = Number(import.meta.env.VITE_MIN_ORDER ?? 800)

export function minOrderFor(client) {
  if (!client || client.min_order === undefined) return DEFAULT_MIN_ORDER
  if (client.min_order === null) return null
  const n = Number(client.min_order)
  return Number.isFinite(n) ? n : DEFAULT_MIN_ORDER
}
