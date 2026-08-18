import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { money } from '../../utils/format'
import { parseOrderMessage } from '../../utils/whatsapp'
// Import estático barato: quotePdf.js recién carga pdfjs-dist (pesado) adentro
// de parseQuotePdf, cuando de verdad se sube un PDF.
import { parseQuotePdf } from '../../utils/quotePdf'
import { inputCls } from './ui'

// Cargar a mano el pedido que llegó por WhatsApp y no al sistema (2026-08-17,
// a pedido del usuario). Es la última red de las tres:
//   1. order_failures  → el pedido llegó y el servidor lo rechazó.
//   2. orderOutbox.js  → no llegó, pero el navegador del cliente lo reintenta.
//   3. esto            → el cliente nunca vuelve y lo único que queda es el
//                        mensaje en el chat de la vendedora.
//
// Se pega el texto, se cruzan los productos por nombre y el pedido lo arma el
// servidor (preview_manual_order / create_manual_order): el precio y el total
// SIEMPRE salen de la lista del cliente, nunca de lo que diga el mensaje —
// que puede ser de ayer y estar desactualizado. Lo del mensaje se muestra al
// lado, solo para comparar.
//
// Desde 2026-08-18 (a pedido del usuario) el mismo modal también acepta el
// PDF de una cotización generado por la app (pestaña 📄): parseQuotePdf lee
// las líneas por posición de columna y acá se cruzan por UPC primero — el PDF
// recorta los nombres largos, pero el UPC viaja entero justamente para esto.
// Todo lo demás (cliente, revisión, precios del servidor, alta) es el mismo
// camino que el mensaje de WhatsApp; si la lista del cliente es de
// cotización, lo creado nace como cotización y se convierte en pedido con el
// botón de siempre de la bandeja.

// Ventana para avisar de un posible duplicado. Si el cliente ya tiene un
// pedido de hace poco, lo más probable es que sea justo este y que sí haya
// entrado: cargarlo de nuevo lo duplicaría sin que nadie se dé cuenta.
const DUP_HOURS = 48

const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g')
const norm = (s) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(DIACRITICS, '').replace(/\s+/g, ' ').trim()

