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
| `quote` | Cotización (sin precio) | Prospecto sin lista asignada todavía — ver sección siguiente |

- **Región**: `ve_*` es exclusivamente para clientes facturados en Venezuela;
  `us_*` abarca todo el resto del mundo (aunque envíen a Miami). **Special no
  distingue región**: a partir de $15,000 es la misma lista sea cual sea el
  país del cliente.
- **El token no cambia al cambiar de lista**: identifica al cliente, y la
  lista se resuelve al abrir el catálogo. Cambiar la lista en el admin
  actualiza al instante lo que ve el mismo link.
- **Pedido mínimo $800**: el checkout se bloquea por debajo (configurable
  con `VITE_MIN_ORDER` en `.env`). Aplica también a Special.

### Catálogo de cotización (sin precios)

`quote` (2026-07-08) es una lista más en `price_lists`, elegible en el
mismo selector "Lista" de cualquier cliente (alta individual, tabla de
Clientes o carga por Excel) — no es un cliente especial ni un flag
aparte, así que se asigna y se reasigna igual que `us_min`/`special`/etc.,
con vendedora asignada como cualquier otro. Un cliente en esa lista ve
**todos los productos activos** (disponibles y pre-order) sin ningún
precio en ninguna parte de la página (tarjetas, carrito, Flash Sale
queda oculta por completo, mensaje de WhatsApp y PDF): `get_catalog`
detecta el código `'quote'` e ignora `product_prices` por completo. Arma
su lista de interés y al enviarla por WhatsApp llega a la vendedora
asignada (mismo mecanismo de `vendedora_phone` que un cliente normal). El
pedido se guarda igual en `orders` pero con `kind = 'quote'` y todos los
precios en `null` — `create_order` fuerza esto en el servidor por el
código de lista del cliente, sin importar lo que mande el navegador. No
tiene pedido mínimo (no aplica sin precio). La lista `quote` no aparece en
la matriz/carga de precios de la pestaña Precios (no tiene sentido
subirle precio, `get_catalog` los ignoraría de todos modos).

### Productos

- El **SKU es 100% interno** (es el ProductID de SellerCloud): nunca viaja
  al navegador del cliente ni aparece en WhatsApp/PDF.
- **Disponibilidad**: `available`, `preorder` o `flash` (2026-07-08). Los
  pre-order se muestran con badge dorado "Pre-Order" en el catálogo y se
  pueden pedir igual; el estado viaja en el mensaje de WhatsApp. Los
  `flash` (columna Type = "Flash Sale" en el Excel de inventario) se
  muestran con badge 🔥 "Flash Sale" — es solo una etiqueta del producto,
  **no tiene relación con la tabla `flash_sales`** (ofertas con precio
  promo y countdown, pestaña Flash Sales): un producto puede tener esta
  etiqueta sin tener ninguna oferta activa, y viceversa.
- Un producto **solo aparece** en el catálogo de un cliente si tiene precio
  cargado en su lista (las 5 listas, incluida Special, se tratan igual).
- El tamaño va dentro del nombre (ej. "Khamrah 3.4 Oz Edp Unisex"); la
  categoría (`category`) es la marca (Brand).
- **`product_line`** (2026-07-08, distinto de `category`/Brand): tipo real
  del perfume, viene de la columna `PRODUCT_CATEGORY` de los exports de
  SellerCloud (no de `PRODUCTBRAND`, que es la marca) — valores típicos
  `Perfume` (diseñador) y `Perfume - Arabes` (dupes árabes). Al importar se
  normalizan variantes/typos del Excel (`Perfums`, mayúsculas, etc.) a esos
  dos valores canónicos; el resto de categorías (Beauty, Electronics...) se
  guarda tal cual. Sirve para filtrar por ese criterio en el catálogo del
  cliente y en el admin, independiente de la marca — los chips/selector
  muestran "Diseñador"/"Árabes" en vez del texto crudo del Excel.

### Catálogo del cliente: búsqueda y cantidades

- El buscador de `Catalog.jsx` matchea **nombre, categoría (marca) o
  línea** (buscar "adidas" trae todo lo de esa marca, "arabes" trae todo
  lo de `Perfume - Arabes`). Además de los chips de marca hay un chip de
  **línea** (2026-07-08: `Perfume` / `Perfume - Arabes` / lo que traiga
  `product_line`, solo si hay 2+ valores distintos) y otro de
  **disponibilidad** (Disponible / Pre-Order / 🔥 Flash Sale) — cada chip
  de disponibilidad solo aparece si el catálogo tiene al menos un
  producto en ese estado.
