import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { cartPricing, tiersFor } from '../utils/tiers'

// Carrito en memoria + localStorage. Ítems: {id, name, price, qty, flash}
// La clave es el id del producto (el SKU es interno y ya no viaja al
// catálogo del cliente).
const CartContext = createContext(null)

const STORAGE_KEY = 'zimaxx_cart'
// Identifica al CARRITO, no al envío: se mantiene mientras el cliente arma su
// pedido y solo cambia cuando el carrito se vacía. create_order lo usa para
// que reintentar un envío que falló devuelva el pedido ya guardado en vez de
// duplicarlo (2026-08-05, migration-2026-08-05-order-capture.sql).
const RID_KEY = 'zimaxx_cart_rid'

function loadCart() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    // Descarta carritos guardados por versiones viejas (ítems sin id).
    return Array.isArray(parsed) ? parsed.filter((i) => i && i.id) : []
  } catch {
    return []
  }
}

function newRequestId() {
  try {
    return crypto.randomUUID()
  } catch {
    // Safari < 15.4 y cualquier contexto sin crypto.randomUUID: uuid v4 a mano.
    // No necesita ser criptográfico, solo no repetirse entre carritos.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    })
  }
}

function loadRequestId() {
  try {
    return localStorage.getItem(RID_KEY) || newRequestId()
  } catch {
    return newRequestId()
  }
}

