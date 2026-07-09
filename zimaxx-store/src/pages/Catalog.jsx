import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useI18n } from '../i18n'
import Header from '../components/Header'
import FilterBar from '../components/FilterBar'
import FlashSaleSection from '../components/FlashSaleSection'
import ProductCard from '../components/ProductCard'
import CartBar from '../components/CartBar'
import CartDrawer from '../components/CartDrawer'
import { useInfiniteRows } from '../hooks/useInfiniteRows'

export default function Catalog() {
  const { t } = useI18n()
  // Los dos valores que importan para filtrar se leen en español/inglés
  // claro en vez del texto crudo del export ("Perfume"/"Perfume - Arabes");
  // el resto (si algún día entra Beauty, Electronics, etc.) se muestra tal cual.
  const lineLabel = (raw) =>
    raw === 'Perfume' ? t('lineDesigner') : raw === 'Perfume - Arabes' ? t('lineArabic') : raw
  const [params] = useSearchParams()
  const token = params.get('c') ?? ''

  const [loading, setLoading] = useState(true)
  const [client, setClient] = useState(null)
  const [products, setProducts] = useState([])
  const [flashSales, setFlashSales] = useState([])
  // `searchInput` es lo que se ve en el campo (responde a cada tecla sin
  // demora); `search`, con debounce, es lo que de verdad filtra. Filtrar
  // miles de productos en cada tecla es lo que causaba el lag al escribir.
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput), 150)
    return () => clearTimeout(id)
  }, [searchInput])
  const [category, setCategory] = useState('')
  const [line, setLine] = useState('')
  const [availability, setAvailability] = useState('')
  const [onlyNew, setOnlyNew] = useState(false)
  // Render progresivo: 3,000+ tarjetas de golpe traban el scroll en móvil.
  // Se cargan más automáticamente a medida que el cliente scrollea.
  const [visible, sentinelRef] = useInfiniteRows(48, [search, category, line, availability, onlyNew])

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

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter(Boolean))].sort(),
    [products],
  )

  // 'product_line' viene de PRODUCT_CATEGORY en el Excel (ej. "Perfume" vs
  // "Perfume - Arabes" = dupes árabes) — distinto de 'category', que acá
  // guarda la marca (Brand).
  const lines = useMemo(
    () => [...new Set(products.map((p) => p.product_line).filter(Boolean))].sort(),
    [products],
  )

  // Hay pedidos de "todo lo Adidas" o "todo lo que sea Pre-Order": la
  // categoría también entra en la búsqueda de texto, y availability tiene
  // su propio filtro además de los chips de categoría.
  const hasPreorder = useMemo(() => products.some((p) => p.availability === 'preorder'), [products])
  // 'flash' es una etiqueta del producto en el Excel de inventario (Type =
  // Flash Sale), distinta de la tabla flash_sales de ofertas con precio
  // promo — acá solo filtra por la etiqueta, sin precio asociado.
  const hasFlashType = useMemo(() => products.some((p) => p.availability === 'flash'), [products])
  // is_new lo calcula get_catalog en el servidor (now() < products.new_until).
  const hasNew = useMemo(() => products.some((p) => p.is_new), [products])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter(
      (p) =>
        (!category || p.category === category) &&
        (!line || p.product_line === line) &&
        (!availability || p.availability === availability) &&
        (!onlyNew || p.is_new) &&
        (!q ||
          p.name.toLowerCase().includes(q) ||
          (p.category ?? '').toLowerCase().includes(q) ||
          (p.product_line ?? '').toLowerCase().includes(q)),
    )
  }, [products, search, category, line, availability, onlyNew])

  const validClient = !!client
  const showFilters = validClient && !loading
  // Con búsqueda o algún chip activo, Flash Sale se oculta para no competir
  // con los resultados; sin filtros vuelve a aparecer como al entrar.
  const hasActiveFilters = !!search.trim() || !!category || !!line || !!availability || onlyNew

  return (
    <div className="min-h-screen pb-24 md:pb-8">
      {/* Header + filtros comparten este sticky (2026-07-09): así los chips
          quedan pegados al buscador sin importar cuánto crezca Flash Sale
          debajo, y sin tener que calcular a mano la altura del header. */}
      <div className="sticky top-0 z-30">
        <Header
          clientName={client?.name}
          search={searchInput}
          onSearchChange={setSearchInput}
          showSearch={showFilters}
        />
        {showFilters && (
          <FilterBar
            categories={categories}
            category={category}
            onCategoryChange={setCategory}
            lines={lines}
            line={line}
            onLineChange={setLine}
            lineLabel={lineLabel}
            hasPreorder={hasPreorder}
            hasFlashType={hasFlashType}
            availability={availability}
            onAvailabilityChange={setAvailability}
            hasNew={hasNew}
            onlyNew={onlyNew}
            onOnlyNewChange={setOnlyNew}
          />
        )}
      </div>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* Flash Sale siempre trae precio real: no aplica al catálogo de cotización sin precios.
            Se oculta mientras haya una búsqueda o filtro activo, para no competir con los resultados. */}
        {!client?.is_quote_only && !hasActiveFilters && (
          <FlashSaleSection sales={flashSales} canOrder={validClient} />
        )}

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
            {filtered.length === 0 ? (
              <p className="py-20 text-center text-primary/50">{t('noProducts')}</p>
            ) : (
              <>
                <p className="mb-3 text-xs uppercase tracking-[0.2em] text-primary/40">
                  {filtered.length} {t('results')}
                </p>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4">
                  {filtered.slice(0, visible).map((p) => (
                    <ProductCard key={p.id} product={p} />
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
      <CartDrawer token={token} client={client} />
    </div>
  )
}
