import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../i18n'
import { supabase, fetchAll } from '../../lib/supabase'
import { money } from '../../utils/format'
import { downloadAuditLogExcel } from '../../utils/excel'
import { inputCls } from './ui'

// Badge + texto de detalle por acción (2026-07-15 suma 'update_price_list',
// ver update_client_price_list en schema.sql — ahora una vendedora también
// puede cambiarle la lista a sus clientes, y queda auditado igual que
// reassign/delete. 2026-07-17 suma 'edit_order_items', ver
// update_order_items — edición de ítems de un pedido, mismo criterio;
// misma tanda: 'update_order_status' (marcar atendido/cancelar/reabrir,
// antes sin auditar) y 'convert_quote_to_order' (cerrar una cotización
// como pedido real, precio congelado desde ese momento). 2026-08-05 suma las
// acciones del panel Superadmin, ver migration-2026-08-05-superadmin.sql: en
// esas filas `client_name` no es un cliente sino el objetivo de la acción (el
// email del usuario o el nombre de la lista) — de ahí el encabezado
// "Cliente / objetivo".
const ACTION_STYLES = {
  delete_client: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  update_price_list: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
  reassign_client: 'bg-gold-pale text-secondary-dark',
  edit_order_items: 'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300',
  update_order_status: 'bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300',
  convert_quote_to_order: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300',
  recover_order_failure: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  create_manual_order: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  push_order_sellercloud: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300',
  set_admin: 'bg-ink text-secondary',
  create_admin_user: 'bg-ink text-secondary',
  set_user_password: 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300',
  add_price_list_owner: 'bg-gold-pale text-secondary-dark',
  remove_price_list_owner: 'bg-gold-pale text-secondary-dark',
  set_primary_price_list_owner: 'bg-gold-pale text-secondary-dark',
  sync_price_list_clients: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
  create_price_list: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300',
  update_price_list_label: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300',
  delete_price_list: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
}

// Cada acción con su key de i18n. Reemplaza la cadena de ternarios que tenía
// actionLabel(): con 13 acciones ya era ilegible.
const ACTION_LABELS = {
  reassign_client: 'actionReassign',
  delete_client: 'actionDelete',
  update_price_list: 'actionUpdateList',
  edit_order_items: 'actionEditOrder',
  update_order_status: 'actionUpdateOrderStatus',
  convert_quote_to_order: 'actionConvertQuote',
  recover_order_failure: 'actionRecoverOrder',
  create_manual_order: 'actionManualOrder',
  push_order_sellercloud: 'actionPushSellerCloud',
  set_admin: 'actionSetAdmin',
  create_admin_user: 'actionCreateAdmin',
  set_user_password: 'actionSetPassword',
  add_price_list_owner: 'actionListOwner',
  remove_price_list_owner: 'actionListOwner',
  set_primary_price_list_owner: 'actionListOwner',
  sync_price_list_clients: 'actionSyncListClients',
  create_price_list: 'actionPriceList',
  update_price_list_label: 'actionPriceList',
  delete_price_list: 'actionPriceList',
}

// Opciones del filtro por acción. El value puede agrupar varias acciones
// separadas por coma (ej. las tres de dueñas de lista comparten etiqueta):
// filtrar por una sola no le sirve a nadie y el select quedaba larguísimo.
const ACTION_FILTERS = [
  ['reassign_client', 'actionReassign'],
  ['delete_client', 'actionDelete'],
  ['update_price_list', 'actionUpdateList'],
  ['edit_order_items', 'actionEditOrder'],
  ['update_order_status', 'actionUpdateOrderStatus'],
  ['convert_quote_to_order', 'actionConvertQuote'],
  ['recover_order_failure', 'actionRecoverOrder'],
  ['create_manual_order', 'actionManualOrder'],
  ['push_order_sellercloud', 'actionPushSellerCloud'],
  ['set_admin,create_admin_user', 'actionSetAdmin'],
  ['set_user_password', 'actionSetPassword'],
  ['add_price_list_owner,remove_price_list_owner,set_primary_price_list_owner', 'actionListOwner'],
  ['sync_price_list_clients', 'actionSyncListClients'],
  ['create_price_list,update_price_list_label,delete_price_list', 'actionPriceList'],
]

