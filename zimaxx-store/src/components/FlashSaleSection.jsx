import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { useCart } from '../context/CartContext'
import { money } from '../utils/format'
import ProductImage from './ProductImage'

function Countdown({ expiresAt }) {
  const { t } = useI18n()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const ms = new Date(expiresAt).getTime() - now
  if (ms <= 0) return null

  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')

  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-ink px-2.5 py-1 font-mono text-xs font-bold text-secondary ring-1 ring-secondary/25">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-secondary" />
      {t('flashEnds')} {d > 0 && `${d}${t('days')} `}
      {pad(h)}:{pad(m)}:{pad(sec)}
    </span>
  )
}

// Sección Flash Sale: visible para cualquier visitante. Con token válido se
// puede agregar al carrito al precio promo; sin token es solo vista.
export default function FlashSaleSection({ sales, canOrder }) {
  const { t } = useI18n()
  const cart = useCart()
  const list = sales ?? []
  const [cutoff, setCutoff] = useState(() => Date.now())

  // Antes esto era un setInterval de 1s que recalculaba `activeSales` (y
  // por lo tanto re-renderizaba toda la grilla, cientos de tarjetas con
  // carga masiva de flash sales) solo para chequear vencimientos. Ahora se
  // agenda un único setTimeout justo para el próximo vencimiento — el
  // grid solo se vuelve a renderizar cuando de verdad hay algo que ocultar.
  useEffect(() => {
    const nextExpiry = list
      .map((s) => new Date(s.expires_at).getTime())
      .filter((ms) => ms > Date.now())
      .sort((a, b) => a - b)[0]
    if (nextExpiry == null) return
    const id = setTimeout(() => setCutoff(Date.now()), Math.max(nextExpiry - Date.now() + 250, 250))
    return () => clearTimeout(id)
  }, [list, cutoff])

  const activeSales = useMemo(
    () => list.filter((s) => new Date(s.expires_at).getTime() > cutoff),
    [list, cutoff],
  )

  if (activeSales.length === 0) return null

  return (
    <section className="mb-8 animate-fade-up rounded-3xl bg-ink p-4 md:p-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="font-brand text-xl font-semibold italic text-secondary md:text-2xl">
          Flash Sale
        </h2>
        <span className="hidden h-px flex-1 bg-secondary/25 md:block" />
        <span className="text-[11px] uppercase tracking-[0.2em] text-white/50">
          {t('flashOnly')}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {activeSales.map((s) => (
          <div
            key={s.id}
            className="group flex flex-col overflow-hidden rounded-2xl bg-surface transition-transform duration-300 hover:-translate-y-1"
          >
            <ProductImage src={s.image_url} alt={s.name} />
            <div className="flex flex-1 flex-col gap-1.5 p-3.5">
              <h3 className="flex-1 text-sm font-medium leading-snug">{s.name}</h3>
              <p className="font-brand text-xl font-semibold text-secondary-dark">
                {money(s.price)}
              </p>
              <Countdown expiresAt={s.expires_at} />
              {canOrder && (
                <button
                  onClick={() => cart.add({ id: s.product_id, name: s.name }, Number(s.price), { flash: true })}
                  className="mt-1.5 rounded-xl bg-secondary py-2.5 text-sm font-bold text-ink transition-colors hover:bg-secondary-dark"
                >
                  {t('add')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
