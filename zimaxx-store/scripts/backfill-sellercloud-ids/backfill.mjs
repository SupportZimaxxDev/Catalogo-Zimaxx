#!/usr/bin/env node
// Backfill de clients.sellercloud_id (2026-09-02). Correr UNA vez, LOCAL —
// nunca en producción ni en la app. Ver README.md de esta carpeta para los
// comandos y las variables de entorno.
//
// Flujo:
//   1. Baja TODOS los customers de SellerCloud (GET /rest/api/Customers,
//      paginado con model.pageNumber/pageSize; respuesta {Items, TotalResults},
//      confirmado contra el Swagger del servidor) y todos los clients de
//      Supabase con sellercloud_id null.
//   2. Matching por confianza descendente (ver matching.mjs). Como el DTO del
//      LISTADO de SellerCloud no trae teléfono, después de la primera pasada
//      se busca server-side (model.phoneNumber) el teléfono de cada cliente
//      todavía sin resolver, se enriquece el universo con esos hits y se
//      re-corre el matching completo.
//   3. --dry-run (default): escribe matches.csv / ambiguous.csv /
//      unmatched.csv y un resumen. NO escribe en la base.
//      --apply: aplica SOLO los matches automáticos, idempotente (el UPDATE
//      lleva `sellercloud_id=is.null`: un cliente que ya tenga ID no se pisa
//      jamás, ni corriendo el script dos veces).
//      --apply-file resolved.csv: aplica los ambiguos resueltos a mano.
//
// Node 23+ (importa el sellercloud.ts real de la Edge Function, con el mismo
// type-stripping que ya usa tests/sc-push-tests.mjs — cero lógica duplicada
// de auth/paginación/errores).

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getCustomer,
  getToken,
  listAllCustomers,
  normalizeBaseUrl,
  resetTokenCache,
  searchCustomers,
} from '../../supabase/functions/sellercloud-push-order/sellercloud.ts'
import { matchClients, customerDisplayName, nameSimilarity, normalizePhone } from './matching.mjs'

// ---------- args ----------
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const APPLY_FILE = args.includes('--apply-file') ? args[args.indexOf('--apply-file') + 1] : null
const OUT_DIR = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(process.cwd(), 'out')

// ---------- env ----------
function env(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Falta la variable de entorno ${name} (ver README.md)`)
    process.exit(1)
  }
  return v
}
const SB_URL = env('SUPABASE_URL').replace(/\/+$/, '')
const SB_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const cfg = {
  baseUrl: normalizeBaseUrl(env('SELLERCLOUD_BASE_URL')),
  username: env('SELLERCLOUD_USERNAME'),
  password: env('SELLERCLOUD_PASSWORD'),
  companyId: Number(env('SELLERCLOUD_COMPANY_ID')),
  warehouseId: null,
}
if (!Number.isFinite(cfg.companyId)) {
  console.error('SELLERCLOUD_COMPANY_ID tiene que ser un número')
  process.exit(1)
}

// ---------- fetch con reintentos ----------
// Envuelve el fetch que se le pasa a sellercloud.ts y a PostgREST: reintenta
// rate limits (429), 5xx y fallos de red con backoff exponencial. Un 4xx
// distinto de 429 NO se reintenta: es un error de datos, repetirlo da igual.
const MAX_TRIES = 6
async function fetchRetry(url, opts = {}) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await fetch(url, opts)
      if (res.status !== 429 && res.status < 500) return res
      lastErr = new Error(`HTTP ${res.status} en ${url}`)
    } catch (e) {
      lastErr = e
    }
    if (attempt < MAX_TRIES) {
      const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300)
      console.warn(`  reintento ${attempt}/${MAX_TRIES - 1} en ${Math.round(wait / 1000)}s — ${lastErr.message}`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr
}

// ---------- Supabase REST (service_role, sin dependencias) ----------
const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
}

async function sbSelectAll(pathAndQuery) {
  const PAGE = 1000
  const all = []
  for (let from = 0; ; from += PAGE) {
    const res = await fetchRetry(`${SB_URL}/rest/v1/${pathAndQuery}`, {
      headers: { ...sbHeaders, Range: `${from}-${from + PAGE - 1}` },
    })
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const page = await res.json()
    all.push(...page)
    if (page.length < PAGE) return all
  }
}

// ---------- CSV ----------
const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}
async function writeCsv(file, header, rows) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
  await writeFile(file, body + '\n', 'utf8')
  console.log(`  ${file} (${rows.length} filas)`)
}

// Parser mínimo para resolved.csv: soporta comillas dobles y comas adentro.
// Las dos columnas que importan (client_id, sellercloud_id) nunca las llevan.
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') inQuotes = false
      else cell += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c !== '')) rows.push(row)
  return rows
}

// ---------- aplicar un vínculo (idempotente) ----------
// El filtro `sellercloud_id=is.null` viaja en el UPDATE: si el cliente ya
// tiene ID (lo puso una corrida anterior, el sync de n8n o alguien a mano),
// el update afecta 0 filas y se reporta como "ya tenía" — nunca se pisa.
async function applyOne(clientId, sellercloudId) {
  const res = await fetchRetry(
    `${SB_URL}/rest/v1/clients?id=eq.${clientId}&sellercloud_id=is.null`,
    {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({ sellercloud_id: Number(sellercloudId) }),
    },
  )
  const text = await res.text()
  if (!res.ok) {
    // 409 = ese sellercloud_id ya lo tiene OTRO cliente (índice único).
    return { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` }
  }
  const rows = JSON.parse(text || '[]')
  return rows.length === 0 ? { ok: false, reason: 'ya tenía sellercloud_id (no se pisa)' } : { ok: true }
}

