// Orquestación del refresco de stock (2026-09-04). Deliberadamente SIN nada
// de Deno — mismo patrón que sellercloud.ts: toda la lógica vive acá y se
// prueba desde Node con un servidor falso y un rpc stub; index.ts es el único
// archivo que toca el runtime de Edge Functions.
//
// Qué hace: pagina el inventario de SellerCloud (companyID del negocio,
// páginas de 50 — el máximo documentado del endpoint) y lo aplica por chunks
// con la RPC refresh_stock_upsert, que toca SOLO products.stock y deja que
// los triggers de la tabla decidan disponibilidad y publicación (la MISMA
// invariante que la carga de Excel — acá no hay reglas de stock propias).
//
// El ciclo de la corrida (running → ok/error) y el lock anti-concurrencia
// viven en la base (inventory_sync_begin/finish): si dos personas aprietan el
// botón a la vez, la segunda recibe ZS002 y acá se traduce a un 409 claro.
//
// DURACIÓN con el catálogo real (~3,450 productos de catálogo, ~3,700 SKUs en
// SellerCloud): ~74 páginas de 50 + ~8 chunks de 500 a la RPC. A ~300-500 ms
// por página secuencial son ~25-40 s de pared — holgado contra el tope de las
// Edge Functions (150 s de wall-clock en el plan free, 400 s en paid). El
// token se renueva por página vía getToken (cachea 55 min), la lección del
// backfill de customers del 2026-09-03.

import {
  fetchInventoryPage,
  getToken,
  type Config,
  type InventoryRow,
} from '../sellercloud-push-order/sellercloud.ts'

type Fetcher = typeof fetch

// El cliente de RPCs se inyecta (supabase-js con el JWT del caller en
// producción, un stub en los tests): esta capa no sabe nada de Supabase.
export type RpcResult = { data: any; error: { message: string; code?: string } | null }
export type RpcClient = (name: string, args: Record<string, unknown>) => Promise<RpcResult>

export type RefreshTotals = {
  sellercloud_items: number
  pages: number
  updated: number
  unchanged: number
  deactivated: number
  reactivated: number
  unknown_skus: number
  invalid_rows: number
  skipped_noncatalog: number
}

export type RefreshOutcome =
  | { ok: true; run_id: string; duration_ms: number; totals: RefreshTotals }
  | { ok: false; status: number; error: string; code?: string }

// Cuántas filas por llamada a refresh_stock_upsert. 500 = ~10 páginas de
// SellerCloud por round-trip a la base; el payload jsonb queda en ~25 KB.
const CHUNK_SIZE = 500

// Cortafuegos contra un TotalResults mentiroso o un servidor que repite la
// última página para siempre (mismos cortes que listAllCustomers): se corta
// por total alcanzado o por página sin ningún SKU nuevo, nunca por "vinieron
// menos de los pedidos".
const MAX_PAGES = 400

function rpcErrorMessage(prefix: string, error: { message: string; code?: string }): string {
  return `${prefix}: ${error.message}${error.code ? ` (${error.code})` : ''}`
}

