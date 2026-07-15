import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { cleanPhone, hasCountryCode } from '../../utils/format'
import { inputCls } from './ui'

const EMPTY = { name: '', phone: '' }

// Gestión de vendedoras: reemplaza el texto libre que antes vivía repetido
// en cada cliente. El teléfono se edita en un solo lugar y se refleja al
// instante en el link de WhatsApp de todos sus clientes.
export default function VendedoresAdmin() {
  const { t } = useI18n()
  const [vendedoras, setVendedoras] = useState([])
  const [clients, setClients] = useState([])
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editPhone, setEditPhone] = useState('')
  const [phoneError, setPhoneError] = useState('')
  const [linkEmail, setLinkEmail] = useState({}) // id -> valor del input de email
  const [linkBusyId, setLinkBusyId] = useState(null)
  const [linkError, setLinkError] = useState({}) // id -> mensaje de error

  // Crear un acceso nuevo (usuario de Supabase Auth) en vez de vincular
  // uno ya existente: un solo formulario abierto a la vez (createOpenId).
  const [createOpenId, setCreateOpenId] = useState(null)
  const [createForm, setCreateForm] = useState({ email: '', password: '' })
  const [createBusyId, setCreateBusyId] = useState(null)
  const [createError, setCreateError] = useState({}) // id -> mensaje de error

  const load = async () => {
    try {
      const [vs, cs] = await Promise.all([
        fetchAll('vendedores', '*', 'name'),
        fetchAll('clients', 'id, vendedora_id'),
      ])
      setVendedoras(vs)
      setClients(cs)
    } catch {
      /* la tabla queda como estaba; el próximo load reintenta */
    }
  }

  useEffect(() => {
    load()
  }, [])

  const clientCount = useMemo(() => {
    const map = new Map()
    for (const c of clients) {
      if (!c.vendedora_id) continue
      map.set(c.vendedora_id, (map.get(c.vendedora_id) ?? 0) + 1)
    }
    return map
  }, [clients])

  const save = async (e) => {
    e.preventDefault()
    setError('')
    // wa.me necesita el código de país incluido (ver format.js): un
    // número de 10 dígitos "funciona" en Android pero no abre el chat en
    // iPhone. Se bloquea acá en vez de dejar que el problema aparezca
    // recién cuando un cliente con iPhone intente mandar su pedido.
    if (form.phone.trim() && !hasCountryCode(form.phone)) {
      setError(t('phoneNeedsCountryCode'))
      return
    }
    setBusy(true)
    const { error } = await supabase.from('vendedores').insert({
      name: form.name.trim(),
      phone: cleanPhone(form.phone) || null,
    })
    if (error) {
      setError(error.message)
    } else {
      setForm(null)
      await load()
    }
    setBusy(false)
  }

  const startEdit = (v) => {
    setEditingId(v.id)
    setEditPhone(v.phone ?? '')
    setPhoneError('')
  }

  const savePhone = async (id) => {
    if (editPhone.trim() && !hasCountryCode(editPhone)) {
      setPhoneError(t('phoneNeedsCountryCode'))
      return
    }
    setPhoneError('')
    const phone = cleanPhone(editPhone) || null
    const { error } = await supabase.from('vendedores').update({ phone }).eq('id', id)
    if (!error) {
      setVendedoras((prev) => prev.map((v) => (v.id === id ? { ...v, phone } : v)))
    }
    setEditingId(null)
  }

  const remove = async (id) => {
    const { error } = await supabase.from('vendedores').delete().eq('id', id)
    if (error) {
      setError(t('vendedoraInUse'))
    } else {
      setError('')
      setVendedoras((prev) => prev.filter((v) => v.id !== id))
    }
  }

  // Vincula el login de la vendedora a un usuario ya creado en el
  // dashboard de Supabase Auth (RPC security definer: valida is_admin(),
  // busca el email en auth.users, que no es legible directo desde acá).
  const linkAccess = async (id) => {
    const email = (linkEmail[id] ?? '').trim()
    if (!email) return
    setLinkBusyId(id)
    setLinkError((prev) => ({ ...prev, [id]: '' }))
    const { data, error } = await supabase.rpc('link_vendedora_login', {
      p_vendedora_id: id,
      p_email: email,
    })
    if (error) {
      setLinkError((prev) => ({ ...prev, [id]: t('linkAccessInUse') }))
    } else if (!data) {
      setLinkError((prev) => ({ ...prev, [id]: t('linkAccessNotFound') }))
    } else {
      setVendedoras((prev) =>
        prev.map((v) => (v.id === id ? { ...v, login_email: email } : v)),
      )
      setLinkEmail((prev) => ({ ...prev, [id]: '' }))
    }
    setLinkBusyId(null)
  }

  const unlinkAccess = async (id) => {
    const { error } = await supabase
      .from('vendedores')
      .update({ user_id: null, login_email: null })
      .eq('id', id)
    if (!error) {
      setVendedoras((prev) => prev.map((v) => (v.id === id ? { ...v, login_email: null } : v)))
    }
  }

  const openCreate = (id) => {
    setCreateOpenId(id)
    setCreateForm({ email: '', password: '' })
    setCreateError((prev) => ({ ...prev, [id]: '' }))
  }

  // Crea el usuario de Auth y lo vincula, todo en un solo paso, vía la
  // Edge Function admin-create-vendedora-user (necesita la service_role
  // key, imposible desde el navegador — ver el archivo para el detalle).
  const createAccess = async (id) => {
    const email = createForm.email.trim()
    const password = createForm.password
    if (!email || password.length < 6) return
    setCreateBusyId(id)
    setCreateError((prev) => ({ ...prev, [id]: '' }))
    const { data, error } = await supabase.functions.invoke('admin-create-vendedora-user', {
      body: { vendedora_id: id, email, password },
    })
    if (error || data?.error) {
      let message = data?.error || error.message
      try {
        const body = await error?.context?.json()
        if (body?.error) message = body.error
      } catch {
        /* sin body JSON legible, se usa error.message */
      }
      setCreateError((prev) => ({ ...prev, [id]: message }))
    } else {
      setVendedoras((prev) => prev.map((v) => (v.id === id ? { ...v, login_email: email } : v)))
      setCreateOpenId(null)
    }
    setCreateBusyId(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-brand text-2xl font-semibold">
          {t('vendedoras')}
          <span className="ml-2 text-base font-normal text-primary/40">{vendedoras.length}</span>
        </h2>
        <button
          onClick={() => setForm({ ...EMPTY })}
          className="rounded-full bg-ink px-5 py-2 text-sm font-semibold text-secondary transition-colors hover:bg-ink-soft"
        >
          + {t('newVendedora')}
        </button>
      </div>

      {form && (
        <form
          onSubmit={save}
          className="grid animate-fade-up gap-3 rounded-2xl border border-secondary/40 bg-surface p-5 shadow-sm md:grid-cols-2"
        >
          <input
            required
            placeholder={t('name')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputCls}
          />
          <label className="text-sm">
            <input
              placeholder={t('phone')}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className={`${inputCls} w-full`}
            />
            <span className="mt-1 block text-xs text-primary/50">{t('phoneHint')}</span>
          </label>
          {error && <p className="text-sm text-red-600 dark:text-red-400 md:col-span-2">{error}</p>}
          <div className="flex gap-2 md:col-span-2">
            <button
              disabled={busy}
              className="rounded-full bg-secondary px-6 py-2 text-sm font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-50"
            >
              {t('save')}
            </button>
            <button
              type="button"
              onClick={() => setForm(null)}
              className="rounded-full border border-line px-6 py-2 text-sm transition-colors hover:border-primary/40"
            >
              {t('cancel')}
            </button>
          </div>
        </form>
      )}

      {error && !form && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-primary/45">
              <th className="p-3">{t('name')}</th>
              <th className="p-3">{t('phone')}</th>
              <th className="p-3">{t('assignedClients')}</th>
              <th className="p-3">{t('access')}</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {vendedoras.map((v) => (
              <tr key={v.id} className="border-b border-line/60 transition-colors hover:bg-gold-pale/20">
                <td className="p-3 font-medium">{v.name}</td>
                <td className="p-3 font-mono text-xs">
                  {editingId === v.id ? (
                    <div className="w-36">
                      <input
                        autoFocus
                        value={editPhone}
                        onChange={(e) => setEditPhone(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && savePhone(v.id)}
                        onBlur={() => savePhone(v.id)}
                        placeholder="13055551234"
                        className="w-36 rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none transition-colors focus:border-secondary"
                      />
                      {phoneError && (
                        <p className="mt-1 whitespace-normal text-[11px] text-red-600 dark:text-red-400">
                          {phoneError}
                        </p>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => startEdit(v)}
                      className="inline-flex items-center gap-1 text-primary/70 hover:text-secondary-dark hover:underline"
                    >
                      {v.phone || <span className="italic text-primary/35">{t('noPhone')}</span>}
                      {v.phone && !hasCountryCode(v.phone) && (
                        <span title={t('phoneNeedsCountryCode')} className="text-red-600 dark:text-red-400">
                          ⚠️
                        </span>
                      )}
                    </button>
                  )}
                </td>
                <td className="p-3 text-primary/60">{clientCount.get(v.id) ?? 0}</td>
                <td className="p-3">
                  {v.login_email ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-primary/70">{v.login_email}</span>
                      <button
                        onClick={() => unlinkAccess(v.id)}
                        className="text-xs font-semibold text-red-600 hover:underline dark:text-red-400"
                      >
                        {t('unlinkAccess')}
                      </button>
                    </div>
                  ) : createOpenId === v.id ? (
                    <div className="w-48 space-y-1.5 rounded-lg border border-secondary/40 bg-gold-pale/10 p-2">
                      <input
                        type="email"
                        autoFocus
                        value={createForm.email}
                        onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                        placeholder={t('loginEmailPlaceholder')}
                        className="w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none transition-colors focus:border-secondary"
                      />
                      <input
                        type="text"
                        value={createForm.password}
                        onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                        placeholder={t('newPasswordPlaceholder')}
                        className="w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none transition-colors focus:border-secondary"
                      />
                      <div className="flex gap-1.5">
                        <button
                          disabled={
                            createBusyId === v.id ||
                            !createForm.email.trim() ||
                            createForm.password.length < 6
                          }
                          onClick={() => createAccess(v.id)}
                          className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-50"
                        >
                          {t('createAccess')}
                        </button>
                        <button
                          onClick={() => setCreateOpenId(null)}
                          className="rounded-lg border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-primary/40"
                        >
                          {t('cancel')}
                        </button>
                      </div>
                      <p className="text-[11px] text-primary/50">{t('newPasswordHint')}</p>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="email"
                          value={linkEmail[v.id] ?? ''}
                          onChange={(e) =>
                            setLinkEmail((prev) => ({ ...prev, [v.id]: e.target.value }))
                          }
                          placeholder={t('loginEmailPlaceholder')}
                          className="w-40 rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none transition-colors focus:border-secondary"
                        />
                        <button
                          disabled={linkBusyId === v.id || !(linkEmail[v.id] ?? '').trim()}
                          onClick={() => linkAccess(v.id)}
                          className="whitespace-nowrap rounded-lg border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary disabled:opacity-50"
                        >
                          {t('linkAccess')}
                        </button>
                      </div>
                      <button
                        onClick={() => openCreate(v.id)}
                        className="text-[11px] font-semibold text-secondary-dark hover:underline"
                      >
                        + {t('createAccess')}
                      </button>
                    </div>
                  )}
                  {linkError[v.id] && (
                    <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                      {linkError[v.id]}
                    </p>
                  )}
                  {createError[v.id] && (
                    <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                      {createError[v.id]}
                    </p>
                  )}
                </td>
                <td className="p-3 text-right">
                  <button
                    onClick={() => remove(v.id)}
                    className="text-xs font-semibold text-red-600 hover:underline dark:text-red-400"
                  >
                    {t('remove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {vendedoras.length === 0 && (
          <p className="p-6 text-center text-sm text-primary/50">{t('noVendedoras')}</p>
        )}
      </div>
    </div>
  )
}
