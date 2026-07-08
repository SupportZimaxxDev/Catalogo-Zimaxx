import { cleanPhone, money } from './format'

// Construye el mensaje de pedido y el link wa.me a la vendedora.
export function buildOrderMessage({ t, clientName, items, total }) {
  const hasPrices = items.some((i) => i.price != null)
  const lines = []
  lines.push(`*${hasPrices ? t('orderTitle') : t('quoteRequestTitle')}*`)
  lines.push(`${t('client')}: ${clientName}`)
  lines.push('')
  lines.push(hasPrices ? t('orderGreeting') : t('quoteRequestGreeting'))
  lines.push('')

  items.forEach((i, n) => {
    const tags = `${i.flash ? ' ⚡' : ''}${i.preorder ? ' (Pre-Order)' : ''}`
    if (i.price == null) {
      lines.push(`${n + 1}. ${i.name} x${i.qty}${tags}`)
    } else {
      lines.push(
        `${n + 1}. ${i.name} x${i.qty} @ ${money(i.price)} = ${money(i.price * i.qty)}${tags}`,
      )
    }
  })

  if (hasPrices) {
    lines.push('')
    lines.push(`*${t('total')}: ${money(total)}*`)
  }

  return lines.join('\n')
}

export function whatsappUrl(phone, message) {
  const num = cleanPhone(phone) || cleanPhone(import.meta.env.VITE_DEFAULT_WHATSAPP)
  const text = encodeURIComponent(message)
  // Sin número configurado, wa.me sin destinatario deja elegir el contacto.
  return num ? `https://wa.me/${num}?text=${text}` : `https://wa.me/?text=${text}`
}
