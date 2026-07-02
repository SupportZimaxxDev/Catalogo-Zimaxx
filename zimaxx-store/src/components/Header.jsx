import { useI18n } from '../i18n'
import { useCart } from '../context/CartContext'
import { money } from '../utils/format'
import ThemeToggle from './ThemeToggle'

export default function Header({ clientName }) {
  const { lang, setLang, t } = useI18n()
  const cart = useCart()

  return (
    <header className="sticky top-0 z-30 border-b border-secondary/30 bg-ink text-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/zimaxx.png" alt="Zimaxx" className="h-10 w-10 shrink-0 md:h-11 md:w-11" />
          <div className="min-w-0">
            <h1 className="font-brand text-xl font-semibold leading-none tracking-wide text-white md:text-2xl">
              ZIMAXX
              <span className="ml-2 align-middle text-[10px] font-normal uppercase tracking-[0.35em] text-secondary md:text-xs">
                Store
              </span>
            </h1>
            {clientName ? (
              <p className="mt-1 truncate text-xs text-white/60">
                {t('welcome')}, <span className="text-secondary/90">{clientName}</span>
              </p>
            ) : (
              <p className="mt-1 text-[10px] uppercase tracking-[0.25em] text-white/40">
                {t('tagline')}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <div className="flex overflow-hidden rounded-full border border-white/20 text-xs">
            {['es', 'en'].map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={`px-3 py-1.5 font-semibold uppercase transition-colors ${
                  lang === l ? 'bg-secondary text-ink' : 'text-white/70 hover:text-white'
                }`}
              >
                {l}
              </button>
            ))}
          </div>

          {/* Botón de carrito visible en tablet/desktop; en móvil está la barra inferior */}
          <button
            onClick={() => cart.setOpen(true)}
            className="hidden items-center gap-2 rounded-full bg-secondary px-4 py-1.5 text-sm font-bold text-ink transition-all hover:bg-white md:flex"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
              <path d="M3 6h18" />
              <path d="M16 10a4 4 0 0 1-8 0" />
            </svg>
            {cart.count}
            {cart.hasPrices && <span className="font-semibold">· {money(cart.total)}</span>}
          </button>
        </div>
      </div>
    </header>
  )
}
