import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { money } from '../../utils/format'
import { downloadMetricsExcel } from '../../utils/excel'

// Pestaña Métricas (2026-08-06, a pedido del usuario): los KPIs del sistema
// en una sola pantalla, en vivo. Solo para el perfil superadmin.
//
// Toda la data viene de UNA RPC (`sa_metrics_overview`, ver
// migration-2026-08-06-sa-metrics.sql) y no de consultas a las tablas. Dos
// razones, en este orden:
//   1. Seguridad: los agregados cruzan TODAS las vendedoras. Sumar `orders`
//      desde el cliente devolvería un número distinto según quién mira (la RLS
//      recorta a una vendedora sus propios pedidos) y para calcular un
//      promedio habría que bajarse el detalle de cada pedido. La RPC es
//      SECURITY DEFINER con `is_superadmin()` adentro y devuelve SOLO los
//      agregados.
//   2. Costo: son 7 consultas distintas. En una RPC es un round-trip cada 60
//      segundos; desde el front serían 7.
//
// El guard de la pestaña y de la ruta vive en AdminLayout.jsx, igual que el de
// 🔐 Superadmin. Ocultar la pestaña es cosmético: el límite real es el
// `is_superadmin()` de la RPC, que rechaza a cualquier otro con
// 'not authorized' aunque la llame a mano con la anon key.
//
// "Tiempo real" por polling y no con una suscripción Realtime de Supabase:
// esto son agregados, no filas — un evento de Realtime avisa que cambió UN
// pedido, y para saber el nuevo promedio habría que volver a pedir todo igual.
// Un timer de 60s es la misma llamada sin el canal de websocket abierto.
const REFRESH_MS = 60_000

// Cada cuánto se recalcula el "actualizado hace X". No hace falta 1 Hz para un
// dato que cambia cada 60s, y a 5s el cartel nunca se ve desfasado.
const AGE_TICK_MS = 5_000

const RANGES = [7, 14, 30]
const DEFAULT_DAYS = 14

// PostgREST devuelve PGRST202 cuando la función no está en su schema cache:
// es exactamente el caso "desplegué el frontend pero todavía no corrí la
// migración". Se detecta para poder decir qué falta en vez de mostrar el
// mensaje crudo de la API.
const isMissingRpc = (e) =>
  e?.code === 'PGRST202' || /could not find the function/i.test(e?.message ?? '')

// 'YYYY-MM-DD' → Date local. new Date('2026-08-06') lo parsea como medianoche
// UTC y en cualquier huso al oeste de Greenwich la etiqueta del gráfico
// mostraría el día anterior.
const dayLabel = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

const hours = (h) => `${Number(h).toFixed(1)} h`

// money() convierte null en $0.00, y para un promedio eso miente: "sin pedidos
// en el período" no es "el ticket promedio fue cero".
const amount = (v) => (v === null || v === undefined ? '—' : money(v))

function Kpi({ label, value, hint, hintTitle, muted }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <p className="text-[11px] uppercase leading-tight tracking-wider text-primary/45">{label}</p>
      <p
        className={`mt-1 font-brand text-2xl font-semibold leading-none ${muted ? 'text-primary/35' : ''}`}
        title={hintTitle}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] leading-tight text-primary/50">{hint}</p>}
    </div>
  )
}

