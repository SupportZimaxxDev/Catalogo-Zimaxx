import { useState } from 'react'
import { useI18n } from '../i18n'
import { useCart } from '../context/CartContext'
import { money } from '../utils/format'
import { buildOrderMessage, whatsappUrl } from '../utils/whatsapp'
import { downloadOrderPdf } from '../utils/pdf'
import { supabase } from '../lib/supabase'

// Pedido mínimo del negocio: no se puede enviar una orden con precios
// por debajo de este monto (las cotizaciones special no tienen mínimo).
const MIN_ORDER = Number(import.meta.env.VITE_MIN_ORDER ?? 800)

// Drawer lateral (desktop) / hoja completa (móvil) con resumen y checkout.
export default function CartDrawer({ token, client, specialMode }) {
  const { t } = useI18n()
  const cart = useCart()
  const [sent, setSent] = useState(false)

  if (!cart.open) return null

  const isQuote = !!specialMode
  const clientName = client?.name ?? ''
  const belowMin = !isQuote && cart.hasPrices && cart.total < MIN_ORDER

  const saveOrder = async () => {
    // Respaldo de auditoría; si falla no bloquea el envío por WhatsApp.
    try {
      await supabase.rpc('create_order', {
        p_token: token,
        p_items: cart.items,
        p_total: isQuote ? null : cart.total,
        p_kind: isQuote ? 'quote' : 'order',
      })
    } catch (e) {
      console.warn('No se pudo registrar la orden:', e)
    }
  }

  const handleCheckout = async () => {
    if (cart.items.length === 0 || belowMin) return
    await saveOrder()
    const msg = buildOrderMessage({
      t,
      clientName,
      items: cart.items,
      total: cart.total,
      isQuote,
    })
    window.open(whatsappUrl(client?.vendedora_phone, msg), '_blank')
    setSent(true)
  }

  const handlePdf = () => {
    if (cart.items.length === 0) return
    downloadOrderPdf({ t, clientName, items: cart.items, total: cart.total, isQuote })
  }

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => cart.setOpen(false)} />
      <aside className="animate-drawer absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-bg shadow-2xl">
        <div className="flex items-center justify-between border-b border-secondary/30 bg-ink px-5 py-4 text-white">
          <h2 className="font-brand text-lg font-semibold text-secondary">
            {isQuote ? t('specialMode') : t('cart')}
            <span className="ml-2 text-sm font-normal text-white/50">({cart.count})</span>
          </h2>
          <button
            onClick={() => cart.setOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-full text-xl leading-none text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {cart.items.length === 0 ? (
            <p className="py-12 text-center text-primary/50">{t('emptyCart')}</p>
          ) : (
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
          )}
        </div>

        {cart.items.length > 0 && (
          <div className="space-y-3 border-t border-line bg-surface p-4">
            {!isQuote && (
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold uppercase tracking-wider text-primary/60">
                  {t('total')}
                </span>
                <span className="font-brand text-2xl font-semibold">{money(cart.total)}</span>
              </div>
            )}
            {isQuote && <p className="text-xs leading-relaxed text-primary/60">{t('specialHint')}</p>}

            {belowMin && (
              <p className="rounded-lg bg-gold-pale/60 p-3 text-xs font-medium leading-relaxed">
                {t('minOrderIs')} {money(MIN_ORDER)} · {t('missingForMin')}{' '}
                <span className="font-bold">{money(MIN_ORDER - cart.total)}</span>
              </p>
            )}

            <button
              onClick={handleCheckout}
              disabled={belowMin}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] py-3 font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.297-.497.1-.198.05-.371-.025-.52-.074-.149-.668-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
              </svg>
              {isQuote ? t('requestQuote') : t('checkout')}
            </button>
            <div className="flex gap-2">
              <button
                onClick={handlePdf}
                className="flex-1 rounded-xl border-2 border-primary py-2 text-sm font-semibold transition-colors hover:bg-ink hover:text-secondary"
              >
                {t('downloadPdf')}
              </button>
              <button
                onClick={() => {
                  cart.clear()
                  setSent(false)
                }}
                className="rounded-xl border border-line px-4 py-2 text-sm text-primary/60 transition-colors hover:border-primary/30 hover:text-primary"
              >
                {t('clearCart')}
              </button>
            </div>
            {sent && <p className="text-center text-xs font-medium text-green-700 dark:text-green-400">{t('orderSent')}</p>}
          </div>
        )}
      </aside>
    </div>
  )
}
