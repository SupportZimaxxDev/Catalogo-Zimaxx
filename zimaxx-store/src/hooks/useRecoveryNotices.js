// Avisos de recuperación para la vendedora (2026-09-17, a pedido del usuario:
// "enviarle una notificación a la respectiva vendedora cuando se les recupere
// una orden, para que les salga desde su vista"). Un solo dueño del estado —
// mismo criterio que useInventoryFreshness: AdminLayout lo monta y lo reparte
// por Outlet context; la campanita del header lo pinta y el cuadro
// "Pedidos recuperados" de la bandeja lo usa para marcar visto y refrescar.
//
// Qué es un aviso: una fila de `order_failures` de un cliente SUYO que alguien
// recuperó (recovered_order_id) y que ella todavía no marcó como vista
// (recovery_seen_at null). Si lo recuperó ella misma, la RPC lo deja ya visto
// — ver migration-2026-09-17-recovery-notifications.sql. RLS recorta la
// consulta a sus clientes; un admin no tiene avisos propios y el hook va
// apagado para él (`enabled` false).
//
// Degradación: si la base todavía no tiene la migración, la consulta da 42703
// (columna inexistente) y `unavailable` queda en true → la campanita no se
// pinta y el panel se ve exactamente como antes. Igual para la RPC de marcar
// (PGRST202 / 42883 = función inexistente).
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

const POLL_MS = 60_000
// Tope de avisos que baja la campanita. Con más que eso el contador dice
// "50+" — y de todas formas la vendedora los marca de a uno o todos juntos.
export const NOTICES_CAP = 50

const NOTICE_SELECT =
  'id, kind, client_id, reason, line_count, created_at, recovered_at, recovered_by, ' +
  'recovered_by_email, recovered_order_id, recovery_seen_at, clients(name, phone)'

// Columna o función inexistente: la migración no corrió. No es un error del
// usuario ni de red, así que se apaga la feature en silencio.
const MISSING_CODES = new Set(['42703', '42883', 'PGRST202'])

export function useRecoveryNotices(enabled) {
  const [notices, setNotices] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [marking, setMarking] = useState(false)
  const [markError, setMarkError] = useState(null)
  const alive = useRef(true)

  const reload = useCallback(async () => {
    if (!enabled) return
    try {
      const { data, error } = await supabase
        .from('order_failures')
        .select(NOTICE_SELECT)
        .not('recovered_order_id', 'is', null)
        .is('recovery_seen_at', null)
        .order('recovered_at', { ascending: false, nullsFirst: false })
        .limit(NOTICES_CAP)
      if (!alive.current) return
      if (error) {
        if (MISSING_CODES.has(error.code)) setUnavailable(true)
        return
      }
      setUnavailable(false)
      setNotices(data ?? [])
      setLoaded(true)
    } catch {
      /* sin red: queda lo último que se vio; el próximo poll lo intenta de nuevo */
    }
  }, [enabled])

  // Al montar, cada minuto mientras la pestaña esté visible, y al volver a
  // ella: así el aviso aparece sin que la vendedora tenga que navegar. Es un
  // GET chico (RLS ya lo acota a sus clientes; casi siempre vuelve vacío).
  useEffect(() => {
    alive.current = true
    if (!enabled) {
      setNotices([])
      setLoaded(false)
      return undefined
    }
    reload()
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') reload()
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, reload])

  // "Marcar visto" (uno o varios). La verdad la pone la RPC — solo alcanza
  // filas recuperadas, pendientes y de los clientes de quien llama — y acá se
  // quitan de la lista en el acto y se recarga para quedar en sincronía.
  // Devuelve cuántas marcó la base (0 si ya estaban vistas), o null si falló.
  const markSeen = useCallback(
    async (ids) => {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
      if (list.length === 0 || marking) return 0
      setMarking(true)
      setMarkError(null)
      try {
        const { data, error } = await supabase.rpc('mark_recoveries_seen', { p_failure_ids: list })
        if (error) {
          if (MISSING_CODES.has(error.code)) setUnavailable(true)
          setMarkError(error.message)
          return null
        }
        const done = new Set(list)
        setNotices((prev) => prev.filter((n) => !done.has(n.id)))
        reload()
        return data ?? 0
      } catch (e) {
        setMarkError(e?.message ?? String(e))
        return null
      } finally {
        setMarking(false)
      }
    },
    [marking, reload],
  )

  const clearMarkError = useCallback(() => setMarkError(null), [])

  return { notices, loaded, unavailable, marking, markError, clearMarkError, refresh: reload, markSeen }
}
