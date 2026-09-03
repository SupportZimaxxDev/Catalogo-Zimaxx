// Cliente de la API de SellerCloud (2026-08-17).
//
// Deliberadamente SIN nada de Deno: solo `fetch`, que existe igual en Deno y en
// Node. Así esta parte —que es donde está toda la lógica— se puede probar con
// un servidor falso desde Node, sin desplegar nada. `index.ts` es el único
// archivo que toca el runtime de Edge Functions.
//
// Referencia de la API (documentación oficial, agosto 2026):
//   * Token         POST {base}/rest/api/token     {Username, Password} → access_token (60 min)
//   * Crear orden   POST {base}/rest/api/Orders/   → id de la orden
//   * Editar orden  PUT  {base}/rest/api/Orders/{id}  (UpdateOrderRequest; el rep es SalesRep1)
//   * Cliente       GET  {base}/rest/api/Customers/{id}
//   * Órdenes       GET  {base}/rest/api/Orders    (lectura; trae SalesRepEmail + SalesRepId)
//
// Canal Wholesale = 21.
//
// DESCUBRIMIENTO 2026-08-19: el POST de creación ACEPTA
// OrderDetails.SalesRepresentative (está en el modelo del Swagger) pero el
// servidor LO IGNORA — las órdenes entraban con SalesRepId 0, comprobado
// releyendo órdenes reales. El rep de una orden existente sí se escribe, con
// PUT /api/Orders/{id} { SalesRep1 }. Por eso pushOrder lo asigna en un
// segundo paso después de crear, y relee la orden para verificar qué quedó.
//
// La orden se crea y se deja tal cual (2026-08-18, cambio de modalidad pedido
// por el usuario): hasta hoy se le ponía On Hold para que la vendedora la
// confirmara allá, pero el control pasó a estar ANTES — solo un pedido ya
// marcado Atendido en el panel se puede enviar (lo exige index.ts), así que la
// revisión humana ya ocurrió y el hold era un paso de más.
//
// 2026-08-28: toda orden viaja con "Allow shipping without payment" prendido
// (ShippingMethodDetails.AllowShippingEvenNotPaid en el create). Sin él,
// SellerCloud usa el default del cliente (AllowShippingUnPaidOrders, false en
// casi todos) y las órdenes entraban bloqueadas para despachar sin cobrar.
// Como el create de esta API puede ignorar campos en silencio, pushOrder lo
// verifica releyendo la orden (donde el campo se llama distinto:
// ShippingDetails.AllowShippingWithoutPaymentValue).
//
// 2026-08-31: si el cliente allá tiene LastName vacío (cuentas con el nombre
// completo metido entero en FirstName), customerDetails parte el nombre para
// el payload — última palabra → LastName, resto → FirstName — en vez de que
// el envío dependa de que el dato esté perfecto en SellerCloud. Solo para el
// payload: nunca se escribe nada de vuelta en el cliente de allá.

export const CHANNEL_WHOLESALE = 21

export type Config = {
  baseUrl: string // https://<servidor>.api.sellercloud.com, sin barra final
  username: string
  password: string
  companyId: number
  warehouseId?: number | null
}

export type OrderItem = {
  sku: string
  name?: string | null
  qty: number
  price?: number | null
}

// Datos opcionales de la orden. La API los acepta SOLO como enteros
// (OrderDetails.SalesRepresentative / OrderDetails.MarketingSource, según el
// Swagger del servidor: /rest/swagger/docs/v1) y no hay endpoint para resolver
// un email o un nombre a su ID — el mapeo se hace antes de llegar acá
// (vendedores.sellercloud_rep_id y el secret SELLERCLOUD_MARKETING_SOURCE_ID).
// Null/undefined = el campo no viaja; la orden entra igual.
export type OrderExtras = {
  salesRepId?: number | null // ID de empleado en SellerCloud (Settings → Employees)
  marketingSourceId?: number | null // ID de la fuente ("catalogo online")
}

type Fetcher = typeof fetch

// El token dura 60 minutos. Se guarda en memoria del isolate: mientras la
// función siga caliente, los envíos siguientes no vuelven a pedirlo. Si el
// isolate se recicla se pide de nuevo, que es lo peor que puede pasar.
let cached: { token: string; expires: number } | null = null
export function resetTokenCache() {
  cached = null
}

// Todos los caminos de la API cuelgan de {base}/rest/api/..., así que la URL
// base es el HOST pelado. Cargar el secret con el prefijo adentro
// (`https://x.api.sellercloud.com/rest/api`) es el error de tipeo más fácil de
// cometer y el más difícil de leer después: la petición termina en
// /rest/api/rest/api/token y lo que vuelve no es JSON. Se recorta acá en vez
// de fallar, porque las dos formas son intención clara. El `.api.` del host NO
// es un segmento de path y no se toca.
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\/(rest\/api|rest|api)$/i, '')
}

