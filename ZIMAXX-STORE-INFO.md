# Zimaxx Store — Referencia completa del proyecto

> Documento de referencia para retomar el trabajo en cualquier sesión.
> Creado: 2026-07-02. Actualizado: 2026-07-06 (endurecimiento pre-producción,
> Special como lista de precio real region-indiferente, tabla `vendedores`
> normalizada, rol vendedora con acceso restringido por RLS). Proyecto
> construido y build verificado.

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
  Special use precio real, y **más tarde** se agregó el rol vendedora
  (`vendedores.user_id`/`login_email`, funciones `is_vendedora()` /
  `current_vendedora_id()` / `get_my_role()`, nuevas policies RLS, RPC
  `link_vendedora_login`), así que hace falta correrlo una vez más. Es
  idempotente, seguro re-correrlo aunque ya haya datos.
- [x] **Rol vendedora con acceso restringido** (2026-07-06, a pedido del
  usuario: las vendedoras no deben ver clientes/pedidos de otras
  vendedoras, solo admins ven todo). Login propio por vendedora
  (`vendedores.user_id` → `auth.users`), RLS por fila (aditiva a
  `admin_all`) para `clients`/`orders`/`vendedores`, lectura general de
  Productos/Precios/Flash Sales, y RPC `link_vendedora_login` para que el
  admin vincule el login desde la pestaña Vendedoras sin ir al SQL
  Editor. Frontend: `AdminLayout.jsx` arma pestañas por rol
  (`get_my_role()`) y pasa el rol a las páginas vía `Outlet context`; cada
  página admin oculta sus controles de edición cuando el rol no es
  `admin`. Falta probar el login real de una vendedora contra un proyecto
  Supabase (no hay entorno local para eso).
- [x] `og:image` ajustado (2026-07-06) a `https://catalogozimaxx.netlify.app/zimaxx.png`, la URL real del sitio en Netlify (el sitio se llama `catalogozimaxx`). Ojo: si conectan un dominio propio más adelante, hay que volver a actualizar esta línea en `index.html` y redesplegar.
- [ ] Excel de clientes reales cargado (incluyendo precios Special)
- [ ] **Pendiente: commitear y desplegar en Netlify** el código de esta
  sesión (fix región-indiferente de Special, tabla vendedores, Special con
  precio real) — hasta ahora solo se corrió el SQL contra Supabase; el
  sitio en producción puede seguir sirviendo el JS viejo hasta el próximo
  deploy.
- [ ] **Catálogo de cotización sin precios** (2026-07-08, a pedido del
  usuario): lista `quote` sembrada en `price_lists`, seleccionable en el
  mismo selector "Lista" de cualquier cliente; `get_catalog`/`create_order`
  la detectan por `code` (no por un flag en `clients`). **Falta correr el
  `schema.sql` actualizado en Supabase** (agrega la fila `quote` a
  `price_lists` — inserción con `on conflict do nothing`, no rompe si ya
  corriste una versión previa) y commitear/desplegar el código — sin el
  SQL actualizado, la opción "Cotización (sin precio)" no aparece en el
  selector de listas.

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
        └── excel.js            ← parseSheet(), normalizeHeader(), pick(), downloadOrderExcel() (XLSX lazy)
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
| `vendedores` | Nombre + teléfono de cada vendedora (2026-07-06; antes texto libre en `clients`). Desde el rol vendedora (2026-07-06): `user_id` (FK a `auth.users`, nullable, único) + `login_email` (solo display) para vincular su login |
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
| `quote` | Cotización (sin precio) — catálogo completo sin precio, ver más abajo |

Corregido 2026-07-06 (en dos pasos): (1) Special ya **no** se divide por
región (antes existían `us_special`/`ve_special`); a partir de $15,000 es
esta única lista sin importar el país del cliente. (2) A pedido del
usuario, Special dejó de ser "cotización sin precio" — ahora se le sube
Excel de precios igual que a las otras 4 y el cliente hace checkout
normal con total, como cualquier otro nivel.

