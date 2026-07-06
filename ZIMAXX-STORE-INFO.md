# Zimaxx Store — Referencia completa del proyecto

> Documento de referencia para retomar el trabajo en cualquier sesión.
> Creado: 2026-07-02. Actualizado: 2026-07-06 (endurecimiento pre-producción,
> Special como lista de precio real region-indiferente, tabla `vendedores`
> normalizada). Proyecto construido y build verificado.

---

## Ubicación del código

```
C:\Users\First Choice Online\Documents\Archivos JEsus\Catalogo Zimaxx\zimaxx-store\
```

## Estado actual

- [x] Código fuente completo (React + Vite + Tailwind v4)
- [x] `npm run build` pasa limpio (bundle gzip ~121 kB initial chunk)
- [x] SQL de Supabase listo en `supabase/schema.sql`
- [x] `netlify.toml` configurado (incluye headers de seguridad)
- [x] Endurecimiento pre-producción (2026-07-06):
  - `create_order` recalcula precios y total **en el servidor** (ignora el payload)
  - Pedidos con estado Nuevo/Atendido + contador en el menú admin
  - `Referrer-Policy: no-referrer` (el token no se fuga a los hosts de imágenes)
  - Open Graph para la vista previa del link en WhatsApp + spinner de carga
  - Fix cuadros de carga masiva desbordados en móvil (`UploadZone`)
- [x] Deploy en Netlify hecho; login admin funcionando (el primer intento
  falló por "Failed to fetch" — el build se había compilado sin las
  variables `VITE_*`; se resolvió agregándolas y forzando un redeploy con
  cache limpia)
- [x] Fix Special Order (2026-07-06, en dos pasos):
  1. Ya **no** se divide por región (eliminadas `us_special`/`ve_special`);
     es una sola lista general — ver sección "Base de datos" más abajo.
  2. A pedido del usuario, dejó de ser "cotización sin precio": ahora es
     una **lista de precio real** más, se le sube Excel igual que a las
     otras 4 y el cliente hace checkout normal con total. Se quitó todo
     el modo "Pedido especial" del catálogo (`specialMode`/`isQuote` en
     `Catalog.jsx`, `ProductCard.jsx`, `CartDrawer.jsx`, `whatsapp.js`,
     `pdf.js`) y el bypass de precio en `get_catalog`.
  Pestaña Precios: botones con contador para ver solo productos con/sin
  precio.
- [x] Tabla `vendedores` normalizada (2026-07-06): antes `vendedora`/
  `vendedora_phone` eran texto libre repetido en cada fila de `clients`;
  ahora `clients.vendedora_id` referencia una tabla propia. Nueva pestaña
  admin **Vendedoras** (alta manual, editar teléfono en un click, contador
  de clientes asignados). El link de WhatsApp del checkout sigue
  funcionando igual (usa el teléfono de la vendedora asignada al cliente),
  solo cambió dónde vive el dato.
- [x] Proyecto Supabase creado, schema ejecutado, variables en `.env` y Netlify
- [x] Primer usuario admin registrado en Supabase (login verificado en producción)
- [x] Deploy en Netlify
- [ ] **Pendiente: re-ejecutar `supabase/schema.sql`** en el SQL Editor de
  Supabase — el usuario ya lo corrió una vez (2026-07-06) para `status` en
  `orders`, la fusión de `us_special`/`ve_special` y la tabla `vendedores`,
  pero **después** se volvió a tocar `get_catalog`/`create_order` para que
  Special use precio real, así que hace falta correrlo una vez más. Es
  idempotente, seguro re-correrlo aunque ya haya datos.
- [ ] Ajustar `og:image` en `index.html` con el dominio/URL final de Netlify
- [ ] Excel de clientes reales cargado (incluyendo precios Special)
- [ ] **Pendiente: commitear y desplegar en Netlify** el código de esta
  sesión (fix región-indiferente de Special, tabla vendedores, Special con
  precio real) — hasta ahora solo se corrió el SQL contra Supabase; el
  sitio en producción puede seguir sirviendo el JS viejo hasta el próximo
  deploy.