// El cuerpo ENTERO como texto. El recorte es cosa de quien arma el mensaje de
// error (`failure`), NO de acá: un cliente de SellerCloud pasa largo los 2 KB
// y recortarlo antes de parsear rompía el JSON válido —"la respuesta no es
// JSON" sobre una respuesta que sí lo era—. Devuelve '' si el cuerpo no se
// puede leer, para que el llamador no tenga que envolver el text() en su
// propio try.
async function readBody(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function looksLikeHtml(text: string): boolean {
  return /^\s*<(!doctype|html|\?xml|head)/i.test(text)
}

// Una respuesta con HTML adentro no es un fallo de SellerCloud: es que no le
// estamos hablando a SellerCloud. Sin esta pista el panel muestra el error
// crudo de JSON.parse (Unexpected token, doctype y nada más) y desde la
// pantalla no hay manera de saber qué hay que arreglar.
function htmlHint(text: string): string {
  if (!looksLikeHtml(text)) return ''
  return (
    ' Eso es una página web, no la API: casi siempre significa que el secret' +
    ' SELLERCLOUD_BASE_URL apunta al sitio de SellerCloud, o a un servidor que' +
    ' no existe, en vez de https://<servidor>.api.sellercloud.com.'
  )
}

// Qué salió mal, en qué paso y contra qué URL. El cuerpo va recortado, y las
// credenciales no pueden filtrarse porque solo se lee la RESPUESTA.
function failure(what: string, url: string, res: Response, text: string): Error {
  const ct = res.headers.get('Content-Type') ?? 'sin Content-Type'
  const cuerpo = text.trim() === '' ? '(cuerpo vacío)' : text.trim().slice(0, 300)
  return new Error(`${what} — ${res.status} ${ct} en ${url}: ${cuerpo}${htmlHint(text)}`)
}

// El cuerpo se lee UNA sola vez como texto y se parsea a mano: `res.json()`
// tira un error que no dice ni el paso, ni la URL, ni el status — justo lo
// único que sirve cuando lo que volvió es una página web.
async function readJson(res: Response, what: string, url: string): Promise<unknown> {
  const text = await readBody(res)
  if (!res.ok) throw failure(what, url, res, text)
  try {
    return JSON.parse(text)
  } catch {
    throw failure(`${what}: la respuesta no es JSON`, url, res, text)
  }
}

export async function getToken(cfg: Config, now = Date.now, f: Fetcher = fetch): Promise<string> {
  if (cached && cached.expires > now()) return cached.token

  const url = `${cfg.baseUrl}/rest/api/token`
  const res = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Username: cfg.username, Password: cfg.password }),
  })
  const data = (await readJson(res, 'SellerCloud no aceptó las credenciales', url)) as
    | Record<string, unknown>
    | null
  const token = data?.access_token ?? data?.token
  if (!token) throw new Error(`SellerCloud no devolvió access_token (${url})`)

  // 55 minutos y no 60: el margen evita usar un token que vence justo entre
  // que se crea la orden y se la pone On Hold, que dejaría la orden creada y
  // sin hold — el peor final posible.
  cached = { token: String(token), expires: now() + 55 * 60 * 1000 }
  return cached.token
}

export async function getCustomer(
  cfg: Config,
  token: string,
  sellercloudId: number,
  f: Fetcher = fetch,
): Promise<Record<string, unknown>> {
  const url = `${cfg.baseUrl}/rest/api/Customers/${sellercloudId}`
  const res = await f(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  })
  const data = await readJson(res, `No se pudo leer el cliente ${sellercloudId} en SellerCloud`, url)
  return (data ?? {}) as Record<string, unknown>
}

// Resuelve el email de quien apretó el botón al SalesRepId de SellerCloud,
// SIN lista de empleados: la API no la expone, pero cada orden LEÍDA viene
// con SalesRepEmail + SalesRepId juntos (MultipleOrderDataDto). Se recorren
// las órdenes más recientes de la compañía hasta encontrar el email. Solo
// funciona para un rep que ya tenga al menos una orden asignada allá — que es
// exactamente el caso del negocio: las vendedoras confirman órdenes en
// SellerCloud desde siempre.
//
// El resultado se cachea en memoria del isolate: 24 h si se encontró (los IDs
// de empleado no cambian) y 10 min si no (para no re-escanear en cada click
// mientras alguien arregla el email allá).
const REP_PAGES = 5
const REP_PAGE_SIZE = 200
let repCache = new Map<string, { id: number | null; expires: number }>()
export function resetRepCache() {
  repCache = new Map()
}

