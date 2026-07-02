// Imagen de producto con placeholder de marca: monograma dorado sobre
// degradé de tinta, para que un catálogo sin fotos igual se vea cuidado.
export default function ProductImage({ src, alt }) {
  return (
    <div className="relative aspect-square overflow-hidden bg-gradient-to-br from-[#1d1a12] via-[#262115] to-[#16130d]">
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
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
