import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { money } from '../../utils/format'
import { inputCls } from './ui'

// Badge + texto de detalle por acción (2026-07-15 suma 'update_price_list',
// ver update_client_price_list en schema.sql — ahora una vendedora también
// puede cambiarle la lista a sus clientes, y queda auditado igual que
// reassign/delete. 2026-07-17 suma 'edit_order_items', ver
// update_order_items — edición de ítems de un pedido, mismo criterio).
const ACTION_STYLES = {
  delete_client: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  update_price_list: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
  reassign_client: 'bg-gold-pale text-secondary-dark',
  edit_order_items: 'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300',
}

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

  const actionLabel = (action) =>
    action === 'delete_client'
      ? t('actionDelete')
      : action === 'update_price_list'
        ? t('actionUpdateList')
        : action === 'edit_order_items'
          ? t('actionEditOrder')
          : t('actionReassign')

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
    return [a.detail?.phone, a.detail?.vendedora, a.detail?.lista].filter(Boolean).join(' · ')
  }

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (userFilter && r.performed_by_email !== userFilter) return false
      if (actionFilter && r.action !== actionFilter) return false
      const day = r.created_at.slice(0, 10) // created_at es ISO, comparar por fecha alcanza
      if (dateFrom && day < dateFrom) return false
      if (dateTo && day > dateTo) return false
      return true
    })
  }, [rows, userFilter, actionFilter, dateFrom, dateTo])

  return (
    <div className="space-y-4">
      <h2 className="font-brand text-2xl font-semibold">
        🛡️ {t('activityLog')}
        <span className="ml-2 text-base font-normal text-primary/40">
          {filtered.length}
          {filtered.length !== rows.length ? ` / ${rows.length}` : ''}
        </span>
      </h2>

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
          <option value="reassign_client">{t('actionReassign')}</option>
          <option value="delete_client">{t('actionDelete')}</option>
          <option value="update_price_list">{t('actionUpdateList')}</option>
          <option value="edit_order_items">{t('actionEditOrder')}</option>
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
                <th className="p-3">{t('client')}</th>
                <th className="p-3">Detalle</th>
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
