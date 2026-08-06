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
| `luzmar` | Luzmar - Precio Especial | Lista con dueña (ver "Listas con dueña" abajo) |

- **Región**: `ve_*` es exclusivamente para clientes facturados en Venezuela;
  `us_*` abarca todo el resto del mundo (aunque envíen a Miami). **Special no
  distingue región**: a partir de $15,000 es la misma lista sea cual sea el
  país del cliente.
- **El token no cambia al cambiar de lista**: identifica al cliente, y la
  lista se resuelve al abrir el catálogo. Cambiar la lista en el admin
  actualiza al instante lo que ve el mismo link.
- **Pedido mínimo $800**: el checkout se bloquea por debajo (configurable
  con `VITE_MIN_ORDER` en `.env`). Aplica también a Special.

### Listas con dueña (personales y compartidas)

Una lista puede tener **dueñas** (tabla `price_list_owners`, 2026-08-04 —
antes era la columna única `price_lists.owner_vendedora_id`, 2026-07-09).
Sirve para precios negociados en privado por una vendedora, que no tienen que
verse ni usarse desde la cuenta de otra. Tres estados:

| Dueñas | Qué significa |
|---|---|
| ninguna | Lista **general** (`us_min`, `special`, `quote`…): la ve y la usa cualquier vendedora |
| una | Lista **personal** (ej. `luzmar`): solo ella la ve, y todo cliente con esa lista queda asignado a ella |
| varias | Lista **compartida**: solo esas vendedoras la ven, y cada cliente de la lista queda con **una** de ellas |

- **Quién la ve**: RLS (`can_vendedora_use_price_list()`) — una vendedora que
  no es dueña no recibe ni la fila de `price_lists` ni sus `product_prices`,
  así que la lista no aparece en la matriz de Precios ni en ningún selector.
  Los admins ven todo.
- **A quién queda asignado el cliente**: lo garantiza el trigger
  `clients_enforce_owner_vendedora` en la base, no la UI. Si la vendedora que
  viene ya es dueña, se respeta (así se reparten los clientes de una lista
  compartida); si no, se fuerza la **dueña principal** (`is_primary`, una sola
  por lista). Cubre la carga por Excel, el sync de SellerCloud y cualquier
  escritura directa.
- **Repartir los clientes de una lista compartida**: el selector de vendedora
  de la pestaña Clientes queda acotado a las dueñas de esa lista, y
  `reassign_client` rechaza server-side cualquier destino que no sea una de
  ellas.