export async function findSalesRepIdByEmail(
  cfg: Config,
  token: string,
  email: string,
  f: Fetcher = fetch,
  now = Date.now,
): Promise<number | null> {
  const key = email.trim().toLowerCase()
  if (!key) return null
  const hit = repCache.get(key)
  if (hit && hit.expires > now()) return hit.id

  let found: number | null = null
  for (let page = 1; page <= REP_PAGES && found == null; page++) {
    // orderBy=1 (OrderDate) descendente: las órdenes recientes son las que
    // tienen los reps activos hoy.
    const url =
      `${cfg.baseUrl}/rest/api/Orders?model.companyID=${cfg.companyId}` +
      `&model.orderBy=1&model.isAscending=false` +
      `&model.pageNumber=${page}&model.pageSize=${REP_PAGE_SIZE}`
    const res = await f(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    })
    const data = (await readJson(res, 'No se pudo buscar el Sales Rep por email', url)) as {
      Items?: Array<Record<string, unknown>>
    } | null
    const items = data?.Items ?? []
    if (items.length === 0) break
    for (const o of items) {
      const e = String(o?.SalesRepEmail ?? '').trim().toLowerCase()
      const id = Number(o?.SalesRepId)
      if (e && e === key && Number.isFinite(id) && id > 0) {
        found = id
        break
      }
    }
  }

  repCache.set(key, {
    id: found,
    expires: now() + (found ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000),
  })
  return found
}

// Asigna el Sales Rep a una orden YA CREADA. Es el único camino que el
// servidor aplica de verdad (ver el descubrimiento 2026-08-19 arriba): el
// campo se llama SalesRep1 en el UpdateOrderRequest del PUT, no
// SalesRepresentative como en el POST. Se manda SOLO ese campo: los demás
// del modelo (CustomerId, direcciones...) van ausentes para no tocarlos.
export async function setSalesRep(
  cfg: Config,
  token: string,
  orderId: number,
  repId: number,
  f: Fetcher = fetch,
): Promise<void> {
  const url = `${cfg.baseUrl}/rest/api/Orders/${orderId}`
  const res = await f(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ SalesRep1: repId }),
  })
  const text = await readBody(res)
  if (!res.ok) {
    throw failure(`No se pudo asignar el Sales Rep ${repId} a la orden ${orderId}`, url, res, text)
  }
}

// Relee una orden por número para verificar qué quedó aplicado. Va por el
// LISTADO filtrado con model.orderIDs y no por GET /Orders/{id}: el DTO de la
// orden única no trae SalesRepId ni MarketingSourceID, el del listado sí.
// Devuelve null si la orden no aparece (p.ej. el índice del listado todavía
// no la tiene) — el llamador decide si eso amerita aviso.
export async function readOrderRep(
  cfg: Config,
  token: string,
  orderId: number,
  f: Fetcher = fetch,
): Promise<{ salesRepId: number | null; marketingSourceId: number | null } | null> {
  const url =
    `${cfg.baseUrl}/rest/api/Orders?model.orderIDs=${orderId}` +
    `&model.pageNumber=1&model.pageSize=1`
  const res = await f(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  })
  const data = (await readJson(res, `No se pudo releer la orden ${orderId}`, url)) as {
    Items?: Array<Record<string, unknown>>
  } | null
  const o = data?.Items?.[0]
  if (!o) return null
  const rep = Number(o.SalesRepId)
  const mkt = Number(o.MarketingSourceID)
  return {
    salesRepId: Number.isFinite(rep) && rep > 0 ? rep : null,
    marketingSourceId: Number.isFinite(mkt) && mkt > 0 ? mkt : null,
  }
}

// Relee la orden recién creada por GET /Orders/{id} para verificar que el
// "Allow shipping without payment" quedó prendido (el create lo manda como
// ShippingMethodDetails.AllowShippingEvenNotPaid, 2026-08-28). Va por la
// orden ÚNICA y no por el listado como readOrderRep: el DTO del listado no
// trae ShippingDetails, el de la orden única sí — y ahí el campo se llama
// AllowShippingWithoutPaymentValue. Devuelve null si el campo no vino, para
// que el llamador avise "no se pudo verificar" en vez de inventar un false.
export async function readOrderAllowUnpaidShipping(
  cfg: Config,
  token: string,
  orderId: number,
  f: Fetcher = fetch,
): Promise<boolean | null> {
  const url = `${cfg.baseUrl}/rest/api/Orders/${orderId}`
  const res = await f(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  })
  const data = await readJson(res, `No se pudo releer la orden ${orderId}`, url)
  const v = pick(data, 'ShippingDetails.AllowShippingWithoutPaymentValue')
  return typeof v === 'boolean' ? v : null
}

