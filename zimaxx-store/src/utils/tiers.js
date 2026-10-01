// Listas de precio dinámicas (2026-10-01): el nivel de precios que paga el
// carrito lo decide su total, no solo la lista asignada al cliente.
//
// Los datos vienen de `get_catalog`:
//   * `client.tiers`  → [{code, label, threshold, min_order}, ...] — la cadena
//     de niveles desde la lista del cliente (índice 0, threshold null) hacia
//     arriba. null/ausente = sin niveles (lista Special, VIP, quote, o base sin
//     migration-2026-10-01-dynamic-price-tiers.sql): todo se comporta como
//     siempre.
//   * `product.tier_prices` → [precio en cada nivel], alineado con `tiers`,
//     null donde ese nivel no tiene precio.
//
// La regla es la MISMA que `compute_order_items` en el servidor (que es quien
// manda al registrar el pedido): se sube de a un nivel mientras el total A
// PRECIOS DEL NIVEL ACTUAL llegue a la marca del siguiente (borde inclusivo),
// y un producto sin precio en un nivel hereda el del nivel anterior. Esto
// existe para que el cliente vea el nivel, el ahorro y cuánto le falta al
// instante, sin ir al servidor en cada toque.

export function tiersFor(client) {
  const t = client?.tiers
  return Array.isArray(t) && t.length > 1 ? t : []
}

// Precio de un ítem/producto en el nivel `k`, con herencia hacia abajo. Sin
// `tier_prices` (carrito guardado antes del cambio, base sin migrar) el único
// precio conocido es `price`, en todos los niveles.
export function tierPrice(item, k) {
  const tp = item?.tier_prices
  const base = item?.price == null ? null : Number(item.price)
  if (!Array.isArray(tp) || tp.length === 0) return base
  for (let i = Math.min(k, tp.length - 1); i >= 0; i--) {
    if (tp[i] != null) return Number(tp[i])
  }
  return base
}

// Calcula el nivel efectivo del carrito y todo lo que la UI muestra.
//   items: [{price, qty, tier_prices?}]; tiers: lo que devuelve tiersFor().
// Devuelve siempre un objeto (con tiers = [] es el carrito de siempre).
export function cartPricing(items, tiers) {
  const n = tiers.length
  const totals = new Array(Math.max(n, 1)).fill(0)
  for (const it of items) {
    const qty = Number(it.qty) || 0
    if (n === 0) {
      if (it.price != null) totals[0] += Number(it.price) * qty
      continue
    }
    for (let k = 0; k < n; k++) {
      const p = tierPrice(it, k)
      if (p != null) totals[k] += p * qty
    }
  }
  let index = 0
  while (
    index < n - 1 &&
    tiers[index + 1].threshold != null &&
    totals[index] >= Number(tiers[index + 1].threshold)
  ) {
    index++
  }
  const total = round2(totals[index])
  const baseTotal = round2(totals[0])
  const next = n > 0 && index < n - 1 ? tiers[index + 1] : null
  return {
    index,
    tier: n > 0 ? tiers[index] : null,
    total,
    baseTotal,
    savings: round2(baseTotal - total),
    next: next
      ? {
          ...next,
          threshold: Number(next.threshold),
          missing: round2(Number(next.threshold) - totals[index]),
          // Qué tan cerca está, para la barra de progreso (0..1).
          progress: Math.max(0, Math.min(1, totals[index] / Number(next.threshold))),
        }
      : null,
    priceOf: (item) => (n > 0 ? tierPrice(item, index) : item?.price == null ? null : Number(item.price)),
  }
}

function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100
}
