// Tests de las listas de precio dinámicas en el navegador (src/utils/tiers.js),
// en Node, sin navegador. Correr con `node tests/tiers-tests.mjs`.
//
// El módulo es puro (sin import.meta.env ni DOM), así que se importa directo.
// La regla tiene que ser la MISMA que compute_order_items en el servidor
// (migration-2026-10-01-dynamic-price-tiers.sql): los casos de acá son los
// mismos escenarios D1–D8 del arnés SQL de esa migración, con los mismos
// números, para que si uno de los dos cambia se note.
import { cartPricing, tierPrice, tiersFor } from '../src/utils/tiers.js'

let passed = 0
let failed = 0
const ok = (cond, msg) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.log(`  ✗ ${msg}`)
  }
}

const TIERS = [
  { code: 'us_min', label: 'US Minimum Order', threshold: null, min_order: 800 },
  { code: 'us_wholesale', label: 'US Wholesale', threshold: 2000, min_order: 2000 },
  { code: 'special', label: 'Special Order', threshold: 15000, min_order: 800 },
]
const P1 = (qty) => ({ id: 'p1', price: 100, tier_prices: [100, 90, 80], qty })
const P3 = (qty) => ({ id: 'p3', price: 50, tier_prices: [50, null, null], qty })
const OLD = (qty) => ({ id: 'old', price: 100, qty }) // carrito guardado sin tier_prices

console.log('tiersFor')
ok(tiersFor({ tiers: TIERS }).length === 3, 'devuelve la cadena')
ok(tiersFor({ tiers: null }).length === 0, 'null → sin niveles')
ok(tiersFor({}).length === 0, 'clave ausente (base sin migrar) → sin niveles')
ok(tiersFor({ tiers: [TIERS[0]] }).length === 0, 'un solo nivel → sin niveles')

console.log('tierPrice')
ok(tierPrice(P1(1), 0) === 100 && tierPrice(P1(1), 1) === 90 && tierPrice(P1(1), 2) === 80, 'precio por nivel')
ok(tierPrice(P3(1), 2) === 50, 'sin precio en el nivel → hereda hacia abajo')
ok(tierPrice(OLD(1), 2) === 100, 'sin tier_prices → price en todos los niveles')
ok(tierPrice({ price: null, qty: 1 }, 1) === null, 'sin precio → null')

console.log('cartPricing — sin niveles')
let r = cartPricing([P1(10)], [])
ok(r.index === 0 && r.tier === null && r.total === 1000 && r.savings === 0 && r.next === null, 'suma de siempre')
ok(r.priceOf(P1(1)) === 100, 'priceOf = price')

console.log('cartPricing — D1: 10×P1 = 1000, se queda')
r = cartPricing([P1(10)], TIERS)
ok(r.index === 0 && r.total === 1000 && r.baseTotal === 1000 && r.savings === 0, 'total 1000, sin ahorro')
ok(r.next?.code === 'us_wholesale' && r.next.missing === 1000 && r.next.progress === 0.5, 'faltan 1000 para wholesale (50%)')

console.log('cartPricing — D2: 20×P1 = 2000 → wholesale 1800')
r = cartPricing([P1(20)], TIERS)
ok(r.index === 1 && r.tier.code === 'us_wholesale', 'nivel wholesale (borde inclusivo)')
ok(r.total === 1800 && r.baseTotal === 2000 && r.savings === 200, 'total 1800, ahorro 200')
ok(r.next?.code === 'special' && r.next.missing === 13200, 'siguiente special, faltan 13200')
ok(r.priceOf(P1(1)) === 90, 'priceOf = precio wholesale')

console.log('cartPricing — D3: 19×P1 + 1×P3 = 1950, se queda')
r = cartPricing([P1(19), P3(1)], TIERS)
ok(r.index === 0 && r.total === 1950, '1950 < 2000')

console.log('cartPricing — D4: 20×P1 + 2×P3 = 2100 → wholesale, P3 hereda')
r = cartPricing([P1(20), P3(2)], TIERS)
ok(r.index === 1 && r.total === 1900 && r.savings === 200, '1800 + 100 heredado = 1900')
ok(r.priceOf(P3(1)) === 50, 'P3 sigue a 50')

console.log('cartPricing — D5: 200×P1 = 20000 → wholesale 18000 → special 16000')
r = cartPricing([P1(200)], TIERS)
ok(r.index === 2 && r.tier.code === 'special' && r.total === 16000 && r.savings === 4000, 'special, ahorro 4000')
ok(r.next === null, 'sin siguiente')

console.log('cartPricing — D6: 160×P1 = 16000 → wholesale 14400 < 15000, escalonado')
r = cartPricing([P1(160)], TIERS)
ok(r.index === 1 && r.total === 14400 && r.next.missing === 600, 'wholesale, faltan 600')

console.log('cartPricing — carrito viejo sin tier_prices')
r = cartPricing([OLD(20)], TIERS)
ok(r.index === 1 && r.total === 2000 && r.savings === 0, 'sube de nivel pero sin precio nuevo conocido: mismo total, ahorro 0')

console.log('cartPricing — mezcla con ítem sin precio')
r = cartPricing([P1(20), { id: 'np', price: null, qty: 5 }], TIERS)
ok(r.index === 1 && r.total === 1800, 'el ítem sin precio no suma ni bloquea')
ok(r.priceOf({ price: null }) === null, 'priceOf null')

console.log('cartPricing — redondeo')
r = cartPricing([{ id: 'x', price: 0.1, tier_prices: [0.1, 0.07], qty: 3 }], [TIERS[0], { ...TIERS[1], threshold: 0.3 }])
ok(r.index === 1 && r.total === 0.21 && r.baseTotal === 0.3 && r.savings === 0.09, 'dos decimales sin basura binaria')

console.log(`\n${passed} ok, ${failed} fallos`)
process.exit(failed ? 1 : 0)
