import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { downloadTableExcel, systemLogsExcelRows } from '../../utils/excel'
import { searchTerms, matchesTerms } from '../../utils/search'
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
//
// 2026-09-09 (a pedido del usuario): filtro rápido "👤 Clientes creados desde
// el catálogo" (source `clients`, que emite ClientsAdmin en cada alta),
// búsqueda de texto sobre lo cargado, y "Exportar Excel" con TODO lo que
// cumple los filtros (recorre todas las páginas de la RPC, no solo lo que se
// ve) con el context aplanado en columnas.
const PAGE = 100
// La RPC clampea p_limit a 500: para exportar se pide el máximo por página.
const EXPORT_PAGE = 500
// Tope del export. 5,000 filas × context aplanado es un Excel de varios MB;
// más que eso es señal de que el filtro está demasiado abierto.
const EXPORT_MAX = 5000

const SEVERITIES = ['info', 'warning', 'error', 'critical']

// Los sources conocidos hoy (mismos valores que documenta la migración). La
// columna no tiene CHECK así que uno nuevo simplemente aparece en la tabla —
// para filtrarlo se agrega acá.
const SOURCES = [
  'order_capture',
  'order_outbox',
  'sellercloud_push',
  // 2026-09-02: búsqueda/alta/vinculación de customers desde Clientes (Edge
  // Function sellercloud-customers). Faltaba en esta lista hasta 2026-09-09.
  'sellercloud_customers',
  // 2026-09-09: clientes creados desde el catálogo (formulario o Excel).
  'clients',
  'price_upload',
  'product_upload',
  // 2026-09-04: refresco de inventario desde SellerCloud (Edge Function
  // sellercloud-refresh-stock) y su override manual.
  'stock_refresh',
  'manual_refresh',
  'sync',
  'frontend',
  // 2026-09-08: descargas del Excel de la lista de precios desde el catálogo
  // del cliente (info) — sirve para saber quién sigue pidiendo el Excel.
  'catalog',
]

// Filtros rápidos: un chip = un source (y el texto que lo explica). Se
// resuelven contra el MISMO select de origen, así que el estado es uno solo.
const PRESETS = [{ key: 'clients', source: 'clients', icon: '👤', label: 'systemPresetClients', hint: 'systemPresetClientsHint' }]

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

// Texto sobre el que busca el input: evento + mensaje + context serializado
// (así "Zimaxx Box" o un teléfono encuentran la fila aunque estén en el
// detalle). Un solo campo a propósito: matchesTerms exige todos los términos
// en el mismo campo.
const haystack = (r) => `${r.event ?? ''} ${r.message ?? ''} ${JSON.stringify(r.context ?? {})}`

