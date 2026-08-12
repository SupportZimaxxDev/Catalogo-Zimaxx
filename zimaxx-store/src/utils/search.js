// Búsqueda de texto por términos, compartida por los buscadores del panel.
//
// Nace de un incidente real (2026-08-12): "las órdenes del cliente Robert
// Carlos Pacheco no se registraron". Los pedidos estaban guardados; lo que
// falló fue encontrarlos. El buscador de la bandeja pedía UNA subcadena
// contigua (`name.toLowerCase().includes(q)`), y el nombre que guarda el sync
// es el `Name` completo de SellerCloud ("Robert Edu Carlos Pacheco") mientras
// el negocio lo conoce por su `CorporateName` ("Robert Carlos"). O sea que
// buscar "robert carlos" devolvía CERO resultados sobre un cliente que sí
// tenía pedidos, y una bandeja vacía se leyó como "no se registró nada".
//
// El nombre de en medio no es un caso aislado: los datos vienen de
// SellerCloud, donde el mismo cliente aparece como Name / CorporateName /
// ContactName, así que la app va a tener guardada casi siempre una variante
// más larga que la que alguien va a tipear.
//
// La regla: TODOS los términos tienen que aparecer, en cualquier orden. Con
// una sola palabra se comporta igual que el `includes` de antes (no cambia
// ningún resultado que ya funcionaba), y con dos o más deja de exigir que
// quien busca adivine el nombre completo tal cual quedó escrito.

// Minúsculas y sin acentos: "Ramón Núñez" tiene que salir tipeando
// "ramon nunez", que es como se escribe sin pelear con el teclado.
// `\p{Diacritic}` en vez de un rango de caracteres combinantes: es lo mismo
// pero no mete en el fuente caracteres invisibles que cualquier reformateo
// del archivo puede perder sin que se note.
export function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

// Los términos de la consulta, ya normalizados. Devuelve [] si no hay nada
// que buscar, para que quien llama trate "sin filtro" como caso aparte.
export function searchTerms(query) {
  return normalizeText(query).split(/\s+/).filter(Boolean)
}

// ¿Aparecen todos los términos en alguno de los campos? Se evalúa campo por
// campo con `some` a propósito: los términos NO se pueden repartir entre dos
// campos distintos (que "juan perez" matchee el nombre "Juan" de un cliente
// más la vendedora "Perez" sería un falso positivo, y en una bandeja de
// pedidos un falso positivo cuesta lo mismo que un falso negativo).
export function matchesTerms(terms, ...fields) {
  if (terms.length === 0) return true
  return fields.some((f) => {
    const hay = normalizeText(f)
    return hay !== '' && terms.every((t) => hay.includes(t))
  })
}
