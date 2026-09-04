// Indicador de frescura de inventario + botón "🔄 Refrescar stock" (2026-09-04).
// Vive en el header del panel (AdminLayout), visible en todas las pestañas
// para todos los roles. El estado real lo tiene useInventoryFreshness en el
// layout; acá solo se pinta:
//
//   verde  → dentro del umbral        (stock_freshness_minutes, default 45)
//   ámbar  → entre umbral y 2×umbral
//   rojo   → más viejo que 2×umbral
//
// Fuera del umbral el indicador entero es también CTA: clic → refresco (el
// mismo del botón). Si get_inventory_freshness no existe (migración sin
// correr), no se pinta nada — el header queda como antes.
import { useEffect } from 'react'
import { useI18n } from '../../i18n'
import { formatAgo } from '../../hooks/useInventoryFreshness'

const TOAST_MS = 9000

export default function InventoryFreshness({ inventory }) {
  const { t } = useI18n()
  const { freshness, refreshing, lastResult, refresh, clearResult } = inventory

  // El toast se va solo; un error se puede cerrar antes con la ✕.
  useEffect(() => {
    if (!lastResult) return undefined
    const id = setTimeout(clearResult, TOAST_MS)
    return () => clearTimeout(id)
  }, [lastResult, clearResult])

  if (!freshness) return null

  const minutes = freshness.minutes_ago
  const threshold = freshness.threshold_minutes ?? 45
  const never = !freshness.last_sync
  const stale = freshness.is_stale === true
  const running = !!freshness.running || refreshing

  const tone = never
    ? 'text-white/50'
    : minutes <= threshold
      ? 'text-emerald-400'
      : minutes <= threshold * 2
        ? 'text-amber-400'
        : 'text-red-400'

  const sourceLabel =
    freshness.last_sync?.source === 'excel_upload' ? t('invSourceExcel') : t('invSourceRefresh')
  const text = never
    ? `${t('invLabel')}: ${t('invNever')}`
    : `${t('invLabel')}: ${formatAgo(minutes)} (${sourceLabel})`

  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* Fuera del umbral, el texto es también CTA (dispara el refresco). */}
      <button
        type="button"
        onClick={() => {
          if (stale && !running) refresh()
        }}
        title={
          stale
            ? t('invStaleTooltip', { time: formatAgo(minutes) })
            : `${t('invThresholdLabel')}: ${threshold} min`
        }
        className={`min-w-0 truncate text-xs font-medium ${tone} ${
          stale && !running ? 'cursor-pointer underline decoration-dotted underline-offset-2' : 'cursor-default'
        }`}
      >
        {text}
      </button>
      <button
        type="button"
        onClick={() => refresh()}
        disabled={running}
        title={running ? t('invRunning') : t('invRefreshBtn')}
        className="whitespace-nowrap rounded-full border border-white/20 px-3 py-1 text-xs text-white/80 transition-colors hover:border-secondary hover:text-secondary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-white/40 border-t-transparent" />
            {t('invRefreshing')}
          </span>
        ) : (
          t('invRefreshBtn')
        )}
      </button>

      {/* Toast de resultado (no bloqueante, se va solo). */}
      {lastResult && (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border px-4 py-3 text-sm shadow-2xl ${
            lastResult.ok
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
              : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200'
          }`}
        >
          <div className="flex items-start gap-3">
            <p className="min-w-0 flex-1 whitespace-normal leading-snug">
              {lastResult.ok
                ? t('invRefreshDone', {
                    n: lastResult.data?.updated ?? 0,
                    d: lastResult.data?.deactivated ?? 0,
                    r: lastResult.data?.reactivated ?? 0,
                  })
                : `${t('invRefreshFailed')}: ${lastResult.message}`}
            </p>
            <button
              type="button"
              onClick={clearResult}
              className="shrink-0 text-current/60 transition-opacity hover:opacity-70"
              aria-label="cerrar"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
