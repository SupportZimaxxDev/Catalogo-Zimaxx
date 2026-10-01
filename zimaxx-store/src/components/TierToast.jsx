import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useCart } from '../context/CartContext'
import { money } from '../utils/format'

// Aviso al cliente cuando el carrito cruza una marca de nivel de precios
// (2026-10-01): "¡Superaste $2,000! Tus precios ahora son los de US
// Wholesale · Ahorrás $150". También cuando baja de la marca (al quitar
// productos), para que no quede pensando que sigue pagando el precio
// anterior. Se cierra solo a los 8 s o con la ✕. Solo cambios de nivel: la
// primera pintura (carrito recuperado del teléfono) no avisa.
const AUTO_HIDE_MS = 8000

export default function TierToast() {
  const { t } = useI18n()
  const cart = useCart()
  const [toast, setToast] = useState(null)
  const prev = useRef(null)

  const index = cart.tierIndex
  const tiers = cart.tiers
  useEffect(() => {
    if (tiers.length < 2) {
      prev.current = null
      return
    }
    if (prev.current === null) {
      prev.current = index
      return
    }
    if (index === prev.current) return
    const up = index > prev.current
    // La marca que se cruzó: la del nivel al que se subió, o del que se bajó.
    const crossed = tiers[up ? index : prev.current]
    prev.current = index
    setToast({
      up,
      amount: Number(crossed?.threshold ?? 0),
      list: tiers[index]?.label ?? '',
      savings: cart.savings,
      key: Date.now(),
    })
  }, [index, tiers]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), AUTO_HIDE_MS)
    return () => clearTimeout(id)
  }, [toast])

  if (!toast) return null

  return (
    <div
      data-testid="tier-toast"
      role="status"
      className="fixed inset-x-3 top-3 z-50 mx-auto max-w-md animate-fade-up rounded-2xl border-2 border-secondary bg-ink p-4 text-white shadow-2xl shadow-black/40"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="text-2xl leading-none">
          {toast.up ? '🎉' : '↩️'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-secondary">
            {toast.up
              ? t('tierUnlockedTitle', { amount: money(toast.amount) })
              : t('tierLostTitle', { amount: money(toast.amount) })}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/80">
            {toast.up
              ? t('tierUnlockedBody', { list: toast.list })
              : t('tierLostBody', { list: toast.list })}
            {toast.up && toast.savings > 0 && (
              <>
                {' '}
                <span className="font-semibold text-secondary">
                  {t('tierSavingsShort', { amount: money(toast.savings) })}
                </span>
              </>
            )}
          </p>
        </div>
        <button
          onClick={() => setToast(null)}
          aria-label="close"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-lg leading-none text-white/60 hover:bg-white/10 hover:text-white"
        >
          ×
        </button>
      </div>
    </div>
  )
}
