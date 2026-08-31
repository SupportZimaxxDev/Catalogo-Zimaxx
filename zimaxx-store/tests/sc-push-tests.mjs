// Tests del cliente de SellerCloud contra un servidor falso (patrón del
// proyecto: sellercloud.ts no importa nada de Deno, así que corre en Node).
// Correr con `node tests/sc-push-tests.mjs` (Node 23+ por el TypeScript).
// Vive en el repo desde el 2026-08-19: las suites anteriores (86 y 100
// comprobaciones) quedaban en el scratchpad de cada sesión y se perdían.
// Foco: el paso de asignar el Sales Rep con PUT después de crear y el mapeo
// de direcciones del cliente al shape del create, con verificación por
// relectura — todo comportamiento REAL descubierto contra la API viva.
// Nota Windows: al final puede salir un "Assertion failed" de libuv DESPUÉS
// del "TODO OK" — es Node cerrando el servidor, no un test caído.
import { createServer } from 'node:http'

const mod = await import(
  new URL('../supabase/functions/sellercloud-push-order/sellercloud.ts', import.meta.url).href
)
const { pushOrder, resetTokenCache, resetRepCache } = mod

// ---- servidor falso -------------------------------------------------------
// Simula el comportamiento REAL descubierto el 2026-08-19: el POST de
// creación ignora SalesRepresentative; el PUT con SalesRep1 sí aplica.
const state = {
  requests: [], // { method, path, body }
  orderRep: 0,
  orderMkt: 0,
  orderAllowShip: false, // queda lo que el create aplicó
  applyMktOnCreate: true, // ¿el create aplica MarketingSource?
  applyAllowShipOnCreate: true, // ¿el create aplica AllowShippingEvenNotPaid?
  failPut: false, // el PUT devuelve 500
  ignorePut: false, // el PUT devuelve 200 pero no aplica
  emptyReadback: false, // la relectura del LISTADO no encuentra la orden
  failSingleGet: false, // GET /Orders/{id} devuelve 500
  omitShipDetails: false, // GET /Orders/{id} contesta sin ShippingDetails
  lastCreatePayload: null,
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null
    const path = req.url
    state.requests.push({ method: req.method, path, body })
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }

    if (req.method === 'POST' && path === '/rest/api/token') {
      return json(200, { access_token: 'tok-1' })
    }
    if (req.method === 'GET' && path.startsWith('/rest/api/Customers/')) {
      // Shape REAL del cliente (2026-08-19): las direcciones vienen en una
      // lista Addresses de UserAddressDto — el nombre es ContactName y la
      // empresa CompanyName, NO FirstName/Business como espera el create.
      const conContacto = !path.endsWith('/456')
      return json(200, {
        Email: 'cliente@x.com',
        FirstName: 'Cli',
        LastName: 'Ente',
        Addresses: [
          {
            ID: 1, ContactName: conContacto ? 'Maria Perez Gomez' : '', CompanyName: 'Empresa X',
            IsShippingAddress: false, IsBillingAddress: true, RowStatus: 0,
            Country: 'PE', City: 'Lima', State: '', Region: '', ZipCode: '2000',
            Address: 'Av. Uno 123', Address2: '', Phone: '51 999', Fax: '',
          },
          {
            ID: 2, ContactName: conContacto ? 'Maria Perez Gomez' : '', CompanyName: 'Empresa X',
            IsShippingAddress: true, IsBillingAddress: false, RowStatus: 0,
            Country: 'US', City: 'Miami', State: 'FL', Region: '', ZipCode: '33166',
            Address: '8301 NW 66th st', Address2: 'Suite 2', Phone: '', Fax: '',
          },
        ],
      })
    }
    if (req.method === 'POST' && path === '/rest/api/Orders/') {
      state.lastCreatePayload = body
      state.orderRep = 0 // el servidor IGNORA SalesRepresentative
      state.orderMkt = state.applyMktOnCreate ? (body?.OrderDetails?.MarketingSource ?? 0) : 0
      state.orderAllowShip = state.applyAllowShipOnCreate
        ? body?.ShippingMethodDetails?.AllowShippingEvenNotPaid === true
        : false
      return json(200, 777)
    }
    if (req.method === 'PUT' && path === '/rest/api/Orders/777') {
      if (state.failPut) return json(500, { Message: 'boom' })
      if (!state.ignorePut && body?.SalesRep1) state.orderRep = body.SalesRep1
      return json(200, {})
    }
    if (req.method === 'GET' && path.startsWith('/rest/api/Orders?')) {
      if (state.emptyReadback) return json(200, { Items: [] })
      return json(200, {
        Items: [{ ID: 777, SalesRepId: state.orderRep, MarketingSourceID: state.orderMkt }],
      })
    }
    if (req.method === 'GET' && path === '/rest/api/Orders/777') {
      // La orden ÚNICA (a diferencia del listado) trae ShippingDetails, y el
      // flag ahí se llama distinto que en el create — nombres reales de la
      // doc de la API (get-single-order).
      if (state.failSingleGet) return json(500, { Message: 'boom' })
      if (state.omitShipDetails) return json(200, { ID: 777 })
      return json(200, {
        ID: 777,
        ShippingDetails: {
          AllowShippingWithoutPaymentValue: state.orderAllowShip,
          AllowShippingWithoutPaymentVisible: state.orderAllowShip,
        },
      })
    }
    json(404, { error: `sin ruta: ${req.method} ${path}` })
  })
})

