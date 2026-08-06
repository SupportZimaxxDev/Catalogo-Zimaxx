import { createContext, useContext, useEffect, useMemo, useState } from 'react'

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
    price,
    qty,
    flash,
    preorder: product.availability === 'preorder',
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(loadCart)
  const [open, setOpen] = useState(false)
  const [requestId, setRequestId] = useState(loadRequestId)

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

    const count = items.reduce((n, i) => n + i.qty, 0)
    const total = items.reduce((s, i) => s + (i.price ?? 0) * i.qty, 0)
    const hasPrices = items.some((i) => i.price != null)

    return {
      items, add, setQty, setExactQty, remove, clear,
      count, total, hasPrices, open, setOpen, requestId,
    }
  }, [items, open, requestId])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  return useContext(CartContext)
}