// Los datos del cliente salen de SellerCloud en el momento del envío, no de
// nuestra base: allá es donde viven el email y las direcciones, y son
// obligatorios para crear la orden. Copiarlos a `clients` sería una segunda
// copia que se desincroniza sola.
//
// Se buscan en varias claves porque la respuesta real puede venir anidada o
// con otra capitalización, y una orden que falla por un nombre de campo es
// mucho más caro de diagnosticar que este puñado de alternativas.
function pick(obj: unknown, ...paths: string[]): unknown {
  for (const path of paths) {
    let cur: any = obj
    for (const part of path.split('.')) {
      if (cur == null) break
      cur = cur[part]
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur
  }
  return undefined
}

// ============================================================
// Customers: búsqueda, listado paginado y alta (2026-09-02, para el backfill
// de sellercloud_id y el alta/vinculación de clientes desde el panel).
//
// Contrato confirmado contra el Swagger del servidor (/rest/swagger/docs/v1):
//   * GET /rest/api/Customers — filtros `model.email`, `model.phoneNumber`,
//     `model.firstName`, `model.lastName`, `model.keyword`,
//     `model.companyIds`, `model.pageNumber`, `model.pageSize`. Respuesta:
//     GetAllResponse<CustomerDto> = { Items: [...], TotalResults: n }.
//     El CustomerDto del LISTADO trae UserID/Email/FirstName/LastName/
//     CorporateName — SIN teléfono: el teléfono vive en el DETALLE
//     (GET /Customers/{id} → Personal.Phone1...) o como filtro server-side.
//   * POST /rest/api/Customers — CreateCustomerRequest: FirstName es EL ÚNICO
//     campo requerido por la API; LastName/Email/BusinessName/CompanyID/
//     CustomerType (0 = WholeSale, 1 = Retail) opcionales. Devuelve el ID
//     nuevo como entero pelado. OJO: el create NO acepta teléfono — se setea
//     en un segundo paso con PUT /Customers/{id} { Phone1 } (UpdateCustomerRequest).
//   * Aunque la API solo exige FirstName, ACÁ el apellido es obligatorio:
//     SellerCloud valida Last Name al crear ÓRDENES ("Customer's last name is
//     not valid", aprendido a golpes el 2026-08-31) — un customer creado sin
//     apellido no serviría para lo único que lo creamos.
// ============================================================

export type CustomerSummary = {
  id: number
  firstName: string
  lastName: string
  email: string | null
  business: string | null
  // Solo cuando se conoce (viene del detalle o de una búsqueda por teléfono);
  // el DTO del listado no lo trae.
  phone: string | null
}

// Normaliza una fila del LISTADO (CustomerDto). Las claves con variantes por
// la misma razón que customerDetails: una respuesta real puede venir con otra
// capitalización y un match que se pierde por eso es carísimo de diagnosticar.
export function customerSummary(raw: unknown): CustomerSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = Number(pick(r, 'UserID', 'UserId', 'ID', 'Id', 'id', 'CustomerID'))
  if (!Number.isFinite(id) || id <= 0) return null
  const s = (v: unknown) => (v == null ? '' : String(v).trim())
  const email = s(pick(r, 'Email', 'email'))
  const phone = s(pick(r, 'Phone', 'Phone1', 'phone', 'Personal.Phone1'))
  return {
    id,
    firstName: s(pick(r, 'FirstName', 'firstName', 'General.FirstName')),
    lastName: s(pick(r, 'LastName', 'lastName', 'General.LastName')),
    email: email ? email.toLowerCase() : null,
    business: s(pick(r, 'CorporateName', 'BusinessName', 'General.CorporateName')) || null,
    phone: phone || null,
  }
}

export type CustomerFilters = {
  email?: string | null
  phone?: string | null // viaja como model.phoneNumber
  firstName?: string | null
  lastName?: string | null
  keyword?: string | null
  pageNumber?: number
  pageSize?: number
}

export async function searchCustomers(
  cfg: Config,
  token: string,
  filters: CustomerFilters,
  f: Fetcher = fetch,
): Promise<{ items: CustomerSummary[]; total: number }> {
  const params = new URLSearchParams()
  if (filters.email) params.set('model.email', String(filters.email).trim())
  if (filters.phone) params.set('model.phoneNumber', String(filters.phone).trim())
  if (filters.firstName) params.set('model.firstName', String(filters.firstName).trim())
  if (filters.lastName) params.set('model.lastName', String(filters.lastName).trim())
  if (filters.keyword) params.set('model.keyword', String(filters.keyword).trim())
  // Acotado a la compañía del negocio, igual que las órdenes (el parámetro es
  // plural/array en el Swagger; un solo valor viaja como un elemento).
  params.set('model.companyIds', String(cfg.companyId))
  params.set('model.pageNumber', String(filters.pageNumber ?? 1))
  params.set('model.pageSize', String(filters.pageSize ?? 50))

  const url = `${cfg.baseUrl}/rest/api/Customers?${params.toString()}`
  const res = await f(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  })
  const data = (await readJson(res, 'No se pudo buscar clientes en SellerCloud', url)) as {
    Items?: unknown[]
    TotalResults?: number
  } | null
  const items = (data?.Items ?? [])
    .map(customerSummary)
    .filter((c): c is CustomerSummary => c != null)
  return { items, total: Number(data?.TotalResults) || items.length }
}

