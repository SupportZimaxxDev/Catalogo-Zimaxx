// Tests del matching del backfill de sellercloud_id (matching.mjs) con casos
// sintéticos. Correr con `node tests/backfill-matching-tests.mjs`.
// Los tres buckets del resultado (matches/ambiguous/unmatched) son exactamente
// las filas de los tres CSVs del dry-run — probar el módulo ES probar el
// contenido de los CSVs; el runner solo los serializa.
import {
  matchClients,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  nameSimilarity,
} from '../scripts/backfill-sellercloud-ids/matching.mjs'

let passed = 0
let failed = 0
const ok = (cond, msg) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.log(`  ✗ ${msg}`)
  }
}

const client = (id, over = {}) => ({
  id: `c${id}`,
  name: `Cliente ${id}`,
  phone: null,
  email: null,
  allow_shared_phone: false,
  sellercloud_id: null,
  ...over,
})
const customer = (id, over = {}) => ({
  id,
  firstName: `Nombre${id}`,
  lastName: `Apellido${id}`,
  email: null,
  business: null,
  phone: null,
  ...over,
})

console.log('Normalización')
ok(normalizeEmail('  Juan@Mail.COM ') === 'juan@mail.com', 'email: minúsculas y trim')
ok(normalizeEmail('sin-arroba') === null, 'email: sin @ no es llave')
ok(normalizePhone('+1 (786) 555-0001') === '7865550001', 'teléfono: solo dígitos, últimos 10')
ok(normalizePhone('17865550001') === normalizePhone('7865550001'), 'teléfono: con y sin código de país dan la misma llave')
ok(normalizePhone('12345') === null, 'teléfono: menos de 7 dígitos no es llave')
ok(normalizeName('  José  PÉREZ ') === 'jose perez', 'nombre: sin acentos, minúsculas, espacios colapsados')
ok(normalizeName('J. Perez') === 'j perez', 'nombre: puntuación fuera')
ok(nameSimilarity('Perfumes Rosario', 'Perfumeria Rosario') > 0.55, 'similitud: parecidos puntúan alto')
ok(nameSimilarity('Juan Gomez', 'Zapateria El Clavo') < 0.2, 'similitud: distintos puntúan bajo')

console.log('Email gana a teléfono')
{
  // c1 comparte teléfono con el customer 20, pero su EMAIL apunta al 10:
  // matchea por email y el 20 queda libre para c2 por teléfono.
  const r = matchClients(
    [
      client(1, { email: 'a@x.com', phone: '7865550001' }),
      client(2, { phone: '7865550002' }),
    ],
    [
      customer(10, { email: 'a@x.com' }),
      customer(20, { phone: '7865550001' }),
      customer(30, { phone: '7865550002' }),
    ],
  )
  const m1 = r.matches.find((m) => m.client.id === 'c1')
  const m2 = r.matches.find((m) => m.client.id === 'c2')
  ok(m1?.customer.id === 10 && m1?.key === 'email', 'c1 matchea por email (10), no por teléfono')
  ok(m2?.customer.id === 30 && m2?.key === 'phone', 'c2 matchea por teléfono')
  ok(r.ambiguous.length === 0 && r.unmatched.length === 0, 'nada a revisión')
}

console.log('Teléfono compartido va a revisión')
{
  // Dos clients con el mismo teléfono (el caso allow_shared_phone del par):
  // ese teléfono no identifica — ambos a revisión, aunque el candidato exista.
  const r = matchClients(
    [
      client(1, { phone: '7865550009', allow_shared_phone: true }),
      client(2, { phone: '17865550009', allow_shared_phone: true }),
    ],
    [customer(10, { phone: '7865550009' })],
  )
  ok(r.matches.length === 0, 'sin matches automáticos')
  ok(r.ambiguous.length === 2 && r.ambiguous.every((a) => a.reason === 'teléfono compartido'),
    'los dos van a revisión con motivo "teléfono compartido"')
  ok(r.ambiguous[0].candidates.some((c) => c.customer.id === 10), 'con el candidato que chocó adentro')
}
{
  // allow_shared_phone incluso SIN duplicado local: tampoco es llave.
  const r = matchClients(
    [client(1, { phone: '7865550009', allow_shared_phone: true })],
    [customer(10, { phone: '7865550009' })],
  )
  ok(r.matches.length === 0 && r.ambiguous.length === 1, 'allow_shared_phone solo también va a revisión')
}

