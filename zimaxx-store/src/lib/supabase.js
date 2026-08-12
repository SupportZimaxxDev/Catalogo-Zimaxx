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
//
// `orderBy` acepta varias columnas (2026-08-12) y esto NO es cosmético: cada
// página es una consulta INDEPENDIENTE con su propio `range`, y Postgres no
// garantiza ningún orden entre filas que empatan en la clave de ordenamiento.
// Con empates en el borde de una página, la misma fila puede salir en dos
// páginas — o en NINGUNA, o sea desaparecer de la tabla del admin estando en
// la base. No era hipotético: `product_prices` se paginaba ordenando solo por
// `product_id`, que tiene una fila por lista de precio, así que había empates
// en todos los bordes de las ~20 páginas. Hay que pasar siempre una
// combinación única (la tabla no tiene por qué tener `id`: `product_prices`
// se identifica por producto + lista).
export async function fetchAll(table, columns = '*', orderBy = 'id') {
  const PAGE = 1000
  const orderCols = Array.isArray(orderBy) ? orderBy : [orderBy]
  const { count, error: countError } = await supabase
    .from(table)
    .select(columns, { count: 'exact', head: true })
  if (countError) throw countError
  const total = count ?? 0
  if (total === 0) return []

  const pageCount = Math.ceil(total / PAGE)
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) => {
      let q = supabase.from(table).select(columns)
      for (const col of orderCols) q = q.order(col)
      return q.range(i * PAGE, i * PAGE + PAGE - 1)
    }),
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
