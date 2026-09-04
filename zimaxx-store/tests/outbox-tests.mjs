// Tests del outbox de pedidos (orderOutbox.js) en Node, sin navegador.
// Correr con `node tests/outbox-tests.mjs`.
//
// El módulo usa import.meta.env (Vite), localStorage/sessionStorage y fetch:
// acá se copia el fuente a un directorio temporal reemplazando import.meta.env
// por un global, y se stubean storage/fetch/Date.now — el CÓDIGO bajo prueba
// es el real, byte a byte salvo ese reemplazo. Vive en el repo desde
// 2026-09-02 (mismo criterio que sc-push-tests.mjs: las suites del scratchpad
// se perdían con cada sesión).
//
// Foco (2026-09-02, "outbox sin pérdidas silenciosas"):
//   * expiración diferenciada: quote 72 h, order 24 h
//   * expirar = ENTREGAR a order_failures vía report_outbox_expired, no borrar
//   * sin red el pendiente se queda; solo un reporte exitoso lo saca
//   * doble expiración no duplica el reporte
//   * "Reintentar ahora" (manual) se salta el tope de reintentos automáticos
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

// ---------- stubs de entorno (ANTES de importar el módulo) ----------
globalThis.__TEST_ENV = {
  VITE_SUPABASE_URL: 'http://sb.test',
  VITE_SUPABASE_ANON_KEY: 'anon-test',
}

function makeStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  }
}
globalThis.localStorage = makeStorage()
globalThis.sessionStorage = makeStorage()

// fetch programable: net.calls acumula {path, body}; net.reply decide por path.
const net = {
  calls: [],
  reply: {}, // path → () => ({ok, json}) | 'network-error'
}
globalThis.fetch = async (fullUrl, opts = {}) => {
  const path = String(fullUrl).replace('http://sb.test', '')
  const body = opts.body ? JSON.parse(opts.body) : null
  net.calls.push({ path, body })
  const handler = net.reply[path]
  if (!handler) throw new Error(`sin mock para ${path}`)
  const r = handler(body)
  if (r === 'network-error') throw new TypeError('failed to fetch (simulado)')
  return { ok: r.ok, status: r.ok ? 200 : (r.status ?? 500), json: async () => r.json }
}
const callsTo = (path) => net.calls.filter((c) => c.path === path)
const resetNet = () => {
  net.calls = []
}

// Reloj controlado: el outbox decide expiración con Date.now().
const T0 = 1_756_800_000_000
let fakeNow = T0
const realNow = Date.now
Date.now = () => fakeNow
const HOUR = 60 * 60 * 1000

// ---------- cargar el módulo real con import.meta.env reemplazado ----------
const dir = await mkdtemp(join(tmpdir(), 'outbox-test-'))
for (const name of ['orderOutbox.js', 'systemLog.js']) {
  const src = await readFile(new URL(`../src/utils/${name}`, import.meta.url), 'utf8')
  await writeFile(
    join(dir, name),
    src
      .replaceAll('import.meta.env', 'globalThis.__TEST_ENV')
      // Vite resuelve el import sin extensión; el ESM de Node no.
      .replaceAll("from './systemLog'", "from './systemLog.js'"),
  )
}
const outbox = await import(pathToFileURL(join(dir, 'orderOutbox.js')).href)
const { savePending, loadPending, flushPending, markFailed, outboxStatus, clearPending } = outbox

const TOKEN = 'tok-cliente-uno-xyz'
const ITEMS = [
  { id: 'p1', sku: 'SKU-1', name: 'Producto Uno', qty: 2, price: 10, flash: false },
  { id: 'p2', sku: 'SKU-2', name: 'Producto Dos', qty: 1, price: 20, flash: false },
]
const CREATE = '/rest/v1/rpc/create_order'
const REPORT = '/rest/v1/rpc/report_outbox_expired'
const LOG = '/rest/v1/rpc/log_event'
// logEvent es fire-and-forget (no espera la respuesta): darle un turno al
// event loop antes de contar sus llamadas.
const settle = () => new Promise((r) => setTimeout(r, 20))