- Cada `ProductCard` (2026-07-07): el botón "Agregar" se convierte, una vez
  que el producto está en el carrito, en un stepper **−/input editable/+**
  (el número se puede tipear a mano) más una fila de botones de compra
  grande **+10 / +15 / +20** siempre visibles — pensados para pedidos
  mayoristas, permiten saltar de 0 a una cantidad grande sin pasar por
  "Agregar" primero. `CartContext.setExactQty()` crea el ítem si todavía no
  estaba en el carrito (a diferencia de `setQty()`, que solo actualiza
  ítems ya existentes).
- **Confirmación antes de enviar** (2026-07-07): el botón de WhatsApp del
  carrito abre un diálogo "¿Tu pedido está completo?" con el resumen
  (ítems + total) antes de registrar el pedido y abrir WhatsApp — evita
  envíos accidentales a mitad de armar el carrito.

### Flujo del pedido

1. Cliente abre su link → catálogo con sus precios → arma carrito.
2. Checkout → confirma en el diálogo de seguridad → el pedido queda
   registrado en `orders` (auditoría) → se abre WhatsApp con el pedido
   armado, dirigido a su vendedora (`vendedora_phone`, con fallback
   `VITE_DEFAULT_WHATSAPP`).
3. Opcional: descarga PDF del pedido.
4. Pendiente (planificado): push automático a SellerCloud como orden On Hold
   vía Supabase Edge Function — ver sección 7.

---

## 2. Panel admin (`/admin`)

Login con email/password (Supabase Auth). Dos roles, resueltos por el RPC
`get_my_role()`:

- **Admin** (tabla `admins`): acceso total (lectura y escritura) a las 8
  pestañas.
- **Vendedora** (`vendedores.user_id` vinculado a un login): ve **solo
  sus propios clientes y pedidos** (RLS filtra por fila, no por UI —
  nunca ve cuántos clientes/pedidos tienen otras vendedoras), y Productos
  / Precios **de solo lectura** (sin botones de carga ni edición). No
  tiene pestaña Vendedoras ni **Flash Sales** (2026-07-15, oculta por
  completo para el rol vendedora). En Precios, una lista "personal" (ej.
  `luzmar`) solo la ve su dueña — el resto ni la ve en la matriz ni en el
  selector de listas (2026-07-15, RLS `vendedora_select_price_lists`/
  `vendedora_select_product_prices`). **Sí puede cambiarle la lista de
  precio a sus propios clientes** (2026-07-15, con confirmación — ver
  pestaña Clientes) vía RPC `update_client_price_list`, aunque no tiene
  ningún UPDATE directo en `clients`.

Pestañas:

