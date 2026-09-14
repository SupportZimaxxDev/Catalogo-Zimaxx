import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { parseSheet, pick, normalizeHeader } from '../../utils/excel'
import { generateToken } from '../../utils/token'
import { cleanPhone, hasCountryCode } from '../../utils/format'
import { searchTerms, matchesTerms } from '../../utils/search'
import { logEvent } from '../../utils/systemLog'
import { SearchIcon, UploadZone, inputCls, useInfiniteRows } from './ui'
import {
  AddressFields,
  addressChanged,
  addressFieldLabels,
  addressForm,
  addressIsEmpty,
  addressMissing,
  addressPayload,
  addressSummary,
} from './address'
import { defaultCountryForList } from '../../utils/countries'

// Alias aceptados en el Excel de clientes (es/en, con o sin acentos).
const COLS = {
  name: ['nombre', 'name', 'cliente', 'client'],
  phone: ['telefono', 'phone', 'tel', 'celular', 'whatsapp'],
  email: ['email', 'correo', 'e-mail', 'mail', 'correo electronico'],
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

// Email opcional del archivo (2026-08-31). Devuelve undefined si la columna
// no viene o el valor no parece un email — undefined significa "no tocar lo
// guardado": re-subir un Excel viejo sin columna de correo no borra nada.
function resolveEmail(row) {
  const raw = String(pick(row, COLS.email) ?? '').trim().toLowerCase()
  return raw && EMAIL_RE.test(raw) ? raw : undefined
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

// Candado del alta en SellerCloud (hotfix 2026-09-09). Con el flag en false,
// el toggle del alta se muestra apagado y deshabilitado, el panel SellerCloud
// no ofrece "Crear en SellerCloud" (buscar y vincular siguen andando) y
// createSc corta antes de llamar a la Edge Function. Va en pareja con
// CREATE_ENABLED en supabase/functions/sellercloud-customers/index.ts.
//
// VALOR POR RAMA (decisión del usuario, 2026-09-14):
//   * main / producción → false: el deploy del 09-14 (7924120) salió con el
//     alta bloqueada, y así tiene que seguir hasta que la reparación termine.
//   * dev → true: ES la rama donde se repara la creación de clientes ("sigamos
//     trabajando el dev con la función en true"), así que acá está prendida.
// main es ancestro de dev y el merge es fast-forward: ANTES de cada deploy
// desde dev, poner los dos flags en false (este y CREATE_ENABLED en la Edge
// Function), deployar, y volver a true en dev. Con true deployado el alta se
// reactiva para todas las vendedoras. En un conflicto de merge sobre esta
// zona, conservar el bloque completo del flag y elegir el valor según la rama
// destino.
const SC_CREATE_ENABLED = true

// scCreate (2026-09-02): "Crear también en SellerCloud" — prendido por
// defecto (mientras SC_CREATE_ENABLED lo permita); al elegir la lista 'quote'
// (cliente de cotización) se apaga solo.
// Con el toggle ON el nombre se pide PARTIDO (nombre + apellido): SellerCloud
// valida Last Name al crear órdenes ("Customer's last name is not valid") y
// un customer creado sin apellido nace inválido para lo único que lo creamos.
const EMPTY_CLIENT = {
  name: '',
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  price_list_id: '',
  vendedora_id: '',
  scCreate: SC_CREATE_ENABLED,
  // Ficha SellerCloud (2026-09-09), ver PROFILE_KEYS.
  business_name: '',
  sc_customer_group_id: '',
  sc_account_manager_id: '',
  sc_salesman: '',
  sc_comments: '',
  // Dirección (2026-09-14), ver address.jsx. El país se propone al elegir la
  // lista (ve_* → VE, el resto → US).
  address_line1: '',
  address_line2: '',
  address_city: '',
  address_state: '',
  address_zip: '',
  address_country: '',
}

// Ficha SellerCloud del cliente (2026-09-09, a pedido del usuario: "el
// cliente se debe crear con business name, customer group, account manager,
// salesmen y comments"). Cinco columnas de `clients` (más
// sc_customer_group_name, la foto del nombre del grupo): el alta las inserta
// junto con el cliente, la edición las guarda por la RPC
// update_client_sc_profile (auditada, solo lo que cambió) y la Edge Function
// sellercloud-customers las manda a SellerCloud — en el alta (create → PUT
// con teléfono + ficha → POST al grupo) y con la acción 'update' cuando se
// edita la ficha de un cliente ya vinculado.
//
// De dónde salen las opciones (la API de SellerCloud no lista grupos ni
// empleados): el grupo y el account manager son datos DE LA VENDEDORA
// (vendedores.sellercloud_group_id / sellercloud_rep_id — en los customers
// reales el AccountManagerId es exactamente el rep_id de su vendedora), el
// salesman es su nombre y el comentario sale de la lista de precio. Todo se
// prellena y se puede cambiar.
const PROFILE_KEYS = ['business_name', 'sc_customer_group_id', 'sc_account_manager_id', 'sc_salesman', 'sc_comments']

// Valores que el negocio usa en Comments (export real de SellerCloud:
// Mayorista 439, Minorista 279, Distribuidor 35, Zimaxx Box 12, Zimaxx Plus
// 4, con typos varios). Son sugerencias del input, no una lista cerrada.
const COMMENT_SUGGESTIONS = ['Mayorista', 'Minorista', 'Distribuidor', 'Zimaxx Box', 'Zimaxx Plus']

// Comentario propuesto según la lista de precio — el espejo de
// resolvePriceListCode (que va de Comments a lista) para el camino inverso.
export function commentsForListCode(code) {
  if (!code) return ''
  if (code === 'special') return 'Distribuidor'
  if (code.endsWith('_wholesale')) return 'Mayorista'
  if (code.endsWith('_min')) return 'Minorista'
  return ''
}

// Ficha de un form (strings) → shape de la fila / la RPC (null = vacío).
export function profilePayload(form) {
  const int = (v) => {
    const raw = String(v ?? '').trim()
    const n = Number(raw)
    return raw !== '' && Number.isInteger(n) && n > 0 ? n : null
  }
  const txt = (v) => String(v ?? '').trim() || null
  return {
    business_name: txt(form.business_name),
    sc_customer_group_id: int(form.sc_customer_group_id),
    sc_account_manager_id: int(form.sc_account_manager_id),
    sc_salesman: txt(form.sc_salesman),
    sc_comments: txt(form.sc_comments),
  }
}

// Ficha de una fila → valores de form ('' = vacío).
function profileForm(row) {
  return {
    business_name: row?.business_name ?? '',
    sc_customer_group_id: row?.sc_customer_group_id == null ? '' : String(row.sc_customer_group_id),
    sc_account_manager_id: row?.sc_account_manager_id == null ? '' : String(row.sc_account_manager_id),
    sc_salesman: row?.sc_salesman ?? '',
    sc_comments: row?.sc_comments ?? '',
  }
}

const profileChanged = (a, b) => PROFILE_KEYS.some((k) => (a[k] ?? null) !== (b[k] ?? null))

// Clase de los inputs de la ficha (alta, edición y panel SellerCloud).
// min-w-0 (2026-09-09): un <select> con opciones largas ("Clientes Adriana
// Montilla") tiene ancho mínimo intrínseco y, dentro de una grilla, empujaba
// la página entera a scroll horizontal en móvil (390 px) — mismo bug que el
// UploadZone del 2026-07-06.
const profileInputCls =
  'w-full min-w-0 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none transition-colors placeholder:text-primary/35 focus:border-secondary'

// Chequeo laxo de email (algo@algo.algo): atajar el typo obvio sin rechazar
// correos raros pero reales. La RPC update_client_info aplica la misma regla
// server-side. El email es opcional en todos los forms — vacío = sin correo.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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
  const { t, lang } = useI18n()
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

  // Edición de nombre/teléfono (2026-08-25), SellerCloud ID (2026-08-31) y
  // correo (2026-09-08): un solo cliente en edición a la vez,
  // { clientId, name, phone, email, scid } | null. Nombre/teléfono/correo van
  // por la RPC update_client_info (admin edita cualquiera, una vendedora solo
  // los suyos) — la RPC exige p_email y vacío = borrar, que acá es una acción
  // explícita del input. Historia: la columna Email se quitó de la tabla el
  // 2026-09-01 (0 de 2755 clientes con correo) y la edición reenviaba el
  // guardado tal cual; el 2026-09-08 el usuario pidió volver a VER qué correo
  // tiene cada cliente — ahora se muestra bajo el teléfono solo si lo hay,
  // con chips con/sin correo, y se edita junto con el teléfono. El vínculo
  // con SellerCloud va aparte por set_client_sellercloud_id (SOLO ADMIN: un
  // ID equivocado manda los pedidos al cliente equivocado allá — el input ni
  // se muestra a la vendedora). Todo queda auditado en admin_audit_log.
  const [editForm, setEditForm] = useState(null)
  const [editBusy, setEditBusy] = useState(false)

  // Alta individual (2026-07-07): la vendedora no elige a quién asignar,
  // el RLS (vendedora_insert_own_clients) exige que sea ella misma — acá
  // se completa con la única fila de `vendedores` que puede leer, la suya.
  const [newClientForm, setNewClientForm] = useState(null)
  const [newClientError, setNewClientError] = useState('')
  const [newClientBusy, setNewClientBusy] = useState(false)
  const myVendedoraId = !isAdmin ? vendedoresList[0]?.id : undefined

  // Opciones de la ficha SellerCloud. Grupos: los cargados en alguna
  // vendedora (la API no los lista). Account managers: las vendedoras con ID
  // de empleado (sellercloud_rep_id). Una vendedora solo lee su propia fila
  // de `vendedores` (RLS), así que sus opciones son ella misma — y la RPC
  // igual rechaza el grupo/account manager de otra.
  const groupOptions = useMemo(() => {
    const m = new Map()
    for (const v of vendedoresList) {
      if (v.sellercloud_group_id != null && !m.has(v.sellercloud_group_id)) {
        m.set(v.sellercloud_group_id, {
          id: v.sellercloud_group_id,
          name: v.sellercloud_group_name || `#${v.sellercloud_group_id}`,
        })
      }
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [vendedoresList])
  const accountManagerOptions = useMemo(
    () =>
      vendedoresList
        .filter((v) => v.sellercloud_rep_id != null)
        .map((v) => ({ id: v.sellercloud_rep_id, name: v.name })),
    [vendedoresList],
  )
  const groupName = (id) => groupOptions.find((g) => String(g.id) === String(id))?.name ?? null
  const accountManagerName = (id) =>
    accountManagerOptions.find((a) => String(a.id) === String(id))?.name ?? null
  // El select de grupo suma el del cliente si ya no está en ninguna
  // vendedora (grupo viejo/ajeno): que se vea y se pueda conservar.
  const groupOptionsFor = (form, row) => {
    const cur = String(form.sc_customer_group_id ?? '')
    if (!cur || groupOptions.some((g) => String(g.id) === cur)) return groupOptions
    return [...groupOptions, { id: Number(cur), name: row?.sc_customer_group_name || `#${cur}` }]
  }

  // Ficha propuesta para un cliente de esta vendedora: su grupo, ella como
  // account manager y su nombre como salesman.
  const profileFromVendedora = (vendedoraId) => {
    const v = vendedoresList.find((x) => x.id === vendedoraId)
    if (!v) return { sc_customer_group_id: '', sc_account_manager_id: '', sc_salesman: '' }
    return {
      sc_customer_group_id: v.sellercloud_group_id == null ? '' : String(v.sellercloud_group_id),
      sc_account_manager_id: v.sellercloud_rep_id == null ? '' : String(v.sellercloud_rep_id),
      sc_salesman: v.name,
    }
  }
  const listCode = (listId) => priceLists.find((l) => l.id === listId)?.code ?? ''

  // Quién está logueado, para el context de los eventos: log_event no guarda
  // identidad. getSession lee el storage local, sin request.
  const [userEmail, setUserEmail] = useState(null)
  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setUserEmail(data?.session?.user?.email ?? null))
      .catch(() => {})
  }, [])

  // Rastro en system_logs de cada cliente creado desde el catálogo (2026-09-09,
  // a pedido del usuario: filtrar y exportar "clientes creados desde el
  // catálogo" en ⚙️ Sistema). Source `clients`, evento `client_created`; el
  // context lleva la ficha completa con NOMBRES (lista, vendedora, grupo,
  // account manager) y no IDs, porque es lo que se exporta a Excel tal cual.
  // `via` distingue el formulario del Excel. Fire-and-forget: nunca frena el
  // alta. El resultado en SellerCloud lo loguea aparte la Edge Function
  // (source sellercloud_customers, con el mismo client_id).
  const logClientCreated = (row, extra) => {
    const v = vendedoresList.find((x) => x.id === row.vendedora_id)
    logEvent('info', 'clients', 'client_created', `${row.name} · ${row.phone}`, {
      client_id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email ?? null,
      price_list: priceLists.find((l) => l.id === row.price_list_id)?.label ?? null,
      vendedora: v?.name ?? null,
      business_name: row.business_name ?? null,
      group: row.sc_customer_group_name ?? row.sc_customer_group_id ?? null,
      account_manager: accountManagerName(row.sc_account_manager_id) ?? row.sc_account_manager_id ?? null,
      salesman: row.sc_salesman ?? null,
      comments: row.sc_comments ?? null,
      created_by: userEmail,
      ...extra,
    })
  }
  // El comentario se re-propone al cambiar la lista SOLO si el que hay es
  // vacío o una de las sugerencias (un texto propio tipeado a mano no se pisa).
  const autoComments = (current, listId) =>
    !String(current ?? '').trim() || COMMENT_SUGGESTIONS.includes(String(current).trim())
      ? { sc_comments: commentsForListCode(listCode(listId)) }
      : {}

  // Guardar la ficha por su RPC (permisos + auditoría server-side) y, si el
  // cliente ya está vinculado, empujarla a SellerCloud — mejor-esfuerzo: lo
  // local ya quedó. Devuelve el aviso para el banner (o null si nada cambió).
  const saveProfile = async (client, form, sellercloudId) => {
    const profile = profilePayload(form)
    if (!profileChanged(profile, profilePayload(profileForm(client)))) return { changed: false, notice: null, pushed: false }
    const { data, error } = await supabase.rpc('update_client_sc_profile', {
      p_client_id: client.id,
      p_business_name: profile.business_name,
      p_customer_group_id: profile.sc_customer_group_id,
      p_customer_group_name: profile.sc_customer_group_id ? groupName(profile.sc_customer_group_id) : null,
      p_account_manager_id: profile.sc_account_manager_id,
      p_salesman: profile.sc_salesman,
      p_comments: profile.sc_comments,
    })
    if (error) throw error
    const patch = {
      ...profile,
      sc_customer_group_name: profile.sc_customer_group_id
        ? groupName(profile.sc_customer_group_id) ?? client.sc_customer_group_name ?? null
        : null,
    }
    setClients((prev) => prev.map((c) => (c.id === client.id ? { ...c, ...patch } : c)))
    if (!data?.changed) return { changed: false, notice: null, pushed: false }
    if (!sellercloudId) return { changed: true, notice: { kind: 'warn', text: t('scProfileNotLinked') }, pushed: false }
    try {
      const res = await invokeSc({ action: 'update', client_id: client.id })
      // El mismo 'update' empuja la dirección (2026-09-14): se refleja en la
      // fila y, si falló, se suma al aviso — `pushed` le dice a saveEdit que
      // no hace falta mandarla aparte.
      applyAddressResult(client.id, res)
      const addrFail =
        res.address_status === 'failed' ? ` ${t('addressSyncFailed', { msg: res.address_error ?? '' })}` : ''
      return {
        changed: true,
        pushed: true,
        notice:
          res.warning || addrFail
            ? { kind: 'warn', text: `${res.warning ?? ''}${addrFail}`.trim() }
            : { kind: 'ok', text: t('scProfileSynced', { id: sellercloudId }) },
      }
    } catch (e) {
      return { changed: true, pushed: true, notice: { kind: 'warn', text: t('scProfileSyncFailed', { msg: e.message }) } }
    }
  }

  // Dirección (2026-09-14): su propia RPC (permisos + auditoría + la regla
  // "completa o vacía", y no se borra si ya está en SellerCloud). Devuelve si
  // cambió. Mandarla a SellerCloud es cosa del llamador: en la edición la
  // ficha y la dirección viajan juntas en UN 'update' (pushAddressSc si la
  // ficha no cambió).
  const saveAddress = async (client, form) => {
    const address = addressPayload(form)
    if (!addressChanged(address, addressPayload(addressForm(client)))) return { changed: false, address }
    const { data, error } = await supabase.rpc('update_client_address', {
      p_client_id: client.id,
      p_line1: address.address_line1,
      p_line2: address.address_line2,
      p_city: address.address_city,
      p_state: address.address_state,
      p_zip: address.address_zip,
      p_country: address.address_country,
    })
    if (error) throw error
    // Cambió lo local: lo de SellerCloud (si hay) quedó viejo hasta mandarla.
    setClients((prev) => prev.map((c) => (c.id === client.id ? { ...c, ...address, sc_address_synced_at: null } : c)))
    return { changed: !!data?.changed, address }
  }

  // Resultado de la dirección en una respuesta de la Edge Function ('create'
  // o 'update') → la fila: ok = ID + hora + sin error; failed = error (y sin
  // hora); skipped/ausente = no se toca.
  const applyAddressResult = (clientId, res) => {
    if (!res || res.address_status !== 'ok' && res.address_status !== 'failed') return
    const patch =
      res.address_status === 'ok'
        ? { sc_address_id: res.sc_address_id ?? null, sc_address_synced_at: new Date().toISOString(), sc_address_error: null }
        : { sc_address_synced_at: null, sc_address_error: res.address_error ?? null }
    setClients((prev) => prev.map((c) => (c.id === clientId ? { ...c, ...patch } : c)))
  }

  // Manda (o reintenta) la dirección de un cliente YA vinculado vía 'update'
  // de la Edge Function (PUT + relectura allá) y refleja el resultado en la
  // fila. Devuelve el aviso para el banner (null si no había nada que mandar).
  const [addressBusyId, setAddressBusyId] = useState(null)
  const pushAddressSc = async (client) => {
    setAddressBusyId(client.id)
    try {
      const res = await invokeSc({ action: 'update', client_id: client.id })
      applyAddressResult(client.id, res)
      if (res.address_status === 'ok') return { kind: 'ok', text: t('addressSynced', { id: client.sellercloud_id }) }
      if (res.address_status === 'failed') return { kind: 'warn', text: t('addressSyncFailed', { msg: res.address_error ?? '' }) }
      return null
    } catch (e) {
      return { kind: 'warn', text: t('addressSyncFailed', { msg: e.message }) }
    } finally {
      setAddressBusyId(null)
    }
  }

  // Panel SellerCloud (2026-09-02): buscar/vincular/crear el customer de un
  // cliente, vía la Edge Function sellercloud-customers (las credenciales de
  // la API nunca tocan el navegador; el permiso real vive en la RPC
  // link_sellercloud_customer — admin cualquiera, vendedora sus clientes).
  // Un solo panel a la vez:
  // { client: {id, name, phone, email}, status: 'searching' | 'candidates' |
  //   'creating' | 'linking' | 'createForm' | 'done' | 'failed',
  //   candidates, message, afterCreate, first, last }
  const [scPanel, setScPanel] = useState(null)

  // Vista completa (2026-09-09, a pedido del usuario: "un botón de expandir
  // que cambie a una vista tipo tabla donde se puedan ver todas las columnas
  // con todos los campos registrados"). La compacta es la de siempre; la
  // completa suma Empresa, Correo, Grupo, Account manager, Salesman,
  // Comentarios y Alta. Se recuerda por navegador.
  const [fullView, setFullView] = useState(() => {
    try {
      return localStorage.getItem('zimaxx_clients_view') === 'full'
    } catch {
      return false
    }
  })
  const toggleView = () =>
    setFullView((v) => {
      const next = !v
      try {
        localStorage.setItem('zimaxx_clients_view', next ? 'full' : 'compact')
      } catch {
        /* sin storage: solo esta sesión */
      }
      return next
    })

  // Aviso tras guardar la ficha: 'ok' (SellerCloud actualizado) o 'warn'
  // (guardado acá, pero allá no — el detalle dice qué cargar a mano).
  const [actionNotice, setActionNotice] = useState(null)

  // Cuadro scrolleable de la tabla (2026-09-09, ajuste a pedido del usuario:
  // "cuando se expande la tabla no hay manera de scrollear a los lados"). Con
  // 13 columnas la tabla es más ancha que el main (max-w-6xl) y la barra
  // horizontal del overflow-x-auto quedaba al PIE de una tabla de cientos de
  // filas: fuera de pantalla, y la rueda del mouse no desplaza a los lados.
  // En vista completa el cuadro tiene alto acotado con su propio scroll
  // vertical (las dos barras quedan a la vista), el encabezado y la columna
  // Nombre son sticky, y hay botones ◀ ▶ que lo desplazan de a 320 px.
  const scrollBoxRef = useRef(null)
  const scrollTable = (dir) => scrollBoxRef.current?.scrollBy({ left: dir * 320, behavior: 'smooth' })
  // Alto del cuadro = desde donde empieza hasta el fondo de la ventana (menos
  // el pie con el conteo). Un `100vh - Xrem` fijo no sirve: lo que hay arriba
  // (form de alta abierto, carga por Excel, avisos) cambia y el borde inferior
  // — con la barra horizontal — caía debajo del pliegue. Se mide en cada
  // render (un getBoundingClientRect) y solo se re-renderiza si cambió.
  const [boxTop, setBoxTop] = useState(0)
  useEffect(() => {
    if (!fullView) return
    const measure = () => {
      const el = scrollBoxRef.current
      if (!el) return
      const top = Math.round(el.getBoundingClientRect().top + window.scrollY)
      setBoxTop((prev) => (Math.abs(prev - top) > 1 ? top : prev))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  })

  // supabase.functions.invoke devuelve un mensaje genérico ante un no-2xx: el
  // motivo real que arma la función viene en el cuerpo (mismo caso que
  // sellercloud-push-order en OrdersAdmin).
  const invokeSc = async (body) => {
    const { data, error } = await supabase.functions.invoke('sellercloud-customers', { body })
    if (error) {
      let message = error.message
      try {
        const detail = await error.context?.json?.()
        if (detail?.error) message = detail.error
      } catch {
        /* se queda el genérico */
      }
      throw new Error(message)
    }
    if (data?.error) throw new Error(data.error)
    return data
  }

  // Pieza 3: desde la fila de un cliente sin vínculo — busca candidatos por
  // email/teléfono (y nombre si no hay nada) y deja elegir o crear.
  const openScPanel = async (client) => {
    setScPanel({ client, status: 'searching', candidates: [], afterCreate: false })
    try {
      const data = await invokeSc({
        action: 'search',
        email: client.email,
        phone: client.phone,
        name: client.name,
      })
      setScPanel((p) =>
        p?.client.id === client.id
          ? { ...p, status: 'candidates', candidates: data.candidates ?? [] }
          : p,
      )
    } catch (e) {
      setScPanel((p) => (p?.client.id === client.id ? { ...p, status: 'failed', message: e.message } : p))
    }
  }

  // Vincular al candidato elegido: la Edge Function verifica que el ID exista
  // allá y la RPC audita ('link_sellercloud_customer'). El cliente viaja por
  // parámetro (no desde scPanel) para poder llamarse recién seteado el panel,
  // antes de que React aplique el estado.
  const linkSc = async (client, candidate) => {
    setScPanel((p) => ({ ...p, status: 'linking' }))
    try {
      const data = await invokeSc({
        action: 'link',
        client_id: client.id,
        sellercloud_id: candidate.id,
      })
      setClients((prev) =>
        prev.map((c) => (c.id === client.id ? { ...c, sellercloud_id: data.sellercloud_id } : c)),
      )
      setScPanel((p) => ({
        ...p,
        status: 'done',
        message: t('scLinkedMsg', { id: data.sellercloud_id }),
      }))
    } catch (e) {
      setScPanel((p) => ({ ...p, status: 'candidates', message: e.message }))
    }
  }

  // Crear el customer allá (con nombre/apellido) y vincular. `force` = el
  // humano ya vio los candidatos (o la búsqueda no encontró nada) y decidió
  // crear igual — la Edge Function sin force busca antes de crear. `email`
  // (2026-09-03): el form del panel tiene su propio campo de correo — si no
  // viene, se usa el guardado del cliente.
  const createSc = async (client, { first, last, email, force }) => {
    if (!SC_CREATE_ENABLED) {
      // Candado del hotfix 2026-09-09: la UI ya no ofrece crear; esto es por
      // si algún camino viejo llega igual. El cliente local no se toca.
      setScPanel((p) => ({ ...p, status: 'failed', message: t('scCreateDisabled') }))
      return
    }
    setScPanel((p) => ({ ...p, status: 'creating', message: null }))
    try {
      const data = await invokeSc({
        action: 'create',
        client_id: client.id,
        first_name: first,
        last_name: last,
        email: email ?? client.email,
        phone: client.phone,
        force,
      })
      if (data.exists) {
        // Solo pasa sin force: hay candidatos — decisión humana explícita.
        setScPanel((p) => ({
          ...p,
          status: 'candidates',
          candidates: data.candidates ?? [],
          first,
          last,
        }))
        return
      }
      const scId = data.sellercloud_id
      // Dirección (2026-09-14): la función la manda tras el create y la
      // verifica releyendo; su resultado viene aparte (address_status). Un
      // fallo NO es un warning más: queda en rojo con "Reintentar" — el
      // customer existe y está vinculado, pero no puede recibir órdenes.
      const addrPatch =
        data.address_status === 'ok'
          ? { sc_address_id: data.sc_address_id ?? null, sc_address_synced_at: new Date().toISOString(), sc_address_error: null }
          : data.address_status === 'failed'
            ? { sc_address_synced_at: null, sc_address_error: data.address_error ?? null }
            : {}
      setClients((prev) => prev.map((c) => (c.id === client.id ? { ...c, sellercloud_id: scId, ...addrPatch } : c)))
      setScPanel((p) => ({
        ...p,
        status: 'done',
        message: `${t('scCreatedMsg', { id: scId })}${data.warning ? ` ${data.warning}` : ''}`,
        addressError:
          data.address_status === 'failed' ? t('addressCreateFailed', { id: scId, msg: data.address_error ?? '' }) : null,
      }))
    } catch (e) {
      // El cliente LOCAL ya existe y no se toca: SellerCloud nunca bloquea lo
      // local. El fallo además quedó en system_logs (sellercloud_customers).
      setScPanel((p) => ({
        ...p,
        status: 'failed',
        message: `${p.afterCreate ? `${t('scCreateFailed')} ` : ''}${e.message}`,
      }))
    }
  }

  // Búsqueda y filtros
  const [query, setQuery] = useState('')
  const [listFilter, setListFilter] = useState('')
  const [repFilter, setRepFilter] = useState('')
  // Con/sin correo (2026-09-08): '' | 'has' | 'missing'. Ver los chips junto
  // a los filtros y el comentario de `base` más abajo.
  const [emailFilter, setEmailFilter] = useState('')
  // Correo desplegable por fila (2026-09-08, segunda iteración a pedido del
  // usuario): mostrarlo en línea bajo el teléfono ensanchaba la columna y
  // empujaba la de acciones fuera de la vista ("Eliminar quedaba cortado").
  // Ahora una flechita junto al teléfono abre una fila debajo con el correo
  // y un botón Copiar. Varias filas pueden estar abiertas a la vez (Set).
  const [emailOpen, setEmailOpen] = useState(() => new Set())
  const [copiedEmailId, setCopiedEmailId] = useState(null)
  const [visibleRows, sentinelRef] = useInfiniteRows(100, [query, listFilter, repFilter, emailFilter])

  const load = async () => {
    try {
      const [cs, pls, vs] = await Promise.all([
        fetchAll('clients', '*, vendedores(name, phone)', ['name', 'id']),
        // Las dueñas vienen embebidas (2026-08-04): una lista puede tener
        // varias (compartida), así que ya no alcanza una columna —
        // price_list_owners es la fuente de verdad. RLS ya filtra las listas
        // que esta vendedora no puede usar.
        fetchAll('price_lists', '*, price_list_owners(vendedora_id, is_primary)'),
        fetchAll('vendedores', '*', ['name', 'id']),
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

  // Universo tras buscador + lista + vendedora, ANTES del filtro de correo:
  // sobre esto se cuentan "con correo / sin correo" (2026-09-08), así los
  // chips dicen cuántos de los que se están mirando tienen correo cargado.
  const base = useMemo(() => {
    const q = query.trim()
    // Mismo criterio que la bandeja de Pedidos (2026-08-12, ver
    // utils/search.js): por términos, no por subcadena contigua. Acá importa
    // igual — si el cliente no se encuentra en Clientes, tampoco se puede
    // revisar su lista de precio ni su vendedora para explicar un pedido.
    const terms = searchTerms(q)
    const qDigits = q.replace(/\D/g, '')
    return clients.filter((c) => {
      if (listFilter && c.price_list_id !== listFilter) return false
      if (repFilter && c.vendedora_id !== repFilter) return false
      if (terms.length === 0) return true
      // El email entra en la búsqueda por términos (2026-08-31) y el ID de
      // SellerCloud en la búsqueda por dígitos — así "¿de quién es la orden
      // del cliente 51234 en SellerCloud?" se responde desde acá.
      return (
        matchesTerms(
          terms,
          c.name,
          c.vendedores?.name,
          c.email,
          // Ficha SellerCloud (2026-09-09): empresa, grupo, salesman y
          // comentarios también se buscan ("¿quiénes son Zimaxx Box?").
          c.business_name,
          c.sc_customer_group_name,
          c.sc_salesman,
          c.sc_comments,
        ) ||
        (qDigits &&
          (cleanPhone(c.phone).includes(qDigits) ||
            String(c.sellercloud_id ?? '').includes(qDigits)))
      )
    })
  }, [clients, query, listFilter, repFilter])

  const withEmailCount = useMemo(() => base.filter((c) => !!c.email).length, [base])
  const filtered = useMemo(() => {
    if (emailFilter === 'has') return base.filter((c) => !!c.email)
    if (emailFilter === 'missing') return base.filter((c) => !c.email)
    return base
  }, [base, emailFilter])

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

        // Lista con dueña (ej. 'luzmar'): pisa lo que traiga el archivo,
        // aunque la columna Vendedora diga otra cosa — un cliente con esos
        // precios no puede quedar con una vendedora que no sea dueña. Si la
        // lista es compartida y el archivo nombra a una de las dueñas, esa
        // se respeta (mismo criterio que el trigger de la base).
        const forcedOwner = ownerFor(listId, vendedoraId)
        if (forcedOwner !== undefined) vendedoraId = forcedOwner

        // Igual que vendedora_id: solo se toca si el archivo trae el dato —
        // re-subir un export sin columna de correo no borra el guardado.
        const email = resolveEmail(row)

        const existing = byPhone.get(phoneKey(phone))
        if (existing) {
          const { error } = await supabase
            .from('clients')
            .update({
              name,
              price_list_id: listId,
              ...(vendedoraId !== undefined ? { vendedora_id: vendedoraId } : {}),
              ...(email !== undefined ? { email } : {}),
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
              email: email ?? null,
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
          if (insertedRows?.[0]) {
            byPhone.set(phoneKey(phone), insertedRows[0])
            // Mismo rastro que el alta individual (via 'excel'): el Excel de
            // clientes no carga ficha SellerCloud, así que esos campos van
            // vacíos. Uno por cliente CREADO (los actualizados no).
            logClientCreated(insertedRows[0], {
              via: 'excel',
              sellercloud_requested: false,
              file: file.name,
            })
          }
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
    // Con "Crear también en SellerCloud" el nombre viene PARTIDO (SellerCloud
    // exige apellido para las órdenes) y el name local se compone de ambos.
    const scOn = SC_CREATE_ENABLED && !!newClientForm.scCreate
    const first = newClientForm.firstName.trim()
    const last = newClientForm.lastName.trim()
    const name = scOn ? `${first} ${last}`.trim() : newClientForm.name.trim()
    const phone = cleanPhone(newClientForm.phone)
    const email = newClientForm.email.trim().toLowerCase()
    if (scOn && (!first || !last)) return
    if (!name || phone.length < 7 || !newClientForm.price_list_id) return
    if (email && !EMAIL_RE.test(email)) {
      setNewClientError(t('invalidEmail'))
      return
    }
    // Dirección (2026-09-14): obligatoria y completa solo cuando se crea en
    // SellerCloud (decisión del usuario); con el toggle apagado puede ir
    // vacía o completa, nunca a medias (la RPC y la función la rechazan igual).
    const address = addressPayload(newClientForm)
    const missingAddr = addressMissing(address)
    if ((scOn || !addressIsEmpty(address)) && missingAddr.length) {
      const labels = addressFieldLabels(t)
      setNewClientError(t('addressIncomplete', { fields: missingAddr.map((k) => labels[k]).join(', ') }))
      return
    }
    // El unique constraint de la base compara el string completo: no
    // pesca un duplicado si el existente está guardado con código de
    // país y este nuevo no (o viceversa). Se chequea acá antes de
    // insertar, comparando por los últimos 10 dígitos.
    if (clients.some((c) => phoneKey(c.phone) === phoneKey(phone))) {
      setNewClientError(t('phoneInUse'))
      return
    }
    setNewClientBusy(true)
    // Elegida en el form (admin) o ella misma (vendedora); si la lista tiene
    // dueñas, ownerFor la valida/corrige igual que el trigger.
    const chosen = isAdmin ? newClientForm.vendedora_id || null : myVendedoraId
    const forced = ownerFor(newClientForm.price_list_id, chosen)
    const vendedoraId = forced !== undefined ? forced : chosen
    // Ficha SellerCloud (2026-09-09): va en el mismo insert (RLS: admin
    // cualquiera, vendedora la suya); la Edge Function la lee de la fila.
    const profile = profilePayload(newClientForm)
    const profileRow = {
      ...profile,
      sc_customer_group_name: profile.sc_customer_group_id ? groupName(profile.sc_customer_group_id) : null,
    }
    // .select('id'): el alta en SellerCloud necesita el id local recién
    // creado. Si el insert falla, nada viaja a SellerCloud.
    const { data: created, error } = await supabase
      .from('clients')
      .insert({
        name,
        phone,
        email: email || null,
        token: generateToken(),
        price_list_id: newClientForm.price_list_id,
        vendedora_id: vendedoraId ?? null,
        ...profileRow,
        ...address,
      })
      .select('id')
      .single()
    if (error) {
      setNewClientError(error.code === '23505' ? t('phoneInUse') : error.message)
      setNewClientBusy(false)
      return
    }
    logClientCreated(
      {
        id: created.id,
        name,
        phone,
        email: email || null,
        price_list_id: newClientForm.price_list_id,
        vendedora_id: vendedoraId ?? null,
        ...profileRow,
        ...address,
      },
      { via: 'panel', sellercloud_requested: scOn, address: addressSummary(address) || null },
    )
    setNewClientForm(null)
    await load()
    setNewClientBusy(false)
    // El cliente LOCAL ya quedó creado pase lo que pase de acá en más:
    // SellerCloud nunca bloquea lo local. La Edge Function busca antes de
    // crear — si el cliente parece existir allá, el panel muestra los
    // candidatos y la decisión (vincular / crear igual) es humana.
    if (scOn) {
      const clientRow = { id: created.id, name, phone, email: email || null, ...profileRow, ...address }
      setScPanel({
        client: clientRow,
        status: 'creating',
        candidates: [],
        afterCreate: true,
        first,
        last,
      })
      createSc(clientRow, { first, last, force: false })
    }
  }

  const copyLink = async (c) => {
    const url = `${window.location.origin}/?c=${c.token}`
    await navigator.clipboard.writeText(url)
    setCopiedId(c.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const toggleEmail = (id) =>
    setEmailOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Mismo gesto que copyLink: feedback "✓ Copiado" 1.5 s en el propio botón.
  const copyEmail = async (c) => {
    if (!c.email) return
    await navigator.clipboard.writeText(c.email)
    setCopiedEmailId(c.id)
    setTimeout(() => setCopiedEmailId(null), 1500)
  }

  // Listas con dueña (ej. 'luzmar', 2026-07-09; varias dueñas desde
  // 2026-08-04): un cliente con esa lista SIEMPRE tiene que quedar asignado
  // a UNA de sus dueñas — evita que precios especiales negociados por ellas
  // terminen en la cuenta de otra vendedora. Espejo exacto del trigger
  // clients_enforce_owner_vendedora; la garantía real está en la base.
  const listOwners = (listId) =>
    (priceLists.find((l) => l.id === listId)?.price_list_owners ?? []).map((o) => o.vendedora_id)

  // Dueña principal: la que se asigna cuando la vendedora que viene no es
  // dueña (mismo criterio que price_list_primary_owner en SQL).
  const primaryOwner = (listId) => {
    const owners = priceLists.find((l) => l.id === listId)?.price_list_owners ?? []
    if (owners.length === 0) return null
    return (owners.find((o) => o.is_primary) ?? owners[0]).vendedora_id
  }

  // Vendedora final para un cliente en esta lista: si la elegida ya es
  // dueña se respeta (así se reparten los clientes de una lista compartida);
  // si no, cae en la principal. Devuelve undefined si la lista no tiene
  // dueñas (o sea: decide quien carga el cliente).
  const ownerFor = (listId, vendedoraId) => {
    const owners = listOwners(listId)
    if (owners.length === 0) return undefined
    return owners.includes(vendedoraId) ? vendedoraId : primaryOwner(listId)
  }

  // Una vendedora sin rol admin no elige a quién asignar (siempre se
  // asigna a sí misma, ver RLS vendedora_insert_own_clients): si además
  // no ve las listas con dueña ajenas, ni por error puede armar un
  // cliente que termine con precios especiales ajenos asignado a ella.
  // Admin sí ve todas — el candado de vendedora se maneja en el form.
  const selectablePriceLists = isAdmin
    ? priceLists
    : priceLists.filter((l) => {
        const owners = listOwners(l.id)
        return owners.length === 0 || owners.includes(myVendedoraId)
      })

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
    // Reflejar lo que hizo el trigger: si la lista nueva tiene dueñas y la
    // vendedora actual del cliente no es una, quedó con la principal. Se
    // parchea también el nombre embebido (`vendedores`), que es lo que
    // muestra la tabla — si no, la columna quedaba con el nombre viejo hasta
    // la próxima recarga.
    const forced = ownerFor(listId, client.vendedora_id)
    const patch = { price_list_id: listId }
    if (forced !== undefined && forced !== client.vendedora_id) {
      patch.vendedora_id = forced
      const v = vendedoresList.find((x) => x.id === forced)
      patch.vendedores = v ? { name: v.name, phone: v.phone } : null
    }
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

  const startEdit = (client) => {
    setActionError('')
    setActionNotice(null)
    setEditForm({
      clientId: client.id,
      name: client.name,
      phone: client.phone,
      email: client.email ?? '',
      scid: client.sellercloud_id == null ? '' : String(client.sellercloud_id),
      // Ficha SellerCloud (2026-09-09): se edita en una fila desplegada bajo
      // el cliente, en las dos vistas. Dirección (2026-09-14): ídem.
      ...profileForm(client),
      ...addressForm(client),
    })
  }

  // Enter guarda, Escape cancela — mismo gesto que el teléfono editable
  // de la pestaña Vendedoras.
  const editKeys = (e) => {
    if (e.key === 'Enter') saveEdit()
    if (e.key === 'Escape') setEditForm(null)
  }

  // El botón Guardar ya se deshabilita con datos inválidos; las
  // validaciones de acá abajo las repite la RPC server-side (con los
  // mensajes en español que muestra el banner). Los duplicados se chequean
  // antes — teléfono por los últimos 10 dígitos (misma regla que el índice
  // único de la base y que el alta, phoneKey) y SellerCloud ID exacto — para
  // dar el mensaje amigable en el idioma del panel en vez del error crudo.
  const saveEdit = async () => {
    setActionError('')
    const client = clients.find((c) => c.id === editForm.clientId)
    const name = editForm.name.trim()
    const phone = cleanPhone(editForm.phone)
    if (!client || !name || phone.length < 7) return
    if (
      !client.allow_shared_phone &&
      clients.some((c) => c.id !== client.id && phoneKey(c.phone) === phoneKey(phone))
    ) {
      setActionError(t('phoneInUse'))
      return
    }
    // Correo (2026-09-08): mismo chequeo laxo que el alta; se guarda en
    // minúsculas; vacío = sin correo.
    const email = editForm.email.trim().toLowerCase()
    if (email && !EMAIL_RE.test(email)) {
      setActionError(t('invalidEmail'))
      return
    }
    // Dirección (2026-09-14): completa o vacía, nunca a medias (la RPC
    // repite la regla; acá va el mensaje amigable en el idioma del panel).
    const addressNew = addressPayload(editForm)
    const missingAddr = addressMissing(addressNew)
    if (!addressIsEmpty(addressNew) && missingAddr.length) {
      const labels = addressFieldLabels(t)
      setActionError(t('addressIncomplete', { fields: missingAddr.map((k) => labels[k]).join(', ') }))
      return
    }
    // Vínculo SellerCloud: solo admin (la vendedora ni ve el input, así que
    // para ella `scidChanged` es siempre false y no se llama a la RPC).
    const scid = editForm.scid.trim() === '' ? null : Number(editForm.scid)
    const scidChanged = isAdmin && scid !== (client.sellercloud_id ?? null)
    if (scidChanged && scid != null && clients.some((c) => c.id !== client.id && c.sellercloud_id === scid)) {
      setActionError(t('sellercloudIdInUse'))
      return
    }
    setEditBusy(true)
    const { error } = await supabase.rpc('update_client_info', {
      p_client_id: client.id,
      p_name: name,
      p_phone: phone,
      p_email: email || null,
    })
    if (error) {
      setEditBusy(false)
      setActionError(error.message)
      return
    }
    if (scidChanged) {
      const { error: scidError } = await supabase.rpc('set_client_sellercloud_id', {
        p_client_id: client.id,
        p_sellercloud_id: scid,
      })
      if (scidError) {
        // Nombre/teléfono YA quedaron guardados: se reflejan igual, y la
        // edición queda abierta con el error del vínculo en el banner.
        setEditBusy(false)
        setClients((prev) =>
          prev.map((c) => (c.id === client.id ? { ...c, name, phone, email: email || null } : c))
        )
        setActionError(scidError.message)
        return
      }
    }
    // Reflejar el cambio sin recargar todo (mismo criterio que updateList):
    // las RPC guardan exactamente esto (nombre trimmeado, teléfono en
    // dígitos).
    setClients((prev) =>
      prev.map((c) =>
        c.id === client.id
          ? {
              ...c,
              name,
              phone,
              email: email || null,
              ...(scidChanged ? { sellercloud_id: scid } : {}),
            }
          : c
      )
    )
    // Ficha SellerCloud (2026-09-09): su propia RPC (audita solo lo que
    // cambió) y, si el cliente está vinculado, la Edge Function la empuja a
    // SellerCloud. Si la RPC falla, nombre/teléfono/correo ya quedaron
    // guardados (reflejados arriba) y la edición sigue abierta con el error.
    try {
      const scIdNow = scidChanged ? scid : client.sellercloud_id
      // Dirección primero (2026-09-14): si la RPC la rechaza (incompleta,
      // borrar una que ya está en SellerCloud) no se toca la ficha.
      const addr = await saveAddress(client, editForm)
      const { notice, pushed } = await saveProfile(client, editForm, scIdNow)
      let finalNotice = notice
      if (addr.changed && !pushed && scIdNow && !addressIsEmpty(addr.address)) {
        // La ficha no cambió, así que nadie empujó nada: la dirección viaja
        // sola en su propio 'update'.
        finalNotice = (await pushAddressSc({ ...client, sellercloud_id: scIdNow })) ?? finalNotice
      }
      setActionNotice(finalNotice)
    } catch (e) {
      setEditBusy(false)
      setActionError(e.message)
      return
    }
    setEditBusy(false)
    setEditForm(null)
  }

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

  // Columnas de la tabla según la vista (los colSpan de las filas
  // desplegadas — correo, panel SellerCloud, edición de la ficha — usan esto).
  // Desde 2026-09-10 el teléfono va DEBAJO del nombre en la misma celda (a
  // pedido del usuario), así que la columna Tel ya no existe. Desde
  // 2026-09-14 la completa suma Dirección y Dir. SellerCloud: 5 / 14.
  const colCount = fullView ? 14 : 5
  // Vista completa: la columna Nombre queda fija al desplazar a los lados
  // (fondo sólido para tapar lo que pasa por debajo) y el contenido de las
  // filas desplegadas (ficha en edición, panel SellerCloud) se queda a la
  // vista en vez de irse con el scroll: sticky a la izquierda y acotado al
  // ancho del cuadro (el main es max-w-6xl = 72rem con padding).
  const stickyCol = fullView ? 'sticky left-0 z-10 bg-surface' : ''
  const expandedCls = fullView ? 'sticky left-0 max-w-[calc(min(100vw,72rem)-2.5rem)]' : ''

  const fmtDate = (iso) => {
    if (!iso) return '—'
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(lang === 'en' ? 'en-US' : 'es-VE')
  }

  // Estado de la dirección en SellerCloud de un cliente VINCULADO
  // (2026-09-14). Cuatro casos: cargada y verificada (✓); sin sincronizar
  // (hay dirección local completa pero no se mandó, o cambió después →
  // "Enviar dirección"); falló ("Reintentar", con el motivo en el tooltip); y
  // sin dirección local (aviso: Editar → Dirección — sus órdenes rebotan si
  // tampoco la tiene allá). Quien ve la fila puede mandarla (la RPC valida).
  const addressBadge = (c) => {
    const complete = addressMissing(addressPayload(c)).length === 0
    const busy = addressBusyId === c.id
    const send = async (e) => {
      e.stopPropagation()
      setActionError('')
      setActionNotice(await pushAddressSc(c))
    }
    const btnCls = (color) =>
      `rounded-lg border px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50 border-${color}-400 text-${color}-700 hover:bg-${color}-50 dark:text-${color}-400 dark:hover:bg-${color}-950/40`
    if (c.sc_address_error) {
      return (
        <span className="flex flex-wrap items-center gap-1" data-testid="address-badge-failed">
          <span
            title={t('addressScFailedHint', { msg: c.sc_address_error })}
            className="whitespace-nowrap text-[11px] font-semibold text-red-700 dark:text-red-400"
          >
            ⚠️ {t('addressScFailed')}
          </span>
          {complete && (
            <button onClick={send} disabled={busy} className={btnCls('red')}>
              {busy ? t('addressSending') : t('addressRetryBtn')}
            </button>
          )}
        </span>
      )
    }
    if (c.sc_address_synced_at) {
      return (
        <span
          title={t('addressScSyncedHint', { id: c.sc_address_id ?? '—' })}
          className="whitespace-nowrap text-[11px] font-semibold text-green-700 dark:text-green-400"
          data-testid="address-badge-synced"
        >
          {t('addressScSynced')}
        </span>
      )
    }
    if (complete) {
      return (
        <span className="flex flex-wrap items-center gap-1" data-testid="address-badge-pending">
          <span
            title={t('addressScPendingHint')}
            className="whitespace-nowrap text-[11px] font-semibold text-amber-700 dark:text-amber-400"
          >
            ⏳ {t('addressScPending')}
          </span>
          <button onClick={send} disabled={busy} className={btnCls('amber')}>
            {busy ? t('addressSending') : t('addressSendBtn')}
          </button>
        </span>
      )
    }
    return (
      <span
        title={t('addressScNoneHint')}
        className="whitespace-nowrap text-[11px] text-primary/40"
        data-testid="address-badge-none"
      >
        📍 {t('addressScNone')}
      </span>
    )
  }

  // Los cinco inputs de la ficha SellerCloud, compartidos por el alta, la
  // fila de edición y el form "Crear en SellerCloud" del panel. `form` trae
  // las PROFILE_KEYS como strings; `onChange(patch)` recibe el cambio; `row`
  // es la fila del cliente (para conservar un grupo/account manager que ya
  // no esté en ninguna vendedora); `onKeyDown` solo en la edición (Enter
  // guarda, Escape cancela — dentro de un <form> Enter ya envía).
  const profileFields = (form, onChange, row, onKeyDown) => {
    const amCur = String(form.sc_account_manager_id ?? '')
    const amOptions =
      !amCur || accountManagerOptions.some((a) => String(a.id) === amCur)
        ? accountManagerOptions
        : [...accountManagerOptions, { id: Number(amCur), name: `#${amCur}` }]
    return (
      <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-5" data-testid="sc-profile-fields">
        <label className="min-w-0 text-[11px] text-primary/50">
          {t('businessName')}
          <input
            value={form.business_name}
            onChange={(e) => onChange({ business_name: e.target.value })}
            onKeyDown={onKeyDown}
            placeholder={t('businessName')}
            className={`${profileInputCls} mt-0.5`}
          />
        </label>
        <label className="min-w-0 text-[11px] text-primary/50">
          {t('scGroup')}
          <select
            value={form.sc_customer_group_id}
            onChange={(e) => onChange({ sc_customer_group_id: e.target.value })}
            onKeyDown={onKeyDown}
            className={`${profileInputCls} mt-0.5`}
          >
            <option value="">{t('scGroupNone')}</option>
            {groupOptionsFor(form, row).map((g) => (
              <option key={g.id} value={String(g.id)}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 text-[11px] text-primary/50">
          {t('scAccountManager')}
          <select
            value={form.sc_account_manager_id}
            onChange={(e) => onChange({ sc_account_manager_id: e.target.value })}
            onKeyDown={onKeyDown}
            className={`${profileInputCls} mt-0.5`}
          >
            <option value="">{t('scAccountManagerNone')}</option>
            {amOptions.map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 text-[11px] text-primary/50">
          {t('scSalesman')}
          <input
            list="sc-salesman-options"
            value={form.sc_salesman}
            onChange={(e) => onChange({ sc_salesman: e.target.value })}
            onKeyDown={onKeyDown}
            placeholder={t('scSalesman')}
            className={`${profileInputCls} mt-0.5`}
          />
        </label>
        <label className="min-w-0 text-[11px] text-primary/50">
          {t('scComments')}
          <input
            list="sc-comments-options"
            value={form.sc_comments}
            onChange={(e) => onChange({ sc_comments: e.target.value })}
            onKeyDown={onKeyDown}
            placeholder={t('scComments')}
            className={`${profileInputCls} mt-0.5`}
          />
        </label>
      </div>
    )
  }

  // Ficha propuesta para un cliente EXISTENTE que se va a crear en SellerCloud
  // desde su fila: lo guardado, y donde no haya nada, lo de su vendedora y su
  // lista (mismo prellenado que el alta).
  const profileWithDefaults = (row) => {
    const base = profileForm(row)
    const fromV = profileFromVendedora(row.vendedora_id)
    return {
      business_name: base.business_name,
      sc_customer_group_id: base.sc_customer_group_id || fromV.sc_customer_group_id,
      sc_account_manager_id: base.sc_account_manager_id || fromV.sc_account_manager_id,
      sc_salesman: base.sc_salesman || fromV.sc_salesman,
      sc_comments: base.sc_comments || commentsForListCode(listCode(row.price_list_id)),
    }
  }

  // Panel SellerCloud (2026-09-02; inline desde 2026-09-03 a pedido del
  // usuario): un solo panel para los dos caminos — el alta con "Crear también
  // en SellerCloud" (afterCreate) y el botón "Buscar en SellerCloud" de la
  // fila. Se dibuja DENTRO de la tabla, como fila expandida bajo el cliente
  // (mismo gesto que el detalle de un pedido en la bandeja); si esa fila no
  // está a la vista (filtros, scroll infinito), cae al bloque de arriba de la
  // tabla para no desaparecer en medio de un alta. Los candidatos vienen de
  // la API real (email → teléfono → nombre) y la decisión de vincular o crear
  // es siempre humana.
  const scPanelInline =
    scPanel && filtered.slice(0, visibleRows).some((c) => c.id === scPanel.client.id)
  const scPanelBox = scPanel && (
    <div className="animate-fade-up space-y-3 rounded-2xl border border-indigo-300 bg-indigo-50/50 p-4 dark:border-indigo-800 dark:bg-indigo-950/30">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-indigo-800 dark:text-indigo-300">
          📦 SellerCloud — {scPanel.client.name}
        </p>
        <button
          onClick={() => setScPanel(null)}
          className="rounded-lg border border-line px-3 py-1 text-xs text-primary/60 transition-colors hover:border-primary/40"
        >
          {t('scCloseBtn')}
        </button>
      </div>

      {scPanel.status === 'searching' && <p className="text-sm text-primary/60">{t('scSearching')}</p>}
      {scPanel.status === 'creating' && <p className="text-sm text-primary/60">{t('scCreating')}</p>}
      {scPanel.status === 'linking' && <p className="text-sm text-primary/60">{t('scLinking')}</p>}

      {scPanel.status === 'done' && (
        <p className="rounded-xl bg-green-100 p-3 text-sm font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
          ✓ {scPanel.message}
        </p>
      )}
      {/* Dirección que no entró tras el create (2026-09-14): en rojo y con
          reintento, aparte del ✓ — el customer existe pero no sirve para
          órdenes hasta que la dirección esté allá. */}
      {scPanel.status === 'done' && scPanel.addressError && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl bg-red-100 p-3 text-sm font-medium text-red-800 dark:bg-red-900/40 dark:text-red-200"
          data-testid="sc-address-error"
        >
          <span className="min-w-0 flex-1 select-text break-words">⚠️ {scPanel.addressError}</span>
          <button
            onClick={async () => {
              const row = clients.find((x) => x.id === scPanel.client.id) ?? scPanel.client
              const notice = await pushAddressSc(row)
              setScPanel((p) =>
                p ? { ...p, addressError: notice?.kind === 'ok' ? null : (notice?.text ?? p.addressError) } : p,
              )
            }}
            disabled={addressBusyId === scPanel.client.id}
            className="rounded-lg border border-red-400 px-3 py-1 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-950/40"
          >
            {addressBusyId === scPanel.client.id ? t('addressSending') : t('addressRetryBtn')}
          </button>
        </div>
      )}
      {scPanel.status === 'failed' && (
        <p className="max-h-32 select-text overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-amber-100 p-3 text-sm font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
          ⚠️ {scPanel.message}
        </p>
      )}

      {scPanel.status === 'candidates' && (
        <>
          <p className="text-sm text-primary/70">
            {scPanel.candidates.length > 0 ? (
              <>
                <span className="font-semibold">{t('scLooksExisting')}</span>{' '}
                {SC_CREATE_ENABLED ? t('scPickToLink') : t('scPickToLinkOnly')}
              </>
            ) : (
              t('scNoCandidates')
            )}
          </p>
          {scPanel.message && (
            <p className="text-xs font-medium text-red-600 dark:text-red-400">{scPanel.message}</p>
          )}
          {scPanel.candidates.length > 0 && (
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {scPanel.candidates.map((cand) => (
                <li key={cand.id} className="flex flex-wrap items-center justify-between gap-2 p-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-semibold">{cand.name}</span>
                    <span className="ml-2 font-mono text-xs text-primary/50">#{cand.id}</span>
                    <span className="block text-xs text-primary/50">
                      {[cand.email, cand.phone, cand.business].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </span>
                  <button
                    onClick={() => linkSc(scPanel.client, cand)}
                    className="rounded-lg bg-ink px-3 py-1.5 text-xs font-bold text-secondary transition-opacity hover:opacity-90"
                  >
                    {t('scLinkBtn')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!SC_CREATE_ENABLED ? (
            // Hotfix 2026-09-09: sin alta, el panel solo busca y vincula.
            <p className="text-xs text-primary/50">{t('scCreateDisabled')}</p>
          ) : scPanel.afterCreate ? (
            // Vino del alta: nombre y apellido ya están — crear igual es un
            // solo click, explícito.
            <button
              onClick={() => createSc(scPanel.client, { first: scPanel.first, last: scPanel.last, force: true })}
              className="rounded-lg border border-indigo-400 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
            >
              {scPanel.candidates.length > 0 ? t('scCreateAnyway') : t('scCreateHere')}
            </button>
          ) : (
            <button
              onClick={() => {
                // Prefill partiendo el nombre local: última palabra →
                // apellido (mismo criterio que customerDetails).
                const parts = scPanel.client.name.trim().split(/\s+/)
                setScPanel((p) => ({
                  ...p,
                  status: 'createForm',
                  first: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] ?? '',
                  last: parts.length > 1 ? parts[parts.length - 1] : '',
                  emailField: p.client.email ?? '',
                  // Ficha (2026-09-09): lo guardado, y si no hay nada, lo de
                  // su vendedora y su lista — igual que el alta.
                  profile: profileWithDefaults(p.client),
                  // Dirección (2026-09-14): lo guardado, y el país por la
                  // lista si no hay. Obligatoria para crear.
                  address: {
                    ...addressForm(p.client),
                    address_country:
                      p.client.address_country || defaultCountryForList(listCode(p.client.price_list_id)),
                  },
                }))
              }}
              className="rounded-lg border border-indigo-400 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
            >
              {t('scCreateHere')}
            </button>
          )}
        </>
      )}

      {scPanel.status === 'createForm' && (
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            const first = scPanel.first.trim()
            const last = scPanel.last.trim()
            const email = (scPanel.emailField ?? '').trim().toLowerCase()
            if (!first || !last) return
            if (email && !EMAIL_RE.test(email)) {
              setScPanel((p) => ({ ...p, message: t('invalidEmail') }))
              return
            }
            // Dirección (2026-09-14): obligatoria para crear; se guarda en la
            // fila ANTES (la Edge Function la lee de ahí y la exige completa
            // — sin ella responde 400 y no crea nada).
            const addr = addressPayload(scPanel.address ?? {})
            const missingAddr = addressMissing(addr)
            if (missingAddr.length) {
              const labels = addressFieldLabels(t)
              setScPanel((p) => ({
                ...p,
                message: t('addressIncomplete', { fields: missingAddr.map((k) => labels[k]).join(', ') }),
              }))
              return
            }
            try {
              await saveAddress(scPanel.client, scPanel.address)
            } catch (err) {
              setScPanel((p) => ({ ...p, message: err.message }))
              return
            }
            // La ficha se guarda en la fila ANTES de crear (la Edge Function
            // la lee de ahí); sin vínculo todavía, saveProfile no empuja nada
            // — el create lo hace. Si la RPC falla, no se crea nada allá.
            if (scPanel.profile) {
              try {
                await saveProfile(scPanel.client, scPanel.profile, null)
              } catch (err) {
                setScPanel((p) => ({ ...p, message: err.message }))
                return
              }
            }
            createSc(scPanel.client, { first, last, email: email || null, force: true })
          }}
          className="space-y-2"
          title={t('scLastNameHint')}
        >
          {scPanel.profile && (
            <div className="rounded-xl border border-indigo-200 bg-surface/60 p-2.5 dark:border-indigo-900">
              <p className="mb-1.5 text-[11px] font-bold text-indigo-800 dark:text-indigo-300">
                📦 {t('scProfileTitle')}
              </p>
              {profileFields(scPanel.profile, (patch) =>
                setScPanel((p) => ({ ...p, profile: { ...p.profile, ...patch } })), scPanel.client)}
            </div>
          )}
          {scPanel.address && (
            <div className="rounded-xl border border-indigo-200 bg-surface/60 p-2.5 dark:border-indigo-900">
              <p className="mb-1 text-[11px] font-bold text-indigo-800 dark:text-indigo-300">📍 {t('addressTitle')}</p>
              <p className="mb-1.5 text-[11px] text-primary/50">{t('addressRequiredHint')}</p>
              <AddressFields
                form={scPanel.address}
                onChange={(patch) => setScPanel((p) => ({ ...p, address: { ...p.address, ...patch } }))}
                required
                idPrefix="panel"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
          <input
            required
            placeholder={t('firstNameLabel')}
            value={scPanel.first}
            onChange={(e) => setScPanel((p) => ({ ...p, first: e.target.value }))}
            className="w-40 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none transition-colors focus:border-secondary"
          />
          <input
            required
            placeholder={t('lastNameLabel')}
            value={scPanel.last}
            onChange={(e) => setScPanel((p) => ({ ...p, last: e.target.value }))}
            className="w-40 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none transition-colors focus:border-secondary"
          />
          {/* Correo propio del panel (2026-09-03, a pedido del usuario):
              prellenado con el del cliente, editable — viaja al create de
              SellerCloud. Vacío = el customer entra sin email (la API no lo
              exige). */}
          <input
            type="email"
            placeholder={t('emailOptional')}
            value={scPanel.emailField ?? ''}
            onChange={(e) => setScPanel((p) => ({ ...p, emailField: e.target.value }))}
            className="w-52 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none transition-colors focus:border-secondary"
          />
          <button className="rounded-lg bg-ink px-3 py-1.5 text-xs font-bold text-secondary transition-opacity hover:opacity-90">
            {t('scCreateHere')}
          </button>
          <span className="text-xs text-primary/40">{t('scLastNameHint')}</span>
          {scPanel.message && (
            <span className="w-full text-xs font-medium text-red-600 dark:text-red-400">{scPanel.message}</span>
          )}
          </div>
        </form>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Sugerencias de los inputs de la ficha (datalist: texto libre con
          opciones). Salesman = nombres de las vendedoras; Comentarios = los
          valores que usa el negocio. */}
      <datalist id="sc-salesman-options">
        {vendedoresList.map((v) => (
          <option key={v.id} value={v.name} />
        ))}
      </datalist>
      <datalist id="sc-comments-options">
        {COMMENT_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-brand text-2xl font-semibold">
          {t('clients')}
          <span className="ml-2 text-base font-normal text-primary/40">{clients.length}</span>
        </h2>
        <div className="flex items-center gap-2">
          {/* Vista compacta ↔ completa (2026-09-09): la completa muestra
              todas las columnas registradas de cada cliente. */}
          <button
            onClick={toggleView}
            aria-pressed={fullView}
            title={t('viewFullHint')}
            className={`rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
              fullView
                ? 'border-secondary/60 bg-gold-pale/40 text-primary'
                : 'border-line text-primary/70 hover:border-primary/40'
            }`}
          >
            {fullView ? `⤡ ${t('viewCompact')}` : `⤢ ${t('viewFull')}`}
          </button>
          <button
            onClick={() => {
              setNewClientError('')
              // La vendedora arranca con su propia ficha (grupo, ella como
              // account manager, su nombre); el admin la ve al elegir vendedora.
              setNewClientForm({
                ...EMPTY_CLIENT,
                ...(isAdmin ? {} : profileFromVendedora(myVendedoraId)),
              })
            }}
            className="rounded-full bg-ink px-5 py-2 text-sm font-semibold text-secondary transition-colors hover:bg-ink-soft"
          >
            + {t('newClient')}
          </button>
        </div>
      </div>

      {newClientForm && (
        <form
          onSubmit={createClient}
          // grid-cols-1 explícito (2026-09-09): sin él la columna única de
          // móvil se dimensiona al min-content del hijo más ancho (la etiqueta
          // del toggle con su pista) y el form empujaba la página a scroll
          // horizontal a 390 px — pescado por Playwright, existía desde antes.
          className="grid grid-cols-1 animate-fade-up gap-3 rounded-2xl border border-secondary/40 bg-surface p-5 shadow-sm md:grid-cols-2"
        >
          {newClientForm.scCreate ? (
            // Con el alta en SellerCloud, el nombre va PARTIDO: allá el
            // apellido es obligatorio para poder facturar órdenes
            // ("Customer's last name is not valid"). El name local se compone
            // de ambos.
            <div className="flex gap-2" title={t('scLastNameHint')}>
              <input
                required
                placeholder={t('firstNameLabel')}
                value={newClientForm.firstName}
                onChange={(e) => setNewClientForm({ ...newClientForm, firstName: e.target.value })}
                className={`${inputCls} min-w-0 flex-1`}
              />
              <input
                required
                placeholder={t('lastNameLabel')}
                value={newClientForm.lastName}
                onChange={(e) => setNewClientForm({ ...newClientForm, lastName: e.target.value })}
                className={`${inputCls} min-w-0 flex-1`}
              />
            </div>
          ) : (
            <input
              required
              placeholder={t('name')}
              value={newClientForm.name}
              onChange={(e) => setNewClientForm({ ...newClientForm, name: e.target.value })}
              className={inputCls}
            />
          )}
          <input
            required
            placeholder={t('phone')}
            value={newClientForm.phone}
            onChange={(e) => setNewClientForm({ ...newClientForm, phone: e.target.value })}
            className={inputCls}
          />
          <input
            type="email"
            placeholder={t('emailOptional')}
            value={newClientForm.email}
            onChange={(e) => setNewClientForm({ ...newClientForm, email: e.target.value })}
            className={inputCls}
          />
          <select
            required
            value={newClientForm.price_list_id}
            onChange={(e) => {
              const listId = e.target.value
              // Al elegir una lista con dueñas, la vendedora del form se
              // preselecciona: la actual si ya es dueña, si no la principal.
              const forced = ownerFor(listId, newClientForm.vendedora_id)
              // Lista 'quote' = cliente de cotización, sin precios: el alta
              // en SellerCloud se apaga solo (se puede volver a prender).
              const isQuote = priceLists.find((l) => l.id === listId)?.code === 'quote'
              setNewClientForm({
                ...newClientForm,
                price_list_id: listId,
                ...(forced !== undefined ? { vendedora_id: forced } : {}),
                // Si la lista impuso otra vendedora, la ficha la sigue; y el
                // comentario se propone por la lista (Mayorista/Minorista/…)
                // salvo que haya un texto propio tipeado a mano.
                ...(forced !== undefined && forced !== newClientForm.vendedora_id
                  ? profileFromVendedora(forced)
                  : {}),
                ...autoComments(newClientForm.sc_comments, listId),
                ...(isQuote ? { scCreate: false } : {}),
                // País de la dirección propuesto por la lista (2026-09-14:
                // ve_* → VE, el resto → US) mientras no se haya elegido uno.
                ...(newClientForm.address_country
                  ? {}
                  : { address_country: defaultCountryForList(listCode(listId)) }),
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
            const owners = listOwners(newClientForm.price_list_id)
            // Una sola dueña: no hay nada que elegir (igual que antes).
            if (owners.length === 1) {
              return (
                <p className="flex items-center text-xs text-primary/50">
                  {t('assignedToOwner')} <span className="ml-1 font-semibold text-primary/70">{vendedoresList.find((v) => v.id === owners[0])?.name}</span>
                </p>
              )
            }
            // Lista compartida (2026-08-04): el admin elige entre las dueñas;
            // una vendedora dueña se lo asigna a sí misma sin elegir.
            if (owners.length > 1) {
              return isAdmin ? (
                <label className="text-xs text-primary/50">
                  {t('sharedListOwners')}
                  <select
                    value={newClientForm.vendedora_id}
                    onChange={(e) =>
                      setNewClientForm({
                        ...newClientForm,
                        vendedora_id: e.target.value,
                        // La ficha se re-propone con la vendedora elegida.
                        ...profileFromVendedora(e.target.value),
                      })
                    }
                    className={`${inputCls} mt-1 w-full`}
                  >
                    {vendedoresList
                      .filter((v) => owners.includes(v.id))
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <p className="flex items-center text-xs text-primary/50">{t('assignedToYou')}</p>
              )
            }
            return isAdmin ? (
              <select
                value={newClientForm.vendedora_id}
                onChange={(e) =>
                      setNewClientForm({
                        ...newClientForm,
                        vendedora_id: e.target.value,
                        // La ficha se re-propone con la vendedora elegida.
                        ...profileFromVendedora(e.target.value),
                      })
                    }
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
          {/* Ficha SellerCloud (2026-09-09): con esto se registra el cliente
              allá. Prellenada por la vendedora y la lista; editable. Se
              guarda en la fila local aunque el toggle de SellerCloud esté
              apagado (queda lista para cuando se cree/vincule). */}
          <fieldset className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-900 dark:bg-indigo-950/20 md:col-span-2">
            <legend className="px-1 text-xs font-bold text-indigo-800 dark:text-indigo-300">
              📦 {t('scProfileTitle')}
            </legend>
            <p className="mb-2 text-[11px] text-primary/50">{t('scProfileHint')}</p>
            {profileFields(newClientForm, (patch) => setNewClientForm((f) => ({ ...f, ...patch })))}
          </fieldset>
          {/* Dirección (2026-09-14): UNA, envío = facturación. Obligatoria
              solo con "Crear también en SellerCloud" prendido (decisión del
              usuario); si no, puede quedar vacía — nunca a medias. El país se
              propone por la lista elegida. */}
          <fieldset
            className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-900 dark:bg-indigo-950/20 md:col-span-2"
            data-testid="new-client-address"
          >
            <legend className="px-1 text-xs font-bold text-indigo-800 dark:text-indigo-300">
              📍 {t('addressTitle')}
            </legend>
            <p className="mb-2 text-[11px] text-primary/50">
              {SC_CREATE_ENABLED && newClientForm.scCreate ? t('addressRequiredHint') : t('addressOptionalHint')}
            </p>
            <AddressFields
              form={newClientForm}
              onChange={(patch) => setNewClientForm((f) => ({ ...f, ...patch }))}
              required={SC_CREATE_ENABLED && !!newClientForm.scCreate}
              idPrefix="new"
            />
          </fieldset>
          <label
            className={`flex min-w-0 flex-wrap items-center gap-2 text-sm md:col-span-2 ${
              SC_CREATE_ENABLED ? 'cursor-pointer text-primary/70' : 'cursor-not-allowed text-primary/40'
            }`}
            title={SC_CREATE_ENABLED ? undefined : t('scCreateDisabled')}
          >
            <input
              type="checkbox"
              checked={SC_CREATE_ENABLED && newClientForm.scCreate}
              disabled={!SC_CREATE_ENABLED}
              onChange={(e) => {
                const on = e.target.checked
                // Al prender con un nombre ya tipeado, se parte para no
                // hacerlo escribir de nuevo: última palabra → apellido.
                let { firstName, lastName } = newClientForm
                if (on && !firstName && !lastName && newClientForm.name.trim()) {
                  const parts = newClientForm.name.trim().split(/\s+/)
                  lastName = parts.length > 1 ? parts[parts.length - 1] : ''
                  firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0]
                }
                setNewClientForm({ ...newClientForm, scCreate: on, firstName, lastName })
              }}
              className="h-4 w-4 accent-secondary"
            />
            📦 {t('scCreateToggle')}
            <span className="text-xs text-primary/40">
              — {SC_CREATE_ENABLED ? t('scCreateToggleHint') : t('scCreateDisabled')}
            </span>
          </label>
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

      {/* El panel SellerCloud vive como fila expandida dentro de la tabla
          (ver scPanelBox arriba); acá solo cae si la fila del cliente no está
          a la vista — sin esto, un alta con filtros puestos dejaría el flujo
          de creación corriendo en un panel invisible. */}
      {scPanel && !scPanelInline && scPanelBox}

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
        {/* Con/sin correo (2026-09-08, a pedido del usuario: "ver qué correos
            están asignados a cada cliente"). Los contadores van sobre lo que
            ya filtran buscador/lista/vendedora; el chip activo recorta la
            tabla. Así se responde sin volver a una columna casi vacía. */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEmailFilter(emailFilter === 'has' ? '' : 'has')}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              emailFilter === 'has'
                ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                : 'bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/50 dark:text-green-300 dark:hover:bg-green-900'
            }`}
          >
            ✉️ {withEmailCount} {t('withEmail')}
          </button>
          <button
            onClick={() => setEmailFilter(emailFilter === 'missing' ? '' : 'missing')}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              emailFilter === 'missing'
                ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                : 'bg-primary/10 text-primary/60 hover:bg-primary/15'
            }`}
          >
            {base.length - withEmailCount} {t('withoutEmail')}
          </button>
        </div>
      </div>

      {actionError && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
          {actionError}
        </div>
      )}
      {/* Resultado de sincronizar la ficha con SellerCloud tras Guardar
          (2026-09-09): verde si entró, ámbar si quedó solo acá. */}
      {actionNotice && (
        <div
          role="status"
          className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm ${
            actionNotice.kind === 'ok'
              ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300'
              : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
          }`}
        >
          <span className="whitespace-pre-wrap break-words">
            {actionNotice.kind === 'ok' ? '✓ ' : '⚠️ '}
            {actionNotice.text}
          </span>
          <button
            onClick={() => setActionNotice(null)}
            aria-label={t('scCloseBtn')}
            className="shrink-0 rounded-md px-1.5 text-xs opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}

      {fullView && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-primary/50">
          <span>{t('scrollSidewaysHint')}</span>
          <span className="flex gap-1">
            <button
              type="button"
              onClick={() => scrollTable(-1)}
              aria-label={t('scrollLeft')}
              title={t('scrollLeft')}
              className="rounded-lg border border-line px-3 py-1 font-bold text-primary/70 transition-colors hover:border-primary/40 hover:bg-gold-pale/40"
            >
              ◀
            </button>
            <button
              type="button"
              onClick={() => scrollTable(1)}
              aria-label={t('scrollRight')}
              title={t('scrollRight')}
              className="rounded-lg border border-line px-3 py-1 font-bold text-primary/70 transition-colors hover:border-primary/40 hover:bg-gold-pale/40"
            >
              ▶
            </button>
          </span>
        </div>
      )}
      <div className="rounded-2xl border border-line bg-surface shadow-sm">
        {/* El cuadro que scrollea (ver scrollBoxRef). En compacta solo a los
            lados, como siempre; en completa también alto acotado. El pie con
            el conteo queda AFUERA para verse siempre. */}
        <div
          ref={scrollBoxRef}
          data-testid="clients-scroll-box"
          className={`overflow-x-auto rounded-t-2xl ${fullView ? 'overflow-y-auto' : ''}`}
          // 56 px = el pie con el conteo + margen; mínimo 240 px para que en
          // una ventana chica siga habiendo tabla que ver.
          style={fullView ? { maxHeight: `max(240px, calc(100vh - ${boxTop + 56}px))` } : undefined}
        >
        <table className="w-full text-sm">
          {/* Sticky top en completa: con border-collapse el borde inferior no
              acompaña al thead, se dibuja con una sombra de 1 px. */}
          <thead className={fullView ? 'sticky top-0 z-20 bg-surface shadow-[0_1px_0_0_var(--color-line)]' : ''}>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-primary/45">
              <th className={`p-3 ${stickyCol}`}>{t('name')}</th>
              {fullView && <th className="p-3">{t('businessName')}</th>}
              {fullView && <th className="p-3">{t('email')}</th>}
              <th className="p-3">SellerCloud</th>
              {fullView && <th className="p-3">{t('scGroup')}</th>}
              {fullView && <th className="p-3">{t('scAccountManager')}</th>}
              {fullView && <th className="p-3">{t('scSalesman')}</th>}
              {fullView && <th className="p-3">{t('scComments')}</th>}
              {fullView && <th className="p-3">{t('addressCol')}</th>}
              {fullView && <th className="p-3">{t('addressScCol')}</th>}
              <th className="p-3">Lista</th>
              <th className="p-3">Vendedora</th>
              {fullView && <th className="p-3">{t('createdAtCol')}</th>}
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, visibleRows).map((c) => (
              <Fragment key={c.id}>
              <tr className="border-b border-line/60 transition-colors hover:bg-gold-pale/20">
                {/* Nombre + teléfono en UNA celda (2026-09-10, a pedido del
                    usuario: "quita la columna de teléfono y haz que salga
                    debajo del nombre"). El teléfono va en mono chico bajo el
                    nombre. La flechita ✉️ del correo (2026-09-08) sigue
                    pegada al teléfono y solo en la compacta — en la completa
                    el correo tiene columna propia. Al editar, los tres inputs
                    (nombre, teléfono, correo) van apilados acá mismo; vacío en
                    correo = sin correo. */}
                <td className={`p-3 font-medium ${stickyCol}`}>
                  {editForm?.clientId === c.id ? (
                    <div className="flex flex-col gap-1">
                      <input
                        autoFocus
                        value={editForm.name}
                        onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        onKeyDown={editKeys}
                        className="w-44 rounded-lg border border-secondary/60 bg-surface px-2 py-1 text-xs font-normal outline-none transition-colors focus:border-secondary"
                      />
                      <input
                        inputMode="tel"
                        value={editForm.phone}
                        onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                        onKeyDown={editKeys}
                        className="w-44 rounded-lg border border-secondary/60 bg-surface px-2 py-1 font-mono text-xs font-normal outline-none transition-colors focus:border-secondary"
                      />
                      <input
                        type="email"
                        placeholder={t('emailOptional')}
                        value={editForm.email}
                        onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                        onKeyDown={editKeys}
                        className="w-44 rounded-lg border border-secondary/60 bg-surface px-2 py-1 font-mono text-xs font-normal outline-none transition-colors focus:border-secondary"
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      <span>{c.name}</span>
                      <span className="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs font-normal text-primary/60">
                        {c.phone}
                        {c.email && !fullView && (
                          <button
                            onClick={() => toggleEmail(c.id)}
                            aria-expanded={emailOpen.has(c.id)}
                            aria-label={t(emailOpen.has(c.id) ? 'hideEmail' : 'showEmail')}
                            title={t(emailOpen.has(c.id) ? 'hideEmail' : 'showEmail')}
                            className="rounded-md px-1 text-[11px] leading-none text-primary/50 transition-colors hover:bg-gold-pale/60 hover:text-primary"
                          >
                            ✉️ {emailOpen.has(c.id) ? '▴' : '▾'}
                          </button>
                        )}
                      </span>
                    </div>
                  )}
                </td>
                {fullView && (
                  <td className="p-3 text-xs text-primary/70">
                    {c.business_name || <span className="text-primary/30">—</span>}
                  </td>
                )}
                {fullView && (
                  <td className="p-3 font-mono text-xs text-primary/60">
                    {c.email ? (
                      <span className="select-all">{c.email}</span>
                    ) : (
                      <span className="text-primary/30">—</span>
                    )}
                  </td>
                )}
                {/* Vínculo SellerCloud con columna propia (2026-09-01,
                    reemplazó a la de Email, que nunca tuvo datos): un cliente
                    sin ID no puede mandar pedidos allá. Editable solo por
                    admin — set_client_sellercloud_id igual lo exige
                    server-side. Vacío = quitar el vínculo. */}
                <td className="p-3 font-mono text-xs text-primary/60">
                  {editForm?.clientId === c.id && isAdmin ? (
                    <input
                      inputMode="numeric"
                      placeholder="SellerCloud ID"
                      value={editForm.scid}
                      onChange={(e) =>
                        setEditForm({ ...editForm, scid: e.target.value.replace(/\D/g, '') })
                      }
                      onKeyDown={editKeys}
                      className="w-32 rounded-lg border border-secondary/60 bg-surface px-2 py-1 font-mono text-xs outline-none transition-colors focus:border-secondary"
                    />
                  ) : c.sellercloud_id ? (
                    // Vinculado: el ID y, debajo, el estado de su dirección
                    // en SellerCloud (2026-09-14) — sin dirección allá el
                    // push de sus órdenes rebota.
                    <div className="flex flex-col items-start gap-1">
                      <span>{c.sellercloud_id}</span>
                      {addressBadge(c)}
                    </div>
                  ) : (
                    (
                      // Pieza 3 (2026-09-02): sin vínculo no se pueden enviar
                      // órdenes — aviso + búsqueda guiada. Lo ven admin Y
                      // vendedora (el permiso real vive en la RPC de link).
                      <div className="flex flex-col items-start gap-1">
                        <span
                          title={t('scNoIdHint')}
                          className="text-[11px] font-semibold text-amber-700 dark:text-amber-400"
                        >
                          ⚠️ {t('scNoId')}
                        </span>
                        <button
                          onClick={() => openScPanel(c)}
                          className="whitespace-nowrap rounded-lg border border-indigo-400 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 transition-colors hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                        >
                          🔍 {t('scFind')}
                        </button>
                      </div>
                    )
                  )}
                </td>
                {/* Ficha SellerCloud en la vista completa (2026-09-09). Solo
                    texto: se edita en la fila desplegada al tocar Editar. */}
                {fullView && (
                  <td className="p-3 text-xs text-primary/70">
                    {c.sc_customer_group_id != null ? (
                      <span title={`#${c.sc_customer_group_id}`}>
                        {c.sc_customer_group_name || `#${c.sc_customer_group_id}`}
                      </span>
                    ) : (
                      <span className="text-primary/30">—</span>
                    )}
                  </td>
                )}
                {fullView && (
                  <td className="p-3 text-xs text-primary/70">
                    {c.sc_account_manager_id != null ? (
                      <span className="whitespace-nowrap">
                        {accountManagerName(c.sc_account_manager_id) ?? ''}
                        <span className="ml-1 font-mono text-[10px] text-primary/40">#{c.sc_account_manager_id}</span>
                      </span>
                    ) : (
                      <span className="text-primary/30">—</span>
                    )}
                  </td>
                )}
                {fullView && (
                  <td className="p-3 text-xs text-primary/70">
                    {c.sc_salesman || <span className="text-primary/30">—</span>}
                  </td>
                )}
                {fullView && (
                  <td className="p-3 text-xs text-primary/70">
                    {c.sc_comments || <span className="text-primary/30">—</span>}
                  </td>
                )}
                {/* Dirección (2026-09-14) y su estado en SellerCloud, solo
                    en la completa; se edita en la fila desplegada. */}
                {fullView && (
                  <td className="p-3 text-xs text-primary/70" data-testid="address-cell">
                    {addressSummary(c) || <span className="text-primary/30">—</span>}
                  </td>
                )}
                {fullView && (
                  <td className="p-3 text-xs text-primary/70">
                    {c.sellercloud_id ? addressBadge(c) : <span className="text-primary/30">—</span>}
                  </td>
                )}
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
                  {/* Lista sin dueñas: se reasigna a cualquiera. Lista
                      compartida (2+ dueñas): solo entre ellas — es lo que
                      permite repartir sus clientes, y reassign_client rechaza
                      el resto server-side. Con una sola dueña no hay nada que
                      elegir, queda texto fijo. */}
                  {isAdmin && listOwners(c.price_list_id).length !== 1 ? (
                    <select
                      value={c.vendedora_id ?? ''}
                      onChange={(e) => reassignClient(c, e.target.value)}
                      className="w-40 rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none transition-colors focus:border-secondary"
                      title={t('reassign')}
                    >
                      {listOwners(c.price_list_id).length === 0 && (
                        <option value="">{t('unassigned')}</option>
                      )}
                      {(listOwners(c.price_list_id).length > 0
                        ? vendedoresList.filter((v) => listOwners(c.price_list_id).includes(v.id))
                        : vendedoresList
                      ).map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    c.vendedores?.name || (isAdmin ? t('unassigned') : '')
                  )}
                </td>
                {fullView && (
                  <td className="whitespace-nowrap p-3 font-mono text-xs text-primary/50">{fmtDate(c.created_at)}</td>
                )}
                {/* whitespace-nowrap (2026-09-08): que los botones nunca se
                    partan en dos líneas ni se recorten; si no entra, la tabla
                    scrollea (overflow-x-auto del contenedor). */}
                <td className="whitespace-nowrap p-3">
                  <div className="flex items-center justify-end gap-2">
                    {editForm?.clientId === c.id ? (
                      <>
                        <button
                          onClick={saveEdit}
                          disabled={
                            editBusy ||
                            !editForm.name.trim() ||
                            cleanPhone(editForm.phone).length < 7
                          }
                          className="rounded-full bg-secondary px-3.5 py-1.5 text-xs font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-50"
                        >
                          {t('save')}
                        </button>
                        <button
                          onClick={() => setEditForm(null)}
                          className="rounded-full border border-line px-3.5 py-1.5 text-xs font-semibold text-primary/60 transition-colors hover:border-primary/40"
                        >
                          {t('cancel')}
                        </button>
                      </>
                    ) : (
                      <>
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
                        {/* Editar nombre/teléfono (2026-08-25): visible también
                            para vendedora — solo ve sus propios clientes, y la
                            RPC igual valida server-side que sean suyos. */}
                        <button
                          onClick={() => startEdit(c)}
                          className="rounded-full px-3 py-1.5 text-xs font-semibold text-primary/60 transition-colors hover:bg-gold-pale/60"
                        >
                          {t('edit')}
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
                      </>
                    )}
                  </div>
                </td>
              </tr>
              {/* Ficha SellerCloud en edición (2026-09-09): fila desplegada
                  bajo el cliente con los cinco campos, en las dos vistas.
                  Nombre/teléfono/correo/ID siguen en línea como siempre;
                  Guardar/Cancelar son los de la fila. */}
              {editForm?.clientId === c.id && (
                <tr className="border-b border-line/60 bg-indigo-50/30 dark:bg-indigo-950/20" data-testid="sc-profile-edit-row">
                  <td colSpan={colCount} className="px-3 py-2.5">
                    <div className={expandedCls}>
                      <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
                        <span className="text-xs font-bold text-indigo-800 dark:text-indigo-300">
                          📦 {t('scProfileTitle')}
                        </span>
                        <span className="text-[11px] text-primary/45">{t('scGroupChangeHint')}</span>
                      </div>
                      {profileFields(editForm, (patch) => setEditForm((f) => ({ ...f, ...patch })), c, editKeys)}
                      {/* Dirección (2026-09-14): completa o vacía; si el
                          cliente ya está vinculado, al guardar viaja a
                          SellerCloud en el mismo 'update' de la ficha. */}
                      <div className="mt-2.5 mb-1.5 flex flex-wrap items-baseline gap-2">
                        <span className="text-xs font-bold text-indigo-800 dark:text-indigo-300">
                          📍 {t('addressTitle')}
                        </span>
                        <span className="text-[11px] text-primary/45">
                          {c.sellercloud_id ? t('addressRequiredHint') : t('addressOptionalHint')}
                        </span>
                      </div>
                      <AddressFields
                        form={editForm}
                        onChange={(patch) => setEditForm((f) => ({ ...f, ...patch }))}
                        onKeyDown={editKeys}
                        idPrefix={`edit-${c.id}`}
                      />
                    </div>
                  </td>
                </tr>
              )}
              {/* Correo desplegado (2026-09-08): fila propia debajo del
                  cliente, mismo gesto que el panel SellerCloud. Solo existe
                  si el cliente tiene correo (sin correo no hay flechita). En
                  la vista completa el correo ya tiene columna. */}
              {!fullView && c.email && emailOpen.has(c.id) && (
                <tr className="border-b border-line/60 bg-gold-pale/15">
                  <td colSpan={colCount} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-primary/50">✉️ {t('email')}:</span>
                      <span className="select-all font-mono text-primary/80">{c.email}</span>
                      <button
                        onClick={() => copyEmail(c)}
                        className={`rounded-full px-3 py-1 font-semibold transition-all ${
                          copiedEmailId === c.id
                            ? 'bg-green-100 text-green-800'
                            : 'bg-secondary/15 text-secondary-dark hover:bg-secondary/30'
                        }`}
                      >
                        {copiedEmailId === c.id ? `✓ ${t('copied')}` : t('copyEmail')}
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              {/* Panel SellerCloud como fila expandida (2026-09-03): la
                  búsqueda, los candidatos y el alta se despliegan DEBAJO del
                  cliente, mismo gesto que el detalle de un pedido en la
                  bandeja. */}
              {scPanel?.client.id === c.id && (
                <tr className="border-b border-line/60 bg-indigo-50/30 dark:bg-indigo-950/20">
                  <td colSpan={colCount} className="p-3">
                    <div className={expandedCls}>{scPanelBox}</div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {filtered.length > visibleRows && (
          <div ref={sentinelRef} className="py-4 text-center text-xs text-primary/40">
            {t('loading')}
          </div>
        )}
        </div>
        <div className="border-t border-line px-4 py-2.5 text-xs text-primary/50">
          {filtered.length} {t('results')}
        </div>
      </div>
    </div>
  )
}
