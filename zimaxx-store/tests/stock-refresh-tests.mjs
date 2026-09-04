// Tests del refresco de stock y del candado de frescura del push contra un
// servidor falso de SellerCloud y un stub de RPCs (patrón del proyecto:
// refresh.ts / freshness.ts / sellercloud.ts no importan nada de Deno, así
// que corren en Node). Correr con `node tests/stock-refresh-tests.mjs`
// (Node 23+ por el TypeScript).
//
// Foco: paginación completa con el pageSize de 50 documentado (y el corte por
// total / por página repetida, la lección del backfill de customers), que a
// la base viajan SOLO {sku, qty} por chunks, el lock de concurrencia (ZS002 →
// 409), la corrida colgada, el cierre en error cuando SellerCloud falla a
// mitad del loop, y las cuatro salidas del gate de frescura del push.
// Nota Windows: al final puede salir un "Assertion failed" de libuv DESPUÉS
// del "TODO OK" — es Node cerrando el servidor, no un test caído.
import { createServer } from 'node:http'

const refreshMod = await import(
  new URL('../supabase/functions/sellercloud-refresh-stock/refresh.ts', import.meta.url).href
)
const { runStockRefresh } = refreshMod

const freshnessMod = await import(
  new URL('../supabase/functions/sellercloud-push-order/freshness.ts', import.meta.url).href
)
const { freshnessGate } = freshnessMod

const scMod = await import(
  new URL('../supabase/functions/sellercloud-push-order/sellercloud.ts', import.meta.url).href
)
const { resetTokenCache, inventoryRow, INVENTORY_PAGE_SIZE } = scMod

// ---- servidor falso de SellerCloud -----------------------------------------
// Simula el contrato documentado del endpoint de inventario:
// GET /rest/api/Inventory?pageNumber=N&pageSize=50&companyID=172 →
// { Items, TotalResults }, con el clampeo REAL a 50 por página (documentado
// para Inventory; a Customers nos lo hizo en silencio el 2026-09-03).
const state = {
  requests: [],
  inventory: [], // [{ ID, InventoryAvailableQty }]
  failOnPage: 0, // página que responde 500 (0 = nunca)
  repeatLastPage: false, // el servidor repite la última página para siempre
  lyingTotal: null, // TotalResults mentiroso (null = el real)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  state.requests.push({ method: req.method, path: url.pathname, params: url.searchParams })
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }

  if (req.method === 'POST' && url.pathname === '/rest/api/token') {
    return json(200, { access_token: 'tok-1' })
  }
  if (req.method === 'GET' && url.pathname === '/rest/api/Inventory') {
    const page = Number(url.searchParams.get('pageNumber') || '1')
    if (state.failOnPage && page === state.failOnPage) {
      return json(500, { Message: 'boom interno de SellerCloud' })
    }
    // Clampeo real: sirve 50 aunque pidan más.
    const size = Math.min(Number(url.searchParams.get('pageSize') || '10'), 50)
    let start = (page - 1) * size
    if (state.repeatLastPage) {
      const lastPage = Math.max(1, Math.ceil(state.inventory.length / size))
      start = (Math.min(page, lastPage) - 1) * size
    }
    return json(200, {
      Items: state.inventory.slice(start, start + size),
      TotalResults: state.lyingTotal ?? state.inventory.length,
    })
  }
  json(404, { Message: `sin ruta para ${req.method} ${url.pathname}` })
})

await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const base = `http://127.0.0.1:${server.address().port}`
const cfg = { baseUrl: base, username: 'u', password: 'p', companyId: 172, warehouseId: null }

