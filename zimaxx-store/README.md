# Zimaxx Store

Catálogo B2B de fragancias al por mayor para **Zimaxx Perfumes**. Cada cliente
recibe un link único por WhatsApp (`https://zimaxxstore.com/?c=<token>`) que
abre el catálogo con **los precios de su lista asignada**, arma su carrito y
envía el pedido directo a su vendedora.

**Stack:** React 18 + Vite · Tailwind CSS v4 · Supabase (Postgres + Auth +
RPC) · SheetJS (Excel) · jsPDF · Netlify (deploy).

---

## 1. Modelo de negocio implementado

### Listas de precios (niveles por inversión)

Dos regiones × dos niveles + una lista Special general (sin región):

| Código | Lista | Quién |
|---|---|---|
| `us_min` | US Minimum Order | Invierte $800 – $1,999 |
| `us_wholesale` | US Wholesale | Invierte $2,000 – $14,999 |
| `ve_min` | VE Minimum Order | Ídem, facturado en Venezuela |
| `ve_wholesale` | VE Wholesale | Ídem, facturado en Venezuela |
| `special` | Special Order | Invierte $15,000+ (**cualquier región**), precio propio |

- **Región**: `ve_*` es exclusivamente para clientes facturados en Venezuela;
  `us_*` abarca todo el resto del mundo (aunque envíen a Miami). **Special no
  distingue región**: a partir de $15,000 es la misma lista sea cual sea el
  país del cliente.
- **El token no cambia al cambiar de lista**: identifica al cliente, y la
  lista se resuelve al abrir el catálogo. Cambiar la lista en el admin
  actualiza al instante lo que ve el mismo link.
- **Pedido mínimo $800**: el checkout se bloquea por debajo (configurable
  con `VITE_MIN_ORDER` en `.env`). Aplica también a Special.

### Productos

- El **SKU es 100% interno** (es el ProductID de SellerCloud): nunca viaja
  al navegador del cliente ni aparece en WhatsApp/PDF.
- **Disponibilidad**: `available` o `preorder`. Los pre-order se muestran
  con badge dorado "Pre-Order" en el catálogo y se pueden pedir igual; el
  estado viaja en el mensaje de WhatsApp.
- Un producto **solo aparece** en el catálogo de un cliente si tiene precio
  cargado en su lista (las 5 listas, incluida Special, se tratan igual).
- El tamaño va dentro del nombre (ej. "Khamrah 3.4 Oz Edp Unisex"); la
  categoría es la marca (Brand).

### Flujo del pedido

1. Cliente abre su link → catálogo con sus precios → arma carrito.
2. Checkout → el pedido queda registrado en `orders` (auditoría) → se abre
   WhatsApp con el pedido armado, dirigido a su vendedora (`vendedora_phone`,
   con fallback `VITE_DEFAULT_WHATSAPP`).
3. Opcional: descarga PDF del pedido.
4. Pendiente (planificado): push automático a SellerCloud como orden On Hold
   vía Supabase Edge Function — ver sección 7.

---

## 2. Panel admin (`/admin`)

Login con email/password (Supabase Auth). Dos roles, resueltos por el RPC
`get_my_role()`:

- **Admin** (tabla `admins`): acceso total (lectura y escritura) a las 7
  pestañas.
- **Vendedora** (`vendedores.user_id` vinculado a un login): ve **solo
  sus propios clientes y pedidos** (RLS filtra por fila, no por UI —
  nunca ve cuántos clientes/pedidos tienen otras vendedoras), y Productos
  / Precios / Flash Sales **de solo lectura** (sin botones de carga ni
  edición). No tiene pestaña Vendedoras.

Pestañas:

| Pestaña | Qué hace |
|---|---|
| **Productos** | Tabla completa con buscador (nombre/SKU), filtros (categoría, activo/inactivo/sin foto/pre-order), contadores clickeables de "sin foto" y "Pre-Order", miniaturas, alta/edición manual, y dos cargas por Excel (productos y fotos). |
| **Precios** | Carga de Excel de precios + **matriz de precios por lista** (producto × 5 listas: 4 regionales + Special) con buscador y botones con contador "con precios" / "sin precios". |
| **Clientes** | Tabla con buscador (nombre/teléfono/vendedora), filtros por lista y vendedora, **selector de lista por fila** y campo **"$ inversión → nivel"** (asigna el nivel automáticamente), botón copiar link, carga por Excel. |
| **Vendedoras** (solo admin) | Alta manual (nombre + teléfono), edición del teléfono en un click, contador de clientes asignados. El link de WhatsApp del checkout de cada cliente usa el teléfono de acá. Columna **Acceso**: vincula el login de la vendedora escribiendo su email y presionando "Vincular acceso" (RPC `link_vendedora_login`) — requiere haber creado antes ese usuario en Supabase Auth. "Desvincular" le quita el acceso sin borrar la vendedora. |
| **Flash Sales** | Crear ofertas con precio promo y vencimiento; visibles para todos con countdown; se ocultan solas al expirar. |
| **Pedidos** | Últimos 200 con detalle expandible; cada pedido se marca **Nuevo/Atendido** y el menú muestra el contador de pedidos sin atender. |

Las tablas grandes usan **scroll infinito** (lotes de 100) y todas las
consultas están **paginadas** para superar el límite de 1,000 filas por
consulta de Supabase.

---

## 3. Formatos de Excel aceptados

El parser detecta automáticamente la **fila de encabezados** (los exports
reales traen membrete arriba) y normaliza los nombres de columna (mayúsculas,
acentos, espacios). Alias en español e inglés.

### Productos (📦 en pestaña Productos)

Acepta tanto un Excel simple como el export de SellerCloud o la lista
wholesale con membrete:

- **SKU** (`sku`, `codigo`, `ProductID`) — opcional; si falta se autogenera.
- **Nombre** (`nombre`, `name`, `ProductName`, `Title Product`) — obligatorio.
- **Categoría** (`categoria`, `category`, `Brand`, `marca`).
- **Imagen** (`imagen`, `image`, `url`...) — también se detecta una columna
  de URLs de foto aunque tenga encabezado inservible (ej. `Column1`).
- **Type** (`type`, `tipo`, `disponibilidad`): `Available` / `Pre Order`
  (`Flash Sale` se trata como disponible).
- **Activo** (`activo`, `active`): `no/false/0/inactivo` desactiva.

Actualiza existentes por SKU y crea los nuevos. **Los campos que el archivo
no trae no se tocan** (re-subir un export sin fotos no borra las fotos).
Filas basura de sistemas de inventario (Skustack, Support-Test, Discount) se
excluyen automáticamente, igual que links al panel de SellerCloud colados
como si fueran fotos.

### Fotos (🖼️ en pestaña Productos)

Excel con SKU y/o nombre + columna con el link directo a la imagen
(`.jpg/.png/...`). Solo actualiza fotos de productos existentes, nunca crea.

### Precios (pestaña Precios)

Dos formatos:
1. **Multi-lista**: columna SKU + una columna por lista (`US Minimum Order`,
   `US Wholesale`, `VE Minimum Order`, `VE Wholesale`, `Special`). Celdas
   vacías se ignoran.
2. **Lista general** (una sola columna `Price`): elegir la **lista destino**
   en el selector antes de subir (Special es una opción más).

La matriz de precios tiene botones con contador para ver solo productos
**con precio** o **sin precio** (según la lista seleccionada en el filtro).

### Clientes (pestaña Clientes)

Acepta el Excel simple (`nombre`, `telefono`, `lista de precio`, `vendedora`,
`telefono vendedora`) **o el export de SellerCloud** (BusinessName /
FirstName+LastName, Phone/Phone1, SalesMan, Country, Comments):

- `Comments` mapea el nivel: Minorista → min · Mayorista → wholesale ·
  Distribuidor/Gran Mayorista/Especial → **special** (una sola lista, sin
  región) · **Inactive → se excluye**.