async function applyPairs(pairs, label) {
  let ok = 0
  const failed = []
  for (const p of pairs) {
    const r = await applyOne(p.clientId, p.sellercloudId)
    if (r.ok) ok++
    else failed.push({ ...p, reason: r.reason })
  }
  console.log(`\n${label}: ${ok}/${pairs.length} aplicados`)
  if (failed.length) {
    console.log('NO aplicados (exactamente estos):')
    for (const f of failed) {
      console.log(`  ${f.clientId} → ${f.sellercloudId}: ${f.reason}`)
    }
  }
  return failed.length
}

// ============================================================
// main
// ============================================================

// --apply-file: no descarga nada — aplica el CSV resuelto a mano y termina.
if (APPLY_FILE) {
  const text = await readFile(APPLY_FILE, 'utf8')
  const rows = parseCsv(text)
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const iClient = header.indexOf('client_id')
  const iSc = header.indexOf('sellercloud_id')
  if (iClient < 0 || iSc < 0) {
    console.error(`${APPLY_FILE} necesita columnas client_id y sellercloud_id (deja el resto igual)`)
    process.exit(1)
  }
  const pairs = rows
    .slice(1)
    .map((r) => ({ clientId: r[iClient]?.trim(), sellercloudId: Number(r[iSc]) }))
    .filter((p) => p.clientId && Number.isFinite(p.sellercloudId) && p.sellercloudId > 0)
  console.log(`Aplicando ${pairs.length} vínculos resueltos a mano de ${APPLY_FILE}…`)
  const failures = await applyPairs(pairs, 'apply-file')
  process.exit(failures ? 1 : 0)
}

console.log(`Modo: ${APPLY ? 'APPLY (escribe en la base)' : 'dry-run (solo CSVs)'}\n`)

// 1) Ambos universos.
console.log('Bajando clients de Supabase (sellercloud_id vacío)…')
const clients = await sbSelectAll(
  'clients?select=id,name,phone,email,allow_shared_phone,sellercloud_id&sellercloud_id=is.null&order=name',
)
console.log(`  ${clients.length} clientes sin vincular`)