| Pestaña | Qué hace |
|---|---|
| **Productos** | Tabla completa con buscador (nombre/SKU/UPC), filtros (categoría/marca, línea de perfume, activo/inactivo/con stock/sin stock/sin foto/pre-order/flash), columnas **UPC** y **Stock** (datos internos, no se muestran al cliente), contadores clickeables de "sin foto", "Pre-Order" y "🔥 Flash Sale", miniaturas, alta/edición manual, **selección por casillas para activar/desactivar en bloque** (solo admin), y dos cargas por Excel (productos y fotos). |
| **Precios** | Carga de Excel de precios + **matriz de precios por lista** (producto × 5 listas: 4 regionales + Special) con buscador y botones con contador "con precios" / "sin precios". |
| **Clientes** | Tabla con buscador (nombre/teléfono/vendedora), filtros por lista y vendedora, **selector de lista por fila con confirmación** (2026-07-15: elegir una opción no aplica el cambio de una — pide "¿Cambiar la lista a X?" con Confirmar/Cancelar; ahora lo puede hacer también una vendedora con sus propios clientes, no solo admin) y campo **"$ inversión → nivel"** (solo admin, asigna el nivel automáticamente sin confirmación — pensado para carga rápida), **reasignar vendedora** por fila y **eliminar cliente** (ambos solo admin, vía RPC con registro de auditoría), botón copiar link, carga por Excel y alta individual ("+ Nuevo cliente"; una vendedora se autoasigna el cliente, un admin puede elegir la vendedora o dejarlo sin asignar). |
| **🛡️ Registro de movimientos** (solo admin, pestaña propia desde 2026-07-15 — antes vivía colapsada dentro de Clientes) | Historial de quién reasignó/borró un cliente o le cambió la lista de precio (fecha, usuario, acción, cliente, detalle), leído directo de `admin_audit_log`. **Filtros** (2026-07-15): por usuario, por acción (Reasignación/Eliminación/Cambio de lista) y por rango de fechas (desde/hasta). Es de solo lectura: la tabla no tiene policy de insert/update/delete para nadie, solo la escriben las RPC `reassign_client`/`delete_client`/`update_client_price_list`. |
| **Vendedoras** (solo admin) | Alta manual (nombre + teléfono), edición del teléfono en un click, contador de clientes asignados. El link de WhatsApp del checkout de cada cliente usa el teléfono de acá. Columna **Acceso**, dos formas de dar acceso a una vendedora sin cuenta: **"Vincular acceso"** (email de un usuario que ya existe en Supabase Auth, RPC `link_vendedora_login`) o **"+ Crear acceso"** (2026-07-15: crea el usuario de una — el admin define email + contraseña inicial ahí mismo, sin pasar por el dashboard de Supabase — vía la Edge Function `admin-create-vendedora-user`, ver sección 6). "Desvincular" le quita el acceso sin borrar la vendedora ni el usuario de Auth. |
| **Flash Sales** | Crear ofertas con precio promo y vencimiento (alta manual, un producto a la vez) o **carga masiva por Excel** (2026-07-08: mismo archivo semanal "Special Flash Sale" con formato letterhead — UPC/Sku/Brand/Title Product/Price/Type/Qty/Total —, matchea por SKU y precio propio de cada fila; la fecha de inicio/fin se elige una vez con el selector de arriba y se aplica a todos los productos del archivo). Visibles para todos con countdown; **se apagan solas por fecha, sin acción manual** (`get_flash_sales()` ya filtra por `expires_at`). La tabla del admin distingue 4 estados (`LIVE` / Programada / Expiró / Desactivada, 2026-07-08) — el botón "Desactivar" es solo para cortar una oferta *antes* de su fecha de fin, no hace falta para que termine normalmente. |
| **Pedidos** | Últimos 200 con detalle expandible; cada pedido se marca **Nuevo/Atendido/Cancelado** (2026-07-15: se sumó Cancelado — un pedido `new` muestra botones "Marcar atendido" y "Cancelar"; uno `done`/`cancelled` muestra "Reabrir") y el menú muestra el contador de pedidos sin atender (solo cuenta `new`). Buscador (nombre/teléfono del cliente) + filtros por estado (Nuevo/Atendido/Cancelado), tipo (Pedido/Cotización) y, solo admin, vendedora. Botón **"Descargar Excel"** por fila: exporta el pedido con las columnas exactas de `UploadTemplate.xls` (`ProductID`, `ProductName`, `UnitPrice`, `Qty`, `ShipFromWarehouseName`, este último fijo en `"Zimaxx"`) para subirlo directo al bulk-order upload de SellerCloud. |

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
- **UPC** (`upc`, `barcode`, `ean`, 2026-07-14) — código de barras, dato
  interno del admin (no se muestra al cliente). Se guarda y es visible en la
  tabla de Productos; también se puede buscar por él.
- **Nombre** (`nombre`, `name`, `ProductName`, `Title Product`) — obligatorio.
- **Categoría/marca** (`categoria`, `category`, `Brand`, `marca`).
- **Línea de perfume** (`PRODUCT_CATEGORY`, `línea`, `segmento`, 2026-07-08):
  **distinta** de la anterior — no lee `PRODUCTBRAND` (eso es la marca), lee
  la columna que trae valores como `Perfume` (diseñador) o
  `Perfume - Arabes` (dupes árabes). El export `119389.xlsx` de SellerCloud
  trae ambas columnas por separado.
- **Imagen** (`imagen`, `image`, `url`...) — también se detecta una columna
  de URLs de foto aunque tenga encabezado inservible (ej. `Column1`).
- **Type** (`type`, `tipo`, `disponibilidad`): `Available` / `Pre Order` /
  `Flash Sale` (2026-07-08: antes se trataba como disponible, ahora se
  guarda como su propio estado — badge 🔥 en el catálogo y filtro propio,
  sin relación con la tabla `flash_sales` de ofertas con precio promo).
