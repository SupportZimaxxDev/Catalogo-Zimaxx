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
- **El UPC sí viaja al cliente desde 2026-08-14**
  (`migration-2026-08-14-catalog-upc.sql`, a pedido del usuario): `get_catalog`
  lo devuelve y se ve en la tarjeta del catálogo, en el carrito y como columna
  propia del PDF. Es el código con el que muchos clientes piden. No confundir
  con el SKU, que sigue siendo interno. Un producto sin UPC cargado
  simplemente no lo muestra: no se dibuja línea vacía ni placeholder.
- **Disponibilidad**: `available`, `preorder` o `flash` (2026-07-08). Los
  pre-order se muestran con badge dorado "Pre-Order" en el catálogo y se
  pueden pedir igual; el estado viaja en el mensaje de WhatsApp. Los
  `flash` se muestran con badge 🔥 "Flash Sale" y tienen su propio chip de
  filtro. **Una Flash Sale es exactamente eso: una etiqueta** (2026-08-07) —
  no tiene precio propio ni cuenta regresiva; marca los productos de los que
  se quiere mover inventario, y el precio sigue siendo el de la lista del
  cliente. Se pone de tres formas: la columna Type del Excel de inventario,
  el Excel de Flash Sales de la pestaña Productos, o la selección en bloque
  de esa misma tabla. (Hasta 2026-08-06 existía además una tabla
  `flash_sales` de ofertas con precio promo + countdown y su propia pestaña;
  se eliminó del producto — ver "Flash Sales" en la sección 3.)
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
- **Y además lo saca del catálogo** (2026-08-12,
  `migration-2026-08-12-hide-out-of-stock.sql`): un producto que queda con
  `stock <= 0` pasa a Pre-Order **y a inactivo**, así que `get_catalog` deja de
  devolverlo. Esto revierte a propósito media decisión del 2026-07-14 ("stock 0
  se muestra como pre-order; ocultarlo es una acción manual aparte"): la
  **etiqueta** sigue siendo Pre-Order —es el dato con el que la asesora sabe que
  se puede reservar— lo que cambia es la **publicación**.
  - **Vuelve solo cuando entra stock**, pero solo el que apagó esta regla. Eso
    lo distingue la columna nueva `products.deactivated_by_stock`: `true` =
    "lo apagó el stock" (se reactiva en cuanto `stock >= 1`), `false` = si está
    inactivo lo apagó una persona (o la exclusión de no-catálogo: SKU
    `-SPECIAL`/`-BOX`, beauty/electronics/support/packing/test) y solo una
    persona lo vuelve a prender. Sin esa bandera, reactivar por stock resucitaría
    también lo que se apagó a mano.
  - Un producto **🔥 Flash Sale con stock 0 también se despublica**: conserva la
    etiqueta (el stock nunca la pisa), pero una Flash Sale es para mover
    inventario y sin inventario no hay nada que mover.
  - **Lo que ya estaba en el carrito se puede pedir igual**:
    `compute_order_items` busca el producto con `(active or
    deactivated_by_stock)`, así que la línea de un cliente que mandó el pedido
    justo después de que el sync bajó el stock no se cae en silencio (es un
    pre-order: agotado pero reservable). Lo que apagó una persona sigue sin
    poder pedirse.
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

- El buscador de `Catalog.jsx` matchea **nombre, categoría (marca), línea o
  UPC** (buscar "adidas" trae todo lo de esa marca, "arabes" trae todo
  lo de `Perfume - Arabes`, y pegar un código de barras —entero o un pedazo—
  trae ese producto; el UPC entró en la búsqueda el 2026-08-14, junto con
  mostrarlo en la tarjeta: si se ve pero no se puede buscar, no sirve de
  nada). Además de los chips de marca hay un chip de
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
   botón "Armar otro pedido". El acuse **dice solo eso** desde 2026-08-14 (a
   pedido del usuario): antes debajo iba una línea explicando que se había
   vaciado el carrito "para que no se envíe dos veces por error" — el
   comportamiento no cambió, solo se dejó de anunciar (se fue la clave
   `cartCleared` de `i18n.jsx`). Además **no queda nada guardado en el
   dispositivo**: `CartContext` borra la clave de `localStorage` cuando el
   carrito queda vacío, en vez de dejar un `[]` guardado — importante porque el
   link del catálogo se comparte por WhatsApp y se abre en teléfonos que a
   veces no son del cliente. Vaciar a mano con "Vaciar carrito" hace lo mismo.
5. La vendedora marca el pedido **Atendido** y recién entonces lo manda a
   SellerCloud con un botón (2026-08-17; modalidad 2026-08-18) — ver más
   abajo.

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

#### El pedido que nunca llega al servidor (2026-08-17)

Lo de 2026-08-05 cubre al pedido que **llega y el servidor rechaza**: eso queda
en `order_failures` y se rescata desde el panel. Quedaba afuera el otro caso —
el request que **nunca llegó**, que no deja rastro ni en el teléfono del cliente
ni en la base. El usuario seguía viendo pedidos que llegaban por WhatsApp y no
estaban en el sistema. Cuatro agujeros, todos en el camino del checkout:

- **Los reintentos corrían cuando el cliente ya se había ido.** `handleCheckout`
  abría WhatsApp y recién después llamaba a los reintentos, que esperaban con
  `setTimeout(700ms, 1400ms)`. Al saltar a WhatsApp la pestaña queda en segundo
  plano y los navegadores móviles **congelan los timers de las páginas ocultas**:
  en el peor caso esos reintentos no se ejecutaban nunca. La red de seguridad
  estaba del lado inalcanzable.
- **El request no sobrevivía a que la pestaña se descargara.** `supabase.rpc` usa
  `fetch` sin `keepalive`; si el sistema operativo recuperaba memoria o el
  cliente cerraba el navegador con el POST en vuelo, se cancelaba.
- **No había timeout.** Con mala señal el fetch se colgaba indefinidamente, el
  botón quedaba deshabilitado y el cliente ni veía abrirse WhatsApp.
- **El aviso no sobrevivía a una recarga.** `failed` era estado de React: al
  volver al día siguiente el cliente veía su carrito lleno *sin ninguna
  advertencia* y, como ya había mandado el WhatsApp, daba por hecho que pidió.

El arreglo vive en **`src/utils/orderOutbox.js`** (solo frontend, sin migración):

- El POST va a PostgREST directo con **`keepalive`**, así el navegador lo termina
  aunque la pestaña se descargue o pase a segundo plano — `supabase.rpc` no deja
  pasar esa opción, por eso el fetch es a mano con la misma anon key. Arriba de
  50 KB de cuerpo se manda sin `keepalive` (el límite del navegador son 64 KB y
  pasarse hace fallar el fetch de entrada).
- **Timeout de 5 s** por intento, con `AbortController`.
- El intento se graba en `localStorage` **antes** de mandarlo y se borra recién
  cuando el servidor contesta. Lo que quede ahí se reintenta **al abrir el
  catálogo y cada vez que la pestaña vuelve a primer plano** — que es justo
  cuando el cliente regresa de mandar el WhatsApp. Es seguro por el
  `request_id`: si el intento anterior sí había entrado, devuelve ese mismo
  pedido en vez de duplicarlo.
- El payload viaja **adelgazado a `{id, qty, flash}`**, que es lo único que lee
  `compute_order_items`; antes iba el ítem entero (nombre, precio, UPC), ~4 veces
  más bytes justo cuando la señal del cliente es peor.
- Un pendiente se descarta si es **de otro cliente** (se compara el `tokenHint`,
  mismo criterio que `order_failures.token_hint`: el link del catálogo se
  comparte por WhatsApp y el mismo teléfono puede abrir el de otra persona — sin
  ese chequeo el pedido de A se reenviaría bajo el token de B) o si tiene **más
  de 24 h** (los precios y el stock ya se movieron, y lo más probable es que la
  asesora lo haya cargado a mano desde el chat).

Además, el aviso del drawer ahora **distingue los dos casos** (`failed` pasó de
un string a `{ kind, reason }`): un fallo de red mantiene el aviso rojo con
"Reintentar", pero un **rechazo del servidor** muestra un aviso ámbar que dice
que la asesora lo va a completar y **no ofrece reintentar** — el rechazo es
determinista, insistir falla igual y cada intento sumaba otra fila a
`order_failures`.

Verificado con Playwright contra el build real, con la red interceptada (nada
sale a producción): que el pedido queda pendiente y el aviso aparece cuando la
red se cae; que al volver al catálogo se reintenta solo, con el mismo
`request_id`, y el carrito se vacía; que un rechazo no queda pendiente ni ofrece
reintento; que un pendiente de otro cliente o de más de 24 h se descarta sin
mandarse; que el payload viaja adelgazado; y que **WhatsApp se sigue abriendo
aunque el registro falle**.

#### Enviar el pedido a SellerCloud (2026-08-17; modalidad 2026-08-18)

Hasta acá, cerrar un pedido terminaba en un paso a mano: bajar el Excel con el
formato de `UploadTemplate.xls` y subirlo al bulk-order upload de SellerCloud.
Ahora hay un botón **"📦 Enviar a SellerCloud"** en cada fila de la bandeja de
Pedidos: crea la orden allá, asociada al correo de la vendedora como Sales Rep
y con Marketing Source "catalogo online".

Una vez enviado, el badge **"SellerCloud #N"** de la fila es un **link a la
orden en el portal** (`fc2.delta.sellercloud.com/orders/order-details.aspx?id=N`,
2026-08-19) que abre en pestaña nueva, y la bandeja tiene un **filtro
"Enviadas / Sin enviar a SellerCloud"** (por `sellercloud_order_id`), que se
combina con los filtros de estado, tipo y vendedora.

**Solo pedidos Atendidos** (modalidad definida por el usuario el 2026-08-18):
el botón queda deshabilitado — con la explicación en el tooltip — hasta que el
pedido se marque Atendido, y la Edge Function lo exige también del lado del
servidor. La revisión humana es ESE paso; por eso la orden ya **no** se deja
On Hold en SellerCloud como en la versión del 2026-08-17 — el hold era un
segundo control para una orden que ya se revisó acá (y atender el pedido ya
descontó el stock local antes del push).

**Las piezas.** El usuario y la contraseña de la API de SellerCloud no pueden
estar en el navegador ni en la base, así que el HTTP lo hace una Edge Function:

- `supabase/functions/sellercloud-push-order/sellercloud.ts` — el cliente de la
  API. **No importa nada de Deno a propósito**: solo usa `fetch`, que existe
  igual en Node, y por eso se puede probar entero contra un servidor falso sin
  desplegar nada.
- `.../index.ts` — el envoltorio de Edge Function: valida, arma y anota.
- `tests/sc-push-tests.mjs` — la suite del cliente (22 comprobaciones, Node
  puro contra un servidor falso; ver "Cómo está verificado" más abajo).
- `migration-2026-08-17-sellercloud-push.sql` — `orders.sellercloud_order_id` /
  `sellercloud_pushed_at` / `sellercloud_error`, y la RPC
  `mark_order_sellercloud` que anota el resultado con permiso y auditoría.

**La API de SellerCloud**, tal como está documentada (agosto 2026):

| Paso | Llamada |
| --- | --- |
| Token | `POST {base}/rest/api/token` con `{Username, Password}` → `access_token`, dura 60 min |
| Cliente | `GET {base}/rest/api/Customers/{id}` |
| Crear orden | `POST {base}/rest/api/Orders/` con `CustomerDetails` + `OrderDetails{CompanyID, Channel: 21}` + direcciones + `Products[]` |
| Asignar el rep | `PUT {base}/rest/api/Orders/{id}` con `{ SalesRep1: <id> }` (2026-08-19, ver abajo) |
| Órdenes (lectura) | `GET {base}/rest/api/Orders` — cada fila trae `SalesRepEmail` + `SalesRepId`; con `model.orderIDs=` filtra órdenes puntuales (así se verifica qué quedó aplicado) |

Canal Wholesale = 21. (Hasta el 2026-08-18 había un paso `PUT
{base}/api/Orders/StatusCode` para dejar la orden On Hold = 200; se quitó con
el cambio de modalidad — el candado de Atendido lo reemplaza.)

> **El POST de creación IGNORA `OrderDetails.SalesRepresentative`**
> (descubierto el 2026-08-19: los campos están en el modelo del Swagger y el
> servidor contesta 200, pero las órdenes entraban con `SalesRepId 0`; se
> comprobó releyendo órdenes reales). El único camino que el servidor aplica
> es el `PUT /api/Orders/{id}` con el campo **`SalesRep1`** (nombre distinto
> que en el create, viene del `UpdateOrderRequest`). Por eso `pushOrder` asigna
> el rep en un **segundo paso** después de crear, manda SOLO ese campo (los
> demás del modelo van ausentes para no tocarlos) y **relee la orden** para
> verificar que quedó — la lección es que acá un 200 no confirma nada. Como la
> orden ya existe al llegar a ese paso, cualquier fallo posterior se degrada a
> `warning` y nunca a error de envío (un error haría reintentar y duplicaría
> la orden).

> **Las direcciones hay que TRADUCIRLAS, no copiarlas** (2026-08-19, reporte
> de una vendedora: "las órdenes llegan sin dirección de shipping"). El create
> sí aplica las direcciones, pero espera `OrderAddressDto`
> (`FirstName`/`LastName`/`Business`/`Address`…) y la ficha del cliente las
> devuelve como `UserAddressDto` (`ContactName`/`CompanyName`/`Address`…).
> Copiarlas textual — lo que se hacía — guardaba calle/ciudad/zip pero perdía
> el **nombre del destinatario**: en el panel de SellerCloud esa dirección se
> ve como vacía y el label saldría sin nombre (las vendedoras las corregían a
> mano). `toOrderAddress` en `sellercloud.ts` hace el mapeo: parte
> `ContactName` en nombre/apellido (primera palabra + resto), cae al nombre
> del cliente si la dirección no trae contacto, mapea `CompanyName` →
> `Business` y no deja pasar las claves basura del DTO del cliente (ID,
> flags, RowStatus). En una orden ya creada, las direcciones se corrigen con
> el mismo `PUT /api/Orders/{id}` del rep, pero con OTRO shape más
> (`AddressWithSeparateAddrLinesDto`: `AddressLine1` en vez de `Address`) —
> tres nombres distintos para el mismo campo según el endpoint.

**Sales Rep y Marketing Source (2026-08-18).** La orden queda además con el
Sales Rep de **la vendedora del pedido** y el Marketing Source **"catalogo
online"**. Los dos son **enteros** (no hay ningún endpoint para resolver un
email o un nombre a su ID, según el Swagger del propio servidor en
`/rest/swagger/docs/v1`) — así que el mapeo vive de este lado:

- El ID de empleado de cada vendedora va en `vendedores.sellercloud_rep_id`
  (`migration-2026-08-18-sellercloud-salesrep.sql`), editable en la pestaña
  Vendedoras (columna "SellerCloud"; el ID sale de SellerCloud → Settings →
  Employees). Desde el cambio de modalidad (2026-08-18), **la orden se asocia
  a la vendedora del pedido apriete quien apriete**: la cadena es ID cargado
  de la vendedora del cliente → resolución por su `login_email` → correo de
  quien apretó SOLO si el cliente no tiene vendedora — así un admin que
  aprieta no se atribuye la venta.
- **En la práctica el ID casi nunca se carga a mano**: si la fila no lo tiene,
  la función resuelve el **correo** sola. No hay endpoint de empleados, pero
  cada orden leída (`GET /api/Orders`) trae `SalesRepEmail` + `SalesRepId`
  juntos: `findSalesRepIdByEmail` busca el correo (case-insensitive) en las
  órdenes recientes de la compañía — hasta 5 páginas de 200, más nuevas
  primero —, guarda el ID encontrado en `vendedores` (si el JWT puede
  escribirlo) y lo cachea en el isolate (24 h si encontró, 10 min si no). El
  campo manual queda como **override** para cuando el correo del empleado en
  SellerCloud no coincide con el login de acá, o el rep todavía no tiene
  ninguna orden asignada allá.
- El ID de "catalogo online" va en el secret `SELLERCLOUD_MARKETING_SOURCE_ID`
  (la fuente se crea una vez en SellerCloud y se anota su ID).
- Si falta cualquiera de los dos, **la orden entra igual** sin ese campo y el
  aviso lo dice — nunca se pierde la orden por un dato accesorio. Un valor
  basura (0, NaN, negativo) tampoco viaja: un ID inválido haría que
  SellerCloud rechace la orden entera.

**Decisiones que no son obvias:**

- **Los datos del cliente se leen de SellerCloud en el momento del envío**, no
  de nuestra base. Email y direcciones son obligatorios para crear la orden y
  allá es donde viven; copiarlos a `clients` sería una segunda copia que se
  desincroniza sola. Ya teníamos lo único que hacía falta para ir a buscarlos:
  `clients.sellercloud_id`, que llena el sync de n8n desde julio.
- **El SKU es el `ProductID` de SellerCloud**, así que las líneas se arman
  directo — es la misma equivalencia que ya usaba el Excel de `UploadTemplate`.
- **El precio que viaja es el nuestro** (`SitePrice`, el de la lista del
  cliente que ya calculó el servidor al registrar el pedido), no el de
  SellerCloud.
- **Una sola vez**: mientras el pedido tenga `sellercloud_order_id`, en lugar
  del botón se muestra ese número. Duplicar una orden allá obliga a ir a
  cancelarla a mano, así que el índice único sobre esa columna impide además
  que dos pedidos apunten a la misma orden.
- **Si falta el Sales Rep o el Marketing Source, la orden entra igual** sin
  ese campo y el aviso lo dice — se corrige para la próxima, no se pierde
  esta. Y si falla el anotar de vuelta (la orden ya existe allá pero no se
  pudo guardar el número acá): el error trae el número adentro y dice
  explícitamente que no se vuelva a mandar.
- **El motivo del fallo se guarda en el pedido** (`sellercloud_error`), no solo
  en pantalla: al recargar sigue estando, y no hay que ir a los logs de la
  función para saber por qué no entró.
- **Cotizaciones no**: solo `kind = 'order'`. Una cotización va a SellerCloud
  recién cuando alguien la convierte en pedido.
- **Permiso y auditoría viven en SQL, no en Deno**: la Edge Function llama a
  `mark_order_sellercloud` **con el JWT de quien apretó el botón** y nunca usa
  la service_role key, así la regla de "admin, o vendedora sobre lo suyo" está
  escrita una sola vez. Queda en el Registro de movimientos como *Orden enviada
  a SellerCloud*, con el número de allá.

**Qué hace falta para que funcione** (migración corrida, función desplegada y
secrets cargados — al 2026-08-18 **las tres cosas ya están hechas en
producción**; esto queda como referencia para rehacerlo):

```
supabase functions deploy sellercloud-push-order
supabase secrets set SELLERCLOUD_BASE_URL=https://XX.api.sellercloud.com \
                     SELLERCLOUD_USERNAME=... \
                     SELLERCLOUD_PASSWORD=... \
                     SELLERCLOUD_COMPANY_ID=... \
                     SELLERCLOUD_WAREHOUSE_ID=...            # opcional
supabase secrets set SELLERCLOUD_MARKETING_SOURCE_ID=...     # opcional: ID de "catalogo online" (2026-08-18)
```

> `SELLERCLOUD_BASE_URL` es **solo el host de la API** — para esta cuenta,
> **`https://fc2.api.sellercloud.com`** (el portal web es
> `fc2.delta.sellercloud.com`; el patrón es portal `<srv>.delta.` → API
> `<srv>.api.`) — sin `/rest/api` ni barra final: la función ya se los agrega.
> El error `Unexpected token '<', "<!doctype "... is not valid JSON` que
> apareció al probar el 2026-08-18 era justo esto: el secret apuntaba al
> portal, que devuelve la página de Login (HTML), y el `res.json()` lo escupía
> crudo. Ahora el cliente lee el cuerpo como texto y, si parece HTML, el
> mensaje dice el paso, el status, la URL y que casi seguro hay que revisar
> `SELLERCLOUD_BASE_URL`. `normalizeBaseUrl` además tolera que el secret venga
> con `/rest/api` de más. El mismo día cayó un segundo bug, ya nuestro: el
> cuerpo se recortaba a 2 KB **antes** de parsear (el límite era para mensajes
> de error) y la respuesta real de `Customers/{id}` — que anida todo bajo
> `General` y pasa largo ese tamaño — daba "la respuesta no es JSON" siendo
> JSON válido. El recorte quedó solo al armar el mensaje de error. Y tercero:
> la respuesta real trae las direcciones en la **lista `Addresses`**, no como
> `ShippingAddress`/`BillingAddress` sueltas — `fromAddressList` elige la
> marcada (bandera booleana que nombre ship/bill, o `AddressType`) y si no hay
> marca usa la primera; `Addresses` vacía da el error "cargásela allá".

**Cómo está verificado.** La suite del cliente de la API vive en el repo
desde el 2026-08-19 — **`tests/sc-push-tests.mjs`, 22 comprobaciones, se
corre con `node tests/sc-push-tests.mjs`** (Node 23+; `sellercloud.ts` no
importa nada de Deno a propósito). Corre contra un servidor falso que
reproduce los vicios REALES de esta API: el create que ignora el Sales Rep,
el PUT que puede fallar con 500 o contestar 200 sin aplicar, la relectura
vacía, y el shape verdadero del cliente (direcciones en la lista `Addresses`
con `ContactName`/`CompanyName`). Cubre el camino feliz completo
(create → PUT solo con `SalesRep1` → relectura), el mapeo de direcciones
(nombre partido, fallback al nombre del cliente, sin claves basura), la
degradación a warning de todo fallo posterior al create, y que extras basura
(NaN, 0, negativos) no viajan. Las suites anteriores (86 y 100
comprobaciones, 2026-08-17/18: token renovado al vencer, credenciales malas,
cliente sin email/dirección cortando antes de crear, el 200 con HTML en cada
paso, el resolvedor correo→ID) quedaban en el scratchpad de cada sesión y se
perdieron — por eso esta vive en `tests/`. Además hubo 14 comprobaciones de
la RPC contra un PostgreSQL 18 desechable y 8 de la pantalla con Playwright.

**La API real ya se ejercitó** (2026-08-19, con una Edge Function de
diagnóstico temporal, borrada al terminar): de ahí salieron los dos
descubrimientos grandes de arriba (el create ignora `SalesRepresentative`;
las direcciones necesitan traducción de DTO) y la reparación de las órdenes
ya creadas. La respuesta de `Customers/{id}` se sigue leyendo de forma
defensiva (varias claves alternativas) y si algo falta el error dice qué.

#### Cargar a mano el pedido que llegó por WhatsApp (2026-08-17)

Las dos redes anteriores dependen de algo: `order_failures` necesita que el
pedido haya llegado al servidor, y el pendiente del navegador necesita que el
cliente **vuelva** al catálogo. Cuando no pasa ninguna de las dos, lo único que
queda del pedido es el mensaje en el chat de la vendedora. Esto lo convierte en
un pedido: botón **"💬 Cargar pedido desde WhatsApp"** en la pestaña Pedidos
(`ManualOrderModal.jsx`), se pega el texto y sale el pedido.

**Cómo lee el mensaje.** `parseOrderMessage` en `src/utils/whatsapp.js`, pegado
al `buildOrderMessage` que lo genera — si alguien cambia el formato del mensaje,
tiene el parser a la vista. Aguanta lo que de verdad llega de un chat: el
membrete de WhatsApp adelante (`[17/8/26, 10:32] Ana: Cliente: Fulano`), los dos
idiomas, las negritas comidas, un "gracias!!" suelto en el medio y el espacio
duro que mete el copiar/pegar. Nada se traga en silencio: lo que tiene forma de
ítem pero no se entiende sale en `unparsed` y se muestra en pantalla.

