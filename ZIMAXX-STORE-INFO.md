# Zimaxx Store — Referencia completa del proyecto

> Documento de referencia para retomar el trabajo en cualquier sesión.
> Creado: 2026-07-02. Proyecto construido y build verificado.

---

## Ubicación del código

```
C:\Users\First Choice Online\Documents\Archivos JEsus\Catalogo Zimaxx\zimaxx-store\
```

## Estado actual

- [x] Código fuente completo (React + Vite + Tailwind v4)
- [x] `npm run build` pasa limpio (bundle gzip ~116 kB initial chunk)
- [x] SQL de Supabase listo en `supabase/schema.sql`
- [x] `netlify.toml` configurado
- [ ] Proyecto Supabase creado y schema ejecutado
- [ ] Variables de entorno en `.env` (local) y en Netlify
- [ ] Primer usuario admin registrado en Supabase
- [ ] Deploy en Netlify
- [ ] Excel de clientes reales cargado

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

| Variable | Hex | Uso |
|---|---|---|
| `--color-primary` | `#0D0D0D` | Negro principal |
| `--color-secondary` | `#D4AF37` | Dorado (botones, acentos) |
| `--color-secondary-dark` | `#B8962E` | Dorado hover |
| `--color-bg` | `#F7F6F2` | Fondo blanco roto |

En Tailwind: `bg-primary`, `text-secondary`, `hover:bg-secondary-dark`, etc.

---

## Base de datos — Tablas

| Tabla | Descripción |
|---|---|
| `price_lists` | Listas de precio fijas (5 registros ya sembrados) |
| `clients` | Clientes con token único, lista asignada y vendedora |
| `products` | Catálogo de productos |
| `product_prices` | Precio por producto+lista (clave compuesta) |
| `flash_sales` | Ofertas con fecha de expiración |
| `orders` | Pedidos registrados al hacer checkout (auditoría) |
| `admins` | user_id de Supabase Auth autorizados como admin |

### Listas de precio sembradas por el schema

| code | label |
|---|---|
| `us_min` | US Minimum Order |
| `us_wholesale` | US Wholesale |
| `ve_min` | VE Minimum Order |
| `ve_wholesale` | VE Wholesale |
| `special` | Special Order (cotización sin precios) |

---

## RPC (funciones Postgres SECURITY DEFINER)

### `get_catalog(p_token text) → jsonb`
- Acceso: `anon` y `authenticated`
- Resuelve el cliente por token. Token inválido → `null` (sin mensaje).
- Lista `special` → catálogo sin precios (modo cotización).
- Devuelve:
  ```json
  {
    "client": { "name", "vendedora", "vendedora_phone", "price_list_code" },
    "products": [ { "id", "sku", "name", "category", "image_url", "price" } ]
  }
  ```

### `get_flash_sales() → jsonb`
- Acceso: `anon` y `authenticated`. Sin token.
- Devuelve solo las ofertas activas con `starts_at <= now() < expires_at`.

### `create_order(p_token, p_items, p_total, p_kind) → uuid`
- Acceso: `anon` y `authenticated`.
- Valida el token; si es inválido devuelve `null` sin registrar.
- `p_kind`: `'order'` (con precios) o `'quote'` (Special Order sin precios).
- Devuelve el `id` del pedido creado.

### `is_admin() → boolean`
- Acceso: solo `authenticated`.
- Comprueba si `auth.uid()` está en `admins`. Usada en las políticas RLS.

---

## RLS — Resumen de seguridad

- **`anon` no puede leer ni escribir ninguna tabla directamente** (RLS activo en todas).
- Todo acceso público es vía las RPC SECURITY DEFINER.
- **`authenticated` + `is_admin() = true`**: acceso total (policy `admin_all` en todas las tablas).
- No hay políticas para `anon` sobre las tablas → denegado implícitamente.

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
5. Verificar que las 7 tablas aparecen en **Table Editor**
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

---

## Link de cliente

Formato: `https://zimaxxstore.com/?c=<token>`

- Token de 10 caracteres alfanuméricos (sin 0/O, 1/l para evitar confusión visual)
- Generado con `crypto.getRandomValues` (no adivinable)
- Se copia desde la columna de la tabla en `/admin/clients`

---

## Decisiones de diseño no explícitas en el spec

1. **Special Order es una lista más** (`price_list_code = 'special'`), no una lógica separada. Simplifica el modelo de datos.
2. **`vendedora_phone` en `clients`** — el spec solo pedía el nombre de la vendedora; el número es necesario para el link `wa.me`.
3. **`create_order` como RPC** en vez de policy INSERT directa — más estricto: no se puede insertar sin token válido.
4. **Imágenes como URL** — sin upload de archivos por ahora; usar cualquier hosting o Supabase Storage pegando la URL pública.
5. **Admin lazy-loaded** — todo el panel admin (SheetJS, jsPDF, etc.) se carga solo cuando se navega a `/admin`, no pesa en el bundle del cliente.
6. **Carrito persistente en `localStorage`** — sobrevive a cerrar la pestaña y recargar.
