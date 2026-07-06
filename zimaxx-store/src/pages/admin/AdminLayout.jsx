import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import ThemeToggle from '../../components/ThemeToggle'

function Login() {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setBusy(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink p-4">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-8 text-center">
          <img src="/zimaxx.png" alt="Zimaxx" className="mx-auto mb-4 h-16 w-16" />
          <h1 className="font-brand text-2xl font-semibold text-white">
            ZIMAXX
            <span className="ml-2 text-xs font-normal uppercase tracking-[0.35em] text-secondary">
              Admin
            </span>
          </h1>
        </div>
        <form
          onSubmit={submit}
          className="space-y-4 rounded-2xl border-t-4 border-secondary bg-surface p-7 shadow-2xl"
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('email')}
            className="w-full rounded-xl border border-line px-4 py-2.5 outline-none transition-colors placeholder:text-primary/35 focus:border-secondary"
          />
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('password')}
            className="w-full rounded-xl border border-line px-4 py-2.5 outline-none transition-colors placeholder:text-primary/35 focus:border-secondary"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            disabled={busy}
            className="w-full rounded-xl bg-ink py-2.5 font-semibold text-secondary transition-colors hover:bg-ink-soft disabled:opacity-50"
          >
            {t('signIn')}
          </button>
        </form>
      </div>
    </div>
  )
}

export default function AdminLayout() {
  const { t } = useI18n()
  const location = useLocation()
  const [session, setSession] = useState(undefined) // undefined = cargando
  const [isAdmin, setIsAdmin] = useState(null)
  const [newOrders, setNewOrders] = useState(0)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) {
      setIsAdmin(null)
      return
    }
    supabase
      .rpc('is_admin')
      .then(({ data }) => setIsAdmin(!!data))
      .catch(() => setIsAdmin(false))
  }, [session])

  // Pedidos sin atender para el badge del menú; se refresca al cambiar de pestaña.
  useEffect(() => {
    if (!isAdmin) return
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'new')
      .then(({ count }) => setNewOrders(count ?? 0))
  }, [isAdmin, location.pathname])

  if (session === undefined) {
    return <p className="py-16 text-center text-primary/60">{t('loading')}</p>
  }
  if (!session) return <Login />
  if (isAdmin === null) {
    return <p className="py-16 text-center text-primary/60">{t('loading')}</p>
  }
  if (!isAdmin) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
        <p className="text-primary/70">{t('notAdmin')}</p>
        <button
          onClick={() => supabase.auth.signOut()}
          className="rounded-lg border border-primary/20 px-4 py-2 text-sm hover:bg-primary/5"
        >
          {t('signOut')}
        </button>
      </div>
    )
  }

  const tabs = [
    { to: '/admin', label: t('products'), end: true },
    { to: '/admin/prices', label: t('prices') },
    { to: '/admin/clients', label: t('clients') },
    { to: '/admin/vendedoras', label: t('vendedoras') },
    { to: '/admin/flash', label: t('flashSales') },
    { to: '/admin/orders', label: t('orders'), badge: newOrders },
  ]

  return (
    <div className="min-h-screen">
      <header className="bg-ink text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5">
          <div className="flex items-center gap-3">
            <img src="/zimaxx.png" alt="Zimaxx" className="h-9 w-9" />
            <h1 className="font-brand text-lg font-semibold leading-none">
              ZIMAXX
              <span className="ml-2 text-[10px] font-normal uppercase tracking-[0.3em] text-secondary">
                Admin
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              onClick={() => supabase.auth.signOut()}
              className="rounded-full border border-white/20 px-4 py-1.5 text-xs text-white/70 transition-colors hover:border-secondary hover:text-secondary"
            >
              {t('signOut')}
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-[3px] px-4 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'border-secondary text-secondary'
                    : 'border-transparent text-white/60 hover:text-white'
                }`
              }
            >
              {tab.label}
              {tab.badge > 0 && (
                <span className="ml-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-bold leading-none text-ink">
                  {tab.badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