Catálogo de cotización sin precios (2026-07-08, a pedido del usuario,
distinto del punto anterior): lista `quote` sembrada en `price_lists`,
igual que cualquier otra — **primer intento** de esta sesión fue un flag
`clients.is_quote_only` con `price_list_id` nullable y un checkbox
aparte en el alta de cliente; el usuario lo rechazó porque obligaba a
crear un cliente nuevo para cada cotización y, sin vendedora asignada, no
quedaba forma cómoda de editarlo después. Se rehizo como una lista más:
el mismo selector "Lista" de siempre (alta individual, tabla de Clientes,
Excel) ahora puede apuntar a `quote`, se reasigna hacia/desde ahí como
cualquier otro nivel, y sigue teniendo vendedora asignada igual que
cualquier cliente. `get_catalog`/`create_order` detectan el modo
cotización resolviendo el `code` de `price_list_id` del cliente (no un
flag): si es `'quote'`, `get_catalog` ignora `product_prices` y devuelve
**todos** los productos activos (disponibles y pre-order) con precio
`null`; `create_order` fuerza `kind = 'quote'` sin calcular precio para
ningún ítem. `PricesUpload.jsx` excluye `quote` de la matriz/carga de
precios (no tiene sentido subirle precio, se ignoraría igual). Ver
detalle del RPC más abajo y la sección de `ClientsAdmin.jsx`.

---

## RPC (funciones Postgres SECURITY DEFINER)

### `get_catalog(p_token text) → jsonb`
- Acceso: `anon` y `authenticated`
- Resuelve el cliente por token. Token inválido → `null` (sin mensaje).
- Todas las listas regionales/Special se tratan igual: un producto solo
  aparece si tiene precio cargado en `product_prices` para esa lista.
  **Excepción: `quote`** (2026-07-08) — ver abajo.
- **No expone el SKU** (es interno).
- Devuelve (mismo contrato JSON de siempre; `vendedora`/`vendedora_phone`
  se resuelven ahora con un join a `vendedores` en vez de leerse directo
  de `clients`; `is_quote_only` es nuevo, 2026-07-08, y es un booleano
  calculado — `price_list_code = 'quote'` — no una columna de `clients`):
  ```json
  {
    "client": { "name", "vendedora", "vendedora_phone", "price_list_code", "is_quote_only" },
    "products": [ { "id", "name", "category", "image_url", "availability", "price" } ]
  }
  ```
- Si la lista resuelta del cliente tiene `code = 'quote'`, ignora
  `product_prices` por completo: devuelve **todos** los productos activos
  con `price: null` siempre (catálogo de cotización, ver "Base de datos"
  más arriba).

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
  `'order'`), **salvo que la lista del cliente sea `'quote'`**: en ese caso
  el servidor fuerza `kind = 'quote'` y nunca calcula precio para ningún
  ítem, sin importar lo que mande el navegador (2026-07-08). Pedidos viejos
  con `kind = 'quote'` (de cuando Special era cotización) siguen
  mostrándose como tal en `/admin/orders`.
- Los ítems guardados incluyen el SKU real del producto (solo visible en el admin).
- Devuelve el `id` del pedido creado; el frontend (`CartDrawer`) revisa el
  retorno y avisa al cliente si el registro falló (WhatsApp sale igual).

### `is_admin() → boolean`
- Acceso: solo `authenticated`.
- Comprueba si `auth.uid()` está en `admins`. Usada en las políticas RLS.

### `is_vendedora() → boolean` / `current_vendedora_id() → uuid` / `get_my_role() → text`
- Acceso: solo `authenticated`. (2026-07-06, rol vendedora.)
- `is_vendedora()`: existe una fila en `vendedores` con `user_id = auth.uid()`.
- `current_vendedora_id()`: el `id` de esa fila (usado en las policies RLS de `clients`/`orders`).
- `get_my_role()`: `'admin'` si `is_admin()`, si no `'vendedora'` si `is_vendedora()`, si no `null`. Es el único RPC que llama `AdminLayout.jsx` para decidir qué pestañas mostrar.