---

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | React 18 + Vite 5 |
| Estilos | Tailwind CSS v4 (`@tailwindcss/vite`, colores en `@theme` en `src/index.css`) |
| Backend / DB | Supabase (Postgres + Auth + RPC) |
| Excel parser | SheetJS (`xlsx`) — carga bajo demanda solo en el panel admin |
| PDF | jsPDF — carga bajo demanda solo al presionar "Descargar PDF" |
| Hosting | Netlify (SPA, redirect en `netlify.toml`) |

---

## Estructura de archivos

```
zimaxx-store/
├── index.html
├── vite.config.js
├── package.json
├── netlify.toml
├── .env.example               ← copiar a .env con las credenciales de Supabase
├── .gitignore
├── README.md
├── supabase/
│   └── schema.sql             ← ejecutar en Supabase SQL Editor (idempotente)
└── src/
    ├── main.jsx
    ├── App.jsx                 ← rutas: / y /admin (admin con lazy import)
    ├── index.css               ← variables CSS de marca + @theme Tailwind
    ├── i18n.jsx                ← diccionario es/en + LanguageProvider + useI18n
    ├── lib/
    │   └── supabase.js         ← cliente Supabase (vars de entorno)
    ├── context/
    │   └── CartContext.jsx     ← carrito en memoria + localStorage
    ├── components/
    │   ├── Header.jsx          ← logo, nombre cliente, selector de idioma, botón carrito (desktop)
    │   ├── ProductCard.jsx     ← tarjeta con precio y botón agregar
    │   ├── ProductImage.jsx    ← imagen con fallback emoji
    │   ├── FlashSaleSection.jsx← sección flash sale con cuenta regresiva
    │   ├── CartDrawer.jsx      ← carrito lateral + checkout WhatsApp + PDF
    │   └── CartBar.jsx         ← barra inferior fija en móvil
    ├── pages/
    │   ├── Catalog.jsx         ← página principal (/?c=<token>)
    │   └── admin/
    │       ├── AdminLayout.jsx ← login Supabase Auth + nav de pestañas
    │       ├── ProductsAdmin.jsx
    │       ├── PricesUpload.jsx
    │       ├── ClientsAdmin.jsx
    │       ├── VendedoresAdmin.jsx
    │       ├── FlashSalesAdmin.jsx
    │       └── OrdersAdmin.jsx
    └── utils/
        ├── format.js           ← money(), cleanPhone()
        ├── whatsapp.js         ← buildOrderMessage(), whatsappUrl()
        ├── pdf.js              ← downloadOrderPdf() (async, jsPDF lazy)
        ├── token.js            ← generateToken() con crypto.getRandomValues
        └── excel.js            ← parseSheet(), normalizeHeader(), pick() (XLSX lazy)
```

---

## Colores de marca (variables CSS)

| Variable | Hex (día) | Uso |
|---|---|---|
| `--color-primary` / `--color-ink` | `#16130d` | Tinta negra cálida (texto / chrome de marca) |
| `--color-secondary` | `#c9a227` | Dorado (botones, acentos) |
| `--color-secondary-dark` | `#a3821a` | Dorado hover |
| `--color-gold-pale` | `#f0e6c8` | Fondos dorados suaves (badges, avisos) |
| `--color-bg` | `#f6f3ec` | Fondo crema de página |
| `--color-surface` | `#ffffff` | Tarjetas / tablas |

En Tailwind: `bg-primary`, `text-secondary`, `hover:bg-secondary-dark`, etc.
Modo oscuro por clase `.dark` en `<html>` (ver `src/theme.js`): `primary`,
`bg`, `surface`, `line` y `gold-pale` cambian de piel; `ink` no (el chrome
negro+dorado es idéntico en ambos modos).

---

## Base de datos — Tablas