console.log('Bajando customers de SellerCloud (paginado)…')
let customers = await listAllCustomers(cfg, fetchRetry, (page, got, total) =>
  console.log(`  página ${page}: ${got}/${total}`),
)
console.log(`  ${customers.length} customers allá`)

// 2) Primera pasada (email + nombre; el listado no trae teléfonos).
let result = matchClients(clients, customers)

// Enriquecer teléfonos: para cada cliente aún sin resolver, búsqueda
// server-side por teléfono (número completo y, si no aparece, últimos 10).
const pendientes = [...result.ambiguous.map((a) => a.client), ...result.unmatched.map((u) => u.client)]
const conTelefono = pendientes.filter((c) => normalizePhone(c.phone))
console.log(`\nBuscando por teléfono en SellerCloud a los ${conTelefono.length} sin resolver…`)
const byId = new Map(customers.map((c) => [c.id, c]))
// OJO (aprendido contra la API real, 2026-09-03): el filtro model.phoneNumber
// matchea por SUBSTRING — buscar "58424411" devuelve a cualquiera cuyo número
// lo contenga — y los teléfonos allá traen ruido (dígitos de más/de menos).
// Un hit del servidor NO es un match: es un CANDIDATO. Se lee el detalle del
// customer para conocer su teléfono REAL; solo si ese teléfono coincide por
// sufijo con el del cliente la llave de teléfono puede matchear en
// matchClients — si no coincide, el hit va a revisión humana (hitsByClient),
// nunca a match automático. La primera corrida sin esta verificación asignó
// 2 de 4 teléfonos MAL (clientes vinculados al customer equivocado).
const hitsByClient = new Map() // client.id → CustomerSummary[] (candidatos aproximados)
let telHits = 0
let telFails = 0
let done = 0
for (const c of conTelefono) {
  const full = String(c.phone ?? '').replace(/\D/g, '')
  // Token POR ITERACIÓN: getToken cachea y se renueva solo a los 55 min —
  // este loop puede durar más que los 60 min del token (aprendido en la
  // corrida real: 401 a mitad del camino). Y un teléfono que falla no tumba
  // la corrida: se anota y se sigue (con un reintento tras limpiar el token,
  // por si el 401 fue justo en el borde de la renovación).
  try {
    let token = await getToken(cfg, Date.now, fetchRetry)
    let items
    try {
      items = (await searchCustomers(cfg, token, { phone: full }, fetchRetry)).items
    } catch {
      resetTokenCache()
      token = await getToken(cfg, Date.now, fetchRetry)
      items = (await searchCustomers(cfg, token, { phone: full }, fetchRetry)).items
    }
    if (items.length === 0 && full.length > 10) {
      items = (await searchCustomers(cfg, token, { phone: full.slice(-10) }, fetchRetry)).items
    }
    for (const hit of items.slice(0, 5)) {
      telHits++
      let known = byId.get(hit.id)
      if (!known) {
        known = { ...hit }
        byId.set(hit.id, known)
        customers.push(known)
      }
      // El teléfono REAL del customer sale de su detalle (el listado no lo
      // trae). Si el detalle falla, el hit queda solo como candidato a
      // revisión — jamás se le estampa el teléfono del cliente.
      if (!known.phone) {
        try {
          const d = await getCustomer(cfg, token, hit.id, fetchRetry)
          const real = String(d?.Personal?.Phone1 ?? d?.Personal?.Mobile ?? '').replace(/\D/g, '')
          if (real) known.phone = real
        } catch {
          /* sin detalle: candidato sin teléfono confirmado */
        }
      }
      if (!hitsByClient.has(c.id)) hitsByClient.set(c.id, [])
      hitsByClient.get(c.id).push(known)
    }
  } catch (e) {
    telFails++
    console.warn(`  teléfono ${full}: ${e.message} — se sigue con el resto`)
  }
  done++
  if (done % 200 === 0) console.log(`  ${done}/${conTelefono.length}…`)
}
console.log(`  ${telHits} candidatos por teléfono${telFails ? ` · ${telFails} búsquedas fallidas` : ''}`)