**Cómo cruza los productos.** Por nombre exacto contra `products` (el mensaje
lleva el `name` tal cual lo escribió el carrito), normalizando mayúsculas y
acentos. Una línea con un solo candidato queda resuelta sola y muestra **qué
producto quedó**, con un botón "Cambiar"; las demás —nombre repetido entre SKU
distintos, o producto renombrado después del pedido— traen un buscador cuyos
resultados se eligen **con un click en la lista**. El pedido no se puede crear
mientras quede una línea sin producto, y la pantalla dice cuántas faltan.

> **Corregido el 2026-08-17, mismo día**, sobre una primera versión que el
> usuario reportó como trabada: "los perfumes que no se seleccionan solos, cuando
> los vas a seleccionar se queda el cuadro como si todavía no hubieras puesto
> cuál perfume es, y deja bloqueado el botón de crear la orden". Eran tres cosas
> sumadas, las tres del lado del panel:
> 1. El producto se elegía en un **`<select>` colapsado ubicado encima del
>    buscador**: se escribía abajo, los resultados entraban en el desplegable de
>    arriba y, hasta abrirlo, seguía diciendo "Elegir producto". Ahora los
>    resultados son una lista visible y se elige con un click.
> 2. **Carrera en el buscador**: cada tecla lanzaba una consulta y la respuesta
>    de una pulsación anterior podía llegar tarde y pisar (o vaciar) la lista de
>    resultados justo después de elegir, dejando el cuadro en blanco. Ahora cada
>    búsqueda lleva un número de secuencia y solo la última puede escribir.
> 3. **El botón se apagaba en silencio**: había un paso "Calcular precios" y
>    cualquier cambio posterior invalidaba el resultado, así que "Crear pedido"
>    se deshabilitaba sin explicar por qué. Ese botón ya no existe: el total se
>    calcula solo (debounce de 350 ms) en cuanto hay cliente y todas las líneas
>    resueltas, y el botón muestra el importe. Cuando sigue deshabilitado, arriba
>    dice exactamente qué falta — elegir el cliente de la lista, o cuántas líneas
>    quedan sin producto.
>
> Lo mismo aplicaba al cliente: tener el nombre escrito en el campo no es lo
> mismo que haberlo elegido de la lista, y esa diferencia no se veía. Ahora, una
> vez elegido, se muestra con ✓ y botón "Cambiar".

**El precio no sale del mensaje.** Lo calcula el servidor con la lista del
cliente, igual que en cualquier alta: el mensaje puede ser de ayer. Lo que decía
el mensaje se muestra al lado, solo para comparar. De eso se ocupan dos RPC
nuevas (`migration-2026-08-17-manual-order.sql`), las dos delgadas sobre
`compute_order_items`:

- `preview_manual_order` arma el pedido **sin guardar nada** y devuelve, además
  de los ítems con su precio vigente y el total: `dropped` (los que se cayeron
  porque el producto está apagado o borrado) y `no_price` (los SKU sin precio en
  la lista del cliente, que harían fallar el alta). Existe como RPC y no como
  cuenta del navegador porque **una vendedora no puede leer `product_prices` de
  una lista con dueñas**: el total le saldría vacío justo a ella.
- `create_manual_order` lo guarda y lo audita en `admin_audit_log`
  (`create_manual_order`), con el mensaje original en `detail.source_message` —
  la prueba de dónde salió ese pedido si mañana alguien pregunta. Es idempotente
  por `request_id`, así que un doble click no crea dos pedidos.

Permiso: admin sobre cualquier cliente, vendedora solo sobre los suyos (mismo
criterio que `update_order_items`). El tipo lo decide la lista del cliente, no
quien carga: si es `quote`, entra como cotización.

**Contra el duplicado**, que es el riesgo real de esta pantalla: al elegir el
cliente se muestran sus pedidos de las últimas 48 h, para que la vendedora vea
si el que está por cargar ya está.

Verificado en tres niveles: **30 comprobaciones del parser** (round-trip contra
el propio `buildOrderMessage`, en los dos idiomas, más los pegados sucios), **24
de las RPC** contra un PostgreSQL 18 desechable con la `compute_order_items`
real (precio y total del servidor, líneas caídas, SKU sin precio, permisos de
vendedora ajena y sin rol, idempotencia, lista `quote`), y **20 de la pantalla**
con Playwright contra el build real y toda la red interceptada — entre ellas el
caso que se reportó: teclear el nombre del perfume letra por letra (con varias
consultas en vuelo y respuestas fuera de orden), elegirlo de la lista y
comprobar que la elección sobrevive a las respuestas atrasadas y que el botón de
crear se habilita solo.

#### Subir el PDF de una cotización y convertirlo en pedido (2026-08-18)

La cotización que el catálogo genera en PDF también puede volver al sistema:
botón **"📄 Cargar cotización desde PDF"** en la pestaña Pedidos, que abre el
mismo modal del alta por WhatsApp con una **segunda pestaña**. Se sube el PDF
y de ahí en adelante el camino es idéntico al del mensaje (cliente, revisión
línea por línea, precios y total del servidor, `create_manual_order`); si la
lista del cliente es de cotización, lo creado nace como cotización y se
convierte en pedido con el botón de siempre de la bandeja. Sin migración: son
las mismas RPC del 2026-08-17.

**Cómo se lee el PDF** (`src/utils/quotePdf.js`, nuevo): con **pdfjs-dist**
(cargado bajo demanda, como jspdf y xlsx; el worker viaja como asset del
bundle). Como el PDF lo dibuja nuestra propia app, no se adivina con regex:
cada texto se clasifica por la **coordenada X** de su columna (nombre / UPC /
cantidad / plata), agrupando por renglón. Decisiones:

- **El cruce es por UPC primero**: el PDF recorta los nombres largos a 78mm,
  pero el UPC se imprime entero — justamente para esto. Después nombre exacto
  y, para lo recortado, `ilike 'nombre%'` (el texto cortado ES un prefijo del
  nombre real). Lo que no se resuelve queda en rojo con el buscador manual.
- **`normalize('NFC')` en el parser no es opcional**: pdfjs puede devolver los
  acentos como carácter combinante (NFD) y `products.name` está en NFC — se
  ven iguales, pero no matchean ni con `in()` ni con `ilike`.
- **El total impreso se muestra al lado del recalculado** y se resalta si
  difieren: la cotización puede ser de ayer. El que vale es el del servidor,
  siempre. La nota del pedido guarda de qué PDF salió y su total impreso.
- Las líneas de un PDF van **sin bandera flash** (el PDF no la imprime): si
  había precio flash, el recalculo lo pierde y se nota en la comparación.

Verificado con **24 comprobaciones en Node** (un PDF generado con el mismo
dibujo de la app: acentos, nombre recortado con UPC intacto, sin precios, 50
líneas cruzando páginas, un PDF ajeno que no revienta y deja lo ilegible a la
vista) y **18 con Playwright contra el build real** — navegador de verdad,
pdfjs y su worker desde el bundle, Supabase interceptado: el flujo entero
hasta `create_manual_order` con los ids, cantidades y nota correctos.

#### El drawer podía quedar congelado sin ningún aviso (2026-08-13)

`handleCheckout` y `handlePdf` en `CartDrawer.jsx` no tenían `try/finally`
alrededor de `setBusy`: si algo entre medio tiraba una excepción no prevista
(el sospechoso principal: el `import('jspdf')` dinámico rechazando por mala
señal), `busy` quedaba en `true` para siempre y los tres botones del drawer
(comparten ese estado) se veían pero deshabilitados, sin ningún mensaje —
reportado como "no me deja seleccionar nada". Ahora los tres handlers
(`handleCheckout`, `handlePdf`, `handleRetrySave`) sueltan `busy` siempre en
un `finally`, y una excepción no prevista pasa por el mismo aviso rojo +
"Reintentar" que ya existía para un fallo de red. Solo frontend, sin
migración. Distinto es el caso de una cotización cuyo PDF sí se descargó pero
nunca se guardó: eso pasa cuando el cliente cierra la pestaña entre el PDF y
el guardado (dos pasos async independientes) y no deja ningún rastro en la
base. **Desde 2026-08-17 sí tiene arreglo** (ver la sección siguiente): el
intento queda guardado en el teléfono antes de mandarse y se reintenta al
volver al catálogo, y el POST va con `keepalive` para sobrevivir al cierre de
la pestaña.

#### "Recuperar" siempre crea una cotización; los fallos sin cliente se pueden descartar (2026-08-13)

`recover_order_failure` ya no respeta el `kind` del intento original: sin
importar si el cliente intentó un pedido o una cotización, "Recuperar" en el
panel **siempre** carga una cotización (precio vigente, sin congelar) —
entre que se armó y se rescata puede haber cambiado el precio o el stock, así
que la vendedora confirma con el cliente y recién ahí usa "Convertir en
pedido" si corresponde. El intento original queda igual en
`admin_audit_log.detail->>'original_kind'`, no se pierde.

Además, una fila del banner rojo sin cliente (token inválido) o sin ítems
nunca podía recuperarse — el botón ni aparece, no hay a quién asignarle el
pedido — y antes se quedaba ahí para siempre sin ninguna acción posible.
Ahora aparece un botón **"Descartar"** exactamente en esos casos: no borra la
fila, solo la saca del banner (`order_failures.dismissed_at`) y queda
auditada. Requiere correr `migration-2026-08-13-recover-as-quote.sql` y
`migration-2026-08-13-dismiss-order-failures.sql` — la segunda **junto con el
deploy**, porque el frontend ya filtra por la columna nueva.

---

## 2. Panel admin (`/admin`)

Login con email/password (Supabase Auth). Tres roles: `get_my_role()` resuelve
admin/vendedora, y `is_superadmin()` (2026-08-05) el tercero — a propósito en
un RPC aparte y no como un valor más de `get_my_role()`, porque el frontend
compara `role === 'admin'` en varias páginas para mostrar los controles de
edición y un valor nuevo ahí las habría dejado en solo lectura:

- **Superadmin** (tabla `superadmins`, 2026-08-05 — hoy solo
  `support5@firstchoiceonline.com`): todo lo de admin **más** dos pestañas
  propias: 🔐 Superadmin, la única desde donde se puede nombrar/quitar admins,
  cambiar la contraseña de cualquier acceso y asignar/desasignar listas de
  precio a vendedoras, y 📈 Métricas (2026-08-06), los KPIs de todo el sistema
  en vivo. Es admin por definición (`is_admin()` lo incluye), así que no
  puede dejarse afuera del panel por error. Sumar o quitar un superadmin sigue
  siendo solo por SQL, a propósito.
- **Admin** (tabla `admins`): acceso total (lectura y escritura) a las 7
  pestañas comunes — las dos de superadmin (🔐 Superadmin y 📈 Métricas) no las
  ve, y entrar por URL directa a `/admin/superadmin` o `/admin/metrics` lo
  redirige a Productos. Desde 2026-08-05 **no** puede escribir `admins` ni
  `price_list_owners` (antes la policy `admin_all` se lo permitía vía API
  directa, aunque no hubiera UI): esas dos las escribe solo el superadmin.
- **Vendedora** (`vendedores.user_id` vinculado a un login): ve **solo
  sus propios clientes y pedidos** (RLS filtra por fila, no por UI —
  nunca ve cuántos clientes/pedidos tienen otras vendedoras), y Productos
  / Precios **de solo lectura** (sin botones de carga ni edición). No
  tiene pestaña Vendedoras ni Registro de movimientos. En Precios, una lista "personal" (ej.
  `luzmar`) solo la ve su dueña — el resto ni la ve en la matriz ni en el
  selector de listas (2026-07-15, RLS `vendedora_select_price_lists`/
  `vendedora_select_product_prices`). **Sí puede cambiarle la lista de
  precio a sus propios clientes** (2026-07-15, con confirmación — ver
  pestaña Clientes) vía RPC `update_client_price_list`, aunque no tiene
  ningún UPDATE directo en `clients`.

Pestañas:

