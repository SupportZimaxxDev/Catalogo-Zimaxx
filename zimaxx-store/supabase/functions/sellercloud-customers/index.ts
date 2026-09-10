// Clientes ↔ SellerCloud: búsqueda, alta y vinculación (2026-09-02, a pedido
// del usuario). El botón "Enviar a SellerCloud" exige clients.sellercloud_id
// y la mayoría lo tenía vacío; además el alta de clientes no asignaba el ID,
// así que el problema se regeneraba solo. Esta función es el único camino del
// panel hacia la API de Customers:
//
//   * action: 'search' — busca candidatos por email → teléfono → nombre (en
//     ese orden de confianza; el nombre solo si los otros no dieron nada).
//   * action: 'create' — BUSCA ANTES DE CREAR: si hay coincidencias devuelve
//     los candidatos sin crear (exists: true) y el humano decide vincular o
//     crear igual (force: true). El create manda First/Last Name partidos
//     (SellerCloud valida Last Name al crear órdenes — "Customer's last name
//     is not valid", 2026-08-31) y el teléfono va en un SEGUNDO paso (PUT
//     Phone1: el CreateCustomerRequest no tiene campo de teléfono), mejor-
//     esfuerzo con aviso. Según el Swagger del servidor, la API solo exige
//     FirstName — el email es opcional también para nosotros.
//   * action: 'link' — verifica que el ID exista allá (GET /Customers/{id})
//     y recién ahí guarda, vía la RPC link_sellercloud_customer con el JWT de
//     quien llama: el PERMISO vive en la RPC (admin cualquiera, vendedora sus
//     clientes) y la vinculación queda auditada sí o sí.
//   * action: 'update' (2026-09-09) — manda la FICHA del cliente ya vinculado
//     a SellerCloud: PUT /Customers/{id} con BusinessName / AccountManager1Id
//     / Salesman / Comments (+ Phone1) y POST al grupo de clientes. La ficha
//     se lee de la fila local (clients.business_name, sc_*), que el panel
//     guarda ANTES vía la RPC update_client_sc_profile (auditada). Lo usa
//     "Guardar" de la edición cuando el cliente tiene sellercloud_id.
//
// Ficha SellerCloud (2026-09-09, a pedido del usuario: "el cliente se debe
// crear con business name, customer group, account manager, salesmen y
// comments"): el create manda BusinessName; el resto NO lo acepta el
// CreateCustomerRequest, así que va en el mismo PUT que el teléfono (un solo
// segundo paso) y el grupo en un POST aparte. Los tres pasos posteriores al
// create son mejor-esfuerzo: el customer YA existe, se vincula igual y lo que
// no entró se devuelve como `warning` para que la persona lo cargue allá.
//
// Mismos principios que sellercloud-push-order: la lógica de la API vive en
// sellercloud.ts (sin nada de Deno, testeable desde Node), esta función nunca
// usa la service_role key (todo con el JWT del caller: RLS y las RPC deciden),
// y todo fallo queda en system_logs (source 'sellercloud_customers') sin
// romper jamás la creación local del cliente — eso lo garantiza el frontend
// creando localmente ANTES de llamar acá.
//
// Deploy (una sola vez): supabase functions deploy sellercloud-customers
// Usa los MISMOS secrets de SellerCloud que el push (ya cargados).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import {
  addCustomerToGroup,
  createCustomer,
  getCustomer,
  getToken,
  normalizeBaseUrl,
  searchCustomers,
  updateCustomer,
  type Config,
  type CustomerFields,
  type CustomerSummary,
} from '../sellercloud-push-order/sellercloud.ts'

// Candado del alta (hotfix 2026-09-09): con false, action:'create' responde
// 503 antes de leer nada — va también acá porque un bundle viejo abierto en un
// navegador seguiría mandando create. 'search', 'link' y 'update' no se tocan.
// Pareja de SC_CREATE_ENABLED en src/pages/admin/ClientsAdmin.jsx.
//
// VALOR POR RAMA (decisión del usuario, 2026-09-10):
//   * main / producción → false (la versión viva v4 lo tiene en false).
//   * dev → true: es la rama donde se repara la creación de clientes y para
//     probarla la función tiene que aceptar create.
// Al redesplegar desde dev, el candado del servidor se abre para TODOS los
// frontends; la protección que queda en producción es el flag del frontend de
// main (toggle deshabilitado + guard en createSc).
const CREATE_ENABLED = true

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function config(): Config {
  const raw = Deno.env.get('SELLERCLOUD_BASE_URL') ?? ''
  const baseUrl = normalizeBaseUrl(raw)
  const username = Deno.env.get('SELLERCLOUD_USERNAME')
  const password = Deno.env.get('SELLERCLOUD_PASSWORD')
  const companyId = Number(Deno.env.get('SELLERCLOUD_COMPANY_ID'))
  if (!baseUrl || !username || !password || !Number.isFinite(companyId)) {
    throw new Error(
      'faltan secrets de SellerCloud (SELLERCLOUD_BASE_URL / USERNAME / PASSWORD / COMPANY_ID)',
    )
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(
      `SELLERCLOUD_BASE_URL tiene que empezar con https:// (está cargado como "${raw}")`,
    )
  }
  return { baseUrl, username, password, companyId, warehouseId: null }
}

