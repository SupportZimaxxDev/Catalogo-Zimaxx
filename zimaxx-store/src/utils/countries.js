// Países y estados para la dirección del cliente (2026-09-14). La dirección
// viaja a SellerCloud con `Country` como código ISO-2 (US, VE...) y `State`
// como texto; para US el código de dos letras. La lista de países es la del
// negocio (mayorista de fragancias en Miami con clientes en toda América
// Latina), no la del mundo entero: si hace falta otro, se agrega acá.
//
// Los estados de US y Venezuela van como sugerencias (<datalist>) del campo
// Estado, que es texto libre y obligatorio para TODOS los países (decisión
// del usuario): en Venezuela el estado existe igual (Miranda, Zulia...) y en
// SellerCloud queda como texto.

export const COUNTRIES = [
  { code: 'US', es: 'Estados Unidos', en: 'United States' },
  { code: 'VE', es: 'Venezuela', en: 'Venezuela' },
  { code: 'MX', es: 'México', en: 'Mexico' },
  { code: 'CO', es: 'Colombia', en: 'Colombia' },
  { code: 'PA', es: 'Panamá', en: 'Panama' },
  { code: 'DO', es: 'República Dominicana', en: 'Dominican Republic' },
  { code: 'EC', es: 'Ecuador', en: 'Ecuador' },
  { code: 'PE', es: 'Perú', en: 'Peru' },
  { code: 'CL', es: 'Chile', en: 'Chile' },
  { code: 'AR', es: 'Argentina', en: 'Argentina' },
  { code: 'BR', es: 'Brasil', en: 'Brazil' },
  { code: 'GT', es: 'Guatemala', en: 'Guatemala' },
  { code: 'HN', es: 'Honduras', en: 'Honduras' },
  { code: 'SV', es: 'El Salvador', en: 'El Salvador' },
  { code: 'NI', es: 'Nicaragua', en: 'Nicaragua' },
  { code: 'CR', es: 'Costa Rica', en: 'Costa Rica' },
  { code: 'BO', es: 'Bolivia', en: 'Bolivia' },
  { code: 'PY', es: 'Paraguay', en: 'Paraguay' },
  { code: 'UY', es: 'Uruguay', en: 'Uruguay' },
  { code: 'TT', es: 'Trinidad y Tobago', en: 'Trinidad and Tobago' },
  { code: 'AW', es: 'Aruba', en: 'Aruba' },
  { code: 'CW', es: 'Curazao', en: 'Curaçao' },
  { code: 'CA', es: 'Canadá', en: 'Canada' },
  { code: 'ES', es: 'España', en: 'Spain' },
]

export function countryName(code, lang = 'es') {
  const c = COUNTRIES.find((x) => x.code === code)
  return c ? c[lang === 'en' ? 'en' : 'es'] : code || ''
}

// País propuesto según la lista de precio del cliente: las listas `ve_*`
// son de clientes facturados en Venezuela; el resto (us_*, special, luzmar,
// quote...) es Estados Unidos, aunque el cliente esté en otro país — se
// cambia en el selector.
export function defaultCountryForList(code) {
  return String(code ?? '').startsWith('ve_') ? 'VE' : 'US'
}

// Estados de US (50 + DC + territorios que SellerCloud maneja como estado).
export const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ['PR', 'Puerto Rico'], ['VI', 'U.S. Virgin Islands'], ['GU', 'Guam'],
].map(([code, name]) => ({ code, name }))

// Estados de Venezuela (23 + Distrito Capital), por nombre.
export const VE_STATES = [
  'Amazonas', 'Anzoátegui', 'Apure', 'Aragua', 'Barinas', 'Bolívar', 'Carabobo', 'Cojedes',
  'Delta Amacuro', 'Distrito Capital', 'Falcón', 'Guárico', 'La Guaira', 'Lara', 'Mérida', 'Miranda',
  'Monagas', 'Nueva Esparta', 'Portuguesa', 'Sucre', 'Táchira', 'Trujillo', 'Yaracuy', 'Zulia',
].map((name) => ({ code: name, name }))

export function statesFor(country) {
  if (country === 'US') return US_STATES
  if (country === 'VE') return VE_STATES
  return []
}
