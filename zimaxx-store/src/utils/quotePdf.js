// Leer el PDF de una cotización/pedido generado por la propia app
// (src/utils/pdf.js) y devolver sus líneas para recargarlo como pedido
// (2026-08-18, a pedido del usuario). Es el mismo espíritu que
// parseOrderMessage en whatsapp.js —el papel vuelve y hay que reconstruir el
// pedido— pero acá el formato lo controlamos nosotros: el PDF lo dibuja
// downloadOrderPdf con columnas en posiciones fijas, así que en vez de
// adivinar con regex sobre texto libre se clasifica cada texto por la
// COORDENADA X en la que está dibujado.
//
// pdfjs-dist se carga bajo demanda (igual que jspdf y xlsx): pesa de más para
// el bundle inicial y solo hace falta cuando alguien sube un PDF.
//
// Qué devuelve: { clientName, total, lines: [{ name, upc, qty, price }],
// unparsed: [] }. Los nombres pueden venir RECORTADOS (el PDF corta el nombre
// a 78mm para que entre la columna UPC), por eso el que importa es el UPC:
// quien consume esto debe matchear por UPC primero y usar el nombre solo de
// respaldo. El precio es solo informativo — el precio real siempre lo
// recalcula el servidor con la lista del cliente.

// Las columnas de downloadOrderPdf, pasadas de mm a puntos PDF (1mm ≈
// 2.8346pt). El nombre arranca en 14mm, el UPC en 96mm, la cantidad termina
// alineada a la derecha en 140mm y todo lo que es plata (y la fecha) vive de
// 400pt para la derecha. Los cortes van holgados: una cantidad de 6 cifras
// arranca en ~364pt y el precio unitario más gordo en ~420pt.
const NAME_MAX_X = 150
const UPC_MIN_X = 240
const UPC_MAX_X = 330
const QTY_MIN_X = 330
const QTY_MAX_X = 400

// Los rótulos que imprime el PDF, en los dos idiomas (el idioma del PDF es el
// que tenía el navegador del cliente al generarlo, así que acá van ambos).
const SKIP_EXACT = new Set([
  'zimaxx store',
  'producto',
  'product',
  'pre-order',
  'pedido zimaxx store',
  'zimaxx store order',
  'solicitud de cotización — zimaxx store',
  'quote request — zimaxx store',
])
const CLIENT_RE = /^(cliente|client):\s*(.+)$/i
const TOTAL_RE = /^total:\s*\$?([\d,]+\.?\d*)$/i
const MONEY_RE = /^\$([\d,]+\.?\d*)$/

async function loadPdfjs() {
  if (typeof window === 'undefined') {
    // Node (las pruebas de este parser): el build moderno exige DOMMatrix,
    // que es del DOM. El legacy anda sin worker (cae solo al "fake worker").
    // La ruta va en una variable A PROPÓSITO: con el string inline, Vite
    // empaquetaba el build legacy entero (535 KB) como chunk muerto aunque
    // esta rama no corre nunca en el navegador; con la variable (más el
    // @vite-ignore que apaga el warning) el import queda tal cual y solo lo
    // resuelve Node.
    const legacyPath = 'pdfjs-dist/legacy/build/pdf.mjs'
    return await import(/* @vite-ignore */ legacyPath)
  }
  const pdfjs = await import('pdfjs-dist')
  // El worker existe como asset gracias al `?url` (Vite lo empaqueta y
  // devuelve su URL final).
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  return pdfjs
}

// Agrupa los textos de una página por renglón (misma Y de línea de base,
// redondeada: todos los textos de una fila se dibujan a la misma altura) y
// los ordena de arriba hacia abajo, izquierda a derecha. En PDF la Y crece
// hacia ARRIBA, por eso el orden desciende.
function rowsOf(textContent) {
  const byY = new Map()
  for (const item of textContent.items) {
    // normalize('NFC') no es opcional: pdfjs devuelve los acentos como
    // carácter combinante (NFD, "o" + ´) y products.name está en NFC. Se ven
    // iguales, pero ni in('name', ...) ni ilike matchean uno contra el otro —
    // sin esto, cualquier producto con tilde y sin UPC queda sin resolver.
    const text = String(item.str ?? '').normalize('NFC').trim()
    if (!text) continue
    const x = item.transform[4]
    const y = Math.round(item.transform[5] * 10) / 10
    if (!byY.has(y)) byY.set(y, [])
    byY.get(y).push({ x, text })
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, cells]) => cells.sort((a, b) => a.x - b.x))
}

export async function parseQuotePdf(arrayBuffer) {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise

  let clientName = null
  let total = null
  const lines = []
  const unparsed = []

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const rows = rowsOf(await page.getTextContent())

    for (const cells of rows) {
      // El nombre puede venir en más de un fragmento (pdfjs a veces parte un
      // string por los cambios de espaciado): todo lo que caiga en la banda
      // del nombre se une en orden.
      const nameText = cells
        .filter((c) => c.x < NAME_MAX_X)
        .map((c) => c.text)
        .join(' ')
        .trim()
      const upcCell = cells.find(
        (c) => c.x >= UPC_MIN_X && c.x < UPC_MAX_X && /^\d{6,14}$/.test(c.text),
      )
      const qtyCell = cells.find(
        (c) => c.x >= QTY_MIN_X && c.x < QTY_MAX_X && /^\d+$/.test(c.text),
      )
      // El primer $ de la derecha es el precio unitario; el segundo, el
      // subtotal. Solo se guarda el unitario, y solo para mostrar.
      const moneyCells = cells.filter((c) => c.x >= QTY_MAX_X && MONEY_RE.test(c.text))

      const clientMatch = nameText.match(CLIENT_RE)
      if (clientMatch) {
        clientName = clientMatch[2].trim()
        continue
      }
      const totalCell = cells.find((c) => TOTAL_RE.test(c.text))
      if (totalCell) {
        total = Number(totalCell.text.match(TOTAL_RE)[1].replace(/,/g, ''))
        continue
      }
      if (!nameText && !qtyCell) continue
      if (SKIP_EXACT.has(nameText.toLowerCase())) continue

      if (nameText && qtyCell) {
        lines.push({
          name: nameText,
          upc: upcCell ? upcCell.text : null,
          qty: Number(qtyCell.text),
          price: moneyCells.length > 0 ? Number(moneyCells[0].text.slice(1).replace(/,/g, '')) : null,
        })
      } else if (nameText) {
        // Texto en la banda del nombre sin cantidad: no es una línea del
        // pedido ni un rótulo conocido. Se muestra, no se descarta — misma
        // regla que parseOrderMessage.
        unparsed.push(nameText)
      }
    }
  }

  return { clientName, total, lines, unparsed }
}
