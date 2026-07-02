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
// del admin: esta función pagina hasta traer todo.
export async function fetchAll(table, columns = '*', orderBy = 'id') {
  const PAGE = 1000
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderBy)
      .range(from, from + PAGE - 1)
    if (error) throw error
    all.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return all
}
