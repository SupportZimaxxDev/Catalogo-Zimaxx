import { useState } from 'react'
import { useI18n } from '../i18n'
import { useCart } from '../context/CartContext'
import { money } from '../utils/format'
import { buildOrderMessage, whatsappUrl } from '../utils/whatsapp'
import { downloadOrderPdf } from '../utils/pdf'
import { supabase } from '../lib/supabase'

// Pedido mínimo del negocio: no se puede enviar una orden por debajo de
// este monto.
const MIN_ORDER = Number(import.meta.env.VITE_MIN_ORDER ?? 800)

// Drawer lateral (desktop) / hoja completa (móvil) con resumen y checkout.
export default function CartDrawer({ token, client }) {
  const { t } = useI18n()
  const cart = useCart()
  // 'order' | 'quote' | null. Al enviar un pedido o generar una cotización
  // el carrito se vacía (2026-08-04, a pedido del usuario), así que este
  // estado es lo que se muestra en lugar de "tu carrito está vacío".
  const [sent, setSent] = useState(null)
  // Mismo par de valores, pero para el camino que falló: el pedido salió por
  // WhatsApp y NO quedó registrado. A diferencia de `sent`, acá el carrito se
  // conserva a propósito (2026-08-05) — es lo único que queda del pedido, y
  // adivinar que se guardó bien es justamente lo que hizo que un pedido de
  // ~10k se perdiera sin que nadie se enterara.
  const [failed, setFailed] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!cart.open) return null

  const clientName = client?.name ?? ''
  const belowMin = cart.hasPrices && cart.total < MIN_ORDER

  // Cerrar el drawer también descarta el acuse: si vuelve a abrirlo para
  // armar otro pedido, arranca limpio. `failed` no se toca: mientras el
  // pedido siga sin registrar, el aviso tiene que seguir ahí al reabrir.
  const close = () => {
    cart.setOpen(false)
    setSent(null)
  }

  // Registra el pedido/cotización. Devuelve:
  //   'ok'       → quedó guardado
  //   'rejected' → el RPC lo rechazó (token, tope de líneas, ítems inválidos).
  //                Reintentar da lo mismo siempre; el motivo ya quedó en
  //                order_failures, que es donde hay que mirar.
  //   'error'    → no se pudo hablar con la base (red, timeout, 5xx). Esto sí
  //                se reintenta.
  const saveOrder = async (items, total, kind, requestId) => {
    const args = {
      p_token: token,
      p_items: items,
      p_total: total,
      p_kind: kind,
      p_request_id: requestId,
    }
    try {
      const { data, error } = await supabase.rpc('create_order', args)
      if (!error) return data ? 'ok' : 'rejected'
      // Base sin migration-2026-08-05-order-capture.sql: la función de 5
      // argumentos no existe y PostgREST no la encuentra (PGRST202). Se
      // reintenta sin p_request_id para no dejar el checkout caído si el
      // frontend se despliega antes de correr el SQL.
      //
      // La condición mira el CÓDIGO, no el texto: con un match laxo, cualquier
      // error que mencionara la función mandaría por el camino sin idempotencia
      // y un intento que sí se guardó podría terminar duplicado. Acá no puede
      // pasar: si la firma de 5 argumentos no existe, el primer intento no
      // guardó nada.
      const notFound =
        error.code === 'PGRST202' ||
        /could not find the function/i.test(error.message ?? '')
      if (notFound) {
        const { p_request_id, ...legacy } = args
        const retry = await supabase.rpc('create_order', legacy)
        if (!retry.error) return retry.data ? 'ok' : 'rejected'
      }
      console.warn('No se pudo registrar la orden:', error)
      return 'error'
    } catch (e) {
      console.warn('No se pudo registrar la orden:', e)
      return 'error'
    }
  }

  // Reintenta solo los fallos de transporte. Es seguro porque create_order es
  // idempotente por request_id: si el intento anterior sí llegó y lo único que
  // se perdió fue la respuesta, esto devuelve ese mismo pedido, no otro.
  const saveWithRetry = async (items, total, kind, requestId, tries) => {
    let res = 'error'
    for (let n = 0; n < tries; n++) {
      res = await saveOrder(items, total, kind, requestId)
      if (res !== 'error') return res
      if (n < tries - 1) await new Promise((r) => setTimeout(r, 700 * (n + 1)))
    }
    return res
  }

  // Cierra el envío según cómo terminó el registro. El carrito se vacía solo
  // cuando el pedido está realmente guardado.
  const settle = (kind, res) => {
    if (res === 'ok') {
      setFailed(null)
      setSent(kind)
      cart.clear()
    } else {
      setSent(null)
      setFailed(kind)
    }
  }

  const handleCheckout = async () => {
    if (cart.items.length === 0 || belowMin || busy) return
    // Copia local: el carrito se vacía al final y el mensaje/PDF ya no
    // podrían leerlo.
    const items = cart.items
    const total = cart.total
    const requestId = cart.requestId
    setBusy(true)
    // try/finally: sin esto, una excepción no prevista (ej. buildOrderMessage
    // o window.open) deja `busy` en true para siempre y los tres botones del
    // drawer (comparten el mismo estado) quedan deshabilitados sin ningún
    // aviso — un cliente reportó justo esto (2026-08-13): no podía ni pedir
    // por WhatsApp ni descargar el PDF.
    try {
      const first = await saveOrder(items, total, 'order', requestId)
      // WhatsApp se abre igual si el registro falló: la asesora recibe la
      // lista y el pedido no se pierde del todo. Va antes de los reintentos
      // para que el navegador siga tratando la ventana como consecuencia del
      // click.
      const msg = buildOrderMessage({ t, clientName, items, total })
      window.open(whatsappUrl(client?.vendedora_phone, msg), '_blank')
      const res =
        first === 'error' ? await saveWithRetry(items, total, 'order', requestId, 2) : first
      settle('order', res)
    } catch (e) {
      console.warn('Checkout falló de forma inesperada:', e)
      settle('order', 'error')
    } finally {
      setBusy(false)
    }
  }

  const handlePdf = async () => {
    if (cart.items.length === 0 || busy) return
    const items = cart.items
    const total = cart.total
    const requestId = cart.requestId
    setBusy(true)
    try {
      await downloadOrderPdf({ t, clientName, items, total })
      // Registrarlo como cotización en el panel (2026-07-17, a pedido del
      // usuario). El PDF ya se descargó, nada bloquea al cliente.
      const res = await saveWithRetry(items, total, 'quote', requestId, 3)
      settle('quote', res)
    } catch (e) {
      // Si downloadOrderPdf tira (jsPDF sin poder cargarse con mala señal,
      // nombre de producto con algo que rompe el render) esto evita que el
      // cliente se quede con el carrito congelado sin saber por qué.
      console.warn('No se pudo generar/registrar la cotización:', e)
      settle('quote', 'error')
    } finally {
      setBusy(false)
    }
  }

  // Reintento a mano desde el aviso, con el carrito tal como está ahora. No
  // vuelve a abrir WhatsApp ni a bajar el PDF: eso ya salió.
  const handleRetrySave = async () => {
    if (cart.items.length === 0 || busy) return
    setBusy(true)
    try {
      const res = await saveWithRetry(cart.items, cart.total, failed, cart.requestId, 3)
      settle(failed, res)
    } catch (e) {
      console.warn('Reintento falló de forma inesperada:', e)
    } finally {
      setBusy(false)
    }
  }

  // El acuse reemplaza al carrito vacío recién enviado; si el cliente agrega
  // otro producto, vuelve a mandar la lista de ítems.
  const showSent = sent !== null && cart.items.length === 0

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={close} />
      <aside className="animate-drawer absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-bg shadow-2xl">
        <div className="flex items-center justify-between border-b border-secondary/30 bg-ink px-5 py-4 text-white">
          <h2 className="font-brand text-lg font-semibold text-secondary">
            {t('cart')}
            <span className="ml-2 text-sm font-normal text-white/50">({cart.count})</span>
          </h2>
          <button
            onClick={close}
            className="flex h-8 w-8 items-center justify-center rounded-full text-xl leading-none text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {showSent ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gold-pale text-2xl font-bold text-secondary-dark">
                ✓
              </span>
              {/* Solo el acuse: alcanza con decir que salió (2026-08-14, a
                  pedido del usuario). Antes debajo iba una línea explicando que
                  se había vaciado el carrito "para que no se envíe dos veces";
                  el carrito se sigue vaciando igual, no hace falta contarlo. */}
              <p className="font-brand text-base font-semibold">
                {sent === 'quote' ? t('quoteSent') : t('orderSent')}
              </p>
              <button
                onClick={close}
                className="mt-2 rounded-xl border-2 border-primary px-5 py-2 text-sm font-semibold transition-colors hover:bg-ink hover:text-secondary"
              >
                {t('startNewOrder')}
              </button>
            </div>
          ) : cart.items.length === 0 ? (
            <p className="py-12 text-center text-primary/50">{t('emptyCart')}</p>
          ) : (
            <>
              {/* El pedido salió por WhatsApp pero no quedó registrado
                  (2026-08-05). Va arriba de todo y en rojo porque antes esto
                  era una línea ámbar dentro del acuse de ✓ con el carrito ya
                  vacío: nadie lo leía y el pedido se perdía. */}
              {failed && (
                <div className="mb-3 rounded-xl border-2 border-red-500 bg-red-50 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-red-700">
                    ⚠️ {t('saveFailedTitle')}
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-red-900/80">
                    {failed === 'quote' ? t('quoteSaveWarn') : t('orderSaveFailed')}
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-red-900/80">{t('cartKept')}</p>
                  <button
                    onClick={handleRetrySave}
                    disabled={busy}
                    className="mt-2.5 w-full rounded-lg bg-red-600 py-2 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? t('retrying') : t('retrySave')}
                  </button>
                </div>
              )}

              {/* Disponibilidad/precio sujetos a cambio (2026-08-04, a pedido
                  del usuario): el catálogo arrastra stock e importes que
                  pueden moverse entre que el cliente arma el pedido y la
                  asesora lo cierra. */}
              <div className="mb-3 flex gap-2.5 rounded-xl border border-secondary/40 bg-gold-pale/50 p-3">
                <span aria-hidden="true" className="text-base leading-none">
                  ⚠️
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-wide text-secondary-dark">
                    {t('cartNoticeTitle')}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-primary/70">{t('cartNoticeBody')}</p>
                </div>
              </div>

              <ul className="space-y-2.5">
                {cart.items.map((i) => (
                  <li
                    key={`${i.id}-${i.flash ? 'f' : 'n'}`}
                    className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {i.flash && <span className="mr-1 text-secondary-dark">⚡</span>}
                        {i.name}
                      </p>
                      {/* Mismo UPC que muestra la tarjeta del catálogo
                          (2026-08-14): el carrito es lo último que el cliente
                          revisa antes de mandar el pedido. Un carrito guardado
                          antes de este cambio no lo trae y no pasa nada. */}
                      {i.upc && (
                        <p className="truncate font-mono text-[10px] tracking-wide text-primary/40">
                          UPC {i.upc}
                        </p>
                      )}
                      <p className="text-xs text-primary/50">
                        {i.price != null && <>{money(i.price)} c/u</>}
                        {i.preorder && (
                          <span className="ml-1.5 rounded-full bg-gold-pale px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-secondary-dark">
                            {t('preorder')}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => cart.setQty(i.id, i.flash, i.qty - 1)}
                        className="h-8 w-8 rounded-full border border-line font-bold text-primary/70 transition-colors hover:border-secondary hover:text-primary"
                      >
                        −
                      </button>
                      <span className="w-8 text-center text-sm font-semibold">{i.qty}</span>
                      <button
                        onClick={() => cart.setQty(i.id, i.flash, i.qty + 1)}
                        className="h-8 w-8 rounded-full border border-line font-bold text-primary/70 transition-colors hover:border-secondary hover:text-primary"
                      >
                        +
                      </button>
                    </div>
                    {i.price != null && (
                      <p className="w-16 text-right font-brand text-sm font-semibold">
                        {money(i.price * i.qty)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {cart.items.length > 0 && (
          <div className="space-y-3 border-t border-line bg-surface p-4">
            {cart.hasPrices && (
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold uppercase tracking-wider text-primary/60">
                  {t('total')}
                </span>
                <span className="font-brand text-2xl font-semibold">{money(cart.total)}</span>
              </div>
            )}

            {belowMin && (
              <p className="rounded-lg bg-gold-pale/60 p-3 text-xs font-medium leading-relaxed">
                {t('minOrderIs')} {money(MIN_ORDER)} · {t('missingForMin')}{' '}
                <span className="font-bold">{money(MIN_ORDER - cart.total)}</span>
              </p>
            )}

            <button
              onClick={() => setConfirming(true)}
              disabled={belowMin || busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] py-3 font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.297-.497.1-.198.05-.371-.025-.52-.074-.149-.668-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
              </svg>
              {t('checkout')}
            </button>
            <div className="flex gap-2">
              <button
                onClick={handlePdf}
                disabled={busy}
                className="flex-1 rounded-xl border-2 border-primary py-2 text-sm font-semibold transition-colors hover:bg-ink hover:text-secondary disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t('downloadPdf')}
              </button>
              <button
                onClick={() => {
                  cart.clear()
                  setSent(null)
                  setFailed(null)
                }}
                className="rounded-xl border border-line px-4 py-2 text-sm text-primary/60 transition-colors hover:border-primary/30 hover:text-primary"
              >
                {t('clearCart')}
              </button>
            </div>
          </div>
        )}
      </aside>

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-[2px] md:items-center"
          onClick={() => setConfirming(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm animate-fade-up rounded-t-3xl border-t-4 border-secondary bg-surface p-6 shadow-2xl md:rounded-3xl"
          >
            <h3 className="font-brand text-lg font-semibold">{t('confirmOrderTitle')}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-primary/60">{t('confirmOrderBody')}</p>
            <div className="mt-4 flex items-baseline justify-between rounded-xl bg-gold-pale/40 px-4 py-3">
              <span className="text-sm text-primary/60">
                {cart.count} {t('items')}
              </span>
              {cart.hasPrices && (
                <span className="font-brand text-lg font-semibold">{money(cart.total)}</span>
              )}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-primary/50">{t('cartNoticeBody')}</p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-xl border border-line py-2.5 text-sm font-semibold transition-colors hover:border-primary/40"
              >
                {t('confirmOrderReview')}
              </button>
              <button
                onClick={() => {
                  setConfirming(false)
                  handleCheckout()
                }}
                className="flex-1 rounded-xl bg-[#25D366] py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
              >
                {t('confirmOrderSend')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