// Mismo criterio que logPush en sellercloud-push-order: por RPC con el JWT
// del caller, y un fallo del log jamás rompe la acción.
async function logCustomers(
  caller: ReturnType<typeof createClient>,
  severity: 'info' | 'warning' | 'error' | 'critical',
  event: string,
  message: string | null,
  context: Record<string, unknown>,
) {
  try {
    await caller.rpc('log_event', {
      p_severity: severity,
      p_source: 'sellercloud_customers',
      p_event: event,
      p_message: message ? message.slice(0, 2000) : null,
      p_context: context,
    })
  } catch {
    /* el log se pierde en silencio */
  }
}

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '')

// La fila local del cliente con su ficha SellerCloud. Las columnas de la
// ficha existen desde migration-2026-09-09-client-sellercloud-profile.sql; si
// la función se despliega antes de correrla, el select cae al shape viejo
// (42703 = columna inexistente) y la ficha queda vacía en vez de romper el
// alta — la migración manda, la función no puede exigirla.
type ClientRow = {
  id: string
  name: string
  phone: string | null
  email: string | null
  sellercloud_id: number | null
  business_name?: string | null
  sc_customer_group_id?: number | null
  sc_customer_group_name?: string | null
  sc_account_manager_id?: number | null
  sc_salesman?: string | null
  sc_comments?: string | null
}

const CLIENT_COLS_FULL =
  'id, name, phone, email, sellercloud_id, business_name, sc_customer_group_id, sc_customer_group_name, sc_account_manager_id, sc_salesman, sc_comments'
const CLIENT_COLS_LEGACY = 'id, name, phone, email, sellercloud_id'

async function loadClient(
  caller: ReturnType<typeof createClient>,
  clientId: string,
): Promise<{ client: ClientRow | null; error: string | null }> {
  let res = await caller.from('clients').select(CLIENT_COLS_FULL).eq('id', clientId).maybeSingle()
  if (res.error?.code === '42703') {
    res = await caller.from('clients').select(CLIENT_COLS_LEGACY).eq('id', clientId).maybeSingle()
  }
  if (res.error) return { client: null, error: res.error.message }
  return { client: (res.data as ClientRow | null) ?? null, error: null }
}

// La ficha que viaja a SellerCloud, desde la fila local. El teléfono entra
// acá también (Phone1 va en el mismo PUT). El grupo se maneja aparte (es otro
// endpoint).
function profileFields(client: ClientRow, phone?: string | null): CustomerFields {
  return {
    phone: phone || digits(client.phone) || null,
    businessName: client.business_name ?? null,
    accountManagerId: client.sc_account_manager_id ?? null,
    salesman: client.sc_salesman ?? null,
    comments: client.sc_comments ?? null,
  }
}

// PUT de la ficha + POST al grupo, mejor-esfuerzo: devuelve qué entró y los
// avisos de lo que no. Nunca lanza — el llamador decide qué hacer con los
// warnings (tras un create el customer ya existe; en 'update' es todo lo que
// hay que reportar).
async function pushProfile(
  cfg: Config,
  token: string,
  scId: number,
  client: ClientRow,
  phone?: string | null,
): Promise<{ applied: string[]; group: number | null; warnings: string[] }> {
  const warnings: string[] = []
  let applied: string[] = []
  try {
    applied = await updateCustomer(cfg, token, scId, profileFields(client, phone))
  } catch (e) {
    warnings.push(
      `El cliente está en SellerCloud (#${scId}) pero no se pudo cargar su ficha (teléfono/empresa/account manager/salesman/comentarios): ${(e as Error).message}. Cargala allá.`,
    )
  }
  let group: number | null = null
  const gid = Number(client.sc_customer_group_id)
  if (client.sc_customer_group_id != null && Number.isInteger(gid) && gid > 0) {
    try {
      await addCustomerToGroup(cfg, token, gid, scId)
      group = gid
    } catch (e) {
      warnings.push(
        `No se pudo agregar al grupo ${client.sc_customer_group_name ?? gid} en SellerCloud: ${(e as Error).message}. Agregalo allá.`,
      )
    }
  }
  return { applied, group, warnings }
}