- **Activo** (`activo`, `active`): `no/false/0/inactivo` desactiva. El
  inventario **no** toca este campo — activo/inactivo es 100% manual
  (edición o selección en bloque, ver abajo) más la exclusión de
  no-catálogo.
- **Inventario / stock** (`inventoryavailableqty`, `inventory`,
  `inventario`, `stock`...): si el archivo trae esta columna, se guarda en
  `products.stock` (no se muestra en la app del cliente) y **decide la
  disponibilidad**: `>= 1` → Disponible, `0` o negativo → Pre-Order — salvo
  que el producto esté marcado `flash`, que se conserva. Misma regla que el
  sync de SellerCloud (`InventoryAvailableQTY`, ver
  `migration-2026-07-14-inventory-stock.sql`).

Actualiza existentes por SKU y crea los nuevos. **Los campos que el archivo
no trae no se tocan** (re-subir un export sin fotos no borra las fotos).
Filas basura de sistemas de inventario (Skustack, Support-Test, Discount) se
excluyen automáticamente, igual que links al panel de SellerCloud colados
como si fueran fotos. **También se excluyen los productos que no son
catálogo vendible** (2026-07-13): SKU terminado en `-SPECIAL` y categorías
`PRODUCT_CATEGORY` = beauty / electronics / support / packing and shipping
supplies / test. Misma regla del lado SQL (`sync_is_noncatalog_product` en
`migration-2026-07-13-exclude-noncatalog.sql`): si se cambia la lista en un
lado, cambiarla en el otro.

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

### Flash Sales (pestaña Flash Sales, 2026-07-08)

Mismo formato letterhead que las listas wholesale (ej. el archivo semanal
"Special Flash Sale"): columnas `UPC`, `Sku`, `Brand`, `Title Product`,
`Price`, `Type`, `Qty`, `Total Price`. Solo se usan **Sku** y **Price**
(acepta el precio con `$`/comas, ej. `$22.00`); `Type`/`Qty`/`Total Price`
se ignoran — la fecha de inicio y fin de la promo **no viene del Excel**,
se elige una sola vez con los selectores de arriba y se aplica igual a
todos los productos del archivo. Filas con SKU que no matchea ningún
producto activo, o con precio inválido/vacío, se cuentan como omitidas
sin tumbar la carga. A diferencia de las cargas de Productos/Precios/
Clientes, **no hace upsert**: cada carga crea filas nuevas en
`flash_sales` (igual que el alta manual de una por una) — si volvés a
subir el mismo archivo se duplican las ofertas, así que para reemplazar
la promo de la semana hay que desactivar las anteriores a mano en la
tabla antes de cargar la nueva.

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

**Alta individual** (botón "+ Nuevo cliente", sin pasar por Excel): nombre,
teléfono, lista de precio y, si sos admin, un selector para asignar la
vendedora (o dejarlo sin asignar). Si entrás como vendedora el campo no se
muestra: el cliente se te asigna a vos automáticamente y no podés
crearlo "suelto" ni para otra vendedora — lo impone una policy RLS
(`vendedora_insert_own_clients` en `schema.sql`), no solo la UI. Eligiendo
**"Cotización (sin precio)"** como lista, el cliente queda con el
catálogo sin precios de la sección 1 — se puede cambiar de/hacia esa
lista en cualquier momento desde el mismo selector, igual que cualquier
otro nivel.

---

## 4. Configuración

### Supabase

