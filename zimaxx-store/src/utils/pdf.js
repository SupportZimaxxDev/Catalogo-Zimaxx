import { money } from './format'

// PDF simple de la orden con jsPDF (tabla dibujada a mano, sin plugins).
// jsPDF se carga bajo demanda para no pesar en el bundle inicial.
export async function downloadOrderPdf({ t, clientName, items, total, isQuote }) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF()
  const pageW = doc.internal.pageSize.getWidth()
  const marginX = 14
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
  doc.text(t(isQuote ? 'quoteTitle' : 'orderTitle'), marginX, y)
  y += 7
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(`${t('client')}: ${clientName}`, marginX, y)
  doc.text(new Date().toLocaleString(), pageW - marginX, y, { align: 'right' })

  // Cabecera de tabla
  y += 10
  doc.setFont('helvetica', 'bold')
  doc.text(t('product'), marginX, y)
  doc.text(t('quantity'), pageW - (isQuote ? 20 : 70), y, { align: 'right' })
  if (!isQuote) {
    doc.text(t('unitPrice'), pageW - 45, y, { align: 'right' })
    doc.text(t('subtotal'), pageW - marginX, y, { align: 'right' })
  }
  doc.setDrawColor(180)
  doc.setLineWidth(0.2)
  doc.line(marginX, y + 2, pageW - marginX, y + 2)

  doc.setFont('helvetica', 'normal')
  items.forEach((i) => {
    y += 7
    if (y > 280) {
      doc.addPage()
      y = 20
    }
    doc.text(doc.splitTextToSize(i.name, 105)[0] ?? '', marginX, y)
    doc.text(String(i.qty), pageW - (isQuote ? 20 : 70), y, { align: 'right' })
    if (!isQuote && i.price != null) {
      doc.text(money(i.price), pageW - 45, y, { align: 'right' })
      doc.text(money(i.price * i.qty), pageW - marginX, y, { align: 'right' })
    }
  })

  if (!isQuote) {
    y += 10
    doc.setDrawColor(13, 13, 13)
    doc.line(pageW - 80, y - 5, pageW - marginX, y - 5)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.text(`${t('total')}: ${money(total)}`, pageW - marginX, y, { align: 'right' })
  }

  const stamp = new Date().toISOString().slice(0, 10)
  doc.save(`zimaxx-${isQuote ? 'quote' : 'order'}-${stamp}.pdf`)
}