// Todos los customers de la compañía, paginando hasta agotar. `onPage` es un
// hook de progreso (el backfill imprime "página X de ~Y"). El tope de páginas
// es un cortafuegos contra un TotalResults mentiroso o una API que repite la
// última página para siempre — no un límite de negocio.
//
// Dos lecciones de la corrida real (2026-09-03):
//   * El servidor CLAMPEA el pageSize: se piden 500 y sirve 50. Cortar por
//     "vinieron menos de los pedidos" paraba en la página 1 con 50 de 1037.
//     Se corta por total alcanzado o por falta de progreso, nunca por tamaño.
//   * El token dura 60 min y una descarga completa + el loop de teléfonos del
//     backfill pueden pasarse: el token se pide POR PÁGINA vía getToken, que
//     cachea y se renueva solo a los 55 min — por eso esta función ya no
//     recibe el token como parámetro.
const LIST_PAGE_SIZE = 500
const LIST_MAX_PAGES = 400

export async function listAllCustomers(
  cfg: Config,
  f: Fetcher = fetch,
  onPage?: (page: number, got: number, total: number) => void,
  now = Date.now,
): Promise<CustomerSummary[]> {
  const all: CustomerSummary[] = []
  const seen = new Set<number>()
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const token = await getToken(cfg, now, f)
    const { items, total } = await searchCustomers(
      cfg,
      token,
      { pageNumber: page, pageSize: LIST_PAGE_SIZE },
      f,
    )
    if (items.length === 0) break
    const before = all.length
    for (const c of items) {
      if (!seen.has(c.id)) {
        seen.add(c.id)
        all.push(c)
      }
    }
    onPage?.(page, all.length, total)
    if (all.length >= total) break
    // Página sin ningún ID nuevo = el servidor repite la última página: cortar
    // acá evita el loop infinito sin depender del TotalResults.
    if (all.length === before) break
  }
  return all
}

export type NewCustomer = {
  firstName: string
  lastName: string
  email?: string | null
  business?: string | null
}

// CustomerType 1 = Wholesale (2026-09-03, confirmado por el usuario contra su
// instancia). OJO: el Swagger se contradice a sí mismo — el x-enumNames del
// CreateCustomerRequest dice 0 = WholeSale / 1 = Retail, pero el del FILTRO
// del GET dice 0 = Retail / 1 = Wholesale. Manda lo observado en los datos
// reales, no el Swagger. Todos los clientes de este negocio son mayoristas.
const CUSTOMER_TYPE_WHOLESALE = 1

export async function createCustomer(
  cfg: Config,
  token: string,
  c: NewCustomer,
  f: Fetcher = fetch,
): Promise<number> {
  const firstName = String(c.firstName ?? '').trim()
  const lastName = String(c.lastName ?? '').trim()
  // La API solo exige FirstName, pero sin LastName el customer nace inválido
  // para crear órdenes (ver cabecera de esta sección): acá se exigen los dos.
  if (!firstName || !lastName) {
    throw new Error('para crear el cliente en SellerCloud hacen falta nombre Y apellido')
  }
  const email = String(c.email ?? '').trim()
  const url = `${cfg.baseUrl}/rest/api/Customers/`
  const res = await f(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      CompanyID: cfg.companyId,
      FirstName: firstName,
      LastName: lastName,
      ...(email ? { Email: email } : {}),
      ...(c.business ? { BusinessName: String(c.business).trim() } : {}),
      CustomerType: CUSTOMER_TYPE_WHOLESALE,
    }),
  })
  const data = await readJson(res, 'SellerCloud rechazó el alta del cliente', url)
  const id = typeof data === 'number' ? data : pick(data, 'ID', 'Id', 'id', 'UserID', 'CustomerID')
  const num = Number(id)
  if (!Number.isFinite(num) || num <= 0) {
    // Igual que createOrder: el customer PUEDE existir allá aunque no sepamos
    // su ID — reintentar a ciegas lo duplicaría.
    throw new Error(
      `SellerCloud no devolvió el ID del cliente (respondió: ${JSON.stringify(data)?.slice(0, 200)}).` +
        ' Buscalo en SellerCloud antes de reintentar.',
    )
  }
  return num
}

// El teléfono no viaja en el create (CreateCustomerRequest no lo tiene): se
// setea después con el PUT del UpdateCustomerRequest, donde sí existe como
// Phone1. Mejor-esfuerzo a propósito: si esto falla, el customer YA existe y
// el llamador avisa en vez de fallar — mismo criterio que setSalesRep.
export async function setCustomerPhone(
  cfg: Config,
  token: string,
  customerId: number,
  phone: string,
  f: Fetcher = fetch,
): Promise<void> {
  const url = `${cfg.baseUrl}/rest/api/Customers/${customerId}`
  const res = await f(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ Phone1: phone }),
  })
  const text = await readBody(res)
  if (!res.ok) {
    throw failure(`No se pudo cargar el teléfono del cliente ${customerId}`, url, res, text)
  }
}