### `link_vendedora_login(p_vendedora_id uuid, p_email text) → boolean`
- Acceso: solo `authenticated`; internamente exige `is_admin()` (si no, `raise exception`). (2026-07-06.)
- Busca `p_email` en `auth.users` (tabla no legible directo por el cliente) y, si existe, setea `vendedores.user_id`/`login_email`. Devuelve `false` si el email no corresponde a ningún usuario. Lo llama `VendedoresAdmin.jsx` al presionar "Vincular acceso" — evita que el admin tenga que ir al SQL Editor, pero el usuario de Supabase Auth se sigue creando a mano en el dashboard.

---

## RLS — Resumen de seguridad

- **`anon` no puede leer ni escribir ninguna tabla directamente** (RLS activo en todas).
- Todo acceso público es vía las RPC SECURITY DEFINER.
- **`authenticated` + `is_admin() = true`**: acceso total (policy `admin_all` en todas las tablas).
- No hay políticas para `anon` sobre las tablas → denegado implícitamente.
- **Rol vendedora** (2026-07-06): `authenticated` + `is_vendedora() = true` (vía `vendedores.user_id = auth.uid()`) obtiene, mediante policies aditivas a `admin_all` (Postgres las combina con OR para el mismo comando):
  - `select` en `vendedores` limitado a su propia fila (`user_id = auth.uid()`).
  - `select` en `clients` y `orders` limitado a `vendedora_id = current_vendedora_id()` (en `orders`, vía `client_id in (select id from clients where ...)`).
  - `update` en `orders` con el mismo filtro en `using`/`with check` — permite marcar sus propios pedidos atendido/nuevo sin poder reasignarlos a otro cliente.
  - `select` de solo lectura en `price_lists`, `products`, `product_prices`, `flash_sales`.
  - `insert` en `clients` (2026-07-07, policy `vendedora_insert_own_clients`) **solo si `vendedora_id = current_vendedora_id()`** — puede darse de alta clientes propios pero no crear uno sin asignar ni para otra vendedora.
  - Sin ninguna otra policy → no puede insertar/actualizar/borrar nada fuera de eso. La UI (`AdminLayout.jsx` + páginas admin) además oculta los controles de edición para este rol, pero el límite real está en RLS.
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

### Alta individual de clientes (2026-07-07)
- Botón "+ Nuevo cliente" en la pestaña Clientes, alternativa a la carga
  por Excel para un cliente puntual. Campos: nombre, teléfono, lista de
  precio (obligatorios) y, solo para admin, un selector de vendedora
  (`"Sin asignar"` por defecto) — inserta directo contra `clients` con
  `supabase.from('clients').insert(...)`, sin RPC dedicada.
- Si el usuario logueado es vendedora, el selector no se muestra: el
  cliente se le asigna automáticamente (usa la única fila de
  `vendedores` que puede leer, la suya, vía `vendedora_select_self`). No
  puede crear un cliente sin asignar ni para otra vendedora — lo impone
  la policy `vendedora_insert_own_clients` (RLS), no la UI.
