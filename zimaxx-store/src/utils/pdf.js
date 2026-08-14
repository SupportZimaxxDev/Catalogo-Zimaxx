import { money } from './format'

// PDF simple de la orden con jsPDF (tabla dibujada a mano, sin plugins).
// jsPDF se carga bajo demanda para no pesar en el bundle inicial.
export async function downloadOrderPdf({ t, clientName, items, total }) {
  const hasPrices = items.some((i) => i.price != null)
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF()
  const pageW = doc.internal.pageSize.getWidth()
  const marginX = 14
  // Columna UPC (2026-08-14, a pedido del usuario): el cliente y la vendedora
  // piden por código, no solo por nombre. Va entre Producto y Cantidad, con el
  // nombre recortado a 78mm para dejarle lugar (antes usaba 105mm). Un ítem sin
  // UPC —producto sin cargar, o pedido guardado antes de este cambio— deja la
  // celda vacía; la columna se dibuja igual para que la tabla no baile de
  // ancho entre un PDF y otro. 26mm entran los 13 dígitos de un EAN-13 a
  // cuerpo 10 sin llegar a tocar el encabezado "Cantidad" (empieza en 125mm).
  const nameW = 78
  const upcX = marginX + nameW + 4
  const upcW = 26
  let y = 20

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(13, 13, 13)
  doc.text('Zimaxx Store', marginX, y)
  doc.setDrawColor(212, 175, 55)
  doc.setLineWidth(0.8)
  doc.line(marginX, y + 2, pageW - marginX, y + 2)

  y += 12
  doc.setFontSize(12)
  doc.text(hasPrices ? t('orderTitle') : t('quoteRequestTitle'), marginX, y)
  y += 7
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(`${t('client')}: ${clientName}`, marginX, y)
  doc.text(new Date().toLocaleString(), pageW - marginX, y, { align: 'right' })

  // Cabecera de tabla
  y += 10
  doc.setFont('helvetica', 'bold')
  doc.text(t('product'), marginX, y)
  doc.text(t('upc'), upcX, y)
  doc.text(t('quantity'), pageW - 70, y, { align: 'right' })
  if (hasPrices) {
    doc.text(t('unitPrice'), pageW - 45, y, { align: 'right' })
    doc.text(t('subtotal'), pageW - marginX, y, { align: 'right' })
  }
  doc.setDrawColor(180)
  doc.setLineWidth(0.2)
  doc.line(marginX, y + 2, pageW - marginX, y + 2)

  const regularItems = items.filter((i) => !i.preorder)
  const preorderItems = items.filter((i) => i.preorder)

  const ensureSpace = () => {
    if (y > 280) {
      doc.addPage()
      y = 20
    }
  }

  // El nombre se recorta si no entra (ya era así), pero el UPC NUNCA: un código
  // cortado a la mitad se lee como un código válido y manda a pedir otra cosa.
  // Si un código raro no entra en la columna, baja de cuerpo hasta que entra.
  const drawUpc = (upc) => {
    const code = String(upc)
    let size = 10
    while (size > 7 && doc.getTextWidth(code) > upcW) {
      size -= 0.5
      doc.setFontSize(size)
    }
    doc.text(code, upcX, y)
    doc.setFontSize(10)
  }

  const drawRow = (i) => {
    y += 7
    ensureSpace()
    doc.text(doc.splitTextToSize(i.name, nameW)[0] ?? '', marginX, y)
    if (i.upc) drawUpc(i.upc)
    doc.text(String(i.qty), pageW - 70, y, { align: 'right' })
    if (i.price != null) {
      doc.text(money(i.price), pageW - 45, y, { align: 'right' })
      doc.text(money(i.price * i.qty), pageW - marginX, y, { align: 'right' })
    }
  }

  const drawSectionTitle = (label) => {
    y += 9
    ensureSpace()
    doc.setFont('helvetica', 'bold')
    doc.text(label, marginX, y)
    doc.setFont('helvetica', 'normal')
  }

  doc.setFont('helvetica', 'normal')
  regularItems.forEach(drawRow)
  if (preorderItems.length) {
    drawSectionTitle(t('preorder'))
    preorderItems.forEach(drawRow)
  }

  if (hasPrices) {
    y += 10
    doc.setDrawColor(13, 13, 13)
    doc.line(pageW - 80, y - 5, pageW - marginX, y - 5)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.text(`${t('total')}: ${money(total)}`, pageW - marginX, y, { align: 'right' })
  }

  const stamp = new Date().toISOString().slice(0, 10)
  doc.save(`zimaxx-order-${stamp}.pdf`)
}
