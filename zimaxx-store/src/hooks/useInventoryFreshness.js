// Frescura de inventario (2026-09-04). Un solo dueño del estado: AdminLayout
// lo monta y lo reparte — el indicador del header lo muestra y las páginas
// (Pedidos) lo leen por Outlet context para el candado de Atendido/push. Así
// el "hace X min" que ve la vendedora y el que deshabilita los botones son EL
// MISMO dato, no dos consultas que pueden discrepar.
//
// La verdad vive en el servidor (get_inventory_freshness + el candado en la
// RPC/Edge Function): esto solo refleja. Si la RPC no existe todavía
// (migración 2026-09-04 sin correr), freshness queda null y el panel se ve
// exactamente como antes — mismo criterio de degradación que Métricas y ⚙️
// Sistema.
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

const POLL_MS = 60_000

export function useInventoryFreshness(enabled) {
  const [freshness, setFreshness] = useState(null) // null = sin dato (cargando o sin migración)
  const [refreshing, setRefreshing] = useState(false)
  // Resultado del último refresco, para el toast: { ok, message?, code?, data? }
  const [lastResult, setLastResult] = useState(null)
  const alive = useRef(true)

  const reload = useCallback(async () => {
    if (!enabled) return
    try {
      const { data, error } = await supabase.rpc('get_inventory_freshness')
      if (!alive.current) return
      if (!error && data) setFreshness(data)
    } catch {
      /* sin red o sin migración: el indicador simplemente no aparece */
    }
  }, [enabled])

  useEffect(() => {
    alive.current = true
    if (!enabled) return undefined
    reload()
    const id = setInterval(reload, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(id)
    }
  }, [enabled, reload])

  // Dispara la Edge Function del refresco. El resultado (bueno o malo) queda
  // en lastResult para el toast; el error nunca bloquea nada — el candado
  // sigue siendo cosa del servidor.
  const refresh = useCallback(async () => {
    if (refreshing) return null
    setRefreshing(true)
    setLastResult(null)
    let result
    try {
      const { data, error } = await supabase.functions.invoke('sellercloud-refresh-stock', {
        body: {},
      })
      if (error) {
        // supabase-js da un mensaje genérico ante un no-2xx: el motivo real
        // que arma la función viene en el cuerpo (mismo caso que el push).
        let message = error.message
        let code = null
        try {
          const detail = await error.context?.json?.()
          if (detail?.error) message = detail.error
          if (detail?.code) code = detail.code
        } catch {
          /* se queda el genérico */
        }
        result = { ok: false, message, code }
      } else {
        result = { ok: true, data }
      }
    } catch (e) {
      result = { ok: false, message: e.message ?? String(e), code: null }
    }
    if (alive.current) {
      setLastResult(result)
      setRefreshing(false)
    }
    reload()
    return result
  }, [refreshing, reload])

  const clearResult = useCallback(() => setLastResult(null), [])

  return { freshness, refreshing, lastResult, refresh, reload, clearResult }
}

// 'hace 12 min' / 'hace 1 h 23 min'. Sin i18n de fechas: el formato es el
// mismo en los dos idiomas del panel ("12 min ago" suena igual de claro que
// "hace 12 min" para las usuarias reales, todas hispanohablantes).
export function formatAgo(minutes) {
  if (minutes == null) return null
  const m = Math.max(0, Math.floor(minutes))
  if (m < 60) return `hace ${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `hace ${h} h` : `hace ${h} h ${rest} min`
}