export default function ManualOrderModal({ open, onClose, onCreated, initialTab = 'text' }) {
  const { t } = useI18n()
  const [tab, setTab] = useState(initialTab)
  const [text, setText] = useState('')
  // Qué PDF se leyó y qué decía: nombre del archivo para la nota del pedido,
  // total del PDF solo para comparar contra el que calcule el servidor.
  const [pdfInfo, setPdfInfo] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [lines, setLines] = useState([])
  const [clientQuery, setClientQuery] = useState('')
  const [clientOptions, setClientOptions] = useState([])
  const [clientId, setClientId] = useState('')
  const [recent, setRecent] = useState([])
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)
  // Un id por apertura del modal: si el alta falla por red y se reintenta, el
  // servidor devuelve el pedido ya creado en vez de uno nuevo.
  const [requestId, setRequestId] = useState(null)

  useEffect(() => {
    if (!open) return
    setTab(initialTab)
    setText('')
    setPdfInfo(null)
    setParsed(null)
    setLines([])
    setClientQuery('')
    setClientOptions([])
    setClientId('')
    setRecent([])
    setPreview(null)
    setError(null)
    setDone(null)
    setCalculating(false)
    setRequestId(crypto.randomUUID?.() ?? String(Math.random()).slice(2))
  }, [open, initialTab])

  // Clientes que matcheen lo tipeado. RLS ya recorta: una vendedora solo ve
  // los suyos, así que no hace falta filtrar por vendedora acá.
  useEffect(() => {
    if (!open) return
    const q = clientQuery.trim()
    if (q.length < 2) {
      setClientOptions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const { data } = await supabase
        .from('clients')
        .select('id, name, phone')
        .ilike('name', `%${q}%`)
        .order('name')
        .limit(20)
      if (!cancelled) setClientOptions(data ?? [])
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [clientQuery, open])

  // Pedidos recientes del cliente elegido, para avisar de un duplicado.
  useEffect(() => {
    if (!clientId) {
      setRecent([])
      return
    }
    const since = new Date(Date.now() - DUP_HOURS * 3600 * 1000).toISOString()
    supabase
      .from('orders')
      .select('id, created_at, total, kind, items')
      .eq('client_id', clientId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .then(({ data }) => setRecent(data ?? []))
  }, [clientId])

  const readMessage = async () => {
    setError(null)
    setPreview(null)
    setDone(null)
    const r = parseOrderMessage(text)
    setParsed(r)
    if (r.lines.length === 0) {
      setLines([])
      setError(t('manualOrderNoLines'))
      return
    }
    setBusy(true)
    try {
      if (r.clientName) setClientQuery(r.clientName)

      // Un solo viaje por todos los nombres del mensaje. El nombre que trae
      // el mensaje es exactamente `products.name` (así lo escribe el carrito),
      // así que el match exacto acierta salvo que el producto se haya
      // renombrado después.
      const names = [...new Set(r.lines.map((l) => l.name))]
      const { data: found, error: e } = await supabase
        .from('products')
        .select('id, name, sku, active')
        .in('name', names)
      if (e) throw e

      const byName = new Map()
      for (const p of found ?? []) {
        const k = norm(p.name)
        byName.set(k, [...(byName.get(k) ?? []), p])
      }

      setLines(
        r.lines.map((l, i) => {
          const cands = byName.get(norm(l.name)) ?? []
          return {
            key: `${i}-${l.name}`,
            raw: l,
            qty: l.qty,
            // Con un solo candidato se elige solo; con varios (hay nombres
            // repetidos entre SKU distintos) decide la persona.
            product: cands.length === 1 ? cands[0] : null,
            // Resultados a elegir: los del cruce por nombre o, si no hubo, los
            // que devuelva la búsqueda a mano.
            results: cands.length > 1 ? cands : [],
            search: '',
            searching: false,
            // Cada búsqueda lleva su número: solo la última que se pidió puede
            // escribir resultados. Sin esto, la respuesta de una pulsación
            // anterior llega tarde y pisa la lista (o la vacía) justo cuando la
            // persona está por elegir.
            seq: 0,
          }
        }),
      )
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  // Leer el PDF de la cotización. Mismo destino que readMessage (las mismas
  // `lines`), pero el cruce es distinto: primero por UPC —que el PDF imprime
  // entero aunque recorte el nombre—, después por nombre exacto, y para los
  // nombres recortados un último intento por prefijo. Lo que no se resuelva
  // queda en rojo con el buscador manual, igual que en el mensaje.
  const readPdf = async (file) => {
    if (!file) return
    setError(null)
    setPreview(null)
    setDone(null)
    setBusy(true)
    try {
      const r = await parseQuotePdf(await file.arrayBuffer())
      if (r.lines.length === 0) {
        setParsed(null)
        setLines([])
        setPdfInfo(null)
        setError(t('pdfOrderNoLines'))
        setBusy(false)
        return
      }
      setParsed({ clientName: r.clientName, unparsed: r.unparsed })
      setPdfInfo({ file: file.name, total: r.total })
      if (r.clientName) setClientQuery(r.clientName)

      // 1) por UPC, un solo viaje
      const upcs = [...new Set(r.lines.map((l) => l.upc).filter(Boolean))]
      const byUpc = new Map()
      if (upcs.length > 0) {
        const { data, error: e } = await supabase
          .from('products')
          .select('id, name, sku, upc, active')
          .in('upc', upcs)
        if (e) throw e
        for (const p of data ?? []) byUpc.set(p.upc, [...(byUpc.get(p.upc) ?? []), p])
      }

      // 2) por nombre exacto, un solo viaje, solo para lo que el UPC no cerró
      const namesLeft = [
        ...new Set(
          r.lines.filter((l) => !(l.upc && byUpc.get(l.upc)?.length)).map((l) => l.name),
        ),
      ]
      const byName = new Map()
      if (namesLeft.length > 0) {
        const { data, error: e } = await supabase
          .from('products')
          .select('id, name, sku, active')
          .in('name', namesLeft)
        if (e) throw e
        for (const p of data ?? []) {
          const k = norm(p.name)
          byName.set(k, [...(byName.get(k) ?? []), p])
        }
      }

      const built = r.lines.map((l, i) => {
        const upcCands = l.upc ? (byUpc.get(l.upc) ?? []) : []
        const nameCands = byName.get(norm(l.name)) ?? []
        const cands = upcCands.length > 0 ? upcCands : nameCands
        return {
          key: `${i}-${l.upc ?? l.name}`,
          raw: { name: l.name, qty: l.qty, price: l.price, flash: false },
          qty: l.qty,
          product: cands.length === 1 ? cands[0] : null,
          results: cands.length > 1 ? cands : [],
          search: '',
          searching: false,
          seq: 0,
        }
      })

      // 3) por prefijo, una consulta por línea todavía sin resolver: el PDF
      // corta los nombres largos a lo que entra en la columna, así que el
      // texto leído ES un prefijo del nombre real. Con tope, para no
      // acribillar la API si alguien sube un PDF gigante ilegible.
      const pending = built.filter((l) => !l.product && l.results.length === 0)
      for (const l of pending.slice(0, 12)) {
        const pattern = `${l.raw.name.replace(/[%_]/g, '\\$&')}%`
        const { data } = await supabase
          .from('products')
          .select('id, name, sku, active')
          .ilike('name', pattern)
          .order('name')
          .limit(5)
        if (data?.length === 1) l.product = data[0]
        else if (data?.length > 1) l.results = data
      }

      setLines(built)
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  const searchProduct = async (key, q) => {
    let mySeq = 0
    setLines((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l
        mySeq = (l.seq ?? 0) + 1
        return { ...l, search: q, seq: mySeq, searching: q.trim().length >= 3 }
      }),
    )
    if (q.trim().length < 3) {
      setLines((prev) => prev.map((l) => (l.key === key ? { ...l, results: [] } : l)))
      return
    }
    const { data } = await supabase
      .from('products')
      .select('id, name, sku, active')
      .ilike('name', `%${q.trim()}%`)
      .order('name')
      .limit(15)
    setLines((prev) =>
      prev.map((l) =>
        // Llegó tarde: ya se pidió otra búsqueda para esta línea.
        l.key === key && l.seq === mySeq ? { ...l, results: data ?? [], searching: false } : l,
      ),
    )
  }

  const pickProduct = (key, product) => {
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, product, results: [], search: '' } : l)),
    )
    setPreview(null)
  }

  const clearProduct = (key) => {
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, product: null, results: [], search: '' } : l)),
    )
    setPreview(null)
  }

  const itemsForServer = useMemo(
    () =>
      lines
        .filter((l) => l.product && l.qty > 0)
        .map((l) => ({ id: l.product.id, qty: Number(l.qty), flash: !!l.raw.flash })),
    [lines],
  )
  const unresolved = lines.filter((l) => !l.product).length
  const ready = !!clientId && unresolved === 0 && itemsForServer.length > 0
  // Firma estable de lo que se le va a pedir al servidor: si no cambia, no hay
  // por qué volver a preguntar.
  const itemsKey = JSON.stringify(itemsForServer)

  // Los precios se calculan solos en cuanto el pedido está completo
  // (2026-08-17, corrección). Antes había que tocar "Calcular precios" y
  // cualquier cambio posterior invalidaba el resultado en silencio: el botón
  // de crear se apagaba sin decir por qué y parecía que la pantalla estaba
  // trabada.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setCalculating(true)
      setError(null)
      const { data, error: e } = await supabase.rpc('preview_manual_order', {
        p_client_id: clientId,
        p_items: JSON.parse(itemsKey),
      })
      if (cancelled) return
      setCalculating(false)
      if (e) setError(e.message)
      else setPreview(data)
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ready, clientId, itemsKey])

  const create = async () => {
    setError(null)
    setBusy(true)
    // La nota guarda de dónde salió el pedido: el texto pegado, o qué PDF y
    // con qué total impreso (para poder auditar una diferencia después).
    const note =
      tab === 'pdf' && pdfInfo
        ? `PDF: ${pdfInfo.file}${pdfInfo.total != null ? ` (total impreso ${money(pdfInfo.total)})` : ''}`
        : text
    const { data, error: e } = await supabase.rpc('create_manual_order', {
      p_client_id: clientId,
      p_items: itemsForServer,
      p_request_id: requestId,
      p_note: note.slice(0, 4000),
    })
    setBusy(false)
    if (e) {
      setError(e.message)
      return
    }
    setDone(data)
    onCreated?.()
  }

  if (!open) return null

  const noPrice = preview?.no_price ?? []
  const dropped = preview?.dropped ?? []
  const canCreate = !!clientId && itemsForServer.length > 0 && !!preview && noPrice.length === 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-[2px] md:items-center md:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border-t-4 border-secondary bg-surface shadow-2xl md:rounded-3xl md:border-t-0"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="font-brand text-lg font-semibold">{t('manualOrderTitle')}</h3>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-xl leading-none text-primary/50 transition-colors hover:bg-primary/10 hover:text-primary"
            aria-label="close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {done ? (
            <div className="space-y-3 py-6 text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gold-pale text-2xl font-bold text-secondary-dark">
                ✓
              </span>
              <p className="font-brand text-base font-semibold">
                {done.already_existed ? t('manualOrderAlreadyExisted') : t('manualOrderCreated')}
              </p>
              {done.total != null && <p className="text-sm text-primary/60">{money(done.total)}</p>}
              <button
                onClick={onClose}
                className="mt-2 rounded-xl border-2 border-primary px-5 py-2 text-sm font-semibold transition-colors hover:bg-ink hover:text-secondary"
              >
                {t('manualOrderClose')}
              </button>
            </div>
          ) : (
            <>
              {/* De dónde viene el pedido: el mensaje pegado o el PDF de la
                  cotización. Cambiar de pestaña no borra lo ya leído — solo
                  cambia el formulario de entrada. */}
              <div className="flex gap-1.5">
                {['text', 'pdf'].map((k) => (
                  <button
                    key={k}
                    onClick={() => setTab(k)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                      tab === k
                        ? 'bg-secondary text-ink'
                        : 'border border-line text-primary/60 hover:border-secondary hover:text-primary'
                    }`}
                  >
                    {k === 'text' ? t('manualTabText') : t('manualTabPdf')}
                  </button>
                ))}
              </div>

              {tab === 'text' ? (
                <>
                  <p className="text-sm leading-relaxed text-primary/70">{t('manualOrderIntro')}</p>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={parsed ? 4 : 9}
                    placeholder={t('manualOrderPastePlaceholder')}
                    className={`${inputCls} w-full font-mono text-xs`}
                  />
                  <button
                    onClick={readMessage}
                    disabled={busy || !text.trim()}
                    className="rounded-xl bg-ink px-4 py-2 text-sm font-bold text-secondary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('manualOrderRead')}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm leading-relaxed text-primary/70">{t('pdfOrderIntro')}</p>
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-ink px-4 py-2 text-sm font-bold text-secondary transition-opacity hover:opacity-90">
                    {busy ? t('loading') : t('pdfOrderPick')}
                    <input
                      type="file"
                      accept="application/pdf,.pdf"
                      className="hidden"
                      disabled={busy}
                      onChange={(e) => {
                        readPdf(e.target.files?.[0])
                        // Permite volver a elegir el MISMO archivo (corregido
                        // el producto en el catálogo, se re-sube): sin esto el
                        // onChange no dispara porque el value no cambió.
                        e.target.value = ''
                      }}
                    />
                  </label>
                  {pdfInfo && (
                    <p className="text-xs text-primary/60">
                      ✓ {t('pdfOrderRead', { file: pdfInfo.file })}
                      {pdfInfo.total != null && ` · ${t('total')}: ${money(pdfInfo.total)}`}
                    </p>
                  )}
                </>
              )}

              {parsed && (
                <>
                  {/* ---- Cliente ---- */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold uppercase tracking-wide text-primary/60">
                      {t('client')}
                    </label>
                    {/* Elegido: se ve con ✓, igual que las líneas. El campo de
                        texto solo tiene el nombre precargado del mensaje, y
                        que se vea escrito no significa que esté elegido —
                        confundir las dos cosas dejaba el pedido sin poder
                        crearse sin ninguna explicación. */}
                    {clientId ? (
                      <div className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                        <p className="min-w-0 flex-1 text-sm">
                          <span className="font-bold text-green-700">✓</span> {clientQuery}
                        </p>
                        <button
                          onClick={() => {
                            setClientId('')
                            setPreview(null)
                          }}
                          className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-primary/50 transition-colors hover:border-secondary hover:text-primary"
                        >
                          {t('manualOrderChange')}
                        </button>
                      </div>
                    ) : (
                      <input
                        value={clientQuery}
                        onChange={(e) => {
                          setClientQuery(e.target.value)
                          setClientId('')
                          setPreview(null)
                        }}
                        placeholder={t('manualOrderSearchClient')}
                        className={`${inputCls} w-full`}
                        autoComplete="off"
                      />
                    )}
                    {clientOptions.length > 0 && !clientId && (
                      <ul className="max-h-40 overflow-y-auto rounded-xl border border-line">
                        {clientOptions.map((c) => (
                          <li key={c.id}>
                            <button
                              onClick={() => {
                                setClientId(c.id)
                                setClientQuery(c.name)
                                setPreview(null)
                              }}
                              className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-gold-pale/50"
                            >
                              {c.name}
                              {c.phone && <span className="ml-2 text-primary/40">{c.phone}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {recent.length > 0 && (
                    <div className="rounded-xl border-2 border-secondary bg-gold-pale/50 p-3">
                      <p className="text-xs font-bold uppercase tracking-wide text-secondary-dark">
                        ⚠️ {t('manualOrderDuplicate', { n: recent.length, h: DUP_HOURS })}
                      </p>
                      <ul className="mt-1.5 space-y-0.5 text-xs text-primary/70">
                        {recent.slice(0, 5).map((o) => (
                          <li key={o.id}>
                            {new Date(o.created_at).toLocaleString()} ·{' '}
                            {Array.isArray(o.items) ? o.items.length : 0} {t('items')}
                            {o.total != null && ` · ${money(o.total)}`}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* ---- Líneas ---- */}
                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wide text-primary/60">
                      {t('manualOrderLines')} ({lines.length})
                    </p>
                    {lines.map((l) => (
                      <div
                        key={l.key}
                        className={`rounded-xl border p-3 ${
                          l.product ? 'border-line' : 'border-red-400 bg-red-50/50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 flex-1 text-sm font-medium">
                            {l.raw.flash && <span className="mr-1 text-secondary-dark">⚡</span>}
                            {l.raw.name}
                          </p>
                          <input
                            type="number"
                            min="1"
                            value={l.qty}
                            onChange={(e) => {
                              const q = Number(e.target.value)
                              setLines((prev) =>
                                prev.map((x) => (x.key === l.key ? { ...x, qty: q } : x)),
                              )
                              setPreview(null)
                            }}
                            className={`${inputCls} w-20 text-right`}
                          />
                          <button
                            onClick={() => {
                              setLines((prev) => prev.filter((x) => x.key !== l.key))
                              setPreview(null)
                            }}
                            className="rounded-lg border border-line px-2 py-1 text-xs text-primary/50 transition-colors hover:border-red-400 hover:text-red-600"
                          >
                            {t('manualOrderRemove')}
                          </button>
                        </div>

                        {/* Resuelta: se ve QUÉ producto quedó, con un botón
                            para cambiarlo. Sin resolver: buscador + lista de
                            resultados en la que se elige con un click. No hay
                            desplegable: el <select> obligaba a abrirlo para
                            elegir y quedaba diciendo "elegir producto" aunque
                            ya hubieras buscado. */}
                        {l.product ? (
                          <div className="mt-1.5 flex items-center gap-2">
                            <p className="min-w-0 flex-1 text-xs text-primary/70">
                              <span className="font-bold text-green-700">✓</span> {l.product.name}
                              <span className="ml-1.5 text-primary/40">{l.product.sku}</span>
                              {!l.product.active && (
                                <span className="ml-1.5 text-red-700">({t('inactive')})</span>
                              )}
                              {l.raw.price != null && (
                                <span className="ml-2 text-primary/40">
                                  {t('manualOrderMsgPrice')}: {money(l.raw.price)}
                                </span>
                              )}
                            </p>
                            <button
                              onClick={() => clearProduct(l.key)}
                              className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-primary/50 transition-colors hover:border-secondary hover:text-primary"
                            >
                              {t('manualOrderChange')}
                            </button>
                          </div>
                        ) : (
                          <div className="mt-2 space-y-1.5">
                            <p className="text-xs font-semibold text-red-700">
                              {t('manualOrderNotFound')}
                            </p>
                            <input
                              value={l.search}
                              onChange={(e) => searchProduct(l.key, e.target.value)}
                              placeholder={t('manualOrderSearchProduct')}
                              className={`${inputCls} w-full`}
                              autoComplete="off"
                            />
                            {l.searching && (
                              <p className="text-xs text-primary/40">{t('loading')}</p>
                            )}
                            {!l.searching && l.results.length === 0 && l.search.trim().length >= 3 && (
                              <p className="text-xs text-primary/40">{t('manualOrderNoResults')}</p>
                            )}
                            {l.results.length > 0 && (
                              <ul className="max-h-44 overflow-y-auto rounded-xl border border-line bg-surface">
                                {l.results.map((c) => (
                                  <li key={c.id}>
                                    <button
                                      onClick={() => pickProduct(l.key, c)}
                                      className="w-full px-3 py-2 text-left text-xs transition-colors hover:bg-gold-pale/50"
                                    >
                                      {c.name}
                                      <span className="ml-1.5 text-primary/40">{c.sku}</span>
                                      {!c.active && (
                                        <span className="ml-1.5 text-red-700">({t('inactive')})</span>
                                      )}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {parsed.unparsed?.length > 0 && (
                    <div className="rounded-xl border border-secondary bg-gold-pale/40 p-3">
                      <p className="text-xs font-bold uppercase tracking-wide text-secondary-dark">
                        {t('manualOrderUnparsed')}
                      </p>
                      <ul className="mt-1 space-y-0.5 font-mono text-xs text-primary/70">
                        {parsed.unparsed.map((u, i) => (
                          <li key={i}>{u}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* ---- Precios del servidor ---- */}
                  {preview && (
                    <div className="rounded-xl border border-line bg-bg p-3">
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs font-bold uppercase tracking-wide text-primary/60">
                          {preview.kind === 'quote' ? t('quote') : t('order')} ·{' '}
                          {preview.items?.length ?? 0} {t('items')}
                        </span>
                        <span className="font-brand text-xl font-semibold">
                          {preview.total != null ? money(preview.total) : '—'}
                        </span>
                      </div>
                      {/* El total impreso en el PDF es de cuando se generó la
                          cotización; el que vale es el recalculado de arriba.
                          Si difieren, mejor verlo ANTES de crear el pedido. */}
                      {pdfInfo?.total != null && preview.total != null && (
                        <p
                          className={`mt-1 text-xs ${
                            Math.abs(pdfInfo.total - preview.total) > 0.005
                              ? 'font-semibold text-secondary-dark'
                              : 'text-primary/50'
                          }`}
                        >
                          {t('pdfOrderTotalCompare', { total: money(pdfInfo.total) })}
                        </p>
                      )}
                      {dropped.length > 0 && (
                        <p className="mt-2 text-xs font-semibold text-red-700">
                          {t('manualOrderDropped', { n: dropped.length })}
                        </p>
                      )}
                      {noPrice.length > 0 && (
                        <p className="mt-2 text-xs font-semibold text-red-700">
                          {t('manualOrderNoPrice')} {noPrice.join(', ')}
                        </p>
                      )}
                    </div>
                  )}

                  {calculating && (
                    <p className="text-xs text-primary/50">{t('manualOrderCalculating')}</p>
                  )}

                  {/* Por qué todavía no se puede crear. Siempre visible: un
                      botón apagado sin motivo es lo que hacía parecer que la
                      pantalla estaba trabada. */}
                  {unresolved > 0 && (
                    <p className="text-xs font-semibold text-red-700">
                      {t('manualOrderPending', { n: unresolved })}
                    </p>
                  )}
                  {unresolved === 0 && !clientId && (
                    <p className="text-xs font-semibold text-red-700">{t('manualOrderPickClient')}</p>
                  )}
                </>
              )}

              {error && (
                <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        {!done && parsed && (
          <div className="border-t border-line p-4">
            <button
              onClick={create}
              disabled={busy || !canCreate}
              className="w-full rounded-xl bg-[#25D366] py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy
                ? t('loading')
                : calculating
                  ? t('manualOrderCalculating')
                  : `${t('manualOrderCreate')}${
                      preview?.total != null ? ` · ${money(preview.total)}` : ''
                    }`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