// Historial de reasignaciones/eliminaciones de clientes y cambios de
// lista de precio (2026-07-14/15, ver migration-2026-07-14-client-admin-
// actions.sql y migration-2026-07-15-vendedora-update-price-list.sql).
// Panel propio (2026-07-15, a pedido del usuario — antes vivía como
// sección colapsable dentro de Clientes). Solo lectura: admin_audit_log
// es de solo lectura para admin (RLS admin_read_audit) y no tiene policy
// de insert/update/delete para nadie — solo lo escriben las RPC
// reassign_client/delete_client/update_client_price_list.
export default function AuditLogAdmin() {
  const { t } = useI18n()
  const [rows, setRows] = useState([])
  const [userFilter, setUserFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  useEffect(() => {
    supabase
      .from('admin_audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => setRows(data ?? []))
  }, [])

  const users = useMemo(
    () => [...new Set(rows.map((r) => r.performed_by_email).filter(Boolean))].sort(),
    [rows],
  )

  const statusLabel = (status) =>
    status === 'done' ? t('statusDone') : status === 'cancelled' ? t('statusCancelled') : t('statusNew')

  const actionLabel = (action) => t(ACTION_LABELS[action] ?? 'actionReassign')

  // Movimiento de stock del cambio de estado (2026-08-04): update_order_status
  // y convert_quote_to_order guardan en detail.stock qué productos ajustaron y
  // cuáles quedaron sin tocar por no tener stock cargado.
  const stockText = (stock) => {
    if (!stock) return null
    const moved = stock.moved?.length ?? 0
    const skipped = stock.skipped?.length ?? 0
    if (moved === 0 && skipped === 0) return null
    const label = stock.direction === -1 ? t('stockMoved') : t('stockReturned')
    return `${label}: ${moved}${skipped > 0 ? ` · ${skipped} ${t('stockNoData')}` : ''}`
  }

  const detailText = (a) => {
    if (a.action === 'reassign_client') {
      return `${a.detail?.from_vendedora ?? t('unassigned')} → ${a.detail?.to_vendedora ?? t('unassigned')}`
    }
    if (a.action === 'update_price_list') {
      return `${a.detail?.from_list ?? '—'} → ${a.detail?.to_list ?? '—'}`
    }
    if (a.action === 'edit_order_items') {
      const before = a.detail?.before_items?.length ?? 0
      const after = a.detail?.after_items?.length ?? 0
      const beforeTotal = a.detail?.before_total != null ? money(a.detail.before_total) : '—'
      const afterTotal = a.detail?.after_total != null ? money(a.detail.after_total) : '—'
      return `${before}→${after} ${t('items')} · ${beforeTotal} → ${afterTotal}`
    }
    if (a.action === 'update_order_status') {
      return [
        `${statusLabel(a.detail?.from_status)} → ${statusLabel(a.detail?.to_status)}`,
        stockText(a.detail?.stock),
      ]
        .filter(Boolean)
        .join(' · ')
    }
    // Pedido cargado a mano desde el mensaje de WhatsApp (2026-08-17). El
    // mensaje original está en detail.source_message; acá va lo que importa
    // de un vistazo.
    if (a.action === 'create_manual_order') {
      const total = a.detail?.total != null ? money(a.detail.total) : '—'
      const kind = a.detail?.kind === 'quote' ? t('quote') : t('order')
      return `${kind} · ${a.detail?.line_count ?? 0} ${t('items')} · ${total}`
    }
    // Orden mandada a SellerCloud (2026-08-17): el número de allá es lo que
    // permite cruzar los dos sistemas cuando algo no cuadra.
    if (a.action === 'push_order_sellercloud') {
      const total = a.detail?.total != null ? money(a.detail.total) : '—'
      return `#${a.detail?.sellercloud_order_id ?? '—'} · On Hold · ${a.detail?.line_count ?? 0} ${t('items')} · ${total}`
    }
    if (a.action === 'convert_quote_to_order') {
      const total = a.detail?.total != null ? money(a.detail.total) : '—'
      return [`${t('quote')} → ${t('order')} · ${total}`, stockText(a.detail?.stock)]
        .filter(Boolean)
        .join(' · ')
    }
    // Acciones del panel Superadmin (2026-08-05). El objetivo (email o nombre
    // de lista) ya va en la columna Cliente / objetivo: acá va el qué.
    if (a.action === 'set_admin') return `${a.detail?.granted ? '+' : '−'} ${t('roleAdmin')}`
    if (a.action === 'create_admin_user') return `+ ${t('roleAdmin')}`
    if (a.action === 'add_price_list_owner') {
      return `+ ${a.detail?.vendedora ?? '—'}${a.detail?.is_primary ? ' ★' : ''}`
    }
    if (a.action === 'remove_price_list_owner') {
      return [`− ${a.detail?.vendedora ?? '—'}`, a.detail?.new_primary && `★ ${a.detail.new_primary}`]
        .filter(Boolean)
        .join(' · ')
    }
    if (a.action === 'set_primary_price_list_owner') return `★ ${a.detail?.vendedora ?? '—'}`
    if (a.action === 'sync_price_list_clients') {
      return `${a.detail?.moved ?? 0} ${t('clients').toLowerCase()} → ${a.detail?.to_vendedora ?? '—'}`
    }
    if (a.action === 'create_price_list' || a.action === 'delete_price_list') {
      return `${a.action === 'create_price_list' ? '+' : '−'} ${a.detail?.code ?? '—'}`
    }
    if (a.action === 'update_price_list_label') {
      return `${a.detail?.from_label ?? '—'} → ${a.detail?.to_label ?? '—'}`
    }
    return [a.detail?.phone, a.detail?.vendedora, a.detail?.lista].filter(Boolean).join(' · ')
  }

  // Un solo criterio de filtrado para la tabla y para el Excel: la tabla lo
  // aplica sobre los últimos 200, el export sobre todo el historial.
  const matchesFilters = (r) => {
    if (userFilter && r.performed_by_email !== userFilter) return false
    if (actionFilter && !actionFilter.split(',').includes(r.action)) return false
    const day = r.created_at.slice(0, 10) // created_at es ISO, comparar por fecha alcanza
    if (dateFrom && day < dateFrom) return false
    if (dateTo && day > dateTo) return false
    return true
  }

  const filtered = useMemo(
    () => rows.filter(matchesFilters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, userFilter, actionFilter, dateFrom, dateTo],
  )

  const hasFilters = Boolean(userFilter || actionFilter || dateFrom || dateTo)

  // Fecha ordenable como texto (YYYY-MM-DD HH:MM:SS en hora local): así la
  // columna del Excel se ordena y filtra bien sin depender de cómo interprete
  // Excel un valor de fecha según la configuración regional de la máquina.
  const stamp = (iso) => {
    const d = new Date(iso)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  // Descarga TODO el historial, no los 200 de la tabla (que es una vista de
  // "lo último"): `fetchAll` pagina más allá del corte de 1,000 filas de
  // PostgREST. Los filtros activos sí se respetan, así que se puede bajar
  // "todo lo que hizo tal usuario" aunque en pantalla no entre.
  const exportExcel = async () => {
    setExporting(true)
    setExportError('')
    try {
      const all = await fetchAll('admin_audit_log', '*', ['created_at', 'id'])
      const data = all
        .filter(matchesFilters)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)) // igual que la tabla: lo último arriba
      if (data.length === 0) {
        setExportError(t('noActivity'))
        return
      }
      const header = [
        t('date'),
        t('user'),
        t('action'),
        t('auditTarget'),
        t('auditDetail'),
        t('auditClientId'),
        t('auditOrderId'),
        t('auditRawData'),
      ]
      await downloadAuditLogExcel({
        rows: data.map((a) => ({
          [header[0]]: stamp(a.created_at),
          [header[1]]: a.performed_by_email ?? '',
          [header[2]]: actionLabel(a.action),
          [header[3]]: a.client_name ?? '',
          [header[4]]: detailText(a),
          [header[5]]: a.client_id ?? '',
          [header[6]]: a.order_id ?? '',
          // El jsonb crudo: es un registro de auditoría, el resumen legible de
          // la columna Detalle pierde información a propósito (ej. el antes/
          // después ítem por ítem de una edición de pedido).
          [header[7]]: a.detail ? JSON.stringify(a.detail) : '',
        })),
        header,
        widths: [20, 30, 22, 34, 46, 38, 38, 80],
        sheetName: 'Movimientos',
        filenameStamp: stamp(new Date().toISOString()).replace(/[: ]/g, '-'),
      })
    } catch (e) {
      setExportError(e.message ?? String(e))
    }
    setExporting(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-brand text-2xl font-semibold">
          🛡️ {t('activityLog')}
          <span className="ml-2 text-base font-normal text-primary/40">
            {filtered.length}
            {filtered.length !== rows.length ? ` / ${rows.length}` : ''}
          </span>
        </h2>
        <button
          disabled={exporting}
          onClick={exportExcel}
          className="rounded-full bg-ink px-5 py-2 text-sm font-semibold text-secondary transition-colors hover:bg-ink-soft disabled:opacity-50"
        >
          {exporting ? '…' : `⬇️ ${t('downloadExcel')} (${hasFilters ? t('auditExportFiltered') : t('auditExportAll')})`}
        </button>
      </div>
      <p className="text-xs leading-relaxed text-primary/50">{t('auditExportHint')}</p>
      {exportError && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {exportError}
        </p>
      )}

      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap">
        <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} className={inputCls}>
          <option value="">{t('allUsers')}</option>
          {users.map((email) => (
            <option key={email} value={email}>
              {email}
            </option>
          ))}
        </select>
        <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className={inputCls}>
          <option value="">{t('allActions')}</option>
          {ACTION_FILTERS.map(([value, key]) => (
            <option key={value} value={value}>
              {t(key)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-primary/60">
          {t('dateFrom')}
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-primary/60">
          {t('dateTo')}
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-primary/50">{t('noActivity')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-primary/45">
                <th className="p-3">{t('date')}</th>
                <th className="p-3">{t('user')}</th>
                <th className="p-3">{t('action')}</th>
                <th className="p-3">{t('auditTarget')}</th>
                <th className="p-3">{t('auditDetail')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} className="border-b border-line/60">
                  <td className="whitespace-nowrap p-3 text-xs text-primary/60">
                    {new Date(a.created_at).toLocaleString()}
                  </td>
                  <td className="p-3 text-xs text-primary/70">{a.performed_by_email}</td>
                  <td className="p-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${ACTION_STYLES[a.action] ?? ACTION_STYLES.reassign_client}`}
                    >
                      {actionLabel(a.action)}
                    </span>
                  </td>
                  <td className="p-3 font-medium">{a.client_name}</td>
                  <td className="p-3 text-xs text-primary/60">{detailText(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