export function customerDetails(customer: Record<string, unknown>) {
  const email = pick(customer, 'Email', 'email', 'UserName', 'Username', 'General.Email')
  const first = pick(customer, 'FirstName', 'firstName', 'General.FirstName', 'BillingAddress.FirstName')
  const last = pick(customer, 'LastName', 'lastName', 'General.LastName', 'BillingAddress.LastName')
  const id = pick(customer, 'ID', 'Id', 'id', 'CustomerID', 'General.ID')

  const faltan: string[] = []
  if (!email) faltan.push('email')
  if (!first && !last) faltan.push('nombre')
  if (faltan.length) {
    throw new Error(
      `El cliente en SellerCloud no tiene ${faltan.join(' ni ')}: cargalo allá y volvé a intentar`,
    )
  }

  // LastName vacío allá (2026-08-31): pasa seguido — cuentas cargadas con el
  // nombre completo (o el de la empresa) metido entero en FirstName. En vez
  // de depender de que el dato esté perfecto en SellerCloud, se parte el
  // nombre completo SOLO para el payload de la orden: última palabra →
  // LastName, el resto → FirstName (con una sola palabra, queda toda en
  // LastName). Mismo criterio que ya usa toOrderAddress con el ContactName.
  // Nada se escribe de vuelta en SellerCloud — el cliente allá queda tal cual.
  let firstName = String(first ?? '').trim()
  let lastName = String(last ?? '').trim()
  if (!lastName && firstName) {
    const parts = firstName.split(/\s+/)
    lastName = parts[parts.length - 1]
    firstName = parts.slice(0, -1).join(' ')
  }

  return {
    ID: typeof id === 'number' ? id : Number(id) || undefined,
    Email: String(email),
    FirstName: firstName,
    LastName: lastName,
  }
}

// Elige de la lista `Addresses` la dirección de envío o de facturación. La
// respuesta real (2026-08-18) no trae ShippingAddress/BillingAddress sueltas:
// trae una lista, y cuál es cuál se marca con alguna bandera cuyo nombre
// exacto no conocemos — por eso se acepta cualquier clave booleana en true que
// nombre ship/bill (IsDefaultShipping, IsShippingAddress...) o una clave
// tipo "...Type..." cuyo valor lo nombre (AddressType: "Shipping"). Si ninguna
// está marcada se usa la primera: el caso normal acá es el mayorista con una
// sola dirección.
function fromAddressList(list: unknown, kind: 'ship' | 'bill'): Record<string, unknown> | undefined {
  if (!Array.isArray(list)) return undefined
  const entries = list.filter((a) => a && typeof a === 'object') as Record<string, unknown>[]
  const re = kind === 'ship' ? /ship/i : /bill/i
  const marked = entries.find((a) =>
    Object.entries(a).some(
      ([k, v]) =>
        (typeof v === 'boolean' && v && re.test(k)) ||
        (typeof v === 'string' && /type/i.test(k) && re.test(v)),
    ),
  )
  return marked ?? entries[0]
}

export function addressesOf(customer: Record<string, unknown>) {
  // La respuesta real anida casi todo bajo `General`, así que todo se busca
  // tanto arriba de todo como bajo `General.` (y con las variantes de
  // capitalización de siempre). Primero las claves directas, después la lista.
  const list = pick(customer, 'Addresses', 'addresses', 'General.Addresses', 'Personal.Addresses')
  const shipping =
    pick(
      customer,
      'ShippingAddress',
      'shippingAddress',
      'DefaultShippingAddress',
      'General.ShippingAddress',
      'General.DefaultShippingAddress',
    ) ?? fromAddressList(list, 'ship')
  const billing =
    pick(
      customer,
      'BillingAddress',
      'billingAddress',
      'DefaultBillingAddress',
      'General.BillingAddress',
      'General.DefaultBillingAddress',
    ) ?? fromAddressList(list, 'bill')
  // Una de las dos alcanza: si falta la de envío se usa la de facturación y al
  // revés. SellerCloud pide las dos en el body, así que se manda la misma
  // duplicada antes que fallar.
  const any = shipping ?? billing
  if (!any) {
    // Lista presente pero vacía = el cliente de verdad no tiene dirección
    // cargada: eso se arregla en SellerCloud, no acá.
    if (Array.isArray(list)) {
      throw new Error(
        'El cliente en SellerCloud no tiene ninguna dirección cargada (la lista' +
          ' Addresses vino vacía): cargásela allá y volvé a intentar',
      )
    }
    // Si SÍ la hay pero bajo una clave que no mapeamos, las claves recibidas
    // dicen dónde está para ajustar el pick de una.
    const keys =
      customer && typeof customer === 'object' ? Object.keys(customer).join(', ') : '(sin objeto)'
    throw new Error(
      `El cliente en SellerCloud no trae dirección en ShippingAddress/BillingAddress` +
        ` ni en Addresses (claves recibidas: ${keys}). Si la dirección está cargada` +
        ` allá, pasame estas claves para ajustar el mapeo.`,
    )
  }
  return {
    ShippingAddress: (shipping ?? billing) as Record<string, unknown>,
    BillingAddress: (billing ?? shipping) as Record<string, unknown>,
  }
}