export default function SystemLogsAdmin() {
  const { t, lang } = useI18n()
  const [severity, setSeverity] = useState('')
  const [source, setSource] = useState('')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // hasMore = la última página vino llena. Puede dar un "Cargar más" de más
  // cuando el total es múltiplo exacto de PAGE (la página siguiente llega
  // vacía y el botón desaparece) — preferible a pedir count aparte cada vez.
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState(null) // { kind: 'error' | 'warn', text }
  // Igual que en MetricsAdmin: si se cambia un filtro dos veces rápido, la
  // respuesta vieja puede llegar después de la nueva y pisarla.
  const reqRef = useRef(0)

  const fetchPage = useCallback(
    async (before, limit = PAGE) => {
      const { data, error: rpcError } = await supabase.rpc('get_system_logs', {
        p_severity: severity || null,
        p_source: source || null,
        p_limit: limit,
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

  // Búsqueda sobre lo cargado (misma regla por términos que el resto del
  // panel, ver utils/search.js).
  const terms = useMemo(() => searchTerms(query), [query])
  const matchesQuery = useCallback((r) => terms.length === 0 || matchesTerms(terms, haystack(r)), [terms])
  const visible = useMemo(() => rows.filter(matchesQuery), [rows, matchesQuery])

  // Etiquetas de las claves de context que se conocen, para las columnas del
  // Excel (las demás salen con su nombre crudo). Los `via` se traducen aparte.
  const contextLabels = useMemo(
    () => ({
      client_id: t('systemCtxClientId'),
      name: t('name'),
      client: t('systemCtxClient'),
      phone: t('phone'),
      email: t('email'),
      price_list: t('systemCtxPriceList'),
      vendedora: t('systemCtxVendedora'),
      business_name: t('businessName'),
      business: t('businessName'),
      group: t('scGroup'),
      group_id: t('scGroup'),
      account_manager: t('scAccountManager'),
      account_manager_id: t('scAccountManager'),
      salesman: t('scSalesman'),
      comments: t('scComments'),
      created_by: t('systemCtxCreatedBy'),
      via: t('systemCtxVia'),
      sellercloud_requested: t('systemCtxScRequested'),
      file: t('systemCtxFile'),
      sellercloud_id: t('systemCtxSellercloudId'),
      warning: t('systemCtxWarning'),
    }),
    [t],
  )
  const viaLabel = (via) => (via === 'panel' ? t('systemViaPanel') : via === 'excel' ? t('systemViaExcel') : via)

  // Exportar: TODAS las páginas del filtro actual (severidad + origen del lado
  // de la RPC, búsqueda del lado de acá), con tope EXPORT_MAX. No exporta
  // solo lo cargado a propósito — "los datos que se filtren" son todos los que
  // cumplen el filtro, no los 100 que entraron en pantalla.
  const exportExcel = async () => {
    setExporting(true)
    setExportNotice(null)
    try {
      let all = []
      let before = null
      let capped = false
      for (;;) {
        const page = await fetchPage(before, EXPORT_PAGE)
        all = all.concat(page)
        if (page.length < EXPORT_PAGE) break
        if (all.length >= EXPORT_MAX) {
          capped = true
          all = all.slice(0, EXPORT_MAX)
          break
        }
        before = page[page.length - 1].created_at
      }
      const data = all.filter(matchesQuery).map((r) =>
        r.context?.via ? { ...r, context: { ...r.context, via: viaLabel(r.context.via) } } : r,
      )
      if (data.length === 0) {
        setExportNotice({ kind: 'error', text: t('systemExportEmpty') })
        return
      }
      const filterDesc = [
        severity || t('systemAllSeverities'),
        source ? (PRESETS.find((p) => p.source === source) ? t(PRESETS.find((p) => p.source === source).label) : source) : t('systemAllSources'),
      ].join(' · ')
      const table = systemLogsExcelRows({ t, rows: data, labels: contextLabels, stamp })
      const now = new Date()
      await downloadTableExcel({
        filename: `zimaxx-logs-sistema${source ? `-${source}` : ''}-${now.toISOString().slice(0, 10)}.xlsx`,
        title: t('systemExportTitle'),
        metaLines: [
          `${t('systemExportFilter')}: ${filterDesc}`,
          ...(query.trim() ? [`${t('systemExportSearch')}: ${query.trim()}`] : []),
          `${t('systemExportGenerated')}: ${now.toLocaleString(lang === 'en' ? 'en-US' : 'es-VE')} · ${data.length} ${t('results')}`,
        ],
        header: table.header,
        rows: table.rows,
        widths: table.widths,
        priceCol: -1,
        sheetName: t('system'),
      })
      if (capped) setExportNotice({ kind: 'warn', text: t('systemExportCapped', { max: EXPORT_MAX }) })
    } catch (e) {
      setExportNotice({ kind: 'error', text: isMissingRpc(e) ? t('systemMigrationMissing') : e.message ?? String(e) })
    } finally {
      setExporting(false)
    }
  }

  const errorMessage = !error
    ? ''
    : isMissingRpc(error)
      ? t('systemMigrationMissing')
      : (error.message ?? String(error))

  const hasContext = (r) => r.context && Object.keys(r.context).length > 0
  const activePreset = PRESETS.find((p) => p.source === source)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-brand text-2xl font-semibold">
            ⚙️ {t('system')}
            <span className="ml-2 text-base font-normal text-primary/40">
              {terms.length > 0 ? `${visible.length} / ${rows.length}` : rows.length}
            </span>
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-primary/55">{t('systemIntro')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            disabled={loading || exporting || rows.length === 0}
            onClick={exportExcel}
            title={t('systemExportHint', { max: EXPORT_MAX })}
            className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-primary/70 transition-colors hover:border-secondary hover:text-primary disabled:opacity-50"
          >
            {exporting ? t('systemExporting') : `⬇️ ${t('systemExport')}`}
          </button>
          <button
            disabled={loading || loadingMore}
            onClick={load}
            className="rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-secondary transition-colors hover:bg-ink-soft disabled:opacity-50"
          >
            {loading ? '…' : `↻ ${t('systemRefresh')}`}
          </button>
        </div>
      </div>

      {errorMessage && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {errorMessage}
        </p>
      )}
      {exportNotice && (
        <p
          role="status"
          className={`flex items-start justify-between gap-3 rounded-xl border p-3 text-sm ${
            exportNotice.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
              : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
          }`}
        >
          <span>{exportNotice.text}</span>
          <button onClick={() => setExportNotice(null)} aria-label={t('scCloseBtn')} className="shrink-0 px-1 opacity-60 hover:opacity-100">
            ✕
          </button>
        </p>
      )}

      {/* Filtros rápidos (2026-09-09): un chip por caso de uso frecuente. */}
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => {
          const active = source === p.source
          return (
            <button
              key={p.key}
              onClick={() => setSource(active ? '' : p.source)}
              aria-pressed={active}
              title={t(p.hint)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                  : 'bg-primary/10 text-primary/70 hover:bg-primary/15'
              }`}
            >
              {p.icon} {t(p.label)}
            </button>
          )
        })}
        {activePreset && <span className="text-xs text-primary/50">{t(activePreset.hint)}</span>}
      </div>

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
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('systemSearchPlaceholder')}
          title={t('systemSearchHint')}
          className={`${inputCls} min-w-0 flex-1`}
        />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        {loading ? (
          <p className="px-4 py-10 text-center text-sm text-primary/50">{t('loading')}</p>
        ) : visible.length === 0 ? (
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
              {visible.map((r) => (
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
                    {/* Clientes creados desde el catálogo (2026-09-09): lo
                        que importa de un vistazo, sin abrir el detalle. */}
                    {r.source === 'clients' && r.context && (
                      <p className="mt-0.5 max-w-xl text-[11px] text-primary/50">
                        {[
                          r.context.via && `${t('systemCtxVia')}: ${viaLabel(r.context.via)}`,
                          r.context.price_list,
                          r.context.vendedora,
                          r.context.comments,
                          r.context.created_by && `${t('systemCtxCreatedBy')}: ${r.context.created_by}`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    )}
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
            {terms.length > 0 && <p className="mt-1 text-[11px] text-primary/40">{t('systemSearchHint')}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
