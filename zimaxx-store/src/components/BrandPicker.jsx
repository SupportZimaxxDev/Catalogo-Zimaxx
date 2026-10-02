import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { normalizeText } from '../utils/search'
import { suggestBrands } from '../utils/catalogSearch'

// Selector de marcas/diseñadores (2026-10-02). Reemplaza la fila de ~100 chips
// de marca, que en el teléfono era un scroll horizontal interminable donde
// nadie encontraba nada: acá la lista completa va A–Z con cuántos productos
// tiene cada marca y un buscador propio (con las mismas siglas que el
// buscador del catálogo: "ysl", "ch", "jpg", "d&g"...).
//
// `brands` llega ya recortado a la línea elegida (Diseñador / Árabes), así
// que los conteos son los que el cliente va a ver al tocar la marca.
// Hoja inferior en el teléfono, ventana centrada en desktop — mismo patrón
// que la confirmación del pedido en CartDrawer.
export default function BrandPicker({ brands, selected, onSelect, onClose, lineName }) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    // Sin scroll del catálogo de fondo mientras la hoja está abierta.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // En el teléfono el teclado tapa media lista: el foco automático solo
    // en pantallas con puntero fino.
    if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  // Con texto: el mismo orden que las sugerencias (las que empiezan con lo
  // tipeado primero). Sin texto: A–Z agrupado por inicial.
  const groups = useMemo(() => {
    const list = q.trim()
      ? suggestBrands(q, brands, brands.length)
      : [...brands].sort((a, b) => a.name.localeCompare(b.name))
    if (q.trim()) return [{ letter: '', items: list }]
    const out = []
    for (const b of list) {
      const first = normalizeText(b.name).charAt(0).toUpperCase()
      const letter = /[A-Z]/.test(first) ? first : '#'
      if (out.at(-1)?.letter !== letter) out.push({ letter, items: [] })
      out.at(-1).items.push(b)
    }
    return out
  }, [q, brands])

  const total = brands.reduce((s, b) => s + b.count, 0)
  const pick = (name) => {
    onSelect(name)
    onClose()
  }
  const itemCls = (active) =>
    `flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
      active ? 'bg-ink font-semibold text-secondary' : 'text-primary/80 hover:bg-gold-pale/50 hover:text-primary'
    }`

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-[2px] md:items-center md:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('brands')}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-3xl animate-fade-up flex-col overflow-hidden rounded-t-3xl border-t-4 border-secondary bg-surface shadow-2xl md:max-h-[80vh] md:rounded-3xl"
      >
        <div className="border-b border-line px-5 pb-4 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-brand text-xl font-semibold">{t('brands')}</h3>
              <p className="mt-0.5 text-xs text-primary/50">
                {brands.length} {t('brandsCount')}
                {lineName ? ` · ${lineName}` : ''}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label={t('close')}
              className="rounded-full p-2 text-primary/50 transition-colors hover:bg-gold-pale/50 hover:text-primary"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="relative mt-3">
            <svg
              viewBox="0 0 24 24"
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-primary/40"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={inputRef}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('searchBrands')}
              className="w-full rounded-full border border-line bg-bg py-2.5 pl-10 pr-4 text-sm outline-none transition-colors placeholder:text-primary/40 focus:border-secondary"
            />
          </div>
        </div>

        <div className="overflow-y-auto px-3 pb-5 pt-2">
          {!q.trim() && (
            <button onClick={() => pick('')} className={`${itemCls(!selected)} mb-1`}>
              <span>{t('allBrands')}</span>
              <span className={`text-xs ${!selected ? 'text-secondary/80' : 'text-primary/40'}`}>{total}</span>
            </button>
          )}
          {groups.every((g) => g.items.length === 0) && (
            <p className="py-10 text-center text-sm text-primary/50">{t('noBrands')}</p>
          )}
          {groups.map((g) => (
            <section key={g.letter || 'q'}>
              {g.letter && (
                <h4 className="sticky top-0 z-10 bg-surface px-3 pb-1 pt-3 font-brand text-sm font-semibold text-secondary-dark">
                  {g.letter}
                </h4>
              )}
              <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2 md:grid-cols-3">
                {g.items.map((b) => (
                  <button key={b.name} onClick={() => pick(b.name)} className={itemCls(selected === b.name)}>
                    <span className="truncate">{b.name}</span>
                    <span className={`shrink-0 text-xs ${selected === b.name ? 'text-secondary/80' : 'text-primary/40'}`}>
                      {b.count}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
