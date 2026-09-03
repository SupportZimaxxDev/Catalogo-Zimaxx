// Tests de la parte de CUSTOMERS de sellercloud.ts (búsqueda, listado
// paginado, alta y teléfono en segundo paso) contra un servidor falso —
// mismo patrón que sc-push-tests.mjs (sellercloud.ts no importa nada de
// Deno, así que corre en Node 23+ tal cual). `node tests/sc-customers-tests.mjs`.
//
// El contrato que simula el servidor falso es el REAL confirmado contra el
// Swagger del servidor (2026-09-02):
//   * GET /rest/api/Customers → { Items: CustomerDto[], TotalResults } con
//     UserID/FirstName/LastName/Email/CorporateName (SIN teléfono).
//   * POST /rest/api/Customers → CreateCustomerRequest (FirstName es lo único
//     requerido por la API) y devuelve el ID nuevo como entero pelado.
//   * PUT /rest/api/Customers/{id} → UpdateCustomerRequest (Phone1).
import { createServer } from 'node:http'

const mod = await import(
  new URL('../supabase/functions/sellercloud-push-order/sellercloud.ts', import.meta.url).href
)
const {
  createCustomer,
  customerSummary,
  getToken,
  listAllCustomers,
  resetTokenCache,
  searchCustomers,
  setCustomerPhone,
} = mod

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

// ---- servidor falso -------------------------------------------------------
const state = {
  requests: [], // { method, path, query, body }
  customers: [], // universo simulado para el GET
  createdId: 501, // lo que devuelve el POST
  createReturnsObject: false, // el POST contesta {Id: n} en vez del int pelado
  failPut: false,
  htmlOnSearch: false, // el GET contesta una página web (base URL mal cargada)
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    const body = raw ? JSON.parse(raw) : null
    state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body })

    if (url.pathname === '/rest/api/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ access_token: 'tok-falso' }))
    }
    if (url.pathname === '/rest/api/Customers' && req.method === 'GET') {
      if (state.htmlOnSearch) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end('<!doctype html><html><body>portal</body></html>')
      }
      // Filtros como el servidor real: email exacto (case-insensible),
      // phoneNumber contra el campo phone del universo, y paginación.
      let items = state.customers
      const email = url.searchParams.get('model.email')
      const phone = url.searchParams.get('model.phoneNumber')
      const keyword = url.searchParams.get('model.keyword')
      if (email) items = items.filter((c) => (c.Email ?? '').toLowerCase() === email.toLowerCase())
      if (phone) items = items.filter((c) => (c.__phone ?? '').includes(phone))
      if (keyword) {
        const k = keyword.toLowerCase()
        items = items.filter((c) =>
          `${c.FirstName} ${c.LastName} ${c.CorporateName ?? ''}`.toLowerCase().includes(k),
        )
      }
      const requested = Number(url.searchParams.get('model.pageSize') ?? 50)
      // clampPageSize simula el server real, que sirve máx. 50 por página
      // aunque se pidan 500; stuckPage simula un server que repite siempre la
      // primera página (TotalResults mentiroso).
      const size = Math.min(requested, state.clampPageSize ?? requested)
      const page = state.stuckPage ? 1 : Number(url.searchParams.get('model.pageNumber') ?? 1)
      const slice = items.slice((page - 1) * size, page * size)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(
        JSON.stringify({
          Items: slice.map(({ __phone, ...c }) => c),
          TotalResults: items.length,
        }),
      )
    }
    if (url.pathname === '/rest/api/Customers/' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(
        state.createReturnsObject ? JSON.stringify({ Id: state.createdId }) : String(state.createdId),
      )
    }
    if (/^\/rest\/api\/Customers\/\d+$/.test(url.pathname) && req.method === 'PUT') {
      if (state.failPut) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ Message: 'boom' }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end('true')
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ Message: 'not found' }))
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const cfg = {
  baseUrl: `http://127.0.0.1:${server.address().port}`,
  username: 'u',
  password: 'p',
  companyId: 8,
  warehouseId: null,
}
resetTokenCache()
const token = await getToken(cfg)
const lastReq = () => state.requests[state.requests.length - 1]
const dto = (id, over = {}) => ({
  UserID: id,
  FirstName: `Nombre${id}`,
  LastName: `Apellido${id}`,
  Email: `c${id}@x.com`,
  CorporateName: null,
  ...over,
})

console.log('customerSummary (mapeo del DTO real)')
{
  const c = customerSummary({ UserID: 7, FirstName: ' Ana ', LastName: 'Paz', Email: 'A@X.com', CorporateName: 'ACME' })
  ok(c.id === 7 && c.firstName === 'Ana' && c.lastName === 'Paz', 'UserID/First/Last mapeados y trimmeados')
  ok(c.email === 'a@x.com' && c.business === 'ACME' && c.phone === null, 'email en minúsculas; sin teléfono en el listado')
  ok(customerSummary({ FirstName: 'sin id' }) === null, 'fila sin ID utilizable se descarta')
}

console.log('searchCustomers: filtros y shape')
{
  state.customers = [dto(1), dto(2, { Email: 'b@x.com', __phone: '17865550002' })]
  const r = await searchCustomers(cfg, token, { email: 'B@x.com ' })
  const q = lastReq().query
  ok(q.get('model.email') === 'B@x.com' && q.get('model.companyIds') === '8', 'viaja model.email + companyIds')
  ok(q.get('model.pageNumber') === '1' && q.get('model.pageSize') === '50', 'paginación con defaults')
  ok(r.items.length === 1 && r.items[0].id === 2 && r.total === 1, 'parsea Items/TotalResults')

  await searchCustomers(cfg, token, { phone: '7865550002' })
  ok(lastReq().query.get('model.phoneNumber') === '7865550002', 'teléfono viaja como model.phoneNumber')

  await searchCustomers(cfg, token, { keyword: 'Nombre1' })
  ok(lastReq().query.get('model.keyword') === 'Nombre1', 'nombre viaja como model.keyword')
}