// ---- stub de RPCs -----------------------------------------------------------
// Emula las RPCs de la base con la misma semántica que la migración: begin
// con lock/colgadas, upsert que cuenta, finish que solo cierra running.
function makeRpcStub({ failBegin = null, failChunkAt = 0, failFinish = false } = {}) {
  const stub = {
    calls: [],
    runs: [], // { id, source, status, started_at, counters }
    products: new Map(), // sku(lower) -> { stock, active, deactivated_by_stock }
    chunks: 0,
    async rpc(name, args) {
      stub.calls.push({ name, args })
      if (name === 'inventory_sync_begin') {
        if (failBegin) return { data: null, error: failBegin }
        const running = stub.runs.find((r) => r.status === 'running')
        if (running) {
          return {
            data: null,
            error: { message: 'Ya hay una actualización de inventario en curso (empezó hace 1 min): esperá a que termine.', code: 'ZS002' },
          }
        }
        const run = { id: `run-${stub.runs.length + 1}`, source: args.p_source, status: 'running' }
        stub.runs.push(run)
        return { data: { ok: true, id: run.id, recovered_stale: 0 }, error: null }
      }
      if (name === 'refresh_stock_upsert') {
        stub.chunks++
        if (failChunkAt && stub.chunks === failChunkAt) {
          return { data: null, error: { message: 'permiso denegado (simulado)', code: '42501' } }
        }
        let updated = 0
        let unchanged = 0
        let unknown = 0
        let deactivated = 0
        let reactivated = 0
        for (const row of args.p_rows) {
          const p = stub.products.get(String(row.sku).toLowerCase())
          if (!p) {
            unknown++
            continue
          }
          const qty = Number(row.qty)
          if (p.stock === qty) {
            unchanged++
            continue
          }
          const wasActive = p.active
          const wasFlagged = p.deactivated_by_stock
          p.stock = qty
          // espejo del trigger products_availability_from_stock
          if (qty <= 0 && p.active) {
            p.active = false
            p.deactivated_by_stock = true
          } else if (qty >= 1 && p.deactivated_by_stock) {
            p.active = true
            p.deactivated_by_stock = false
          }
          updated++
          if (wasActive && !p.active) deactivated++
          if (wasFlagged && p.active) reactivated++
        }
        return {
          data: {
            updated,
            unchanged,
            deactivated,
            reactivated,
            unknown_skus: unknown,
            invalid_rows: 0,
            skipped_noncatalog: 0,
          },
          error: null,
        }
      }
      if (name === 'inventory_sync_finish') {
        if (failFinish) return { data: null, error: { message: 'red caída (simulado)' } }
        const run = stub.runs.find((r) => r.id === args.p_id)
        if (!run || run.status !== 'running') return { data: { ok: false }, error: null }
        run.status = args.p_status
        run.counters = {
          products_updated: args.p_products_updated,
          deactivated: args.p_deactivated_count,
          reactivated: args.p_reactivated_count,
        }
        run.error_message = args.p_error ?? null
        return { data: { ok: true, id: run.id, status: run.status }, error: null }
      }
      return { data: null, error: { message: `RPC desconocida: ${name}` } }
    },
  }
  return stub
}

