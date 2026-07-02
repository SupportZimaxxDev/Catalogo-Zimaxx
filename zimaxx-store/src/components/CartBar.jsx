import { useI18n } from '../i18n'
import { useCart } from '../context/CartContext'
import { money } from '../utils/format'

// Barra inferior fija en móvil: total + "Ver carrito", accesible con una mano.
export default function CartBar() {
  const { t } = useI18n()
  const cart = useCart()

  if (cart.count === 0) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 p-3 md:hidden">
      <button
        onClick={() => cart.setOpen(true)}
        className="flex w-full items-center justify-between rounded-2xl border border-secondary/40 bg-ink px-5 py-3.5 text-white shadow-2xl shadow-black/40"
      >
        <span className="flex items-center gap-2.5 font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-xs font-bold text-ink">
            {cart.count}
          </span>
          {t('viewCart')}
        </span>
        {cart.hasPrices && (
          <span className="font-brand text-lg font-semibold text-secondary">
            {money(cart.total)}
          </span>
        )}
      </button>
    </div>
  )
}