const freshPending = (kind, ageMs, extra = {}) => {
  localStorage.clear()
  sessionStorage.clear()
  fakeNow = T0
  savePending({ requestId: 'req-1', token: TOKEN, items: ITEMS, total: 40, kind })
  const p = JSON.parse(localStorage.getItem('zimaxx_pending_order'))
  localStorage.setItem('zimaxx_pending_order', JSON.stringify({ ...p, ...extra }))
  fakeNow = T0 + ageMs
}

net.reply[LOG] = () => ({ ok: true, json: null })

// ---------- 1) lo guardado viaja slim, pero se guarda completo ----------
{
  resetNet()
  freshPending('order', 0)
  const p = loadPending()
  ok(
    p.items[0].sku === 'SKU-1' && p.items[0].price === 10 && p.items[0].name === 'Producto Uno',
    'el pendiente guarda el payload completo (sku/nombre/precio) para el forense',
  )
  net.reply[CREATE] = () => ({ ok: true, json: 'uuid-nuevo' })
  const res = await flushPending(TOKEN)
  const call = callsTo(CREATE)[0]
  ok(res === 'ok' && call, 'flush fresco registra contra create_order')
  ok(
    JSON.stringify(Object.keys(call.body.p_items[0]).sort()) === '["flash","id","qty"]',
    'el POST a create_order viaja slim (solo id/qty/flash)',
  )
  ok(loadPending() === null, 'registrado → el pendiente se borra')
}

// ---------- 2) expiración diferenciada por tipo ----------
{
  // quote a 25 h: NO expira — sigue intentando registrarse.
  resetNet()
  freshPending('quote', 25 * HOUR)
  net.reply[CREATE] = () => ({ ok: true, json: 'uuid-q' })
  await flushPending(TOKEN)
  ok(
    callsTo(CREATE).length === 1 && callsTo(REPORT).length === 0,
    'quote a las 25 h NO expira (sigue intentando registrarse)',
  )

  // order a 25 h: SÍ expira — se entrega, no se registra.
  resetNet()
  freshPending('order', 25 * HOUR)
  net.reply[REPORT] = () => ({ ok: true, json: { ok: true, failure_id: 'f1', already_reported: false } })
  await flushPending(TOKEN)
  ok(
    callsTo(REPORT).length === 1 && callsTo(CREATE).length === 0,
    'order a las 25 h expira: se entrega a order_failures, no se registra tarde',
  )

  // quote a 73 h: SÍ expira.
  resetNet()
  freshPending('quote', 73 * HOUR)
  await flushPending(TOKEN)
  ok(callsTo(REPORT).length === 1, 'quote a las 73 h sí expira')
}

// ---------- 3) expirar CON red: se reporta y solo entonces se borra ----------
{
  resetNet()
  freshPending('quote', 73 * HOUR)
  net.reply[REPORT] = (body) => {
    // El reporte lleva el payload completo y el request_id de siempre.
    ok(
      body.p_request_id === 'req-1' && body.p_kind === 'quote' && body.p_items.length === 2 &&
        body.p_items[0].sku === 'SKU-1',
      'el reporte viaja con request_id, kind y el payload completo',
    )
    return { ok: true, json: { ok: true, failure_id: 'f1', already_reported: false } }
  }
  await flushPending(TOKEN)
  await settle()
  ok(loadPending() === null, 'reporte exitoso → recién ahí se borra del teléfono')
  ok(sessionStorage.getItem('zimaxx_outbox_reported') === 'quote', 'queda la marca de sesión "reportado"')
  ok(outboxStatus()?.state === 'reported', 'el banner pasa a "reportado al equipo de ventas"')
  const log = callsTo(LOG).find((c) => c.body.p_severity === 'critical')
  ok(
    log && log.body.p_context.reason === 'expired' && log.body.p_context.delivered === true &&
      Array.isArray(log.body.p_context.items) && log.body.p_context.items[0].sku === 'SKU-1' &&
      log.body.p_context.total === 40,
    'el critical de siempre sigue, ahora con el payload completo como respaldo forense',
  )
}

