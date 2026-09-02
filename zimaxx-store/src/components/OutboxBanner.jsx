import { useState, useSyncExternalStore } from 'react'
import { useI18n } from '../i18n'
import { flushPending, outboxStatus, subscribeOutbox } from '../utils/orderOutbox'

// Aviso del outbox en el catálogo del cliente (2026-09-02): si quedó un
// pedido/cotización sin registrar, el cliente lo VE — antes el único rastro
// visible vivía dentro del drawer del carrito, y si el cliente no lo volvía a
// abrir, nadie se enteraba hasta que el pendiente expiraba.
//
// Dos estados (ver outboxStatus en orderOutbox.js):
//   * 'pending'  → hay un pendiente que ya falló: banner + "Reintentar ahora"
//                  (dispara el mismo ciclo de reintento del outbox, saltando
//                  el tope de reintentos automáticos — es un pedido a mano).
//   * 'reported' → el pendiente expiró y quedó entregado al equipo de ventas
//                  (order_failures): mensaje informativo, sin botón. Dura lo
//                  que dura la sesión (sessionStorage) y no vuelve a aparecer
//                  en la próxima visita.
//
// El snapshot es un string primitivo a propósito: useSyncExternalStore
// compara por identidad y un objeto nuevo por llamada re-renderizaría en loop.
const snapshot = () => {
  const s = outboxStatus()
  return s ? `${s.state}:${s.kind === 'quote' ? 'quote' : 'order'}` : ''
}

export default function OutboxBanner({ token }) {
  const { t } = useI18n()
  const status = useSyncExternalStore(subscribeOutbox, snapshot)
  const [busy, setBusy] = useState(false)

  if (!status || !token) return null
  const [state, kind] = status.split(':')

  const retry = async () => {
    if (busy) return
    setBusy(true)
    try {
      await flushPending(token, { manual: true })
    } finally {
      setBusy(false)
    }
  }

  if (state === 'reported') {
    return (
      <div className="mb-4 animate-fade-up rounded-2xl border border-secondary/40 bg-gold-pale/40 p-4 text-sm leading-relaxed text-primary/80">
        {t(kind === 'quote' ? 'outboxReportedQuote' : 'outboxReportedOrder')}
      </div>
    )
  }

  return (
    <div className="mb-4 flex animate-fade-up flex-wrap items-center justify-between gap-3 rounded-2xl border border-secondary/50 bg-gold-pale/50 p-4">
      <p className="text-sm leading-relaxed text-primary/80">
        {t(kind === 'quote' ? 'outboxPendingQuote' : 'outboxPendingOrder')}{' '}
        <span className="text-primary/60">{t('outboxPendingBody')}</span>
      </p>
      <button
        onClick={retry}
        disabled={busy}
        className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-secondary transition-colors hover:bg-ink-soft disabled:opacity-50"
      >
        {busy ? t('outboxRetrying') : t('outboxRetryNow')}
      </button>
    </div>
  )
}
