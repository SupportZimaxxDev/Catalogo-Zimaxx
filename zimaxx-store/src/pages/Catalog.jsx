import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useI18n } from '../i18n'
import Header from '../components/Header'
import FilterBar from '../components/FilterBar'
import ProductCard from '../components/ProductCard'
import CartBar from '../components/CartBar'
import CartDrawer from '../components/CartDrawer'
import { useInfiniteRows } from '../hooks/useInfiniteRows'
import { loadFavorites, pushFavorite, saveFavorites } from '../utils/favorites'

// Género y sets derivados DEL NOMBRE (2026-08-20): no hay columna de género
// — el dato vive en el nombre tal como llega del export de SellerCloud, y en
// el catálogo real la cobertura es casi total (medido en producción: de 875
// activos, 330 "Men", 355 "Women", 185 "Unisex" y solo 5 sin token; 95 con
// "Set"). Por eso se deriva acá y no con una migración: es clasificación de
// presentación, no un dato nuevo.
const RE_UNISEX = /\bunisex\b/i
const RE_WOMEN = /\bwom[ae]n\b/i
const RE_MEN = /\b(men|man)\b/i // \b evita el falso positivo de "woMEN"
const RE_SET = /\bsets?\b/i

function genderOf(name) {
  const n = String(name ?? '')
  if (RE_UNISEX.test(n)) return 'unisex'
  if (RE_WOMEN.test(n)) return 'women'
  if (RE_MEN.test(n)) return 'men'
  return null
}