// ---------- 4) expirar SIN red: el pendiente se queda ----------
{
  resetNet()
  freshPending('order', 25 * HOUR)
  net.reply[REPORT] = () => 'network-error'
  await flushPending(TOKEN)
  await settle()
  ok(loadPending() !== null, 'sin red el pendiente NO se borra: expirado = pendiente de entregar')
  ok(outboxStatus()?.state === 'pending', 'el banner sigue mostrando el pendiente')
  ok(
    callsTo(LOG).filter((c) => c.body.p_severity === 'critical').length === 0,
    'sin entregar no hay critical de expirado (se emite cuando el reporte se resuelve)',
  )

  // Vuelve la red: la PRÓXIMA visita entrega y limpia.
  resetNet()
  net.reply[REPORT] = () => ({ ok: true, json: { ok: true, failure_id: 'f2', already_reported: false } })
  await flushPending(TOKEN)
  ok(callsTo(REPORT).length === 1 && loadPending() === null, 'con red de vuelta, la entrega sale y limpia')

  // Doble expiración: ya no queda nada que reportar.
  resetNet()
  const again = await flushPending(TOKEN)
  ok(again === null && callsTo(REPORT).length === 0, 'doble expiración no duplica el reporte')
}

// ---------- 5) reporte rechazado (determinista): limpia sin prometer nada ----------
{
  resetNet()
  sessionStorage.clear()
  freshPending('order', 25 * HOUR)
  net.reply[REPORT] = () => ({ ok: true, json: { ok: false, reason: 'token inválido' } })
  await flushPending(TOKEN)
  await settle()
  ok(loadPending() === null, 'rechazo determinista → se limpia (reintentar daría lo mismo)')
  ok(sessionStorage.getItem('zimaxx_outbox_reported') === null, 'sin entrega real no se promete "reportado"')
  const log = callsTo(LOG).find((c) => c.body.p_severity === 'critical')
  ok(log && log.body.p_context.delivered === false, 'el critical forense queda con delivered:false')
}

// ---------- 6) banner: aparece desde el primer fallo; manual salta el tope ----------
{
  resetNet()
  freshPending('order', 1 * HOUR)
  ok(outboxStatus() === null, 'pendiente recién guardado (envío en curso): sin banner todavía')
  net.reply[CREATE] = () => 'network-error'
  const res = await flushPending(TOKEN)
  await settle()
  ok(res === 'error' && outboxStatus()?.state === 'pending', 'primer fallo → el banner ya se muestra')

  // Con los reintentos automáticos agotados, el flush normal ni intenta...
  freshPending('order', 1 * HOUR, { tries: 8, failed: true })
  resetNet()
  const auto = await flushPending(TOKEN)
  ok(auto === null && callsTo(CREATE).length === 0, 'con el tope agotado, el flush automático no insiste')

  // ...pero "Reintentar ahora" (manual) sí.
  resetNet()
  net.reply[CREATE] = () => ({ ok: true, json: 'uuid-manual' })
  const manual = await flushPending(TOKEN, { manual: true })
  ok(
    manual === 'ok' && callsTo(CREATE).length === 1 && loadPending() === null,
    'el reintento manual se salta el tope y registra',
  )
}

// ---------- 7) compat: un pendiente viejo (shape slim, sin failed) expira igual ----------
{
  resetNet()
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem(
    'zimaxx_pending_order',
    JSON.stringify({
      requestId: 'req-viejo',
      tokenHint: TOKEN.slice(0, 8),
      items: [{ id: 'p1', qty: 2, flash: false }],
      total: 40,
      kind: 'order',
      ts: T0,
      tries: 3,
    }),
  )
  fakeNow = T0 + 25 * HOUR
  net.reply[REPORT] = (body) => {
    ok(body.p_items[0].id === 'p1' && body.p_items[0].sku === undefined, 'el shape slim viejo viaja tal cual')
    return { ok: true, json: { ok: true, failure_id: 'f3', already_reported: false } }
  }
  await flushPending(TOKEN)
  ok(loadPending() === null && callsTo(REPORT).length === 1, 'los pendientes guardados antes del cambio expiran y se entregan igual')
}

Date.now = realNow
console.log(`\n${passed}/${passed + failed} OK${failed ? ` — ${failed} FALLARON` : ''}`)
process.exit(failed ? 1 : 0)
