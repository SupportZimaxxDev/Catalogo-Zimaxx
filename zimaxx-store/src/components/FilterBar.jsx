import { useI18n } from '../i18n'

const chipCls = (active, size = 'text-xs') =>
  `whitespace-nowrap rounded-full px-4 py-1.5 ${size} font-medium transition-all ${
    active
      ? 'bg-ink text-secondary ring-1 ring-secondary/40'
      : 'border border-line bg-surface text-primary/70 hover:border-secondary hover:text-primary'
  }`

// Chips de categoría/línea/disponibilidad. Vive pegado al Header (ver
// Catalog.jsx: ambos comparten el mismo contenedor sticky) para que no
// queden escondidos debajo de Flash Sale cuando esa sección crece.
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
}) {
  const { t } = useI18n()

  if (categories.length === 0 && lines.length <= 1 && !hasPreorder && !hasFlashType) return null

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
      {(hasPreorder || hasFlashType) && (
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          <button onClick={() => onAvailabilityChange('')} className={chipCls(!availability)}>
            {t('allStatuses')}
          </button>
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
        </div>
      )}
    </div>
  )
}
