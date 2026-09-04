// Matching clients (Supabase) ↔ customers (SellerCloud) para el backfill de
// sellercloud_id (2026-09-02). Módulo PURO a propósito: no hace red ni lee
// env — recibe los dos universos ya descargados y devuelve qué se puede
// aplicar solo, qué necesita revisión humana y qué no existe allá. Así se
// prueba con fixtures sintéticos (tests/backfill-matching-tests.mjs) sin
// tocar ninguna API.
//
// Reglas, por confianza descendente (cada cliente juega UNA sola vez):
//   1. email exacto (normalizado) — automático si es 1:1.
//   2. teléfono (solo dígitos, comparado por los ÚLTIMOS 10 para ignorar
//      prefijos de país) — automático si es 1:1 Y el cliente no comparte
//      teléfono (allow_shared_phone o duplicado local): un teléfono
//      compartido no identifica a nadie → a revisión.
//   3. nombre normalizado (sin acentos, minúsculas, espacios colapsados) —
//      automático solo si el nombre es único de AMBOS lados.
//
// Cualquier colisión (una llave con 2+ de un lado o del otro, un customer
// pretendido por dos clientes) manda a TODOS los involucrados a revisión —
// nunca se elige "el más parecido" en silencio. Y una vez que un cliente cae
// a revisión por una llave fuerte, una llave más débil NO lo rescata: si el
// email era ambiguo, que el nombre coincida no lo vuelve confiable.

export function normalizeEmail(v) {
  const e = String(v ?? '').trim().toLowerCase()
  return e.includes('@') ? e : null
}

// Solo dígitos; la LLAVE de comparación son los últimos 10 (número nacional,
// con o sin código de país). Menos de 7 dígitos no identifica un teléfono.
export function normalizePhone(v) {
  const d = String(v ?? '').replace(/\D/g, '')
  return d.length >= 7 ? d.slice(-10) : null
}

export function normalizeName(v) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // acentos fuera
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ') // puntuación → espacio (J. Pérez ≈ J Perez)
    .replace(/\s+/g, ' ')
    .trim()
}

export function customerDisplayName(c) {
  return (
    [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
    String(c.business ?? '').trim() ||
    `#${c.id}`
  )
}

// Similitud de nombres por bigramas de caracteres (coeficiente de Dice) sobre
// el nombre normalizado: barato, sin dependencias y suficiente para rankear
// "los 3 más parecidos" de un ambiguo — la decisión final es humana igual.
export function nameSimilarity(a, b) {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const grams = (s) => {
    const g = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2)
      g.set(bg, (g.get(bg) ?? 0) + 1)
    }
    return g
  }
  const ga = grams(na)
  const gb = grams(nb)
  let shared = 0
  let totalA = 0
  let totalB = 0
  for (const n of ga.values()) totalA += n
  for (const n of gb.values()) totalB += n
  for (const [bg, n] of ga) shared += Math.min(n, gb.get(bg) ?? 0)
  return totalA + totalB === 0 ? 0 : (2 * shared) / (totalA + totalB)
}

