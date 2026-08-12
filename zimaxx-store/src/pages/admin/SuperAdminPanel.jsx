import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { inputCls, SearchIcon } from './ui'

// Pestaña Superadmin (2026-08-05, a pedido del usuario): las acciones que
// hasta hoy obligaban a entrar al SQL Editor de Supabase o al dashboard de
// Auth — hacer admin a alguien, cambiar una contraseña, asignar/desasignar
// una lista de precio a una vendedora — pero visibles solo para el perfil
// superadmin (ver migration-2026-08-05-superadmin.sql).
//
// Nada de esto se hace con update/insert directos: todo va por RPC
// SECURITY DEFINER (o por la Edge Function `superadmin-users` cuando hace
// falta la Admin API de Auth), así el candado de superadmin y la fila de
// auditoría en `admin_audit_log` son imposibles de saltear. El guard de la
// pestaña/ruta vive en AdminLayout.jsx, pero el límite real es el de la base:
// un admin común que llame estas RPC a mano recibe "solo el superadmin
// puede...".
//
// El panel NO cachea nada: después de cada acción recarga todo (`load()`),
// porque casi todas tienen efectos cruzados (quitar una dueña puede promover
// a otra, agregar una dueña deja clientes inconsistentes, etc.) y reconstruir
// eso en el estado local sería duplicar las reglas del SQL.
export default function SuperAdminPanel() {
  const { t } = useI18n()
  const [users, setUsers] = useState([])
  const [lists, setLists] = useState([])
  const [vendedoras, setVendedoras] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [userSearch, setUserSearch] = useState('')
  const [pwdFor, setPwdFor] = useState(null) // user_id con el form de contraseña abierto
  const [pwd, setPwd] = useState('')
  const [confirmAdminOff, setConfirmAdminOff] = useState(null) // user_id
  const [adminForm, setAdminForm] = useState(null) // { email, password } | null

  const [listForm, setListForm] = useState(null) // { code, label } | null
  const [renaming, setRenaming] = useState(null) // { id, label } | null
  const [ownerPick, setOwnerPick] = useState({}) // price_list_id -> vendedora_id elegida
  const [confirmDeleteList, setConfirmDeleteList] = useState(null) // price_list_id

  const load = async () => {
    try {
      const [u, l, v] = await Promise.all([
        supabase.rpc('sa_list_users'),
        supabase.rpc('sa_price_list_overview'),
        fetchAll('vendedores', 'id, name', ['name', 'id']),
      ])
      if (u.error) throw u.error
      if (l.error) throw l.error
      setUsers(u.data ?? [])
      setLists(l.data ?? [])
      setVendedoras(v)
    } catch (e) {
      setError(e.message ?? String(e))
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // Los mensajes de las RPC vienen del `raise exception` de Postgres (en
  // español, pensados para mostrarse tal cual).
  const rpc = async (name, params) => {
    const { data, error: rpcError } = await supabase.rpc(name, params)
    if (rpcError) throw rpcError
    return data
  }

  // La Edge Function devuelve el detalle del error en el body, no en
  // error.message (mismo patrón que el alta de acceso en VendedoresAdmin).
  const invokeSuper = async (body) => {
    const { data, error: fnError } = await supabase.functions.invoke('superadmin-users', { body })
    if (fnError || data?.error) {
      let message = data?.error || fnError.message
      try {
        const parsed = await fnError?.context?.json()
        if (parsed?.error) message = parsed.error
      } catch {
        /* sin body JSON legible, se usa error.message */
      }
      throw new Error(message)
    }
    return data
  }

  // Devuelve si salió bien: los formularios inline solo se cierran cuando la
  // acción pasó (si falla, el email/contraseña tipeados no se pierden).
  const run = async (fn, okMessage) => {
    setBusy(true)
    setError('')
    setNotice('')
    let ok = false
    try {
      const data = await fn()
      if (okMessage) setNotice(typeof okMessage === 'function' ? okMessage(data) : okMessage)
      await load()
      ok = true
    } catch (e) {
      setError(e.message ?? String(e))
    }
    setBusy(false)
    return ok
  }

  // ---------- Usuarios ----------
  const setAdmin = (user, value) => {
    setConfirmAdminOff(null)
    run(() => rpc('sa_set_admin', { p_user_id: user.user_id, p_is_admin: value }))
  }

  const savePassword = async (user) => {
    const password = pwd
    const ok = await run(
      () => invokeSuper({ action: 'set_password', user_id: user.user_id, password }),
      (data) => `${t('passwordChanged')}${data?.warning ? ` (${data.warning})` : ''}`,
    )
    if (ok) {
      setPwdFor(null)
      setPwd('')
    }
  }

  const createAdmin = async () => {
    const { email, password } = adminForm
    const ok = await run(
      () => invokeSuper({ action: 'create_admin', email: email.trim(), password }),
      t('adminCreated'),
    )
    if (ok) setAdminForm(null)
  }

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) => (u.email ?? '').toLowerCase().includes(q))
  }, [users, userSearch])

  const roleOf = (u) =>
    u.is_superadmin
      ? { label: t('roleSuperadmin'), cls: 'bg-gold-pale text-secondary-dark' }
      : u.is_admin
        ? { label: t('roleAdmin'), cls: 'bg-ink text-secondary' }
        : u.vendedora_id
          ? { label: t('roleVendedora'), cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300' }
          : { label: t('roleNone'), cls: 'bg-primary/10 text-primary/50' }

  const date = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—')

  // ---------- Listas de precio ----------
  const addOwner = async (list) => {
    const vendedoraId = ownerPick[list.id]
    if (!vendedoraId) return
    const ok = await run(() =>
      rpc('sa_add_price_list_owner', {
        p_price_list_id: list.id,
        p_vendedora_id: vendedoraId,
        p_is_primary: false,
      }),
    )
    if (ok) setOwnerPick((prev) => ({ ...prev, [list.id]: '' }))
  }

  const removeOwner = (list, owner) =>
    run(() =>
      rpc('sa_remove_price_list_owner', {
        p_price_list_id: list.id,
        p_vendedora_id: owner.vendedora_id,
      }),
    )

  const makePrimary = (list, owner) =>
    run(() =>
      rpc('sa_set_primary_price_list_owner', {
        p_price_list_id: list.id,
        p_vendedora_id: owner.vendedora_id,
      }),
    )

  const fixAssignments = (list) =>
    run(
      () => rpc('sa_sync_price_list_clients', { p_price_list_id: list.id }),
      (data) => `${data?.moved ?? 0} ${t('clientsMoved')} → ${data?.to_vendedora ?? '—'}`,
    )

  const createList = async () => {
    const { code, label } = listForm
    const ok = await run(() => rpc('sa_create_price_list', { p_code: code, p_label: label }))
    if (ok) setListForm(null)
  }

  const saveLabel = async () => {
    const { id, label } = renaming
    const ok = await run(() => rpc('sa_update_price_list', { p_price_list_id: id, p_label: label }))
    if (ok) setRenaming(null)
  }

  const deleteList = (list) => {
    setConfirmDeleteList(null)
    run(() => rpc('sa_delete_price_list', { p_price_list_id: list.id }))
  }

  const btn = 'rounded-lg border border-line px-2.5 py-1 text-xs transition-colors hover:border-secondary hover:text-primary disabled:opacity-40'
  const btnDanger =
    'rounded-lg border border-red-200 px-2.5 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40'

  if (loading) return <p className="py-16 text-center text-primary/60">{t('loading')}</p>

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-brand text-2xl font-semibold">🔐 {t('superadmin')}</h2>
        <p className="mt-1 text-xs leading-relaxed text-primary/55">{t('superadminIntro')}</p>
      </div>

      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
          {notice}
        </p>
      )}

      {/* ---------- Usuarios y accesos ---------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-brand text-lg font-semibold">
            {t('superadminUsers')}
            <span className="ml-2 text-sm font-normal text-primary/40">{users.length}</span>
          </h3>
          <div className="flex items-center gap-2">
            <div className="relative">
              <SearchIcon />
              <input
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder={t('searchUser')}
                className={`${inputCls} w-48 pl-10`}
              />
            </div>
            <button
              onClick={() => setAdminForm({ email: '', password: '' })}
              className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-secondary transition-colors hover:bg-ink-soft"
            >
              + {t('newAdmin')}
            </button>
          </div>
        </div>

        {adminForm && (
          <div className="grid animate-fade-up gap-3 rounded-2xl border border-secondary/40 bg-surface p-5 shadow-sm md:grid-cols-2">
            <input
              type="email"
              autoFocus
              value={adminForm.email}
              onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })}
              placeholder={t('email')}
              className={inputCls}
            />
            <input
              type="text"
              value={adminForm.password}
              onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })}
              placeholder={t('newPasswordPlaceholder')}
              className={inputCls}
            />
            <p className="text-xs leading-relaxed text-primary/55 md:col-span-2">
              {t('newAdminHint')} {t('newPasswordHint')}
            </p>
            <div className="flex gap-2 md:col-span-2">
              <button
                disabled={busy || !adminForm.email.trim() || adminForm.password.length < 6}
                onClick={createAdmin}
                className="rounded-full bg-secondary px-6 py-2 text-sm font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-50"
              >
                {t('newAdmin')}
              </button>
              <button
                onClick={() => setAdminForm(null)}
                className="rounded-full border border-line px-6 py-2 text-sm transition-colors hover:border-primary/40"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-primary/45">
                <th className="p-3">{t('email')}</th>
                <th className="p-3">{t('roleColumn')}</th>
                <th className="p-3">{t('vendedoras')}</th>
                <th className="p-3">{t('createdAt')}</th>
                <th className="p-3">{t('lastSignIn')}</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => {
                const role = roleOf(u)
                return (
                  <tr key={u.user_id} className="border-b border-line/60 align-top">
                    <td className="p-3 font-medium">{u.email}</td>
                    <td className="p-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${role.cls}`}
                      >
                        {role.label}
                      </span>
                      {/* Admin Y vendedora a la vez (caso Luzmar Quintero): el
                          badge principal dice Admin/Superadmin, así que la
                          otra mitad del rol se muestra al lado. */}
                      {u.vendedora_id && (u.is_admin || u.is_superadmin) && (
                        <span className="ml-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                          {t('roleVendedora')}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-primary/70">{u.vendedora_name ?? '—'}</td>
                    <td className="whitespace-nowrap p-3 text-xs text-primary/55">
                      {date(u.created_at)}
                    </td>
                    <td className="whitespace-nowrap p-3 text-xs text-primary/55">
                      {u.last_sign_in_at ? date(u.last_sign_in_at) : t('never')}
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {!u.is_superadmin &&
                          (u.is_admin ? (
                            confirmAdminOff === u.user_id ? (
                              <span className="flex items-center gap-1.5 text-xs">
                                {t('confirmRemoveAdmin')}
                                <button
                                  disabled={busy}
                                  onClick={() => setAdmin(u, false)}
                                  className={btnDanger}
                                >
                                  {t('yes')}
                                </button>
                                <button onClick={() => setConfirmAdminOff(null)} className={btn}>
                                  {t('no')}
                                </button>
                              </span>
                            ) : (
                              <button
                                onClick={() => setConfirmAdminOff(u.user_id)}
                                className={btnDanger}
                              >
                                {t('removeAdmin')}
                              </button>
                            )
                          ) : (
                            <button disabled={busy} onClick={() => setAdmin(u, true)} className={btn}>
                              {t('makeAdmin')}
                            </button>
                          ))}

                        {pwdFor === u.user_id ? (
                          <span className="flex items-center gap-1.5">
                            <input
                              autoFocus
                              type="text"
                              value={pwd}
                              onChange={(e) => setPwd(e.target.value)}
                              placeholder={t('newPasswordPlaceholder')}
                              className="w-36 rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none transition-colors focus:border-secondary"
                            />
                            <button
                              disabled={busy || pwd.length < 6}
                              onClick={() => savePassword(u)}
                              className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-40"
                            >
                              {t('save')}
                            </button>
                            <button
                              onClick={() => {
                                setPwdFor(null)
                                setPwd('')
                              }}
                              className={btn}
                            >
                              {t('cancel')}
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => {
                              setPwdFor(u.user_id)
                              setPwd('')
                            }}
                            className={btn}
                          >
                            {t('changePassword')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filteredUsers.length === 0 && (
            <p className="p-6 text-center text-sm text-primary/50">{t('noUsers')}</p>
          )}
        </div>
      </section>

      {/* ---------- Listas de precio y dueñas ---------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-brand text-lg font-semibold">
            {t('superadminLists')}
            <span className="ml-2 text-sm font-normal text-primary/40">{lists.length}</span>
          </h3>
          <button
            onClick={() => setListForm({ code: '', label: '' })}
            className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-secondary transition-colors hover:bg-ink-soft"
          >
            + {t('newPriceList')}
          </button>
        </div>

        {listForm && (
          <div className="grid animate-fade-up gap-3 rounded-2xl border border-secondary/40 bg-surface p-5 shadow-sm md:grid-cols-2">
            <input
              autoFocus
              value={listForm.code}
              onChange={(e) => setListForm({ ...listForm, code: e.target.value })}
              placeholder={t('listCode')}
              className={`${inputCls} font-mono`}
            />
            <input
              value={listForm.label}
              onChange={(e) => setListForm({ ...listForm, label: e.target.value })}
              placeholder={t('listLabel')}
              className={inputCls}
            />
            <p className="text-xs leading-relaxed text-primary/55 md:col-span-2">
              {t('listCodeHint')}
            </p>
            <div className="flex gap-2 md:col-span-2">
              <button
                disabled={busy || !listForm.code.trim() || !listForm.label.trim()}
                onClick={createList}
                className="rounded-full bg-secondary px-6 py-2 text-sm font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-50"
              >
                {t('save')}
              </button>
              <button
                onClick={() => setListForm(null)}
                className="rounded-full border border-line px-6 py-2 text-sm transition-colors hover:border-primary/40"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-3">
          {lists.map((l) => {
            const owners = l.owners ?? []
            const free = vendedoras.filter((v) => !owners.some((o) => o.vendedora_id === v.id))
            return (
              <div key={l.id} className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    {renaming?.id === l.id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          autoFocus
                          value={renaming.label}
                          onChange={(e) => setRenaming({ ...renaming, label: e.target.value })}
                          onKeyDown={(e) => e.key === 'Enter' && saveLabel()}
                          className={`${inputCls} w-56`}
                        />
                        <button
                          disabled={busy || !renaming.label.trim()}
                          onClick={saveLabel}
                          className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-40"
                        >
                          {t('save')}
                        </button>
                        <button onClick={() => setRenaming(null)} className={btn}>
                          {t('cancel')}
                        </button>
                      </div>
                    ) : (
                      <p className="font-semibold">
                        {l.label}
                        <span className="ml-2 rounded bg-primary/5 px-1.5 py-0.5 font-mono text-[11px] font-normal text-primary/50">
                          {l.code}
                        </span>
                        {l.protected && (
                          <span
                            title={t('protectedList')}
                            className="ml-1.5 text-[11px] text-primary/35"
                          >
                            🔒
                          </span>
                        )}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-primary/50">
                      {l.clients} {t('clients').toLowerCase()} · {l.prices} {t('pricesLoaded')}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {renaming?.id !== l.id && (
                      <button
                        onClick={() => setRenaming({ id: l.id, label: l.label })}
                        className={btn}
                      >
                        {t('rename')}
                      </button>
                    )}
                    {!l.protected &&
                      (confirmDeleteList === l.id ? (
                        <span className="flex items-center gap-1.5 text-xs">
                          {t('confirmDeleteList')}
                          <button disabled={busy} onClick={() => deleteList(l)} className={btnDanger}>
                            {t('yes')}
                          </button>
                          <button onClick={() => setConfirmDeleteList(null)} className={btn}>
                            {t('no')}
                          </button>
                        </span>
                      ) : (
                        <button onClick={() => setConfirmDeleteList(l.id)} className={btnDanger}>
                          {t('deleteList')}
                        </button>
                      ))}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
                  <span className="text-[11px] uppercase tracking-wider text-primary/45">
                    {t('owners')}
                  </span>
                  {owners.length === 0 && (
                    <span className="text-xs italic text-primary/45">{t('generalList')}</span>
                  )}
                  {owners.map((o) => (
                    <span
                      key={o.vendedora_id}
                      className="flex items-center gap-1.5 rounded-full border border-secondary/40 bg-gold-pale/25 py-1 pl-3 pr-1.5 text-xs"
                    >
                      <span className="font-medium">{o.name}</span>
                      {o.is_primary ? (
                        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink">
                          ★ {t('primaryOwner')}
                        </span>
                      ) : (
                        <button
                          disabled={busy}
                          onClick={() => makePrimary(l, o)}
                          title={t('makePrimary')}
                          className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-primary/50 transition-colors hover:bg-secondary/20 hover:text-primary disabled:opacity-40"
                        >
                          ★
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => removeOwner(l, o)}
                        title={t('remove')}
                        className="rounded-full px-1.5 text-[11px] font-bold text-red-600 transition-colors hover:bg-red-100 disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-950/50"
                      >
                        ✕
                      </button>
                    </span>
                  ))}

                  {free.length > 0 && (
                    <span className="flex items-center gap-1.5">
                      <select
                        value={ownerPick[l.id] ?? ''}
                        onChange={(e) =>
                          setOwnerPick((prev) => ({ ...prev, [l.id]: e.target.value }))
                        }
                        className="rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none transition-colors focus:border-secondary"
                      >
                        <option value="">{t('addOwner')}…</option>
                        {free.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={busy || !ownerPick[l.id]}
                        onClick={() => addOwner(l)}
                        className={btn}
                      >
                        + {t('addOwner')}
                      </button>
                    </span>
                  )}
                </div>

                {l.misassigned > 0 && (
                  <p className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-gold-pale/40 p-2.5 text-xs text-primary/75">
                    <span>
                      ⚠️ {l.misassigned} {t('misassignedClients')}
                    </span>
                    <button disabled={busy} onClick={() => fixAssignments(l)} className={btn}>
                      {t('fixAssignments')}
                    </button>
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
