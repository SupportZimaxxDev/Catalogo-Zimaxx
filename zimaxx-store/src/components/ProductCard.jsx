import { memo, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useCart } from '../context/CartContext'
import { money } from '../utils/format'
import ProductImage from './ProductImage'

// Compras grandes son el caso común de este catálogo B2B: además del
// stepper +/- de a uno, botones para sumar de a 10/15/20 de una.
const BULK_STEPS = [10, 15, 20]

// memo: con scroll infinito y filtros, Catalog re-renderiza seguido con
// listas de cientos de tarjetas — sin esto, cada tecla del buscador o cada
// lote nuevo del scroll infinito re-renderizaba TODAS las tarjetas ya
// visibles, no solo las nuevas.
function ProductCard({ product }) {
  const { t } = useI18n()
  const cart = useCart()
  const price = product.price == null ? null : Number(product.price)
  const qty = cart.items.find((i) => i.id === product.id && !i.flash)?.qty ?? 0

  // Input controlado aparte del qty del carrito: mientras se escribe a mano
  // no queremos que cada tecla dispare un setExactQty (y su re-render).
  const [draft, setDraft] = useState(String(qty))
  useEffect(() => setDraft(String(qty)), [qty])

  const commitDraft = (raw) => {
    const n = Math.max(0, Math.floor(Number(raw)) || 0)
    cart.setExactQty(product, price, n)
  }

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-surface transition-all duration-300 hover:-translate-y-1 hover:border-secondary/50 hover:shadow-lg hover:shadow-black/10">
      {/* El badge vive sobre la imagen del producto, que es oscura SIEMPRE
          (degradé fijo de ProductImage, no sigue el tema) — por eso usa los
          tonos crema/dorado de la paleta en hex fijo: con las clases del
          tema, gold-pale se vuelve oscuro en dark mode y el badge
          desaparecería. El puntito pulsante repite el lenguaje del
          countdown de Flash Sale para llamar la atención sin desentonar. */}
      {product.availability === 'preorder' && (
        <span className="absolute left-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-full bg-[#f0e6c8] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#16130d] shadow-md shadow-black/30 ring-1 ring-[#c9a227]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#a3821a]" />
          {t('preorder')}
        </span>
      )}
      {product.availability === 'flash' && (
        <span className="absolute left-2 top-2 z-10 rounded-full bg-secondary px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-ink ring-1 ring-ink/10">
          🔥 {t('flashSale')}
        </span>
      )}
      {/* A la derecha para no chocar con el badge de Pre-Order/Flash Sale. */}
      {product.is_new && (
        <span className="absolute right-2 top-2 z-10 rounded-full bg-green-600 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white ring-1 ring-white/20">
          ✨ {t('newTag')}
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
        {qty === 0 ? (
          <button
            onClick={() => cart.add(product, price)}
            className="mt-1.5 rounded-xl bg-ink py-2.5 text-sm font-semibold text-secondary transition-colors duration-200 hover:bg-secondary hover:text-ink"
          >
            {t('add')}
          </button>
        ) : (
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              onClick={() => cart.setExactQty(product, price, qty - 1)}
              className="h-9 w-9 shrink-0 rounded-full border border-line font-bold text-primary/70 transition-colors hover:border-secondary hover:text-primary"
            >
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={(e) => commitDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="w-full min-w-0 rounded-lg border border-line bg-surface py-1.5 text-center text-sm font-semibold outline-none transition-colors focus:border-secondary"
            />
            <button
              onClick={() => cart.add(product, price)}
              className="h-9 w-9 shrink-0 rounded-full border border-line font-bold text-primary/70 transition-colors hover:border-secondary hover:text-primary"
            >
              +
            </button>
          </div>
        )}

        <div className="flex gap-1">
          {BULK_STEPS.map((n) => (
            <button
              key={n}
              onClick={() => cart.add(product, price, { qty: n })}
              className="flex-1 rounded-lg border border-line py-1 text-[11px] font-semibold text-primary/60 transition-colors hover:border-secondary hover:text-secondary-dark"
            >
              +{n}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default memo(ProductCard)