// Top-N customers más parecidos por nombre (para decidir un ambiguo a mano).
export function topByName(client, customers, n = 3) {
  return customers
    .map((c) => ({ customer: c, score: nameSimilarity(client.name, customerDisplayName(c)) }))
    .filter((x) => x.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
}

// clients:   [{ id, name, phone, email, allow_shared_phone, sellercloud_id }]
// customers: [{ id, firstName, lastName, email, business, phone? }]
//            (phone solo cuando se conoce: el listado de SellerCloud no lo
//            trae — el runner lo agrega para los hits de búsqueda por
//            teléfono)
// Devuelve { matches, ambiguous, unmatched, skipped } donde:
//   matches:   [{ client, customer, key: 'email'|'phone'|'name' }]
//   ambiguous: [{ client, reason, candidates: [{customer, score}] }]
//   unmatched: [{ client }]
export function matchClients(clients, customers) {
  // Cliente ya vinculado: no se toca nunca (idempotencia del backfill).
  const skipped = clients.filter((c) => c.sellercloud_id != null).length
  const pool = clients.filter((c) => c.sellercloud_id == null)

  const matches = []
  const ambiguous = []
  const claimedClient = new Set() // ids de clients ya resueltos (match O revisión)
  const claimedCustomer = new Set() // ids de customers ya asignados

  // Teléfonos que NO identifican: compartidos localmente (dos clients con la
  // misma llave) o marcados allow_shared_phone.
  const phoneCount = new Map()
  for (const c of pool) {
    const k = normalizePhone(c.phone)
    if (k) phoneCount.set(k, (phoneCount.get(k) ?? 0) + 1)
  }

  const tiers = [
    {
      key: 'email',
      clientKey: (c) => normalizeEmail(c.email),
      customerKey: (c) => normalizeEmail(c.email),
      autoOk: () => true,
    },
    {
      key: 'phone',
      clientKey: (c) => normalizePhone(c.phone),
      customerKey: (c) => normalizePhone(c.phone),
      autoOk: (client, k) => !client.allow_shared_phone && phoneCount.get(k) === 1,
    },
    {
      key: 'name',
      clientKey: (c) => normalizeName(c.name) || null,
      customerKey: (c) => normalizeName(customerDisplayName(c)) || null,
      autoOk: () => true,
    },
  ]

  const sendToReview = (client, reason, colliding) => {
    claimedClient.add(client.id)
    // Los que chocaron van primero; se completa hasta 3 con los más parecidos
    // por nombre entre los customers todavía libres.
    const base = (colliding ?? []).map((customer) => ({
      customer,
      score: nameSimilarity(client.name, customerDisplayName(customer)),
    }))
    const seen = new Set(base.map((x) => x.customer.id))
    const fill = topByName(
      client,
      customers.filter((c) => !claimedCustomer.has(c.id) && !seen.has(c.id)),
    )
    ambiguous.push({ client, reason, candidates: [...base, ...fill].slice(0, 3) })
  }

  for (const tier of tiers) {
    // Índices SOLO con lo que sigue libre al empezar esta llave.
    const byKeyClients = new Map()
    for (const c of pool) {
      if (claimedClient.has(c.id)) continue
      const k = tier.clientKey(c)
      if (!k) continue
      if (!byKeyClients.has(k)) byKeyClients.set(k, [])
      byKeyClients.get(k).push(c)
    }
    const byKeyCustomers = new Map()
    for (const c of customers) {
      if (claimedCustomer.has(c.id)) continue
      const k = tier.customerKey(c)
      if (!k) continue
      if (!byKeyCustomers.has(k)) byKeyCustomers.set(k, [])
      byKeyCustomers.get(k).push(c)
    }

    for (const [k, clientsFor] of byKeyClients) {
      const customersFor = byKeyCustomers.get(k)
      if (!customersFor || customersFor.length === 0) continue

      if (clientsFor.length === 1 && customersFor.length === 1 && tier.autoOk(clientsFor[0], k)) {
        const client = clientsFor[0]
        const customer = customersFor[0]
        claimedClient.add(client.id)
        claimedCustomer.add(customer.id)
        matches.push({ client, customer, key: tier.key })
        continue
      }

      // Colisión (2+ de algún lado) o llave vetada (teléfono compartido):
      // todos los clientes de esta llave, a revisión con los candidatos.
      const reason =
        tier.key === 'phone' && clientsFor.some((c) => c.allow_shared_phone || phoneCount.get(k) > 1)
          ? 'teléfono compartido'
          : `${tier.key} con ${clientsFor.length} cliente(s) y ${customersFor.length} candidato(s)`
      for (const client of clientsFor) {
        sendToReview(client, reason, customersFor)
      }
    }
  }

  const unmatched = pool
    .filter((c) => !claimedClient.has(c.id))
    .map((client) => ({ client }))

  return { matches, ambiguous, unmatched, skipped }
}
