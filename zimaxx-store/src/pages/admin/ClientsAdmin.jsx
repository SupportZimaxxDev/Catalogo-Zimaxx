import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { parseSheet, pick, normalizeHeader } from '../../utils/excel'
import { generateToken } from '../../utils/token'
import { cleanPhone } from '../../utils/format'
import { SearchIcon, UploadZone, inputCls, useInfiniteRows } from './ui'

// Alias aceptados en el Excel de clientes (es/en, con o sin acentos).
const COLS = {
  name: ['nombre', 'name', 'cliente', 'client'],
  phone: ['telefono', 'phone', 'tel', 'celular', 'whatsapp'],
  list: ['lista de precio', 'lista de precios', 'lista', 'price list', 'pricelist'],
  vendedora: ['vendedora', 'vendedor', 'sales rep', 'rep', 'asesora'],
  vendedoraPhone: [
    'telefono vendedora',
    'tel vendedora',
    'vendedora telefono',
    'rep phone',
    'sales rep phone',
  ],
}

// Export real del sistema de origen (SellerCloud): no trae columnas
// "nombre"/"lista de precio", sino nombre de empresa/persona separado,
// varios teléfonos y un campo "Comments" en texto libre con el tamaño
// de compra (Mayorista/Minorista). Se resuelve con reglas propias en
// vez de alias directos, y solo se usa como último recurso si el
// archivo no trae ya las columnas simples de arriba.
function resolveName(row) {
  return (
    pick(row, COLS.name) ||
    row.businessname ||
    [row.firstname, row.lastname].filter(Boolean).join(' ').trim() ||
    undefined
  )
}

function resolvePhone(row) {
  return (
    pick(row, COLS.phone) ||
    row.phone1 ||
    row.phone ||
    row.billtophone ||
    row.shiptophone ||
    row.phone2 ||
    row.phone3 ||
    undefined
  )
}

function resolveVendedora(row) {
  return pick(row, COLS.vendedora) || row.salesman || undefined
}

// Cuentas de prueba de QA/integraciones coladas en el export real
// ("Test Uno", "TEST API PHONE NO USAR" con teléfono real): no son
// clientes y no deben recibir un link de catálogo funcional.
const CLIENT_JUNK_PATTERN = /\btest\b|no usar/i

// La región (us_/ve_) es por precio de mercado, no por logística: los
// clientes facturados en Venezuela pagan otra lista aunque envíen a
// Miami como casi todos. Se resuelve por el país de facturación
// ("Country"), no por el de envío.
function resolveRegion(row) {
  return normalizeHeader(row.country ?? '').includes('venezuela') ? 've' : 'us'
}

// Comments es texto libre y con errores de tipeo ("MAyorista",
// "Minoritsta", etc.): se matchea por substring, no por igualdad.
// "Inactive" no resuelve a ninguna lista: esa fila se descarta entera
// (no tiene sentido generarle un link de catálogo activo a alguien dado
// de baja). Special (distribuidor/gran mayorista/especial) es una sola
// lista general: a partir de $15,000 la región no aplica.
function resolvePriceListCode(row) {
  const comments = normalizeHeader(row.comments ?? '')
  if (/inactiv/.test(comments)) return null
  if (/especial|special|distribuidor|gran mayor/.test(comments)) return 'special'
  const region = resolveRegion(row)
  if (/mayor/.test(comments)) return `${region}_wholesale`
  if (/minor/.test(comments)) return `${region}_min`
  if (row.iswholesaleuser === undefined) return undefined // no hay señal: que decida resolveListId
  return String(row.iswholesaleuser).trim().toLowerCase() === 'true'
    ? `${region}_wholesale`
    : `${region}_min`
}

// Umbrales de inversión → nivel de lista (regla del negocio): el mínimo
// de orden es $800; desde $2,000 aplica precio mayorista. Desde $15,000
// es Special: una sola lista general con precio propio (sin región).
export function tierForInvestment(amount) {
  if (amount >= 15000) return 'special'
  if (amount >= 2000) return 'wholesale'
  return 'min'
}

const LIST_CODE_ALIASES = {
  'us minimum order': 'us_min',
  'us min': 'us_min',
  us_min: 'us_min',
  'us wholesale': 'us_wholesale',
  us_wholesale: 'us_wholesale',
  've minimum order': 've_min',
  've min': 've_min',
  ve_min: 've_min',
  've wholesale': 've_wholesale',
  ve_wholesale: 've_wholesale',
  // Special no distingue región: "US/VE Special" y "distribuidor" de
  // cualquier variante caen todos en la misma lista general.
  'us special': 'special',
  us_special: 'special',
  'us distribuidor': 'special',
  'us distributor': 'special',
  've special': 'special',
  ve_special: 'special',
  've distribuidor': 'special',
  've distributor': 'special',
  'special order': 'special',
  special: 'special',
}

