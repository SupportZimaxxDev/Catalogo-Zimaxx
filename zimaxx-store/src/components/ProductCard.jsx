import { useI18n } from '../i18n'
import { useCart } from '../context/CartContext'
import { money } from '../utils/format'
import ProductImage from './ProductImage'

export default function ProductCard({ product }) {
  const { t } = useI18n()
  const cart = useCart()

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-surface transition-all duration-300 hover:-translate-y-1 hover:border-secondary/50 hover:shadow-lg hover:shadow-black/10">
      {product.availability === 'preorder' && (
        <span className="absolute left-2 top-2 z-10 rounded-full bg-ink/90 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-secondary ring-1 ring-secondary/40">
          {t('preorder')}
        </span>
      )}
      <ProductImage src={product.image_url} alt={product.name} />
      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        {product.category && (
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-secondary-dark">
            {product.category}
          </p>
        )}
        <h3 className="flex-1 text-sm font-medium leading-snug text-primary">{product.name}</h3>
        {product.price != null && (
          <p className="font-brand text-xl font-semibold text-primary">
            {money(product.price)}
          </p>
        )}
        <button
          onClick={() => cart.add(product, Number(product.price))}
          className="mt-1.5 rounded-xl bg-ink py-2.5 text-sm font-semibold text-secondary transition-colors duration-200 hover:bg-secondary hover:text-ink"
        >
          {t('add')}
        </button>
      </div>
    </div>
  )
}
