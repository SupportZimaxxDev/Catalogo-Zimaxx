import { useEffect, useRef, useState } from 'react'

// Reintento automático cuando la foto no carga (2026-08-19, por el reporte
// de una vendedora: "a veces al cliente no le cargan ciertas imágenes y se
// arregla reenviándole el link"). Las fotos son hotlinks al servidor de
// SellerCloud (fc2.cwa, sin CDN y sin headers de caché, respuestas de hasta
// 1.6 s) y en datos móviles algunas requests se caen; sin esto la <img>
// fallida quedaba rota hasta recargar la página entera — reenviar el link
// era exactamente eso, un reintento manual.
//
// El reintento REMONTA la <img> (key={attempt}): un elemento nuevo vuelve a
// pedir la misma URL — los fallos de red no se cachean — y un éxito sigue
// aprovechando el caché normal del teléfono (nada de cache-busters, que lo
// esquivarían para siempre). Mientras espera, y si se agotan los intentos,
// se muestra el monograma: una tarjeta con la Z dorada se ve cuidada; el
// glifo de imagen rota del navegador, no.
const RETRY_DELAYS_MS = [1200, 3500]

// Imagen de producto con placeholder de marca: monograma dorado sobre
// degradé de tinta, para que un catálogo sin fotos igual se vea cuidado.
export default function ProductImage({ src, alt }) {
  const [attempt, setAttempt] = useState(0)
  const [waiting, setWaiting] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef(null)

  // Si cambia la URL (la tarjeta se reusa para otro producto), de cero.
  // El cleanup también corre al desmontar: sin él, el setTimeout de un
  // reintento pendiente dispararía un setState sobre un componente muerto.
  useEffect(() => {
    setAttempt(0)
    setWaiting(false)
    setFailed(false)
    return () => clearTimeout(timer.current)
  }, [src])

  const onError = () => {
    if (attempt < RETRY_DELAYS_MS.length) {
      setWaiting(true)
      timer.current = setTimeout(() => {
        setAttempt((a) => a + 1)
        setWaiting(false)
      }, RETRY_DELAYS_MS[attempt])
    } else {
      setFailed(true)
    }
  }

  const showImg = src && !failed && !waiting
  return (
    <div className="relative aspect-square overflow-hidden bg-gradient-to-br from-[#1d1a12] via-[#262115] to-[#16130d]">
      {showImg ? (
        <img
          key={attempt}
          src={src}
          alt={alt}
          loading="lazy"
          onError={onError}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="font-brand text-5xl font-semibold italic text-secondary/25">Z</span>
        </div>
      )}
    </div>
  )
}
