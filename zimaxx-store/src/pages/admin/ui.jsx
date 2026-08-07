// Piezas de UI compartidas del panel admin.

import { useI18n } from '../../i18n'

export { useInfiniteRows } from '../../hooks/useInfiniteRows'

export function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-primary/40"
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

export const inputCls =
  'rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none transition-colors placeholder:text-primary/35 focus:border-secondary'

// ---------- Filtros de producto (compartidos Productos ↔ Precios) ----------
// 2026-08-07: la pestaña Precios pasó a filtrar por los mismos grupos que la
// de Productos (marca, línea, pre-order, 🔥 flash, ✨ nuevo, stock) para poder
// mirar los precios de un grupo puntual. La regla de qué pasa cada filtro vive
// acá y no duplicada en cada página: si divergen, el panel dice una cosa y la
// otra pestaña otra sobre los mismos productos.

// La etiqueta ✨ Nuevo es una fecha, no un booleano: vence sola.
export const isNewProduct = (p) => !!p.new_until && new Date(p.new_until).getTime() > Date.now()

// Estados disponibles en el select. `photo: true` = solo tiene sentido donde
// se cargó image_url (Productos); Precios no lo pide y lo omite.
const STATUS_OPTIONS = [
  { value: 'active', key: 'active' },
  { value: 'inactive', key: 'inactive' },
  { value: 'instock', key: 'withStock' },
  { value: 'nostock', key: 'outOfStock' },
  { value: 'noimage', key: 'noImage', photo: true },
  { value: 'preorder', key: 'preorder' },
  { value: 'flash', key: 'flashSale', icon: '🔥' },
  { value: 'new', key: 'newTag', icon: '✨' },
]

export function productMatchesStatus(p, statusFilter) {
  switch (statusFilter) {
    case '':
    case undefined:
      return true
    case 'active':
      return !!p.active
    case 'inactive':
      return !p.active
    case 'instock':
      return p.stock >= 1
    case 'nostock':
      return p.stock != null && p.stock <= 0
    case 'noimage':
      return !p.image_url
    case 'preorder':
      return p.availability === 'preorder'
    case 'flash':
      return p.availability === 'flash'
    case 'new':
      return isNewProduct(p)
    default:
      return true
  }
}

// `__none__` en marca/línea = "sin ese dato" (productos sin categorizar).
export function productMatchesFilters(p, { query = '', catFilter = '', lineFilter = '', statusFilter = '' }) {
  if (catFilter === '__none__' ? p.category : catFilter && p.category !== catFilter) return false
  if (lineFilter === '__none__' ? p.product_line : lineFilter && p.product_line !== lineFilter)
    return false
  if (!productMatchesStatus(p, statusFilter)) return false
  const q = query.trim().toLowerCase()
  if (
    q &&
    !String(p.name ?? '').toLowerCase().includes(q) &&
    !String(p.sku ?? '').toLowerCase().includes(q) &&
    !String(p.upc ?? '').toLowerCase().includes(q)
  )
    return false
  return true
}

// Buscador + los tres selects, idénticos en las dos pestañas.
export function ProductFilters({
  query,
  onQueryChange,
  categories,
  catFilter,
  onCatChange,
  lines,
  lineFilter,
  onLineChange,
  lineLabel,
  statusFilter,
  onStatusChange,
  withPhotoStatus = false,
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-2 md:flex-row">
      <div className="relative flex-1">
        <SearchIcon />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('searchProducts')}
          className={`${inputCls} w-full pl-10`}
        />
      </div>
      <select value={catFilter} onChange={(e) => onCatChange(e.target.value)} className={inputCls}>
        <option value="">{t('allCategories')}</option>
        <option value="__none__">{t('uncategorized')}</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {lines.length > 0 && (
        <select value={lineFilter} onChange={(e) => onLineChange(e.target.value)} className={inputCls}>
          <option value="">{t('allLines')}</option>
          <option value="__none__">{t('uncategorized')}</option>
          {lines.map((l) => (
            <option key={l} value={l}>
              {lineLabel ? lineLabel(l) : l}
            </option>
          ))}
        </select>
      )}
      <select
        value={statusFilter}
        onChange={(e) => onStatusChange(e.target.value)}
        className={inputCls}
      >
        <option value="">{t('allStatuses')}</option>
        {STATUS_OPTIONS.filter((o) => withPhotoStatus || !o.photo).map((o) => (
          <option key={o.value} value={o.value}>
            {o.icon ? `${o.icon} ` : ''}
            {t(o.key)}
          </option>
        ))}
      </select>
    </div>
  )
}

// Zona de carga de Excel colapsable: los uploads son ocasionales y no
// deben robarle espacio a la tabla, que es el trabajo diario.
// min-w-0/overflow-hidden: como ítem de grid, sin esto el contenido largo
// del hint estira el cuadro más allá del ancho del teléfono.
export function UploadZone({ icon, title, hint, busy, result, onFile }) {
  return (
    <details className="group min-w-0 max-w-full overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <summary className="flex cursor-pointer select-none list-none items-center gap-3 p-4 [&::-webkit-details-marker]:hidden">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gold-pale/60 text-lg">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="truncate text-xs text-primary/50">{hint}</p>
        </div>
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0 text-primary/40 transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="space-y-3 px-4 pb-4">
        <p className="break-words text-xs leading-relaxed text-primary/60">{hint}</p>
        <label className="block cursor-pointer rounded-xl border-2 border-dashed border-secondary/50 px-4 py-6 text-center transition-colors hover:border-secondary hover:bg-gold-pale/20">
          <input type="file" accept=".xlsx,.xls,.csv" onChange={onFile} className="hidden" />
          <p className="break-words text-sm font-semibold text-primary/80">{busy ? '…' : title}</p>
        </label>
        {result && (
          <p
            className={`break-words rounded-lg p-3 text-xs leading-relaxed ${
              result.ok ? 'bg-green-50 text-green-800 dark:bg-green-950/50 dark:text-green-300' : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300'
            }`}
          >
            {result.message}
          </p>
        )}
      </div>
    </details>
  )
}