- Teléfono duplicado (constraint `clients.phone` único) muestra un error
  amigable (`phoneInUse` en `i18n.jsx`) en vez del mensaje crudo de Postgres.

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
9. **Open Graph** (2026-07-06) — el link compartido por WhatsApp genera tarjeta de vista previa con logo. `og:image` exige URL absoluta: apunta a `https://catalogozimaxx.netlify.app/zimaxx.png` (URL real del sitio, corregida el mismo día tras probar en WhatsApp con la URL placeholder inicial). Si el sitio se cambia a otro dominio, hay que actualizar esta línea en `index.html` y redesplegar — WhatsApp además cachea la vista previa por URL compartida, así que un link ya probado puede seguir sin imagen hasta que expire ese caché o se comparta un link nuevo.
10. **Tabla `vendedores` normalizada** (2026-07-06) — antes `vendedora`/`vendedora_phone` eran texto libre repetido en cada fila de `clients` (mismo nombre podía escribirse distinto en cada Excel). Ahora es una tabla propia con `clients.vendedora_id` como FK: el teléfono se edita en un solo lugar y se refleja al instante en el link de WhatsApp de todos sus clientes. `get_catalog` resuelve el join pero devuelve el mismo JSON de siempre, así que el frontend del catálogo no cambió.
11. **Special pasó a tener precio fijo real** (2026-07-06, a pedido del usuario) — hasta entonces `special` era la única lista sin precio ("catálogo sin precios, checkout = cotización"), y por eso la pestaña Precios no ofrecía subirle Excel. El usuario pidió poder cargarle precios como a cualquier otra lista, así que se quitó el modo "Pedido especial" por completo: `get_catalog` ya no bypassea el requisito de precio para `special`, y se eliminó `specialMode`/`isQuote` de `Catalog.jsx`, `ProductCard.jsx`, `CartDrawer.jsx`, `whatsapp.js` y `pdf.js`. El checkout de un cliente Special ahora es idéntico al de cualquier otro nivel (total, mínimo de $800, mensaje de WhatsApp normal). El `kind`/`p_kind` ('order'/'quote') de `create_order` se mantiene en el schema por si se quiere un flujo de cotización manual más adelante, pero ya nada lo dispara automáticamente.
12. **Rol vendedora con acceso restringido** (2026-07-06, a pedido del usuario) — antes el panel admin era binario (estar o no en `admins`, sin nivel intermedio). Se agregó un login propio por vendedora sin tocar el modelo de `admins`: `vendedores.user_id` (FK a `auth.users`, nullable, único) vincula la fila a un usuario ya creado en el dashboard de Supabase Auth; el admin hace esa vinculación desde la pestaña Vendedoras (RPC `link_vendedora_login`, evita ir al SQL Editor). El nivel de acceso se resuelve por RLS, no por la UI: nuevas policies (aditivas a `admin_all`, que sigue intacta para admins) le dan a una vendedora `select` de sus propios `clients`/`orders` (por `vendedora_id`/`current_vendedora_id()`), `select` de su propia fila en `vendedores` (nunca las de otras), `update` acotado a sus propios `orders` (marcar atendido/reabrir) y `select` de solo lectura de `price_lists`/`products`/`product_prices`/`flash_sales`. El frontend (`AdminLayout.jsx` con `get_my_role()` + `Outlet context={{ role }}`) arma pestañas distintas por rol y cada página admin esconde sus controles de edición cuando `role !== 'admin'`, pero eso es solo UX — la restricción real es la RLS.
13. **Alta individual de clientes** (2026-07-07, a pedido del usuario) — hasta entonces `ClientsAdmin.jsx` solo creaba clientes por carga masiva de Excel. Se agregó un botón "+ Nuevo cliente" con formulario inline; admin puede elegir vendedora o dejarlo sin asignar, vendedora se autoasigna el cliente (el selector ni se muestra). Igual que el resto del rol vendedora, la restricción real es una policy RLS nueva (`vendedora_insert_own_clients`: `insert` en `clients` solo si `vendedora_id = current_vendedora_id()`), no la UI.
14. **Exportar pedido a Excel para SellerCloud** (2026-07-07, a pedido del usuario) — `/admin/orders` tiene un botón "Descargar Excel" por fila que genera un `.xlsx` con las columnas exactas de `UploadTemplate.xls` (`ProductID`, `ProductName`, `UnitPrice`, `Qty`, `ShipFromWarehouseName`), para subirlo directo al bulk-order upload de SellerCloud sin retocarlo. `ProductID`/`ProductName`/`UnitPrice`/`Qty` salen de `orders.items` (`sku`/`name`/`price`/`qty`, ya guardados ahí); `ShipFromWarehouseName` no existe en el modelo de datos (Zimaxx tiene un solo almacén) así que queda fijo como `"Zimaxx"` en `downloadOrderExcel()` (`src/utils/excel.js`) — si algún día manejan más de un almacén, hay que resolver esa columna por producto/cliente en vez de una constante.
15. **Cantidades grandes en el catálogo + confirmación de pedido** (2026-07-07, a pedido del usuario) — `ProductCard.jsx` reemplaza el botón "Agregar" fijo por un stepper editable (−/input/+) una vez que el producto ya está en el carrito, más una fila de botones **+10/+15/+20** siempre visibles (pensados para compras mayoristas grandes, permiten saltar de 0 a una cantidad grande sin pasar primero por "Agregar"). Requirió extender `CartContext.jsx`: `add(product, price, {flash, qty})` ahora acepta cuánto sumar (antes siempre +1) y se agregó `setExactQty(product, price, qty, {flash})`, que a diferencia de `setQty(id, flash, qty)` **crea el ítem si no existía** (necesario para el input editable a mano y los botones +10/+15/+20 sobre un producto todavía no agregado). Además, `Catalog.jsx`: el buscador ahora matchea nombre **o categoría** (antes solo nombre — "buscar Adidas" no traía nada aunque hubiera productos de esa marca), y se sumó un filtro de disponibilidad (Disponible/Pre-Order) como chips, junto a los de categoría. Por último, `CartDrawer.jsx` agrega un diálogo de confirmación ("¿Tu pedido está completo?" + resumen de ítems/total) antes de registrar la orden y abrir WhatsApp, para evitar envíos accidentales.
16. **Filtros de búsqueda en Pedidos** (2026-07-07, a pedido del usuario) — `OrdersAdmin.jsx` no tenía forma de buscar/filtrar entre los últimos 200 pedidos. Se agregó buscador (nombre/teléfono del cliente), y selects de estado (Nuevo/Atendido), tipo (Pedido/Cotización) y, solo para admin, vendedora (derivada de los pedidos ya cargados, sin query aparte). El filtro de vendedora requirió ampliar el `select` de Supabase a `clients(name, phone, vendedora_id, vendedores(name))` — una vendedora ya solo ve sus propios pedidos por RLS (`vendedora_select_own_orders`), así que ese filtro se oculta para ese rol.
17. **Catálogo de cotización sin precios** (2026-07-08, a pedido del usuario, distinto de Special) — necesitaba un link genérico para mandar a un prospecto sin lista asignada, que muestre todos los perfumes disponibles y pre-order sin precio en ningún lado, y que igual arme una lista y la mande por WhatsApp a la vendedora asignada (misma lógica de `vendedora_phone` que un cliente normal). **Primer intento, rechazado por el usuario en la misma sesión**: un flag en `clients` (`is_quote_only`, con `price_list_id` nullable) más un checkbox aparte en el alta de cliente que ocultaba el selector de lista. El usuario lo rechazó: obligaba a crear un cliente nuevo cada vez que alguien quisiera una cotización, y un cliente "sin lista asignada" (price_list_id null) quedaba incómodo de editar después. **Diseño final**: `quote` es una fila más en `price_lists` (como `special`), elegible en el mismo selector "Lista" de siempre (alta individual, tabla de Clientes, Excel) — se reasigna hacia/adentro/afuera de esa lista igual que cualquier otro nivel, sin checkbox ni estado especial, y el cliente sigue teniendo vendedora asignada como cualquiera. `get_catalog`/`create_order` detectan el modo cotización resolviendo el `code` de la lista del cliente (no un flag): si es `'quote'`, `get_catalog` ignora `product_prices` y devuelve todos los productos activos con `price: null`; `create_order` fuerza `kind = 'quote'` sin calcular precio, sin importar el payload del navegador (mismo patrón de "el servidor decide, no el cliente" que ya usaba el recálculo de precios). `PricesUpload.jsx` excluye `quote` de la matriz/carga de precios. En el frontend casi todo el ocultamiento de precio ya existía gratis porque `ProductCard`/`CartDrawer`/`CartBar`/`Header` ya condicionaban el render en `price != null` / `cart.hasPrices` (resabio de Special-como-cotización, punto 11) — solo hubo que: (a) arreglar un bug real en `ProductCard.jsx` donde `Number(product.price)` convertía un precio `null` en `0` en vez de mantenerlo `null` (rompía `hasPrices` y por lo tanto el mínimo de pedido); (b) ocultar `FlashSaleSection` por completo para estos clientes (las ofertas siempre traen precio real, no dependen del cliente); (c) en `whatsapp.js`/`pdf.js`, omitir la línea de Total y usar título/saludo de "Solicitud de cotización" cuando ningún ítem tiene precio. **Pendiente**: correr el `schema.sql` actualizado en Supabase (agrega la fila `quote` a `price_lists`, `on conflict do nothing`) y desplegar el código — sin eso, la opción no aparece en el selector.
