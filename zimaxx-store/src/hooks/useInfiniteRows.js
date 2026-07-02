import { useCallback, useEffect, useRef, useState } from 'react'

// Scroll infinito por lotes: renderizar miles de filas/tarjetas de golpe
// cuelga la pestaña, así que se muestran `step` y se suman más cuando el
// centinela (un div al pie de la lista) entra en pantalla.
// sentinelRef es un callback ref: el centinela aparece y desaparece del
// DOM según queden filas por mostrar, y el observer debe seguirlo.
export function useInfiniteRows(step = 100, resetDeps = []) {
  const [visible, setVisible] = useState(step)
  const ioRef = useRef(null)

  useEffect(() => {
    setVisible(step)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetDeps)

  useEffect(() => () => ioRef.current?.disconnect(), [])

  const sentinelRef = useCallback(
    (el) => {
      ioRef.current?.disconnect()
      ioRef.current = null
      if (!el) return
      const io = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) setVisible((v) => v + step)
        },
        { rootMargin: '400px' },
      )
      io.observe(el)
      ioRef.current = io
    },
    [step],
  )

  return [visible, sentinelRef]
}