console.log('Nombre duplicado va a revisión')
{
  const r = matchClients(
    [client(1, { name: 'María López' })],
    [
      customer(10, { firstName: 'Maria', lastName: 'Lopez' }),
      customer(20, { firstName: 'MARIA', lastName: 'lópez' }),
    ],
  )
  ok(r.matches.length === 0 && r.ambiguous.length === 1, 'dos customers con el mismo nombre → revisión')
  ok(r.ambiguous[0].candidates.length >= 2, 'con ambos candidatos listados')
}
{
  // Nombre único de ambos lados, con acentos/mayúsculas distintas: automático.
  const r = matchClients(
    [client(1, { name: 'María  López' })],
    [customer(10, { firstName: 'maria', lastName: 'LOPEZ' }), customer(20, { firstName: 'Otro', lastName: 'Cliente' })],
  )
  ok(r.matches.length === 1 && r.matches[0].customer.id === 10 && r.matches[0].key === 'name',
    'nombre único normalizado matchea automático')
}

console.log('Colisión cruzada: un customer para dos clients')
{
  const r = matchClients(
    [client(1, { email: 'dup@x.com' }), client(2, { email: 'dup@x.com' })],
    [customer(10, { email: 'dup@x.com' })],
  )
  ok(r.matches.length === 0 && r.ambiguous.length === 2, 'dos clients con el mismo email → ambos a revisión')
}

console.log('Ya vinculado se ignora; revisión fuerte no se rescata con llave débil')
{
  const r = matchClients(
    [
      client(1, { sellercloud_id: 999, email: 'a@x.com' }),
      // c2: email ambiguo (dos customers con ese email) pero nombre único —
      // NO se rescata por nombre: queda en revisión.
      client(2, { email: 'dup@x.com', name: 'Unico Nombre' }),
    ],
    [
      customer(10, { email: 'a@x.com' }),
      customer(20, { email: 'dup@x.com' }),
      customer(30, { email: 'dup@x.com', firstName: 'Unico', lastName: 'Nombre' }),
    ],
  )
  ok(r.skipped === 1, 'el cliente ya vinculado cuenta como skipped')
  ok(!r.matches.some((m) => m.client.id === 'c1') && !r.ambiguous.some((a) => a.client.id === 'c1'),
    'y no aparece en ningún CSV')
  ok(r.ambiguous.some((a) => a.client.id === 'c2') && !r.matches.some((m) => m.client.id === 'c2'),
    'el email ambiguo manda a revisión aunque el nombre hubiera matcheado')
}

console.log('Sin candidato → unmatched; idempotencia del matching')
{
  const clients = [client(1, { name: 'Nadie Conocido', phone: '7865550099', email: 'nadie@x.com' })]
  const customers = [customer(10, { email: 'otro@x.com' })]
  const r1 = matchClients(clients, customers)
  ok(r1.unmatched.length === 1 && r1.unmatched[0].client.id === 'c1', 'sin candidato va a unmatched')
  const r2 = matchClients(clients, customers)
  ok(JSON.stringify(r1) === JSON.stringify(r2), 'correr dos veces da exactamente lo mismo')
}

console.log('Un customer solo se asigna una vez')
{
  // c1 se lleva al 10 por email; c2 tiene el MISMO nombre que el 10 — sin el
  // claim, c2 lo matchearía por nombre. Tiene que quedar sin candidato.
  const r = matchClients(
    [
      client(1, { email: 'a@x.com' }),
      client(2, { name: 'Nombre10 Apellido10' }),
    ],
    [customer(10, { email: 'a@x.com' })],
  )
  ok(r.matches.length === 1 && r.matches[0].client.id === 'c1', 'c1 se lleva el customer por email')
  ok(r.unmatched.some((u) => u.client.id === 'c2'), 'c2 no puede reclamar un customer ya asignado')
}

console.log(`\n${passed}/${passed + failed} OK${failed ? ` — ${failed} FALLARON` : ''}`)
process.exit(failed ? 1 : 0)