// Mini-gráfico de barras en SVG a mano: el repo no tiene librería de charts y
// sumar una (recharts arrastra d3, ~200 kB) para una sola serie de 15 puntos
// no se justifica.
//
// El truco para que sea responsive sin medir nada en JS: viewBox con un ancho
// fijo de 10 unidades por día + preserveAspectRatio="none", así el SVG se
// estira al ancho del contenedor. Las barras son <rect> sin borde ni esquinas
// redondeadas, que es justo lo que tolera bien ese estirón (una barra más
// ancha sigue siendo una barra); el texto NO va adentro por lo mismo — las
// fechas se dibujan en HTML abajo, donde no se deforman.
function TrendChart({ serie, label }) {
  const H = 100
  const STEP = 10
  const BAR = 7
  const max = Math.max(...serie.map((d) => Number(d.monto) || 0), 0)

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wider text-primary/45">{label}</p>
        <p className="font-mono text-[11px] text-primary/45">{money(max)}</p>
      </div>
      <svg
        viewBox={`0 0 ${serie.length * STEP} ${H}`}
        preserveAspectRatio="none"
        className="mt-2 h-32 w-full"
        role="img"
        aria-label={label}
      >
        {serie.map((d, i) => {
          const value = Number(d.monto) || 0
          // Los días en cero dibujan una astilla de 1 unidad en el color de
          // las hairlines: así se ve que el día existe y no vendió, en vez de
          // un hueco que se confunde con "falta el dato".
          const h = max > 0 && value > 0 ? Math.max((value / max) * (H - 6), 2) : 1
          return (
            <rect
              key={d.dia}
              x={i * STEP + (STEP - BAR) / 2}
              y={H - h}
              width={BAR}
              height={h}
              fill={value > 0 ? 'var(--color-secondary)' : 'var(--color-line)'}
            >
              <title>{`${d.dia} · ${money(value)} · ${d.pedidos}`}</title>
            </rect>
          )
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-primary/40">
        <span>{dayLabel(serie[0].dia)}</span>
        {serie.length > 2 && <span>{dayLabel(serie[Math.floor(serie.length / 2)].dia)}</span>}
        <span>{dayLabel(serie[serie.length - 1].dia)}</span>
      </div>
    </div>
  )
}

export default function MetricsAdmin() {
  const { t } = useI18n()
  const [days, setDays] = useState(DEFAULT_DAYS)
  const [data, setData] = useState(null)
  // El objeto de error crudo, no el texto: el mensaje se traduce en el render
  // para que cambiar de idioma no invalide `load` (que lleva `error` en su
  // dependencia) ni dispare una recarga con spinner.
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [fetchedAt, setFetchedAt] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [exporting, setExporting] = useState(false)

  // Contador de pedidos en vuelo: si se cambia de rango dos veces rápido, la
  // respuesta de la primera llamada puede llegar DESPUÉS de la segunda y
  // pintar los números del rango viejo. También invalida lo que quede en
  // vuelo al desmontar.
  const reqRef = useRef(0)

  const load = useCallback(async (silent) => {
    const seq = ++reqRef.current
    if (silent) setRefreshing(true)
    else {
      setLoading(true)
      setData(null)
    }
    const { data: payload, error: rpcError } = await supabase.rpc('sa_metrics_overview', {
      p_days: days,
    })
    if (seq !== reqRef.current) return
    if (rpcError) {
      // No se borra `data`: si falla un refresco automático (wifi caído, la
      // migración todavía sin correr) se sigue mostrando la última foto buena
      // con el aviso arriba, en vez de vaciar la pantalla.
      setError(rpcError)
    } else {
      setData(payload)
      setFetchedAt(Date.now())
      setError(null)
    }
    setLoading(false)
    setRefreshing(false)
  }, [days])

  useEffect(() => {
    load(false)
    const id = setInterval(() => load(true), REFRESH_MS)
    return () => {
      clearInterval(id)
      reqRef.current++
    }
  }, [load])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    return () => clearInterval(id)
  }, [])

  const ageLabel = useMemo(() => {
    if (!fetchedAt) return ''
    const secs = Math.max(0, Math.round((now - fetchedAt) / 1000))
    if (secs < 5) return t('metricsJustNow')
    const age = secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min`
    return t('metricsUpdatedAgo', { age })
  }, [fetchedAt, now, t])

  const errorMessage = !error
    ? ''
    : isMissingRpc(error)
      ? t('metricsMigrationMissing')
      : (error.message ?? String(error))

  const totals = data?.totals
  const filas = data?.por_vendedora ?? []
  const serie = data?.serie_diaria ?? []
  const excluidas = data?.excluidas ?? []
  const fallos = data?.fallos
  // null cuando ningún pedido del período llegó a "Atendido" todavía. `?? null`
  // y no el valor pelado: así un undefined (RPC vieja, respuesta recortada) cae
  // en el mismo "—" en vez de mostrar "NaN h".
  const attendHours = data?.tiempo_a_atender_horas ?? null

  const exportExcel = async () => {
    setExporting(true)
    try {
      const header = [
        t('metricsVendedora'),
        t('orders'),
        t('metricsCaptured'),
        t('metricsAvgTicket'),
        t('metricsQuotes'),
      ]
      // Números crudos y no money(): así se pueden sumar y ordenar en Excel.
      const rows = filas.map((r) => ({
        [header[0]]: r.vendedora ?? t('unassigned'),
        [header[1]]: r.pedidos,
        [header[2]]: Number(r.monto ?? 0),
        [header[3]]: r.ticket == null ? '' : Number(r.ticket),
        [header[4]]: r.cotizaciones,
      }))
      const p = (n) => String(n).padStart(2, '0')
      const d = new Date()
      await downloadMetricsExcel({
        rows,
        header,
        widths: [30, 10, 16, 16, 14],
        sheetName: t('metricsAdoption').slice(0, 31), // Excel corta los nombres de hoja en 31
        periodStamp: `${days}d-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`,
      })
    } catch (e) {
      setError(e)
    }
    setExporting(false)
  }

  const rangeBtn = (active) =>
    `rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
      active
        ? 'bg-secondary text-ink'
        : 'border border-line text-primary/60 hover:border-secondary hover:text-primary'
    }`

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-brand text-2xl font-semibold">📈 {t('metrics')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-primary/55">
            {t('metricsIntro', { secs: REFRESH_MS / 1000 })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-primary/40">
            {t('metricsRange')}
          </span>
          {RANGES.map((n) => (
            <button key={n} onClick={() => setDays(n)} className={rangeBtn(n === days)}>
              {n} {t('metricsDays')}
            </button>
          ))}
          <button
            disabled={loading || refreshing}
            onClick={() => load(true)}
            className="rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-secondary transition-colors hover:bg-ink-soft disabled:opacity-50"
          >
            {refreshing ? '…' : `↻ ${t('metricsRefresh')}`}
          </button>
        </div>
      </div>

      {errorMessage && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {errorMessage}
        </p>
      )}

      {loading ? (
        <p className="py-16 text-center text-primary/60">{t('loading')}</p>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Kpi label={t('metricsCaptured')} value={money(totals.monto_capturado)} />
            <Kpi label={t('orders')} value={totals.pedidos} />
            <Kpi
              label={t('metricsAvgTicket')}
              value={amount(totals.ticket_promedio)}
              muted={totals.ticket_promedio === null}
            />
            <Kpi label={t('metricsQuotes')} value={totals.cotizaciones} />
            <Kpi label={t('metricsActiveVendedoras')} value={totals.vendedoras_activas} />
            {/* "—" y no 0: que todavía no haya un pedido atendido no significa
                que se atiendan en cero horas. El motivo va en el tooltip y
                también visible, porque en el teléfono no hay hover. */}
            <Kpi
              label={t('metricsAvgAttend')}
              value={attendHours === null ? '—' : hours(attendHours)}
              muted={attendHours === null}
              hintTitle={attendHours === null ? t('metricsNoAttendData') : undefined}
              hint={attendHours === null ? t('metricsNoAttendData') : undefined}
            />
            <Kpi label={t('metricsConverted')} value={data.cotizaciones_convertidas} />
            <Kpi label={t('metricsCancelled')} value={totals.cancelados} />
          </div>

          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-primary/50">
            <span>
              {t('metricsFailures')}:{' '}
              <strong className="font-semibold">{fallos?.total ?? 0}</strong>
              {fallos?.total > 0 && ` · ${fallos.recuperados} ${t('metricsRecovered')}`}
            </span>
            {ageLabel && <span className="text-primary/40">· {ageLabel}</span>}
          </p>

          <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
            {serie.length === 0 || serie.every((d) => Number(d.monto) === 0) ? (
              <>
                <p className="text-[11px] uppercase tracking-wider text-primary/45">
                  {t('metricsTrend')}
                </p>
                <p className="py-10 text-center text-sm text-primary/50">{t('metricsNoData')}</p>
              </>
            ) : (
              <TrendChart serie={serie} label={t('metricsTrend')} />
            )}
            <p className="mt-2 text-[10px] leading-relaxed text-primary/35">
              {t('metricsPartialFirstDay', { days: data.period?.days ?? days })}
            </p>
          </div>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-brand text-lg font-semibold">
                {t('metricsAdoption')}
                <span className="ml-2 text-sm font-normal text-primary/40">{filas.length}</span>
              </h3>
              <button
                disabled={exporting || filas.length === 0}
                onClick={exportExcel}
                className="rounded-full border border-line px-4 py-1.5 text-xs transition-colors hover:border-secondary hover:text-primary disabled:opacity-40"
              >
                {exporting ? '…' : `⬇️ ${t('downloadExcel')}`}
              </button>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
              {filas.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-primary/50">{t('metricsNoData')}</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-primary/45">
                      <th className="p-3">{t('metricsVendedora')}</th>
                      <th className="p-3 text-right">{t('orders')}</th>
                      <th className="p-3 text-right">{t('metricsCaptured')}</th>
                      <th className="p-3 text-right">{t('metricsAvgTicket')}</th>
                      <th className="p-3 text-right">{t('metricsQuotes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* key por nombre: la RPC agrupa por vendedora, así que hay
                        como máximo UNA fila sin vendedora y el centinela (con
                        el espacio adelante) no puede chocar con un nombre
                        real. */}
                    {filas.map((r) => (
                      <tr key={r.vendedora ?? ' sin-vendedora'} className="border-b border-line/60">
                        <td className="p-3 font-medium">
                          {r.vendedora ?? (
                            <span className="text-primary/45" title={t('unassigned')}>
                              —
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-right tabular-nums">{r.pedidos}</td>
                        <td className="p-3 text-right font-semibold tabular-nums">
                          {money(r.monto)}
                        </td>
                        <td className="p-3 text-right tabular-nums text-primary/70">
                          {amount(r.ticket)}
                        </td>
                        <td className="p-3 text-right tabular-nums text-primary/70">
                          {r.cotizaciones}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/* Los montos de la tabla suman exactamente el total del
                      período (la RPC no descarta ninguna fila): el pie sirve
                      de cuadre a la vista. */}
                  <tfoot>
                    <tr className="text-[13px] font-semibold">
                      <td className="p-3 uppercase tracking-wider text-primary/45">
                        {t('metricsPeriodTotal')}
                      </td>
                      <td className="p-3 text-right tabular-nums">{totals.pedidos}</td>
                      <td className="p-3 text-right tabular-nums">
                        {money(totals.monto_capturado)}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {amount(totals.ticket_promedio)}
                      </td>
                      <td className="p-3 text-right tabular-nums">{totals.cotizaciones}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>

            {excluidas.length > 0 && (
              <p className="text-[11px] leading-relaxed text-primary/40">
                {t('metricsExcluded')} {excluidas.join(', ')}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}
