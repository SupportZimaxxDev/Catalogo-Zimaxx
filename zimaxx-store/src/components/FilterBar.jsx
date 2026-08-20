import { useI18n } from '../i18n'

const chipCls = (active, size = 'text-xs') =>
  `whitespace-nowrap rounded-full px-4 py-1.5 ${size} font-medium transition-all ${
    active
      ? 'bg-ink text-secondary ring-1 ring-secondary/40'
      : 'border border-line bg-surface text-primary/70 hover:border-secondary hover:text-primary'
  }`

// Chips de categoría/línea/disponibilidad. Vive pegado al Header (ver
// Catalog.jsx: ambos comparten el mismo contenedor sticky) para quedar
// siempre a la vista sin importar cuánto crezca el contenido de abajo.
// El chip 🔥 Flash Sale filtra por la etiqueta del producto: desde
// 2026-08-07 es la única Flash Sale que hay (no existe más la sección de
// ofertas con precio promo y cuenta regresiva).
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
  // ⭐ Más vendidos (2026-08-20): mismo patrón que ✨ Nuevo — el chip solo
  // aparece si el catálogo trae al menos un producto marcado por la base.
  hasTop,
  onlyTop,
  onOnlyTopChange,
  // Orden por precio (2026-08-20): oculto para la lista 'quote' (sin precios).
  hasPrices,
  sortBy,
  onSortChange,
}) {
  const { t } = useI18n()

  if (
    categories.length === 0 &&
    lines.length <= 1 &&
    !hasPreorder &&
    !hasFlashType &&
    !hasNew &&
    !hasTop &&
    !hasPrices
  )
    return null

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
      {(hasPreorder || hasFlashType || hasNew || hasTop || hasPrices) && (
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
          <button
            onClick={() => {
              onAvailabilityChange('')
              onOnlyNewChange(false)
              onOnlyTopChange?.(false)
            }}
            className={chipCls(!availability && !onlyNew && !onlyTop)}
          >
            {t('allStatuses')}
          </button>
          {/* Primero de los chips especiales: es el gancho comercial. */}
          {hasTop && (
            <button onClick={() => onOnlyTopChange(!onlyTop)} className={chipCls(onlyTop)}>
              ⭐ {t('topSellers')}
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
    </div>
  )
}
