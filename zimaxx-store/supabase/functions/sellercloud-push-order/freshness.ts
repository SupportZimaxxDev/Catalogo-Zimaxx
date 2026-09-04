// Candado de frescura de inventario para el push (2026-09-04). Sin nada de
// Deno ni de supabase-js — el cliente de RPCs se inyecta — para poder probar
// desde Node las cuatro salidas del gate (fresco / vencido / override
// auditado / override rechazado), igual que el resto de la lógica del push
// (patrón sellercloud.ts).
//
// La VERDAD vive en la base: get_inventory_freshness dice si venció y
// audit_freshness_override decide quién puede saltear (solo superadmin) y
// deja el rastro en admin_audit_log. Acá solo se traduce eso a una respuesta
// HTTP — y se corta ANTES de tocar la API de SellerCloud, porque un rechazo
// después del create dejaría una orden creada a medias allá.

export type RpcResult = { data: any; error: { message: string; code?: string } | null }
export type RpcClient = (name: string, args: Record<string, unknown>) => Promise<RpcResult>

export type GateOutcome =
  // Puede seguir. `warning` = algo para dejar en system_logs (candado no
  // consultable u override usado); `overrode` = pasó por el escape de
  // emergencia (ya auditado en admin_audit_log por la RPC).
  | { allow: true; overrode: boolean; warning: { event: string; message: string } | null }
  // Rechazado: status + body listos para responder.
  | { allow: false; status: number; body: Record<string, unknown> }

export async function freshnessGate(
  rpc: RpcClient,
  orderId: string,
  wantOverride: boolean,
): Promise<GateOutcome> {
  const { data: fresh, error: freshError } = await rpc('get_inventory_freshness', {})

  if (freshError) {
    // La RPC no existe todavía (migración 2026-09-04 sin correr) o falló la
    // consulta: el candado no puede evaluar, así que NO bloquea (mismo
    // comportamiento que antes de esta tanda) pero lo deja dicho — un push
    // sin candado por desalineo de deploys no puede pasar inadvertido.
    return {
      allow: true,
      overrode: false,
      warning: {
        event: 'freshness_unavailable',
        message: `El candado de frescura no se pudo consultar (¿falta la migración 2026-09-04?): ${freshError.message}`,
      },
    }
  }

  if (!fresh?.is_stale) {
    // Fresco (o candado dormido: sin corridas registradas). El override acá
    // no significa nada y no se audita — no salteó ningún candado.
    return { allow: true, overrode: false, warning: null }
  }

  if (!wantOverride) {
    // Error identificable (code) para que el panel muestre el CTA de refresco
    // en vez de texto suelto — incluye hace cuántos minutos.
    return {
      allow: false,
      status: 409,
      body: {
        error:
          `Inventario desactualizado (hace ${fresh.minutes_ago} min, umbral ` +
          `${fresh.threshold_minutes} min): refrescá el stock para continuar.`,
        code: 'stale_inventory',
        stale_minutes: fresh.minutes_ago,
        threshold_minutes: fresh.threshold_minutes,
      },
    }
  }

  // Escape de emergencia (la API de SellerCloud caída para el refresco, por
  // ejemplo): SOLO superadmin y SIEMPRE auditado. La RPC rechaza a cualquier
  // otro y calcula ella misma la edad del inventario — sin auditoría no hay
  // override.
  const { error: auditError } = await rpc('audit_freshness_override', {
    p_via: 'sellercloud_push',
    p_order_id: orderId,
  })
  if (auditError) {
    return {
      allow: false,
      status: 403,
      body: { error: auditError.message, code: 'override_forbidden' },
    }
  }

  return {
    allow: true,
    overrode: true,
    warning: {
      event: 'push_freshness_override',
      message: `Push con inventario vencido (hace ${fresh.minutes_ago} min) forzado por superadmin`,
    },
  }
}