await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const cfg = {
  baseUrl: `http://127.0.0.1:${server.address().port}`,
  username: 'u',
  password: 'p',
  companyId: 172,
  warehouseId: null,
}
const ITEMS = [{ sku: 'SKU1', name: 'Perfume', qty: 2, price: 10 }]

let failures = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'OK ' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`)
  if (!ok) failures++
}
function reset(over = {}) {
  resetTokenCache()
  resetRepCache?.()
  Object.assign(state, {
    requests: [],
    orderRep: 0,
    orderMkt: 0,
    orderAllowShip: false,
    applyMktOnCreate: true,
    applyAllowShipOnCreate: true,
    failPut: false,
    ignorePut: false,
    emptyReadback: false,
    failSingleGet: false,
    omitShipDetails: false,
    lastCreatePayload: null,
  })
  Object.assign(state, over)
}
const putsTo777 = () => state.requests.filter((r) => r.method === 'PUT' && r.path === '/rest/api/Orders/777')

// 1) Camino feliz: create (rep ignorado) → PUT SalesRep1 → relectura OK.
reset()
{
  const r = await pushOrder(cfg, 123, ITEMS, { salesRepId: 75448, marketingSourceId: 5 })
  check('feliz: devuelve el número de orden', r.orderId === 777)
  check('feliz: sin warnings', r.warnings.length === 0, JSON.stringify(r.warnings))
  check(
    'feliz: el create SIGUE mandando SalesRepresentative (por si algún día lo aplican)',
    state.lastCreatePayload?.OrderDetails?.SalesRepresentative === 75448,
  )
  const puts = putsTo777()
  check('feliz: un solo PUT, con SalesRep1 y nada más', puts.length === 1 && JSON.stringify(puts[0].body) === '{"SalesRep1":75448}', JSON.stringify(puts))
  check('feliz: la orden quedó con el rep', state.orderRep === 75448)
  check(
    'feliz: el create manda AllowShippingEvenNotPaid en true (2026-08-28)',
    state.lastCreatePayload?.ShippingMethodDetails?.AllowShippingEvenNotPaid === true,
    JSON.stringify(state.lastCreatePayload?.ShippingMethodDetails),
  )
}

// 1b) Direcciones (2026-08-19): el create recibe OrderAddressDto de verdad —
//     nombre del ContactName partido en First/Last, Business del CompanyName,
//     la entrada MARCADA shipping para envío y la marcada billing para
//     facturación — y sin las claves basura del DTO del cliente.
reset()
{
  await pushOrder(cfg, 123, ITEMS, {})
  const ship = state.lastCreatePayload?.ShippingAddress
  const bill = state.lastCreatePayload?.BillingAddress
  check(
    'addr: shipping = la entrada marcada, con nombre partido y Business',
    ship?.FirstName === 'Maria' && ship?.LastName === 'Perez Gomez' &&
      ship?.Business === 'Empresa X' && ship?.Address === '8301 NW 66th st' &&
      ship?.Address2 === 'Suite 2' && ship?.City === 'Miami' && ship?.State === 'FL' &&
      ship?.ZipCode === '33166' && ship?.Country === 'US',
    JSON.stringify(ship),
  )
  check(
    'addr: billing = la entrada marcada billing, con su teléfono',
    bill?.Address === 'Av. Uno 123' && bill?.City === 'Lima' && bill?.Country === 'PE' &&
      bill?.Phone === '51 999' && bill?.FirstName === 'Maria',
    JSON.stringify(bill),
  )
  check(
    'addr: sin claves basura del DTO del cliente (ContactName, flags, ID)',
    ship && !('ContactName' in ship) && !('IsShippingAddress' in ship) && !('ID' in ship) &&
      !('RowStatus' in ship) && !('CompanyName' in ship),
    JSON.stringify(Object.keys(ship ?? {})),
  )
}

// 1c) Dirección sin ContactName: el nombre cae al del cliente.
reset()
{
  await pushOrder(cfg, 456, ITEMS, {})
  const ship = state.lastCreatePayload?.ShippingAddress
  check(
    'addr: sin ContactName usa el nombre del cliente',
    ship?.FirstName === 'Cli' && ship?.LastName === 'Ente',
    JSON.stringify(ship),
  )
}

// 2) PUT falla con 500: la orden queda, warning con el motivo.
reset({ failPut: true })
{
  const r = await pushOrder(cfg, 123, ITEMS, { salesRepId: 75448 })
  check('put-500: la orden se devuelve igual', r.orderId === 777)
  check(
    'put-500: warning de que no se pudo asignar',
    r.warnings.length === 1 && r.warnings[0].includes('no se le pudo asignar el Sales Rep'),
    JSON.stringify(r.warnings),
  )
}

// 3) PUT contesta 200 pero no aplica (el vicio de esta API): la relectura lo pesca.
reset({ ignorePut: true })
{
  const r = await pushOrder(cfg, 123, ITEMS, { salesRepId: 75448 })
  check(
    'put-ignorado: la relectura avisa que no quedó',
    r.warnings.length === 1 && r.warnings[0].includes('al releerla'),
    JSON.stringify(r.warnings),
  )
}

// 4) El create no aplica MarketingSource: warning que lo dice.
reset({ applyMktOnCreate: false })
{
  const r = await pushOrder(cfg, 123, ITEMS, { salesRepId: 75448, marketingSourceId: 5 })
  check(
    'mkt-ignorado: warning de Marketing Source',
    r.warnings.length === 1 && r.warnings[0].includes('Marketing Source'),
    JSON.stringify(r.warnings),
  )
}

// 5) Sin rep ni marketing: ni PUT ni relectura del LISTADO. La única request
//    de más es el GET de la orden única, que verifica el flag de despacho sin
//    pago y corre SIEMPRE (2026-08-28).
reset()
{
  const r = await pushOrder(cfg, 123, ITEMS, {})
  const extra = state.requests.filter(
    (x) => (x.method === 'PUT') || (x.method === 'GET' && x.path.startsWith('/rest/api/Orders?')),
  )
  const singleGets = state.requests.filter(
    (x) => x.method === 'GET' && x.path === '/rest/api/Orders/777',
  )
  check('sin-extras: sin warnings', r.warnings.length === 0, JSON.stringify(r.warnings))
  check('sin-extras: no hay PUT ni relectura del listado', extra.length === 0, JSON.stringify(extra))
  check('sin-extras: un solo GET de verificación del flag', singleGets.length === 1)
}

// 5b) El create acepta AllowShippingEvenNotPaid pero NO lo aplica (el mismo
//     vicio que el rep): la relectura de la orden única lo pesca y avisa que
//     el remedio es manual (no hay PUT para este campo).
reset({ applyAllowShipOnCreate: false })
{
  const r = await pushOrder(cfg, 123, ITEMS, {})
  check(
    'allow-ignorado: warning de que quedó sin el flag',
    r.warnings.length === 1 && r.warnings[0].includes('quedó SIN "Allow shipping without payment"'),
    JSON.stringify(r.warnings),
  )
  check('allow-ignorado: la orden se devuelve igual', r.orderId === 777)
}

// 5c) La orden única contesta sin ShippingDetails: aviso suave de "no se pudo
//     verificar", nunca un false inventado.
reset({ omitShipDetails: true })
{
  const r = await pushOrder(cfg, 123, ITEMS, {})
  check(
    'allow-sin-campo: warning suave de verificación',
    r.warnings.length === 1 &&
      r.warnings[0].includes('No se pudo verificar el "Allow shipping without payment"') &&
      r.warnings[0].includes('no trajo el campo'),
    JSON.stringify(r.warnings),
  )
}

// 5d) El GET de la orden única falla con 500: la orden queda, aviso con el
//     motivo real adentro.
reset({ failSingleGet: true })
{
  const r = await pushOrder(cfg, 123, ITEMS, {})
  check(
    'allow-get-500: warning con el motivo',
    r.warnings.length === 1 &&
      r.warnings[0].includes('No se pudo verificar el "Allow shipping without payment"') &&
      r.warnings[0].includes('500'),
    JSON.stringify(r.warnings),
  )
  check('allow-get-500: la orden se devuelve igual', r.orderId === 777)
}

// 6) Rep null pero marketing sí: sin PUT, la relectura solo verifica marketing.
reset()
{
  const r = await pushOrder(cfg, 123, ITEMS, { salesRepId: null, marketingSourceId: 5 })
  check('solo-mkt: sin PUT', putsTo777().length === 0)
  check('solo-mkt: marketing aplicado, sin warnings', r.warnings.length === 0, JSON.stringify(r.warnings))
}

// 7) La relectura no encuentra la orden: aviso suave, no error.
reset({ emptyReadback: true })
{
  const r = await pushOrder(cfg, 123, ITEMS, { salesRepId: 75448 })
  check(
    'readback-vacío: warning suave de verificación',
    r.warnings.length === 1 && r.warnings[0].includes('No se pudo verificar'),
    JSON.stringify(r.warnings),
  )
  check('readback-vacío: la orden se devuelve igual', r.orderId === 777)
}

// 8) Valores basura en extras: no viajan ni al create ni en PUT.
reset()
{
  const r = await pushOrder(cfg, 123, ITEMS, { salesRepId: NaN, marketingSourceId: -3 })
  check('basura: sin PUT', putsTo777().length === 0)
  check(
    'basura: el create no lleva los campos',
    state.lastCreatePayload?.OrderDetails?.SalesRepresentative === undefined &&
      state.lastCreatePayload?.OrderDetails?.MarketingSource === undefined,
  )
  check('basura: sin warnings', r.warnings.length === 0, JSON.stringify(r.warnings))
}

server.close()
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLAS`)
process.exit(failures === 0 ? 0 : 1)