- `Country` = Venezuela → listas `ve_*`; cualquier otro país → `us_*`
  (no aplica a Special, que es la misma lista para cualquier país).
- `vendedora`/`telefono vendedora` (o `SalesMan`) resuelven contra la tabla
  `vendedores` por nombre (sin distinguir mayúsculas): si no existe una con
  ese nombre se crea sobre la marcha. Re-subir un archivo sin esa columna
  **no borra** la vendedora ya asignada al cliente.
- Match por **teléfono**: crea nuevos (token automático) y actualiza
  existentes. **Nunca borra** clientes. Cuentas de prueba ("Test...",
  "NO USAR") se excluyen.

---

## 4. Configuración

### Supabase

1. Crear proyecto en [supabase.com](https://supabase.com).
2. Ejecutar completo [`supabase/schema.sql`](supabase/schema.sql) en el SQL
   Editor. **Es idempotente**: se re-ejecuta sin romper datos, e incluye las
   migraciones (p. ej. fusión de distribuidor/us_special/ve_special en la
   lista general `special`, y el paso de `vendedora`/`vendedora_phone`
   —texto libre en `clients`— a la tabla `vendedores` con relación).
3. Crear el primer admin: **Authentication → Users → Add user**, luego:

   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'admin@zimaxx.com'
   on conflict do nothing;
   ```

4. Crear el login de una vendedora (opcional, para que vea solo sus
   propios clientes/pedidos): **Authentication → Users → Add user** con
   su email, y luego, ya logueado como admin, ir a la pestaña
   **Vendedoras** → escribir ese email en la fila de la vendedora →
   **Vincular acceso**.

### Variables de entorno (`.env`)

| Variable | Descripción |
|---|---|
| `VITE_SUPABASE_URL` | URL del proyecto Supabase |
| `VITE_SUPABASE_ANON_KEY` | anon key (Settings → API) |
| `VITE_DEFAULT_WHATSAPP` | Número fallback si el cliente no tiene vendedora con teléfono (solo dígitos con código de país) |
| `VITE_MIN_ORDER` | Pedido mínimo en USD (default: 800) |

### Local

```bash
npm install
cp .env.example .env   # completar credenciales
npm run dev            # http://localhost:5173
```

### Deploy (Netlify)

Conectar el repo (o `netlify deploy`). `netlify.toml` ya define build/publish
y el redirect SPA. Configurar las mismas variables de entorno en el sitio.

---

## 5. Diseño

- **Identidad**: tinta negra cálida + dorado del logo (`public/zimaxx.png`) +
  crema editorial. Tipografías: Fraunces (titulares/precios) + Outfit (UI).
- **Modo día/noche**: sigue el tema del sistema automáticamente; botón
  sol/luna en ambos headers para forzar (persiste en localStorage). El chrome
  de marca (negro + dorado) es igual en ambos modos. `?theme=dark|light` en
  la URL fuerza el tema para esa visita (útil para previews).
- Tokens semánticos en `src/index.css`: `ink` (superficies de marca, siempre
  oscuras), `primary` (texto, se invierte de noche), `surface` (tarjetas),
  `bg`/`line`/`gold-pale` (se ajustan por modo).
- Placeholder de producto sin foto: monograma "Z" dorado sobre tinta.
- Idioma es/en: auto-detección + selector en header (localStorage).

---

## 6. Seguridad

- **RLS activo en todas las tablas**; el rol `anon` no puede leer ninguna
  tabla directamente (en particular `clients` y `product_prices`).
- Catálogo público solo vía RPC `SECURITY DEFINER`:
  - `get_catalog(p_token)` — resuelve el cliente por token; devuelve solo
    los precios de su lista. Token inválido → `null` sin explicación.
    **No expone el SKU.**
  - `get_flash_sales()` — pública, solo ofertas vigentes, sin SKU.
  - `create_order(p_token, ...)` — inserta pedidos validando token; el
    cliente nunca puede leer/modificar `orders`. **Los precios y el total se
    recalculan en el servidor** con la lista del cliente y las flash sales
    vigentes: el payload del navegador solo aporta producto, cantidad y flag
    flash (máx. 200 ítems, qty 1–9999). La tabla `orders` es fuente de
    verdad aunque se manipule el request.
- Escritura solo para usuarios autenticados presentes en `admins`
  (`is_admin()`).
- **Rol vendedora** (2026-07-06): `vendedores.user_id` vincula un login a
  una fila de `vendedores`. Policies RLS adicionales (aditivas a
  `admin_all`, no la reemplazan) le dan a ese usuario `select` de sus
  propios `clients`/`orders` (filtrado por `vendedora_id`), `select` de
  su propia fila en `vendedores`, `select` de solo lectura de
  `price_lists`/`products`/`product_prices`/`flash_sales`, y `update`
  acotado a sus propios `orders` (para marcar atendido/reabrir). Sin
  policy propia no puede insertar/actualizar/borrar nada más — el
  frontend además oculta esos controles para esa vista, pero la
  restricción real vive en RLS, no en la UI. El RPC `get_my_role()`
  resuelve `'admin' | 'vendedora' | null` para que `AdminLayout.jsx`
  arme las pestañas correctas.
- Tokens de cliente: 10 caracteres, `crypto.getRandomValues`, sin caracteres
  ambiguos.
- **`Referrer-Policy: no-referrer`** (meta + header en `netlify.toml`): el
  token viaja en la URL y las imágenes de producto son de dominios externos;
  sin esto el token se fugaría en el header `Referer`. Netlify además envía
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` y
  `X-Robots-Tag: noindex`.

---

## 7. Roadmap / pendientes

- **Integración SellerCloud** (analizada, no implementada): al crear una
  orden → Supabase Edge Function la crea en SellerCloud (`POST
  /rest/api/Orders/`, canal Wholesale) y la marca On Hold (`PUT
  /api/Orders/StatusCode`, status 200); las vendedoras confirman desde
  SellerCloud. Requiere: usuario API dedicado en SellerCloud, y agregar
  email/UserID de SellerCloud a `clients` (el export 118377 ya los trae).
- Enforcement estricto por nivel (mínimo $2,000 para wholesale, etc.) o
  nivel automático por total del carrito ("te faltan $X para precio
  mayorista") — opción C discutida.
- Subida directa de archivos de imagen (hoy es por URL).
- Integración CRM (Bigin/Zoho) — fuera de alcance del spec original.

---

## 8. Estructura del código

```
src/
  main.jsx              Bootstrap + tema
  App.jsx               Rutas (catálogo / admin, admin con lazy loading)
  theme.js              Modo día/noche (sistema + manual)
  i18n.jsx              Diccionario es/en
  index.css             Tokens de diseño + modo oscuro
  lib/supabase.js       Cliente + fetchAll (paginación >1,000 filas)
  hooks/useInfiniteRows.js  Scroll infinito por lotes
  context/CartContext.jsx   Carrito (localStorage, clave por product id)
  utils/
    excel.js            Parser Excel (detección de encabezados, columna de fotos)
    token.js            Tokens de cliente + SKU autogenerado
    whatsapp.js         Mensaje de pedido + link wa.me
    pdf.js              PDF del pedido (jsPDF)
    format.js           money / cleanPhone
  components/           Header, ProductCard, FlashSaleSection, CartBar,
                        CartDrawer, ProductImage, ThemeToggle
  pages/
    Catalog.jsx         Catálogo del cliente
    admin/
      AdminLayout.jsx   Login + shell del panel
      ProductsAdmin.jsx Productos + carga Excel + fotos Excel
      PricesUpload.jsx  Precios Excel + matriz por lista
      ClientsAdmin.jsx  Clientes + niveles por inversión
      VendedoresAdmin.jsx  Alta manual de vendedoras + teléfono
      FlashSalesAdmin.jsx
      OrdersAdmin.jsx
      ui.jsx            Piezas compartidas (UploadZone, SearchIcon, ...)
supabase/schema.sql     Esquema completo + RLS + RPCs + migraciones
```
