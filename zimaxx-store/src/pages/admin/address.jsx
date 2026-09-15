// Dirección del cliente (2026-09-14, a pedido del usuario: "es muy importante
// que el cliente se guarde con el address correcto, y que ese campo no llegue
// vacío"). UNA dirección por cliente, que en SellerCloud vale como envío y
// facturación; obligatoria solo cuando el cliente se crea allá. Estado
// obligatorio para todos los países. Las columnas viven en `clients`
// (migration-2026-09-14-client-address.sql), la edición pasa por la RPC
// auditada update_client_address, y la Edge Function sellercloud-customers la
// manda con PUT /Customers/{id}/Addresses y la verifica releyendo.
//
// Este archivo comparte los helpers y el bloque de inputs entre el alta de
// Clientes, la fila de edición, el form "Crear en SellerCloud" del panel y
// el modal "Cargar dirección y reenviar" de Pedidos.
import { useI18n } from '../../i18n'
import { COUNTRIES, statesFor } from '../../utils/countries'

export const ADDRESS_KEYS = [
  'address_line1',
  'address_line2',
  'address_city',
  'address_state',
  'address_zip',
  'address_country',
]

// Lo que SellerCloud exige (calle, ciudad, código postal, país) más el
// estado, que el usuario decidió obligatorio para todos.
export const ADDRESS_REQUIRED = ['address_line1', 'address_city', 'address_state', 'address_zip', 'address_country']

// Form (strings) → shape de la fila / la RPC (null = vacío). País en
// mayúsculas; estado de US en mayúsculas si son dos letras (fl → FL).
export function addressPayload(form) {
  const txt = (v) => String(v ?? '').trim() || null
  const country = (txt(form?.address_country) ?? '').toUpperCase() || null
  let state = txt(form?.address_state)
  if (state && country === 'US' && /^[A-Za-z]{2}$/.test(state)) state = state.toUpperCase()
  return {
    address_line1: txt(form?.address_line1),
    address_line2: txt(form?.address_line2),
    address_city: txt(form?.address_city),
    address_state: state,
    address_zip: txt(form?.address_zip),
    address_country: country,
  }
}

// Fila → valores de form ('' = vacío).
export function addressForm(row) {
  const out = {}
  for (const k of ADDRESS_KEYS) out[k] = row?.[k] ?? ''
  return out
}

export const addressChanged = (a, b) => ADDRESS_KEYS.some((k) => (a[k] ?? null) !== (b[k] ?? null))

// Claves obligatorias que faltan en un payload. Vacío = completa.
export function addressMissing(payload) {
  return ADDRESS_REQUIRED.filter((k) => !payload?.[k])
}

export const addressIsEmpty = (payload) => ADDRESS_KEYS.every((k) => !payload?.[k])
export const addressIsComplete = (payload) => addressMissing(payload).length === 0

