import { useI18n } from '../i18n'

const chipCls = (active, size = 'text-xs') =>
  `whitespace-nowrap rounded-full px-4 py-1.5 ${size} font-medium transition-all ${
    active
      ? 'bg-ink text-secondary ring-1 ring-secondary/40'
      : 'border border-line bg-surface text-primary/70 hover:border-secondary hover:text-primary'
  }`

// Chips de categoría/línea/disponibilidad + segmento. Vive pegado al Header
// (ver Catalog.jsx: ambos comparten el mismo contenedor sticky) para quedar
// siempre a la vista sin importar cuánto crezca el contenido de abajo.
// El chip 🔥 Flash Sale filtra por la etiqueta del producto: desde
// 2026-08-07 es la única Flash Sale que hay (no existe más la sección de
// ofertas con precio promo y cuenta regresiva).
//
// 2026-08-20 (cuarta tanda): se suman los ⭐ Más vendidos POR LÍNEA (el top de
// cada línea, para que la que más vende no tape a la otra), la fila de
// segmento (Mujer / Hombre / Sets, derivados del nombre — ver Catalog.jsx) y
// ❤️ Favoritos. Cada chip aparece solo si el catálogo tiene con qué
// responderle; con una base sin las migraciones de ranking, los ⭐
// simplemente no salen.
export default function FilterBar({
  categories,
  category,
  onCategoryChange,
  lines,
  line,
  onLineChange,
  lineLabel,
  hasPreorder,
  hasFlashType,
  availability,
  onAvailabilityChange,
  hasNew,
  onlyNew,
  onOnlyNewChange,
  hasTop,
  hasTopArabic,
  hasTopDesigner,
  topFilter,
  onTopFilterChange,
  hasWomen,
  hasMen,
  hasSets,
  segment,
  onSegmentChange,
  favCount,
  onlyFavs,
  onOnlyFavsChange,
  hasPrices,
  sortBy,
  onSortChange,
}) {
  const { t } = useI18n()

  const hasStatusRow =
    hasPreorder || hasFlashType || hasNew || hasTop || hasTopArabic || hasTopDesigner || hasPrices
  const hasSegmentRow = hasWomen || hasMen || hasSets || favCount > 0

  if (categories.length === 0 && lines.length <= 1 && !hasStatusRow && !hasSegmentRow) return null

  // Un solo botón "Todos" resetea todos los filtros especiales de una: es el
  // escape para volver al catálogo completo sin destildar chip por chip.
  const resetSpecials = () => {
    onAvailabilityChange('')
    onOnlyNewChange(false)
    onTopFilterChange('')
    onSegmentChange('')
    onOnlyFavsChange(false)
  }
  const anySpecial = availability || onlyNew || topFilter || segment || onlyFavs

  const toggleTop = (value) => onTopFilterChange(topFilter === value ? '' : value)
  const toggleSegment = (value) => onSegmentChange(segment === value ? '' : value)

  return (
    <div className="space-y-2 border-b border-line bg-bg px-4 py-2.5">
      {categories.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          <button onClick={() => onCategoryChange('')} className={chipCls(!category, 'text-sm')}>
            {t('allCategories')}
          </button>
          {categories.map((c) => (
            <button key={c} onClick={() => onCategoryChange(c === category ? '' : c)} className={chipCls(category === c, 'text-sm')}>
              {c}
            </button>
          ))}
        </div>
      )}
      {lines.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          <button onClick={() => onLineChange('')} className={chipCls(!line)}>
            {t('allLines')}
          </button>
          {lines.map((l) => (
            <button key={l} onClick={() => onLineChange(l === line ? '' : l)} className={chipCls(line === l)}>
              {lineLabel(l)}
            </button>
          ))}
        </div>
      )}
      {hasStatusRow && (
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
          <button onClick={resetSpecials} className={chipCls(!anySpecial)}>
            {t('allStatuses')}
          </button>
          {/* Primero los ⭐: son el gancho comercial. El global y los de línea
              son excluyentes entre sí (un solo topFilter). */}
          {hasTop && (
            <button onClick={() => toggleTop('global')} className={chipCls(topFilter === 'global')}>
              ⭐ {t('topSellers')}
            </button>
          )}
          {hasTopArabic && (
            <button onClick={() => toggleTop('arabes')} className={chipCls(topFilter === 'arabes')}>
              ⭐ {t('topSellersArabic')}
            </button>
          )}
          {hasTopDesigner && (
            <button onClick={() => toggleTop('disenador')} className={chipCls(topFilter === 'disenador')}>
              ⭐ {t('topSellersDesigner')}
            </button>
          )}
          {hasNew && (
            <button onClick={() => onOnlyNewChange(!onlyNew)} className={chipCls(onlyNew)}>
              ✨ {t('newTag')}
            </button>
          )}
          <button
            onClick={() => onAvailabilityChange(availability === 'available' ? '' : 'available')}
            className={chipCls(availability === 'available')}
          >
            {t('inStock')}
          </button>
          {hasPreorder && (
            <button
              onClick={() => onAvailabilityChange(availability === 'preorder' ? '' : 'preorder')}
              className={chipCls(availability === 'preorder')}
            >
              {t('preorder')}
            </button>
          )}
          {hasFlashType && (
            <button
              onClick={() => onAvailabilityChange(availability === 'flash' ? '' : 'flash')}
              className={chipCls(availability === 'flash')}
            >
              🔥 {t('flashSale')}
            </button>
          )}
          {/* Orden por precio (2026-08-20): a la derecha de los chips, con el
              mismo lenguaje visual redondeado. Solo si el catálogo tiene
              precios — para la lista 'quote' no hay nada que ordenar. */}
          {hasPrices && (
            <select
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value)}
              aria-label={t('sortDefault')}
              className="ml-auto shrink-0 rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-primary/70 outline-none transition-colors hover:border-secondary focus:border-secondary"
            >
              <option value="">{t('sortDefault')}</option>
              <option value="price_desc">{t('sortPriceDesc')}</option>
              <option value="price_asc">{t('sortPriceAsc')}</option>
            </select>
          )}
        </div>
      )}
      {/* Segmento (Mujer/Hombre/Sets, excluyentes entre sí — Mujer y Hombre
          incluyen unisex a propósito) + ❤️ Favoritos, que recién aparece
          cuando el cliente marcó alguno con el corazón de la tarjeta. */}
      {hasSegmentRow && (
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          {hasWomen && (
            <button onClick={() => toggleSegment('women')} className={chipCls(segment === 'women')}>
              {t('filterWomen')}
            </button>
          )}
          {hasMen && (
            <button onClick={() => toggleSegment('men')} className={chipCls(segment === 'men')}>
              {t('filterMen')}
            </button>
          )}
          {hasSets && (
            <button onClick={() => toggleSegment('sets')} className={chipCls(segment === 'sets')}>
              {t('filterSets')}
            </button>
          )}
          {favCount > 0 && (
            <button onClick={() => onOnlyFavsChange(!onlyFavs)} className={chipCls(onlyFavs)}>
              ❤️ {t('favorites')} ({favCount})
            </button>
          )}
        </div>
      )}
    </div>
  )
}
