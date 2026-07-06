import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import Catalog from './pages/Catalog'

// El panel admin se carga bajo demanda: los clientes solo descargan el catálogo.
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const ProductsAdmin = lazy(() => import('./pages/admin/ProductsAdmin'))
const PricesUpload = lazy(() => import('./pages/admin/PricesUpload'))
const ClientsAdmin = lazy(() => import('./pages/admin/ClientsAdmin'))
const VendedorasAdmin = lazy(() => import('./pages/admin/VendedoresAdmin'))
const FlashSalesAdmin = lazy(() => import('./pages/admin/FlashSalesAdmin'))
const OrdersAdmin = lazy(() => import('./pages/admin/OrdersAdmin'))

// Fallback de Suspense: sin esto, /admin queda en blanco mientras baja el chunk.
function PageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-secondary/25 border-t-secondary" />
    </div>
  )
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Catalog />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<ProductsAdmin />} />
          <Route path="prices" element={<PricesUpload />} />
          <Route path="clients" element={<ClientsAdmin />} />
          <Route path="vendedoras" element={<VendedorasAdmin />} />
          <Route path="flash" element={<FlashSalesAdmin />} />
          <Route path="orders" element={<OrdersAdmin />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