// Convierte la dirección tal como viene en el CLIENTE (UserAddressDto:
// ContactName, CompanyName, Address...) al shape que el create de órdenes
// SÍ entiende (OrderAddressDto: FirstName/LastName, Business, Address...).
// Copiarla textual — lo que se hacía hasta el 2026-08-19 — guardaba calle,
// ciudad y zip pero PERDÍA EL NOMBRE del destinatario (el create espera
// FirstName/LastName y la del cliente trae ContactName; Business vs
// CompanyName, ídem): en el panel de SellerCloud esa dirección se ve como
// "sin dirección de envío" y un label saldría sin destinatario — fue el
// reporte de una vendedora, que las corregía a mano allá.
// El nombre sale del ContactName de la propia dirección (primera palabra =
// nombre, el resto apellido, mismo criterio que usa SellerCloud); si la
// dirección no trae contacto, se cae al nombre del cliente.
export function toOrderAddress(
  addr: Record<string, unknown>,
  fallback?: { FirstName?: string; LastName?: string },
) {
  const s = (v: unknown) => (v == null ? '' : String(v).trim())
  const contact = s(pick(addr, 'ContactName', 'contactName', 'Name'))
  let first = ''
  let last = ''
  if (contact) {
    const parts = contact.split(/\s+/)
    first = parts[0]
    last = parts.slice(1).join(' ')
  } else {
    first = s(fallback?.FirstName)
    last = s(fallback?.LastName)
  }
  return {
    FirstName: first,
    LastName: last,
    Business: s(pick(addr, 'CompanyName', 'Business', 'companyName')),
    Country: s(pick(addr, 'Country', 'CountryCode', 'country')),
    City: s(pick(addr, 'City', 'city')),
    State: s(pick(addr, 'State', 'StateCode', 'state')),
    Region: s(pick(addr, 'Region', 'region')),
    ZipCode: s(pick(addr, 'ZipCode', 'PostalCode', 'zipCode')),
    Address: s(pick(addr, 'Address', 'StreetLine1', 'Address1', 'Street', 'address')),
    Address2: s(pick(addr, 'Address2', 'StreetLine2', 'address2')),
    Phone: s(pick(addr, 'Phone', 'PhoneNumber', 'phone')),
    Fax: s(pick(addr, 'Fax', 'FaxNumber', 'fax')),
  }
}

export function buildOrderPayload(
  cfg: Config,
  customer: Record<string, unknown>,
  items: OrderItem[],
  extras: OrderExtras = {},
) {
  const usable = items.filter((i) => i.sku && i.qty > 0)
  if (usable.length === 0) throw new Error('el pedido no tiene ninguna línea con SKU y cantidad')

  // Number.isFinite y no un truthy check: un 0 no es un ID válido en ninguna
  // de las dos listas, pero un NaN colado (un secret mal tipeado) tampoco
  // tiene que viajar.
  const salesRep = Number(extras.salesRepId)
  const marketing = Number(extras.marketingSourceId)

  const details = customerDetails(customer)
  const addrs = addressesOf(customer)
  return {
    CustomerDetails: details,
    OrderDetails: {
      CompanyID: cfg.companyId,
      Channel: CHANNEL_WHOLESALE,
      ...(Number.isFinite(salesRep) && salesRep > 0 ? { SalesRepresentative: salesRep } : {}),
      ...(Number.isFinite(marketing) && marketing > 0 ? { MarketingSource: marketing } : {}),
    },
    // Despacho sin pago SIEMPRE permitido (2026-08-28): sin este campo, la
    // orden hereda el default del cliente en SellerCloud (AllowShippingUnPaidOrders,
    // false en casi todos) y entraba bloqueada para despachar hasta cobrarse —
    // el negocio despacha antes de cobrar. En el modelo del create el campo es
    // ShippingMethodDetails.AllowShippingEvenNotPaid; al RELEER la orden vuelve
    // con otro nombre: ShippingDetails.AllowShippingWithoutPaymentValue.
    ShippingMethodDetails: {
      AllowShippingEvenNotPaid: true,
    },
    ShippingAddress: toOrderAddress(addrs.ShippingAddress, details),
    BillingAddress: toOrderAddress(addrs.BillingAddress, details),
    Products: usable.map((i) => ({
      ProductID: i.sku,
      Qty: i.qty,
      SitePrice: i.price ?? 0,
      ...(cfg.warehouseId ? { ShipFromWareHouseID: cfg.warehouseId } : {}),
    })),
  }
}

