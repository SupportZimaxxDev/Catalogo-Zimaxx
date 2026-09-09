import { useState } from 'react'
import { useI18n } from '../i18n'
import { downloadPriceListExcel, fileSlug, priceListExcelRows } from '../utils/excel'
import { logEvent } from '../utils/systemLog'

// "¿Prefieres verlo en Excel?" (2026-09-08, a pedido del usuario): algunos
// clientes —los de más edad sobre todo— se resisten al link y siguen pidiendo
// la lista de precios "en Excel como siempre". Este bloque les baja SU lista
// completa (todos los productos que ven en el catálogo, con sus precios) en un
// .xlsx, para no perder la venta mientras se acostumbran. Es un puente a
// propósito: cuando dejen de usarlo se saca este componente y nada más.
//
// Se arma en el navegador con lo que ya devolvió get_catalog — sin RPC ni
// migración: el archivo dice exactamente lo mismo que la pantalla. SheetJS se
// carga bajo demanda al tocar el botón, igual que jsPDF en el carrito, así el
// bundle inicial del catálogo no engorda. Cada descarga deja un `info` en
// system_logs (source `catalog`) para saber quién sigue pidiendo el Excel y
// cuándo se puede retirar.
export default function PriceListExcel({ token, client, products, lineLabel }) {
  const { t, lang } = useI18n()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  if (!client || !products?.length) return null
  // Lista `quote`: catálogo sin precios. El archivo sale igual (sirve como
  // listado), pero se llama "catálogo" y no "lista de precios".
  const hasPrices = products.some((p) => p.price != null)
  const kindKey = hasPrices ? 'excelListSheet' : 'catalog'

  const download = async () => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    const tokenHint = String(token ?? '').slice(0, 8)
    try {
      const stamp = new Date()
      const metaLines = [
        `${t('client')}: ${client.name}`,
        client.vendedora
          ? `${t('excelSalesRep')}: ${client.vendedora}${client.vendedora_phone ? ` · ${client.vendedora_phone}` : ''}`
          : null,
        `${t('excelGeneratedAt')}: ${stamp.toLocaleString()}`,
      ].filter(Boolean)
      await downloadPriceListExcel({
        ...priceListExcelRows({ t, products, lineLabel }),
        title: `Zimaxx Store — ${t(kindKey)}`,
        metaLines,
        sheetName: t(kindKey),
        filename: `zimaxx-${hasPrices ? 'lista-precios' : 'catalogo'}-${fileSlug(client.name)}-${stamp
          .toISOString()
          .slice(0, 10)}.xlsx`,
      })
      logEvent('info', 'catalog', 'price_list_excel_downloaded', `${client.name}: ${products.length} productos`, {
        token_hint: tokenHint,
        client: client.name,
        price_list_code: client.price_list_code,
        products: products.length,
        lang,
      })
    } catch (err) {
      // Igual que el PDF del carrito: el import dinámico puede fallar con mala
      // señal. Se avisa y se deja reintentar; el botón nunca queda trabado.
      setFailed(true)
      logEvent('warning', 'catalog', 'price_list_excel_failed', err?.message, {
        token_hint: tokenHint,
        client: client.name,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label={t('excelListTitle')}
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm"
    >
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-sm font-semibold text-primary">📊 {t('excelListTitle')}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-primary/60">
          {t(hasPrices ? 'excelListHint' : 'excelListHintNoPrices')}
        </p>
      </div>
      <button
        onClick={download}
        disabled={busy}
        className="shrink-0 rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-secondary transition-colors hover:bg-secondary hover:text-ink disabled:opacity-50"
      >
        {busy ? t('excelListBusy') : `⬇️ ${t('excelListButton')}`}
      </button>
      {failed && (
        <p className="w-full text-xs text-red-600 dark:text-red-400" role="alert">
          {t('excelListFailed')}
        </p>
      )}
    </section>
  )
}
