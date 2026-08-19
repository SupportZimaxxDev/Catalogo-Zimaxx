// Mandar un pedido a SellerCloud (2026-08-17, a pedido del usuario; modalidad
// cambiada el 2026-08-18). Reemplaza el paso manual de bajar el Excel de la
// orden y subirlo al bulk-order upload de SellerCloud: la vendedora aprieta
// "Enviar a SellerCloud" en la bandeja de Pedidos y la orden se crea allá,
// asociada a su correo como Sales Rep y con Marketing Source "catalogo
// online". Sin On Hold: el control humano pasó a estar ANTES — solo un pedido
// ya marcado **Atendido** se puede enviar, así que la revisión ya ocurrió.
//
// Tiene que ser una Edge Function y no una RPC de Postgres porque el usuario y
// la contraseña de la API de SellerCloud no pueden estar en el navegador ni en
// la base. Toda la lógica de la API vive en ./sellercloud.ts, que no importa
// nada de Deno justamente para poder probarla desde Node contra un servidor
// falso.
//
// Deploy (una sola vez, no está automatizado):
//   supabase functions deploy sellercloud-push-order
//   supabase secrets set SELLERCLOUD_BASE_URL=https://XX.api.sellercloud.com \
//                        SELLERCLOUD_USERNAME=... \
//                        SELLERCLOUD_PASSWORD=... \
//                        SELLERCLOUD_COMPANY_ID=... \
//                        SELLERCLOUD_WAREHOUSE_ID=...      # opcional
// SUPABASE_URL / SUPABASE_ANON_KEY ya vienen inyectadas por el runtime.
//
// Permiso y auditoría NO se deciden acá: los decide la RPC
// mark_order_sellercloud, que se llama con el JWT de quien apretó el botón
// (mismo criterio que admin-create-vendedora-user con is_admin()). Esta
// función nunca usa la service_role key.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import {
  findSalesRepIdByEmail,
  getToken,
  normalizeBaseUrl,
  pushOrder,
  type Config,
  type OrderExtras,
  type OrderItem,
} from './sellercloud.ts'

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
  const warehouseId = Number(Deno.env.get('SELLERCLOUD_WAREHOUSE_ID')) || null
  if (!baseUrl || !username || !password || !Number.isFinite(companyId)) {
    throw new Error(
      'faltan secrets de SellerCloud (SELLERCLOUD_BASE_URL / USERNAME / PASSWORD / COMPANY_ID)',
    )
  }
  // Sin esquema, `fetch` tira "Invalid URL" y el panel muestra eso, que no
  // dice nada. El secret se carga a mano una sola vez: vale gastar una línea
  // en decir qué tiene de malo.
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(
      `SELLERCLOUD_BASE_URL tiene que empezar con https:// (está cargado como "${raw}")`,
    )
  }
  return { baseUrl, username, password, companyId, warehouseId }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  const caller = createClient(SUPABASE_URL!, ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  })

  let body: { order_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'body inválido' }, 400)
  }
  const orderId = body.order_id?.trim()
  if (!orderId) return json({ error: 'falta order_id' }, 400)

  // El pedido se lee CON EL JWT DE QUIEN LLAMA: RLS ya se encarga de que una
  // vendedora solo vea los suyos, así que si no lo puede ver, no lo puede
  // mandar. No hace falta repetir la regla acá.
  const { data: order, error: orderError } = await caller
    .from('orders')
    .select(
      'id, kind, status, items, total, sellercloud_order_id, clients(name, sellercloud_id, vendedora_id)',
    )
    .eq('id', orderId)
    .maybeSingle()

  if (orderError) return json({ error: orderError.message }, 400)
  if (!order) return json({ error: 'pedido no encontrado' }, 404)

  // Ya mandado: no se manda de nuevo. Duplicar una orden en SellerCloud
  // obliga a ir a cancelarla a mano allá.
  if (order.sellercloud_order_id) {
    return json({
      ok: true,
      already_pushed: true,
      sellercloud_order_id: order.sellercloud_order_id,
    })
  }

  // Una cotización no es una orden: no se monta en SellerCloud hasta que
  // alguien la convierta en pedido ("Convertir en pedido" en la bandeja).
  if (order.kind !== 'order') {
    return json({ error: 'solo se pueden mandar pedidos, no cotizaciones' }, 400)
  }
  if (order.status === 'cancelled') {
    return json({ error: 'este pedido está cancelado' }, 400)
  }

  // Solo pedidos Atendidos (2026-08-18): el envío ya no pone la orden On Hold
  // allá, así que la revisión humana es ESTE paso — marcarlo Atendido acá — y
  // no puede saltearse. De paso, atender el pedido ya descontó el stock local.
  if (order.status !== 'done') {
    return json({ error: 'marcá el pedido como Atendido antes de enviarlo a SellerCloud' }, 400)
  }

  const client = Array.isArray(order.clients) ? order.clients[0] : order.clients
  const sellercloudId = client?.sellercloud_id
  if (!sellercloudId) {
    return json(
      { error: 'este cliente todavía no está sincronizado con SellerCloud (no tiene ID allá)' },
      400,
    )
  }

  const items: OrderItem[] = (order.items ?? []).map((i: Record<string, unknown>) => ({
    sku: String(i.sku ?? ''),
    name: (i.name as string) ?? null,
    qty: Number(i.qty ?? 0),
    price: i.price == null ? null : Number(i.price),
  }))

  // Sales Rep: el correo de LA VENDEDORA DEL PEDIDO (2026-08-18, modalidad
  // definida por el usuario) — la orden se asocia a ella, apriete quien
  // apriete: si aprieta un admin, la venta sigue siendo de la vendedora del
  // cliente. La API solo acepta el ID de empleado, así que el correo se
  // resuelve a ID: primero el override cargado a mano en la pestaña
  // Vendedoras, después la búsqueda automática por email. Si no hay nada, la
  // orden entra sin Sales Rep y se avisa — nunca se pierde la orden por un
  // dato accesorio.
  let repId: number | null = null
  let repWarning: string | null = null
  {
    // El JWT va explícito: este cliente no tiene sesión (se creó solo con el
    // header), y getUser() sin argumento buscaría una sesión que no existe.
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    const { data: auth } = await caller.auth.getUser(jwt)
    const pressedBy = (auth?.user?.email ?? '').trim()

    // La fila de la vendedora del pedido. RLS deja leerla a la propia
    // vendedora (es su fila) y a cualquier admin.
    let owner: { id: string; sellercloud_rep_id: number | null; login_email: string | null } | null =
      null
    if (client?.vendedora_id) {
      const { data } = await caller
        .from('vendedores')
        .select('id, sellercloud_rep_id, login_email')
        .eq('id', client.vendedora_id)
        .maybeSingle()
      owner = data
    }

    // 1) El ID cargado a mano manda: es el override para cuando el correo de
    //    acá no coincide con el del empleado en SellerCloud.
    repId = owner?.sellercloud_rep_id ?? null

    // 2) Sin ID: se resuelve el CORREO contra SellerCloud. No hay endpoint de
    //    empleados, pero cada orden leída trae SalesRepEmail + SalesRepId
    //    juntos, así que se busca el login de la vendedora en las órdenes
    //    recientes. Solo si el cliente no tiene vendedora se usa el correo de
    //    quien apretó — con vendedora asignada, caer al correo de un admin
    //    atribuiría la venta a la persona equivocada. Lo encontrado se guarda
    //    en vendedores para no volver a escanear (con JWT de vendedora el
    //    update no pasa RLS y afecta 0 filas: no es error, el caché en
    //    memoria cubre mientras tanto).
    if (repId == null) {
      const candidatos = owner
        ? [{ email: (owner.login_email ?? '').trim(), rowId: owner.id }]
        : [{ email: pressedBy, rowId: null as string | null }]
      try {
        const cfg = config()
        const token = await getToken(cfg)
        for (const c of candidatos) {
          if (!c.email) continue
          const id = await findSalesRepIdByEmail(cfg, token, c.email)
          if (id != null) {
            repId = id
            if (c.rowId) {
              await caller.from('vendedores').update({ sellercloud_rep_id: id }).eq('id', c.rowId)
            }
            break
          }
        }
      } catch {
        // La búsqueda es mejor-esfuerzo: si falla, la orden sigue sin rep y
        // el aviso de abajo lo dice.
      }
    }

    if (repId == null) {
      const who = owner?.login_email || pressedBy || 'la vendedora del pedido'
      repWarning =
        `La orden entró sin Sales Rep: ${who} no tiene el ID cargado (pestaña Vendedoras) ` +
        'y su correo no aparece como Sales Rep en las órdenes recientes de SellerCloud — ' +
        'el email del empleado allá tiene que ser el mismo, o cargá el ID a mano.'
    }
  }

  // Marketing Source: un solo valor global ("catalogo online"). La API solo
  // acepta el ID de la lista de SellerCloud, así que vive en un secret, como
  // COMPANY_ID. Sin secret, el campo no viaja y se avisa.
  const marketingSourceId = Number(Deno.env.get('SELLERCLOUD_MARKETING_SOURCE_ID')) || null
  const marketingWarning = marketingSourceId
    ? null
    : 'La orden entró sin Marketing Source: falta el secret SELLERCLOUD_MARKETING_SOURCE_ID ' +
      '(el ID de "catalogo online" en SellerCloud).'

  const extras: OrderExtras = { salesRepId: repId, marketingSourceId }

  let result: { orderId: number; warnings: string[] }
  try {
    result = await pushOrder(config(), Number(sellercloudId), items, extras)
  } catch (e) {
    const message = (e as Error).message ?? 'error desconocido'
    // Queda anotado en el pedido para que se vea en el panel en vez de
    // perderse en los logs de la función.
    await caller.rpc('mark_order_sellercloud', {
      p_order_id: orderId,
      p_sellercloud_order_id: null,
      p_error: message,
    })
    return json({ error: message }, 502)
  }

  // Datos que faltaron y se corrigen para la próxima orden, no para esta —
  // más lo que pushOrder no pudo dejar aplicado en la orden ya creada
  // (2026-08-19: el Sales Rep se asigna con un PUT posterior al create y se
  // verifica releyendo; si algo de eso falla, la orden queda y acá se avisa).
  const warning =
    [repWarning, marketingWarning, ...result.warnings].filter(Boolean).join(' | ') || null

  // La orden ya existe en SellerCloud: pase lo que pase con esta llamada, hay
  // que dejar anotado el número. Si esto fallara, el próximo intento crearía
  // una orden duplicada — por eso el error se devuelve con el número adentro.
  const { data: marked, error: markError } = await caller.rpc('mark_order_sellercloud', {
    p_order_id: orderId,
    p_sellercloud_order_id: result.orderId,
    p_error: warning,
  })
  if (markError) {
    return json(
      {
        error: `La orden se creó en SellerCloud (#${result.orderId}) pero no se pudo anotar acá: ${markError.message}. NO la vuelvas a mandar.`,
        sellercloud_order_id: result.orderId,
      },
      500,
    )
  }

  return json({
    ok: true,
    sellercloud_order_id: result.orderId,
    warning,
    already_pushed: marked?.already_pushed ?? false,
  })
})
