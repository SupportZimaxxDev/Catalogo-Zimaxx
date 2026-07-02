import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useI18n } from '../i18n'
import Header from '../components/Header'
import FlashSaleSection from '../components/FlashSaleSection'
import ProductCard from '../components/ProductCard'
import CartBar from '../components/CartBar'
import CartDrawer from '../components/CartDrawer'
import { useInfiniteRows } from '../hooks/useInfiniteRows'

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-primary/40"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

export default function Catalog() {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const token = params.get('c') ?? ''

  const [loading, setLoading] = useState(true)
  const [client, setClient] = useState(null)
  const [products, setProducts] = useState([])
  const [flashSales, setFlashSales] = useState([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  // Render progresivo: 3,000+ tarjetas de golpe traban el scroll en móvil.
  // Se cargan más automáticamente a medida que el cliente scrollea.
  const [visible, sentinelRef] = useInfiniteRows(48, [search, category])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const [catalogRes, flashRes] = await Promise.all([
        token ? supabase.rpc('get_catalog', { p_token: token }) : Promise.resolve({ data: null }),
        supabase.rpc('get_flash_sales'),
      ])
      if (cancelled) return
      const catalog = catalogRes.data
      setClient(catalog?.client ?? null)
      setProducts(catalog?.products ?? [])
      setFlashSales(Array.isArray(flashRes.data) ? flashRes.data : [])
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [token])

  const specialMode = client?.price_list_code === 'special'

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter(Boolean))].sort(),
    [products],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter(
      (p) => (!category || p.category === category) && (!q || p.name.toLowerCase().includes(q)),
    )
  }, [products, search, category])

  const validClient = !!client

  return (
    <div className="min-h-screen pb-24 md:pb-8">
      <Header clientName={client?.name} />

      <main className="mx-auto max-w-6xl px-4 py-6">
        <FlashSaleSection sales={flashSales} canOrder={validClient && !specialMode} />

        {loading ? (
          <div className="flex flex-col items-center gap-3 py-20">
            <img src="/zimaxx.png" alt="" className="h-12 w-12 animate-pulse" />
            <p className="text-sm text-primary/50">{t('loading')}</p>
          </div>
        ) : !validClient ? (
          <div className="mx-auto mt-8 max-w-md animate-fade-up rounded-3xl border border-line bg-surface p-10 text-center shadow-sm">
            <img src="/zimaxx.png" alt="Zimaxx" className="mx-auto mb-5 h-14 w-14" />
            <h2 className="font-brand mb-2 text-xl font-semibold">Zimaxx Store</h2>
            <p className="text-sm leading-relaxed text-primary/60">{t('invalidLink')}</p>
          </div>
        ) : (
          <>
            {specialMode && (
              <div className="mb-5 animate-fade-up rounded-2xl border border-secondary/40 bg-gold-pale/40 p-4">
                <p className="font-brand font-semibold italic">✨ {t('specialMode')}</p>
                <p className="mt-0.5 text-sm text-primary/70">{t('specialHint')}</p>
              </div>
            )}

            {/* Buscador + categorías */}
            <div className="mb-6 space-y-3">
              <div className="relative">
                <SearchIcon />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('search')}
                  className="w-full rounded-full border border-line bg-surface py-3 pl-11 pr-4 text-sm shadow-sm outline-none transition-colors placeholder:text-primary/35 focus:border-secondary"
                />
              </div>
              {categories.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  <button
                    onClick={() => setCategory('')}
                    className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
                      !category
                        ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                        : 'border border-line bg-surface text-primary/70 hover:border-secondary hover:text-primary'
                    }`}
                  >
                    {t('allCategories')}
                  </button>
                  {categories.map((c) => (
                    <button
                      key={c}
                      onClick={() => setCategory(c === category ? '' : c)}
                      className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
                        category === c
                          ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                          : 'border border-line bg-surface text-primary/70 hover:border-secondary hover:text-primary'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {filtered.length === 0 ? (
              <p className="py-20 text-center text-primary/50">{t('noProducts')}</p>
            ) : (
              <>
                <p className="mb-3 text-xs uppercase tracking-[0.2em] text-primary/40">
                  {filtered.length} {t('results')}
                </p>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4">
                  {filtered.slice(0, visible).map((p) => (
                    <ProductCard key={p.id} product={p} specialMode={specialMode} />
                  ))}
                </div>
                {filtered.length > visible && (
                  <div ref={sentinelRef} className="flex justify-center py-8">
                    <img src="/zimaxx.png" alt="" className="h-8 w-8 animate-pulse" />
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>

      <CartBar />
      <CartDrawer token={token} client={client} specialMode={specialMode} />
    </div>
  )
}
