import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { parseSheet, pick, normalizeHeader } from '../../utils/excel'
import { generateToken } from '../../utils/token'
import { cleanPhone, hasCountryCode } from '../../utils/format'
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

const EMPTY_CLIENT = { name: '', phone: '', price_list_id: '', vendedora_id: '' }

// Clave de match para deduplicar por teléfono (2026-07-15, bug real
// detectado por el usuario: el mismo cliente quedó duplicado porque un
// Excel lo cargó con código de país — "13055551234" — y otro sin él —
// "3055551234" —, y comparar el string completo los trataba como dos
// personas distintas). Los últimos 10 dígitos son el número nacional real
// tanto en US (10 dígitos, código "1") como en Venezuela (national
// significant number de 10 dígitos, con o sin el "0" de troncal o el "58"
// de país por delante) — no hace falta adivinar ni agregar ningún código,
// solo ignorarlo al comparar.
const phoneKey = (phone) => cleanPhone(phone).slice(-10)

// Selector de lista de precio con confirmación (2026-07-15, a pedido del
// usuario): elegir una opción no aplica el cambio de una, muestra un
// aviso "¿Cambiar a X?" con Confirmar/Cancelar — evita un cambio de
// lista sin querer (afecta lo que el cliente ve y paga). Reutilizado
// tanto para admin como para vendedora (con distintas `options`), así
// que vive fuera de ClientsAdmin en vez de definirse adentro: un
// componente definido dentro de otro se recrea en cada render.
function ListPicker({ client, options, pending, onRequest, onConfirm, onCancel, t }) {
  const isPending = pending?.clientId === client.id
  return (
    <div className="space-y-1">
      <select
        value={client.price_list_id}
        disabled={isPending}
        onChange={(e) => onRequest(client, e.target.value)}
        className="w-40 rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none transition-colors focus:border-secondary disabled:opacity-60"
      >
        {options.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
      {isPending && (
        <div className="w-40 space-y-1.5 rounded-lg border border-secondary/40 bg-gold-pale/20 p-2">
          <p className="text-[11px] leading-snug text-primary/70">
            {t('confirmListChangeText')}{' '}
            <span className="font-semibold">
              {options.find((l) => l.id === pending.listId)?.label}
            </span>
            ?
          </p>
          <div className="flex gap-1.5">
            <button
              onClick={onConfirm}
              className="rounded-lg bg-secondary px-2.5 py-1 text-[11px] font-bold text-ink transition-colors hover:bg-secondary-dark"
            >
              {t('confirm')}
            </button>
            <button
              onClick={onCancel}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-primary/60 transition-colors hover:border-primary/40"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ClientsAdmin() {
  const { t } = useI18n()
  const { role } = useOutletContext()
  const isAdmin = role === 'admin'
  const [clients, setClients] = useState([])
  const [priceLists, setPriceLists] = useState([])
  const [vendedoresList, setVendedoresList] = useState([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [copiedId, setCopiedId] = useState(null)

  // Reasignar / eliminar (admin) — el registro de auditoría vive en su
  // propio panel, ver AuditLogAdmin.jsx.
  const [actionError, setActionError] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  // Cambio de lista de precio con confirmación (2026-07-15): un solo
  // cambio pendiente a la vez, { clientId, listId } | null.
  const [pendingList, setPendingList] = useState(null)

  // Alta individual (2026-07-07): la vendedora no elige a quién asignar,
  // el RLS (vendedora_insert_own_clients) exige que sea ella misma — acá
  // se completa con la única fila de `vendedores` que puede leer, la suya.
  const [newClientForm, setNewClientForm] = useState(null)
  const [newClientError, setNewClientError] = useState('')
  const [newClientBusy, setNewClientBusy] = useState(false)
  const myVendedoraId = !isAdmin ? vendedoresList[0]?.id : undefined

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

      // Si 2+ clientes YA existentes comparten la misma clave (caso real,
      // confirmado 2026-07-15: negocios agendados una vez con nombre
      // personal y otra con nombre de empresa, que se decidió mantener
      // como clientes distintos — ver allow_shared_phone en la DB), no
      // se puede saber a cuál de los dos le pertenece una fila del Excel
      // que llegue con esa clave. Se excluyen del mapa a propósito: una
      // fila así cae al camino de alta nueva en vez de arriesgarse a
      // pisar el cliente equivocado.
      const phoneKeyCounts = new Map()
      for (const c of clients) {
        const k = phoneKey(c.phone)
        phoneKeyCounts.set(k, (phoneKeyCounts.get(k) || 0) + 1)
      }
      const byPhone = new Map(
        clients.filter((c) => phoneKeyCounts.get(phoneKey(c.phone)) === 1).map((c) => [phoneKey(c.phone), c])
      )
      // Vendedora por nombre (sin distinguir mayúsculas): se completa con
      // las que ya existen y se crean sobre la marcha las que falten,
      // igual que antes se creaba el texto libre.
      const vendedorByName = new Map(vendedoresList.map((v) => [v.name.toLowerCase(), v]))
      let created = 0
      let updated = 0
      let inactive = 0
      let junk = 0
      let vendedoraPhoneDropped = 0
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
          const vendedoraPhoneRaw = pick(row, COLS.vendedoraPhone)
          // Sin código de país el link de WhatsApp no abre el chat en
          // iPhone (ver format.js) — mejor dejarla sin teléfono (se
          // completa a mano en la pestaña Vendedoras) que guardar uno
          // que falla en silencio.
          if (vendedoraPhoneRaw && !hasCountryCode(vendedoraPhoneRaw)) vendedoraPhoneDropped++
          const vendedoraPhone =
            vendedoraPhoneRaw && hasCountryCode(vendedoraPhoneRaw) ? cleanPhone(vendedoraPhoneRaw) : null
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

        // Lista "personal" de una vendedora (ej. 'luzmar'): pisa lo que
        // traiga el archivo, aunque la columna Vendedora diga otra cosa —
        // un cliente con esos precios no puede quedar con otra vendedora.
        const listOwner = priceLists.find((l) => l.id === listId)?.owner_vendedora_id
        if (listOwner) vendedoraId = listOwner

        const existing = byPhone.get(phoneKey(phone))
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
          // mismo teléfono más adelante (con o sin código de país), esa
          // fila actualiza en vez de crear un duplicado.
          if (insertedRows?.[0]) byPhone.set(phoneKey(phone), insertedRows[0])
        }
      }

      setResult({
        ok: true,
        message: `${created} ${t('created')} · ${updated} ${t('updated')} · ${skipped.length} ${t('skipped')}${
          skipped.length ? ` (${skipped.slice(0, 10).join(', ')})` : ''
        }${inactive ? ` · ${inactive} ${t('inactiveExcluded')}` : ''}${
          junk ? ` · ${junk} ${t('junkExcluded')}` : ''
        }${vendedoraPhoneDropped ? ` · ${vendedoraPhoneDropped} ${t('vendedoraPhoneDropped')}` : ''}`,
      })
      await load()
    } catch (err) {
      setResult({ ok: false, message: err.message })
    }
    setBusy(false)
  }

  const createClient = async (e) => {
    e.preventDefault()
    setNewClientError('')
    const name = newClientForm.name.trim()
    const phone = cleanPhone(newClientForm.phone)
    if (!name || phone.length < 7 || !newClientForm.price_list_id) return
    // El unique constraint de la base compara el string completo: no
    // pesca un duplicado si el existente está guardado con código de
    // país y este nuevo no (o viceversa). Se chequea acá antes de
    // insertar, comparando por los últimos 10 dígitos.
    if (clients.some((c) => phoneKey(c.phone) === phoneKey(phone))) {
      setNewClientError(t('phoneInUse'))
      return
    }
    setNewClientBusy(true)
    const owner = ownerVendedoraId(newClientForm.price_list_id)
    const vendedoraId = owner || (isAdmin ? newClientForm.vendedora_id || null : myVendedoraId)
    const { error } = await supabase.from('clients').insert({
      name,
      phone,
      token: generateToken(),
      price_list_id: newClientForm.price_list_id,
      vendedora_id: vendedoraId ?? null,
    })
    if (error) {
      setNewClientError(error.code === '23505' ? t('phoneInUse') : error.message)
    } else {
      setNewClientForm(null)
      await load()
    }
    setNewClientBusy(false)
  }

  const copyLink = async (c) => {
    const url = `${window.location.origin}/?c=${c.token}`
    await navigator.clipboard.writeText(url)
    setCopiedId(c.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  // Listas "personales" de una vendedora (ej. 'luzmar', 2026-07-09): si
  // owner_vendedora_id está seteado, un cliente con esa lista SIEMPRE
  // tiene que quedar asignado a esa vendedora — evita que precios
  // especiales negociados por ella terminen en la cuenta de otra.
  const ownerVendedoraId = (listId) => priceLists.find((l) => l.id === listId)?.owner_vendedora_id

  // Una vendedora sin rol admin no elige a quién asignar (siempre se
  // asigna a sí misma, ver RLS vendedora_insert_own_clients): si además
  // no ve las listas "personales" de otras, ni por error puede armar un
  // cliente que termine con precios especiales ajenos asignado a ella.
  // Admin sí ve todas — el candado de vendedora se maneja en el form.
  const selectablePriceLists = isAdmin
    ? priceLists
    : priceLists.filter((l) => !l.owner_vendedora_id || l.owner_vendedora_id === myVendedoraId)

  // Cambiar la lista del cliente: el link que ya tiene muestra los
  // precios nuevos al instante (el token identifica al cliente, la
  // lista se resuelve al abrir el catálogo). Vía RPC
  // update_client_price_list (2026-07-15): antes era un update directo
  // (solo lo podía hacer admin, que tiene RLS de escritura total); ahora
  // una vendedora también puede cambiarle la lista a sus propios
  // clientes, y para eso hace falta la RPC (ella no tiene policy de
  // UPDATE en `clients`) — que de paso audita el cambio en
  // `admin_audit_log`, sea quien sea que lo haga.
  const updateList = async (client, listId) => {
    setActionError('')
    const { error } = await supabase.rpc('update_client_price_list', {
      p_client_id: client.id,
      p_price_list_id: listId,
    })
    if (error) {
      setActionError(error.message)
      return
    }
    const owner = ownerVendedoraId(listId)
    const patch = { price_list_id: listId, ...(owner ? { vendedora_id: owner } : {}) }
    setClients((prev) => prev.map((c) => (c.id === client.id ? { ...c, ...patch } : c)))
  }

  // Elegir una opción en el selector de lista no aplica el cambio: queda
  // pendiente hasta que se confirme (evita cambiar la lista de un
  // cliente por error de un click).
  const requestListChange = (client, listId) => {
    if (!listId || listId === client.price_list_id) return
    setPendingList({ clientId: client.id, listId })
  }
  const confirmListChange = () => {
    const client = clients.find((c) => c.id === pendingList?.clientId)
    const listId = pendingList?.listId
    setPendingList(null)
    if (client && listId) updateList(client, listId)
  }
  const cancelListChange = () => setPendingList(null)

  // Reasignar el cliente a otra vendedora (o dejarlo sin asignar). Vía RPC
  // reassign_client (SECURITY DEFINER): valida admin, rechaza listas
  // personales y deja registro en admin_audit_log. No se usa un update
  // directo justamente para que la acción quede auditada sí o sí.
  const reassignClient = async (client, vendedoraId) => {
    setActionError('')
    const { error } = await supabase.rpc('reassign_client', {
      p_client_id: client.id,
      p_vendedora_id: vendedoraId || null,
    })
    if (error) {
      setActionError(error.message)
      return
    }
    await load()
  }

  // Eliminar el cliente. Vía RPC delete_client: valida admin, rechaza si
  // tiene pedidos (para no perder el historial) y audita el borrado.
  const deleteClient = async (client) => {
    setActionError('')
    const { error } = await supabase.rpc('delete_client', { p_client_id: client.id })
    setConfirmDeleteId(null)
    if (error) {
      setActionError(error.message)
      return
    }
    await load()
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
      <div className="flex items-center justify-between">
        <h2 className="font-brand text-2xl font-semibold">
          {t('clients')}
          <span className="ml-2 text-base font-normal text-primary/40">{clients.length}</span>
        </h2>
        <button
          onClick={() => {
            setNewClientError('')
            setNewClientForm({ ...EMPTY_CLIENT })
          }}
          className="rounded-full bg-ink px-5 py-2 text-sm font-semibold text-secondary transition-colors hover:bg-ink-soft"
        >
          + {t('newClient')}
        </button>
      </div>

      {newClientForm && (
        <form
          onSubmit={createClient}
          className="grid animate-fade-up gap-3 rounded-2xl border border-secondary/40 bg-surface p-5 shadow-sm md:grid-cols-2"
        >
          <input
            required
            placeholder={t('name')}
            value={newClientForm.name}
            onChange={(e) => setNewClientForm({ ...newClientForm, name: e.target.value })}
            className={inputCls}
          />
          <input
            required
            placeholder={t('phone')}
            value={newClientForm.phone}
            onChange={(e) => setNewClientForm({ ...newClientForm, phone: e.target.value })}
            className={inputCls}
          />
          <select
            required
            value={newClientForm.price_list_id}
            onChange={(e) => {
              const listId = e.target.value
              const owner = ownerVendedoraId(listId)
              setNewClientForm({
                ...newClientForm,
                price_list_id: listId,
                ...(owner ? { vendedora_id: owner } : {}),
              })
            }}
            className={inputCls}
          >
            <option value="">{t('selectList')}</option>
            {selectablePriceLists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          {(() => {
            const owner = ownerVendedoraId(newClientForm.price_list_id)
            if (owner) {
              return (
                <p className="flex items-center text-xs text-primary/50">
                  {t('assignedToOwner')} <span className="ml-1 font-semibold text-primary/70">{vendedoresList.find((v) => v.id === owner)?.name}</span>
                </p>
              )
            }
            return isAdmin ? (
              <select
                value={newClientForm.vendedora_id}
                onChange={(e) => setNewClientForm({ ...newClientForm, vendedora_id: e.target.value })}
                className={inputCls}
              >
                <option value="">{t('unassigned')}</option>
                {vendedoresList.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="flex items-center text-xs text-primary/50">{t('assignedToYou')}</p>
            )
          })()}
          {newClientError && (
            <p className="text-sm text-red-600 dark:text-red-400 md:col-span-2">{newClientError}</p>
          )}
          <div className="flex gap-2 md:col-span-2">
            <button
              disabled={newClientBusy}
              className="rounded-full bg-secondary px-6 py-2 text-sm font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-50"
            >
              {t('save')}
            </button>
            <button
              type="button"
              onClick={() => setNewClientForm(null)}
              className="rounded-full border border-line px-6 py-2 text-sm transition-colors hover:border-primary/40"
            >
              {t('cancel')}
            </button>
          </div>
        </form>
      )}

      {isAdmin && (
        <UploadZone
          icon="📇"
          title={t('bulkUpload')}
          hint={t('clientUploadHint')}
          busy={busy}
          result={result}
          onFile={handleFile}
        />
      )}

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
          {selectablePriceLists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        {isAdmin && (
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
        )}
      </div>

      {actionError && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
          {actionError}
        </div>
      )}

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
                  {isAdmin ? (
                    <div className="flex flex-col gap-1.5">
                      <ListPicker
                        client={c}
                        options={priceLists}
                        pending={pendingList}
                        onRequest={requestListChange}
                        onConfirm={confirmListChange}
                        onCancel={cancelListChange}
                        t={t}
                      />
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
                  ) : (
                    <ListPicker
                      client={c}
                      options={selectablePriceLists}
                      pending={pendingList}
                      onRequest={requestListChange}
                      onConfirm={confirmListChange}
                      onCancel={cancelListChange}
                      t={t}
                    />
                  )}
                </td>
                <td className="p-3 text-primary/60">
                  {isAdmin && !ownerVendedoraId(c.price_list_id) ? (
                    <select
                      value={c.vendedora_id ?? ''}
                      onChange={(e) => reassignClient(c, e.target.value)}
                      className="w-40 rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none transition-colors focus:border-secondary"
                      title={t('reassign')}
                    >
                      <option value="">{t('unassigned')}</option>
                      {vendedoresList.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    c.vendedores?.name || (isAdmin ? t('unassigned') : '')
                  )}
                </td>
                <td className="p-3">
                  <div className="flex items-center justify-end gap-2">
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
                    {isAdmin &&
                      (confirmDeleteId === c.id ? (
                        <span className="flex items-center gap-1.5">
                          <span className="text-xs text-primary/60">{t('deleteConfirmClient')}</span>
                          <button
                            onClick={() => deleteClient(c)}
                            className="rounded-full bg-red-600 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-red-700"
                          >
                            {t('yes')}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-primary/60 transition-colors hover:border-primary/40"
                          >
                            {t('no')}
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => {
                            setActionError('')
                            setConfirmDeleteId(c.id)
                          }}
                          className="rounded-full px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/40"
                        >
                          {t('deleteAction')}
                        </button>
                      ))}
                  </div>
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