// Un candidato como lo consume el panel. El teléfono no viene en el DTO del
// listado — se completa (mejor-esfuerzo) leyendo el detalle de cada candidato,
// acotado a los primeros para no multiplicar llamadas.
type Candidate = {
  id: number
  name: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  business: string | null
  matched_by: 'email' | 'phone' | 'name'
}

const MAX_CANDIDATES = 8

function toCandidate(c: CustomerSummary, matchedBy: Candidate['matched_by']): Candidate {
  return {
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.business || `#${c.id}`,
    first_name: c.firstName,
    last_name: c.lastName,
    email: c.email,
    phone: c.phone,
    business: c.business,
    matched_by: matchedBy,
  }
}

// Búsqueda con la escalera de confianza. Email y teléfono son llaves fuertes;
// el nombre (model.keyword) solo se consulta si las fuertes no dieron nada —
// un keyword genérico devolvería medio SellerCloud.
async function findCandidates(
  cfg: Config,
  token: string,
  q: { email?: string | null; phone?: string | null; name?: string | null },
): Promise<Candidate[]> {
  const seen = new Map<number, Candidate>()
  const add = (items: CustomerSummary[], by: Candidate['matched_by']) => {
    for (const c of items) if (!seen.has(c.id)) seen.set(c.id, toCandidate(c, by))
  }

  const email = String(q.email ?? '').trim().toLowerCase()
  if (email) {
    const { items } = await searchCustomers(cfg, token, { email })
    add(items, 'email')
  }

  const tel = digits(q.phone)
  if (tel.length >= 7) {
    let { items } = await searchCustomers(cfg, token, { phone: tel })
    // El comportamiento exacto del filtro (¿exacto?, ¿contiene?) no está
    // documentado: si el número completo con código de país no encuentra
    // nada, se reintenta con el número nacional (últimos 10 dígitos).
    if (items.length === 0 && tel.length > 10) {
      items = (await searchCustomers(cfg, token, { phone: tel.slice(-10) })).items
    }
    // Los hits por teléfono ya traen el teléfono confirmado por el servidor.
    add(items.map((c) => ({ ...c, phone: c.phone ?? tel })), 'phone')
  }

  const name = String(q.name ?? '').trim()
  if (seen.size === 0 && name) {
    const { items } = await searchCustomers(cfg, token, { keyword: name })
    add(items, 'name')
  }

  const out = [...seen.values()].slice(0, MAX_CANDIDATES)

  // Completar teléfono/email desde el detalle (Personal.Phone1 / General):
  // mejor-esfuerzo — un candidato sin teléfono visible sigue siendo elegible.
  await Promise.all(
    out.map(async (c) => {
      if (c.phone && c.email) return
      try {
        const detail = await getCustomer(cfg, token, c.id)
        const d = detail as Record<string, any>
        c.phone =
          c.phone ??
          (String(
            d?.Personal?.Phone1 ?? d?.Personal?.Mobile ?? d?.Phone1 ?? d?.Phone ?? '',
          ).trim() || null)
        c.email = c.email ?? (String(d?.General?.Email ?? d?.Email ?? '').trim().toLowerCase() || null)
      } catch {
        /* sin detalle: se muestra lo que hay */
      }
    }),
  )
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  const caller = createClient(SUPABASE_URL!, ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'body inválido' }, 400)
  }
  const action = String(body.action ?? '')

  // El rol se valida ACÁ además de en la RPC de vinculación: 'search' y
  // 'create' hablan con la API de SellerCloud y no tocan ninguna tabla — sin
  // este candado cualquier token authenticated podría usarnos de proxy de
  // búsqueda. get_my_role devuelve null para un usuario sin rol.
  const { data: role } = await caller.rpc('get_my_role')
  if (role !== 'admin' && role !== 'vendedora') {
    return json({ error: 'no autorizado' }, 403)
  }

  // ---------- search ----------
  if (action === 'search') {
    try {
      const cfg = config()
      const token = await getToken(cfg)
      const candidates = await findCandidates(cfg, token, {
        email: body.email as string,
        phone: body.phone as string,
        name: body.name as string,
      })
      return json({ ok: true, candidates })
    } catch (e) {
      const message = (e as Error).message ?? 'error desconocido'
      await logCustomers(caller, 'error', 'search_failed', message, {
        email: body.email ?? null,
        phone: body.phone ?? null,
        name: body.name ?? null,
      })
      return json({ error: message }, 502)
    }
  }

  // ---------- link ----------
  if (action === 'link') {
    const clientId = String(body.client_id ?? '')
    const scId = Number(body.sellercloud_id)
    if (!clientId || !Number.isFinite(scId) || scId <= 0) {
      return json({ error: 'faltan client_id / sellercloud_id' }, 400)
    }
    // Verificar que el customer EXISTA allá antes de guardar nada: este flujo
    // es guiado justamente para que nunca quede escrito un ID inventado.
    let scName: string | null = null
    let scEmail: string | null = null
    try {
      const cfg = config()
      const token = await getToken(cfg)
      const d = (await getCustomer(cfg, token, scId)) as Record<string, any>
      scName =
        String(
          d?.General?.Name ??
            [d?.General?.FirstName ?? d?.FirstName, d?.General?.LastName ?? d?.LastName]
              .filter(Boolean)
              .join(' '),
        ).trim() || null
      scEmail = String(d?.General?.Email ?? d?.Email ?? '').trim().toLowerCase() || null
    } catch (e) {
      const message = (e as Error).message ?? 'error desconocido'
      await logCustomers(caller, 'error', 'link_verify_failed', message, {
        client_id: clientId,
        sellercloud_id: scId,
      })
      return json({ error: `no se pudo verificar ese ID en SellerCloud: ${message}` }, 502)
    }

    const { data, error } = await caller.rpc('link_sellercloud_customer', {
      p_client_id: clientId,
      p_sellercloud_id: scId,
      p_detail: { sc_name: scName, sc_email: scEmail, via: 'search' },
    })
    if (error) return json({ error: error.message }, 400)
    await logCustomers(caller, 'info', 'link_ok', `Cliente vinculado a SellerCloud #${scId}`, {
      client_id: clientId,
      sellercloud_id: scId,
      sc_name: scName,
    })
    return json({ ok: true, sellercloud_id: scId, sc_name: scName, changed: data?.changed ?? true })
  }

  // ---------- create ----------
  if (action === 'create') {
    if (!CREATE_ENABLED) {
      return json({ error: 'El alta de clientes en SellerCloud está temporalmente desactivada.' }, 503)
    }
    const clientId = String(body.client_id ?? '')
    const firstName = String(body.first_name ?? '').trim()
    const lastName = String(body.last_name ?? '').trim()
    const email = String(body.email ?? '').trim().toLowerCase()
    const phone = digits(body.phone)
    const force = body.force === true
    if (!clientId) return json({ error: 'falta client_id' }, 400)
    // Apellido obligatorio ACÁ aunque la API solo exija FirstName: sin Last
    // Name el customer nace inválido para crear órdenes (2026-08-31).
    if (!firstName || !lastName) return json({ error: 'hacen falta nombre y apellido' }, 400)

    // El cliente local, leído con el JWT del caller: RLS ya recorta a una
    // vendedora a los suyos — un cliente ajeno simplemente "no existe". Trae
    // la ficha SellerCloud (empresa/grupo/account manager/salesman/
    // comentarios) que el panel ya guardó en la fila.
    const { client, error: clientError } = await loadClient(caller, clientId)
    if (clientError) return json({ error: clientError }, 400)
    if (!client) return json({ error: 'cliente no encontrado' }, 404)
    if (client.sellercloud_id) {
      return json({ ok: true, already_linked: true, sellercloud_id: client.sellercloud_id })
    }

    const logContext = {
      client_id: clientId,
      client: client.name,
      email: email || null,
      business: client.business_name ?? null,
      group_id: client.sc_customer_group_id ?? null,
      account_manager_id: client.sc_account_manager_id ?? null,
      salesman: client.sc_salesman ?? null,
      comments: client.sc_comments ?? null,
    }

    let cfg: Config
    let token: string
    try {
      cfg = config()
      token = await getToken(cfg)

      // Buscar ANTES de crear (salvo force: el humano ya vio los candidatos y
      // decidió crear igual). Solo llaves fuertes: email y teléfono.
      if (!force) {
        const candidates = await findCandidates(cfg, token, {
          email: email || client.email,
          phone: phone || client.phone,
        })
        if (candidates.length > 0) {
          return json({ ok: true, exists: true, candidates })
        }
      }
    } catch (e) {
      const message = (e as Error).message ?? 'error desconocido'
      await logCustomers(caller, 'error', 'create_failed', message, logContext)
      return json({ error: message }, 502)
    }

    let scId: number
    try {
      // BusinessName es lo único de la ficha que el create acepta.
      scId = await createCustomer(cfg, token, {
        firstName,
        lastName,
        email: email || null,
        business: client.business_name ?? null,
      })
    } catch (e) {
      const message = (e as Error).message ?? 'error desconocido'
      await logCustomers(caller, 'error', 'create_failed', message, logContext)
      return json({ error: message }, 502)
    }

    // Segundo paso: teléfono + ficha en UN PUT (el create no los acepta) y el
    // grupo en su POST. Mejor-esfuerzo — el customer YA existe, así que lo que
    // falle se degrada a warning, nunca a error, y se vincula igual.
    const pushed = await pushProfile(cfg, token, scId, client, phone)
    const warning = pushed.warnings.length ? pushed.warnings.join(' ') : null

    // Vincular acá, auditado por la RPC. Si ESTO falla, el customer ya existe
    // allá y no quedó anotado — mismo estado peligroso que push_annotate_failed:
    // critical + el ID en el error para vincular a mano, NUNCA volver a crear.
    const { error: linkError } = await caller.rpc('link_sellercloud_customer', {
      p_client_id: clientId,
      p_sellercloud_id: scId,
      p_detail: {
        sc_name: `${firstName} ${lastName}`,
        sc_email: email || null,
        via: 'create',
      },
    })
    if (linkError) {
      await logCustomers(
        caller,
        'critical',
        'create_annotate_failed',
        `El cliente se creó en SellerCloud (#${scId}) pero no se pudo vincular acá: ${linkError.message}`,
        { ...logContext, sellercloud_id: scId },
      )
      return json(
        {
          error:
            `El cliente se creó en SellerCloud (#${scId}) pero no se pudo vincular acá: ` +
            `${linkError.message}. Vinculalo con "Buscar en SellerCloud" — NO lo vuelvas a crear.`,
          sellercloud_id: scId,
        },
        500,
      )
    }

    await logCustomers(caller, 'info', 'create_ok', `Cliente creado en SellerCloud (#${scId})`, {
      ...logContext,
      sellercloud_id: scId,
      applied: pushed.applied,
      group: pushed.group,
      warning,
    })
    return json({
      ok: true,
      created: true,
      sellercloud_id: scId,
      applied: pushed.applied,
      group: pushed.group,
      warning,
    })
  }

  // ---------- update (2026-09-09) ----------
  // Ficha → SellerCloud para un cliente YA vinculado. La fila local ya tiene
  // la ficha nueva (el panel la guardó con update_client_sc_profile, que es
  // quien valida permisos y audita); acá solo se empuja. Sin vínculo no hay
  // a quién actualizar: 409, el panel ofrece "Buscar en SellerCloud".
  if (action === 'update') {
    const clientId = String(body.client_id ?? '')
    if (!clientId) return json({ error: 'falta client_id' }, 400)
    const { client, error: clientError } = await loadClient(caller, clientId)
    if (clientError) return json({ error: clientError }, 400)
    if (!client) return json({ error: 'cliente no encontrado' }, 404)
    const scId = Number(client.sellercloud_id)
    if (!Number.isFinite(scId) || scId <= 0) {
      return json({ error: 'este cliente todavía no está vinculado a SellerCloud' }, 409)
    }
    const logContext = {
      client_id: clientId,
      client: client.name,
      sellercloud_id: scId,
      business: client.business_name ?? null,
      group_id: client.sc_customer_group_id ?? null,
      account_manager_id: client.sc_account_manager_id ?? null,
      salesman: client.sc_salesman ?? null,
      comments: client.sc_comments ?? null,
    }
    let cfg: Config
    let token: string
    try {
      cfg = config()
      token = await getToken(cfg)
    } catch (e) {
      const message = (e as Error).message ?? 'error desconocido'
      await logCustomers(caller, 'error', 'update_failed', message, logContext)
      return json({ error: message }, 502)
    }
    const pushed = await pushProfile(cfg, token, scId, client)
    const warning = pushed.warnings.length ? pushed.warnings.join(' ') : null
    if (pushed.applied.length === 0 && pushed.group == null) {
      // Nada entró: o la ficha está vacía (nada que mandar) o todo falló.
      if (warning) {
        await logCustomers(caller, 'error', 'update_failed', warning, logContext)
        return json({ error: warning }, 502)
      }
      return json({ ok: true, sellercloud_id: scId, applied: [], group: null, warning: null })
    }
    await logCustomers(
      caller,
      warning ? 'warning' : 'info',
      'update_ok',
      `Ficha actualizada en SellerCloud (#${scId})`,
      { ...logContext, applied: pushed.applied, group: pushed.group, warning },
    )
    return json({ ok: true, sellercloud_id: scId, applied: pushed.applied, group: pushed.group, warning })
  }

  return json({ error: `acción desconocida: ${action}` }, 400)
})
