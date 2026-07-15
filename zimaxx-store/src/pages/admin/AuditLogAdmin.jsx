import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'

// Historial de reasignaciones/eliminaciones de clientes (2026-07-14, ver
// migration-2026-07-14-client-admin-actions.sql). Panel propio (2026-07-15,
// a pedido del usuario — antes vivía como sección colapsable dentro de
// Clientes). Solo lectura: admin_audit_log es de solo lectura para admin
// (RLS admin_read_audit) y no tiene policy de insert/update/delete para
// nadie — solo lo escriben las RPC reassign_client/delete_client.
export default function AuditLogAdmin() {
  const { t } = useI18n()
  const [rows, setRows] = useState([])

  useEffect(() => {
    supabase
      .from('admin_audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => setRows(data ?? []))
  }, [])

  return (
    <div className="space-y-4">
      <h2 className="font-brand text-2xl font-semibold">
        🛡️ {t('activityLog')}
        <span className="ml-2 text-base font-normal text-primary/40">{rows.length}</span>
      </h2>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        {rows.length === 0 ? (
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
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-line/60">
                  <td className="whitespace-nowrap p-3 text-xs text-primary/60">
                    {new Date(a.created_at).toLocaleString()}
                  </td>
                  <td className="p-3 text-xs text-primary/70">{a.performed_by_email}</td>
                  <td className="p-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        a.action === 'delete_client'
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'
                          : 'bg-gold-pale text-secondary-dark'
                      }`}
                    >
                      {a.action === 'delete_client' ? t('actionDelete') : t('actionReassign')}
                    </span>
                  </td>
                  <td className="p-3 font-medium">{a.client_name}</td>
                  <td className="p-3 text-xs text-primary/60">
                    {a.action === 'reassign_client'
                      ? `${a.detail?.from_vendedora ?? t('unassigned')} → ${a.detail?.to_vendedora ?? t('unassigned')}`
                      : [a.detail?.phone, a.detail?.vendedora, a.detail?.lista].filter(Boolean).join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
