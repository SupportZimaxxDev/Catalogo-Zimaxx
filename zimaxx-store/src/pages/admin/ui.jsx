// Piezas de UI compartidas del panel admin.

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

// Zona de carga de Excel colapsable: los uploads son ocasionales y no
// deben robarle espacio a la tabla, que es el trabajo diario.
export function UploadZone({ icon, title, hint, busy, result, onFile }) {
  return (
    <details className="group rounded-2xl border border-line bg-surface shadow-sm">
      <summary className="flex cursor-pointer select-none items-center gap-3 p-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gold-pale/60 text-lg">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
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
        <p className="text-xs leading-relaxed text-primary/60">{hint}</p>
        <label className="block cursor-pointer rounded-xl border-2 border-dashed border-secondary/50 p-6 text-center transition-colors hover:border-secondary hover:bg-gold-pale/20">
          <input type="file" accept=".xlsx,.xls,.csv" onChange={onFile} className="hidden" />
          <p className="text-sm font-semibold text-primary/80">{busy ? '…' : title}</p>
        </label>
        {result && (
          <p
            className={`rounded-lg p-3 text-xs leading-relaxed ${
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