| Tabla | Descripción |
|---|---|
| `price_lists` | Listas de precio fijas (5 registros ya sembrados) |
| `clients` | Clientes con token único, lista asignada y `vendedora_id` (FK a `vendedores`) |
| `vendedores` | Nombre + teléfono de cada vendedora (2026-07-06; antes texto libre en `clients`) |
| `products` | Catálogo de productos (`availability`: 'available' \| 'preorder') |
| `product_prices` | Precio por producto+lista (clave compuesta) |
| `flash_sales` | Ofertas con fecha de expiración |
| `orders` | Pedidos del checkout — fuente de verdad (precios recalculados en el servidor) con `status` 'new' \| 'done' |
| `admins` | user_id de Supabase Auth autorizados como admin |

### Listas de precio sembradas por el schema

| code | label |
|---|---|
| `us_min` | US Minimum Order ($800+) |
| `us_wholesale` | US Wholesale ($2,000+) |
| `ve_min` | VE Minimum Order |
| `ve_wholesale` | VE Wholesale |
| `special` | Special Order ($15,000+, **cualquier región**, precio fijo real) |

Corregido 2026-07-06 (en dos pasos): (1) Special ya **no** se divide por
región (antes existían `us_special`/`ve_special`); a partir de $15,000 es
esta única lista sin importar el país del cliente. (2) A pedido del
usuario, Special dejó de ser "cotización sin precio" — ahora se le sube
Excel de precios igual que a las otras 4 y el cliente hace checkout
normal con total, como cualquier otro nivel.

---

## RPC (funciones Postgres SECURITY DEFINER)

### `get_catalog(p_token text) → jsonb`
- Acceso: `anon` y `authenticated`
- Resuelve el cliente por token. Token inválido → `null` (sin mensaje).
- Todas las listas (incluida `special`) se tratan igual: un producto solo
  aparece si tiene precio cargado en `product_prices` para esa lista.
- **No expone el SKU** (es interno).
- Devuelve (mismo contrato JSON de siempre; `vendedora`/`vendedora_phone`
  se resuelven ahora con un join a `vendedores` en vez de leerse directo
  de `clients`):
  ```json
  {
    "client": { "name", "vendedora", "vendedora_phone", "price_list_code" },
    "products": [ { "id", "name", "category", "image_url", "availability", "price" } ]
  }
  ```

### `get_flash_sales() → jsonb`
- Acceso: `anon` y `authenticated`. Sin token.
- Devuelve solo las ofertas activas con `starts_at <= now() < expires_at`.

### `create_order(p_token, p_items, p_total, p_kind) → uuid`
- Acceso: `anon` y `authenticated`.
- Valida el token; si es inválido devuelve `null` sin registrar.
- **Los precios y el total se recalculan en el servidor** con la lista del
  cliente y las flash sales vigentes (fallback a precio de lista si la
  oferta expiró). Del payload solo se usan `id`, `qty` y `flash` de cada
  ítem; `p_total` se ignora (se mantiene en la firma por compatibilidad).
- Límites: máx. 200 ítems, qty 1–9999; ítems malformados o de productos
  inactivos se descartan sin tumbar el pedido. Si no sobrevive ninguno → `null`.
- `p_kind`: `'order'` o `'quote'`, tal cual lo pida el caller (por defecto
  `'order'`). Ya no hay lista que fuerce `'quote'` — el frontend actual
  nunca pide `'quote'`, queda para un eventual flujo de cotización manual
  futuro. Pedidos viejos con `kind = 'quote'` (de cuando Special era
  cotización) siguen mostrándose como tal en `/admin/orders`.
- Los ítems guardados incluyen el SKU real del producto (solo visible en el admin).
- Devuelve el `id` del pedido creado; el frontend (`CartDrawer`) revisa el
  retorno y avisa al cliente si el registro falló (WhatsApp sale igual).

### `is_admin() → boolean`
- Acceso: solo `authenticated`.
- Comprueba si `auth.uid()` está en `admins`. Usada en las políticas RLS.

---

## RLS — Resumen de seguridad

