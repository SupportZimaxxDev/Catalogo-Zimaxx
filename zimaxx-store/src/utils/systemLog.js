// Logs de errores y eventos hacia system_logs (2026-08-20). Es la puerta única
// del frontend a la RPC log_event (migration-2026-08-20-system-logs.sql): los
// eventos quedan consultables en la pestaña ⚙️ Sistema del panel en vez de
// morir en la consola del navegador de un cliente.
//
// REGLA DE ORO, igual que del lado SQL: un log JAMÁS rompe el flujo que lo
// llama. logEvent es fire-and-forget — no devuelve promesa, no lanza nunca,
// no se espera. Si la red o Supabase fallan, el log se pierde y ya (para eso
// el flujo importante tiene sus propias redes: order_failures, el pendiente
// del outbox).
//
// Por qué fetch directo con la anon key y no supabase.rpc (mismo criterio que
// orderOutbox.js):
//   * `keepalive`: los logs más valiosos se emiten justo cuando la pestaña se
//     va a segundo plano (el cliente saltó a WhatsApp) o se está cerrando —
//     supabase.rpc no deja pasar esa opción y el request moriría con la página.
//   * No depende del estado de sesión: sirve igual desde el catálogo (anon) y
//     desde el panel. log_event no registra identidad de todos modos; lo que
//     identifica al evento va en el context.

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Mismo tope que usa orderOutbox para keepalive (el límite del navegador son
// 64 KB por request con keepalive). Un log no debería acercarse nunca — el
// context viaja recortado del lado SQL igual — pero si alguien manda algo
// gigante, mejor sin keepalive que un fetch que falla de entrada.
const KEEPALIVE_MAX_BYTES = 50_000

export function logEvent(severity, source, event, message, context = {}) {
  try {
    const body = JSON.stringify({
      p_severity: severity,
      p_source: source,
      p_event: event,
      p_message: message == null ? null : String(message).slice(0, 2000),
      p_context: context ?? {},
    })
    fetch(`${url}/rest/v1/rpc/log_event`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body,
      keepalive: body.length <= KEEPALIVE_MAX_BYTES,
    }).catch(() => {
      /* el log se pierde en silencio: nunca es más importante que el flujo */
    })
  } catch {
    /* ídem: ni un context circular (JSON.stringify tira) puede romper al caller */
  }
}

// ---------- Errores JS globales ----------
// Un error en loop (un efecto que revienta en cada render, un reject por
// segundo) inundaría la tabla: tope de 5 eventos por minuto y nunca el mismo
// mensaje dos veces seguidas. `lastMessage` no se resetea con la ventana a
// propósito — un error que se repite idéntico queda logueado UNA vez por
// carga de página, no una por minuto; si entre medio aparece otro distinto,
// el primero vuelve a poder loguearse.
const MAX_PER_MINUTE = 5
let windowStart = 0
let sentInWindow = 0
let lastMessage = null

function shouldLog(message) {
  const now = Date.now()
  if (now - windowStart > 60_000) {
    windowStart = now
    sentInWindow = 0
  }
  if (sentInWindow >= MAX_PER_MINUTE) return false
  if (message && message === lastMessage) return false
  lastMessage = message
  sentInWindow++
  return true
}

// Ruido de extensiones del navegador (2026-09-02): un `js_error` de MetaMask
// (inpage.js inyectado por la extensión) llegó a system_logs sin ser código
// nuestro. El criterio principal es el ORIGEN en el stack o el archivo
// (chrome-extension:// / moz-extension:// / safari-extension:// y variantes
// safari-web-extension); el mensaje ("Failed to connect to MetaMask") es solo
// refuerzo para promesas rechazadas que llegan sin stack útil.
const EXTENSION_ORIGIN = /\b(?:chrome|moz|safari|safari-web)-extension:\/\//i
const EXTENSION_MESSAGE = /metamask/i

function isExtensionNoise(message, stack, file) {
  return (
    EXTENSION_ORIGIN.test(stack ?? '') ||
    EXTENSION_ORIGIN.test(file ?? '') ||
    EXTENSION_MESSAGE.test(message ?? '')
  )
}

// La URL va SIN query string: el link del catálogo lleva el token del cliente
// en `?c=...` y esa credencial no tiene que quedar escrita en ningún log
// (mismo criterio que order_failures.token_hint).
function pageUrl() {
  try {
    return location.origin + location.pathname
  } catch {
    return null
  }
}

// Registra window.onerror + unhandledrejection. Se llama una vez desde
// main.jsx, antes del primer render. Todo va envuelto: un fallo del propio
// handler no puede convertirse en otro error global (sería un loop).
export function installGlobalErrorLogging() {
  window.addEventListener('error', (e) => {
    try {
      const msg = String(e?.message || e?.error?.message || 'error desconocido').slice(0, 500)
      const stack = String(e?.error?.stack ?? '').slice(0, 1500)
      const file = e?.filename ? `${e.filename}:${e.lineno ?? '?'}` : undefined
      // Errores de extensiones del navegador: no son código nuestro y no se
      // loguean (va ANTES de shouldLog para no gastarle la ventana ni el
      // dedupe a los errores reales).
      if (isExtensionNoise(msg, stack, file)) return
      if (!shouldLog(msg)) return
      logEvent('error', 'frontend', 'js_error', msg, {
        stack: stack || undefined,
        file,
        url: pageUrl(),
      })
    } catch {
      /* nunca */
    }
  })

  window.addEventListener('unhandledrejection', (e) => {
    try {
      const reason = e?.reason
      const msg = String(reason?.message ?? reason ?? 'promesa rechazada sin motivo').slice(0, 500)
      const stack = String(reason?.stack ?? '').slice(0, 1500)
      if (isExtensionNoise(msg, stack, undefined)) return
      if (!shouldLog(msg)) return
      logEvent('error', 'frontend', 'js_error', msg, {
        kind: 'unhandledrejection',
        stack: stack || undefined,
        url: pageUrl(),
      })
    } catch {
      /* nunca */
    }
  })
}