- **Agregar o quitar dueñas se hace desde la pestaña 🔐 Superadmin**
  (2026-08-05; hasta entonces era solo por SQL, los queries siguen al final de
  `supabase/migration-2026-08-04-shared-price-lists.sql` como referencia).
  Ojo con quitar una dueña: sus clientes **no** se mueven solos (a dónde van
  es decisión del admin) — el panel muestra cuántos quedaron con una vendedora
  que ya no es dueña y ofrece un botón para pasarlos a la dueña principal.

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
- **La disponibilidad la decide el stock, sola** (2026-08-04, trigger
  `products_availability_from_stock` en la base): `products.stock >= 1` →
  Disponible, `0` o negativo → Pre-Order, `null` ("todavía no se sabe el
  stock") → no se toca. La etiqueta `flash` se conserva siempre: el stock solo
  alterna Disponible↔Pre-Order. La regla vive en un trigger y no en cada
  camino de escritura, así que vale para el sync de SellerCloud, el Excel de
  productos, la carga masiva, el formulario del panel, el descuento de un
  pedido atendido y cualquier request directo — un producto en 0 no puede
  quedar marcado Disponible. Antes esto se podía romper: un Excel de precios
  sin columna `Type` dejaba en Disponible a todos sus productos, con stock 0
  incluido.
- **`stock`** es dato interno (nunca lo devuelve `get_catalog`). Entra por el
  sync (`InventoryAvailableQTY`), por el Excel de productos (columna
  `Inventory`/`Stock`), a mano desde el formulario de la pestaña Productos
  (2026-08-04) — y **baja solo** cuando un pedido se marca Atendido (ver
  "Descuento de stock" en la sección 2).
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
- **Aviso de disponibilidad y precio sujetos a cambio** (2026-08-04): arriba
  de la lista de ítems del carrito, y repetido en el diálogo de confirmación
  — el stock y los precios pueden moverse entre que el cliente arma el pedido
  y la asesora lo cierra, así que hay que confirmarlos con ella.

### Flujo del pedido

1. Cliente abre su link → catálogo con sus precios → arma carrito.
2. Checkout → confirma en el diálogo de seguridad → el pedido queda
   registrado en `orders` (auditoría) → se abre WhatsApp con el pedido
   armado, dirigido a su vendedora (`vendedora_phone`, con fallback
   `VITE_DEFAULT_WHATSAPP`).
3. Opcional: descarga PDF del pedido — desde 2026-07-17 esto **también**
   registra un pedido `kind = 'quote'` en `orders` (antes solo generaba el
   archivo, sin tocar la base), así queda visible como cotización en
   `/admin/orders` sin bloquear la descarga si el guardado falla.
4. **El carrito se vacía** al enviar el pedido por WhatsApp o al generar la
   cotización con el PDF (2026-08-04), **pero solo si el pedido quedó
   realmente registrado** (2026-08-05, ver más abajo): en lugar de la lista de
   ítems queda un acuse ("Pedido registrado" / "Cotización generada") con un
   botón "Armar otro pedido". Además **no queda nada guardado en el
   dispositivo**: `CartContext` borra la clave de `localStorage` cuando el
   carrito queda vacío, en vez de dejar un `[]` guardado — importante porque el
   link del catálogo se comparte por WhatsApp y se abre en teléfonos que a
   veces no son del cliente. Vaciar a mano con "Vaciar carrito" hace lo mismo.
5. Pendiente (planificado): push automático a SellerCloud como orden On Hold
   vía Supabase Edge Function — ver sección 7.

#### Si el pedido no llega a registrarse (2026-08-05)

El 2026-08-05 un pedido de ~10k se envió por WhatsApp y **no apareció en el
sistema**, dos veces seguidas. Causa: `create_order` rechazaba todo pedido de
más de **200 líneas distintas** con un `return null` mudo, y el frontend abría
WhatsApp igual y mostraba el ✓ de enviado. Por eso pedidos más CAROS sí
entraban (pocas referencias × mucha cantidad) y ese no (muchas referencias ×
1–2 unidades, el cliente que recorre el catálogo entero): el tope nunca tuvo
que ver con el monto. Lo que cambió, en tres capas:

- **El tope pasó a 1000 líneas.** No se saca del todo porque
  `compute_order_items` crece superlineal (~48 ms con 200 líneas, 651 ms con
  1000, 2.4 s con 2000: el acumulador `v_items || ...` copia el jsonb entero en
  cada vuelta), y pasando las ~2000 se choca con el `statement_timeout` del rol
  `anon` — sería el mismo fallo silencioso por otra puerta.
- **Todo rechazo queda en `order_failures`** (motivo, cantidad de líneas y el
  payload). Antes el único registro era un `console.warn` en el teléfono del
  cliente, así que no había forma de saber qué había pasado. La bandeja de
  Pedidos muestra un aviso rojo con esos pedidos y un botón **Recuperar**
  (`recover_order_failure`) que los carga como pedido con los precios vigentes,
  sin pedirle al cliente que rearme nada.
- **El carrito ya no se vacía si el registro falló.** En su lugar el drawer
  muestra un aviso rojo con un botón "Reintentar registro" y el pedido sigue
  ahí. Los fallos de red se reintentan solos; los rechazos del RPC no, porque
  darían lo mismo siempre. WhatsApp se abre igual, así la asesora recibe la
  lista aunque el registro haya fallado.
- **Reintentar no duplica**: `CartContext` genera un `request_id` por carrito y
  `create_order` es idempotente sobre él (`orders.request_id` con índice
  único), así que un envío repetido — a mano, automático, o dos toques del
  cliente a la vez — devuelve el pedido ya guardado en vez de crear otro.

---

## 2. Panel admin (`/admin`)

Login con email/password (Supabase Auth). Tres roles: `get_my_role()` resuelve
admin/vendedora, y `is_superadmin()` (2026-08-05) el tercero — a propósito en
un RPC aparte y no como un valor más de `get_my_role()`, porque el frontend
compara `role === 'admin'` en varias páginas para mostrar los controles de
edición y un valor nuevo ahí las habría dejado en solo lectura:

- **Superadmin** (tabla `superadmins`, 2026-08-05 — hoy solo
  `support5@firstchoiceonline.com`): todo lo de admin **más** la pestaña
  🔐 Superadmin, la única desde donde se puede nombrar/quitar admins, cambiar
  la contraseña de cualquier acceso y asignar/desasignar listas de precio a
  vendedoras. Es admin por definición (`is_admin()` lo incluye), así que no
  puede dejarse afuera del panel por error. Sumar o quitar un superadmin sigue
  siendo solo por SQL, a propósito.
- **Admin** (tabla `admins`): acceso total (lectura y escritura) a las 8
  pestañas. Desde 2026-08-05 **no** puede escribir `admins` ni
  `price_list_owners` (antes la policy `admin_all` se lo permitía vía API
  directa, aunque no hubiera UI): esas dos las escribe solo el superadmin.
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
| **Productos** | Tabla completa con buscador (nombre/SKU/UPC), filtros (categoría/marca, línea de perfume, activo/inactivo/con stock/sin stock/sin foto/pre-order/flash), columnas **UPC** y **Stock** (datos internos, no se muestran al cliente), contadores clickeables de "sin foto", "Pre-Order" y "🔥 Flash Sale", miniaturas, alta/edición manual **con campo Stock editable** (2026-08-04 — reponer stock a mano es lo que devuelve un producto de Pre-Order a Disponible sin esperar al sync; vacío = "sin dato", distinto de 0), **selección por casillas para activar/desactivar en bloque** (solo admin), y dos cargas por Excel (productos y fotos). |
| **Precios** | Carga de Excel de precios + **matriz de precios por lista** (producto × 5 listas: 4 regionales + Special) con buscador y botones con contador "con precios" / "sin precios". |
| **Clientes** | Tabla con buscador (nombre/teléfono/vendedora), filtros por lista y vendedora, **selector de lista por fila con confirmación** (2026-07-15: elegir una opción no aplica el cambio de una — pide "¿Cambiar la lista a X?" con Confirmar/Cancelar; ahora lo puede hacer también una vendedora con sus propios clientes, no solo admin) y campo **"$ inversión → nivel"** (solo admin, asigna el nivel automáticamente sin confirmación — pensado para carga rápida), **reasignar vendedora** por fila y **eliminar cliente** (ambos solo admin, vía RPC con registro de auditoría), botón copiar link, carga por Excel y alta individual ("+ Nuevo cliente"; una vendedora se autoasigna el cliente, un admin puede elegir la vendedora o dejarlo sin asignar). |
| **🛡️ Registro de movimientos** (solo admin, pestaña propia desde 2026-07-15 — antes vivía colapsada dentro de Clientes) | Historial de quién reasignó/borró un cliente, le cambió la lista de precio, o tocó un pedido (editar ítems, cambiar estado, convertir cotización) — con el **movimiento de stock** de ese cambio de estado cuando hubo uno (2026-08-04: "Stock descontado: N · M sin dato de stock"; el `detail` guarda producto, SKU, cantidad y el antes/después de cada uno). Fecha, usuario, acción, cliente, detalle, leído directo de `admin_audit_log`. Desde 2026-08-05 también registra **todo lo que se hace en la pestaña Superadmin** (rol admin, cambios de contraseña, dueñas de listas, alta/renombre/borrado de listas) — en esas filas la columna "Cliente / objetivo" no es un cliente sino el email del usuario o el nombre de la lista. **Filtros** (2026-07-15): por usuario, por acción y por rango de fechas (desde/hasta). **"⬇️ Descargar Excel"** (2026-08-05): baja **todo** el historial, no los 200 que muestra la tabla (usa `fetchAll`, así pasa el corte de 1,000 filas de PostgREST), respetando los filtros activos — el botón aclara "(todo el historial)" o "(filtrado)". Columnas: Fecha (texto `YYYY-MM-DD HH:MM:SS` local, ordenable en cualquier Excel sin depender de la configuración regional), Usuario, Acción, Cliente / objetivo, Detalle, ID cliente, ID pedido y **Datos completos (JSON)** — el `detail` crudo, porque el resumen legible deja cosas afuera (el antes/después ítem por ítem de una edición de pedido, el stock producto por producto). Con filtros que no dejan ninguna fila no genera archivo vacío: avisa. Es de solo lectura: la tabla no tiene policy de insert/update/delete para nadie, solo la escriben las RPC (`reassign_client`/`delete_client`/`update_client_price_list`/las de pedidos/`sa_log` desde las `sa_*`). |
| **Vendedoras** (solo admin) | Alta manual (nombre + teléfono), edición del teléfono en un click, contador de clientes asignados. El link de WhatsApp del checkout de cada cliente usa el teléfono de acá. Columna **Acceso**, dos formas de dar acceso a una vendedora sin cuenta: **"Vincular acceso"** (email de un usuario que ya existe en Supabase Auth, RPC `link_vendedora_login`) o **"+ Crear acceso"** (2026-07-15: crea el usuario de una — el admin define email + contraseña inicial ahí mismo, sin pasar por el dashboard de Supabase — vía la Edge Function `admin-create-vendedora-user`, ver sección 6). "Desvincular" le quita el acceso sin borrar la vendedora ni el usuario de Auth. |
| **Flash Sales** | Crear ofertas con precio promo y vencimiento (alta manual, un producto a la vez) o **carga masiva por Excel** (2026-07-08: mismo archivo semanal "Special Flash Sale" con formato letterhead — UPC/Sku/Brand/Title Product/Price/Type/Qty/Total —, matchea por SKU y precio propio de cada fila; la fecha de inicio/fin se elige una vez con el selector de arriba y se aplica a todos los productos del archivo). Visibles para todos con countdown; **se apagan solas por fecha, sin acción manual** (`get_flash_sales()` ya filtra por `expires_at`). La tabla del admin distingue 4 estados (`LIVE` / Programada / Expiró / Desactivada, 2026-07-08) — el botón "Desactivar" es solo para cortar una oferta *antes* de su fecha de fin, no hace falta para que termine normalmente. |
| **Pedidos** | Últimos 200; click en una fila expande un detalle de ancho completo (tabla Producto/Cantidad/Precio/Subtotal, 2026-07-17 — antes se abría angosto dentro de la columna Ítems). Cada pedido se marca **Nuevo/Atendido/Cancelado** (2026-07-15: se sumó Cancelado; 2026-07-17: las 3 acciones piden confirmación en un modal antes de aplicarse, y quedan auditadas vía RPC `update_order_status`, antes un `update` directo sin rastro) y el menú muestra el contador de pedidos sin atender (solo cuenta `new`). Buscador (nombre/teléfono del cliente) + filtros por estado, tipo (Pedido/Cotización) y, solo admin, vendedora. Botones **"Descargar PDF"**/**"Descargar Excel"** por fila (2026-07-17 el primero, mismo generador que el carrito del cliente; el Excel con las columnas exactas de `UploadTemplate.xls` para subirlo directo al bulk-order upload de SellerCloud); debajo, separados, **"Editar"** y **"Convertir en pedido"** — ambos **solo para cotizaciones** (`kind = 'quote'`), nunca para un pedido real, y "Editar" además solo mientras la cotización sigue `new` (ni atendida ni cancelada se edita). "Editar" (RPC auditada `update_order_items`) deja cambiar cantidad/quitar/agregar producto — cualquiera con acceso al pedido puede hacerlo (admin siempre, vendedora solo los de sus propios clientes). "Convertir en pedido" (RPC `convert_quote_to_order`) congela el precio de ese momento con la lista real del cliente (a diferencia de la cotización, que sigue mostrando el precio **vigente** vía `get_quotes_live_pricing` — ver sección 6) y deja de ajustarse a cambios de precio futuros. Arriba de la lista, **aviso rojo de los pedidos que el cliente envió y no se registraron** (2026-08-05, `order_failures`): cliente, fecha, motivo y cantidad de líneas, con un botón **"Recuperar"** que lo carga como pedido con los precios vigentes de su lista (RPC `recover_order_failure`, auditada) — antes un pedido rechazado no dejaba rastro en ninguna parte. Aparece también cuando todavía no hay ningún pedido, para que "aún no hay pedidos" no tape justo lo que hay que ver. Una vendedora solo ve (y recupera) los de sus propios clientes. |
| **🔐 Superadmin** (2026-08-05, solo superadmin) | Lo que antes obligaba a entrar al SQL Editor o al dashboard de Auth. **Usuarios y accesos**: todos los usuarios de Supabase Auth con su rol (Superadmin/Admin/Vendedora/Sin rol), la vendedora vinculada, fecha de alta y último acceso; por fila, "Hacer admin"/"Quitar admin" (con confirmación) y **"Cambiar contraseña"** (sirve para cualquier acceso: vendedora, admin o el propio superadmin); arriba, **"+ Crear admin"** (crea el usuario de Auth con su contraseña inicial y le da el rol, en un paso). **Listas de precio y dueñas**: por lista, cuántos clientes y cuántos precios tiene, sus dueñas con la principal marcada (★), agregar/quitar dueña y cambiar cuál es la principal; si al mover dueñas quedaron clientes con una vendedora que ya no es dueña, avisa cuántos y ofrece pasarlos a la principal de una vez. También **crear** una lista nueva (código + nombre visible; el código se valida y no se puede cambiar después), **renombrar** el nombre visible y **eliminar** una lista que no sea de las base y esté completamente vacía. Todo va por RPC `sa_*` con `is_superadmin()` adentro (o por la Edge Function `superadmin-users` cuando hace falta la Admin API de Auth) y **todo queda en el Registro de movimientos**. |

### Descuento de stock al atender un pedido (2026-08-04)

El catálogo arrastra inventario viejo de una de las primeras cargas, así que
hay productos que se ven Disponibles cuando ya se agotaron. Para que dos
clientes no pidan la misma mercadería, **marcar un pedido como Atendido
descuenta sus cantidades de `products.stock`** (RPC `update_order_status` →
helper `apply_order_stock`): stock 20 de Adidas Fresh, un cliente pide 10, la
asesora lo marca Atendido → queda 10, y si llega a 0 el producto pasa a
Pre-Order solo (trigger `products_availability_from_stock`).

Reglas, todas confirmadas con el usuario:

- **Solo pedidos reales** (`kind = 'order'`). Una cotización nunca toca el
  stock — ni la que genera "Descargar PDF" del carrito ni la de un cliente con
  lista `quote`. Para que descuente hay que pasarla a pedido con **"Convertir
  en pedido"** y marcar ESE pedido Atendido. Si no fuera así, un cliente
  bajando 5 PDF mientras mira el catálogo vaciaría el inventario solo.
- **Reabrir o cancelar devuelve el stock** y el producto vuelve de Pre-Order a
  Disponible si corresponde. Marcar Atendido por error se deshace.
- **Nunca descuenta dos veces**: la bandera `orders.stock_applied` (no el
  estado) es la que decide, así que `done → new → done` descuenta una sola vez
  por ciclo. La bandera está blindada por el trigger
  `orders_guard_items_edit`, igual que `items`/`total`/`status`/`kind`.
- **Productos con `stock` null** ("todavía no se sabe", nunca sincronizados) se
  saltan: no se puede restar de un dato que no existe. Se cuentan aparte y el
  panel lo muestra ("N sin dato de stock").
- Un pedido que **supera** el stock disponible deja el stock en negativo (ej.
  −5), que también es Pre-Order — así queda registro de lo que se debe.
- Un pedido con el mismo producto en dos líneas (una de oferta flash y otra a
  precio de lista) suma las cantidades antes de tocar el stock.
- El modal de confirmación avisa qué va a pasar con el stock antes de aplicar,
  y después de aplicar la fila muestra el resultado. Un pedido con stock ya
  descontado lleva el chip "📦 Stock descontado".

**Cómo convive con el sync de SellerCloud** (decisión del usuario, 2026-08-04):
el descuento es un **puente de vida corta**, no la fuente de verdad. El flujo
acordado es:

1. La asesora marca la orden **Atendida** → el sistema resta el stock al
   instante y el catálogo queda protegido desde ese segundo.
2. Acto seguido, la asesora **monta la orden de compra en SellerCloud** (para
   eso está el botón "Descargar Excel" de la fila).
3. La próxima corrida de n8n (resync completo, dos veces al día) trae el
   `InventoryAvailableQTY` real y **reemplaza** el valor de la base — nunca
   suma. Eso ya es el comportamiento de `sync_upsert_products`
   (`stock = coalesce(v_stock, p.stock)`), no hizo falta cambiar nada. Con el
   trigger `products_availability_from_stock`, la disponibilidad se recalcula
   sola en ese mismo momento.

Así el descuento cubre solo el hueco entre "orden cerrada en la app" y "orden
cargada en SellerCloud", que es exactamente para lo que se pensó: evitar tener
que sincronizar el inventario cada 5 minutos para que esté al día. **Depende de
que el paso 2 se haga**: si una orden se marca Atendida y no se carga en
SellerCloud, la próxima corrida del sync devuelve el stock viejo y la
protección se pierde. Si eso llegara a ser un problema, la alternativa ya
pensada es una columna `products.reserved` (el descuento suma ahí en vez de
tocar `stock`, y la disponibilidad se calcula con `stock - reserved`, de modo
que sobreviva al sync).

Las tablas grandes usan **scroll infinito** (lotes de 100) y todas las
consultas están **paginadas** para superar el límite de 1,000 filas por
consulta de Supabase. Desde 2026-07-20, `fetchAll` pide todas las páginas
**en paralelo** (antes era secuencial, una tras otra) — mismo dato, pero
la carga de tablas grandes como la matriz de Precios ya no espera cada
página por turno.

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

Una **lista de precio por archivo** (2026-07-17, reemplaza el formato
multi-columna anterior): elegir arriba a qué lista corresponde el Excel
(selector con las listas de `price_lists`, sin `quote`), luego subirlo.
Columnas: SKU, precio (`Price`/`Precio`/genérica o con el nombre de la
lista, ej. `US Minimum Order`) y `Type`/`Tipo`/`Disponibilidad`
(`Available`/`Pre Order`/`Flash Sale`, igual que el Excel de productos).

El archivo sube a la RPC `apply_price_list` en dos pasos:
1. **Preview** (`p_commit: false`): sin escribir nada, muestra cuántos
   productos se van a actualizar, reactivar y **desactivar**, más SKU sin
   producto y precios inválidos (con muestra de los primeros 50 de cada
   uno).
2. **Confirmar** (`p_commit: true`): recién ahí se aplica.

Es una carga "reemplaza todo" por lista: un producto que **hoy tiene
precio en esa lista pero no viene en el archivo** (o viene con SKU/precio
inválido) pierde el precio de esa lista y queda **inactivo globalmente**
— por eso el preview es obligatorio antes de escribir. La dedup por SKU
repetido en el archivo la hace la RPC del lado del servidor (última fila
gana), así un SKU duplicado ya no puede reventar el `upsert` con "ON
CONFLICT DO UPDATE command cannot affect row a second time" como pasaba
antes.

La matriz de precios (debajo, de solo lectura) tiene botones con contador
para ver solo productos **con precio** o **sin precio** (según la lista
seleccionada en el filtro).

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
    flash (**máx. 1000 líneas** desde 2026-08-05 — eran 200 y rechazaba pedidos
    reales, ver sección 1 —, qty 1–9999). La tabla `orders` es fuente de
    verdad aunque se manipule el request. Todo rechazo queda en
    `order_failures` en lugar de devolver `null` sin dejar rastro, y
    `p_request_id` lo hace idempotente para que un reintento no duplique.
  - `recover_order_failure(p_failure_id)` — solo `authenticated`: exige
    `is_admin()` o `is_vendedora()` adentro, y una vendedora solo puede
    recuperar los pedidos de sus propios clientes. Audita en
    `admin_audit_log`. `order_failures` es de **solo lectura** vía RLS (admin
    todo, vendedora lo de sus clientes, `anon` nada) y no tiene policy de
    insert/update/delete para nadie: solo la escribe `create_order`.
- Escritura solo para usuarios autenticados presentes en `admins`
  (`is_admin()`), **salvo `admins` y `price_list_owners`, que desde 2026-08-05
  solo las escribe el superadmin** (ver abajo).
- **Rol superadmin** (2026-08-05, `migration-2026-08-05-superadmin.sql`): tabla
  `superadmins` + `is_superadmin()`, y `is_admin()` pasa a ser "está en `admins`
  **o** es superadmin".
  - La tabla `superadmins` tiene **RLS activo y cero policies**: desde la app
    no existe para nadie, ni para el propio superadmin. Solo la leen las
    funciones `SECURITY DEFINER` y el SQL Editor. Es a propósito: si la marca
    viviera en una columna de `admins` — que hasta esta migración cualquier
    admin podía escribir vía API — cualquiera se habría podido coronar.
  - `admins` y `price_list_owners` perdieron el `admin_all`: ahora tienen
    `superadmin_all` (escritura) + `admin_read_only` (lectura, que sí usa
    `ClientsAdmin.jsx` para saber qué listas tienen dueña).
  - Las RPC del panel (`sa_list_users`, `sa_set_admin`,
    `sa_add_price_list_owner`, `sa_remove_price_list_owner`,
    `sa_set_primary_price_list_owner`, `sa_sync_price_list_clients`,
    `sa_price_list_overview`, `sa_create_price_list`, `sa_update_price_list`,
    `sa_delete_price_list`, `sa_register_new_admin`, `sa_log_password_change`)
    exigen `is_superadmin()` **adentro**: ocultar la pestaña no es la
    protección, es solo la UI. Todas auditan vía `sa_log()`.
  - Crear un usuario de Auth o cambiarle la contraseña necesita la Admin API de
    GoTrue (service_role), imposible desde el navegador: eso vive en la Edge
    Function `supabase/functions/superadmin-users`, que valida `is_superadmin()`
    con el JWT de quien llama y después vuelve a Postgres **con ese mismo JWT**
    para dejar la auditoría con su `auth.uid()` real. La contraseña no se
    guarda ni se loguea en ninguna parte. Nota: cambiar la contraseña no cierra
    las sesiones ya abiertas de ese usuario (GoTrue no lo hace).
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
- **`price_lists`/`product_prices` con dueña** (2026-07-15; rehecho
  2026-08-04 en `migration-2026-08-04-shared-price-lists.sql`, que
  **reemplaza** a `migration-2026-07-15-restrict-vendedora-luzmar.sql`): la
  policy de solo-lectura de una vendedora sobre estas dos tablas ya no es un
  blanket `is_vendedora()` — ahora exige `can_vendedora_use_price_list()`,
  o sea que la lista no tenga dueñas (general) o que ella sea una de
  ellas. Antes cualquier vendedora podía ver la columna/precios de una
  lista "personal" ajena (ej. `luzmar`) en la matriz de Precios y en el
  selector de listas; ahora esas filas directamente no vienen en la
  respuesta de Supabase para el resto. Ver "Listas compartidas" en la
  sección 1.
- **Reasignar/eliminar clientes con auditoría** (2026-07-14,
  `migration-2026-07-14-client-admin-actions.sql`): solo admin, vía RPC
  `SECURITY DEFINER` `reassign_client(p_client_id, p_vendedora_id)` y
  `delete_client(p_client_id)` — no con `update`/`delete` directos, para
  que cada acción quede registrada sí o sí en la tabla `admin_audit_log`
  (quién/qué/cuándo, con snapshot del cliente). `reassign_client` acota el
  destino a las dueñas de la lista del cliente si esa lista tiene dueñas
  (2026-08-04; antes rechazaba de plano cualquier cliente con lista
  personal — ahora, en una lista compartida, repartir sus clientes entre
  las dueñas es justamente lo que hay que poder hacer);
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
- **Auditoría clientes app vs. SellerCloud** (2026-07-16, a pedido del
  usuario: notó que Adriana Montilla tenía 190 clientes en la app pero
  solo 150 en SellerCloud, y quería confirmar que no fueran "fantasma" —
  la app todavía no está en producción, así que su tabla `clients`
  debería reflejar solo lo real de SellerCloud). Se comparó el export
  real de SellerCloud (868 clientes activos, generado por el usuario vía
  n8n) contra los 1023 de la app, cruzando por `sellercloud_id` y por
  nombre normalizado. Encontró 3 causas distintas, no solo la de
  Adriana: (1) **86 duplicados huérfanos** — el cliente real ya existe en
  la app correctamente vinculado a SellerCloud con otro
  `sellercloud_id`, pero desde la carga masiva inicial (2026-07-02)
  quedó una segunda fila con el mismo nombre y un teléfono mal tipeado
  que ni siquiera coincidía en los últimos 10 dígitos (por eso el índice
  único de teléfono del punto anterior no lo detectó) —
  `migration-2026-07-16-cleanup-unlinked-duplicate-clients.sql` los
  borra por teléfono exacto, solo si siguen sin `sellercloud_id` y sin
  pedidos; (2) **21 clientes con vendedora incorrecta** — el cliente es
  real y su `sellercloud_id` es correcto, pero la app lo tenía asignado
  a otra vendedora que la que dice SellerCloud (18 de ellos mal puestos
  bajo Maria Fernanda Sardua, en realidad de Manuela
  Henriquez/Luzmila Ernandez/Yusleidy Romero/Jesus Rodriguez/Daniela
  Bohorquez — esto también explica por qué esas 4 aparecían con MENOS
  clientes en la app que en SellerCloud) —
  `migration-2026-07-16-reassign-vendedora-mismatches.sql` los reasigna
  por `sellercloud_id`; (3) **103 sin match** que no corresponden a
  ningún nombre del export real — podrían ser clientes que SellerCloud
  ya dio de baja o basura de la carga inicial, el usuario pidió
  dejarlos sin tocar por ahora. Aparte, **35 clientes reales de
  SellerCloud todavía no están sincronizados a la app** (sobre todo sin
  vendedora asignada) — dato relevante para antes de salir a
  producción, no forma parte de esta limpieza. Ambas migraciones toman
  backup propio (`clients_backup_20260716_*`) antes de tocar nada.
  **Ambas migraciones corridas en producción** (2026-07-16, confirmado
  por el usuario). El caso de "vendedora incorrecta" se coordinó con la
  sesión que lleva el flujo de n8n (Claude Desktop): confirmado que NO es
  un bug de n8n (los 21 casos vienen de la carga manual del 2026-07-02,
  antes de que existiera el sync — la vendedora vieja quedó preservada
  por el `coalesce()` de la rama `linked_by_phone` de
  `sync_upsert_clients` cuando el salesman no matcheaba en el momento del
  primer vínculo). El n8n hace *resync completo* dos veces al día, así
  que los 21 casos ya corregidos no deberían volver a desactualizarse
  solos. Sobre los 35 faltantes, se filtró la lista a 24 candidatos
  reales (excluyendo ~11 cuentas de prueba/test de SellerCloud) para que
  Claude Desktop los cruce contra logs de timeout (`ETIMEDOUT`) de
  corridas recientes — pendiente esa respuesta. Los 103 sin match quedan
  a decisión del usuario con su equipo, fuera del alcance de esta
  limpieza.
- **Editar ítems de una cotización con auditoría** (2026-07-17,
  `migration-2026-07-17-orders-edit-live-quotes.sql`, a pedido del
  usuario: una vendedora ahora puede corregir una cotización ya
  recibida, no solo cambiarle el estado): RPC `SECURITY DEFINER`
  `update_order_items(p_order_id, p_items)` — permite admin (cualquier
  pedido) o vendedora (solo los de sus propios clientes). **Solo
  cotizaciones (`kind = 'quote'`) y solo mientras siguen `new`** — ajuste
  del mismo día a pedido del usuario, sobre una primera versión que
  editaba cualquier pedido no cancelado: rechaza `kind = 'order'` y
  rechaza `status <> 'new'` (ni atendida ni cancelada se edita). Recalcula
  precio/total en el servidor (nunca confía en lo que manda el navegador)
  y **audita el antes/después en `admin_audit_log`** (acción
  `edit_order_items`, columna `order_id` nueva) antes de escribir.
- **Marcar atendido/cancelar/reabrir con confirmación y auditoría**
  (2026-07-17, mismo archivo, a pedido del usuario): antes era un
  `update` directo a `orders.status` sin dejar rastro. Ahora
  `OrdersAdmin.jsx` pide confirmación en un modal y llama a la RPC
  `SECURITY DEFINER` `update_order_status(p_order_id, p_status)`, que
  valida permiso (admin, o vendedora sobre sus propios pedidos) y audita
  el cambio (`update_order_status`, `from_status`/`to_status`).
- **Convertir cotización en pedido** (2026-07-17, mismo archivo, a
  pedido del usuario): RPC `SECURITY DEFINER`
  `convert_quote_to_order(p_order_id)` — a diferencia de una cotización
  (que nunca congela precio, ver abajo), acá sí: recalcula con la lista
  de precio real del cliente y pasa `kind` a `'order'`, auditado
  (`convert_quote_to_order`). Rechaza si el pedido no es una cotización,
  si está cancelada, o si el cliente sigue en la lista `quote` (no hay
  precio real que congelar).
- **Todo pasa por RPC auditadas, nunca por `update` directo** (2026-07-17):
  la policy `vendedora_update_own_orders` le da a una vendedora `update`
  crudo sobre sus propios pedidos (pensada solo para el status) — sin un
  candado extra, esa misma policy le hubiera dejado reescribir
  `items`/`total`/`status`/`kind` a mano, sin pasar por ninguna RPC ni
  quedar auditado. El trigger `orders_guard_items_edit` cierra ese hueco:
  bloquea cualquier `update` directo a `orders` que cambie alguna de esas
  4 columnas — **5 desde 2026-08-04, con `stock_applied`** — salvo que la
  bandera de sesión transacción-local `app.allow_order_edit` esté prendida,
  cosa que solo hacen
  `update_order_items`/`update_order_status`/`convert_quote_to_order`
  justo antes de escribir cada una. Sin blindar `stock_applied`, una
  vendedora podría prender/apagar la bandera a mano y saltearse o duplicar
  el descuento de stock de un pedido sin dejar rastro.
- **Movimiento de stock server-side** (2026-08-04,
  `migration-2026-08-04-order-stock.sql`): el navegador nunca dice cuánto
  descontar — `update_order_status`/`convert_quote_to_order` llaman al helper
  `apply_order_stock(p_order_id, p_direction)`, que lee las cantidades de
  `orders.items` (ya recalculadas en el servidor por `compute_order_items`) y
  suma/resta sobre `products.stock`. El helper no tiene grant a
  `anon`/`authenticated` (mismo criterio que `compute_order_items`) y el
  movimiento queda en `admin_audit_log` dentro del `detail` de la acción,
  con SKU, cantidad y el antes/después de cada producto. La disponibilidad
  resultante no la calcula el helper: la deriva el trigger
  `products_availability_from_stock` sobre `products`, así el resultado es el
  mismo venga el cambio de stock de donde venga (sync, Excel, formulario o
  este descuento) y un producto en 0 nunca puede quedar marcado Disponible.
- **Cotizaciones con precio vigente, no congelado** (2026-07-17, mismo
  archivo): una cotización (`kind = 'quote'`) nunca guardó precio en
  `orders.items` (siempre `null`, ver `get_catalog`/`create_order`) — lo
  nuevo es que el panel ya no la muestra "sin precio" sin más: la RPC
  `get_quotes_live_pricing(p_order_ids)` recalcula al vuelo el precio
  **actual** de cada ítem contra `product_prices`/`flash_sales` de la
  lista del cliente (reusa el helper `compute_order_items`, factorizado
  del cuerpo que antes tenía `create_order`), así una cotización se
  ajusta sola si el admin cambia un precio después de que el cliente la
  pidió. Omite del resultado los pedidos que el caller no tiene permiso
  de ver en vez de tirar error (para pedir varias de una sola vez sin que
  una ajena tumbe el resto).
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
  payload). **El workflow de n8n está armado y corriendo en producción**
  (confirmado por el usuario el 2026-08-04: mantiene el stock de los
  productos actualizado constantemente, además del resync completo de
  clientes dos veces al día). Se había detectado antes por evidencia
  indirecta (2026-07-15, una tanda de ~45 clientes duplicados creados en el
  mismo segundo, la huella de `sync_upsert_clients`) — ver el bug de
  teléfonos duplicados en la sección 6, que salió de eso. Sigue pendiente
  del lado de n8n el **nodo de cierre de `sync_runs`** (el `PATCH` final con
  los contadores), sin el cual la tabla de auditoría de corridas queda
  incompleta.
- ~~`migration-2026-07-15-restrict-vendedora-luzmar.sql`~~ **ya no hace falta
  correrla**: quedó reemplazada por
  `migration-2026-08-04-shared-price-lists.sql`, que deja las mismas policies
  ya adaptadas a listas con varias dueñas. Nunca se corrió en producción, así
  que hasta que corra la del 08-04 sigue activa la policy blanket vieja (toda
  vendedora ve la lista de Luzmar en la matriz de Precios).
- `migration-2026-08-04-shared-price-lists.sql` **ya corrida en producción**
  (2026-08-05: lo confirma el preflight de `migration-2026-08-05-superadmin.sql`,
  que corta si esta falta y sí corrió — ver más abajo. Este ítem la listaba como
  pendiente por error). Reemplaza `price_lists.owner_vendedora_id` (una dueña) por la
  tabla `price_list_owners` (varias), para poder **compartir** una lista entre
  dos vendedoras — ver "Listas con dueña" en la sección 1. Migra la dueña que
  ya existía, dropea la columna vieja, reescribe el trigger
  `clients_enforce_owner_vendedora`, `reassign_client` y
  `update_client_price_list`, y deja las policies de
  `price_lists`/`product_prices`/`price_list_owners`. Requiere
  `migration-2026-07-09-luzmar-owner-link.sql` y
  `migration-2026-07-14-client-admin-actions.sql` ya corridas. **Sola no
  cambia nada funcional** (Luzmar sigue siendo la única dueña de su lista);
  para compartirla hay que correr aparte el `insert` que está al final del
  archivo.
- `migration-2026-08-05-superadmin.sql` **corrida en producción** (2026-08-05,
  confirmado por el usuario) y Edge Function `supabase/functions/superadmin-users`
  **desplegada** el mismo día: el rol superadmin está activo (tabla
  `superadmins` + `is_superadmin()`, `is_admin()` que lo incluye, las policies
  nuevas de `admins`/`price_list_owners` y las 12 RPC `sa_*` — ver secciones 2 y
  6). Como esa migración abre con un preflight que corta si faltan
  `migration-2026-07-14-client-admin-actions.sql` o
  `migration-2026-08-04-shared-price-lists.sql`, el hecho de que haya corrido
  confirma que esas dos ya estaban aplicadas. Antes de correrla se probó contra
  un PostgreSQL 18 desechable (18 bloques de assert: identidad de los 3 roles,
  rechazo de las RPC a un admin común, RLS de
  `admins`/`price_list_owners`/`superadmins` actuando como el rol
  `authenticated`, ciclo completo de dueñas incluida la promoción de la
  principal y la reasignación de clientes colgados, validación del código de
  lista, guardas del borrado, y auditoría de cada acción).
- **Pendiente y urgente: correr `migration-2026-08-05-order-capture.sql`** en
  producción — es el arreglo del pedido de ~10k que se envió por WhatsApp y no
  quedó registrado (ver "Si el pedido no llega a registrarse" en la sección 1).
  Sube el tope de líneas de `create_order` de 200 a 1000, crea `order_failures`
  (+ RLS + `grant select`), agrega `orders.request_id` con índice único
  parcial, suma `request_id` al trigger `orders_guard_items_edit` y crea
  `recover_order_failure`. **Hasta que corra, el bug sigue vivo**: cualquier
  pedido de más de 200 líneas distintas se pierde en silencio.
  - **Correr el SQL ANTES de desplegar el frontend.** El frontend nuevo manda
    `p_request_id`, que la función vieja no acepta. Igual no se cae si el orden
    se invierte: `CartDrawer.jsx` detecta ese error y reintenta sin el
    parámetro (pierde solo la idempotencia hasta que corra el SQL).
  - Abre con un **preflight** que corta sin tocar nada si falta
    `compute_order_items` (o sea `migration-2026-07-17-orders-edit-live-quotes.sql`)
    o las funciones del rol vendedora. Crea `orders.stock_applied` y
    `admin_audit_log.order_id` con `if not exists` por si aquellas migraciones
    no corrieron, porque el trigger que reescribe nombra `stock_applied` y sin
    la columna reventaría en el primer `update` a `orders`.
  - Probada contra un PostgreSQL 18 desechable: tope 199/200 entra y 201/250
    entra después del cambio; 1001 líneas rechaza y deja la fila en
    `order_failures`; el mismo `request_id` tres veces devuelve el mismo
    `order_id` y deja **un** pedido; un frontend viejo (3 y 4 argumentos) sigue
    funcionando; `recover_order_failure` rechaza a anon, a una vendedora ajena
    y al segundo intento, y audita; RLS de `order_failures` verificada como rol
    `authenticated` (admin ve todo, vendedora solo lo suyo, `anon` nada, y
    ninguno puede escribirla). También se midió el costo del loop para elegir
    el tope: 48 ms con 200 líneas, 651 ms con 1000, 2.4 s con 2000.
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
- **Pendiente: correr `migration-2026-07-17-apply-price-list.sql`** en
  producción (crea la RPC `apply_price_list`). Sin esto, subir un Excel de
  precios desde `/admin/prices` falla contra la base — el frontend ya
  quedó desplegable con el flujo nuevo (una lista por archivo + preview/
  confirmar). Reemplaza el `.upsert()` directo a `product_prices` que
  reventaba con "ON CONFLICT DO UPDATE command cannot affect row a second
  time" si el Excel traía un SKU repetido (pasó con el archivo real de US
  Minimum Order, SKU `ZX_PE-MA-U-599175` duplicado) — la dedup por SKU
  ahora la hace la RPC del lado del servidor.
- **Pendiente: correr `migration-2026-07-17-orders-edit-live-quotes.sql`**
  en producción (crea `admin_audit_log.order_id`, el trigger
  `orders_guard_items_edit` (blinda `items`/`total`/`status`/`kind`), el
  helper `compute_order_items` y las RPC
  `update_order_items`/`update_order_status`/`convert_quote_to_order`/
  `get_quotes_live_pricing` — ver sección 6). Sin esto: editar una
  cotización falla, "Convertir en pedido" falla, marcar atendido/
  cancelar/reabrir falla (ya no es un `update` directo), y las
  cotizaciones se ven sin precio en vez de mostrar el precio vigente. El
  frontend (OrdersAdmin, CartDrawer, AuditLogAdmin) ya está desplegable.
- **Pendiente: correr `migration-2026-08-04-order-stock.sql`** en producción
  (agrega `orders.stock_applied`, el trigger
  `products_availability_from_stock`, el helper `apply_order_stock`, y
  reescribe `update_order_status`/`convert_quote_to_order` para mover el
  stock — ver "Descuento de stock al atender un pedido" en la sección 2).
  Requiere que `migration-2026-07-17-orders-edit-live-quotes.sql` ya esté
  corrida (esta reescribe funciones que aquella crea). Crea también
  `products.stock` con `if not exists`, por si acaso, pero esa columna **ya
  existe**: `migration-2026-07-14-inventory-stock.sql` está corrida y el sync
  de n8n mantiene el inventario al día (confirmado por el usuario el
  2026-08-04 — este README y el `ZIMAXX-STORE-INFO.md` la listaban como
  pendiente por error). O sea que el descuento tiene de dónde restar desde el
  momento en que se corra esta migración. Sin ella, el panel de Pedidos sigue
  funcionando pero no descuenta nada; el frontend ya está desplegable.
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
  context/CartContext.jsx   Carrito (localStorage, clave por product id) + request_id por carrito (idempotencia del alta)
  utils/
    excel.js            Parser Excel (detección de encabezados, columna de fotos) + exports: pedido (UploadTemplate.xls), productos sin foto, registro de movimientos
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
      AuditLogAdmin.jsx Registro de movimientos (clientes, pedidos, superadmin)
      VendedoresAdmin.jsx  Alta manual de vendedoras + teléfono + acceso
      FlashSalesAdmin.jsx
      OrdersAdmin.jsx   Bandeja de pedidos + aviso de los que no se registraron (order_failures) con "Recuperar"
      SuperAdminPanel.jsx  Usuarios/roles/contraseñas + dueñas de listas (solo superadmin)
      ui.jsx            Piezas compartidas (UploadZone, SearchIcon, ...)
supabase/schema.sql     Esquema completo + RLS + RPCs + migraciones
supabase/migration-*.sql  Deltas idempotentes para producción (no re-correr el schema completo)
supabase/functions/admin-create-vendedora-user/  Edge Function (Deno) — crea el usuario de Auth de una vendedora, requiere deploy manual
supabase/functions/superadmin-users/  Edge Function (Deno) — cambia contraseñas y crea admins (Admin API de Auth), requiere deploy manual
```