// "123 NW 1st St, Suite 4, Miami, FL 33101, US" — para la tabla, los logs y
// los modales. Con una fila sin dirección devuelve ''.
export function addressSummary(row) {
  if (!row) return ''
  const line = [row.address_line1, row.address_line2].filter(Boolean).join(', ')
  const cityState = [row.address_city, [row.address_state, row.address_zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ')
  return [line, cityState, row.address_country].filter(Boolean).join(', ')
}

// "8323 NW 12th St, Doral, FL 33126, US" — SIN la segunda línea: es lo que
// se muestra bajo el ID de SellerCloud cuando la dirección ya está verificada
// allá (2026-09-14, pedido del usuario: ver la dirección, no un texto que
// diga que está). La completa va en el tooltip.
export function addressShort(row) {
  if (!row) return ''
  const cityState = [row.address_city, [row.address_state, row.address_zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ')
  return [row.address_line1, cityState, row.address_country].filter(Boolean).join(', ')
}

const inputCls =
  'w-full min-w-0 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none transition-colors placeholder:text-primary/35 focus:border-secondary'

// Nombre legible de cada clave obligatoria, para el mensaje "falta: ...".
export function addressFieldLabels(t) {
  return {
    address_line1: t('addressLine1'),
    address_line2: t('addressLine2'),
    address_city: t('addressCity'),
    address_state: t('addressState'),
    address_zip: t('addressZip'),
    address_country: t('addressCountry'),
  }
}

// Los seis inputs. `form` trae las ADDRESS_KEYS como strings; `onChange(patch)`
// recibe el cambio; `required` marca los obligatorios con * (y `required` en
// el input, que dentro de un <form> corta el submit); `onKeyDown` para la
// fila de edición (Enter guarda, Escape cancela). `idPrefix` separa los
// <datalist> cuando hay dos bloques en pantalla (alta + edición).
export function AddressFields({ form, onChange, onKeyDown, required = false, idPrefix = 'addr' }) {
  const { t, lang } = useI18n()
  const country = String(form.address_country ?? '').toUpperCase()
  const states = statesFor(country)
  const listId = `${idPrefix}-states-${country || 'none'}`
  const label = (key) => (
    <>
      {t(key)}
      {required && <span className="text-red-500"> *</span>}
    </>
  )
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="address-fields">
      <label className="min-w-0 text-[11px] text-primary/50 lg:col-span-2">
        {label('addressLine1')}
        <input
          value={form.address_line1}
          onChange={(e) => onChange({ address_line1: e.target.value })}
          onKeyDown={onKeyDown}
          required={required}
          placeholder={t('addressLine1Placeholder')}
          autoComplete="address-line1"
          className={`${inputCls} mt-0.5`}
          data-testid="address-line1"
        />
      </label>
      <label className="min-w-0 text-[11px] text-primary/50 lg:col-span-2">
        {t('addressLine2')}
        <input
          value={form.address_line2}
          onChange={(e) => onChange({ address_line2: e.target.value })}
          onKeyDown={onKeyDown}
          placeholder={t('addressLine2Placeholder')}
          autoComplete="address-line2"
          className={`${inputCls} mt-0.5`}
          data-testid="address-line2"
        />
      </label>
      <label className="min-w-0 text-[11px] text-primary/50">
        {label('addressCity')}
        <input
          value={form.address_city}
          onChange={(e) => onChange({ address_city: e.target.value })}
          onKeyDown={onKeyDown}
          required={required}
          placeholder={t('addressCity')}
          autoComplete="address-level2"
          className={`${inputCls} mt-0.5`}
          data-testid="address-city"
        />
      </label>
      <label className="min-w-0 text-[11px] text-primary/50">
        {label('addressState')}
        <input
          list={states.length ? listId : undefined}
          value={form.address_state}
          onChange={(e) => onChange({ address_state: e.target.value })}
          onKeyDown={onKeyDown}
          required={required}
          placeholder={country === 'US' ? 'FL' : t('addressState')}
          autoComplete="address-level1"
          className={`${inputCls} mt-0.5`}
          data-testid="address-state"
        />
        {states.length > 0 && (
          <datalist id={listId}>
            {states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </datalist>
        )}
      </label>
      <label className="min-w-0 text-[11px] text-primary/50">
        {label('addressZip')}
        <input
          value={form.address_zip}
          onChange={(e) => onChange({ address_zip: e.target.value })}
          onKeyDown={onKeyDown}
          required={required}
          placeholder={country === 'US' ? '33101' : t('addressZip')}
          autoComplete="postal-code"
          className={`${inputCls} mt-0.5`}
          data-testid="address-zip"
        />
      </label>
      <label className="min-w-0 text-[11px] text-primary/50">
        {label('addressCountry')}
        <select
          value={country}
          onChange={(e) => onChange({ address_country: e.target.value })}
          onKeyDown={onKeyDown}
          required={required}
          autoComplete="country"
          className={`${inputCls} mt-0.5`}
          data-testid="address-country"
        >
          <option value="">{t('addressCountryPick')}</option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c[lang === 'en' ? 'en' : 'es']} ({c.code})
            </option>
          ))}
          {country && !COUNTRIES.some((c) => c.code === country) && <option value={country}>{country}</option>}
        </select>
      </label>
    </div>
  )
}
