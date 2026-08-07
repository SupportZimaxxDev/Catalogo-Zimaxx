import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  console.warn(
    'Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Configura el archivo .env (ver .env.example).',
  )
}

export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'anon')

// PostgREST corta cada consulta en 1,000 filas por defecto. Con 3,600+
// productos eso rompe silenciosamente los cruces por SKU y las tablas
// del admin: esta función pagina hasta traer todo. Las páginas se piden
// todas en paralelo (no una tras otra) — se pide el total primero para
// saber cuántas hacen falta.
export async function fetchAll(table, columns = '*', orderBy = 'id') {
  const PAGE = 1000
  const { count, error: countError } = await supabase
    .from(table)
    .select(columns, { count: 'exact', head: true })
  if (countError) throw countError
  const total = count ?? 0
  if (total === 0) return []

  const pageCount = Math.ceil(total / PAGE)
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) =>
      supabase
        .from(table)
        .select(columns)
        .order(orderBy)
        .range(i * PAGE, i * PAGE + PAGE - 1),
    ),
  )

  const all = []
  for (const { data, error } of pages) {
    if (error) throw error
    all.push(...(data ?? []))
  }
  return all
}

// UPDATE ... WHERE id IN (...) en tandas (2026-08-07). PostgREST manda el
// `in.(...)` en la query string: con una selección grande de la pestaña
// Productos (marcar 🔥 media promo, activar todo lo filtrado) son ~37 bytes
// por uuid, así que 1,000 ids arman una URL de ~37 KB y el request se cae
// por largo antes de llegar a la base. De a 100 la URL queda en ~4 KB.
// No es atómico: si una tanda falla, las anteriores ya se aplicaron — se
// devuelve cuántas filas se alcanzaron a tocar junto con el error para
// poder decirlo en pantalla en vez de dar el bulk entero por fallado.
export async function updateByIds(table, patch, ids, chunkSize = 100) {
  let done = 0
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const { error } = await supabase.from(table).update(patch).in('id', chunk)
    if (error) return { done, error }
    done += chunk.length
  }
  return { done, error: null }
}