- **`anon` no puede leer ni escribir ninguna tabla directamente** (RLS activo en todas).
- Todo acceso público es vía las RPC SECURITY DEFINER.
- **`authenticated` + `is_admin() = true`**: acceso total (policy `admin_all` en todas las tablas).
- No hay políticas para `anon` sobre las tablas → denegado implícitamente.
- **Headers** (meta en `index.html` + `netlify.toml`): `Referrer-Policy:
  no-referrer` — crítico porque el token viaja en la URL (`?c=<token>`) y
  las imágenes de producto se cargan de dominios externos; sin esto el token
  se fugaría en el header `Referer`. Además `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff` y `X-Robots-Tag: noindex` (+ meta robots).

---

## Variables de entorno

| Variable | Dónde se pone | Qué es |
|---|---|---|
| `VITE_SUPABASE_URL` | `.env` local + Netlify | `https://xxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `.env` local + Netlify | anon/public key del proyecto |
| `VITE_DEFAULT_WHATSAPP` | `.env` local + Netlify | Número fallback vendedora (opcional, solo dígitos con código país, ej: `13055551234`) |

---

## Pasos para crear el proyecto en Supabase (pendiente)

1. Ir a [supabase.com](https://supabase.com) → New project
   - Nombre sugerido: `zimaxx-store`
   - Región: US East (más cerca de Doral, FL)
   - Contraseña de la DB: guardarla en lugar seguro
2. Esperar a que el proyecto inicie (~1 min)
3. Ir a **SQL Editor** → New query
4. Pegar y ejecutar todo el contenido de `supabase/schema.sql`
5. Verificar que las 8 tablas aparecen en **Table Editor**
6. Ir a **Settings → API** y copiar:
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon public` key → `VITE_SUPABASE_ANON_KEY`
7. Crear el usuario admin:
   - **Authentication → Users → Add user** → email + contraseña
   - SQL Editor: ejecutar
     ```sql
     insert into public.admins (user_id)
     select id from auth.users where email = 'TU_EMAIL_AQUI'
     on conflict do nothing;
     ```
8. Copiar las credenciales al archivo `.env` del proyecto local

---

## Pasos para deploy en Netlify (pendiente)