// Pasada final con el universo enriquecido (teléfonos REALES verificados).
result = matchClients(clients, customers)

// Un cliente sin match pero CON hits aproximados de teléfono (el substring
// del servidor encontró algo cuyo número real no coincide por sufijo): a
// revisión humana con esos candidatos, en vez de perderse en unmatched como
// si allá no hubiera nada parecido.
{
  const matched = new Set(result.matches.map((m) => m.client.id))
  const stillUnmatched = []
  for (const u of result.unmatched) {
    const hits = (hitsByClient.get(u.client.id) ?? []).filter((h) => !matched.has(h.id))
    if (hits.length > 0) {
      result.ambiguous.push({
        client: u.client,
        reason: 'coincidencia aproximada de teléfono (verificar número real)',
        candidates: hits
          .map((h) => ({ customer: h, score: nameSimilarity(u.client.name, customerDisplayName(h)) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3),
      })
    } else {
      stillUnmatched.push(u)
    }
  }
  result.unmatched = stillUnmatched
}

// 3) Salidas.
await mkdir(OUT_DIR, { recursive: true })
console.log(`\nCSVs en ${OUT_DIR}:`)
await writeCsv(
  join(OUT_DIR, 'matches.csv'),
  ['client_id', 'client_name', 'client_phone', 'client_email', 'sellercloud_id', 'sellercloud_name', 'matched_by'],
  result.matches.map((m) => [
    m.client.id,
    m.client.name,
    m.client.phone,
    m.client.email,
    m.customer.id,
    customerDisplayName(m.customer),
    m.key,
  ]),
)
await writeCsv(
  join(OUT_DIR, 'ambiguous.csv'),
  [
    'client_id', 'client_name', 'client_phone', 'client_email', 'reason',
    'sellercloud_id', // ← completar a mano con el elegido y pasar por --apply-file
    'candidate_1_id', 'candidate_1_name', 'candidate_1_score',
    'candidate_2_id', 'candidate_2_name', 'candidate_2_score',
    'candidate_3_id', 'candidate_3_name', 'candidate_3_score',
  ],
  result.ambiguous.map((a) => {
    const c = (i) => a.candidates[i]
    const cell = (i, f) => (c(i) ? f(c(i)) : '')
    return [
      a.client.id, a.client.name, a.client.phone, a.client.email, a.reason,
      '', // sellercloud_id vacío: lo decide el humano
      cell(0, (x) => x.customer.id), cell(0, (x) => customerDisplayName(x.customer)), cell(0, (x) => x.score.toFixed(2)),
      cell(1, (x) => x.customer.id), cell(1, (x) => customerDisplayName(x.customer)), cell(1, (x) => x.score.toFixed(2)),
      cell(2, (x) => x.customer.id), cell(2, (x) => customerDisplayName(x.customer)), cell(2, (x) => x.score.toFixed(2)),
    ]
  }),
)
await writeCsv(
  join(OUT_DIR, 'unmatched.csv'),
  ['client_id', 'client_name', 'client_phone', 'client_email'],
  result.unmatched.map((u) => [u.client.id, u.client.name, u.client.phone, u.client.email]),
)

console.log(
  `\nResumen: ${result.matches.length} automáticos · ${result.ambiguous.length} a revisión ` +
    `· ${result.unmatched.length} sin candidato (probablemente crear allá) · ${result.skipped} ya vinculados (intactos)`,
)
const porLlave = result.matches.reduce((acc, m) => ((acc[m.key] = (acc[m.key] ?? 0) + 1), acc), {})
console.log(`  automáticos por llave: ${JSON.stringify(porLlave)}`)

// 4) Aplicar (solo con --apply).
if (APPLY) {
  const failures = await applyPairs(
    result.matches.map((m) => ({ clientId: m.client.id, sellercloudId: m.customer.id })),
    'apply',
  )
  process.exit(failures ? 1 : 0)
} else {
  console.log('\nDry-run: nada se escribió. Revisá los CSVs y corré con --apply.')
}
