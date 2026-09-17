// Campanita de avisos del panel (2026-09-17, a pedido del usuario): la
// vendedora ve, desde cualquier pestaña, que alguien le recuperó un pedido o
// una cotización de uno de sus clientes. Vive en el header de AdminLayout,
// solo para el rol vendedora; el estado lo tiene useRecoveryNotices en el
// layout (un solo dueño, compartido con el cuadro "Pedidos recuperados" de
// la bandeja) — acá solo se pinta.
//
// Cada aviso dice de quién era el intento, cuándo y quién lo recuperó, y
// ofrece "Ver" (va a la cotización en Pedidos, que lleva el chip ♻️) y
// "Marcar visto". El visto es explícito, no automático al abrir (decisión del
// usuario): el contador baja solo cuando ella lo toca. El historial completo
// no está acá ni en Pedidos: vive en el Registro de movimientos (solo admin),
// también a pedido del usuario. Si la base no tiene la migración, el hook
// marca `unavailable` y la campanita no se pinta.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n'
import { fmtDateTime, agoLabel } from '../utils/format'
import { NOTICES_CAP } from '../hooks/useRecoveryNotices'

export default function RecoveryBell({ recoveries, userId }) {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  const { notices, unavailable, marking, markError, clearMarkError, markSeen } = recoveries

  // Cierra con click afuera o Escape.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (unavailable) return null

  const count = notices.length
  const countLabel = count >= NOTICES_CAP ? t('recoveryMore', { n: NOTICES_CAP }) : String(count)
  // "por vos" si lo recuperó la misma persona que está mirando (no debería
  // pasar — una autorrecuperación nace vista — pero el historial sí lo usa).
  const who = (n) => (n.recovered_by && n.recovered_by === userId ? t('recoveryByYou') : n.recovered_by_email ?? '—')

  const view = (n) => {
    setOpen(false)
    navigate(`/admin/orders?recovered=${n.recovered_order_id}`)
  }

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => {
          clearMarkError()
          setOpen((v) => !v)
        }}
        aria-label={t('recoveryBell')}
        aria-expanded={open}
        title={t('recoveryBell')}
        data-testid="recovery-bell"
        className={`relative rounded-full border px-2.5 py-1 text-sm leading-none transition-colors ${
          count > 0
            ? 'border-secondary/60 text-secondary hover:bg-white/10'
            : 'border-white/20 text-white/60 hover:border-white/40 hover:text-white'
        }`}
      >
        🔔
        {count > 0 && (
          <span
            data-testid="recovery-bell-count"
            className="absolute -right-1.5 -top-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-bold leading-none text-ink"
          >
            {countLabel}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="recovery-panel"
          className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-3 text-left text-primary shadow-2xl"
        >
          <h3 className="text-sm font-bold">
            ♻️ {t('recoveryBell')}
            {count > 0 && ` (${countLabel})`}
          </h3>

          {count === 0 ? (
            <p className="mt-2 text-xs text-primary/60" data-testid="recovery-empty">
              {t('recoveryBellEmpty')}
            </p>
          ) : (
            <>
              <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-0.5">
                {notices.map((n) => (
                  <li key={n.id} data-testid="recovery-notice" className="rounded-lg border border-line bg-primary/[0.02] p-2.5">
                    <p className="text-xs font-semibold leading-snug">
                      {t(n.kind === 'quote' ? 'recoveryNoticeQuote' : 'recoveryNoticeOrder', {
                        client: n.clients?.name ?? t('unknownClient'),
                      })}
                    </p>
                    <p className="mt-1 text-[11px] leading-snug text-primary/60">
                      📅 {fmtDateTime(n.recovered_at, lang)}
                      {agoLabel(n.recovered_at, t) && ` · ${agoLabel(n.recovered_at, t)}`} ·{' '}
                      {t('recoveryBy', { who: who(n) })}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => view(n)}
                        className="rounded-lg bg-ink px-2.5 py-1 text-[11px] font-bold text-secondary transition-colors hover:bg-ink-soft"
                      >
                        {t('recoveryView')}
                      </button>
                      <button
                        type="button"
                        onClick={() => markSeen([n.id])}
                        disabled={marking}
                        data-testid="recovery-mark-seen"
                        className="rounded-lg border border-line px-2.5 py-1 text-[11px] font-semibold text-primary/70 transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t('recoveryMarkSeen')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => markSeen(notices.map((n) => n.id))}
                disabled={marking}
                data-testid="recovery-mark-all"
                className="mt-2 w-full rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-primary/70 transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('recoveryMarkAllSeen')}
              </button>
            </>
          )}

          {markError && (
            <p className="mt-2 text-xs font-medium text-red-700 dark:text-red-300">
              {t('recoveryMarkFailed')}: {markError}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
