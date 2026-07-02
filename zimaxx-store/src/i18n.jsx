import { createContext, useContext, useMemo, useState } from 'react'

// Diccionario simple es/en. Sin librería de i18n: objeto plano + hook.
const dict = {
  es: {
    // Header / general
    search: 'Buscar producto...',
    allCategories: 'Todas',
    catalog: 'Catálogo',
    loading: 'Cargando...',
    noProducts: 'No hay productos para mostrar.',
    invalidLink:
      'Este link no es válido o expiró. Pide a tu vendedora tu link personalizado para ver el catálogo con tus precios.',
    welcome: 'Hola',
    poweredPrices: 'Precios de tu lista asignada',
    tagline: 'Fragancias al por mayor',
    results: 'resultados',
    loadMore: 'Ver más productos',
    preorder: 'Pre-Order',
    minOrderIs: 'El pedido mínimo es',
    missingForMin: 'Te faltan',

    // Flash sale
    flashSale: 'Flash Sale',
    flashEnds: 'Termina en',
    days: 'd',
    flashOnly: 'Oferta por tiempo limitado',

    // Cart
    add: 'Agregar',
    addToCart: 'Agregar al carrito',
    viewCart: 'Ver carrito',
    cart: 'Carrito',
    emptyCart: 'Tu carrito está vacío.',
    subtotal: 'Subtotal',
    total: 'Total',
    quantity: 'Cantidad',
    remove: 'Quitar',
    clearCart: 'Vaciar carrito',
    continueShopping: 'Seguir comprando',

    // Checkout
    checkout: 'Enviar pedido por WhatsApp',
    downloadPdf: 'Descargar PDF',
    orderTitle: 'Pedido Zimaxx Store',
    quoteTitle: 'Solicitud de cotización',
    client: 'Cliente',
    product: 'Producto',
    unitPrice: 'Precio unit.',
    orderSent: 'Pedido registrado. Se abrió WhatsApp para enviarlo.',
    orderGreeting: 'Hola! Te envío mi pedido:',
    quoteGreeting: 'Hola! Quiero cotizar estos productos:',

    // Special order
    specialMode: 'Pedido especial',
    specialHint:
      'Arma tu lista de productos deseados y solicita tu cotización personalizada. Tu vendedora te responderá con los precios.',
    requestQuote: 'Solicitar cotización personalizada',

    // Admin
    adminTitle: 'Panel admin',
    email: 'Email',
    password: 'Contraseña',
    signIn: 'Ingresar',
    signOut: 'Salir',
    notAdmin: 'Este usuario no tiene permisos de administrador.',
    products: 'Productos',
    prices: 'Precios',
    clients: 'Clientes',
    orders: 'Pedidos',
    flashSales: 'Flash Sales',
    save: 'Guardar',
    cancel: 'Cancelar',
    edit: 'Editar',
    newProduct: 'Nuevo producto',
    name: 'Nombre',
    category: 'Categoría',
    imageUrl: 'URL de imagen',
    active: 'Activo',
    inactive: 'Inactivo',
    uploadExcel: 'Subir Excel',
    processing: 'Procesando...',
    priceUploadHint:
      'Excel/CSV con columna SKU y una columna por lista de precio (US Minimum Order, US Wholesale, VE Minimum Order, VE Wholesale).',
    productUploadHint:
      'Excel/CSV con columnas: nombre (o Title Product), categoría (o Brand), imagen (URL), Type (Available / Pre Order), activo y opcional SKU. Acepta las listas wholesale con membrete: detecta la fila de encabezados y la columna de fotos automáticamente. El SKU es interno, nunca se muestra al cliente; si falta se genera uno. Actualiza existentes por SKU y crea los nuevos; los campos que el archivo no trae no se tocan.',
    imageUploadHint:
      'Excel/CSV solo para fotos: columnas SKU y/o nombre + una columna con el link directo a la imagen (debe terminar en .jpg/.png/etc., no un link a un panel administrativo). Cruza con productos ya cargados y actualiza su foto; no crea productos nuevos.',
    clientUploadHint:
      'Excel/CSV con columnas: nombre, teléfono, lista de precio, vendedora (y opcional: teléfono vendedora). También acepta el export del sistema anterior (BusinessName/FirstName+LastName, Phone/Phone1, SalesMan, Comments con Mayorista/Minorista → wholesale/min, todos a listas "us_"; Comments = Inactive se excluye). Crea clientes nuevos con token automático y actualiza existentes por teléfono. Nunca borra clientes.',
    created: 'creados',
    updated: 'actualizados',
    skipped: 'omitidos',
    junkExcluded: 'filas internas excluidas (pruebas/soporte)',
    notMatched: 'sin producto coincidente',
    invalidImageLink: 'links inválidos ignorados (apuntan a un panel admin, no a una foto)',
    inactiveExcluded: 'clientes inactivos excluidos',
    bulkUpload: 'Carga masiva por Excel',
    imageUpload: 'Fotos por Excel',
    searchProducts: 'Buscar por nombre o SKU...',
    searchClients: 'Buscar por nombre, teléfono o vendedora...',
    allStatuses: 'Todos los estados',
    allLists: 'Todas las listas',
    allReps: 'Todas las vendedoras',
    uncategorized: 'Sin categoría',
    noImage: 'Sin foto',
    showingFirst: 'Mostrando primeros',
    refineSearch: 'afiná la búsqueda para ver el resto',
    investmentPlaceholder: '$ inversión → nivel',
    investmentHint:
      'Monto que el cliente va a invertir: hasta $1,999 → Minimum Order, $2,000+ → Wholesale, $15,000+ → Special. Enter para aplicar.',
    targetListLabel: 'Lista destino (para archivos con una sola columna "Price")',
    priceMatrixTitle: 'Precios por lista',
    onlyWithoutPrices: 'Solo sin precios',
    chooseTargetList:
      'Este archivo trae una sola columna de precio: elegí arriba la lista destino y volvé a subirlo.',
    copyLink: 'Copiar link',
    copied: 'Copiado',
    expiresAt: 'Expira',
    startsAt: 'Empieza',
    promoPrice: 'Precio promo',
    selectProduct: 'Seleccionar producto',
    deactivate: 'Desactivar',
    noOrders: 'Aún no hay pedidos registrados.',
    date: 'Fecha',
    type: 'Tipo',
    order: 'Pedido',
    quote: 'Cotización',
    items: 'Ítems',
  },
  en: {
    search: 'Search products...',
    allCategories: 'All',
    catalog: 'Catalog',
    loading: 'Loading...',
    noProducts: 'No products to show.',
    invalidLink:
      'This link is invalid or expired. Ask your sales rep for your personal link to see the catalog with your prices.',
    welcome: 'Hi',
    poweredPrices: 'Prices from your assigned list',
    tagline: 'Wholesale fragrances',
    results: 'results',
    loadMore: 'Load more products',
    preorder: 'Pre-Order',
    minOrderIs: 'Minimum order is',
    missingForMin: 'You need',

    flashSale: 'Flash Sale',
    flashEnds: 'Ends in',
    days: 'd',
    flashOnly: 'Limited-time offer',

    add: 'Add',
    addToCart: 'Add to cart',
    viewCart: 'View cart',
    cart: 'Cart',
    emptyCart: 'Your cart is empty.',
    subtotal: 'Subtotal',
    total: 'Total',
    quantity: 'Quantity',
    remove: 'Remove',
    clearCart: 'Clear cart',
    continueShopping: 'Continue shopping',

    checkout: 'Send order via WhatsApp',
    downloadPdf: 'Download PDF',
    orderTitle: 'Zimaxx Store Order',
    quoteTitle: 'Quote request',
    client: 'Client',
    product: 'Product',
    unitPrice: 'Unit price',
    orderSent: 'Order saved. WhatsApp was opened to send it.',
    orderGreeting: 'Hello! Here is my order:',
    quoteGreeting: 'Hello! I would like a quote for these products:',

    specialMode: 'Special order',
    specialHint:
      'Build your wishlist and request a personalized quote. Your sales rep will reply with prices.',
    requestQuote: 'Request personalized quote',

    adminTitle: 'Admin panel',
    email: 'Email',
    password: 'Password',
    signIn: 'Sign in',
    signOut: 'Sign out',
    notAdmin: 'This user has no admin permissions.',
    products: 'Products',
    prices: 'Prices',
    clients: 'Clients',
    orders: 'Orders',
    flashSales: 'Flash Sales',
    save: 'Save',
    cancel: 'Cancel',
    edit: 'Edit',
    newProduct: 'New product',
    name: 'Name',
    category: 'Category',
    imageUrl: 'Image URL',
    active: 'Active',
    inactive: 'Inactive',
    uploadExcel: 'Upload Excel',
    processing: 'Processing...',
    priceUploadHint:
      'Excel/CSV with a SKU column plus one column per price list (US Minimum Order, US Wholesale, VE Minimum Order, VE Wholesale).',
    productUploadHint:
      'Excel/CSV with columns: name (or Title Product), category (or Brand), image (URL), Type (Available / Pre Order), active, and optional SKU. Accepts letterhead wholesale lists: header row and photo column are detected automatically. SKU is internal and never shown to clients; missing SKUs are generated. Updates existing products by SKU and creates new ones; fields the file lacks are left untouched.',
    imageUploadHint:
      'Photos-only Excel/CSV: SKU and/or name columns plus a column with the direct image link (must end in .jpg/.png/etc., not a link to an admin panel). Matches existing products and updates their photo; never creates new products.',
    clientUploadHint:
      'Excel/CSV with columns: name, phone, price list, sales rep (optional: rep phone). Also accepts the legacy system export (BusinessName/FirstName+LastName, Phone/Phone1, SalesMan, Comments with Mayorista/Minorista → wholesale/min, all mapped to "us_" lists; Comments = Inactive is excluded). Creates new clients with auto tokens and updates existing ones matched by phone. Never deletes clients.',
    created: 'created',
    updated: 'updated',
    skipped: 'skipped',
    junkExcluded: 'internal rows excluded (test/support)',
    notMatched: 'no matching product',
    invalidImageLink: 'invalid links ignored (point to an admin panel, not a photo)',
    inactiveExcluded: 'inactive clients excluded',
    bulkUpload: 'Bulk upload via Excel',
    imageUpload: 'Photos via Excel',
    searchProducts: 'Search by name or SKU...',
    searchClients: 'Search by name, phone or rep...',
    allStatuses: 'All statuses',
    allLists: 'All lists',
    allReps: 'All reps',
    uncategorized: 'Uncategorized',
    noImage: 'No photo',
    showingFirst: 'Showing first',
    refineSearch: 'refine your search to see the rest',
    investmentPlaceholder: '$ investment → tier',
    investmentHint:
      'Amount the client will invest: up to $1,999 → Minimum Order, $2,000+ → Wholesale, $15,000+ → Special. Press Enter to apply.',
    targetListLabel: 'Target list (for files with a single "Price" column)',
    priceMatrixTitle: 'Prices by list',
    onlyWithoutPrices: 'Only without prices',
    chooseTargetList:
      'This file has a single price column: choose the target list above and upload again.',
    copyLink: 'Copy link',
    copied: 'Copied',
    expiresAt: 'Expires',
    startsAt: 'Starts',
    promoPrice: 'Promo price',
    selectProduct: 'Select product',
    deactivate: 'Deactivate',
    noOrders: 'No orders yet.',
    date: 'Date',
    type: 'Type',
    order: 'Order',
    quote: 'Quote',
    items: 'Items',
  },
}

const LanguageContext = createContext(null)

function detectLang() {
  const saved = localStorage.getItem('zimaxx_lang')
  if (saved === 'es' || saved === 'en') return saved
  return (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en'
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(detectLang)

  const value = useMemo(() => {
    const setLang = (l) => {
      localStorage.setItem('zimaxx_lang', l)
      setLangState(l)
    }
    const t = (key) => dict[lang]?.[key] ?? dict.en[key] ?? key
    return { lang, setLang, t }
  }, [lang])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useI18n() {
  return useContext(LanguageContext)
}
