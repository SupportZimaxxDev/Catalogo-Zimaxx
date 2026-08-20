// Favoritos del catálogo del cliente (2026-08-20; servidor desde la quinta
// tanda del mismo día, a pedido del usuario).
//
// LA FUENTE DE VERDAD ES LA BASE: tabla `client_favorites` + RPC
// `set_favorite` por token (migration-2026-08-20-client-favorites.sql), para
// que quede registro de los favoritos de cada cliente (consultable por la
// vendedora/admin) y sobrevivan al cambio de teléfono. `get_catalog` los trae
// de vuelta como `is_fav` en cada producto, sin round-trip extra.
//
// El localStorage queda como CACHÉ de arranque y fallback:
//   * al abrir el catálogo, los corazones cacheados se pintan al instante y
//     cuando llega get_catalog manda el servidor (Catalog.jsx reemplaza el
//     estado con los is_fav y reescribe este caché);
//   * si la base todavía no tiene la migración (is_fav llega undefined), los
//     favoritos siguen funcionando como la v1: solo en este dispositivo.
//
// El toggle es OPTIMISTA: la UI y el caché cambian ya, y el POST viaja
// fire-and-forget con keepalive (sobrevive a cerrar la pestaña) y un único
// reintento — si aún así no llega, el corazón queda local esta visita y al
// recargar manda lo que diga el servidor. Un favorito jamás rompe nada ni
// muestra un error: no es más importante que el flujo del catálogo.
//
// La clave del caché va POR CLIENTE (tokenHint, primeros 8 caracteres del
// token — mismo criterio que orderOutbox/order_failures): el link se comparte
// por WhatsApp y el mismo teléfono puede abrir el catálogo de otra persona.

import { tokenHint } from './orderOutbox'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

const KEY_PREFIX = 'zimaxx_favs_'
// Espejo del tope server-side de set_favorite: nadie tiene 500 favoritos de
// verdad, y un JSON gigante en localStorage es lo único que podría hacer
// lento el arranque del catálogo.
const MAX_FAVS = 500

const keyOf = (token) => `${KEY_PREFIX}${tokenHint(token)}`

export function loadFavorites(token) {
  try {
    const raw = localStorage.getItem(keyOf(token))
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v) => typeof v === 'string').slice(0, MAX_FAVS))
  } catch {
    return new Set()
  }
}

export function saveFavorites(token, favs) {
  try {
    const list = [...favs].slice(0, MAX_FAVS)
    if (list.length === 0) {
      // Igual que el carrito vacío: no se deja un `[]` huérfano guardado.
      localStorage.removeItem(keyOf(token))
    } else {
      localStorage.setItem(keyOf(token), JSON.stringify(list))
    }
  } catch {
    /* modo privado o storage lleno: quedan en memoria por esta visita */
  }
}

// Registra el toggle en la base, fire-and-forget. Fetch directo con la anon
// key + keepalive (mismo criterio que orderOutbox/systemLog: supabase.rpc no
// deja pasar keepalive y el toggle puede ser lo último antes de cerrar la
// pestaña). Un fallo de red reintenta UNA vez; después se rinde en silencio —
// el servidor manda en la próxima carga.
export function pushFavorite(token, productId, fav, attempt = 0) {
  try {
    fetch(`${url}/rest/v1/rpc/set_favorite`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_token: token, p_product_id: productId, p_fav: !!fav }),
      keepalive: true,
    }).catch(() => {
      if (attempt === 0) setTimeout(() => pushFavorite(token, productId, fav, 1), 1500)
    })
  } catch {
    /* jamás rompe el catálogo por un corazón */
  }
}