function makeItem(product, price, qty, flash) {
  return {
    id: product.id,
    name: product.name,
    // 2026-08-14: el UPC viaja con el ítem para poder imprimirlo en el PDF de
    // cotización sin volver a pedir el producto. Puede ser null (producto sin
    // UPC cargado) o undefined (carrito guardado por una versión anterior, o
    // catálogo servido por un get_catalog todavía sin la clave): las dos cosas
    // se dibujan igual, sin línea de UPC.
    upc: product.upc ?? null,
    price,
    // 2026-10-01: el precio en cada nivel de la cadena (ver utils/tiers.js).
    // Ausente en carritos viejos o con una base sin la migración: entonces el
    // único precio conocido es `price`.
    tier_prices: Array.isArray(product.tier_prices) ? product.tier_prices : undefined,
    qty,
    flash,
    preorder: product.availability === 'preorder',
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(loadCart)
  const [open, setOpen] = useState(false)
  const [requestId, setRequestId] = useState(loadRequestId)
  // 2026-10-01: la cadena de niveles del cliente (client.tiers de get_catalog).
  // La pone Catalog cuando carga; vacía = carrito de siempre.
  const [tiers, setTiersState] = useState([])

  // Un carrito vacío no se guarda: se borra la clave. Así, después de
  // enviar un pedido o generar una cotización (CartDrawer llama a clear()),
  // no queda nada del movimiento en el almacenamiento del dispositivo —
  // importante porque el link del catálogo se comparte por WhatsApp y se
  // abre en teléfonos que a veces no son del cliente (2026-08-04, a pedido
  // del usuario). El request_id sigue la misma suerte: se guarda mientras hay
  // carrito y se borra con él.
  useEffect(() => {
    try {
      if (items.length === 0) {
        localStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(RID_KEY)
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
        localStorage.setItem(RID_KEY, requestId)
      }
    } catch {
      // Modo privado o storage lleno: el carrito sigue vivo en memoria.
    }
  }, [items, requestId])

  const value = useMemo(() => {
    // `qty` es cuánto sumar (1 por defecto, o 10/15/20 desde los botones de
    // compra grande de ProductCard), no la cantidad final.
    const add = (product, price, { flash = false, qty = 1 } = {}) => {
      setItems((prev) => {
        const key = `${product.id}|${flash ? 'f' : 'n'}`
        const idx = prev.findIndex((i) => `${i.id}|${i.flash ? 'f' : 'n'}` === key)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = { ...next[idx], qty: next[idx].qty + qty }
          return next
        }
        return [...prev, makeItem(product, price, qty, flash)]
      })
    }

    const setQty = (id, flash, qty) => {
      setItems((prev) =>
        qty <= 0
          ? prev.filter((i) => !(i.id === id && !!i.flash === !!flash))
          : prev.map((i) => (i.id === id && !!i.flash === !!flash ? { ...i, qty } : i)),
      )
    }

    // Como setQty pero recibe el producto completo: si todavía no está en
    // el carrito lo crea (para el input editable a mano de ProductCard,
    // que puede escribir una cantidad sin haber tocado antes "Agregar").
    const setExactQty = (product, price, qty, { flash = false } = {}) => {
      setItems((prev) => {
        const key = `${product.id}|${flash ? 'f' : 'n'}`
        const idx = prev.findIndex((i) => `${i.id}|${i.flash ? 'f' : 'n'}` === key)
        if (qty <= 0) return idx >= 0 ? prev.filter((_, i) => i !== idx) : prev
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = { ...next[idx], qty }
          return next
        }
        return [...prev, makeItem(product, price, qty, flash)]
      })
    }

    const remove = (id, flash) => setQty(id, flash, 0)
    // Vaciar el carrito cierra ese pedido: el próximo arranca con otro
    // request_id, así dos pedidos distintos del mismo cliente nunca se
    // confunden entre sí en create_order.
    const clear = () => {
      setItems([])
      setRequestId(newRequestId())
    }

    // 2026-10-01: Catalog la llama con client.tiers al cargar.
    const setTiers = (client) => setTiersState(tiersFor(client))

    // 2026-10-01: al cargar el catálogo, los ítems guardados toman el precio,
    // los precios por nivel, el UPC y la disponibilidad VIGENTES del producto.
    // Antes el precio quedaba congelado al momento de agregar (y el servidor
    // recalculaba igual al registrar); con niveles hace falta que el carrito
    // conozca los precios de cada nivel aunque se haya armado ayer. Un ítem
    // cuyo producto ya no está en el catálogo se deja como está (el servidor
    // decide si entra: pre-order por stock sí, apagado a mano no).
    const refreshFromCatalog = (products) => {
      if (!Array.isArray(products) || products.length === 0) return
      const byId = new Map(products.map((p) => [p.id, p]))
      setItems((prev) => {
        let changed = false
        const next = prev.map((i) => {
          const p = byId.get(i.id)
          if (!p) return i
          const fresh = makeItem(p, p.price == null ? null : Number(p.price), i.qty, i.flash)
          const same =
            fresh.price === i.price &&
            fresh.upc === i.upc &&
            fresh.preorder === i.preorder &&
            JSON.stringify(fresh.tier_prices ?? null) === JSON.stringify(i.tier_prices ?? null)
          if (same) return i
          changed = true
          return { ...i, ...fresh, name: i.name }
        })
        return changed ? next : prev
      })
    }

    const count = items.reduce((n, i) => n + i.qty, 0)
    // 2026-10-01: el total es el del NIVEL EFECTIVO (igual que lo cobra el
    // servidor); `baseTotal` es a precios de la lista del cliente y `savings`
    // la diferencia. Sin niveles, pricing.total es la suma de siempre.
    const pricing = cartPricing(items, tiers)
    const total = pricing.total
    const hasPrices = items.some((i) => i.price != null)
    // Los ítems con el precio que de verdad se cobra (para el drawer, el
    // mensaje de WhatsApp y el PDF); `base_price` conserva el de la lista.
    const pricedItems = items.map((i) => {
      const price = pricing.priceOf(i)
      return price === i.price ? i : { ...i, price, base_price: i.price }
    })
    // Precio efectivo de un producto del catálogo en el nivel actual.
    const priceFor = (product) => pricing.priceOf(product)

    return {
      items, add, setQty, setExactQty, remove, clear,
      count, total, hasPrices, open, setOpen, requestId,
      tiers, setTiers, refreshFromCatalog,
      pricing, pricedItems, priceFor,
      baseTotal: pricing.baseTotal,
      savings: pricing.savings,
      tierIndex: pricing.index,
      tier: pricing.tier,
      nextTier: pricing.next,
    }
  }, [items, open, requestId, tiers])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  return useContext(CartContext)
}
