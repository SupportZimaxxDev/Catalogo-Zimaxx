import { Fragment, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { money, cleanPhone } from '../../utils/format'
import { searchTerms, matchesTerms } from '../../utils/search'
import { downloadOrderExcel } from '../../utils/excel'
import { downloadOrderPdf } from '../../utils/pdf'
import { SearchIcon, inputCls, useInfiniteRows } from './ui'
import ManualOrderModal from './ManualOrderModal'

// Estilos de badge por estado (2026-07-15 agrega 'cancelled': un pedido
// se arma y confirma, pero a veces el cliente lo cancela después).
const STATUS_STYLES = {
  new: 'bg-gold-pale text-secondary-dark',
  done: 'bg-primary/10 text-primary/50',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
}

// El join a vendedora solo lo necesita el filtro que ve el admin; a una
// vendedora RLS ya le recorta la consulta a sus propios pedidos.
//
// SIN `items` desde 2026-08-20 (análisis de rendimiento): el jsonb de ítems
// pesa 4.2 KB promedio por pedido (hasta 69 KB) y la fila de la tabla solo
// mostraba su total de unidades — que ahora viene en la columna generada
// `units` (migration-2026-08-20-orders-units.sql). Los ítems completos se
// piden POR PEDIDO al desplegar la fila o al actuar sobre él (ensureItems).
// Con ~250 pedidos/semana, bajar todo con items eran ~14 MB a los 3 meses.
const ORDER_SELECT =
  'id, client_id, created_at, kind, status, total, stock_applied, request_id, ' +
  'sellercloud_order_id, sellercloud_pushed_at, sellercloud_error, units, ' +
  'clients(name, phone, vendedora_id, vendedores(name))'

// Si la migración de `units` todavía no corrió, el select de arriba da 42703
// (columna inexistente): se degrada al select viejo con items incluidos — más
// pesado, pero la bandeja funciona igual. Así ni la migración bloquea el
// deploy ni el deploy espera a la migración.
const ORDER_SELECT_LEGACY = '*, clients(name, phone, vendedora_id, vendedores(name))'

// Ventana de tiempo por defecto de la bandeja (2026-08-20): los pedidos
// crecen ~250 por semana y "traer todo" crece sin techo — la operación diaria
// vive en lo reciente. 0 = todo el historial (para buscar algo viejo).
const RANGES = [30, 90, 180, 0]
const DEFAULT_RANGE_DAYS = 90

// Link directo a la orden en el PORTAL de SellerCloud (2026-08-19, a pedido
// del usuario). El host del portal es fc2.delta — la API usa fc2.api, son
// dominios distintos del mismo servidor (ver README).
const SC_ORDER_URL = 'https://fc2.delta.sellercloud.com/orders/order-details.aspx?id='

// Cuántos ids por llamada a get_quotes_live_pricing. La RPC recalcula el
// precio vigente de cada línea de cada cotización: pedirle 800 de una es
// una sola consulta larga que puede chocar con el statement_timeout, y si
// falla no se muestra ningún precio. En tandas, cada una responde por su
// cuenta y los precios van apareciendo.
const LIVE_PRICING_CHUNK = 100

// Bandeja de pedidos: cada uno se marca atendido para no depender de la
// memoria del chat de WhatsApp.
export default function OrdersAdmin() {
  const { t } = useI18n()
  const { role } = useOutletContext()
  const isAdmin = role === 'admin'
  const [orders, setOrders] = useState([])
  const [expanded, setExpanded] = useState(null)
  // Sin el tope de 200 la primera carga puede tardar: hasta que termine, la
  // tabla no puede decir "aún no hay pedidos" (diría que no hay ninguno
  // cuando en realidad todavía están viniendo).
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // Ventana de tiempo (2026-08-20): cuántos días hacia atrás trae la bandeja.
  const [rangeDays, setRangeDays] = useState(DEFAULT_RANGE_DAYS)
  // Ítems bajo demanda (2026-08-20): id del pedido cuyos ítems están viniendo,
  // y el último fallo al traerlos (se muestra en la fila desplegada).
  const [detailLoading, setDetailLoading] = useState(null)
  const [detailError, setDetailError] = useState(null) // { id, message }

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [repFilter, setRepFilter] = useState('')
  // '' | 'sent' | 'notsent' — enviadas (o no) a SellerCloud (2026-08-19,
  // a pedido del usuario). Se filtra por sellercloud_order_id: es lo único
  // que distingue un pedido que ya vive allá.
  const [scFilter, setScFilter] = useState('')

  // Cotizaciones (kind='quote') nunca guardan precio congelado — se
  // recalculan con el precio VIGENTE del producto (2026-07-17, a pedido
  // del usuario). livePricing guarda {orderId: {items, total}} pisando
  // lo que se muestra para esos pedidos; ver displayOf().
  const [livePricing, setLivePricing] = useState({})

  // Edición de ítems de un pedido (2026-07-17): cantidades, quitar y
  // agregar productos, auditado server-side vía update_order_items.
  const [editing, setEditing] = useState(null)
  const [editItems, setEditItems] = useState([])
  const [editError, setEditError] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [productQuery, setProductQuery] = useState('')
  const [products, setProducts] = useState(null)

  // Confirmación antes de marcar atendido/cancelar/reabrir (2026-07-17,
  // a pedido del usuario) y feedback de error para "Convertir en pedido".
  const [confirmStatus, setConfirmStatus] = useState(null) // { id, status }
  const [convertError, setConvertError] = useState(null) // { id, message }
  // Resultado del movimiento de stock del último cambio de estado
  // (2026-08-04): { id, direction, moved[], skipped[] }. Antes los errores
  // de update_order_status se descartaban en silencio.
  const [stockInfo, setStockInfo] = useState(null)
  const [statusError, setStatusError] = useState(null) // { id, message }

  // Pedidos que el cliente envió y NO entraron (2026-08-05, order_failures).
  // Antes de esta tanda un rechazo no dejaba rastro en ninguna parte: la
  // vendedora recibía la lista por WhatsApp y el pedido no existía para el
  // sistema, sin forma de saber por qué. RLS ya filtra esto a los clientes de
  // cada vendedora.
  const [failures, setFailures] = useState([])
  const [recovering, setRecovering] = useState(null) // id del que se está rescatando
  const [recoverError, setRecoverError] = useState(null) // { id, message }
  const [manualOpen, setManualOpen] = useState(false)
  const [pushing, setPushing] = useState(null) // id del pedido que se está mandando
  const [pushError, setPushError] = useState(null) // { id, message }
  // Un fallo sin cliente (token inválido) o sin ítems no tiene a quién
  // asignárselo — "Recuperar" ni aparece — y antes se quedaba en el banner
  // para siempre sin ninguna acción posible (2026-08-13, reportado por el
  // usuario). "Descartar" lo saca de la lista sin borrar la fila.
  const [dismissing, setDismissing] = useState(null)
  const [dismissError, setDismissError] = useState(null) // { id, message }

  const loadLivePricing = async (list) => {
    const quoteIds = list.filter((o) => o.kind === 'quote').map((o) => o.id)
    for (let i = 0; i < quoteIds.length; i += LIVE_PRICING_CHUNK) {
      const chunk = quoteIds.slice(i, i + LIVE_PRICING_CHUNK)
      const { data } = await supabase.rpc('get_quotes_live_pricing', { p_order_ids: chunk })
      if (data) setLivePricing((prev) => ({ ...prev, ...data }))
    }
  }

  // Los pedidos de la ventana elegida (2026-08-20; hasta hoy era "todos, sin
  // tope" — 2026-08-07 — que con ~250 pedidos nuevos por semana crecía sin
  // techo: eran ~3 MB con los items adentro y serían ~55 MB al año). La
  // ventana por defecto son 90 días y "Todo el historial" sigue disponible en
  // el selector. `fetchAll` pagina de a 1,000 (el corte de PostgREST)
  // pidiendo las páginas en paralelo. Se ordena descendente acá porque
  // `fetchAll` pagina ascendente para que el `range` sea estable.
  const loadOrders = async (days = rangeDays) => {
    // `['created_at', 'id']` y no solo la fecha: sin una clave única el
    // paginado en paralelo puede saltearse una fila en el borde de una página
    // (ver fetchAll) — o sea un pedido que está en la base y no aparece en la
    // bandeja, que es justo el síntoma que se reportó el 2026-08-12.
    const since = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null
    const windowFilter = since ? (q) => q.gte('created_at', since) : null
    let all
    try {
      all = await fetchAll('orders', ORDER_SELECT, ['created_at', 'id'], windowFilter)
    } catch (e) {
      // 42703 = la columna `units` no existe: la migración
      // migration-2026-08-20-orders-units.sql todavía no corrió. Se degrada
      // al select viejo (items incluidos) en vez de dejar la bandeja caída.
      if (e?.code !== '42703') throw e
      all = await fetchAll('orders', ORDER_SELECT_LEGACY, ['created_at', 'id'], windowFilter)
    }
    const list = all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    setOrders(list)
    loadLivePricing(list)
    return list
  }

  // Trae los ítems de UN pedido y los funde en el estado (2026-08-20): el
  // listado ya no los baja. Idempotente — si ya están (los trajo esto mismo,
  // el select legacy, o los dejó una edición/conversión), no pide nada.
  const ensureItems = async (o) => {
    if (o.items !== undefined) return o
    setDetailLoading(o.id)
    setDetailError(null)
    try {
      const { data, error } = await supabase.from('orders').select('items').eq('id', o.id).single()
      if (error) throw error
      const items = data?.items ?? []
      setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, items } : x)))
      return { ...o, items }
    } catch (e) {
      setDetailError({ id: o.id, message: e.message ?? String(e) })
      throw e
    } finally {
      setDetailLoading(null)
    }
  }

  // Manda el pedido a SellerCloud como orden On Hold (2026-08-17). El trabajo
  // real lo hace la Edge Function `sellercloud-push-order`: el usuario y la
  // contraseña de la API no pueden vivir en el navegador. Acá solo se dispara
  // y se muestra el resultado.
  const pushToSellerCloud = async (order) => {
    if (pushing) return
    setPushError(null)
    setPushing(order.id)
    try {
      const { data, error } = await supabase.functions.invoke('sellercloud-push-order', {
        body: { order_id: order.id },
      })
      if (error) {
        // supabase-js devuelve un mensaje genérico ante un no-2xx ("Edge
        // Function returned a non-2xx status code"): el motivo real que arma
        // la función viene en el cuerpo, hay que leerlo de error.context.
        // Mismo caso que admin-create-vendedora-user.
        let message = error.message
        try {
          const detail = await error.context?.json?.()
          if (detail?.error) message = detail.error
        } catch {
          /* se queda el genérico */
        }
        setPushError({ id: order.id, message })
      } else if (data?.warning) {
        // La orden entró pero le faltó un dato (Sales Rep o Marketing
        // Source): se corrige para la próxima, y eso no se puede tragar en
        // silencio.
        setPushError({ id: order.id, message: data.warning })
      }
    } catch (e) {
      setPushError({ id: order.id, message: e.message })
    }
    setPushing(null)
    // Se recargan los pedidos igual que después de cualquier otra acción: si
    // salió bien, la fila pasa a mostrar el número de orden de SellerCloud.
    loadOrders().catch(() => {})
  }

  const loadFailures = () =>
    supabase
      .from('order_failures')
      .select('*, clients(name, phone)')
      .is('recovered_order_id', null)
      .is('dismissed_at', null)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => setFailures(data ?? []))

  // Recarga al montar Y al cambiar la ventana. Los fallos (order_failures) no
  // llevan ventana: son una alarma acotada a 50 filas, no un listado.
  useEffect(() => {
    setLoading(true)
    setLoadError(false)
    setExpanded(null)
    loadOrders(rangeDays)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false))
    loadFailures()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeDays])

  // Rescata el pedido perdido: lo crea SIEMPRE como cotización de ese
  // cliente (2026-08-13, con precios vigentes) y marca el fallo como
  // recuperado — la vendedora confirma con el cliente y recién ahí lo
  // convierte en pedido real ("Convertir en pedido", ya existente).
  const recover = async (id) => {
    setRecoverError(null)
    setRecovering(id)
    const { data, error } = await supabase.rpc('recover_order_failure', { p_failure_id: id })
    setRecovering(null)
    if (error || !data?.ok) {
      setRecoverError({ id, message: error?.message ?? t('recoverFailed') })
      return
    }
    // Recargar las dos listas: el pedido nuevo tiene que aparecer arriba y el
    // aviso desaparecer.
    await loadOrders().catch(() => {})
    loadFailures()
  }

  // Descarta un fallo que nunca se va a poder recuperar (sin cliente o sin
  // ítems): no borra la fila, solo la saca del banner (dismissed_at).
  const dismiss = async (id) => {
    setDismissError(null)
    setDismissing(id)
    const { data, error } = await supabase.rpc('dismiss_order_failure', { p_failure_id: id })
    setDismissing(null)
    if (error || !data?.ok) {
      setDismissError({ id, message: error?.message ?? t('dismissFailed') })
      return
    }
    loadFailures()
  }

  // Antes era un update directo; ahora pasa por la RPC auditada
  // (2026-07-17) — cada cambio de estado queda en admin_audit_log. La UI
  // pide confirmación antes de llamarla (ver confirmStatus más abajo).
  // 2026-08-04: la misma RPC mueve el stock de los productos (descuenta al
  // marcar atendido un pedido real, devuelve al reabrir/cancelar) y devuelve
  // qué ajustó, para mostrarlo acá.
  const applyStatus = async (id, status) => {
    setStatusError(null)
    setStockInfo(null)
    const { data, error } = await supabase.rpc('update_order_status', {
      p_order_id: id,
      p_status: status,
    })
    if (error) {
      setStatusError({ id, message: error.message })
      return
    }
    setOrders((prev) =>
      prev.map((o) => (o.id === id ? { ...o, status, stock_applied: !!data?.stock_applied } : o)),
    )
    if (data?.stock) setStockInfo({ id, ...data.stock })
  }

  const statusLabel = (status) =>
    status === 'done' ? t('statusDone') : status === 'cancelled' ? t('statusCancelled') : t('statusNew')

  // Convertir una cotización en pedido real (2026-07-17): congela precio
  // (a diferencia de una cotización, que siempre se ve con precio
  // vigente — ver displayOf) y queda auditado del lado del servidor.
  const convertToOrder = async (o) => {
    setConvertError(null)
    const { data, error } = await supabase.rpc('convert_quote_to_order', { p_order_id: o.id })
    if (error) {
      setConvertError({ id: o.id, message: error.message })
      return
    }
    setOrders((prev) =>
      prev.map((x) =>
        x.id === o.id
          ? {
              ...x,
              kind: 'order',
              items: data.items,
              total: data.total,
              stock_applied: !!data.stock_applied,
            }
          : x,
      ),
    )
    // Borde de stock: si la cotización ya estaba atendida, la conversión
    // descuenta ahí mismo (ver convert_quote_to_order en la migración).
    if (data.stock) setStockInfo({ id: o.id, ...data.stock })
  }

  // Ítems/total a mostrar: los de la cotización se pisan con el precio
  // vigente si ya se cargó (livePricing); si no, se ve lo guardado
  // (siempre sin precio para una cotización recién creada).
  const displayOf = (o) =>
    (o.kind === 'quote' && livePricing[o.id]) || { items: o.items ?? [], total: o.total }

  // Las acciones que necesitan los ítems los aseguran primero (2026-08-20):
  // una cotización con livePricing ya los tiene recalculados; el resto los
  // pide ensureItems si el listado no los trajo.
  const withItems = (o) => (o.kind === 'quote' && livePricing[o.id] ? Promise.resolve(o) : ensureItems(o))

  const exportOrder = async (o) => {
    try {
      const oo = await withItems(o)
      const stamp = new Date(oo.created_at).toISOString().slice(0, 10)
      downloadOrderExcel(displayOf(oo).items ?? [], `${stamp}-${oo.id.slice(0, 8)}`)
    } catch {
      /* el aviso quedó en detailError */
    }
  }

  const exportPdf = async (o) => {
    try {
      const oo = await withItems(o)
      const d = displayOf(oo)
      downloadOrderPdf({ t, clientName: oo.clients?.name ?? '', items: d.items ?? [], total: d.total })
    } catch {
      /* el aviso quedó en detailError */
    }
  }

  const startEdit = async (o) => {
    setEditError('')
    // Los ítems van ANTES de abrir el editor: abrirlo vacío y que se llene
    // solo es exactamente el tipo de cuadro fantasma que ya se reportó una
    // vez en el modal manual (2026-08-17).
    let oo
    try {
      oo = await ensureItems(o)
    } catch {
      return
    }
    setEditing(oo.id)
    setEditItems(
      (oo.items ?? []).map((i) => ({ id: i.id, sku: i.sku, name: i.name, qty: i.qty, flash: !!i.flash })),
    )
    setProductQuery('')
    if (products === null) {
      setProducts([])
      const all = await fetchAll('products', 'id, sku, name, active', ['name', 'id'])
      setProducts(all.filter((p) => p.active))
    }
  }

  const cancelEdit = () => {
    setEditing(null)
    setEditItems([])
    setEditError('')
  }

  const setEditQty = (id, qty) => {
    const clean = Math.max(1, Math.min(9999, Math.floor(qty) || 1))
    setEditItems((prev) => prev.map((i) => (i.id === id ? { ...i, qty: clean } : i)))
  }

  const removeEditItem = (id) => {
    setEditItems((prev) => prev.filter((i) => i.id !== id))
  }

  const addEditProduct = (p) => {
    setEditItems((prev) =>
      prev.some((i) => i.id === p.id) ? prev : [...prev, { id: p.id, sku: p.sku, name: p.name, qty: 1, flash: false }],
    )
    setProductQuery('')
  }

  const saveEdit = async (orderId) => {
    if (editItems.length === 0) {
      setEditError(t('orderNeedsItem'))
      return
    }
    setEditBusy(true)
    setEditError('')
    const { data, error } = await supabase.rpc('update_order_items', {
      p_order_id: orderId,
      p_items: editItems.map((i) => ({ id: i.id, qty: i.qty, flash: i.flash })),
    })
    setEditBusy(false)
    if (error) {
      setEditError(error.message)
      return
    }
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, items: data.items, total: data.total } : o)))
    const edited = orders.find((o) => o.id === orderId)
    if (edited?.kind === 'quote') {
      const { data: pricing } = await supabase.rpc('get_quotes_live_pricing', { p_order_ids: [orderId] })
      if (pricing) setLivePricing((prev) => ({ ...prev, ...pricing }))
    }
    setEditing(null)
    setEditItems([])
  }

  const reps = useMemo(() => {
    const map = new Map()
    for (const o of orders) {
      const v = o.clients?.vendedora_id
      if (v && !map.has(v)) map.set(v, o.clients.vendedores?.name ?? '')
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [orders])

  // Traer todos los pedidos no significa dibujarlos todos de golpe: cada fila
  // puede desplegar su detalle, así que se rinden por lotes con scroll
  // infinito, igual que la tabla de Productos.
  const [visibleRows, sentinelRef] = useInfiniteRows(100, [
    query,
    statusFilter,
    typeFilter,
    repFilter,
    scFilter,
  ])

  const filtered = useMemo(() => {
    const q = query.trim()
    // Por términos y no por subcadena contigua (2026-08-12): buscar
    // "robert carlos" tiene que encontrar a "Robert Edu Carlos Pacheco".
    // Ver utils/search.js — que ese cliente no apareciera acá es lo que se
    // reportó como "sus pedidos no se registraron".
    const terms = searchTerms(q)
    const qDigits = q.replace(/\D/g, '')
    return orders.filter((o) => {
      if (statusFilter && (o.status ?? 'new') !== statusFilter) return false
      if (typeFilter && (o.kind ?? 'order') !== typeFilter) return false
      if (repFilter && o.clients?.vendedora_id !== repFilter) return false
      if (scFilter === 'sent' && !o.sellercloud_order_id) return false
      if (scFilter === 'notsent' && o.sellercloud_order_id) return false
      if (terms.length === 0) return true
      return (
        matchesTerms(terms, o.clients?.name) ||
        (qDigits && cleanPhone(o.clients?.phone).includes(qDigits))
      )
    })
  }, [orders, query, statusFilter, typeFilter, repFilter, scFilter])

  // Va arriba de la bandeja y también cuando todavía no hay ningún pedido: un
  // catálogo nuevo cuyo primer pedido rebotó mostraría "aún no hay pedidos"
  // ocultando justo lo que hay que ver.
  const failuresNotice = failures.length > 0 && (
    <div className="rounded-xl border-2 border-red-500 bg-red-50 p-4 dark:bg-red-950/40">
      <h3 className="text-sm font-bold text-red-700 dark:text-red-300">
        ⚠️ {t('failedOrders')} ({failures.length})
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-red-900/70 dark:text-red-200/70">
        {t('failedOrdersBody')}
      </p>
      <ul className="mt-3 space-y-2">
        {failures.map((f) => {
          // Sin cliente (token inválido) o sin ítems: no hay a quién
          // asignárselo, "Recuperar" no tiene sentido — la única salida es
          // descartarlo (2026-08-13).
          const canRecover = !!f.client_id && Array.isArray(f.items) && f.items.length > 0
          return (
          <li key={f.id} className="rounded-lg bg-surface p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{f.clients?.name ?? t('unknownClient')}</p>
                <p className="text-xs text-primary/60">
                  {new Date(f.created_at).toLocaleString()} · {f.reason}
                  {f.line_count != null && ` · ${f.line_count} ${t('failureLines')}`}
                </p>
              </div>
              {canRecover ? (
                <button
                  onClick={() => recover(f.id)}
                  disabled={recovering === f.id}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {recovering === f.id ? t('recovering') : t('recoverOrder')}
                </button>
              ) : (
                <button
                  onClick={() => dismiss(f.id)}
                  disabled={dismissing === f.id}
                  className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-bold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/40"
                >
                  {dismissing === f.id ? t('dismissing') : t('dismissFailure')}
                </button>
              )}
            </div>
            {recoverError?.id === f.id && (
              <p className="mt-2 text-xs font-medium text-red-700 dark:text-red-300">
                {recoverError.message}
              </p>
            )}
            {dismissError?.id === f.id && (
              <p className="mt-2 text-xs font-medium text-red-700 dark:text-red-300">
                {dismissError.message}
              </p>
            )}
          </li>
          )
        })}
      </ul>
    </div>
  )

  // Cargar a mano el pedido que llegó por WhatsApp y no al sistema
  // (2026-08-17). Va acá, en la misma pantalla donde se ve el aviso rojo de
  // los que sí dejaron rastro: es el mismo problema visto desde el otro lado.
  // Desde 2026-08-18 el mismo modal también lee el PDF de una cotización
  // (generado por la app) y lo convierte en pedido: dos botones, un modal —
  // manualOpen guarda con qué pestaña abrir ('text' | 'pdf').
  const manualBlock = (
    <>
      <span className="inline-flex flex-wrap gap-2">
        <button
          onClick={() => setManualOpen('text')}
          className="rounded-xl border-2 border-primary px-4 py-2 text-sm font-semibold transition-colors hover:bg-ink hover:text-secondary"
        >
          {t('manualOrderButton')}
        </button>
        <button
          onClick={() => setManualOpen('pdf')}
          className="rounded-xl border-2 border-primary px-4 py-2 text-sm font-semibold transition-colors hover:bg-ink hover:text-secondary"
        >
          {t('pdfOrderButton')}
        </button>
      </span>
      <ManualOrderModal
        open={!!manualOpen}
        initialTab={manualOpen === 'pdf' ? 'pdf' : 'text'}
        onClose={() => setManualOpen(false)}
        onCreated={() => {
          loadOrders().catch(() => {})
        }}
      />
    </>
  )

  // Ya no hay retorno anticipado con la bandeja vacía (2026-08-20): con la
  // ventana de tiempo, "0 pedidos" puede significar "0 en los últimos 90
  // días" y el selector para ampliarla tiene que quedar visible. De paso se
  // arregla que durante la carga inicial se mostraba "aún no hay pedidos"
  // sin esperar la respuesta.

  // Aviso del efecto en stock dentro del modal de confirmación (2026-08-04):
  // solo aplica a pedidos reales — una cotización nunca mueve inventario.
  const pendingOrder = confirmStatus ? orders.find((o) => o.id === confirmStatus.id) : null
  const stockNoticeKey =
    pendingOrder?.kind !== 'order'
      ? null
      : confirmStatus.status === 'done' && !pendingOrder.stock_applied
        ? 'stockWillDeduct'
        : confirmStatus.status !== 'done' && pendingOrder.stock_applied
          ? 'stockWillReturn'
          : null

  return (
    <div className="space-y-4">
      {/* El número es el total DE LA VENTANA elegida (90 días por defecto,
          2026-08-20; entre 2026-08-07 y hoy era el histórico entero, que
          crece ~250 pedidos/semana). Con filtros puestos muestra
          "coinciden / total", y al lado dice qué ventana es para que el
          número no se lea como el histórico. */}
      <h2 className="text-xl font-bold">
        {t('orders')}{' '}
        {loading ? (
          <span className="text-base font-normal text-primary/40">{t('loading')}</span>
        ) : (
          <>
            ({filtered.length}
            {filtered.length !== orders.length ? ` / ${orders.length}` : ''})
            <span className="ml-2 text-sm font-normal text-primary/40">
              · {rangeDays === 0 ? t('ordersRangeAll') : t('ordersRangeDays', { n: rangeDays })}
            </span>
          </>
        )}
      </h2>

      {loadError && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {t('ordersLoadFailed')}
        </p>
      )}

      {failuresNotice}

      <div>{manualBlock}</div>

      <div className="flex flex-col gap-2 md:flex-row">
        <div className="relative flex-1">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchOrders')}
            className={`${inputCls} w-full pl-10`}
          />
        </div>
        {/* La ventana es un filtro DEL SERVIDOR (recarga la bandeja), no un
            recorte client-side como los demás selects. */}
        <select
          value={rangeDays}
          onChange={(e) => setRangeDays(Number(e.target.value))}
          className={inputCls}
        >
          {RANGES.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? t('ordersRangeAll') : t('ordersRangeDays', { n })}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className={inputCls}
        >
          <option value="">{t('allStatuses')}</option>
          <option value="new">{t('statusNew')}</option>
          <option value="done">{t('statusDone')}</option>
          <option value="cancelled">{t('statusCancelled')}</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={inputCls}>
          <option value="">{t('allTypes')}</option>
          <option value="order">{t('order')}</option>
          <option value="quote">{t('quote')}</option>
        </select>
        <select value={scFilter} onChange={(e) => setScFilter(e.target.value)} className={inputCls}>
          <option value="">{t('scFilterAll')}</option>
          <option value="sent">{t('scFilterSent')}</option>
          <option value="notsent">{t('scFilterNotSent')}</option>
        </select>
        {isAdmin && reps.length > 0 && (
          <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} className={inputCls}>
            <option value="">{t('allReps')}</option>
            {reps.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>

      {loading ? (
        <p className="py-10 text-center text-primary/50">{t('loading')}</p>
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-primary/50">{t('noOrders')}</p>
      ) : (
      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-primary/10 text-left text-xs uppercase text-primary/50">
              <th className="p-3">{t('date')}</th>
              <th className="p-3">{t('client')}</th>
              <th className="p-3">{t('type')}</th>
              <th className="p-3">{t('items')}</th>
              <th className="p-3 text-right">{t('total')}</th>
              <th className="p-3">{t('status')}</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, visibleRows).map((o) => {
              const canEdit = o.kind === 'quote' && (o.status ?? 'new') === 'new'
              const canConvert = o.kind === 'quote' && (o.status ?? 'new') !== 'cancelled'
              return (
              <Fragment key={o.id}>
              <tr
                onClick={() => {
                  const next = expanded === o.id ? null : o.id
                  setExpanded(next)
                  // Los ítems del detalle llegan recién acá (2026-08-20): el
                  // listado ya no los baja. Si falla, la fila desplegada
                  // muestra el motivo (detailError).
                  if (next) withItems(o).catch(() => {})
                }}
                className="cursor-pointer border-b border-primary/5 align-top hover:bg-primary/[0.02]"
              >
                <td className="whitespace-nowrap p-3 text-primary/60">
                  {new Date(o.created_at).toLocaleString()}
                </td>
                <td className="p-3 font-medium">
                  {o.clients?.name}
                  <span className="block text-xs font-normal text-primary/50">
                    {o.clients?.phone}
                  </span>
                </td>
                <td className="p-3">
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      o.kind === 'quote'
                        ? 'bg-secondary/20 text-secondary-dark'
                        : 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300'
                    }`}
                  >
                    {o.kind === 'quote' ? t('quote') : t('order')}
                  </span>
                </td>
                <td className="p-3">
                  <span className="inline-flex items-center gap-1 text-primary/60">
                    {/* units la calcula la base (columna generada); el
                        reduce queda de respaldo para el select legacy (base
                        sin migration-2026-08-20-orders-units.sql). */}
                    {o.units ?? (o.items ?? []).reduce((n, i) => n + (i.qty ?? 0), 0)} {t('items')}
                    <svg
                      viewBox="0 0 24 24"
                      className={`h-3 w-3 shrink-0 transition-transform ${expanded === o.id ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </span>
                </td>
                <td className="p-3 text-right font-bold">
                  {displayOf(o).total != null ? money(displayOf(o).total) : '—'}
                </td>
                <td className="whitespace-nowrap p-3">
                  <div className="flex flex-col items-start gap-1.5">
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[o.status ?? 'new']}`}
                    >
                      {statusLabel(o.status ?? 'new')}
                    </span>
                    {o.stock_applied && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary/60">
                        📦 {t('stockDeducted')}
                      </span>
                    )}
                    {(o.status ?? 'new') === 'new' ? (
                      <span className="inline-flex gap-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmStatus({ id: o.id, status: 'done' })
                          }}
                          className="rounded-lg border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                        >
                          {t('markDone')}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmStatus({ id: o.id, status: 'cancelled' })
                          }}
                          className="rounded-lg border border-line px-2.5 py-1 text-xs text-red-600 transition-colors hover:border-red-400 dark:text-red-400"
                        >
                          {t('cancelOrder')}
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmStatus({ id: o.id, status: 'new' })
                        }}
                        className="rounded-lg border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                      >
                        {t('markNew')}
                      </button>
                    )}
                    {stockInfo?.id === o.id && (
                      <p className="max-w-[13rem] whitespace-normal text-[11px] font-medium leading-snug text-primary/60">
                        {stockInfo.direction === -1 ? t('stockMoved') : t('stockReturned')}:{' '}
                        {stockInfo.moved?.length ?? 0} {t('products').toLowerCase()}
                        {(stockInfo.skipped?.length ?? 0) > 0 &&
                          ` · ${stockInfo.skipped.length} ${t('stockNoData')}`}
                      </p>
                    )}
                    {statusError?.id === o.id && (
                      <p className="max-w-[13rem] whitespace-normal text-[11px] font-medium leading-snug text-red-600 dark:text-red-400">
                        {statusError.message}
                      </p>
                    )}
                  </div>
                </td>
                <td className="p-3 text-right align-top">
                  <div className="flex flex-col items-end gap-1.5">
                    <span className="inline-flex gap-1.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          exportPdf(o)
                        }}
                        className="whitespace-nowrap rounded-full border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                      >
                        {t('downloadPdf')}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          exportOrder(o)
                        }}
                        className="whitespace-nowrap rounded-full border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                      >
                        {t('downloadExcel')}
                      </button>
                    </span>
                    {/* SellerCloud (2026-08-17; modalidad 2026-08-18): solo
                        pedidos reales, una sola vez — mientras haya número de
                        orden allá, en vez del botón se muestra ese número
                        (duplicar una orden en SellerCloud obliga a ir a
                        cancelarla a mano) — y solo pedidos ATENDIDOS: el envío
                        ya no pone On Hold allá, así que la revisión humana es
                        marcarlo Atendido acá. Hasta entonces el botón se ve
                        deshabilitado con la explicación en el tooltip, en vez
                        de esconderse: un botón que aparece "de la nada" al
                        atender es más difícil de descubrir. La función igual
                        lo exige del lado del servidor. */}
                    {o.kind === 'order' && o.status !== 'cancelled' && (
                      <span className="inline-flex items-center gap-1.5">
                        {o.sellercloud_order_id ? (
                          // El badge es un LINK a la orden en el portal
                          // (2026-08-19): stopPropagation para que el click
                          // abra SellerCloud y no despliegue la fila.
                          <a
                            href={`${SC_ORDER_URL}${o.sellercloud_order_id}`}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="whitespace-nowrap rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-200 hover:underline dark:bg-indigo-900/50 dark:text-indigo-300 dark:hover:bg-indigo-900"
                          >
                            {t('scPushed', { id: o.sellercloud_order_id })} ↗
                          </a>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (o.status === 'done') pushToSellerCloud(o)
                            }}
                            disabled={pushing === o.id || o.status !== 'done'}
                            title={o.status !== 'done' ? t('scPushNeedsDone') : undefined}
                            className="whitespace-nowrap rounded-full border border-indigo-400 px-2.5 py-1 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                          >
                            {pushing === o.id ? t('scPushing') : t('scPush')}
                          </button>
                        )}
                      </span>
                    )}
                    {(canEdit || canConvert) && (
                      <span className="inline-flex gap-1.5">
                        {canEdit && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              startEdit(o)
                            }}
                            className="whitespace-nowrap rounded-full border border-secondary/60 px-2.5 py-1 text-xs text-secondary-dark transition-colors hover:bg-gold-pale/40"
                          >
                            {t('edit')}
                          </button>
                        )}
                        {canConvert && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              convertToOrder(o)
                            }}
                            className="whitespace-nowrap rounded-full border border-secondary/60 px-2.5 py-1 text-xs text-secondary-dark transition-colors hover:bg-gold-pale/40"
                          >
                            {t('convertToOrder')}
                          </button>
                        )}
                      </span>
                    )}
                    {convertError?.id === o.id && (
                      <p className="max-w-[12rem] text-right text-[11px] font-medium text-red-600 dark:text-red-400">
                        {convertError.message}
                      </p>
                    )}
                    {/* El motivo por el que no entró queda guardado en el
                        pedido (`sellercloud_error`), así se sigue viendo al
                        recargar y no solo en el momento de apretar. Los
                        motivos que vienen de la API traen la URL y el cuerpo
                        de la respuesta —largos a propósito, es lo único con
                        lo que se puede arreglar el secret—, así que el bloque
                        recorta por alto y scrollea en vez de estirar la
                        fila. */}
                    {(pushError?.id === o.id || o.sellercloud_error) && !o.sellercloud_order_id && (
                      <p
                        title={pushError?.id === o.id ? pushError.message : o.sellercloud_error}
                        className="ml-auto max-h-24 max-w-[16rem] select-text overflow-y-auto whitespace-pre-wrap break-words text-left text-[11px] font-medium text-red-600 dark:text-red-400"
                      >
                        {pushError?.id === o.id ? pushError.message : o.sellercloud_error}
                      </p>
                    )}
                  </div>
                </td>
              </tr>
              {expanded === o.id && (
                <tr className="border-b border-primary/10 bg-primary/[0.02]">
                  <td colSpan={7} className="p-4">
                    {/* Mientras los ítems vienen (o si no vinieron), el
                        detalle lo dice — una tabla vacía se leería como
                        "pedido sin ítems", que es mentira. */}
                    {detailLoading === o.id ? (
                      <p className="py-2 text-center text-xs text-primary/50">{t('loading')}</p>
                    ) : detailError?.id === o.id ? (
                      <p className="py-2 text-center text-xs font-medium text-red-600 dark:text-red-400">
                        {t('orderItemsFailed')} — {detailError.message}
                      </p>
                    ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left uppercase tracking-wide text-primary/45">
                            <th className="pb-2 pr-4 font-semibold">{t('product')}</th>
                            <th className="pb-2 pr-4 text-right font-semibold">{t('quantity')}</th>
                            <th className="pb-2 pr-4 text-right font-semibold">{t('unitPrice')}</th>
                            <th className="pb-2 text-right font-semibold">{t('subtotal')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(displayOf(o).items ?? []).map((i, n) => (
                            <tr key={n} className="border-t border-primary/10">
                              <td className="py-1.5 pr-4">
                                <span className="font-mono text-primary/40">[{i.sku}]</span> {i.name}
                                {i.flash && <span className="ml-1 text-secondary-dark">⚡</span>}
                              </td>
                              <td className="py-1.5 pr-4 text-right">{i.qty}</td>
                              <td className="py-1.5 pr-4 text-right">{i.price != null ? money(i.price) : '—'}</td>
                              <td className="py-1.5 text-right font-semibold">
                                {i.price != null ? money(i.price * i.qty) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    )}
                  </td>
                </tr>
              )}
              {editing === o.id && (
                <tr className="border-b border-primary/10 bg-primary/[0.02]">
                  <td colSpan={7} className="p-4">
                    <div className="mx-auto max-w-2xl rounded-2xl border border-secondary/30 bg-surface p-4 shadow-sm">
                      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-secondary-dark">
                        {t('editingQuote')} — {o.clients?.name}
                      </p>

                      {editItems.length === 0 ? (
                        <p className="py-3 text-center text-xs text-primary/50">{t('emptyCart')}</p>
                      ) : (
                        <ul className="divide-y divide-line rounded-xl border border-line">
                          {editItems.map((i) => (
                            <li key={i.id} className="flex items-center gap-3 p-2.5 text-sm">
                              <span className="min-w-0 flex-1 truncate">
                                <span className="font-mono text-xs text-primary/50">[{i.sku}]</span> {i.name}
                              </span>
                              <input
                                type="number"
                                min={1}
                                max={9999}
                                value={i.qty}
                                onChange={(e) => setEditQty(i.id, Number(e.target.value))}
                                className={`${inputCls} w-20 text-right`}
                              />
                              <button
                                type="button"
                                onClick={() => removeEditItem(i.id)}
                                className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-red-600 transition-colors hover:border-red-400 dark:text-red-400"
                              >
                                {t('remove')}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="relative mt-3">
                        <input
                          type="search"
                          value={productQuery}
                          onChange={(e) => setProductQuery(e.target.value)}
                          placeholder={`${t('selectProduct')} — ${t('searchProducts')}`}
                          className={`${inputCls} w-full`}
                        />
                        {productQuery.trim() && (
                          <div className="absolute z-10 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-line bg-surface shadow-lg">
                            {(products ?? [])
                              .filter((p) => {
                                const q = productQuery.trim().toLowerCase()
                                return (
                                  p.name.toLowerCase().includes(q) ||
                                  String(p.sku).toLowerCase().includes(q)
                                )
                              })
                              .slice(0, 30)
                              .map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  onClick={() => addEditProduct(p)}
                                  className="block w-full border-b border-line/60 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-gold-pale/30"
                                >
                                  <span className="font-mono text-xs text-primary/50">{p.sku}</span> {p.name}
                                </button>
                              ))}
                          </div>
                        )}
                      </div>

                      {editError && (
                        <p className="mt-3 text-xs font-medium text-red-600 dark:text-red-400">{editError}</p>
                      )}

                      <div className="mt-4 flex gap-2">
                        <button
                          type="button"
                          disabled={editBusy}
                          onClick={() => saveEdit(o.id)}
                          className="rounded-lg bg-ink px-4 py-2 text-xs font-semibold text-secondary transition-colors hover:bg-ink-soft disabled:opacity-50"
                        >
                          {editBusy ? t('processing') : t('save')}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="rounded-lg border border-line px-4 py-2 text-xs text-primary/60 transition-colors hover:border-primary/30"
                        >
                          {t('cancel')}
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
              )
            })}
          </tbody>
        </table>
        {filtered.length > visibleRows && (
          <div ref={sentinelRef} className="py-4 text-center text-xs text-primary/40">
            {t('loading')}
          </div>
        )}
        <div className="border-t border-line px-4 py-2.5 text-xs text-primary/50">
          {filtered.length} {t('results')}
        </div>
      </div>
      )}

      {confirmStatus && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-[2px] md:items-center"
          onClick={() => setConfirmStatus(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm animate-fade-up rounded-t-3xl border-t-4 border-secondary bg-surface p-6 shadow-2xl md:rounded-3xl"
          >
            <h3 className="font-brand text-lg font-semibold">{t('confirmOrderActionTitle')}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-primary/60">
              {t('confirmOrderActionBody')} <span className="font-semibold">{statusLabel(confirmStatus.status)}</span>.
            </p>
            {stockNoticeKey && (
              <p className="mt-3 rounded-xl bg-gold-pale/50 p-3 text-xs leading-relaxed text-primary/70">
                {t(stockNoticeKey)}
              </p>
            )}
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirmStatus(null)}
                className="flex-1 rounded-xl border border-line py-2.5 text-sm font-semibold transition-colors hover:border-primary/40"
              >
                {t('cancel')}
              </button>
              <button
                onClick={() => {
                  const { id, status } = confirmStatus
                  setConfirmStatus(null)
                  applyStatus(id, status)
                }}
                className="flex-1 rounded-xl bg-ink py-2.5 text-sm font-bold text-secondary transition-opacity hover:opacity-90"
              >
                {t('confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
