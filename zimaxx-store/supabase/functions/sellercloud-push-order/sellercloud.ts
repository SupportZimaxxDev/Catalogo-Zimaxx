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
//   * Cliente       GET  {base}/rest/api/Customers/{id}
//   * Órdenes       GET  {base}/rest/api/Orders    (lectura; trae SalesRepEmail + SalesRepId)
//
// Canal Wholesale = 21.
//
// La orden se crea y se deja tal cual (2026-08-18, cambio de modalidad pedido
// por el usuario): hasta hoy se le ponía On Hold para que la vendedora la
// confirmara allá, pero el control pasó a estar ANTES — solo un pedido ya
// marcado Atendido en el panel se puede enviar (lo exige index.ts), así que la
// revisión humana ya ocurrió y el hold era un paso de más.

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

  return {
    ID: typeof id === 'number' ? id : Number(id) || undefined,
    Email: String(email),
    FirstName: String(first ?? ''),
    LastName: String(last ?? ''),
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

  return {
    CustomerDetails: customerDetails(customer),
    OrderDetails: {
      CompanyID: cfg.companyId,
      Channel: CHANNEL_WHOLESALE,
      ...(Number.isFinite(salesRep) && salesRep > 0 ? { SalesRepresentative: salesRep } : {}),
      ...(Number.isFinite(marketing) && marketing > 0 ? { MarketingSource: marketing } : {}),
    },
    ...addressesOf(customer),
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
export async function pushOrder(
  cfg: Config,
  sellercloudId: number,
  items: OrderItem[],
  extras: OrderExtras = {},
  f: Fetcher = fetch,
  now = Date.now,
): Promise<{ orderId: number }> {
  const token = await getToken(cfg, now, f)
  const customer = await getCustomer(cfg, token, sellercloudId, f)
  const payload = buildOrderPayload(cfg, customer, items, extras)
  const orderId = await createOrder(cfg, token, payload, f)
  return { orderId }
}