// ---- helpers ----------------------------------------------------------------
let failures = 0
let checks = 0
function assert(cond, label) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${label}`)
  } else {
    console.log(`  ✓ ${label}`)
  }
}

function seedInventory(n, { qtyOf = (i) => i % 7 } = {}) {
  state.inventory = Array.from({ length: n }, (_, i) => ({
    ID: `SKU-${String(i + 1).padStart(4, '0')}`,
    ProductName: `Producto ${i + 1}`,
    InventoryAvailableQty: qtyOf(i),
  }))
}

function seedProducts(stub, n, { stockOf = () => 999 } = {}) {
  for (let i = 0; i < n; i++) {
    stub.products.set(`sku-${String(i + 1).padStart(4, '0')}`, {
      stock: stockOf(i),
      active: true,
      deactivated_by_stock: false,
    })
  }
}

function resetServer() {
  state.requests = []
  state.failOnPage = 0
  state.repeatLastPage = false
  state.lyingTotal = null
  resetTokenCache()
}

// ============================================================================
console.log('1) inventoryRow normaliza y descarta lo inservible')
{
  assert(
    JSON.stringify(inventoryRow({ ID: ' ABC-1 ', InventoryAvailableQty: 7.9 })) ===
      JSON.stringify({ sku: 'ABC-1', qty: 7 }),
    'ID+InventoryAvailableQty → {sku, qty} (trim y truncado a entero)',
  )
  assert(
    inventoryRow({ ID: 'ABC-1', InventoryAvailableQty: 0 })?.qty === 0,
    'qty 0 se conserva (0 = sin stock, no "sin dato")',
  )
  assert(inventoryRow({ InventoryAvailableQty: 5 }) === null, 'sin SKU → null (se omite)')
  assert(
    inventoryRow({ ID: 'ABC-2', InventoryAvailableQty: 'no-numérico' }) === null,
    'qty no numérico → null (nunca se inventa un 0, que despublicaría)',
  )
  assert(
    inventoryRow({ Sku: 'alt-key', AvailableQty: 3 })?.sku === 'alt-key',
    'variantes de capitalización de la respuesta real se aceptan',
  )
}

// ============================================================================
console.log('2) refresco completo: pagina todo, chunks a la base, cierre ok')
{
  resetServer()
  seedInventory(120) // 3 páginas de 50
  const stub = makeRpcStub()
  seedProducts(stub, 120)

  const out = await runStockRefresh(cfg, stub.rpc, fetch)
  assert(out.ok === true, 'la corrida termina ok')
  const invPages = state.requests.filter((r) => r.path === '/rest/api/Inventory')
  assert(invPages.length === 3, `pagina hasta agotar (3 páginas de 50, hubo ${invPages.length})`)
  assert(
    invPages.every((r) => r.params.get('pageSize') === String(INVENTORY_PAGE_SIZE)),
    'pide el pageSize máximo documentado (50)',
  )
  assert(
    invPages.every((r) => r.params.get('companyID') === '172'),
    'filtra por companyID en cada página',
  )
  assert(out.totals.sellercloud_items === 120, 'los 120 SKUs de SellerCloud contados')
  assert(out.totals.updated === 120, 'los 120 con stock distinto quedaron actualizados')
  const run = stub.runs[0]
  assert(run.status === 'ok', 'inventory_syncs quedó en ok')
  assert(run.counters.products_updated === 120, 'el finish llevó los contadores')
  const upserts = stub.calls.filter((c) => c.name === 'refresh_stock_upsert')
  assert(upserts.length === 1, 'un solo chunk (120 < 500)')
  assert(
    upserts.every((c) => c.args.p_rows.every((r) => 'sku' in r && 'qty' in r && Object.keys(r).length === 2)),
    'a la base viajan SOLO {sku, qty} — nunca precio ni nombre',
  )
}

// ============================================================================
console.log('3) chunks de 500 y contadores sumados entre chunks')
{
  resetServer()
  seedInventory(1100, { qtyOf: (i) => (i < 10 ? 0 : 5) }) // 22 páginas
  const stub = makeRpcStub()
  seedProducts(stub, 1100, { stockOf: () => 3 }) // todos cambian

  const out = await runStockRefresh(cfg, stub.rpc, fetch)
  assert(out.ok === true, 'la corrida termina ok')
  const upserts = stub.calls.filter((c) => c.name === 'refresh_stock_upsert')
  assert(upserts.length === 3, `3 chunks (500+500+100), hubo ${upserts.length}`)
  assert(out.totals.updated === 1100, 'updated suma entre chunks')
  assert(out.totals.deactivated === 10, 'los 10 que quedaron en 0 aparecen como desactivados')
}

// ============================================================================
console.log('4) SKUs de SellerCloud que no están en el catálogo: se ignoran')
{
  resetServer()
  seedInventory(60)
  const stub = makeRpcStub()
  seedProducts(stub, 40) // 20 SKUs de SellerCloud no existen acá

  const out = await runStockRefresh(cfg, stub.rpc, fetch)
  assert(out.ok === true, 'la corrida termina ok')
  assert(out.totals.unknown_skus === 20, 'los 20 desconocidos contados, sin tumbar nada')
  assert(out.totals.updated === 40, 'los 40 del catálogo actualizados')
}

// ============================================================================
console.log('5) lock de concurrencia: begin rechaza con ZS002 → 409, sin tocar la API')
{
  resetServer()
  seedInventory(10)
  const stub = makeRpcStub()
  stub.runs.push({ id: 'previa', source: 'manual_refresh', status: 'running' })

  const out = await runStockRefresh(cfg, stub.rpc, fetch)
  assert(out.ok === false && out.status === 409, 'rechaza con 409')
  assert(out.code === 'refresh_in_progress', 'code identificable para el panel')
  assert(/en curso/.test(out.error), 'mensaje claro ("ya hay una actualización en curso")')
  assert(
    state.requests.filter((r) => r.path === '/rest/api/Inventory').length === 0,
    'no gastó ni un request de SellerCloud',
  )
}

// ============================================================================
console.log('6) SellerCloud falla a mitad del loop: corrida cerrada en error, respuesta limpia')
{
  resetServer()
  seedInventory(120)
  state.failOnPage = 2
  const stub = makeRpcStub()
  seedProducts(stub, 120)

  const out = await runStockRefresh(cfg, stub.rpc, fetch)
  assert(out.ok === false && out.status === 502, 'responde 502 limpio')
  assert(/500/.test(out.error), 'el mensaje trae el status del paso que falló')
  const run = stub.runs[0]
  assert(run.status === 'error', 'inventory_syncs quedó en error (no cuenta como frescura)')
  assert(/500/.test(run.error_message), 'el motivo quedó en la corrida')
}

// ============================================================================
console.log('7) la base rechaza un chunk: corrida en error, sin seguir')
{
  resetServer()
  seedInventory(1100)
  const stub = makeRpcStub({ failChunkAt: 1 })
  seedProducts(stub, 1100, { stockOf: () => 3 })

  const out = await runStockRefresh(cfg, stub.rpc, fetch)
  assert(out.ok === false && out.status === 502, 'responde 502')
  assert(/chunk/.test(out.error), 'dice que fue un chunk contra la base')
  assert(stub.runs[0].status === 'error', 'corrida cerrada en error')
}

// ============================================================================
console.log('8) inventario vacío NO es una corrida buena')
{
  resetServer()
  seedInventory(0)
  const stub = makeRpcStub()

  const out = await runStockRefresh(cfg, stub.rpc, fetch)
  assert(out.ok === false, 'no marca ok')
  assert(stub.runs[0].status === 'error', 'corrida cerrada en error')
  assert(/vacío|ningún ítem/i.test(out.error), 'el mensaje dice que vino vacío')
}

// ============================================================================
console.log('9) TotalResults mentiroso / página repetida: corta sin loop infinito')
{
  resetServer()
  seedInventory(60)
  state.lyingTotal = 10_000
  state.repeatLastPage = true
  const stub = makeRpcStub()
  seedProducts(stub, 60)

  const out = await runStockRefresh(cfg, stub.rpc, fetch)
  assert(out.ok === true, 'termina igual')
  assert(out.totals.sellercloud_items === 60, 'los 60 reales, sin duplicar')
  const invPages = state.requests.filter((r) => r.path === '/rest/api/Inventory')
  assert(invPages.length <= 4, `cortó por página sin SKUs nuevos (${invPages.length} páginas)`)
}

// ============================================================================
console.log('10) el finish falla: se avisa que la frescura NO quedó registrada')
{
  resetServer()
  seedInventory(10)
  const stub = makeRpcStub({ failFinish: true })
  seedProducts(stub, 10)

  const out = await runStockRefresh(cfg, stub.rpc, fetch)
  assert(out.ok === false && out.status === 500, 'responde 500')
  assert(/frescura/i.test(out.error), 'el mensaje dice que la frescura no quedó registrada')
}

// ============================================================================
console.log('11) gate de frescura del push: fresco pasa, sin auditar')
{
  const calls = []
  const rpc = async (name) => {
    calls.push(name)
    if (name === 'get_inventory_freshness') {
      return { data: { is_stale: false, minutes_ago: 12, threshold_minutes: 45 }, error: null }
    }
    return { data: null, error: { message: 'no debería llamarse' } }
  }
  const gate = await freshnessGate(rpc, 'order-1', false)
  assert(gate.allow === true && gate.overrode === false && gate.warning === null, 'pasa limpio')
  assert(!calls.includes('audit_freshness_override'), 'no audita nada')
}

// ============================================================================
console.log('12) gate: vencido sin override → 409 identificable con la edad')
{
  const rpc = async (name) =>
    name === 'get_inventory_freshness'
      ? { data: { is_stale: true, minutes_ago: 87, threshold_minutes: 45 }, error: null }
      : { data: null, error: { message: 'no debería llamarse' } }
  const gate = await freshnessGate(rpc, 'order-1', false)
  assert(gate.allow === false && gate.status === 409, 'rechaza con 409')
  assert(gate.body.code === 'stale_inventory', 'code identificable')
  assert(/hace 87 min/.test(gate.body.error), 'la edad va en el mensaje')
  assert(gate.body.stale_minutes === 87, 'y también como campo propio')
}

// ============================================================================
console.log('13) gate: override de superadmin → pasa auditado')
{
  const audits = []
  const rpc = async (name, args) => {
    if (name === 'get_inventory_freshness') {
      return { data: { is_stale: true, minutes_ago: 87, threshold_minutes: 45 }, error: null }
    }
    if (name === 'audit_freshness_override') {
      audits.push(args)
      return { data: { ok: true }, error: null }
    }
    return { data: null, error: { message: '?' } }
  }
  const gate = await freshnessGate(rpc, 'order-1', true)
  assert(gate.allow === true && gate.overrode === true, 'pasa por el escape')
  assert(audits.length === 1 && audits[0].p_via === 'sellercloud_push', 'quedó auditado con la vía')
  assert(audits[0].p_order_id === 'order-1', 'y con el pedido')
  assert(/forzado por superadmin/.test(gate.warning.message), 'warning para system_logs')
}

// ============================================================================
console.log('14) gate: override de NO-superadmin → 403 (la RPC de auditoría rechaza)')
{
  const rpc = async (name) => {
    if (name === 'get_inventory_freshness') {
      return { data: { is_stale: true, minutes_ago: 87, threshold_minutes: 45 }, error: null }
    }
    if (name === 'audit_freshness_override') {
      return { data: null, error: { message: 'solo el superadmin puede saltear el candado de inventario' } }
    }
    return { data: null, error: { message: '?' } }
  }
  const gate = await freshnessGate(rpc, 'order-1', true)
  assert(gate.allow === false && gate.status === 403, 'rechaza con 403')
  assert(gate.body.code === 'override_forbidden', 'code identificable')
  assert(/solo el superadmin/.test(gate.body.error), 'el motivo de la base se muestra tal cual')
}

// ============================================================================
console.log('15) gate: RPC de frescura inexistente (migración sin correr) → pasa con warning')
{
  const rpc = async () => ({
    data: null,
    error: { message: 'function public.get_inventory_freshness() does not exist', code: '42883' },
  })
  const gate = await freshnessGate(rpc, 'order-1', false)
  assert(gate.allow === true && gate.overrode === false, 'no bloquea (comportamiento previo)')
  assert(gate.warning?.event === 'freshness_unavailable', 'pero avisa a system_logs')
}

// ============================================================================
server.close()
console.log('')
if (failures > 0) {
  console.error(`${failures} de ${checks} comprobaciones FALLARON`)
  process.exit(1)
}
console.log(`TODO OK — ${checks} comprobaciones`)
