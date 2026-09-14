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
//   * PUT /rest/api/Customers/{id} → UpdateCustomerRequest (Phone1, y desde
//     2026-09-09 la ficha: BusinessName / AccountManager1Id / Salesman /
//     Comments).
//   * POST /rest/api/Customers/CustomersGroups/{groupId}/Customers
//     {CustomersIDs: [..]} → agrega al grupo (2026-09-09).
import { createServer } from 'node:http'

const mod = await import(
  new URL('../supabase/functions/sellercloud-push-order/sellercloud.ts', import.meta.url).href
)
const {
  addCustomerToGroup,
  addressDto,
  addressMissing,
  createCustomer,
  customerAddressesBody,
  customerSummary,
  customerUpdateBody,
  findAddress,
  getToken,
  listAllCustomers,
  resetTokenCache,
  searchCustomers,
  setCustomerAddress,
  setCustomerPhone,
  updateCustomer,
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
  // Direcciones del customer (2026-09-14)
  addresses: [],
  nextAddressId: 9000,
  failAddressPut: false,
  addressPutIgnored: false,
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
    // Detalle del customer (CustomerDetailsDto real: General/Personal/... +
    // Addresses[]). La lista de direcciones vive en state.addresses.
    if (/^\/rest\/api\/Customers\/\d+$/.test(url.pathname) && req.method === 'GET') {
      const id = Number(url.pathname.split('/').pop())
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(
        JSON.stringify({
          General: { ID: id, FirstName: 'Nombre', LastName: 'Apellido', Email: `c${id}@x.com` },
          Personal: { Phone1: '3055550000' },
          Addresses: state.addresses.map((a) => ({ ...a })),
          NotesCount: 0,
        }),
      )
    }
    // PUT /Customers/{id}/Addresses (2026-09-14): reemplaza la lista; a las
    // direcciones nuevas (ID 0) les asigna un ID. failAddressPut simula el
    // rechazo; addressPutIgnored simula un server que contesta 200 pero no
    // guarda nada (la relectura tiene que pescarlo).
    if (/^\/rest\/api\/Customers\/\d+\/Addresses$/.test(url.pathname) && req.method === 'PUT') {
      if (state.failAddressPut) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ Message: 'ZipCode is required' }))
      }
      if (!state.addressPutIgnored) {
        state.addresses = (body?.Addresses ?? []).map((a) => ({
          ...a,
          ID: Number(a.ID) > 0 ? Number(a.ID) : ++state.nextAddressId,
        }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end('true')
    }
    if (/^\/rest\/api\/Customers\/CustomersGroups\/\d+\/Customers$/.test(url.pathname) && req.method === 'POST') {
      if (state.failGroup) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ Message: 'group not found' }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end('')
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

console.log('createCustomer: BusinessName (ficha, 2026-09-09)')
{
  state.requests = []
  await createCustomer(cfg, token, { firstName: 'A', lastName: 'B', business: '  ACME Perfumes ' })
  const req = state.requests.find((r) => r.method === 'POST' && r.path === '/rest/api/Customers/')
  ok(req.body.BusinessName === 'ACME Perfumes', 'BusinessName viaja trimmeado en el create')
  state.requests = []
  await createCustomer(cfg, token, { firstName: 'A', lastName: 'B', business: null })
  ok(!('BusinessName' in state.requests.find((r) => r.method === 'POST').body), 'sin empresa el campo no viaja')
}

console.log('customerUpdateBody: solo lo que tiene valor (UpdateCustomerRequest real)')
{
  const b = customerUpdateBody({
    phone: ' 7865550001 ',
    businessName: ' ACME ',
    accountManagerId: 75448,
    salesman: 'Adriana Montilla',
    comments: ' Mayorista ',
  })
  ok(
    b.Phone1 === '7865550001' && b.BusinessName === 'ACME' && b.AccountManager1Id === 75448 &&
      b.Salesman === 'Adriana Montilla' && b.Comments === 'Mayorista',
    'las 5 claves del Swagger, trimmeadas',
  )
  ok(Object.keys(b).length === 5, 'y ninguna otra')
  const empty = customerUpdateBody({ phone: '', businessName: null, accountManagerId: null, salesman: '  ', comments: undefined })
  ok(Object.keys(empty).length === 0, 'vacío/null/espacios NO viajan (mandar null borraría lo cargado allá)')
  ok(!('AccountManager1Id' in customerUpdateBody({ accountManagerId: 0 })), 'account manager 0 no viaja')
  ok(!('AccountManager1Id' in customerUpdateBody({ accountManagerId: -3 })), 'account manager negativo no viaja')
  ok(customerUpdateBody({ accountManagerId: '75448' }).AccountManager1Id === 75448, 'account manager como string numérico se convierte')
  ok(!('AccountManager1Id' in customerUpdateBody({ accountManagerId: 'abc' })), 'account manager no numérico no viaja')
  // Mayorista + compañía explícitos (2026-09-11)
  ok(customerUpdateBody({ isWholesale: true }).IsWholesale === true, 'isWholesale true → IsWholesale: true')
  ok(customerUpdateBody({ isWholesale: false }).IsWholesale === false, 'isWholesale false viaja como false (booleano explícito)')
  ok(!('IsWholesale' in customerUpdateBody({ isWholesale: null })), 'isWholesale null no viaja')
  ok(!('IsWholesale' in customerUpdateBody({ comments: 'x' })), 'sin isWholesale no viaja')
  ok(customerUpdateBody({ companyId: 8 }).CompanyId === 8, 'companyId → CompanyId')
  ok(!('CompanyId' in customerUpdateBody({ companyId: 0 })), 'companyId 0 no viaja')
  ok(!('CompanyId' in customerUpdateBody({ companyId: null })), 'companyId null no viaja')
  ok(!('CompanyId' in customerUpdateBody({ companyId: NaN })), 'companyId NaN no viaja')
}

console.log('updateCustomer: PUT con la ficha completa')
{
  state.requests = []
  const applied = await updateCustomer(cfg, token, 777, {
    phone: '7865550001',
    businessName: 'ACME',
    accountManagerId: 75448,
    salesman: 'Adriana Montilla',
    comments: 'Mayorista',
    isWholesale: true,
    companyId: cfg.companyId,
  })
  const req = lastReq()
  ok(req.method === 'PUT' && req.path === '/rest/api/Customers/777', 'PUT /Customers/{id}')
  ok(
    req.body.Phone1 === '7865550001' && req.body.AccountManager1Id === 75448 && req.body.Salesman === 'Adriana Montilla' &&
      req.body.Comments === 'Mayorista' && req.body.BusinessName === 'ACME',
    'teléfono + ficha en UN solo PUT',
  )
  ok(req.body.IsWholesale === true && req.body.CompanyId === 8, 'y en el mismo PUT: IsWholesale true + CompanyId del negocio (2026-09-11)')
  ok(applied.length === 7 && applied.includes('Comments') && applied.includes('IsWholesale') && applied.includes('CompanyId'), 'devuelve las claves que viajaron')

  state.requests = []
  const none = await updateCustomer(cfg, token, 777, { phone: '', businessName: null })
  ok(none.length === 0 && state.requests.length === 0, 'sin nada que mandar NO llama a la API')

  state.failPut = true
  let threw = null
  try {
    await updateCustomer(cfg, token, 777, { comments: 'x' })
  } catch (e) {
    threw = e.message
  }
  ok(/actualizar el cliente 777/.test(threw ?? ''), 'PUT fallido lanza con contexto (el caller degrada a warning)')
  state.failPut = false
}

console.log('addCustomerToGroup: POST al grupo')
{
  state.requests = []
  await addCustomerToGroup(cfg, token, 4, 777)
  const req = lastReq()
  ok(
    req.method === 'POST' && req.path === '/rest/api/Customers/CustomersGroups/4/Customers',
    'POST /Customers/CustomersGroups/{groupId}/Customers',
  )
  ok(JSON.stringify(req.body) === JSON.stringify({ CustomersIDs: [777] }), 'body {CustomersIDs: [id]}')

  let threw = null
  state.requests = []
  try {
    await addCustomerToGroup(cfg, token, 0, 777)
  } catch (e) {
    threw = e.message
  }
  ok(/grupo de SellerCloud inválido/.test(threw ?? '') && state.requests.length === 0, 'grupo 0 corta ANTES de llamar')

  state.failGroup = true
  threw = null
  try {
    await addCustomerToGroup(cfg, token, 99, 777)
  } catch (e) {
    threw = e.message
  }
  ok(/agregar el cliente 777 al grupo 99/.test(threw ?? ''), 'grupo inexistente lanza con contexto')
  state.failGroup = false
}

console.log('dirección del customer (2026-09-14): PUT /Customers/{id}/Addresses + relectura')
{
  const A = {
    line1: ' 8323 NW 12th St ',
    line2: 'Suite 4',
    city: 'Doral',
    state: 'FL',
    zip: '33126',
    country: 'us',
    contactName: 'María Pérez',
    companyName: 'ACME',
    phone: '3055550001',
  }
  ok(addressMissing(A).length === 0, 'completa → nada falta')
  ok(
    JSON.stringify(addressMissing({ line1: 'x', city: '', state: null, zip: '1', country: 'US' })) ===
      JSON.stringify(['ciudad', 'estado']),
    'lista lo que falta (ciudad, estado) — el estado es obligatorio para todos los países',
  )
  ok(addressMissing(null).length === 5, 'sin nada faltan los 5')

  const dto = addressDto(A)
  ok(dto.ID === 0 && dto.AddressSource === 0 && dto.AddressStatus === 2, 'DTO nuevo: ID 0, LocalSite, Confirmed')
  ok(dto.IsShippingAddress === true && dto.IsBillingAddress === true, 'UNA dirección: envío Y facturación')
  ok(
    dto.Address === '8323 NW 12th St' && dto.Address2 === 'Suite 4' && dto.City === 'Doral' && dto.State === 'FL' && dto.ZipCode === '33126',
    'campos trimmeados',
  )
  ok(dto.Country === 'US', 'país en mayúsculas')
  ok(dto.ContactName === 'María Pérez' && dto.CompanyName === 'ACME' && dto.Phone === '3055550001', 'contacto, empresa y teléfono')
  const required = ['ID', 'AddressSource', 'AddressStatus', 'IsShippingAddress', 'IsBillingAddress', 'Country', 'City', 'ZipCode', 'Address']
  ok(required.every((k) => k in dto), 'las 9 claves requeridas por el Swagger están presentes')

  // Body: lista vacía → solo la nuestra; con existentes → la nuestra adelante y las otras intactas.
  const b0 = customerAddressesBody([], A)
  ok(b0.Addresses.length === 1 && b0.Addresses[0].ID === 0, 'sin direcciones previas: una sola, nueva')
  const existing = [
    { ID: 11, Address: '1 Old Rd', City: 'Miami', ZipCode: '33101', Country: 'US', IsShippingAddress: true, IsBillingAddress: false, AddressSource: 0, AddressStatus: 0 },
    { ID: 12, Address: '8323 NW 12TH ST.', City: 'Doral', ZipCode: '33126', Country: 'US', IsShippingAddress: false, IsBillingAddress: true, AddressSource: 0, AddressStatus: 0, Phone: '999' },
  ]
  const b1 = customerAddressesBody(existing, A)
  ok(b1.Addresses.length === 2, 'con existentes: se conserva la lista completa')
  ok(
    b1.Addresses[0].ID === 12 && b1.Addresses[0].Address === '8323 NW 12th St' && b1.Addresses[0].Phone === '3055550001',
    'la que coincide por calle+zip se actualiza EN SU LUGAR con su ID (y va adelante)',
  )
  ok(b1.Addresses[1].ID === 11 && b1.Addresses[1].Address === '1 Old Rd', 'la otra viaja tal cual')
  const b2 = customerAddressesBody(existing, { ...A, id: 11 })
  ok(b2.Addresses[0].ID === 11 && b2.Addresses[0].Address === '8323 NW 12th St', 'con id conocido gana el ID aunque el contenido no coincida')
  ok(findAddress(existing, { line1: 'nada', zip: '0' }) === null, 'sin coincidencia → null')
  ok(findAddress('no es lista', { line1: 'x', zip: '1' }) === null, 'lista inválida → null')

  // setCustomerAddress contra el servidor falso: GET → PUT → GET.
  state.requests = []
  state.addresses = []
  const r1 = await setCustomerAddress(cfg, token, 777, A)
  const seq = state.requests
    .filter((r) => r.path.startsWith('/rest/api/Customers/777'))
    .map((r) => `${r.method} ${r.path.split('/').slice(4).join('/')}`)
  ok(JSON.stringify(seq) === JSON.stringify(['GET 777', 'PUT 777/Addresses', 'GET 777']), `secuencia GET → PUT → GET (${seq.join(' · ')})`)
  ok(r1.id === 9001 && r1.replaced === false && r1.sent === 1, 'devuelve el ID que SellerCloud le dio a la dirección nueva')
  const put = state.requests.find((r) => r.method === 'PUT' && /Addresses$/.test(r.path))
  ok(put.body.Addresses.length === 1 && put.body.Addresses[0].ID === 0 && put.body.Addresses[0].Country === 'US', 'el PUT lleva {Addresses: [la nuestra]} con ID 0')

  // Reintento con la misma dirección: actualiza la existente (ID 9001), no duplica.
  state.requests = []
  const r2 = await setCustomerAddress(cfg, token, 777, { ...A, line2: 'Suite 5' })
  ok(
    r2.id === 9001 && r2.replaced === true && state.addresses.length === 1 && state.addresses[0].Address2 === 'Suite 5',
    'reintento: actualiza en su lugar, sin duplicar',
  )

  // Con id conocido y otras direcciones allá: las ajenas se conservan.
  state.addresses = [
    { ID: 5, Address: 'Other 1', City: 'X', ZipCode: '1', Country: 'US', IsShippingAddress: true, IsBillingAddress: true, AddressSource: 0, AddressStatus: 0 },
    ...state.addresses,
  ]
  const r3 = await setCustomerAddress(cfg, token, 777, { ...A, id: 9001 })
  ok(r3.id === 9001 && state.addresses.length === 2 && state.addresses.some((a) => a.ID === 5), 'las direcciones ajenas del customer sobreviven al PUT')
  ok(state.addresses[0].ID === 9001, 'la nuestra queda primera (el push elige la primera marcada)')

  // Incompleta: corta ANTES de llamar.
  state.requests = []
  let threw = null
  try {
    await setCustomerAddress(cfg, token, 777, { ...A, state: '' })
  } catch (e) {
    threw = e.message
  }
  ok(/dirección incompleta.*estado/.test(threw ?? '') && state.requests.length === 0, 'sin estado corta antes de tocar la API')

  // PUT rechazado → lanza con contexto (paso, status y cuerpo).
  state.failAddressPut = true
  threw = null
  try {
    await setCustomerAddress(cfg, token, 777, A)
  } catch (e) {
    threw = e.message
  }
  ok(
    /cargar la dirección del cliente 777/.test(threw ?? '') && /400/.test(threw ?? '') && /ZipCode is required/.test(threw ?? ''),
    'PUT rechazado lanza con paso, status y cuerpo',
  )
  state.failAddressPut = false

  // Server que dice 200 pero no guarda: la relectura lo pesca.
  state.addresses = []
  state.addressPutIgnored = true
  threw = null
  try {
    await setCustomerAddress(cfg, token, 777, A)
  } catch (e) {
    threw = e.message
  }
  ok(/aceptó la dirección.*no aparece/.test(threw ?? ''), 'PUT "ok" sin efecto → error por relectura (no se da por cargada)')
  state.addressPutIgnored = false
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
