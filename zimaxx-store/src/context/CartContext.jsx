import { createContext, useContext, useEffect, useMemo, useState } from 'react'

// Carrito en memoria + localStorage. Ítems: {id, name, price, qty, flash}
// La clave es el id del producto (el SKU es interno y ya no viaja al
// catálogo del cliente).
const CartContext = createContext(null)

const STORAGE_KEY = 'zimaxx_cart'

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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  }, [items])

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
    const clear = () => setItems([])

    const count = items.reduce((n, i) => n + i.qty, 0)
    const total = items.reduce((s, i) => s + (i.price ?? 0) * i.qty, 0)
    const hasPrices = items.some((i) => i.price != null)

    return { items, add, setQty, setExactQty, remove, clear, count, total, hasPrices, open, setOpen }
  }, [items, open])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  return useContext(CartContext)
}