console.log('listAllCustomers: paginación completa')
{
  state.customers = Array.from({ length: 1203 }, (_, i) => dto(i + 1))
  state.requests = []
  const all = await listAllCustomers(cfg)
  ok(all.length === 1203, 'baja los 1203 (3 páginas de 500)')
  const pages = state.requests.filter((r) => r.path === '/rest/api/Customers')
  ok(pages.length === 3 && pages[2].query.get('model.pageNumber') === '3', 'pidió exactamente 3 páginas')
  ok(new Set(all.map((c) => c.id)).size === 1203, 'sin duplicados')

  // El caso REAL (2026-09-03): el servidor clampea el pageSize — se piden 500
  // y sirve 50. Antes esto cortaba en la página 1 con 50 bajados.
  state.clampPageSize = 50
  state.requests = []
  const clamped = await listAllCustomers(cfg)
  ok(clamped.length === 1203, 'con pageSize clampeado a 50 igual baja TODO (25 páginas)')
  ok(
    state.requests.filter((r) => r.path === '/rest/api/Customers').length === 25,
    'pidió las 25 páginas que el clamp obliga',
  )
  state.clampPageSize = null

  // Servidor que repite la última página para siempre (TotalResults
  // mentiroso): el corte por falta de progreso evita el loop infinito.
  state.stuckPage = true
  state.requests = []
  const stuck = await listAllCustomers(cfg)
  ok(stuck.length === 500, 'página repetida: corta por falta de progreso, sin loop infinito')
  state.stuckPage = false
}

console.log('createCustomer: payload y respuesta')
{
  state.requests = []
  state.createdId = 777
  const id = await createCustomer(cfg, token, {
    firstName: 'María',
    lastName: 'Pérez',
    email: 'mp@x.com',
  })
  const req = state.requests.find((r) => r.method === 'POST' && r.path === '/rest/api/Customers/')
  ok(id === 777, 'devuelve el ID entero pelado')
  ok(
    req.body.FirstName === 'María' && req.body.LastName === 'Pérez',
    'First/Last Name viajan partidos (SellerCloud valida Last Name en las órdenes)',
  )
  // CustomerType 1 = Wholesale en ESTA instancia (2026-09-03, confirmado por
  // el usuario; el Swagger se contradice entre el create y el filtro del GET).
  ok(req.body.CompanyID === 8 && req.body.CustomerType === 1, 'CompanyID + CustomerType 1 (Wholesale)')
  ok(req.body.Email === 'mp@x.com' && !('Phone' in req.body) && !('Phone1' in req.body),
    'email viaja; el teléfono NO (el create no lo acepta)')

  // Sin email: el campo no viaja (la API solo exige FirstName).
  state.requests = []
  await createCustomer(cfg, token, { firstName: 'Solo', lastName: 'Nombre' })
  ok(!('Email' in state.requests.find((r) => r.method === 'POST').body), 'sin email el campo no viaja')

  // La respuesta como objeto {Id} también se entiende.
  state.createReturnsObject = true
  state.createdId = 888
  ok((await createCustomer(cfg, token, { firstName: 'A', lastName: 'B' })) === 888, 'ID envuelto en objeto también parsea')
  state.createReturnsObject = false

  // Apellido obligatorio ACÁ aunque la API no lo exija.
  let threw = null
  state.requests = []
  try {
    await createCustomer(cfg, token, { firstName: 'Sin', lastName: '' })
  } catch (e) {
    threw = e.message
  }
  ok(/nombre Y apellido/.test(threw ?? ''), 'sin apellido corta ANTES de llamar a la API')
  ok(state.requests.length === 0, 'y no viajó ningún request')
}

console.log('setCustomerPhone: segundo paso')
{
  state.requests = []
  await setCustomerPhone(cfg, token, 777, '7865550001')
  const req = lastReq()
  ok(
    req.method === 'PUT' && req.path === '/rest/api/Customers/777' && req.body.Phone1 === '7865550001',
    'PUT /Customers/{id} con Phone1 (único campo)',
  )
  ok(Object.keys(req.body).length === 1, 'no toca ningún otro campo del customer')

  state.failPut = true
  let threw = null
  try {
    await setCustomerPhone(cfg, token, 777, '123')
  } catch (e) {
    threw = e.message
  }
  ok(/teléfono del cliente 777/.test(threw ?? ''), 'un PUT fallido lanza con contexto (el caller degrada a warning)')
  state.failPut = false
}

console.log('errores endurecidos')
{
  state.htmlOnSearch = true
  let threw = null
  try {
    await searchCustomers(cfg, token, { email: 'x@x.com' })
  } catch (e) {
    threw = e.message
  }
  ok(/página web, no la API/.test(threw ?? ''), 'una respuesta HTML dice qué secret revisar (patrón del push)')
  state.htmlOnSearch = false
}

server.close()
console.log(`\n${passed}/${passed + failed} OK${failed ? ` — ${failed} FALLARON` : ''}`)
process.exit(failed ? 1 : 0)