1. Crear proyecto en [supabase.com](https://supabase.com).
2. Ejecutar completo [`supabase/schema.sql`](supabase/schema.sql) en el SQL
   Editor. **Es idempotente**: se re-ejecuta sin romper datos, e incluye las
   migraciones (p. ej. fusión de distribuidor/us_special/ve_special en la
   lista general `special`, y el paso de `vendedora`/`vendedora_phone`
   —texto libre en `clients`— a la tabla `vendedores` con relación).
   En instalaciones **ya en producción** conviene NO re-correr el schema
   completo (una vez causó un deadlock con los RPC del sitio en vivo):
   correr en su lugar los deltas `supabase/migration-*.sql`, que son
   chicos, idempotentes y con `lock_timeout` corto.
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
    **No expone el SKU.** Excepción: la lista `quote` devuelve todos los
    productos activos con precio `null` (catálogo de cotización, ver
    sección 1).
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
  `products`/`flash_sales`, y `update` acotado a sus propios `orders`
  (para marcar atendido/reabrir). También tiene `insert` en `clients`
  (2026-07-07, `vendedora_insert_own_clients`) pero **solo si
  `vendedora_id` = ella misma** — no puede crear un cliente sin asignar
  ni para otra vendedora. Fuera de eso no puede insertar/actualizar/
  borrar nada más — el frontend además oculta esos controles para esa
  vista, pero la restricción real vive en RLS, no en la UI. El RPC
  `get_my_role()` resuelve `'admin' | 'vendedora' | null` para que
  `AdminLayout.jsx` arme las pestañas correctas (2026-07-15: a una
  vendedora ya no le arma pestaña Flash Sales, con redirect si entra por
  URL directa).
- **`price_lists`/`product_prices` con dueña** (2026-07-15,
  `migration-2026-07-15-restrict-vendedora-luzmar.sql`): la policy de
  solo-lectura de una vendedora sobre estas dos tablas ya no es un
  blanket `is_vendedora()` — ahora exige que la lista sea general
  (`owner_vendedora_id is null`) o suya (`owner_vendedora_id =
  current_vendedora_id()`). Antes cualquier vendedora podía ver la
  columna/precios de una lista "personal" ajena (ej. `luzmar`) en la
  matriz de Precios y en el selector de listas; ahora esas filas
  directamente no vienen en la respuesta de Supabase para el resto.
- **Reasignar/eliminar clientes con auditoría** (2026-07-14,
  `migration-2026-07-14-client-admin-actions.sql`): solo admin, vía RPC
  `SECURITY DEFINER` `reassign_client(p_client_id, p_vendedora_id)` y
  `delete_client(p_client_id)` — no con `update`/`delete` directos, para
  que cada acción quede registrada sí o sí en la tabla `admin_audit_log`
  (quién/qué/cuándo, con snapshot del cliente). `reassign_client` rechaza
  clientes con lista personal (los fuerza el trigger igual);
  `delete_client` rechaza si el cliente tiene pedidos (no se pierde el
  historial de ventas). `admin_audit_log` es de solo lectura para admin
  (RLS), la escriben solo esas funciones.
- **Cambiar la lista de precio con auditoría, ahora también para
  vendedora** (2026-07-15, `migration-2026-07-15-vendedora-update-price-list.sql`):
  antes `ClientsAdmin.jsx` cambiaba `clients.price_list_id` con un
  `update` directo (por eso era admin-only — una vendedora no tiene
  policy de UPDATE en `clients`). Se reemplazó por la RPC `SECURITY
  DEFINER` `update_client_price_list(p_client_id, p_price_list_id)`:
  permite admin (cualquier cliente) o vendedora (solo sus propios
  clientes, `vendedora_id = current_vendedora_id()`), rechaza que una
  vendedora asigne una lista "personal" ajena, y **audita el cambio en
  `admin_audit_log`** (acción `update_price_list`) sin importar quién lo
  haga — antes este cambio ni quedaba registrado. `admin_audit_log`
  (tabla + RLS `admin_read_audit`) se agregó recién a `schema.sql` en
  este cambio: había quedado fuera desde que se creó
  (`migration-2026-07-14-client-admin-actions.sql` nunca se mergeó de
  vuelta al schema completo), y esta función la necesita para instalaciones
  nuevas.
- **Crear acceso de vendedora desde el panel** (2026-07-15,
  `supabase/functions/admin-create-vendedora-user/index.ts`): antes,
  `link_vendedora_login` solo podía **vincular** un usuario ya creado a
  mano en el dashboard de Supabase Auth. Crear un usuario **con
  contraseña** requiere la Admin API de GoTrue (`auth.admin.createUser`),
  que solo se puede llamar con la **service_role key** — nunca desde el
  navegador, así que es una Edge Function y no una RPC de Postgres. La
  función valida que quien llama sea admin reusando la RPC `is_admin()`
  (con el JWT de quien llama, no con la service_role key, para no
  duplicar esa regla en dos lugares); si el admin es válido, crea el
  usuario y en el mismo paso vincula `vendedores.user_id`/`login_email` —
  si el link fallara, borra el usuario recién creado para no dejarlo
  huérfano. **Requiere deploy manual** (no está automatizado, igual que
  las migraciones SQL): `supabase functions deploy
  admin-create-vendedora-user` desde `zimaxx-store/` (necesita
  `supabase login` + `supabase link --project-ref <ref>` la primera vez).
  No hace falta configurar secrets: `SUPABASE_URL`/`SUPABASE_ANON_KEY`/
  `SUPABASE_SERVICE_ROLE_KEY` ya vienen inyectadas por el runtime de Edge
  Functions.
- **Fix de clientes duplicados por formato de teléfono** (2026-07-15,
  `migration-2026-07-15-fix-duplicate-client-phones.sql`): el mismo
  cliente real quedaba cargado dos veces cuando un lado tenía el teléfono
  con código de país (ej. `51902191277`, Perú) y el otro sin él
  (`1902191277`) — tanto la carga por Excel (`ClientsAdmin.jsx`, ya
  corregido en el frontend con `phoneKey()`, compara por los **últimos 10
  dígitos**) como el paso de "adopción por teléfono" de
  `sync_upsert_clients` (el sync de SellerCloud) comparaban el string
  completo. La migración corre dentro de una transacción explícita
  (`begin`/`commit`) en 4 pasos: (1a) backup completo de `clients`
  (`clients_backup_20260715`, tabla normal, a pedido del usuario — se
  borra a mano una vez confirmado que todo quedó bien); (1b) captura en
  tablas temporales qué fila basura borrar (sin lista, con
  `sellercloud_id`, sin pedidos) y a qué fila real le corresponde adoptar
  su `sellercloud_id`; (1c) borra primero las filas basura; (1d) recién
  ahí copia el `sellercloud_id` capturado a la fila real. **El primer
  intento hacía (1d) antes que (1c)** (adoptar antes de borrar) y falló
  con `duplicate key value violates unique constraint
  clients_sellercloud_id_key` — con las dos filas compartiendo el mismo
  `sellercloud_id` por un instante, el índice único lo rechaza antes de
  llegar al DELETE. Además, (2) reescribe `sync_upsert_clients` para que
  compare por los últimos 10 dígitos igual que el frontend, y (3) agrega
  un índice único sobre el teléfono normalizado
  (`clients_phone_normalized_key`) para que esto no pueda volver a pasar
  por ningún camino (Excel, alta manual, sync) — un intento de insertar
  choca con `unique_violation`, que `sync_upsert_clients` ya contaba en
  `phone_conflicts` y que el frontend ya evita de entrada. **El segundo
  intento también falló** (mismo día): con los ~180 duplicados "basura
  del sync" ya limpios, el `create unique index` chocó igual con un
  teléfono duplicado — revisando a mano aparecieron 2 pares de clientes
  reales (no basura del sync, ya cargados desde el 2026-07-02, cada uno
  con su propia lista de precio y vendedora) que comparten teléfono
  porque el mismo negocio quedó agendado una vez con nombre personal y
  otra con nombre de empresa. El usuario confirmó que quiere mantenerlos
  como 2 clientes distintos, no fusionarlos, así que se agregó
  `clients.allow_shared_phone` (boolean, marcada `true` solo en esos 4
  registros puntuales por id) y el índice quedó **parcial**
  (`where not allow_shared_phone`) — exige unicidad para todo el resto,
  ignora esas 4 filas. Si en el futuro aparece otro caso legítimo igual,
  se marca a mano con `update clients set allow_shared_phone = true
  where id = '...'` (no hay UI para esto todavía). En el frontend,
  `ClientsAdmin.jsx` ahora excluye del mapa de matching de la carga por
  Excel cualquier clave de teléfono que ya sea ambigua entre 2+ clientes
  existentes — una fila de Excel para uno de esos 2 pares cae al alta de
  un cliente nuevo en vez de arriesgarse a actualizar el cliente
  equivocado.
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
- **Sync SellerCloud → catálogo vía n8n**: el lado base de datos ya está
  (2026-07-10): `supabase/migration-2026-07-10-sellercloud-sync.sql`
  (corrida y probada en producción: tabla `sync_runs` de auditoría +
  `sync_upsert_products` / `sync_upsert_prices`, SECURITY DEFINER, solo
  `service_role`, upsert nunca delete) y
  `supabase/migration-2026-07-10-sellercloud-sync-v2.sql` (también
  corrida y probada: agrega `clients.sellercloud_id` — General.ID de
  SellerCloud, llave real del sync de clientes —, suelta el NOT NULL de
  `clients.price_list_id` y reescribe `sync_upsert_clients` con match de
  vendedora sin acentos + contador `unmatched_salesman`; la lista de
  precio nunca se toca desde el sync, sigue siendo manual).
  `migration-2026-07-13-exclude-noncatalog.sql` (2026-07-13) desactiva los
  productos no-catálogo ya cargados (SKU `-SPECIAL` + categorías beauty/
  electronics/support/packing and shipping supplies/test) y blinda
  `sync_upsert_products` para que no los vuelva a jalar (los cuenta en
  `skipped`). `migration-2026-07-14-inventory-stock.sql` (2026-07-14)
  agrega `products.stock` (oculta al cliente) y hace que el inventario del
  JSON de SellerCloud (`InventoryAvailableQTY`) controle la
  **disponibilidad** en cada corrida del sync: `>= 1` → Disponible, `0`/
  negativo → Pre-Order, respetando `flash`. El estado **activo** ya no lo
  toca el sync (es manual). `migration-2026-07-14-product-upc.sql`
  (2026-07-14) agrega `products.upc` (código de barras, dato interno del
  admin) y hace que `sync_upsert_products` lo guarde (campo `upc` del
  payload). **2026-07-15: todo indica que el workflow de n8n ya está
  corriendo en producción** (se detectó por evidencia indirecta — una
  tanda de ~45 clientes duplicados creados en el mismo segundo, todos sin
  lista de precio y con `sellercloud_id`, la huella de `sync_upsert_clients`
  — no porque alguien lo haya confirmado explícitamente; conviene
  confirmarlo con el usuario). Ver el bug de teléfonos duplicados más
  abajo (sección 6) que salió de esto.
- **Pendiente: correr `migration-2026-07-15-restrict-vendedora-luzmar.sql`**
  en producción (restringe la lectura de `price_lists`/`product_prices`
  para que una vendedora no vea la lista/precios "personales" de otra,
  ver sección 6). El código de Flash Sales oculto para vendedora ya se
  puede desplegar sin esperar esta migración (es solo frontend).
- **Pendiente: deploy de la Edge Function
  `supabase/functions/admin-create-vendedora-user`** (2026-07-15, ver
  sección 6) — sin desplegarla, el botón "+ Crear acceso" de la pestaña
  Vendedoras falla (la función no existe todavía en el proyecto de
  Supabase). El resto del código (frontend + "Vincular acceso" con un
  usuario ya existente) ya funciona sin esto.
- **Pendiente: correr `migration-2026-07-15-order-status-cancelled.sql`**
  en producción (recrea el CHECK de `orders.status` para aceptar
  `'cancelled'` además de `'new'/'done'`). Sin esto, marcar un pedido
  como cancelado desde `/admin/orders` falla contra la base — el
  frontend ya está desplegable.
- **Pendiente: correr `migration-2026-07-15-vendedora-update-price-list.sql`**
  en producción (crea la RPC `update_client_price_list`). Sin esto, el
  selector de lista con confirmación de la pestaña Clientes falla para
  todos (admin incluido — ya no usa el `update` directo). Esta migración
  requiere que `migration-2026-07-14-client-admin-actions.sql` ya haya
  corrido antes (crea `admin_audit_log`, donde esta función también
  audita).
- `migration-2026-07-15-fix-duplicate-client-phones.sql` corrida en
  producción (2026-07-16): limpió 315 clientes duplicados que había
  creado el sync por el bug de formato de teléfono, corrigió
  `sync_upsert_clients` para que no lo vuelva a hacer, y agregó el
  índice único **parcial** por teléfono normalizado con la excepción
  `allow_shared_phone` para 2 pares de clientes reales que comparten
  número a propósito — ver sección 6. Pendiente: `git push` del commit
  local `9ce3020` (a criterio del usuario).
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
    excel.js            Parser Excel (detección de encabezados, columna de fotos) + export de pedido (UploadTemplate.xls)
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
      AuditLogAdmin.jsx Registro de movimientos (reasignar/eliminar clientes)
      VendedoresAdmin.jsx  Alta manual de vendedoras + teléfono + acceso
      FlashSalesAdmin.jsx
      OrdersAdmin.jsx
      ui.jsx            Piezas compartidas (UploadZone, SearchIcon, ...)
supabase/schema.sql     Esquema completo + RLS + RPCs + migraciones
supabase/migration-*.sql  Deltas idempotentes para producción (no re-correr el schema completo)
supabase/functions/admin-create-vendedora-user/  Edge Function (Deno) — crea el usuario de Auth de una vendedora, requiere deploy manual
```