export async function runStockRefresh(
  cfg: Config,
  rpc: RpcClient,
  f: Fetcher = fetch,
  now: () => number = Date.now,
): Promise<RefreshOutcome> {
  const t0 = now()

  // ---- 1) Abrir la corrida (lock anti-concurrencia del lado de la base) ----
  const begin = await rpc('inventory_sync_begin', { p_source: 'manual_refresh' })
  if (begin.error) {
    // ZS002 = ya hay una corrida en curso: no es un fallo del sistema, es el
    // lock haciendo su trabajo — 409 con el mensaje de la base (trae hace
    // cuántos minutos empezó la otra).
    if (begin.error.code === 'ZS002') {
      return { ok: false, status: 409, error: begin.error.message, code: 'refresh_in_progress' }
    }
    return {
      ok: false,
      status: 400,
      error: rpcErrorMessage('No se pudo abrir la corrida de inventario', begin.error),
    }
  }
  const runId = String(begin.data?.id ?? '')

  const totals: RefreshTotals = {
    sellercloud_items: 0,
    pages: 0,
    updated: 0,
    unchanged: 0,
    deactivated: 0,
    reactivated: 0,
    unknown_skus: 0,
    invalid_rows: 0,
    skipped_noncatalog: 0,
  }

  // Cerrar SIEMPRE la corrida, pase lo que pase: una 'running' huérfana
  // bloquea el botón hasta que el próximo begin la marque colgada (10 min).
  const finish = async (status: 'ok' | 'error', errorMessage: string | null) => {
    const res = await rpc('inventory_sync_finish', {
      p_id: runId,
      p_status: status,
      p_products_updated: totals.updated,
      p_deactivated_count: totals.deactivated,
      p_reactivated_count: totals.reactivated,
      p_error: errorMessage,
    })
    return res
  }

  const buffer: InventoryRow[] = []
  const flush = async () => {
    if (buffer.length === 0) return
    const chunk = buffer.splice(0, buffer.length)
    const res = await rpc('refresh_stock_upsert', {
      p_rows: chunk.map((r) => ({ sku: r.sku, qty: r.qty })),
    })
    if (res.error) {
      throw new Error(rpcErrorMessage('La base rechazó un chunk de stock', res.error))
    }
    totals.updated += Number(res.data?.updated ?? 0)
    totals.unchanged += Number(res.data?.unchanged ?? 0)
    totals.deactivated += Number(res.data?.deactivated ?? 0)
    totals.reactivated += Number(res.data?.reactivated ?? 0)
    totals.unknown_skus += Number(res.data?.unknown_skus ?? 0)
    totals.invalid_rows += Number(res.data?.invalid_rows ?? 0)
    totals.skipped_noncatalog += Number(res.data?.skipped_noncatalog ?? 0)
  }

  try {
    // ---- 2) Paginar el inventario completo y aplicarlo por chunks ----
    const seen = new Set<string>()
    let total = 0
    for (let page = 1; page <= MAX_PAGES; page++) {
      // Token por página vía getToken (cachea y se renueva solo a los 55
      // min): una corrida nunca muere por token vencido a mitad del loop.
      const token = await getToken(cfg, now, f)
      const pageResult = await fetchInventoryPage(cfg, token, page, f)
      total = pageResult.total
      if (pageResult.rows.length === 0 && pageResult.skipped === 0) break
      totals.pages++
      totals.invalid_rows += pageResult.skipped

      let fresh = 0
      for (const row of pageResult.rows) {
        const key = row.sku.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        fresh++
        buffer.push(row)
        if (buffer.length >= CHUNK_SIZE) await flush()
      }
      totals.sellercloud_items = seen.size

      if (seen.size >= total && total > 0) break
      // Página sin ningún SKU nuevo = el servidor repite la última página.
      if (fresh === 0 && pageResult.rows.length > 0) break
    }
    await flush()

    // Cero ítems no es una corrida buena: marcar 'ok' acá diría "inventario
    // fresco" sin haber refrescado nada (misma regla que la carga de Excel,
    // que rechaza un archivo vacío). Se cierra como error y se avisa.
    if (totals.sellercloud_items === 0) {
      throw new Error(
        'SellerCloud no devolvió ningún ítem de inventario: se cierra la corrida como error ' +
          '(un inventario vacío casi seguro es un filtro o un secret mal cargado, no la realidad).',
      )
    }

    // ---- 3) Cerrar la corrida ----
    const fin = await finish('ok', null)
    if (fin.error) {
      // La corrida quedó aplicada pero sin cerrar: el próximo begin la marca
      // colgada a los 10 min. Se avisa como error porque la frescura NO quedó
      // registrada — el candado seguiría contando desde la corrida anterior.
      return {
        ok: false,
        status: 500,
        error: rpcErrorMessage(
          'El stock se actualizó pero no se pudo cerrar la corrida (la frescura no quedó registrada)',
          fin.error,
        ),
      }
    }
    if (fin.data?.ok === false) {
      return {
        ok: false,
        status: 500,
        error:
          'El stock se actualizó pero la corrida ya no estaba en running ' +
          '(otro intento la marcó colgada): la frescura no quedó registrada con esta corrida.',
      }
    }

    return { ok: true, run_id: runId, duration_ms: now() - t0, totals }
  } catch (e) {
    const message = (e as Error).message ?? 'error desconocido'
    // Mejor esfuerzo: si el finish también falla, el lock lo recupera el
    // próximo begin (corrida colgada) — nunca queda bloqueado para siempre.
    try {
      await finish('error', message)
    } catch {
      /* la corrida queda running y la recupera el próximo begin */
    }
    return { ok: false, status: 502, error: message }
  }
}
