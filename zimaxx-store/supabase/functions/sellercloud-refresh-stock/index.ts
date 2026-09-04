// Refrescar el stock desde SellerCloud a pedido (2026-09-04, a pedido del
// usuario). El stock entra hoy por la carga de Excel dos veces al día y entre
// cargas el catálogo queda desalineado con el inventario real: este es el
// botón "🔄 Refrescar stock" del panel — trae el inventario disponible por la
// API (paginado completo, companyID del negocio) y actualiza SOLO
// products.stock, dejando que los triggers de la tabla decidan disponibilidad
// y publicación (la misma invariante que la carga de Excel).
//
// Toda la lógica vive en ./refresh.ts y ../sellercloud-push-order/
// sellercloud.ts, que no importan nada de Deno — se prueban desde Node contra
// un servidor falso (tests/stock-refresh-tests.mjs). Este archivo solo ata el
// runtime: CORS, auth y secrets.
//
// Permisos: pueden refrescar admins Y vendedoras (el refresco solo alinea el
// stock con la verdad de SellerCloud, no hay nada que abusar) — la regla
// vive en las RPCs (inventory_sync_begin/refresh_stock_upsert exigen
// is_admin() o is_vendedora()), que se llaman CON EL JWT de quien apretó.
// Esta función nunca usa la service_role key, igual que el push.
//
// Deploy (una sola vez, desde zimaxx-store/):
//   supabase functions deploy sellercloud-refresh-stock
// Usa los MISMOS secrets de SellerCloud que el push (ya cargados).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { normalizeBaseUrl, type Config } from '../sellercloud-push-order/sellercloud.ts'
import { runStockRefresh } from './refresh.ts'

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

// Mismo criterio que logPush en sellercloud-push-order: el log va por la RPC
// con el JWT de quien apretó, nunca lanza, y un fallo del log jamás rompe el
// refresco. Fuente 'stock_refresh' (pedida por el usuario para los fallos).
async function logRefresh(
  caller: ReturnType<typeof createClient>,
  severity: 'info' | 'warning' | 'error',
  event: string,
  message: string | null,
  context: Record<string, unknown>,
) {
  try {
    await caller.rpc('log_event', {
      p_severity: severity,
      p_source: 'stock_refresh',
      p_event: event,
      p_message: message ? message.slice(0, 2000) : null,
      p_context: context,
    })
  } catch {
    /* el log se pierde en silencio; el refresco sigue su curso */
  }
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  const caller = createClient(SUPABASE_URL!, ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  })

  // Anónimos afuera de entrada, con un mensaje claro. El permiso fino
  // (admin/vendedora) lo deciden las RPCs — acá solo se corta lo obvio para
  // no gastar un token de SellerCloud en un request sin sesión.
  const jwt = authHeader.replace(/^Bearer\s+/i, '')
  const { data: auth } = await caller.auth.getUser(jwt)
  if (!auth?.user) {
    return json({ error: 'no autorizado: hace falta la sesión del panel' }, 401)
  }

  let cfg: Config
  try {
    cfg = config()
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }

  const rpc = (name: string, args: Record<string, unknown>) => caller.rpc(name, args)
  const result = await runStockRefresh(cfg, rpc)

  if (!result.ok) {
    // Un refresco en curso (409) no es un fallo: no se loguea como error.
    if (result.code !== 'refresh_in_progress') {
      await logRefresh(caller, 'error', 'refresh_failed', result.error, {
        pressed_by: auth.user.email ?? null,
      })
    }
    return json({ error: result.error, code: result.code ?? null }, result.status)
  }

  await logRefresh(
    caller,
    'info',
    'refresh_ok',
    `Stock refrescado desde SellerCloud: ${result.totals.updated} actualizados, ` +
      `${result.totals.deactivated} desactivados, ${result.totals.reactivated} reactivados`,
    {
      pressed_by: auth.user.email ?? null,
      run_id: result.run_id,
      duration_ms: result.duration_ms,
      ...result.totals,
    },
  )

  return json({
    ok: true,
    run_id: result.run_id,
    duration_ms: result.duration_ms,
    ...result.totals,
  })
})