// Los dos valores canónicos de product_line (ver parseLine en ProductsAdmin).
const LINE_ARABIC = 'Perfume - Arabes'
const LINE_DESIGNER = 'Perfume'

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
  // ⭐ Más vendidos (2026-08-20; por línea desde la cuarta tanda del día):
  // '' = sin filtro, 'global' = is_top (top 12 general), 'arabes'/'disenador'
  // = is_top_line + la línea (top 12 DE cada línea, para que una línea que
  // vende más no tape el top de la otra).
  const [topFilter, setTopFilter] = useState('')
  // Mujer / Hombre / Sets (2026-08-20): derivados del nombre (ver genderOf).
  // Mujer y Hombre INCLUYEN unisex a propósito — la pregunta que responde el
  // chip es "¿qué le puedo vender a una mujer/un hombre?", y un unisex
  // califica en las dos.
  const [segment, setSegment] = useState('')
  // ❤️ Favoritos (2026-08-20; en la base desde la quinta tanda): el estado
  // arranca del caché local (corazones al instante) y cuando llega
  // get_catalog MANDA EL SERVIDOR — el efecto de carga lo reemplaza con los
  // is_fav y reescribe el caché. Sin la migración corrida, is_fav llega
  // undefined y esto queda en modo solo-dispositivo (v1).
  const [favs, setFavs] = useState(() => loadFavorites(token))
  const [onlyFavs, setOnlyFavs] = useState(false)
  // Orden por precio (2026-08-20): '' = orden del catálogo (categoría+nombre,
  // como viene del servidor), 'price_desc' / 'price_asc'.
  const [sortBy, setSortBy] = useState('')
  // Render progresivo: 3,000+ tarjetas de golpe traban el scroll en móvil.
  // Se cargan más automáticamente a medida que el cliente scrollea.
  const [visible, sentinelRef] = useInfiniteRows(48, [
    search,
    category,
    line,
    availability,
    onlyNew,
    topFilter,
    segment,
    onlyFavs,
  ])

  // Estable a propósito: ProductCard está memoizado y un handler nuevo en
  // cada render re-renderizaría todas las tarjetas visibles. Optimista: la UI
  // y el caché cambian ya; la base se entera con pushFavorite (fire-and-
  // forget con keepalive — un corazón nunca espera ni muestra errores).
  const toggleFav = useCallback(
    (id) => {
      setFavs((prev) => {
        const next = new Set(prev)
        const fav = !next.has(id)
        if (fav) next.add(id)
        else next.delete(id)
        saveFavorites(token, next)
        pushFavorite(token, id, fav)
        return next
      })
    },
    [token],
  )

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const catalogRes = token
        ? await supabase.rpc('get_catalog', { p_token: token })
        : { data: null }
      if (cancelled) return
      const catalog = catalogRes.data
      setClient(catalog?.client ?? null)
      const list = catalog?.products ?? []
      setProducts(list)
      // Con la base migrada, los favoritos DEL SERVIDOR pisan lo local (es la
      // fuente de verdad: sobreviven al cambio de teléfono y son el registro
      // que ve el negocio) y refrescan el caché. Sin migración, is_fav no
      // viene y se queda lo del dispositivo.
      if (list.some((p) => p.is_fav !== undefined)) {
        const serverFavs = new Set(list.filter((p) => p.is_fav).map((p) => p.id))
        setFavs(serverFavs)
        saveFavorites(token, serverFavs)
      }
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [token])

  // Género y set se calculan UNA vez por carga de catálogo, no en cada
  // filtrado: son regex sobre miles de nombres.
  const enriched = useMemo(
    () => products.map((p) => ({ ...p, gender: genderOf(p.name), is_set: RE_SET.test(p.name ?? '') })),
    [products],
  )

  const categories = useMemo(
    () => [...new Set(enriched.map((p) => p.category).filter(Boolean))].sort(),
    [enriched],
  )

  // 'product_line' viene de PRODUCT_CATEGORY en el Excel (ej. "Perfume" vs
  // "Perfume - Arabes" = dupes árabes) — distinto de 'category', que acá
  // guarda la marca (Brand).
  const lines = useMemo(
    () => [...new Set(enriched.map((p) => p.product_line).filter(Boolean))].sort(),
    [enriched],
  )

  // Hay pedidos de "todo lo Adidas" o "todo lo que sea Pre-Order": la
  // categoría también entra en la búsqueda de texto, y availability tiene
  // su propio filtro además de los chips de categoría.
  const hasPreorder = useMemo(() => enriched.some((p) => p.availability === 'preorder'), [enriched])
  // 'flash' es una etiqueta del producto (Type = Flash Sale del Excel de
  // inventario, o puesta a mano desde la pestaña Productos): marca lo que se
  // quiere mover, sin precio promo ni countdown asociado. Desde 2026-08-07 es
  // la única forma de Flash Sale que existe — la tabla `flash_sales` de
  // ofertas con precio propio y cuenta regresiva salió del producto.
  const hasFlashType = useMemo(() => enriched.some((p) => p.availability === 'flash'), [enriched])
  // is_new lo calcula get_catalog en el servidor (now() < products.new_until).
  const hasNew = useMemo(() => enriched.some((p) => p.is_new), [enriched])
  // is_top lo calcula get_catalog desde los pedidos reales (2026-08-20). Con
  // una base sin la migración llega undefined y el chip no aparece — mismo
  // patrón de degradación que is_new/upc. is_top_line (cuarta tanda del día)
  // es el top DE cada línea: sus chips solo aparecen si esa línea tiene algún
  // marcado.
  const hasTop = useMemo(() => enriched.some((p) => p.is_top), [enriched])
  const hasTopArabic = useMemo(
    () => enriched.some((p) => p.is_top_line && p.product_line === LINE_ARABIC),
    [enriched],
  )
  const hasTopDesigner = useMemo(
    () => enriched.some((p) => p.is_top_line && p.product_line === LINE_DESIGNER),
    [enriched],
  )
  const hasWomen = useMemo(() => enriched.some((p) => p.gender === 'women' || p.gender === 'unisex'), [enriched])
  const hasMen = useMemo(() => enriched.some((p) => p.gender === 'men' || p.gender === 'unisex'), [enriched])
  const hasSets = useMemo(() => enriched.some((p) => p.is_set), [enriched])
  // El selector de orden por precio solo tiene sentido si hay precios: un
  // cliente de la lista 'quote' no ve ninguno.
  const hasPrices = useMemo(() => enriched.some((p) => p.price != null), [enriched])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = enriched.filter(
      (p) =>
        (!category || p.category === category) &&
        (!line || p.product_line === line) &&
        (!availability || p.availability === availability) &&
        (!onlyNew || p.is_new) &&
        (topFilter === '' ||
          (topFilter === 'global' && p.is_top) ||
          (topFilter === 'arabes' && p.is_top_line && p.product_line === LINE_ARABIC) ||
          (topFilter === 'disenador' && p.is_top_line && p.product_line === LINE_DESIGNER)) &&
        (segment === '' ||
          (segment === 'women' && (p.gender === 'women' || p.gender === 'unisex')) ||
          (segment === 'men' && (p.gender === 'men' || p.gender === 'unisex')) ||
          (segment === 'sets' && p.is_set)) &&
        (!onlyFavs || favs.has(p.id)) &&
        (!q ||
          p.name.toLowerCase().includes(q) ||
          (p.category ?? '').toLowerCase().includes(q) ||
          (p.product_line ?? '').toLowerCase().includes(q) ||
          // 2026-08-14: desde que el UPC se ve en la tarjeta, tiene que poder
          // buscarse — si no, el cliente lo lee en el catálogo y no lo puede usar.
          (p.upc ?? '').toLowerCase().includes(q)),
    )
    // El sort va sobre la copia que ya devolvió filter. Empates por nombre
    // para que el orden sea estable entre renders; un precio null (no debería
    // haber, salvo lista quote donde el selector ni se muestra) va al final.
    if (sortBy === 'price_asc' || sortBy === 'price_desc') {
      const dir = sortBy === 'price_asc' ? 1 : -1
      list.sort((a, b) => {
        const pa = a.price == null ? null : Number(a.price)
        const pb = b.price == null ? null : Number(b.price)
        if (pa == null && pb == null) return a.name.localeCompare(b.name)
        if (pa == null) return 1
        if (pb == null) return -1
        return pa === pb ? a.name.localeCompare(b.name) : (pa - pb) * dir
      })
    }
    return list
  }, [enriched, search, category, line, availability, onlyNew, topFilter, segment, onlyFavs, favs, sortBy])

  const validClient = !!client
  const showFilters = validClient && !loading

  return (
    <div className="min-h-screen pb-24 md:pb-8">
      {/* Header + filtros comparten este sticky (2026-07-09): así los chips
          quedan pegados al buscador sin tener que calcular a mano la altura
          del header. */}
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
            hasTop={hasTop}
            hasTopArabic={hasTopArabic}
            hasTopDesigner={hasTopDesigner}
            topFilter={topFilter}
            onTopFilterChange={setTopFilter}
            hasWomen={hasWomen}
            hasMen={hasMen}
            hasSets={hasSets}
            segment={segment}
            onSegmentChange={setSegment}
            favCount={favs.size}
            onlyFavs={onlyFavs}
            onOnlyFavsChange={setOnlyFavs}
            hasPrices={hasPrices}
            sortBy={sortBy}
            onSortChange={setSortBy}
          />
        )}
      </div>

      <main className="mx-auto max-w-6xl px-4 py-6">
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
                    <ProductCard
                      key={p.id}
                      product={p}
                      isFav={favs.has(p.id)}
                      onToggleFav={toggleFav}
                    />
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