1. Subir `zimaxx-store/` a un repositorio de GitHub
2. En [netlify.com](https://netlify.com) → Add new site → Import from Git
3. Build settings (ya están en `netlify.toml`, Netlify los detecta automáticamente):
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Site settings → Environment variables → agregar las 3 variables del `.env`
5. Deploy site

---

## Panel admin — Flujo de carga de datos

### Productos
- Crear manualmente en `/admin` (Productos) o
- Cargar el Excel de precios (el parser no crea productos, necesitan existir primero)

### Precios (Excel/CSV)
- Columnas: `SKU` + una o más de: `US Minimum Order`, `US Wholesale`, `VE Minimum Order`, `VE Wholesale`
- SKUs desconocidos se reportan como omitidos (no falla)
- Celdas vacías se ignoran
- El parser normaliza encabezados (sin acentos, minúsculas) → aceptan variaciones

### Clientes (Excel/CSV)
- Columnas requeridas: `nombre`, `teléfono`, `lista de precio`, `vendedora`
- Columna opcional: `teléfono vendedora`
- Match por teléfono: crea nuevos (token automático) y actualiza existentes
- **Nunca borra** clientes que no estén en el archivo
- Alias aceptados por columna (el parser normaliza):
  - Nombre: `nombre`, `name`, `cliente`, `client`
  - Teléfono: `telefono`, `phone`, `tel`, `celular`, `whatsapp`
  - Lista: `lista de precio`, `lista de precios`, `lista`, `price list`
  - Vendedora: `vendedora`, `vendedor`, `sales rep`, `rep`, `asesora`
  - Tel. vendedora: `telefono vendedora`, `tel vendedora`, `rep phone`
- La vendedora del Excel se resuelve contra la tabla `vendedores` por
  nombre (sin distinguir mayúsculas); si no existe se crea sobre la
  marcha. Re-subir un archivo sin esa columna no borra la asignación
  existente del cliente.

### Vendedoras (pestaña Vendedoras, `/admin/vendedoras`)
- Alta manual: nombre (obligatorio) + teléfono (opcional, se puede
  completar después).
- El teléfono se edita con un click sobre el valor en la tabla (o "Sin
  teléfono" si está vacío); Enter o click afuera lo guarda.
- Contador de clientes asignados por fila. Borrar una vendedora con
  clientes asignados falla (restricción de la base de datos) y muestra
  un aviso — hay que reasignar esos clientes primero.

---

## Link de cliente

Formato: `https://zimaxxstore.com/?c=<token>`

- Token de 10 caracteres alfanuméricos (sin 0/O, 1/l para evitar confusión visual)
- Generado con `crypto.getRandomValues` (no adivinable)
- Se copia desde la columna de la tabla en `/admin/clients`

---

## Decisiones de diseño no explícitas en el spec

1. **Special Order es una lista más** (`price_list_code = 'special'`), no una lógica separada. Simplifica el modelo de datos. (Originalmente sin precio fijo/cotización personalizada; revertido en el punto 11 a pedido del usuario.)
2. **`vendedora_phone` en `clients`** — el spec solo pedía el nombre de la vendedora; el número es necesario para el link `wa.me`.
3. **`create_order` como RPC** en vez de policy INSERT directa — más estricto: no se puede insertar sin token válido.
4. **Imágenes como URL** — sin upload de archivos por ahora; usar cualquier hosting o Supabase Storage pegando la URL pública.
5. **Admin lazy-loaded** — todo el panel admin (SheetJS, jsPDF, etc.) se carga solo cuando se navega a `/admin`, no pesa en el bundle del cliente. El `Suspense` muestra un spinner dorado mientras baja el chunk.
6. **Carrito persistente en `localStorage`** — sobrevive a cerrar la pestaña y recargar.
7. **Precios server-side en `create_order`** (2026-07-06) — el navegador nunca dicta precios ni total; la tabla `orders` es fuente de verdad aunque se manipule el request.
8. **Ciclo de vida del pedido** (2026-07-06) — columna `status` ('new'/'done'), botón Marcar atendido/Reabrir en `/admin/orders` y badge con el conteo de pendientes en el menú del admin.
9. **Open Graph** (2026-07-06) — el link compartido por WhatsApp genera tarjeta de vista previa con logo. `og:image` exige URL absoluta: apunta a `https://zimaxx-store.netlify.app/zimaxx.png`; ajustar en `index.html` si el dominio final es otro.
10. **Tabla `vendedores` normalizada** (2026-07-06) — antes `vendedora`/`vendedora_phone` eran texto libre repetido en cada fila de `clients` (mismo nombre podía escribirse distinto en cada Excel). Ahora es una tabla propia con `clients.vendedora_id` como FK: el teléfono se edita en un solo lugar y se refleja al instante en el link de WhatsApp de todos sus clientes. `get_catalog` resuelve el join pero devuelve el mismo JSON de siempre, así que el frontend del catálogo no cambió.
11. **Special pasó a tener precio fijo real** (2026-07-06, a pedido del usuario) — hasta entonces `special` era la única lista sin precio ("catálogo sin precios, checkout = cotización"), y por eso la pestaña Precios no ofrecía subirle Excel. El usuario pidió poder cargarle precios como a cualquier otra lista, así que se quitó el modo "Pedido especial" por completo: `get_catalog` ya no bypassea el requisito de precio para `special`, y se eliminó `specialMode`/`isQuote` de `Catalog.jsx`, `ProductCard.jsx`, `CartDrawer.jsx`, `whatsapp.js` y `pdf.js`. El checkout de un cliente Special ahora es idéntico al de cualquier otro nivel (total, mínimo de $800, mensaje de WhatsApp normal). El `kind`/`p_kind` ('order'/'quote') de `create_order` se mantiene en el schema por si se quiere un flujo de cotización manual más adelante, pero ya nada lo dispara automáticamente.
