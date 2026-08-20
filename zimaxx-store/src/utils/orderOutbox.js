// Registro del pedido con reintento que sobrevive a que el cliente se vaya
// (2026-08-17). Complementa a `order_failures`, que solo ve los pedidos que
// SÍ llegaron al servidor: acá se ataca el otro caso, el request que nunca
// llegó y no deja rastro en ninguna parte.
//
// Tres piezas:
//   1. El POST va con `keepalive`, así el navegador lo termina aunque la
//      pestaña se descargue o pase a segundo plano al saltar a WhatsApp.
//      `supabase.rpc` no permite pasar esa opción — por eso se llama a
//      PostgREST directo, con la misma anon key del cliente de siempre.
//   2. Timeout explícito: sin esto, un fetch con mala señal se queda colgado
//      para siempre, el botón queda deshabilitado y el cliente no ve ni
//      abrirse WhatsApp.
//   3. El intento se guarda en localStorage ANTES de mandarlo (el "pendiente")
//      y se borra recién cuando el servidor contesta. Lo que quede ahí se
//      reintenta en la próxima visita al catálogo — seguro, porque
//      `create_order` es idempotente por `request_id`: si el intento anterior
//      sí había entrado, devuelve ese mismo pedido en vez de duplicarlo.
//
// Por qué hace falta lo tercero: los reintentos con `setTimeout` que había en
// CartDrawer corrían DESPUÉS de abrir WhatsApp, o sea con la pestaña ya en
// segundo plano, y los navegadores móviles congelan los timers de las páginas
// ocultas. En el peor caso no se ejecutaban nunca.

import { logEvent } from './systemLog'

const PENDING_KEY = 'zimaxx_pending_order'

// Después de un día un pedido pendiente ya no se manda solo: los precios y el
// stock se movieron, y lo más probable es que la asesora ya lo haya cargado a
// mano desde el WhatsApp. Se descarta en silencio.
const MAX_AGE_MS = 24 * 60 * 60 * 1000

// Tope de reintentos automáticos acumulados entre visitas. Si a esta altura
// no entró, no es un problema de señal. El pendiente NO se borra: el aviso
// rojo sigue visible y el botón de reintentar a mano sigue funcionando.
const MAX_AUTO_TRIES = 8

const TIMEOUT_MS = 5000

// `keepalive` tiene un tope de 64 KB de cuerpo por navegador. Un pedido normal
// no llega ni a 5 KB, pero uno de cientos de líneas puede pasarse, y ahí el
// fetch falla de entrada. Arriba de este tamaño se manda sin keepalive: se
// pierde la garantía de sobrevivir a la descarga de la página, pero al menos
// sale.
const KEEPALIVE_MAX_BYTES = 50_000

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// El servidor solo lee id, qty y flash de cada ítem (`compute_order_items`):
// nombre, precio y UPC los recalcula él y descarta lo que venga del navegador.
// Mandar el ítem completo hacía viajar ~4 veces más bytes justo cuando la
// señal del cliente es mala — y encima empujaba el cuerpo hacia el tope de
// keepalive.
export function slimItems(items) {
  return items.map((i) => ({ id: i.id, qty: i.qty, flash: !!i.flash }))
}

// Mismo criterio que `order_failures.token_hint` del lado SQL: alcanza para
// saber si el pendiente es de este cliente sin guardar la credencial entera.
// Importa porque el link del catálogo se comparte por WhatsApp y el mismo
// teléfono puede abrir el de otra persona: sin este chequeo, el pedido de A
// se reenviaría bajo el token de B.
export function tokenHint(token) {
  return String(token ?? '').slice(0, 8)
}

export function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const p = raw ? JSON.parse(raw) : null
    if (!p || !p.requestId || !Array.isArray(p.items) || p.items.length === 0) return null
    return p
  } catch {
    return null
  }
}

export function savePending({ requestId, token, items, total, kind }) {
  try {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        requestId,
        tokenHint: tokenHint(token),
        items: slimItems(items),
        total,
        kind,
        ts: Date.now(),
        tries: 0,
      }),
    )
  } catch {
    // Modo privado o storage lleno: se sigue igual, solo se pierde el
    // reintento entre visitas.
  }
}

export function clearPending() {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    /* nada que hacer */
  }
}

function bumpTries() {
  const p = loadPending()
  if (!p) return
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, tries: (p.tries ?? 0) + 1 }))
  } catch {
    /* nada que hacer */
  }
}

// El `outbox_exhausted` por tope de reintentos se loguea UNA sola vez: el
// pendiente sigue en el teléfono (el aviso rojo y el reintento a mano siguen
// vivos) y flushPending corre en cada visita/foco — sin esta marca, cada
// vuelta al catálogo sumaría otro critical idéntico.
function markExhaustedLogged() {
  const p = loadPending()
  if (!p) return
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, exhaustedLogged: true }))
  } catch {
    /* nada que hacer */
  }
}

// Lo que identifica al pendiente en system_logs sin exponer nada sensible:
// mismo criterio que order_failures (token_hint de 8 chars, conteos y total,
// nunca los ítems). El request_id permite cruzar con orders.request_id para
// confirmar si al final entró.
function pendingContext(p) {
  return {
    kind: p.kind,
    lines: Array.isArray(p.items) ? p.items.length : null,
    total: p.total,
    tries: p.tries ?? 0,
    request_id: p.requestId,
    token_hint: p.tokenHint,
  }
}

