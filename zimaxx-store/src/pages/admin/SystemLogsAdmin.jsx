import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { inputCls } from './ui'

// Pestaña ⚙️ Sistema (2026-08-20, a pedido del usuario): los logs de errores y
// eventos operativos (system_logs) en una tabla consultable. Solo superadmin,
// igual que 📈 Métricas — el guard de la pestaña y de la ruta vive en
// AdminLayout.jsx, y el candado real es el is_superadmin() dentro de la RPC
// get_system_logs (migration-2026-08-20-system-logs.sql), que rechaza a
// cualquier otro aunque la llame a mano con la anon key.
//
// Toda la lectura va por esa RPC y no por un select a la tabla: system_logs
// tiene RLS sin policies a propósito (la escribe solo log_event), así que por
// PostgREST directo no se ve nada.
//
// Sin polling, a diferencia de Métricas: un log se mira cuando algo anda mal,
// no en vivo — botón de refrescar y listo. La paginación es por cursor
// (created_at de la última fila) con el botón "Cargar más".
const PAGE = 100

const SEVERITIES = ['info', 'warning', 'error', 'critical']

// Los sources conocidos hoy (mismos valores que documenta la migración). La
// columna no tiene CHECK así que uno nuevo simplemente aparece en la tabla —
// para filtrarlo se agrega acá.
const SOURCES = [
  'order_capture',
  'order_outbox',
  'sellercloud_push',
  'price_upload',
  'product_upload',
  'sync',
  'frontend',
]

// Gris info / amarillo warning / rojo error / rojo oscuro critical (pedido
// así): los tres primeros calcan los chips de AuditLogAdmin, critical es el
// único con fondo pleno para que se distinga de error de un vistazo.
const SEVERITY_STYLES = {
  info: 'bg-primary/10 text-primary/60',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  critical: 'bg-red-800 text-white dark:bg-red-900 dark:text-red-100',
}

// PGRST202 = la función no existe en la base: el frontend se desplegó antes de
// correr la migración. Mismo detector que MetricsAdmin.
const isMissingRpc = (e) =>
  e?.code === 'PGRST202' || /could not find the function/i.test(e?.message ?? '')

const stamp = (iso) => new Date(iso).toLocaleString()

export default function SystemLogsAdmin() {
  const { t } = useI18n()
  const [severity, setSeverity] = useState('')
  const [source, setSource] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // hasMore = la última página vino llena. Puede dar un "Cargar más" de más
  // cuando el total es múltiplo exacto de PAGE (la página siguiente llega
  // vacía y el botón desaparece) — preferible a pedir count aparte cada vez.
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState(null)
  // Igual que en MetricsAdmin: si se cambia un filtro dos veces rápido, la
  // respuesta vieja puede llegar después de la nueva y pisarla.
  const reqRef = useRef(0)

  const fetchPage = useCallback(
    async (before) => {
      const { data, error: rpcError } = await supabase.rpc('get_system_logs', {
        p_severity: severity || null,
        p_source: source || null,
        p_limit: PAGE,
        p_before: before,
      })
      if (rpcError) throw rpcError
      return data ?? []
    },
    [severity, source],
  )

  const load = useCallback(async () => {
    const seq = ++reqRef.current
    setLoading(true)
    try {
      const page = await fetchPage(null)
      if (seq !== reqRef.current) return
      setRows(page)
      setHasMore(page.length === PAGE)
      setError(null)
    } catch (e) {
      if (seq !== reqRef.current) return
      setError(e)
    }
    if (seq === reqRef.current) setLoading(false)
  }, [fetchPage])

  useEffect(() => {
    load()
    return () => {
      reqRef.current++
    }
  }, [load])

  const loadMore = async () => {
    if (rows.length === 0 || loadingMore) return
    const seq = ++reqRef.current
    setLoadingMore(true)
    try {
      const page = await fetchPage(rows[rows.length - 1].created_at)
      if (seq !== reqRef.current) return
      setRows((prev) => [...prev, ...page])
      setHasMore(page.length === PAGE)
      setError(null)
    } catch (e) {
      if (seq !== reqRef.current) return
      setError(e)
    }
    if (seq === reqRef.current) setLoadingMore(false)
  }

  const errorMessage = !error
    ? ''
    : isMissingRpc(error)
      ? t('systemMigrationMissing')
      : (error.message ?? String(error))

  const hasContext = (r) => r.context && Object.keys(r.context).length > 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-brand text-2xl font-semibold">
            ⚙️ {t('system')}
            <span className="ml-2 text-base font-normal text-primary/40">{rows.length}</span>
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-primary/55">{t('systemIntro')}</p>
        </div>
        <button
          disabled={loading || loadingMore}
          onClick={load}
          className="rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-secondary transition-colors hover:bg-ink-soft disabled:opacity-50"
        >
          {loading ? '…' : `↻ ${t('systemRefresh')}`}
        </button>
      </div>

      {errorMessage && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {errorMessage}
        </p>
      )}

      <div className="flex flex-col gap-2 md:flex-row">
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={inputCls}>
          <option value="">{t('systemAllSeverities')}</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className={inputCls}>
          <option value="">{t('systemAllSources')}</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        {loading ? (
          <p className="px-4 py-10 text-center text-sm text-primary/50">{t('loading')}</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-primary/50">{t('systemNoLogs')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-primary/45">
                <th className="p-3">{t('date')}</th>
                <th className="p-3">{t('systemSeverity')}</th>
                <th className="p-3">{t('systemSource')}</th>
                <th className="p-3">{t('systemEvent')}</th>
                <th className="p-3">{t('systemMessage')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60 align-top">
                  <td className="whitespace-nowrap p-3 text-xs text-primary/60">
                    {stamp(r.created_at)}
                  </td>
                  <td className="p-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SEVERITY_STYLES[r.severity] ?? SEVERITY_STYLES.info}`}
                    >
                      {r.severity}
                    </span>
                  </td>
                  <td className="whitespace-nowrap p-3 font-mono text-xs text-primary/70">
                    {r.source}
                  </td>
                  <td className="whitespace-nowrap p-3 font-mono text-xs font-medium">{r.event}</td>
                  <td className="p-3 text-xs text-primary/70">
                    {r.message && <p className="max-w-xl leading-relaxed">{r.message}</p>}
                    {hasContext(r) && (
                      <details className="mt-1">
                        <summary className="cursor-pointer select-none text-[11px] font-semibold text-primary/45 hover:text-primary/70">
                          {t('systemContext')}
                        </summary>
                        <pre className="mt-1 max-h-64 max-w-xl overflow-auto rounded-lg bg-primary/5 p-2 font-mono text-[11px] leading-relaxed text-primary/70">
                          {JSON.stringify(r.context, null, 2)}
                        </pre>
                        {r.user_agent && (
                          <p className="mt-1 max-w-xl break-words font-mono text-[10px] text-primary/40">
                            {r.user_agent}
                          </p>
                        )}
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && hasMore && (
          <div className="border-t border-line p-3 text-center">
            <button
              disabled={loadingMore}
              onClick={loadMore}
              className="rounded-full border border-line px-5 py-1.5 text-xs font-semibold text-primary/60 transition-colors hover:border-secondary hover:text-primary disabled:opacity-50"
            >
              {loadingMore ? '…' : t('systemLoadMore')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
