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