export default function ClientsAdmin() {
  const { t } = useI18n()
  const [clients, setClients] = useState([])
  const [priceLists, setPriceLists] = useState([])
  const [vendedoresList, setVendedoresList] = useState([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [copiedId, setCopiedId] = useState(null)

  // Búsqueda y filtros
  const [query, setQuery] = useState('')
  const [listFilter, setListFilter] = useState('')
  const [repFilter, setRepFilter] = useState('')
  const [visibleRows, sentinelRef] = useInfiniteRows(100, [query, listFilter, repFilter])

  const load = async () => {
    try {
      const [cs, pls, vs] = await Promise.all([
        fetchAll('clients', '*, vendedores(name, phone)', 'name'),
        fetchAll('price_lists'),
        fetchAll('vendedores', '*', 'name'),
      ])
      setClients(cs)
      setPriceLists(pls)
      setVendedoresList(vs)
    } catch {
      /* la tabla queda como estaba; el próximo load reintenta */
    }
  }

  useEffect(() => {
    load()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const qDigits = q.replace(/\D/g, '')
    return clients.filter((c) => {
      if (listFilter && c.price_list_id !== listFilter) return false
      if (repFilter && c.vendedora_id !== repFilter) return false
      if (!q) return true
      return (
        c.name.toLowerCase().includes(q) ||
        (qDigits && cleanPhone(c.phone).includes(qDigits)) ||
        (c.vendedores?.name ?? '').toLowerCase().includes(q)
      )
    })
  }, [clients, query, listFilter, repFilter])

  const resolveListId = (raw) => {
    const norm = normalizeHeader(raw ?? '')
    const code = LIST_CODE_ALIASES[norm] ?? norm
    return priceLists.find((l) => l.code === code || normalizeHeader(l.label) === norm)?.id
  }

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setBusy(true)
    setResult(null)

    try {
      const rows = await parseSheet(file)
      if (rows.length === 0) throw new Error('Archivo vacío')

      const byPhone = new Map(clients.map((c) => [cleanPhone(c.phone), c]))
      // Vendedora por nombre (sin distinguir mayúsculas): se completa con
      // las que ya existen y se crean sobre la marcha las que falten,
      // igual que antes se creaba el texto libre.
      const vendedorByName = new Map(vendedoresList.map((v) => [v.name.toLowerCase(), v]))
      let created = 0
      let updated = 0
      let inactive = 0
      let junk = 0
      const skipped = []

      // Solo crear/actualizar (match por teléfono). Nunca borrar clientes
      // ausentes del archivo: un Excel viejo no puede matar tokens en uso.
      for (const [idx, row] of rows.entries()) {
        const name = resolveName(row)
        const phone = cleanPhone(resolvePhone(row))
        if (CLIENT_JUNK_PATTERN.test(name ?? '')) {
          junk++
          continue
        }
        const listCode = resolvePriceListCode(row)
        if (listCode === null) {
          inactive++
          continue
        }
        const listId =
          listCode !== undefined
            ? priceLists.find((l) => l.code === listCode)?.id
            : resolveListId(pick(row, COLS.list))

        if (!name || !phone || phone.length < 7 || !listId) {
          skipped.push(`fila ${idx + 2}`)
          continue
        }

        // Solo tocar vendedora_id si el archivo trae ese dato: re-subir un
        // export sin esa columna no debe borrar la asignación existente.
        const vendedoraName = resolveVendedora(row)
        let vendedoraId
        if (vendedoraName) {
          const key = vendedoraName.trim().toLowerCase()
          let v = vendedorByName.get(key)
          const vendedoraPhone = cleanPhone(pick(row, COLS.vendedoraPhone)) || null
          if (!v) {
            const { data: inserted, error: vError } = await supabase
              .from('vendedores')
              .insert({ name: vendedoraName.trim(), phone: vendedoraPhone })
              .select()
              .single()
            if (vError) throw vError
            v = inserted
          } else if (vendedoraPhone && !v.phone) {
            await supabase.from('vendedores').update({ phone: vendedoraPhone }).eq('id', v.id)
            v = { ...v, phone: vendedoraPhone }
          }
          vendedorByName.set(key, v)
          vendedoraId = v.id
        }

        const existing = byPhone.get(phone)
        if (existing) {
          const { error } = await supabase
            .from('clients')
            .update({
              name,
              price_list_id: listId,
              ...(vendedoraId !== undefined ? { vendedora_id: vendedoraId } : {}),
            })
            .eq('id', existing.id)
          if (error) throw error
          updated++
        } else {
          const { data: insertedRows, error } = await supabase
            .from('clients')
            .insert({
              name,
              phone,
              token: generateToken(),
              price_list_id: listId,
              vendedora_id: vendedoraId ?? null,
            })
            .select()
          if (error) throw error
          created++
          // Registrar el alta recién hecha: si el archivo repite este
          // mismo teléfono más adelante, esa fila actualiza en vez de
          // chocar contra el unique constraint de clients.phone.
          if (insertedRows?.[0]) byPhone.set(phone, insertedRows[0])
        }
      }

      setResult({
        ok: true,
        message: `${created} ${t('created')} · ${updated} ${t('updated')} · ${skipped.length} ${t('skipped')}${
          skipped.length ? ` (${skipped.slice(0, 10).join(', ')})` : ''
        }${inactive ? ` · ${inactive} ${t('inactiveExcluded')}` : ''}${
          junk ? ` · ${junk} ${t('junkExcluded')}` : ''
        }`,
      })
      await load()
    } catch (err) {
      setResult({ ok: false, message: err.message })
    }
    setBusy(false)
  }

  const copyLink = async (c) => {
    const url = `${window.location.origin}/?c=${c.token}`
    await navigator.clipboard.writeText(url)
    setCopiedId(c.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  // Cambiar la lista del cliente: el link que ya tiene muestra los
  // precios nuevos al instante (el token identifica al cliente, la
  // lista se resuelve al abrir el catálogo).
  const updateList = async (client, listId) => {
    const { error } = await supabase
      .from('clients')
      .update({ price_list_id: listId })
      .eq('id', client.id)
    if (!error) {
      setClients((prev) =>
        prev.map((c) => (c.id === client.id ? { ...c, price_list_id: listId } : c)),
      )
    }
  }

  // Monto que el cliente dice que va a invertir → nivel dentro de su
  // región actual (us_/ve_), salvo que el nivel resultante sea 'special':
  // esa lista es general, sin región. Una vez en 'special' no se
  // reasigna solo: si hay que bajarlo de nivel, se hace a mano.
  const applyInvestment = (client, raw) => {
    const amount = Number(String(raw).replace(/[$,\s]/g, ''))
    if (!Number.isFinite(amount) || amount <= 0) return
    const currentCode = priceLists.find((l) => l.id === client.price_list_id)?.code ?? ''
    if (currentCode === 'special') return
    const tier = tierForInvestment(amount)
    const targetCode = tier === 'special' ? 'special' : `${currentCode.startsWith('ve_') ? 've' : 'us'}_${tier}`
    const target = priceLists.find((l) => l.code === targetCode)
    if (target && target.id !== client.price_list_id) updateList(client, target.id)
  }

  return (
    <div className="space-y-4">
      <h2 className="font-brand text-2xl font-semibold">
        {t('clients')}
        <span className="ml-2 text-base font-normal text-primary/40">{clients.length}</span>
      </h2>

      <UploadZone
        icon="📇"
        title={t('bulkUpload')}
        hint={t('clientUploadHint')}
        busy={busy}
        result={result}
        onFile={handleFile}
      />

      {/* Buscador + filtros */}
      <div className="flex flex-col gap-2 md:flex-row">
        <div className="relative flex-1">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchClients')}
            className={`${inputCls} w-full pl-10`}
          />
        </div>
        <select
          value={listFilter}
          onChange={(e) => setListFilter(e.target.value)}
          className={inputCls}
        >
          <option value="">{t('allLists')}</option>
          {priceLists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <select
          value={repFilter}
          onChange={(e) => setRepFilter(e.target.value)}
          className={inputCls}
        >
          <option value="">{t('allReps')}</option>
          {vendedoresList.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-primary/45">
              <th className="p-3">{t('name')}</th>
              <th className="p-3">Tel</th>
              <th className="p-3">Lista</th>
              <th className="p-3">Vendedora</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, visibleRows).map((c) => (
              <tr key={c.id} className="border-b border-line/60 transition-colors hover:bg-gold-pale/20">
                <td className="p-3 font-medium">{c.name}</td>
                <td className="p-3 font-mono text-xs text-primary/60">{c.phone}</td>
                <td className="p-3">
                  <div className="flex flex-col gap-1.5">
                    <select
                      value={c.price_list_id}
                      onChange={(e) => updateList(c, e.target.value)}
                      className="w-40 rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none transition-colors focus:border-secondary"
                    >
                      {priceLists.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder={t('investmentPlaceholder')}
                      title={t('investmentHint')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          applyInvestment(c, e.currentTarget.value)
                          e.currentTarget.value = ''
                        }
                      }}
                      onBlur={(e) => {
                        if (e.currentTarget.value.trim()) {
                          applyInvestment(c, e.currentTarget.value)
                          e.currentTarget.value = ''
                        }
                      }}
                      className="w-40 rounded-lg border border-dashed border-line bg-transparent px-2 py-1 text-xs outline-none transition-colors placeholder:text-primary/35 focus:border-secondary"
                    />
                  </div>
                </td>
                <td className="p-3 text-primary/60">{c.vendedores?.name}</td>
                <td className="p-3 text-right">
                  <button
                    onClick={() => copyLink(c)}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all ${
                      copiedId === c.id
                        ? 'bg-green-100 text-green-800'
                        : 'bg-secondary/15 text-secondary-dark hover:bg-secondary/30'
                    }`}
                  >
                    {copiedId === c.id ? `✓ ${t('copied')}` : t('copyLink')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > visibleRows && (
          <div ref={sentinelRef} className="py-4 text-center text-xs text-primary/40">
            {t('loading')}
          </div>
        )}
        <div className="border-t border-line px-4 py-2.5 text-xs text-primary/50">
          {filtered.length} {t('results')}
        </div>
      </div>
    </div>
  )
}