export async function createOrder(
  cfg: Config,
  token: string,
  payload: unknown,
  f: Fetcher = fetch,
): Promise<number> {
  const url = `${cfg.baseUrl}/rest/api/Orders/`
  const res = await f(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const data = await readJson(res, 'SellerCloud rechazó la orden', url)
  // La respuesta puede traer el id pelado o dentro de un objeto.
  const id = typeof data === 'number' ? data : pick(data, 'ID', 'Id', 'id', 'OrderID', 'OrderId')
  const num = Number(id)
  if (!Number.isFinite(num) || num <= 0) {
    // Acá la orden PUEDE existir allá aunque no sepamos su número, así que el
    // aviso es parte del error: reintentar a ciegas la duplicaría.
    throw new Error(
      `SellerCloud no devolvió el número de orden (respondió: ${JSON.stringify(data)?.slice(0, 200)}).` +
        ' Revisá en SellerCloud si la orden se creó ANTES de reintentar.',
    )
  }
  return num
}

// Crea la orden en SellerCloud y devuelve su número. Sin On Hold desde el
// 2026-08-18: el pedido ya viene revisado (solo se puede enviar si está
// Atendido en el panel), así que entra directo.
//
// El Sales Rep se asigna DESPUÉS de crear (2026-08-19), porque el POST lo
// ignora; y como a partir del create la orden YA EXISTE allá, nada de lo que
// falle después puede volver como error de envío — el panel lo reintentaría
// y duplicaría la orden. Todo lo posterior se degrada a `warnings`.
export async function pushOrder(
  cfg: Config,
  sellercloudId: number,
  items: OrderItem[],
  extras: OrderExtras = {},
  f: Fetcher = fetch,
  now = Date.now,
): Promise<{ orderId: number; warnings: string[] }> {
  const token = await getToken(cfg, now, f)
  const customer = await getCustomer(cfg, token, sellercloudId, f)
  const payload = buildOrderPayload(cfg, customer, items, extras)
  const orderId = await createOrder(cfg, token, payload, f)

  const warnings: string[] = []
  const repId = Number(extras.salesRepId)
  const mktId = Number(extras.marketingSourceId)
  const wantRep = Number.isFinite(repId) && repId > 0
  const wantMkt = Number.isFinite(mktId) && mktId > 0

  let repPutOk = false
  if (wantRep) {
    try {
      await setSalesRep(cfg, token, orderId, repId, f)
      repPutOk = true
    } catch (e) {
      warnings.push(
        `La orden #${orderId} se creó pero no se le pudo asignar el Sales Rep ` +
          `(${(e as Error).message}). Asignáselo a mano en SellerCloud.`,
      )
    }
  }

  // Verificación releyendo la orden: la lección del 2026-08-19 es que esta
  // API puede contestar 200 y no aplicar el campo, así que "el PUT no falló"
  // no alcanza como confirmación.
  if (repPutOk || wantMkt) {
    try {
      const back = await readOrderRep(cfg, token, orderId, f)
      if (back == null) {
        if (repPutOk) {
          warnings.push(
            `No se pudo verificar el Sales Rep de la orden #${orderId} ` +
              '(todavía no aparece en el listado de SellerCloud). Revisalo allá.',
          )
        }
      } else {
        if (repPutOk && back.salesRepId !== repId) {
          warnings.push(
            `SellerCloud aceptó el Sales Rep de la orden #${orderId} pero al releerla ` +
              `quedó ${back.salesRepId ?? 'sin rep'} en vez de ${repId}. Corregilo a mano allá.`,
          )
        }
        // A diferencia del rep, el Marketing Source SÍ lo aplica el create
        // (verificado 2026-08-19: las órdenes reales quedaron con el ID
        // correcto) — este aviso es solo por si algún día deja de hacerlo.
        if (wantMkt && back.marketingSourceId !== mktId) {
          warnings.push(
            `El Marketing Source no quedó aplicado en la orden #${orderId} ` +
              `(quedó ${back.marketingSourceId ?? 'vacío'} en vez de ${mktId}). Revisalo allá.`,
          )
        }
      }
    } catch (e) {
      if (repPutOk) {
        warnings.push(
          `No se pudo verificar el Sales Rep de la orden #${orderId}: ${(e as Error).message}`,
        )
      }
    }
  }

  // El "Allow shipping without payment" viaja en el create (2026-08-28), pero
  // esta API ya demostró contestar 200 y no aplicar un campo (el rep,
  // 2026-08-19): se verifica SIEMPRE releyendo la orden única. A diferencia
  // del rep no hay PUT que lo corrija — el UpdateOrderRequest no trae el
  // campo — así que si no quedó, el remedio es prenderlo a mano allá.
  try {
    const allow = await readOrderAllowUnpaidShipping(cfg, token, orderId, f)
    if (allow === false) {
      warnings.push(
        `La orden #${orderId} quedó SIN "Allow shipping without payment" ` +
          '(SellerCloud no aplicó el campo del create). Prendéselo a mano allá ' +
          'para que se pueda despachar antes de cobrarse.',
      )
    } else if (allow == null) {
      warnings.push(
        `No se pudo verificar el "Allow shipping without payment" de la orden #${orderId} ` +
          '(la relectura no trajo el campo). Revisalo allá.',
      )
    }
  } catch (e) {
    warnings.push(
      `No se pudo verificar el "Allow shipping without payment" de la orden #${orderId}: ` +
        `${(e as Error).message}`,
    )
  }

  return { orderId, warnings }
}