// Un intento contra create_order. Devuelve los mismos tres estados que usaba
// CartDrawer:
//   'ok'       → quedó guardado
//   'rejected' → el servidor lo rechazó (token, tope de líneas, ítems sin
//                precio...). Reintentar da igual siempre: el motivo y el
//                payload ya quedaron en `order_failures` y la asesora lo
//                rescata desde el panel.
//   'error'    → no se pudo hablar con la base (red, timeout, 5xx). Esto sí
//                se reintenta.
export async function postOrder({ token, items, total, kind, requestId }) {
  const body = JSON.stringify({
    p_token: token,
    p_items: slimItems(items),
    p_total: total,
    p_kind: kind,
    p_request_id: requestId,
  })

  try {
    const res = await rpc(body)
    if (res.ok) return (await res.json()) ? 'ok' : 'rejected'

    // Base sin migration-2026-08-05-order-capture.sql: la función de 5
    // argumentos no existe (PGRST202) y se reintenta con la firma vieja, para
    // no dejar el checkout caído si el frontend se despliega antes de correr
    // el SQL. Se mira el CÓDIGO y no el texto: con un match laxo, cualquier
    // error que nombrara la función mandaría por el camino sin idempotencia y
    // un intento que sí se guardó podría terminar duplicado. Acá no puede
    // pasar: si la firma de 5 argumentos no existe, el primer intento no
    // guardó nada.
    const err = await res.json().catch(() => null)
    if (err?.code === 'PGRST202' || /could not find the function/i.test(err?.message ?? '')) {
      const { p_request_id, ...legacy } = JSON.parse(body)
      const retry = await rpc(JSON.stringify(legacy))
      if (retry.ok) return (await retry.json()) ? 'ok' : 'rejected'
    }
    console.warn('No se pudo registrar la orden:', err ?? res.status)
    return 'error'
  } catch (e) {
    // AbortError (timeout) incluido: es reintentable como cualquier fallo de red.
    console.warn('No se pudo registrar la orden:', e)
    return 'error'
  }
}

function rpc(body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  return fetch(`${url}/rest/v1/rpc/create_order`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
    },
    body,
    keepalive: body.length <= KEEPALIVE_MAX_BYTES,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer))
}

// Varios intentos seguidos con espera corta entre uno y otro. La espera es
// corta a propósito: esto puede estar corriendo con la pestaña ya en segundo
// plano (el cliente saltó a WhatsApp), donde los timers largos se congelan.
export async function postWithRetry(args, tries = 2) {
  let res = 'error'
  for (let n = 0; n < tries; n++) {
    res = await postOrder(args)
    if (res !== 'error') return res
    if (n < tries - 1) await new Promise((r) => setTimeout(r, 300 * (n + 1)))
  }
  return res
}

// Reintenta el pendiente guardado, si corresponde. Devuelve el estado del
// intento, o null si no había nada que mandar (que es lo normal).
export async function flushPending(token) {
  const p = loadPending()
  if (!p) return null

  // De otro cliente: el teléfono abrió el link de otra persona. No es nuestro
  // pedido para reenviar y tampoco hay que dejarlo ahí ensuciando.
  if (p.tokenHint !== tokenHint(token)) {
    clearPending()
    return null
  }
  if (Date.now() - (p.ts ?? 0) > MAX_AGE_MS) {
    // El peor final del outbox: el pedido nunca entró y ya no se va a mandar
    // solo. Queda en system_logs (2026-08-20) con lo que hace falta para que
    // la asesora lo busque en el chat — antes esto se descartaba sin dejar
    // rastro en ninguna parte.
    logEvent(
      'critical',
      'order_outbox',
      'outbox_exhausted',
      'Pedido pendiente descartado por antigüedad (más de 24 h sin poder registrarse)',
      { ...pendingContext(p), reason: 'expired' },
    )
    clearPending()
    return null
  }
  // Se sigue mostrando el aviso, pero ya no se insiste solo.
  if ((p.tries ?? 0) >= MAX_AUTO_TRIES) {
    if (!p.exhaustedLogged) {
      markExhaustedLogged()
      logEvent(
        'critical',
        'order_outbox',
        'outbox_exhausted',
        `El pedido agotó los ${MAX_AUTO_TRIES} reintentos automáticos y sigue sin registrarse`,
        { ...pendingContext(p), reason: 'max_tries' },
      )
    }
    return null
  }

  bumpTries()
  const res = await postOrder({
    token,
    items: p.items,
    total: p.total,
    kind: p.kind,
    requestId: p.requestId,
  })
  if (res === 'error') {
    // Cada reintento automático que no llega queda contado (2026-08-20): una
    // seguidilla de estos en el panel es la señal de un cliente con el pedido
    // trabado ANTES de que se agote y pase a critical.
    logEvent(
      'warning',
      'order_outbox',
      'outbox_retry_failed',
      'Reintento automático del pedido pendiente sin respuesta de la base',
      { ...pendingContext(p), attempt: (p.tries ?? 0) + 1 },
    )
  }
  if (res !== 'error') clearPending()
  return res
}
