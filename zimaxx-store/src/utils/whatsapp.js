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

// ---------- Lectura del mensaje (2026-08-17) ----------
// La inversa de buildOrderMessage: la vendedora pega en el panel el mensaje
// que le llegó por WhatsApp y de ahí sale el pedido, para el caso en que el
// registro nunca llegó al sistema (ver "Cargar pedido desde WhatsApp" en el
// README). Vive en este archivo A PROPÓSITO, pegado al generador: si alguien
// cambia el formato del mensaje, tiene el parser a la vista.
//
// Tiene que aguantar lo que de verdad llega desde un chat, no solo el texto
// perfecto que genera el carrito:
//   * copiado con el membrete de WhatsApp adelante
//     ("[17/8/26, 10:32] Ana: 1. Perfume x2"),
//   * en español o en inglés (el cliente elige el idioma del catálogo),
//   * con los asteriscos de negrita puestos o comidos,
//   * con líneas de más (saludos, "gracias!", el greeting) mezcladas.
// Por eso no se ancla nada al principio de la línea y todo lo que no
// entienda se devuelve aparte en `unparsed`, para mostrarlo en pantalla en
// lugar de tragárselo en silencio — que es exactamente el error que ya costó
// un pedido en este proyecto.

// "Cliente: Fulano" / "Client: Fulano", con o sin negrita. No se ancla al
// principio: al copiar del chat, la línea suele venir como
// "[17/8/26, 10:32] Ana: Cliente: Fulano". El delimitador de adelante evita
// que "client" matchee dentro de otra palabra.
const CLIENT_RE = /(?:^|[\s\]:*])(?:cliente|client)\s*:\s*(.+?)[*\s]*$/i
// "*Total: $123.45*"
const TOTAL_RE = /^[*\s]*total\s*:\s*\$?\s*([\d.,]+)[*\s]*$/i
// El "3." que abre una línea de ítem, esté donde esté (puede venir después
// del membrete del chat). Se toma desde ahí hasta el final.
const ITEM_RE = /(\d{1,4})\.\s+(\S.*)$/
// "x3", "X 3", "×3" al final del nombre. El nombre puede contener la letra x
// ("Perfume 3 x 100ml"), por eso se busca el ÚLTIMO y anclado al final.
const QTY_RE = /^(.*?)\s*[x×]\s*(\d{1,5})$/i

const PREORDER_RE = /\(\s*pre.?order\s*\)/i

function num(raw) {
  const n = Number(String(raw ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export function parseOrderMessage(text) {
  const out = { clientName: null, total: null, lines: [], unparsed: [] }
  const rawLines = String(text ?? '').split(/\r?\n/)

  for (const raw of rawLines) {
    // El espacio duro que a veces mete el copiar/pegar rompe todos los
    // patrones de abajo si no se normaliza acá.
    const line = raw.replace(/ /g, ' ').trim()
    if (!line) continue

    if (!out.clientName) {
      const c = line.match(CLIENT_RE)
      if (c) {
        out.clientName = c[1].trim()
        continue
      }
    }
    const tot = line.match(TOTAL_RE)
    if (tot) {
      out.total = num(tot[1])
      continue
    }

    const item = line.match(ITEM_RE)
    if (!item) continue // saludo, título, línea suelta: no es un ítem

    let body = item[2].trim()
    const flash = body.includes('⚡')
    const preorder = PREORDER_RE.test(body)
    body = body.replace(/⚡/g, '').replace(PREORDER_RE, '').trim()

    // "Nombre x2 @ $20.00 = $40.00" → la parte de precios se corta acá. El
    // precio del mensaje NO se usa para crear el pedido (el servidor lo
    // recalcula con la lista del cliente, como en cualquier otro alta): sirve
    // para mostrarlo al lado del vigente y que la vendedora vea si cambió.
    let price = null
    const at = body.lastIndexOf('@')
    if (at !== -1) {
      const m = body.slice(at + 1).match(/\$?\s*([\d.,]+)/)
      if (m) price = num(m[1])
      body = body.slice(0, at).trim()
    }

    const q = body.match(QTY_RE)
    if (!q) {
      // Tiene forma de ítem pero no se le encuentra la cantidad: se muestra
      // para que la persona decida, no se descarta.
      out.unparsed.push(line)
      continue
    }
    const name = q[1].trim()
    const qty = Number(q[2])
    if (!name || !qty) {
      out.unparsed.push(line)
      continue
    }
    out.lines.push({ name, qty, flash, preorder, price })
  }

  return out
}

export function whatsappUrl(phone, message) {
  const num = cleanPhone(phone) || cleanPhone(import.meta.env.VITE_DEFAULT_WHATSAPP)
  const text = encodeURIComponent(message)
  // Sin número configurado, wa.me sin destinatario deja elegir el contacto.
  return num ? `https://wa.me/${num}?text=${text}` : `https://wa.me/?text=${text}`
}