| Pestaña | Qué hace |
|---|---|
| **Productos** | Tabla completa con buscador (nombre/SKU/UPC), filtros (categoría/marca, línea de perfume, activo/inactivo/con stock/sin stock/sin foto/pre-order/🔥 flash/✨ nuevo), columnas **UPC** y **Stock** (datos internos, no se muestran al cliente), contadores clickeables de "sin foto", "Pre-Order", "✨ Nuevo" y "🔥 Flash Sale", miniaturas, alta/edición manual **con campo Stock editable** (2026-08-04 — reponer stock a mano es lo que devuelve un producto de Pre-Order a Disponible sin esperar al sync; vacío = "sin dato", distinto de 0), **selección por casillas para acciones en bloque** (solo admin: activar/desactivar, poner o quitar las etiquetas 🔥 Flash Sale / Pre-Order / Disponible, y marcar o quitar ✨ Nuevo — ver abajo), y **tres cargas por Excel**: productos, fotos y **🔥 Flash Sales** (2026-08-07). |
| **Precios** | Carga de Excel de precios + **matriz de precios por lista** (producto × 5 listas: 4 regionales + Special) con buscador, botones con contador "con precios" / "sin precios" y **los mismos filtros por grupo de producto que la pestaña Productos** (2026-08-07: marca, línea, activo/inactivo, con/sin stock, Pre-Order, 🔥 Flash Sale, ✨ Nuevo) para revisar los precios de un recorte concreto. |
| **Clientes** | Tabla con buscador (nombre/teléfono/vendedora) **por términos** (2026-08-12, mismo criterio que Pedidos — ver "Buscadores del panel" más abajo), filtros por lista y vendedora, **selector de lista por fila con confirmación** (2026-07-15: elegir una opción no aplica el cambio de una — pide "¿Cambiar la lista a X?" con Confirmar/Cancelar; ahora lo puede hacer también una vendedora con sus propios clientes, no solo admin) y campo **"$ inversión → nivel"** (solo admin, asigna el nivel automáticamente sin confirmación — pensado para carga rápida), **reasignar vendedora** por fila y **eliminar cliente** (ambos solo admin, vía RPC con registro de auditoría), botón copiar link, carga por Excel y alta individual ("+ Nuevo cliente"; una vendedora se autoasigna el cliente, un admin puede elegir la vendedora o dejarlo sin asignar). |
| **🛡️ Registro de movimientos** (solo admin, pestaña propia desde 2026-07-15 — antes vivía colapsada dentro de Clientes) | Historial de quién reasignó/borró un cliente, le cambió la lista de precio, o tocó un pedido (editar ítems, cambiar estado, convertir cotización) — con el **movimiento de stock** de ese cambio de estado cuando hubo uno (2026-08-04: "Stock descontado: N · M sin dato de stock"; el `detail` guarda producto, SKU, cantidad y el antes/después de cada uno). Fecha, usuario, acción, cliente, detalle, leído directo de `admin_audit_log`. Desde 2026-08-05 también registra **todo lo que se hace en la pestaña Superadmin** (rol admin, cambios de contraseña, dueñas de listas, alta/renombre/borrado de listas) — en esas filas la columna "Cliente / objetivo" no es un cliente sino el email del usuario o el nombre de la lista. **Filtros** (2026-07-15): por usuario, por acción y por rango de fechas (desde/hasta). **"⬇️ Descargar Excel"** (2026-08-05): baja **todo** el historial, no los 200 que muestra la tabla (usa `fetchAll`, así pasa el corte de 1,000 filas de PostgREST), respetando los filtros activos — el botón aclara "(todo el historial)" o "(filtrado)". Columnas: Fecha (texto `YYYY-MM-DD HH:MM:SS` local, ordenable en cualquier Excel sin depender de la configuración regional), Usuario, Acción, Cliente / objetivo, Detalle, ID cliente, ID pedido y **Datos completos (JSON)** — el `detail` crudo, porque el resumen legible deja cosas afuera (el antes/después ítem por ítem de una edición de pedido, el stock producto por producto). Con filtros que no dejan ninguna fila no genera archivo vacío: avisa. Es de solo lectura: la tabla no tiene policy de insert/update/delete para nadie, solo la escriben las RPC (`reassign_client`/`delete_client`/`update_client_price_list`/las de pedidos/`sa_log` desde las `sa_*`). |
| **Vendedoras** (solo admin) | Alta manual (nombre + teléfono), edición del teléfono en un click, contador de clientes asignados. El link de WhatsApp del checkout de cada cliente usa el teléfono de acá. Columna **Acceso**, dos formas de dar acceso a una vendedora sin cuenta: **"Vincular acceso"** (email de un usuario que ya existe en Supabase Auth, RPC `link_vendedora_login`) o **"+ Crear acceso"** (2026-07-15: crea el usuario de una — el admin define email + contraseña inicial ahí mismo, sin pasar por el dashboard de Supabase — vía la Edge Function `admin-create-vendedora-user`, ver sección 6). "Desvincular" le quita el acceso sin borrar la vendedora ni el usuario de Auth. |
| **Pedidos** | **Todos los pedidos, sin tope** (2026-08-07: antes traía los últimos 200, así que el conteo del encabezado decía "200" hubiera 200 o 900 y los pedidos viejos no se podían ni ver ni marcar atendidos). Carga con `fetchAll` (páginas de 1,000 en paralelo) y se renderiza por lotes con scroll infinito; el encabezado muestra el total real y, con filtros puestos, "coinciden / total". Click en una fila expande un detalle de ancho completo (tabla Producto/Cantidad/Precio/Subtotal, 2026-07-17 — antes se abría angosto dentro de la columna Ítems). Cada pedido se marca **Nuevo/Atendido/Cancelado** (2026-07-15: se sumó Cancelado; 2026-07-17: las 3 acciones piden confirmación en un modal antes de aplicarse, y quedan auditadas vía RPC `update_order_status`, antes un `update` directo sin rastro) y el menú muestra el contador de pedidos sin atender (solo cuenta `new`). Buscador (nombre/teléfono del cliente) **por términos** (2026-08-12: todos los términos tienen que aparecer, en cualquier orden y sin acentos — antes pedía una subcadena contigua y buscar "robert carlos" no encontraba a "Robert Edu Carlos Pacheco"; ver "Buscadores del panel" más abajo) + filtros por estado, tipo (Pedido/Cotización) y, solo admin, vendedora. Botones **"Descargar PDF"**/**"Descargar Excel"** por fila (2026-07-17 el primero, mismo generador que el carrito del cliente; el Excel con las columnas exactas de `UploadTemplate.xls` para subirlo directo al bulk-order upload de SellerCloud); debajo, separados, **"Editar"** y **"Convertir en pedido"** — ambos **solo para cotizaciones** (`kind = 'quote'`), nunca para un pedido real, y "Editar" además solo mientras la cotización sigue `new` (ni atendida ni cancelada se edita). "Editar" (RPC auditada `update_order_items`) deja cambiar cantidad/quitar/agregar producto — cualquiera con acceso al pedido puede hacerlo (admin siempre, vendedora solo los de sus propios clientes). "Convertir en pedido" (RPC `convert_quote_to_order`) congela el precio de ese momento con la lista real del cliente (a diferencia de la cotización, que sigue mostrando el precio **vigente** vía `get_quotes_live_pricing` — ver sección 6) y deja de ajustarse a cambios de precio futuros. Arriba de la lista, **aviso rojo de los pedidos que el cliente envió y no se registraron** (2026-08-05, `order_failures`): cliente, fecha, motivo y cantidad de líneas, con un botón **"Recuperar"** que lo carga como pedido con los precios vigentes de su lista (RPC `recover_order_failure`, auditada) — antes un pedido rechazado no dejaba rastro en ninguna parte. Aparece también cuando todavía no hay ningún pedido, para que "aún no hay pedidos" no tape justo lo que hay que ver. Una vendedora solo ve (y recupera) los de sus propios clientes. Al lado, **"💬 Cargar pedido desde WhatsApp"** (2026-08-17): pega el mensaje del chat y crea el pedido, para el caso en que el registro nunca llegó al sistema y el cliente no vuelve a abrir el catálogo — ver la sección 2 para el detalle. |
| **🔐 Superadmin** (2026-08-05, solo superadmin) | Lo que antes obligaba a entrar al SQL Editor o al dashboard de Auth. **Usuarios y accesos**: todos los usuarios de Supabase Auth con su rol (Superadmin/Admin/Vendedora/Sin rol), la vendedora vinculada, fecha de alta y último acceso; por fila, "Hacer admin"/"Quitar admin" (con confirmación) y **"Cambiar contraseña"** (sirve para cualquier acceso: vendedora, admin o el propio superadmin); arriba, **"+ Crear admin"** (crea el usuario de Auth con su contraseña inicial y le da el rol, en un paso). **Listas de precio y dueñas**: por lista, cuántos clientes y cuántos precios tiene, sus dueñas con la principal marcada (★), agregar/quitar dueña y cambiar cuál es la principal; si al mover dueñas quedaron clientes con una vendedora que ya no es dueña, avisa cuántos y ofrece pasarlos a la principal de una vez. También **crear** una lista nueva (código + nombre visible; el código se valida y no se puede cambiar después), **renombrar** el nombre visible y **eliminar** una lista que no sea de las base y esté completamente vacía. Todo va por RPC `sa_*` con `is_superadmin()` adentro (o por la Edge Function `superadmin-users` cuando hace falta la Admin API de Auth) y **todo queda en el Registro de movimientos**. |
| **📈 Métricas** (2026-08-06, solo superadmin) | Los KPIs de todo el sistema en una pantalla, **en vivo** (se refresca solo cada 60 s, más un botón "↻ Actualizar" y un cartel "actualizado hace X"). Selector de rango **7 / 14 / 30 días** (default 14). Nueve tarjetas: monto capturado, pedidos, ticket promedio, cotizaciones, vendedoras activas, **tiempo promedio a atender** (horas desde que entró el pedido hasta la primera vez que se marcó Atendido; "—" con la aclaración "aún sin pedidos marcados atendidos" cuando todavía no hay ninguno), cotizaciones convertidas, cancelados y **Enviados a SellerCloud** (2026-08-18, `migration-2026-08-18-sa-metrics-sellercloud.sql`: pedidos del período con `sellercloud_order_id` anotado — cancelados incluidos a propósito, un pedido enviado y cancelado acá igual salió — con el total histórico en la leyenda; muestra "—" mientras la RPC sea la vieja); debajo, los **fallos de envío** del período y cuántos se recuperaron. Después, un **mini-gráfico de barras del monto por día** (SVG propio, sin librería de charts) y la tabla **"Adopción por vendedora"** (pedidos, monto, ticket y cotizaciones por vendedora, ordenada por monto, con fila de total del período que cuadra con las tarjetas) y su **"⬇️ Descargar Excel"**. Los pedidos sin vendedora salen agrupados en una fila "—". **Las cuentas de prueba (`SystemsPruebas` y compañía) quedan afuera de todos los números** y sus nombres se listan al pie de la tabla, para que la exclusión se vea en vez de ser invisible. Toda la data viene de **una sola RPC** `sa_metrics_overview(p_days)` con `is_superadmin()` adentro: los agregados cruzan a todas las vendedoras, así que sumarlos desde el cliente daría un número distinto según quién mira (la RLS le recorta a cada vendedora sus propios pedidos). Es la única `sa_*` que **no** audita: es de solo lectura, y una fila por refresco llenaría `admin_audit_log` con una por minuto por pestaña abierta. |

> **La pestaña Flash Sales se eliminó** (2026-08-07). Estaba entre Vendedoras
> y Pedidos y manejaba ofertas con precio promo propio + cuenta regresiva
> (tabla `flash_sales`). El negocio no las usa así: una Flash Sale es una
> **estrategia para mover inventario**, no un precio distinto con reloj. Hoy
> es la etiqueta 🔥 del producto, que se pone desde Productos (Excel o
> selección en bloque) y el cliente filtra con el chip 🔥 del catálogo.
> **No hizo falta ninguna migración**: la tabla y sus datos quedan en la base
> sin que nadie los lea (ver el comentario "LEGADO" en `schema.sql`), así que
> volver atrás es reponer el código, no recuperar datos.

#### Un producto sin precio no sale en el catálogo (2026-08-06)

A pedido del usuario. `get_catalog` ya excluía los productos **sin fila** en
`product_prices` para la lista del cliente; el agujero era el **precio 0**:
`product_prices.price` es `not null check (price >= 0)`, o sea que 0 es un valor
válido para la tabla, y la regex de parseo de `apply_price_list`
(`^[0-9]+(\.[0-9]+)?$`) matchea `"0"` y `"0.00"` como cualquier otro número. Una
celda en 0 en el Excel de precios (o una columna corrida) alcanzaba para que el
producto entrara al catálogo mostrando **$0.00**, se pudiera agregar al carrito y
se registrara **un pedido con el total en $0.00** — `create_order` recalcula el
precio del lado del servidor, pero 0 era "un precio" para toda la cadena.

La regla, en un enunciado: **un precio de 0 es lo mismo que no tener precio**, y
un producto sin precio no se muestra, no se cotiza y no se puede pedir. Se aplica
en las cinco puertas que llevan a lo mismo
(`migration-2026-08-06-require-price.sql`):

| Dónde | Qué cambia |
|---|---|
| `get_catalog` | `and pp.price > 0` en vez de `is not null`. **La rama de la lista `quote` no se toca**: ahí devolver todo con `price = null` es la función, no un dato faltante. |
| `get_flash_sales` | `and fs.price > 0` — `flash_sales.price` tiene el mismo `check (price >= 0)`, así que una carga masiva con la columna corrida podía llenar la sección Flash Sale de $0.00. |
| `compute_order_items` | los dos lookups (flash y lista) piden `> 0`, así un 0 se comporta **igual que "no hay fila"** y todo lo que ya sabía tratar "sin precio" (el total que no suma, el `—` de la tabla de pedidos, el PDF sin precios) sigue andando sin tocarlo. El ítem **no** se descarta a propósito: descartarlo lo haría desaparecer de la vista de cotizaciones con precio vigente sin decir nada. |
| `create_order` | un pedido real con una línea sin precio **no se guarda**: se rechaza entero y queda en `order_failures` con los SKU culpables, así el admin lo ve en el aviso rojo de Pedidos, carga el precio y le da "Recuperar". Una **cotización** sí se guarda sin precios (es su función). |
| `convert_quote_to_order` | misma regla por la puerta del admin, con `raise exception` que nombra los SKU a arreglar. De paso se le sumó el guard de "ningún producto válido" que `update_order_items` ya tenía. |
| `apply_price_list` | un `0` en el Excel cuenta como **precio inválido**: entra en el contador `invalid_prices` que el preview ya muestra antes de confirmar, y no se upsertea ni activa el producto. Es un solo cambio en el `CASE` del parseo; todo lo de abajo ya filtraba por `price is not null` y hereda la regla. |

En la pestaña Precios, una celda con 0 se muestra en **rojo con ⚠** en vez de
como un precio normal, y los contadores "con precios / sin precios" cuentan el 0
como sin precio — si no, el panel diría "con precio" de un producto que el
catálogo esconde.

#### El bug del grupo reprogramado que reaparecía en el catálogo (2026-08-06)

Reportado por el usuario: le puso al grupo una fecha de vencimiento nueva para
el mes siguiente, **el panel siguió diciendo "Desactivada" y el catálogo empezó
a mostrar el Flash Sale**. Las dos cosas eran ciertas, sobre filas distintas del
mismo grupo:

- El badge rojo "Desactivada" sale solo con `active = false`. Una oferta que
  simplemente pasó su fecha sigue con `active = true` y se pinta "Expiró" (gris).
- Un "grupo" es un armado del frontend (mismo `batch_id`, o misma `expires_at`),
  y puede ser **mixto**: filas apagadas a mano junto a filas solo vencidas.
- "Aplicar al grupo" escribía **solo `expires_at`**. Con la fecha nueva, todas
  las filas `active = true` volvían al catálogo en el acto — `get_flash_sales()`
  solo exige `active` y estar dentro del rango — mientras las `active = false`
  seguían apagadas mostrando el badge rojo.

**No era un bug de la base**: `get_flash_sales()` filtra `active` correctamente
y nunca publicó una oferta apagada (verificado). Era el panel, que dejaba
reprogramar un grupo mixto sin decir qué iba a publicar y no tenía forma de
volver a prender lo apagado. Arreglado enteramente en `FlashSalesAdmin.jsx`,
**sin migración**.

> Al día siguiente (2026-08-07) el usuario decidió **eliminar el área entera**:
> lo que el negocio necesita de una Flash Sale es destacar productos para mover
> inventario, no un precio con reloj. Este apartado queda como historia — ese
> panel ya no existe. Ver el recuadro arriba de esta sección.

### Buscadores del panel: por términos, no por subcadena (2026-08-12)

Los buscadores de **Pedidos** y **Clientes** exigían que lo tipeado apareciera
como **una subcadena contigua** del nombre (`name.toLowerCase().includes(q)`).
Eso rompía con los nombres que llegan del sync: SellerCloud guarda el nombre
completo en `Name` ("Robert Edu Carlos Pacheco") mientras el negocio usa el
`CorporateName` ("Robert Carlos"), así que buscar al cliente por el nombre con
el que se lo nombra devolvía **cero resultados** — y una bandeja vacía se lee
como "sus pedidos no se registraron". Fue un incidente real de soporte.

Ahora se filtra con `src/utils/search.js`: **todos los términos tienen que
aparecer, en cualquier orden**, sin distinguir mayúsculas ni acentos ("ramon
nunez" encuentra a "Ramón Núñez").

Dos detalles que conviene no perder si se toca esto:

- **Con una sola palabra el resultado es idéntico al de antes**, así que el
  cambio no altera ninguna búsqueda que ya funcionaba.
- Los términos **no se reparten entre campos distintos**: "juan perez" no
  matchea un cliente llamado "Juan" cuya vendedora es "Perez". En una bandeja
  de pedidos un falso positivo cuesta lo mismo que un falso negativo.

El buscador del catálogo del cliente (`Catalog.jsx`, nombre/marca/línea) y el
de Productos (nombre/SKU/UPC) **siguen con el `includes` de siempre**: no
entraron en este arreglo. Son el mismo patrón, así que si aparece la misma
queja ahí, la pieza a reutilizar ya está.

### Descuento de stock al atender un pedido (2026-08-04)

El catálogo arrastra inventario viejo de una de las primeras cargas, así que
hay productos que se ven Disponibles cuando ya se agotaron. Para que dos
clientes no pidan la misma mercadería, **marcar un pedido como Atendido
descuenta sus cantidades de `products.stock`** (RPC `update_order_status` →
helper `apply_order_stock`): stock 20 de Adidas Fresh, un cliente pide 10, la
asesora lo marca Atendido → queda 10, y si llega a 0 el producto pasa a
Pre-Order solo (trigger `products_availability_from_stock`) y **sale del
catálogo** (2026-08-12, ver "Productos" en la sección 1).

Reglas, todas confirmadas con el usuario:

- **Solo pedidos reales** (`kind = 'order'`). Una cotización nunca toca el
  stock — ni la que genera "Descargar PDF" del carrito ni la de un cliente con
  lista `quote`. Para que descuente hay que pasarla a pedido con **"Convertir
  en pedido"** y marcar ESE pedido Atendido. Si no fuera así, un cliente
  bajando 5 PDF mientras mira el catálogo vaciaría el inventario solo.
- **Reabrir o cancelar devuelve el stock** y el producto vuelve de Pre-Order a
  Disponible si corresponde — y **vuelve al catálogo** si fue esta regla la que
  lo había apagado (`deactivated_by_stock`). Marcar Atendido por error se
  deshace por completo.
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

**Ojo con el orden al paginar en paralelo** (2026-08-12): cada página es una
consulta independiente con su propio `range`, y Postgres no garantiza ningún
orden entre filas que **empatan** en la clave de ordenamiento. Con un empate
justo en el borde de una página, una fila puede venir en dos páginas o **en
ninguna** — o sea desaparecer de la tabla del admin estando en la base. No era
hipotético: `product_prices` se paginaba ordenando solo por `product_id`, que
tiene una fila por lista de precio, así que había empates en todos los bordes
de sus ~20 páginas. Por eso `fetchAll` acepta **varias** columnas de orden y
cada llamada pasa una combinación única: `['created_at', 'id']` en Pedidos y
Registro, `['name', 'id']` en Productos/Clientes/Vendedoras y
`['product_id', 'price_list_id']` en Precios. Si se agrega una llamada nueva,
la regla es esa: la clave de orden tiene que identificar la fila sin empates
(la tabla no tiene por qué tener `id` — `product_prices` no lo tiene).

---

## 3. Formatos de Excel aceptados

El parser detecta automáticamente la **fila de encabezados** (los exports
reales traen membrete arriba) y normaliza los nombres de columna (mayúsculas,
acentos, espacios). Alias en español e inglés.

### Productos (📦 en pestaña Productos)

Acepta tanto un Excel simple como el export de SellerCloud o la lista
wholesale con membrete:

- **SKU** (`sku`, `codigo`, `ProductID`) — opcional; si falta se autogenera.
- **UPC** (`upc`, `barcode`, `ean`, 2026-07-14) — código de barras. Se guarda y
  es visible/buscable en la tabla de Productos. **Desde 2026-08-14 también se
  muestra al cliente** (tarjeta del catálogo, carrito y columna propia del PDF)
  y se puede buscar por él en el catálogo — antes era dato interno del admin.
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
  guarda como su propio estado — badge 🔥 en el catálogo y filtro propio).
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
  `migration-2026-07-14-inventory-stock.sql`). Desde 2026-08-12, `0` o negativo
  **también lo saca del catálogo** (queda inactivo y vuelve solo cuando entre
  stock). Ojo con la interacción con la columna **Activo**: si el archivo la
  trae, es intención explícita del admin y **borra la marca de "lo apagó el
  stock"** — un `Activo = No` deja el producto apagado incluso si después entra
  stock; un `Activo = Sí` sobre uno en 0 lo vuelve a marcar para publicarse
  cuando haya.

Actualiza existentes por SKU y crea los nuevos. **Los campos que el archivo
no trae no se tocan** (re-subir un export sin fotos no borra las fotos).
Filas basura de sistemas de inventario (Skustack, Support-Test, Discount) se
excluyen automáticamente, igual que links al panel de SellerCloud colados
como si fueran fotos. **También se excluyen los productos que no son
catálogo vendible** (2026-07-13): SKU terminado en `-SPECIAL` **o en `-BOX`**
(2026-08-13: el mismo perfume vendido por caja) y categorías
`PRODUCT_CATEGORY` = beauty / electronics / support / packing and shipping
supplies / test. Misma regla del lado SQL (`sync_is_noncatalog_product` /
`is_noncatalog_sku` en `migration-2026-07-13-exclude-noncatalog.sql` y
`migration-2026-08-13-exclude-box-skus.sql`): si se cambia la lista o un sufijo
en un lado, cambiarlo en el otro (el sufijo del SKU vive en `isNonCatalogSku`,
`src/pages/admin/ui.jsx`). Contra el export real `119389.xlsx` la regla excluye
282 filas (77 `-BOX` + 111 `-SPECIAL` + 94 por categoría) y deja 3,371 de
catálogo.

### El día que entró el export general de SellerCloud (2026-08-17)

Un admin subió por esta pestaña `124758.xlsx` —el export **general** de
SellerCloud, 8,272 filas, no el de catálogo— y se crearon del orden de 3,000
productos que no van. Sirve como caso de referencia de qué tan lejos llega el
filtro de no-catálogo y qué se puede deshacer después.

**Lo que el filtro atajó y lo que no.** De las 8,272 filas descartó 1,643 (13
basura + `-BOX`/`-SPECIAL` + categorías excluidas) y dejó pasar 6,616. De esas,
5,098 eran perfume y **1,518 no**, repartidas en categorías que la lista de
exclusión no nombra:

| `PRODUCT_CATEGORY` | filas | por qué pasó |
| --- | --- | --- |
| `855696`, `855824`, `856208` | 1,182 | categorías corruptas del export (un ID donde va el nombre) |
| `Beauty and Health` | 255 | `EXCLUDED_LINES` tiene `beauty` y compara por **igualdad exacta** |
| `Office Supply` | 55 | no está en la lista |
| (sin categoría) | 16 | fila sin `PRODUCT_CATEGORY`, no hay nada que comparar |
| `Home` / `Party` / `Toys` | 10 | no están en la lista |

O sea: la exclusión por categoría es una lista blanca al revés — nombra lo que
conoce y deja entrar todo lo demás. Un export nuevo con una categoría nueva
vuelve a pasar. La regla del SKU (`-BOX`/`-SPECIAL`) sí es robusta porque
matchea por sufijo.

**Qué tan grave fue.** Poco, por el efecto de rebote de dos reglas que ya
existían: la carga de productos no toca precios (eso es la pestaña Precios), y
desde `migration-2026-08-06-require-price.sql` un producto sin precio `> 0` no
sale en el catálogo ni se puede pedir. Los 3k quedaron ensuciando el panel
admin, invisibles para el cliente.

**Cómo se revirtió.** `supabase/cleanup-2026-08-17-carga-excel-erronea.sql`, para
correr a mano en el SQL Editor paso por paso. La tanda se identifica por
`created_at` (la carga los crea todos en el mismo minuto) y se congela en una
tabla de respaldo con una columna `a_borrar`, que es lo que leen el apagado y el
borrado — así los dos operan sobre el mismo conjunto aunque en el medio se
perdone parte (ej. conservar los perfumes nuevos). Primero `active = false`
(reversible, inmediato), y el `delete` recién después de revisar el catálogo.
Detalles que el script cuida: `deactivated_by_stock = false` al apagar, para que
el trigger de stock no los vuelva a prender; RLS en las tablas de respaldo, que
si no PostgREST las publicaría con la anon key; y el deshacer reinserta con los
mismos `id`, así los precios respaldados vuelven a enganchar. Probado sobre un
Postgres desechable con réplica del esquema, en los dos escenarios (borrar todo
/ perdonar los perfumes).

**Lo que no se recupera con eso:** los SKU que ya existían y el archivo pisó
(nombre, categoría, foto, activo, stock, upc). Eso es backup/PITR de Supabase o
volver a subir el archivo bueno.

### Los SKU `-BOX` y `-SPECIAL` no se publican nunca (2026-08-13)

Un `-BOX` es el mismo perfume que ya está en el catálogo pero **vendido por
caja** (`ZX_PE-AB-M-636268-ZX-BOX` y `ZX_PE-AB-M-636268-ZX` son los dos "Blue
Seduction 3.4 Oz Edt Men"); un `-SPECIAL` es una variante interna de
SellerCloud. No alcanzaba con no jalarlos en la carga: la **carga de precios**
escribe `active = true` para todo lo que trae precio en el archivo, y esos Excel
salen del mismo export, así que se republicaban solos cada semana. Ahora la
garantía vive en la base, en el trigger **`products_enforce_noncatalog`**
(`migration-2026-08-13-exclude-box-skus.sql`): cualquier insert/update con un SKU
así queda `active = false`, venga del sync, del Excel, del panel o de un request
directo. `deactivated_by_stock` queda en `false` — esa bandera significa "vuelve
cuando entre stock", y a un `-BOX` lo apaga su SKU, no el inventario.

- **El trigger mira solo el sufijo del SKU**, no la regla completa de
  no-catálogo. El sufijo es un dato estructural de SellerCloud que nadie tipea, y
  si algún día hay que vender un `-BOX` alcanza con **cambiarle el SKU** desde el
  formulario. La otra mitad de la regla (`product_line` = beauty/electronics/...)
  es texto libre de un export y **no** es editable en el panel: clavarla en un
  trigger dejaría un perfume mal categorizado imposible de activar.
- **En la pestaña Productos**: contador/filtro **🚫 No-catálogo (-BOX/-SPECIAL)**
  —son ~190 filas y si no se separan tapan a los inactivos que sí hay que
  revisar—, badge 🚫 en la fila, y "Activar" que **avisa en vez de mandar un
  update que la base va a revertir**. En bloque, el botón queda apagado con su
  motivo (y si la selección mezcla `-BOX` con inactivos sin stock, dice los dos),
  y el aviso separa "1 activados · 🚫 2 siguen inactivos por ser -BOX/-SPECIAL".
- **En la pestaña Precios**: contador `blocked_noncatalog` con chip "🚫 N no se
  publican (-BOX/-SPECIAL)" — antes esas filas contaban como "a reactivar" y no
  volvía ninguna. El precio sí se guarda (es un dato inerte).
- ⚠️ **`is_noncatalog_sku` no lleva `revoke execute from public`**, a diferencia
  de las funciones del sync, y sí un `grant execute` explícito a
  `authenticated, anon, service_role`: el privilegio EXECUTE de lo que se llama
  dentro de un trigger se chequea contra el usuario que hace el UPDATE (el rol
  `authenticated` del panel), así que si se queda sin ese permiso **cualquier**
  edición de producto se cae con `permission denied for function`.
- Efecto conocido: si un pedido sin atender tiene una línea `-BOX`,
  `compute_order_items` la descarta al recalcular. El backfill de la migración
  **reporta cuántos pedidos así hay** (`raise notice`) en vez de tocarlos.

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
   uno). Desde 2026-08-12 hay un contador aparte, **"📦 N no vuelven (stock
   0)"**: los que traen precio y están inactivos pero **no** se van a ver con
   esta carga porque su stock está en 0 (quedan marcados para publicarse cuando
   entre stock). Antes se contaban como "a reactivar" y el preview prometía de
   más. Del otro lado, lo que la carga **desactiva** por quedar fuera del
   archivo pierde esa marca: lo saca una persona, así que no vuelve solo con el
   próximo inventario.
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

**Filtros por grupo de producto** (2026-08-07): además del buscador, la
matriz filtra por marca, línea de perfume y estado (activo/inactivo, con/sin
stock, Pre-Order, 🔥 Flash Sale, ✨ Nuevo) — son literalmente los mismos de la
pestaña Productos (`ProductFilters`/`productMatchesFilters` en
`pages/admin/ui.jsx`, compartidos para que las dos pestañas no puedan
divergir sobre los mismos productos). Sirve para responder "¿los 🔥 de esta
semana tienen precio en US Wholesale?" sin buscarlos de a uno. Los contadores
"con precios / sin precios" **se recalculan sobre el grupo filtrado** (no
sobre el catálogo entero), que es lo único que hace útil la combinación; el
buscador de texto no los mueve, para que el número no baile tecla a tecla.
Cada fila muestra las etiquetas del producto (🔥 / Pre-Order / ✨ Nuevo /
Inactivo) para saber qué se está mirando.

### Flash Sales (🔥 en pestaña Productos, 2026-08-07)

Sube el archivo semanal **"Special Flash Sale"** tal cual viene (formato
letterhead: `UPC`, `Sku`, `Brand`, `Title Product`, `Price`, `Type`, `Qty`,
`Total Price`) y **le pone la etiqueta 🔥 Flash Sale a esos productos**. Solo
se usa la columna **Sku**: no crea productos y **la columna Price se ignora
a propósito** — una Flash Sale ya no tiene precio propio, el precio sale de
la lista del cliente y se carga en la pestaña Precios como el de cualquier
otro producto.

Dos pasos, igual que la carga de precios y por el mismo motivo (esta carga
también **desmarca** por omisión):

1. **Vista previa**: cuántos se van a marcar, cuántos se van a desmarcar,
   cuántos ya tenían la etiqueta y cuántos SKU del archivo no existen (con
   la lista de esos SKU). Si alguno de los productos del archivo está
   **inactivo**, avisa en rojo: la etiqueta no lo hace visible en el
   catálogo.
2. **Confirmar y aplicar**.

Por defecto **reemplaza la promo entera**: a los productos que hoy tienen 🔥
y no vienen en el archivo se les quita la etiqueta. Se puede destildar
("Quitarle la etiqueta 🔥 a los que no vienen en el archivo") para acumular
sobre la promo anterior. Al desmarcar, el producto vuelve a **Disponible**, o
a **Pre-Order si su stock está en 0** — lo decide el trigger de la base, no
el frontend; la disponibilidad que tenía antes de ser 🔥 no se guarda en
ningún lado, así que no hay a qué "volver" cuando no hay dato de stock.

Los `update` van **en tandas de 100 ids** (`updateByIds` en
`lib/supabase.js`): PostgREST manda el `id=in.(...)` en la URL, y una promo de
300 productos armaba una query string de ~11 KB que se cae antes de llegar a
la base.

### Acciones en bloque de la tabla de Productos (solo admin)

Las casillas seleccionan **todo lo que pasa los filtros actuales** (no solo
las filas renderizadas por el scroll infinito), y la barra sticky ofrece:

- **Activar / Desactivar** (2026-07-14).
- **Etiqueta** (2026-08-07): 🔥 Flash Sale · Pre-Order · Disponible.
- **✨ Nuevo** (2026-08-07): Marcar (pone `new_until` a +10 días) o Quitar
  (lo deja en `null`).

Ojo con Disponible/Pre-Order: **las decide el stock**. El trigger
`products_availability_from_stock` las recalcula en cualquier escritura sobre
un producto con stock cargado, así que marcar Pre-Order sobre algo con 5
unidades no queda — solo 🔥 se respeta siempre. El panel no finge que
funcionó: después de aplicar **relee y compara**, y avisa "N con la etiqueta
aplicada · M recalculados por su stock".

**Un botón que no cambiaría nada aparece deshabilitado**, con el motivo en el
tooltip. Se calcula sobre la selección real, no sobre la etiqueta a secas:
`availabilityAfter()` en `ProductsAdmin.jsx` es el **espejo del trigger** (con
qué disponibilidad va a quedar el producto si le escribimos X), y el botón se
apaga cuando ningún seleccionado cambiaría. Por eso hay dos motivos distintos:

- *"Todos los seleccionados ya están así"* — marcar 🔥 sobre una selección que
  ya es toda 🔥, Activar sobre lo que ya está activo, ✨ Marcar sobre lo que ya
  lleva la etiqueta (y ✨ Quitar cuando ninguno la tiene).
- *"No cambiaría nada: la disponibilidad la manda su stock"* — Pre-Order sobre
  productos con stock ≥ 1, o Disponible sobre productos con stock 0. No es que
  "ya estén así": es que el trigger los va a devolver a donde estaban.
- *"Sin stock no se publica"* (2026-08-12) — Activar sobre productos con stock
  0 que ya están marcados para volver cuando entre stock. Pedirlo de nuevo no
  cambia ni lo que se ve ahora ni lo que va a pasar después.

Con selección **mixta** los botones siguen habilitados: la acción se aplica al
subconjunto que sí cambia, y el aviso posterior dice cuántos fueron.

**Activar/Desactivar con la regla de stock 0** (2026-08-12):

- **Activar** sobre un producto sin stock no lo publica, pero **no es un
  no-op**: queda marcado (`deactivated_by_stock`) y se publica solo en cuanto
  entre stock. El aviso separa las dos cosas — "3 activados · 5 siguen
  inactivos por stock 0 (vuelven solos cuando entre stock)" — en vez de contar
  como aplicados los que siguen escondidos. Desde el badge de una fila el aviso
  es el mismo, para que nadie lo intente dos veces creyendo que falló.
- **Desactivar** apaga además la bandera: si una persona lo apaga, no tiene que
  volver solo. Por eso el botón sigue **habilitado sobre un producto ya
  inactivo por stock**: es la única forma de decir "este no vuelve" (el badge de
  la fila solo ofrece activar mientras esté inactivo), y el aviso lo dice así —
  "2 ya no vuelven solos cuando entre stock".
- El filtro de estado tiene **"📦 Inactivos por stock 0"**, separado de
  "Inactivos": los primeros se arreglan solos con el próximo sync, los segundos
  son los únicos que hay que revisar a mano. En la tabla, el badge de estado
  lleva 📦 cuando el producto está en ese caso.

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
- **Reintento automático de fotos** (2026-08-19, por reporte de una
  vendedora: "a veces no cargan ciertas imágenes y se arregla reenviando el
  link"). Las fotos son hotlinks al servidor de SellerCloud
  (`fc2.cwa.sellercloud.com` — sin CDN, sin headers de caché, respuestas de
  hasta 1.6 s) y en datos móviles algunas requests se caen. `ProductImage`
  ahora reintenta 2 veces (a los 1.2 s y 3.5 s) **remontando la `<img>`**, no
  con cache-busters (un fallo de red no se cachea; un éxito sí debe seguir
  usando el caché del teléfono). Mientras espera —y si se agotan los
  intentos— muestra el monograma Z, nunca el glifo de imagen rota. Reenviar
  el link era exactamente esto, un reintento manual.
- Idioma es/en: auto-detección + selector en header (localStorage).

---

## 6. Seguridad

- **RLS activo en todas las tablas**; el rol `anon` no puede leer ninguna
  tabla directamente (en particular `clients` y `product_prices`).
- Catálogo público solo vía RPC `SECURITY DEFINER`:
  - `get_catalog(p_token)` — resuelve el cliente por token; devuelve solo
    los precios de su lista. Token inválido → `null` sin explicación.
    **No expone el SKU ni el stock**; el **UPC sí** desde 2026-08-14
    (`migration-2026-08-14-catalog-upc.sql`, decisión del usuario: es el código
    con el que el cliente pide). Excepción: la lista `quote` devuelve todos los
    productos activos con precio `null` (catálogo de cotización, ver
    sección 1).
  - `get_flash_sales()` — **legado, sin llamadores desde 2026-08-07**: el
    catálogo dejó de pedirla al eliminarse la sección de ofertas. Sigue
    creada por si hiciera falta volver atrás.
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
- **Métricas** (2026-08-06, `migration-2026-08-06-sa-metrics.sql`): una sola
  RPC `sa_metrics_overview(p_days int default 14)` que devuelve un `jsonb` con
  `period` / `totals` / `por_vendedora` / `tiempo_a_atender_horas` /
  `cotizaciones_convertidas` / `fallos` / `serie_diaria` / `excluidas`.
  - `is_superadmin()` como primera línea (rechaza con `not authorized`), pero
    **sin `sa_log()`**: es de solo lectura, y la pestaña la llama cada 60 s —
    auditarla dejaría una fila por minuto por pestaña abierta.
  - Los agregados **no se pueden calcular en el cliente**: cruzan a todas las
    vendedoras, y con RLS cada una ve solo sus propios pedidos, así que el
    número saldría distinto según quién mira. La RPC devuelve solo agregados,
    nunca el detalle de un pedido.
  - **Cuentas de prueba excluidas** de todos los agregados vía
    `sa_metrics_test_vendedora_patterns()` (array de patrones ILIKE contra
    `vendedores.name`: `systemspruebas%`, `%prueba%`, `%demo%`) +
    `sa_is_test_vendedora(name)`. Editar el array es el único lugar donde vive
    la lista. No borra ni toca nada: solo deja esas filas afuera del cálculo, y
    los nombres que matchearon vuelven en `excluidas` para que el panel los
    muestre.
  - `tiempo_a_atender_horas` sale de `admin_audit_log`: `min(created_at)` por
    `order_id` sobre `action = 'update_order_status'` con
    `detail->>'to_status' = 'done'`. `min` y no el último porque un pedido puede
    ir done → new → done varias veces y lo que se mide es la primera atención.
  - Índices que agrega: `orders_created_idx` (la ventana `created_at >= now() -
    N days`, que sin él era un seq scan cada 60 s por pestaña abierta) y
    `admin_audit_log_order_status_idx` (parcial, `where action =
    'update_order_status'`).
  - Los helpers `sa_metrics_test_vendedora_patterns` / `sa_is_test_vendedora`
    no tienen `execute` para `authenticated` (ni para el superadmin): los llama
    solo la RPC, que corre como el dueño.
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
  `AdminLayout.jsx` arme las pestañas correctas (a una vendedora no le arma
  Vendedoras ni Registro de movimientos, con redirect si entra por URL
  directa).
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

> **⚠️ MIGRACIONES PENDIENTES AL 2026-08-14 — CUATRO.** Las tres del 2026-08-13
> (`exclude-box-skus`, `recover-as-quote`, `dismiss-order-failures`: el detalle
> de las dos últimas está en el encabezado de `ZIMAXX-STORE-INFO.md`) más
> **`migration-2026-08-14-catalog-upc.sql`**, la que hace que el UPC viaje al
> catálogo del cliente y quede guardado en los ítems del pedido (`get_catalog` +
> `compute_order_items`, ver "Productos" en la sección 1). Las cuatro son
> independientes entre sí y van en cualquier orden. La del UPC **no bloquea el
> deploy del frontend**: sin ella el catálogo simplemente no muestra ningún UPC
> (llega `undefined`, igual que un producto sin código cargado) y el PDF sale con
> la columna vacía; nada rompe.
>
> Detalle de la primera:
> `migration-2026-08-13-exclude-box-skus.sql`, la de los SKU `-BOX` fuera del
> catálogo (ver "Los SKU `-BOX` y `-SPECIAL` no se publican nunca" en la sección
> 3). **Correrla junto con el deploy**: el panel nuevo ya marca y bloquea los
> `-BOX`, pero sin la migración nada los desactiva en la base, la carga de precios
> los sigue republicando y el chip 🚫 del preview de Precios no aparece nunca
> (`apply_price_list` todavía no devuelve `blocked_noncatalog`). Anotar los tres
> `raise notice` del backfill: cuántos `-BOX` estaban publicados, cuántos
> no-catálogo por categoría habían vuelto a publicarse por una carga de precios, y
> cuántos pedidos sin atender tienen una línea `-BOX` (esos hay que revisarlos con
> la asesora: al recalcular, esa línea se descarta).
>
> **✅ MIGRACIONES: NO QUEDABA NINGUNA PENDIENTE AL 2026-08-12.** Todas las de
> `supabase/` están corridas y probadas en producción, confirmado por el usuario
> ese día. El sondeo con la anon key (sin escribir nada, ver "Auditoría del
> estado real (2026-08-12)" en `ZIMAXX-STORE-INFO.md`) encontró que **6 de las 8
> migraciones que este doc listaba como pendientes ya estaban corridas**, dejó
> una sola pendiente confirmada (`migration-2026-08-12-hide-out-of-stock.sql`) y
> 3 sin determinar (las que solo cambian el cuerpo de una función o un CHECK, que
> no dejan huella visible desde la API); el usuario corrió la primera y confirmó
> las otras tres el mismo día. La única que **nunca se corrió y ya no hace falta**
> es `migration-2026-07-15-restrict-vendedora-luzmar.sql`, reemplazada por
> `migration-2026-08-04-shared-price-lists.sql`.
> Lo que sigue abajo en esta sección son **pendientes de producto** (SellerCloud,
> n8n, mejoras), no de base de datos. Si algún ítem dice "pendiente: correr…",
> es histórico — verificar contra producción antes de creerlo.

- **⏳ `migration-2026-08-14-catalog-upc.sql` PENDIENTE** (2026-08-14). El UPC deja
  de ser dato interno: `get_catalog` lo devuelve (las dos ramas, con precios y
  `quote`) y `compute_order_items` lo guarda en cada ítem del pedido/cotización,
  para que el PDF que descarga la vendedora desde Pedidos también lo tenga —
  esos ítems los arma el servidor, no el carrito. Sin cambios de esquema ni de
  permisos: mismas firmas, mismos grants, y los dos cuerpos son copia de la
  versión viva con una sola clave nueva en el jsonb. Los pedidos ya guardados no
  se tocan (siguen sin la clave: su PDF sale sin UPC). Probada contra un cluster
  PostgreSQL 18 desechable: el UPC en las dos ramas del catálogo, la clave en
  los ítems con `kind` `order` y `quote`, token inválido → `null`, el producto
  apagado a mano que se sigue descartando y el agotado que se sigue pudiendo
  pedir; re-aplicada (idempotente) y con el preflight fallando a propósito sin
  `products.upc`.
- **⏳ `migration-2026-08-13-exclude-box-skus.sql` PENDIENTE** (2026-08-13). Es la
  que deja fuera del catálogo, para siempre, a los SKU terminados en `-BOX` (el
  mismo perfume vendido por caja) y `-SPECIAL`. Crea `is_noncatalog_sku(sku)` (el
  sufijo del SKU en un solo lugar, que `sync_is_noncatalog_product` ahora llama) y
  el trigger `products_enforce_noncatalog`; hace el backfill de los ya cargados
  (nunca DELETE) y le suma a `apply_price_list` el contador `blocked_noncatalog`,
  además de sacar esas filas del UPDATE que publica lo que trae precio. Detalle y
  porqués en la sección 3. Probada contra un cluster PostgreSQL 18 desechable
  partiendo del `schema.sql` de HEAD + las migraciones del sync (7 bloques de
  assert: predicado, backfill, trigger —incluido el orden de los dos triggers—,
  sync, `apply_price_list`, `get_catalog`, `compute_order_items`), re-aplicándola,
  con el `schema.sql` completo encima y en una instalación desde cero; y el panel
  en navegador real (18 aserciones, incluida la carga del `119389.xlsx`).
- **✅ `migration-2026-08-12-hide-out-of-stock.sql` corrida** en
  producción (2026-08-12, confirmado por el usuario). Es la que hace que un producto con `stock <= 0` quede en Pre-Order
  **y fuera del catálogo** (ver "Productos" en la sección 1). Agrega
  `products.deactivated_by_stock`, reescribe el trigger
  `products_availability_from_stock`, apaga en el mismo paso los que hoy están
  publicados con stock 0 (con la bandera puesta, así vuelven solos cuando entre
  stock) y actualiza `apply_price_list` (contador `blocked_by_stock` + la
  desactivación por quedar fuera del archivo borra la bandera) y
  `compute_order_items` (`or deactivated_by_stock`, para no perder la línea de un
  carrito ya armado). Había que correrla **junto con el deploy, no después**: sin
  la columna el frontend nuevo funciona igual pero el filtro "📦 Inactivos por
  stock 0" no encuentra nada, el badge 📦 nunca aparece y los `update` que la
  mencionan fallan. El número que reportó el `raise notice` del paso 3 (cuántos
  productos se apagaron) no quedó anotado; si se necesita, sale de
  `select count(*) from products where deactivated_by_stock;`.
  Probada de verdad antes de entregarla: cluster PostgreSQL 18 desechable
  partiendo del `schema.sql` de producción, 10 bloques de assert (ciclo de stock,
  apagado a mano que no revive, 🔥 sin stock, `stock` null, `get_catalog` en los
  dos sentidos, línea de carrito que sobrevive, contadores y bandera de
  `apply_price_list`, pedido atendido/reabierto, backfill), corridos también
  re-aplicando la migración, con el `schema.sql` completo encima y en una
  instalación desde cero.
- **Integración SellerCloud** — ✅ **hecha el 2026-08-17**, con un cambio sobre
  lo que decía este plan: **no se dispara al crear la orden sino con un botón
  por pedido** en la bandeja (decisión del usuario: la vendedora revisa antes).
  Lo demás quedó como estaba pensado: Edge Function `sellercloud-push-order`,
  `POST /rest/api/Orders/` con canal Wholesale, `PUT /api/Orders/StatusCode`
  con status 200, y las vendedoras confirmando desde SellerCloud. Tampoco hizo
  falta agregarle el email a `clients`: los datos del cliente se leen de
  SellerCloud en el momento del envío con el `sellercloud_id` que ya teníamos.
  Falta lo de afuera: usuario de API dedicado y los secrets. Ver la sección 2.
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
  `skipped`); `migration-2026-08-13-exclude-box-skus.sql` (2026-08-13,
  **pendiente**) suma el sufijo `-BOX` a esa regla —77 SKU en el export real, que
  pasaban porque su `PRODUCT_CATEGORY` es `Perfume`— y agrega el trigger que los
  mantiene inactivos aunque los publique otra vía. `migration-2026-07-14-inventory-stock.sql` (2026-07-14)
  agrega `products.stock` (oculta al cliente) y hace que el inventario del
  JSON de SellerCloud (`InventoryAvailableQTY`) controle la
  **disponibilidad** en cada corrida del sync: `>= 1` → Disponible, `0`/
  negativo → Pre-Order, respetando `flash`. El estado **activo** ya no lo
  toca el sync (es manual). `migration-2026-07-14-product-upc.sql`
  (2026-07-14) agrega `products.upc` (código de barras; nació como dato interno
  del admin y desde 2026-08-14 también se le muestra al cliente, ver
  `migration-2026-08-14-catalog-upc.sql`) y hace que `sync_upsert_products` lo
  guarde (campo `upc` del payload). **El workflow de n8n está armado y corriendo en producción**
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
- **✅ `migration-2026-08-06-require-price.sql` corrida** (confirmado por el
  usuario el 2026-08-12; el sondeo con la anon key no podía verla porque solo
  reemplaza cuerpos de funciones) — un producto
  sin precio deja de salir en el catálogo. Ver "Un producto sin precio no sale en
  el catálogo" en la sección 1.
  - No tenía orden obligatorio respecto del frontend (no hay dependencia entre
    los dos). El efecto del catálogo es inmediato al correr
    el SQL, porque `get_catalog` es server-side; el frontend de esta tanda solo
    cambia los contadores de la pestaña Precios para que cuenten un 0 como "sin
    precio" y digan lo mismo que el catálogo.
  - Abre con un **preflight** que corta sin tocar nada si falta `apply_price_list`,
    `compute_order_items`, `order_failures` o la firma de `create_order` con
    `p_request_id`. Es decir: **necesita `migration-2026-08-05-order-capture.sql`
    corrida antes** (igual que la de métricas).
  - **No borra ni corrige ningún dato.** Las filas con `price = 0` que ya existan
    quedan donde están y simplemente dejan de publicar el producto. El final del
    archivo trae las consultas para listarlas antes de correr, y el `delete`
    por si después se quieren limpiar.
  - Probada contra un PostgreSQL 18 desechable: primero se **reprodujo el agujero
    sobre el `schema.sql` de HEAD** (un producto con precio 0 sale en el catálogo
    en $0.00 y se registra un pedido de 5 unidades con total $0.00), después se
    corrió la migración sobre ese mismo estado y se verificaron las 5 puertas
    (14 asserts), incluida la lista `quote` intacta, la cotización que sí se
    guarda sin precios, y que el `type = Flash Sale` del Excel de precios sigue
    mapeando a `availability = flash`. También en instalación desde cero con
    `schema.sql` solo, re-corriendo la migración, y con el `schema.sql` completo
    encima.
- **HECHO: `migration-2026-08-06-sa-metrics.sql` está corrida** (verificado el 2026-08-12: `sa_metrics_overview` devuelve `42501 permission denied`, o sea que existe y anon no tiene `execute`). Antes decía "pendiente" — habilita la
  pestaña 📈 Métricas (RPC `sa_metrics_overview` + los dos helpers de cuentas de
  prueba + los índices `orders_created_idx` y
  `admin_audit_log_order_status_idx`). Ver la sección 6.
  - **El frontend se puede desplegar antes.** Sin la RPC, la pestaña muestra
    "Falta correr migration-2026-08-06-sa-metrics.sql en la base de datos…"
    (detecta el `PGRST202` de PostgREST) en vez de romper; el resto del panel no
    se toca. No hay orden obligatorio.
  - Abre con un **preflight** que corta sin tocar nada si falta
    `is_superadmin()` (`migration-2026-08-05-superadmin.sql`), `admin_audit_log`
    o `order_failures`. Es re-corrible (todo `create or replace` /
    `create index if not exists`).
  - Probada contra un PostgreSQL 18 desechable arrancando del estado real
    (`schema.sql` de HEAD + la migración) y también con `schema.sql` solo: ~35
    asserts sobre un set de datos sembrado — los 6 totales, el orden y el cuadre
    de `por_vendedora` contra `monto_capturado`, el `min()` del tiempo de
    atención con un pedido que fue done → new → done (toma el primer done, no el
    tercero), conversión y fallos, la serie diaria (15 buckets, sin huecos,
    suma = total del período, días sin ventas en 0), la exclusión de
    `SystemsPruebas` (ni aparece en `por_vendedora` ni suma en `totals` — sus
    pedidos de 88.888 / 77.777 quedaron afuera, y su pedido atendido a las
    1000 h no movió el promedio), el clamp de `p_days` (0, −5, 99999, null) y la
    ventana de 7 días. Gating verificado actuando como rol `authenticated`:
    superadmin recibe el `jsonb`, **admin común y vendedora reciben
    `not authorized`**, `anon` no tiene ni `execute`, y los dos helpers no
    tienen `execute` ni para el superadmin.
- **HECHO: `migration-2026-08-05-order-capture.sql` está corrida** en
  producción — es el arreglo del pedido de ~10k que se envió por WhatsApp y no
  quedó registrado (ver "Si el pedido no llega a registrarse" en la sección 1).
  Sube el tope de líneas de `create_order` de 200 a 1000, crea `order_failures`
  (+ RLS + `grant select`), agrega `orders.request_id` con índice único
  parcial, suma `request_id` al trigger `orders_guard_items_edit` y crea
  `recover_order_failure`.
  - **Verificado el 2026-08-12** sondeando PostgREST con la anon key (sin
    escribir nada): la tabla `order_failures` responde y
    `recover_order_failure(p_failure_id)` existe. Este ítem decía "pendiente y
    urgente — hasta que corra el bug sigue vivo" **por error**: no asumir que el
    tope de 200 líneas sigue vivo ni que un rechazo no deja rastro.
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
- **✅ Edge Function `supabase/functions/admin-create-vendedora-user`
  desplegada** (2026-07-15, verificado el 2026-08-12: `POST
  /functions/v1/admin-create-vendedora-user` devuelve `403`, o sea que existe y
  rechaza por falta de JWT; una función no desplegada daría `404`. Ver
  sección 6). Es la que respalda el botón "+ Crear acceso" de la pestaña
  Vendedoras. "Vincular acceso" (usuario ya existente) no depende de ella.
- **✅ `migration-2026-07-15-order-status-cancelled.sql` corrida**
  en producción (confirmado por el usuario el 2026-08-12; el sondeo con la anon
  key no podía verla porque solo recrea un CHECK). Recrea el CHECK de
  `orders.status` para aceptar `'cancelled'` además de `'new'/'done'`; hasta que
  corrió, marcar un pedido como cancelado desde `/admin/orders` fallaba contra
  la base.
- **✅ `migration-2026-07-15-vendedora-update-price-list.sql` corrida**
  en producción (confirmado por el usuario el 2026-08-12; no se sondeó porque la
  RPC escribe). Crea la RPC `update_client_price_list`. Hasta que corrió, el
  selector de lista con confirmación de la pestaña Clientes fallaba para
  todos (admin incluido — ya no usa el `update` directo). Requería
  `migration-2026-07-14-client-admin-actions.sql` antes (crea
  `admin_audit_log`, donde esta función también audita), que ya estaba.
- **✅ `migration-2026-07-17-apply-price-list.sql` corrida** en
  producción (confirmado por el usuario el 2026-08-12; lo respalda además el
  preflight de `migration-2026-08-06-require-price.sql`, que corta si falta
  `apply_price_list` y sin embargo corrió). Crea la RPC `apply_price_list`, sin
  la cual subir un Excel de precios desde `/admin/prices` falla contra la base.
  Reemplaza el `.upsert()` directo a `product_prices` que
  reventaba con "ON CONFLICT DO UPDATE command cannot affect row a second
  time" si el Excel traía un SKU repetido (pasó con el archivo real de US
  Minimum Order, SKU `ZX_PE-MA-U-599175` duplicado) — la dedup por SKU
  ahora la hace la RPC del lado del servidor.
- **✅ `migration-2026-07-17-orders-edit-live-quotes.sql` corrida**
  en producción (verificado el 2026-08-12: `get_quotes_live_pricing` responde con
  su propio `P0001 no autorizado`, o sea que existe). Crea
  `admin_audit_log.order_id`, el trigger
  `orders_guard_items_edit` (blinda `items`/`total`/`status`/`kind`), el
  helper `compute_order_items` y las RPC
  `update_order_items`/`update_order_status`/`convert_quote_to_order`/
  `get_quotes_live_pricing` — ver sección 6). Hasta que corrió: editar una
  cotización fallaba, "Convertir en pedido" fallaba, marcar atendido/
  cancelar/reabrir fallaba (ya no es un `update` directo), y las
  cotizaciones se veían sin precio en vez de mostrar el precio vigente.
- **✅ `migration-2026-08-04-order-stock.sql` corrida** en producción
  (verificado el 2026-08-12: `orders.stock_applied` existe). Agrega esa columna,
  el trigger
  `products_availability_from_stock`, el helper `apply_order_stock`, y
  reescribe `update_order_status`/`convert_quote_to_order` para mover el
  stock — ver "Descuento de stock al atender un pedido" en la sección 2).
  Requiere que `migration-2026-07-17-orders-edit-live-quotes.sql` ya esté
  corrida (esta reescribe funciones que aquella crea). Crea también
  `products.stock` con `if not exists`, por si acaso, pero esa columna **ya
  existe**: `migration-2026-07-14-inventory-stock.sql` está corrida y el sync
  de n8n mantiene el inventario al día (confirmado por el usuario el
  2026-08-04 — este README y el `ZIMAXX-STORE-INFO.md` la listaban como
  pendiente por error). O sea que el descuento tiene de dónde restar.
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
    pdf.js              PDF del pedido/cotización (jsPDF; columnas Producto · UPC · Cantidad · Precio unit. · Subtotal)
    format.js           money / cleanPhone
  components/           Header, FilterBar, ProductCard, CartBar,
                        CartDrawer, ProductImage, ThemeToggle
  pages/
    Catalog.jsx         Catálogo del cliente
    admin/
      AdminLayout.jsx   Login + shell del panel
      ProductsAdmin.jsx Productos + carga Excel (productos, fotos, 🔥 Flash Sales) + acciones en bloque
      PricesUpload.jsx  Precios Excel + matriz por lista + filtros por grupo de producto
      ClientsAdmin.jsx  Clientes + niveles por inversión
      AuditLogAdmin.jsx Registro de movimientos (clientes, pedidos, superadmin)
      VendedoresAdmin.jsx  Alta manual de vendedoras + teléfono + acceso
      OrdersAdmin.jsx   Bandeja de pedidos + aviso de los que no se registraron (order_failures) con "Recuperar"
      SuperAdminPanel.jsx  Usuarios/roles/contraseñas + dueñas de listas (solo superadmin)
      MetricsAdmin.jsx  KPIs en vivo por polling + gráfico SVG + adopción por vendedora (solo superadmin)
      ui.jsx            Piezas compartidas (UploadZone, SearchIcon, ProductFilters/productMatchesFilters, ...)
supabase/schema.sql     Esquema completo + RLS + RPCs + migraciones
supabase/migration-*.sql  Deltas idempotentes para producción (no re-correr el schema completo)
supabase/functions/admin-create-vendedora-user/  Edge Function (Deno) — crea el usuario de Auth de una vendedora, requiere deploy manual
supabase/functions/superadmin-users/  Edge Function (Deno) — cambia contraseñas y crea admins (Admin API de Auth), requiere deploy manual (⚠️ 2026-08-19: NO está desplegada en producción — redesplegarla)
supabase/functions/sellercloud-push-order/  Edge Function (Deno) — crea la orden en SellerCloud + Sales Rep y direcciones vía PUT (v11 en producción, 2026-08-19)
tests/sc-push-tests.mjs  Suite del cliente de SellerCloud (22 comprobaciones, Node contra un servidor falso)
```
