# Zimaxx Store — Referencia completa del proyecto

> Documento de referencia para retomar el trabajo en cualquier sesión.
>
> **✅ ESTADO DE MIGRACIONES (2026-08-12): no queda ninguna pendiente.**
> Todas las migraciones de `supabase/` están **corridas y probadas en
> producción** (confirmado por el usuario el 2026-08-12), incluidas la única que
> la auditoría de ese día había verificado como pendiente
> (`migration-2026-08-12-hide-out-of-stock.sql`) y las tres que no se podían
> determinar desde la API (`migration-2026-08-06-require-price.sql`,
> `migration-2026-07-15-order-status-cancelled.sql`,
> `migration-2026-07-15-vendedora-update-price-list.sql`). La única que **nunca
> se corrió es `migration-2026-07-15-restrict-vendedora-luzmar.sql`, y no hace
> falta**: quedó reemplazada por `migration-2026-08-04-shared-price-lists.sql`,
> que sí está corrida.
> Si más abajo aparece un "pendiente de correr", es **histórico**: describe el
> estado al escribir esa entrada, no el de hoy. Antes de volver a marcar algo
> como pendiente, sondear producción con el método de la sección "Auditoría del
> estado real (2026-08-12)" — la lista de pendientes de este doc ya se equivocó
> en las dos direcciones antes.
>
> Creado: 2026-07-02. Última actualización: 2026-08-12 (**incidente: "las
> órdenes de un cliente no se registraron"** — los pedidos estaban guardados,
> lo que falló fue **encontrarlos**: el buscador del panel pedía una subcadena
> contigua, así que buscar "robert carlos" no encontraba a "Robert Edu Carlos
> Pacheco" y la bandeja vacía se leyó como pedido perdido. Ahora busca por
> términos (`src/utils/search.js`); de paso, `fetchAll` paginaba sin clave
> única y podía saltearse filas — punto 56, **sin migración**).
> Misma fecha (**un producto con
> stock 0 sale del catálogo**: sigue quedando en Pre-Order —esa etiqueta no
> cambia— pero se desactiva, y vuelve solo cuando entra stock gracias a la
> columna nueva `products.deactivated_by_stock` — punto 55,
> `migration-2026-08-12-hide-out-of-stock.sql` **corrida en producción el
> 2026-08-12**).
> Antes: 2026-08-07 (**se eliminó el área de
> Flash Sales**: la pestaña del panel y la sección con countdown del catálogo.
> Una Flash Sale pasa a ser solo la **etiqueta 🔥 del producto**, que se pone
> desde Productos con un Excel nuevo o con la selección en bloque; en la misma
> tanda, **acciones en bloque de etiquetas** (🔥 / Pre-Order / Disponible /
> ✨ Nuevo) y **filtros por grupo de producto en la pestaña Precios** —
> punto 53, **sin migración**. Cuarta tanda: **la bandeja de Pedidos deja de
> estar topeada en 200** — carga todos y el conteo pasa a ser el real, punto 54).
> Antes: 2026-08-06 (**pestaña 📈 Métricas**,
> solo superadmin: KPIs de todo el sistema en vivo por polling de 60 s, rango
> 7/14/30 días, adopción por vendedora y mini-gráfico de monto por día, todo
> desde una sola RPC `sa_metrics_overview` — punto 50; **migración corrida**.
> Segunda tanda: **arreglo del grupo de Flash Sales que reaparecía en
> el catálogo** + reactivar ofertas y grupos, punto 51, sin migración. Tercera
> tanda: **un producto sin precio —o con precio 0— no sale en el catálogo, no se
> cotiza y no se puede pedir**, punto 52, `migration-2026-08-06-require-price.sql`
> **corrida**).
> Antes: 2026-08-05 (**perfil superadmin**:
> pestaña 🔐 Superadmin para nombrar/quitar admins, cambiar contraseñas y
> asignar/desasignar listas de precio a vendedoras sin entrar al SQL Editor,
> restringida a `support5@firstchoiceonline.com` — punto 48; **migración
> corrida y Edge Function desplegada el mismo día**. Segunda tanda: **export a
> Excel del Registro de movimientos**, punto 49). Antes: 2026-08-04 (descuento de stock
> al atender un pedido + disponibilidad derivada del stock por trigger +
> aviso en el carrito + carrito que se vacía al enviar, punto 46; **listas
> de precio compartidas entre varias vendedoras**, punto 47; ver también
> el final de esta sección). Antes: 2026-07-20 (carga en paralelo
> de `fetchAll`). Antes: 2026-07-17 (edición auditada
> de pedidos + cotizaciones con precio vigente, ver el final de esta
> sección para el resumen más reciente). Historial anterior desde
> 2026-07-09: PDF separa
> Pre-Order;
> grupos de Flash Sales por lote O mismo vencimiento con desactivación y
> reprogramación de fechas en grupo; buscador + chips en Header sticky;
> optimización de rendimiento; etiqueta ✨ Nuevo automática ~10 días para
> productos recién creados, con fecha editable; buscador de producto en
> el alta de Flash Sale; badge Pre-Order rediseñado para resaltar en
> ambos temas; export de Excel de productos sin foto; lista de precio +
> acceso admin para Luzmar Quintero + trigger que garantiza que un
> cliente con su lista siempre quede asignado a ella — **requiere correr
> `migration-2026-07-09-luzmar-list.sql`, `migration-2026-07-09-luzmar-admin.sql`
> y `migration-2026-07-09-luzmar-owner-link.sql`, en ese orden**; filtro
> de listas de Clientes también respeta el candado de lista personal;
> validación de teléfono de vendedora con código de país — sin él,
> WhatsApp no abre el chat en iPhone). 2026-07-10: infraestructura SQL
> para el sync SellerCloud → Supabase vía n8n
> (`migration-2026-07-10-sellercloud-sync.sql`: tabla `sync_runs` +
> funciones `sync_upsert_products`/`sync_upsert_prices`/
> `sync_upsert_clients`, solo `service_role`). 2026-07-13: exclusión de
> productos no-catálogo (`migration-2026-07-13-exclude-noncatalog.sql`):
> desactiva los ya cargados con SKU `-SPECIAL` o categoría beauty/
> electronics/support/packing and shipping supplies/test, y blinda
> `sync_upsert_products` + la carga manual de Excel (`ProductsAdmin.jsx`)
> para que no los vuelvan a jalar. 2026-07-14: se registra el stock en la BD
> (`migration-2026-07-14-inventory-stock.sql` + `ProductsAdmin.jsx`):
> columna `products.stock` (oculta al cliente) que decide la
> **disponibilidad** — `InventoryAvailableQTY >= 1` → Disponible, `0`/
> negativo → Pre-Order, respetando `flash`; el estado activo NO lo toca el
> sync (es manual). Además, selección por casillas en la pestaña Productos
> para activar/desactivar en bloque, y columna `products.upc`
> (`migration-2026-07-14-product-upc.sql`) visible/editable/buscable en el
> panel (dato interno, no se muestra al cliente). Además, reasignar y
> eliminar clientes desde el panel (solo admin, vía RPC con auditoría en
> `admin_audit_log`; `migration-2026-07-14-client-admin-actions.sql`), con
> un Registro de movimientos que muestra qué usuario hizo cada acción.
> Proyecto construido y build verificado. 2026-07-15: pestaña Flash Sales
> ya no existe para el rol vendedora (oculta + redirect si entra por URL
> directa); lista de precio "personal" (ej. `luzmar`) ya no aparece para
> el resto de vendedoras ni en la matriz de Precios ni en los selectores
> de lista — solo su dueña y los admins la ven, vía RLS nueva en
> `price_lists`/`product_prices`
> (`migration-2026-07-15-restrict-vendedora-luzmar.sql`, **nunca se corrió y ya
> no hace falta**: la reemplazó `migration-2026-08-04-shared-price-lists.sql`,
> que sí está corrida y deja las mismas dos policies ya adaptadas a listas con
> varias dueñas). El Registro de movimientos ahora es una
> pestaña propia (`/admin/audit`, entre Clientes y Vendedoras) en vez de
> vivir colapsado dentro de Clientes — sigue siendo solo lectura,
> inmutable, sin policy de escritura para nadie salvo las RPC. Además,
> pestaña Vendedoras suma **"+ Crear acceso"**: crea el usuario de
> Supabase Auth de una (email + contraseña que define el admin ahí
> mismo) vía la Edge Function `admin-create-vendedora-user`, sin pasar
> por el dashboard de Supabase (deploy con `supabase functions deploy
> admin-create-vendedora-user` — confirmar que corrió bien tras el typo
> del primer intento). Además,
> `orders.status` suma el estado `cancelled` (el cliente arma y confirma
> el pedido pero a veces lo cancela después): en `/admin/orders`, un
> pedido Nuevo tiene botones "Marcar atendido" y "Cancelar"; uno
> Atendido/Cancelado tiene "Reabrir" — `migration-2026-07-15-order-status-cancelled.sql`
> recrea el CHECK de la columna, **corrida en producción** (confirmado por el
> usuario el 2026-08-12).
> Una vendedora ahora puede cambiarle la lista de precio a sus propios
> clientes (con confirmación "¿Cambiar a X?" antes de aplicar) vía la RPC
> nueva `update_client_price_list`, que además audita el cambio en
> `admin_audit_log` — `migration-2026-07-15-vendedora-update-price-list.sql`,
> **corrida en producción** (confirmado por el usuario el 2026-08-12; requería
> `migration-2026-07-14-client-admin-actions.sql` antes, que ya estaba). El
> Registro de movimientos suma filtro por usuario/acción/rango de fechas.
> **Bug real detectado por el usuario, mismo día**: clientes duplicados
> porque un lado tenía el teléfono con código de país (`51...`, Perú) y el
> otro sin él — pasaba tanto en la carga por Excel como (evidencia
> indirecta: ~45 duplicados creados en el mismo segundo, sin lista de
> precio, con `sellercloud_id` — sugiere que **el sync de n8n ya está
> corriendo en producción**, sin confirmación explícita todavía) en
> `sync_upsert_clients`. Corregido: `ClientsAdmin.jsx` compara por los
> últimos 10 dígitos (`phoneKey()`); `migration-2026-07-15-fix-duplicate-client-phones.sql`
> limpia los duplicados ya creados, reescribe `sync_upsert_clients` con el
> mismo criterio, y agrega un índice único por teléfono normalizado. El
> primer intento de correrla falló con "duplicate key value violates
> unique constraint clients_sellercloud_id_key" (el orden original copiaba
> el `sellercloud_id` a la fila real antes de borrar la fila basura,
> dejando un instante con las dos filas compartiendo el mismo valor) —
> reescrita en 4 pasos dentro de una transacción explícita: (1a) backup
> completo de `clients` (`clients_backup_20260715`, tabla normal, a pedido
> del usuario, se borra a mano una vez confirmado que todo quedó bien),
> (1b) capturar en tablas temporales qué fila borrar y a quién adoptar,
> (1c) borrar primero las filas basura, (1d) recién ahí copiar el
> `sellercloud_id` a la fila real. **Segundo intento también falló**
> (mismo día): el `create unique index` chocó con un teléfono que seguía
> duplicado después de la limpieza — al revisar a mano aparecieron 2
> pares de clientes reales (no basura del sync, ya cargados desde el
> 2026-07-02, cada uno con su propia lista/vendedora) que comparten
> teléfono porque el mismo negocio se agendó una vez con nombre personal
> y otra con nombre de empresa; el usuario confirmó que quiere mantenerlos
> como clientes distintos, no fusionarlos. Se agregó `clients.allow_shared_phone`
> (marcada `true` solo en esos 4 registros puntuales) y el índice único
> quedó parcial (`where not allow_shared_phone`) para no chocar con esa
> excepción — ver sección 6. También se ajustó `ClientsAdmin.jsx`: la
> carga por Excel ahora excluye del mapa de matching cualquier clave de
> teléfono que ya sea ambigua entre 2+ clientes existentes (esos 2 pares),
> para no arriesgarse a que un Excel futuro actualice el cliente
> equivocado — una fila así cae al alta de un cliente nuevo en vez de
> pisar uno de los dos. **Corrida en producción** (verificado el 2026-08-12:
> `clients.allow_shared_phone` existe; era urgente porque mientras no corriera,
> cada corrida del sync seguía generando más duplicados). 2026-07-16: auditoría completa comparando el
> export real de SellerCloud (868 clientes activos, vía n8n) contra los
> 1023 de la app — confirmó la sospecha del usuario de que Adriana
> Montilla tenía clientes "de más" (150 reales vs 190 en la app) y
> encontró el mismo patrón en otras vendedoras. Dos causas distintas, dos
> migraciones: `migration-2026-07-16-cleanup-unlinked-duplicate-clients.sql`
> borra 86 filas huérfanas de la carga inicial (2026-07-02) que son
> duplicados confirmados de un cliente que ya existe correctamente
> vinculado a SellerCloud con otro teléfono/sellercloud_id;
> `migration-2026-07-16-reassign-vendedora-mismatches.sql` reasigna 21
> clientes reales que estaban con la vendedora equivocada (18 de ellos
> mal puestos bajo Maria Fernanda Sardua, en realidad de Manuela
> Henriquez/Luzmila Ernandez/Yusleidy Romero/Jesus Rodriguez/Daniela
> Bohorquez). Quedan aparte, sin tocar a pedido del usuario: 103 clientes
> sin `sellercloud_id` que no matchean ningún cliente real de SellerCloud
> por nombre (podrían ser clientes que SellerCloud ya dio de baja, o
> basura de la carga inicial — pendiente de decisión), y 35 clientes
> reales que existen en SellerCloud pero todavía no están sincronizados a
> la app. **Ambas migraciones corridas en producción (2026-07-16).**
> 2026-07-17 (segunda tanda del día, después de `apply_price_list`, ver
> "Panel admin" más abajo): a pedido del usuario, varios cambios en
> Pedidos. (1) Una vendedora ahora puede **editar los ítems de una
> cotización** una vez que llega a la bandeja (cantidades, quitar,
> agregar producto por buscador — igual UI que el alta de Flash Sale) —
> **solo cotizaciones (`kind = 'quote'`) y solo mientras siguen
> `new`**; un pedido real (`kind = 'order'`) nunca se edita desde acá, y
> una cotización ya atendida o cancelada tampoco (ajuste del mismo día,
> a pedido del usuario, sobre una primera versión que permitía editar
> cualquier pedido no cancelado). Va por la RPC `update_order_items`,
> que audita el antes/después en `admin_audit_log` (acción
> `edit_order_items`, `admin_audit_log.order_id` nuevo); el trigger
> `orders_guard_items_edit` bloquea cualquier update directo a
> `items`/`total`/`status`/`kind` que no pase por una RPC (cada una
> habilita la escritura con `set_config('app.allow_order_edit', 'on',
> true)`, transacción-local) — así el permiso que ya tenía una vendedora
> para tocar sus propios pedidos no le sirve para saltarse la auditoría
> en ninguna de estas columnas. (2) El panel de Pedidos suma botón
> **"Descargar PDF"** (mismo `pdf.js` que ya usaba el carrito del
> cliente). (3) Al cliente descargar el PDF desde el carrito (antes solo
> generaba el archivo, sin tocar la base), ahora también se registra un
> pedido `kind = 'quote'` vía `create_order` — sin bloquear la descarga
> si falla el guardado. Como una cotización nunca guarda precio congelado
> (ver `compute_order_items`, factorizado del cuerpo que antes tenía
> `create_order`), el panel calcula el precio **vigente** al vuelo con la
> RPC `get_quotes_live_pricing` — si el admin cambia el precio de un
> producto después, las cotizaciones ya creadas lo reflejan solo con
> volver a abrir/refrescar el panel, no quedan ancladas al precio de
> cuando se pidieron. (4) **Convertir cotización en pedido** (RPC nueva
> `convert_quote_to_order`): a diferencia de la cotización, el pedido
> resultante SÍ congela precio (con la lista de precio real del
> cliente — rechaza si el cliente sigue en la lista `quote`, sin precio
> real que congelar) y ya no se sigue ajustando a cambios futuros;
> auditado (`convert_quote_to_order`). (5) **Marcar atendido/Cancelar/
> Reabrir ahora piden confirmación** (modal "¿Confirmás esta acción?")
> antes de aplicarse, y quedan auditados por la RPC nueva
> `update_order_status` (antes era un `update` directo sin rastro
> alguno). (6) Ajuste visual: al hacer click en un pedido, el detalle de
> ítems ya no se abre angosto dentro de la columna Ítems (quedaba muy
> alto y feo) — ahora abre una fila propia de ancho completo con una
> tabla (Producto/Cantidad/Precio/Subtotal); mismo criterio para el panel
> de edición (tarjeta propia, ancho completo). Los botones de acción se
> separaron en dos filas: Descargar PDF/Excel arriba, Editar/Convertir en
> pedido debajo (antes los tres quedaban apretados uno al lado del otro).
> `migration-2026-07-17-orders-edit-live-quotes.sql`, **corrida en producción**
> (verificado el 2026-08-12: `get_quotes_live_pricing` responde). 2026-07-20: el usuario notó que la pestaña
> Precios (matriz producto × lista) a veces tarda en cargar; la causa no
> era solo cache frío sino que `fetchAll` (`src/lib/supabase.js`), usada
> por todas las tablas grandes del admin, pedía las páginas de 1,000 filas
> **secuencialmente** (un `for` con `await` adentro) — con `product_prices`
> pudiendo superar las 15,000-20,000 filas (3,450 productos × varias
> listas), eran 15-20 round-trips en fila antes de poder pintar la tabla.
> Se cambió a pedir el conteo total primero (`count: 'exact', head: true`)
> y disparar todas las páginas con `Promise.all` — mismo resultado, pero
> el tiempo total pasa a ser el de la página más lenta, no la suma de
> todas. Beneficia a la vez a Productos, Clientes, Vendedoras, Flash Sales
> y Pedidos (todas usan `fetchAll`). Solo cambio de código, sin migración
> SQL ni cambio de comportamiento — build verificado.
> 2026-08-04: tres pedidos del usuario en una tanda. (1) **Aviso en el
> carrito** de que la disponibilidad y el precio están sujetos a cambio y
> hay que confirmarlos con la asesora (arriba de la lista de ítems +
> repetido en el diálogo de confirmación). (2) **El carrito se vacía** al
> enviar el pedido por WhatsApp o al generar la cotización con el PDF, y
> `CartContext` ahora **borra** la clave de `localStorage` cuando queda
> vacío en vez de guardar un `[]` — no queda rastro del movimiento en el
> dispositivo (el link se comparte por WhatsApp y se abre en teléfonos que
> a veces no son del cliente). En lugar de "carrito vacío" queda un acuse
> con botón "Armar otro pedido". (3) **Descuento de stock al marcar un
> pedido Atendido** + disponibilidad derivada del stock por trigger, ver
> el punto 46 para el detalle y las 3 decisiones que confirmó el usuario.
> `migration-2026-08-04-order-stock.sql`, **corrida en producción** (verificado
> el 2026-08-12: `orders.stock_applied` existe; requería
> `migration-2026-07-17-orders-edit-live-quotes.sql` antes, porque reescribe
> funciones que aquella crea, y esa ya estaba). Además se
> corrigió un bug preexistente de i18n: la key `inStock` estaba duplicada
> (catálogo "Disponible" vs admin "Con stock") y la del admin pisaba a la
> otra, así que el chip de disponibilidad del catálogo del cliente decía
> "Con stock" en español — la del admin pasó a llamarse `withStock`.
> Verificado: build limpio + la lógica SQL probada de verdad contra un
> PostgreSQL 18 desechable (cluster propio en el scratchpad, borrado
> después) con 16 casos, incluidos el ejemplo exacto del usuario, producto
> repetido en dos líneas, idempotencia del doble Atendido, devolución al
> reabrir/cancelar, cotización que no toca stock, y el bloqueo del update
> directo a `stock_applied`.
>
> 2026-08-07, **punto 53: se eliminó el área de Flash Sales; la Flash Sale
> pasa a ser una etiqueta del producto**. A pedido del usuario, con el porqué
> textual: *"los flash sales no hace falta que tengan un countdown, ya que
> realmente se usa como una estrategia para vender productos de los cuales se
> quiere mover inventario"*. Se fueron la pestaña **Flash Sales** del panel (la
> que estaba al lado de Vendedoras, `FlashSalesAdmin.jsx`) y la **sección negra
> con cuenta regresiva** del catálogo (`FlashSaleSection.jsx`), más la llamada a
> `get_flash_sales()` que el catálogo hacía en cada carga. Queda la etiqueta 🔥
> (`products.availability = 'flash'`), que ya existía desde 2026-07-08 con su
> badge en la tarjeta y su chip de filtro — el cliente no pierde nada visible
> salvo la caja de ofertas. **Sin migración y sin borrar datos**: la tabla
> `flash_sales`, sus filas y `get_flash_sales()` quedan en la base marcadas como
> LEGADO en `schema.sql`; deshacer esto es reponer código, no recuperar datos.
> Tampoco se tocó el flag `flash` de los ítems del carrito ni la rama que
> `compute_order_items` usa para revalorizarlos: ya nadie lo pone en true, y una
> línea vieja marcada así cae al precio de lista, que es lo correcto — sacarlo
> era refactorizar el carrito del cliente entero a cambio de nada.
>
> Tres cosas nuevas en la misma tanda:
> **(1) Carga de Flash Sales por Excel en la pestaña Productos** — el archivo
> semanal "Special Flash Sale" tal cual (323 SKU útiles de 324 filas en el real;
> la que sobra no trae SKU). Solo lee la columna SKU y pone la etiqueta; **la
> columna Price se ignora a propósito**, porque una Flash Sale ya no tiene
> precio propio. Vista previa antes de escribir (a marcar / a desmarcar / ya
> etiquetados / SKU sin producto) por la misma razón que la de precios: **por
> defecto también desmarca**, para que el archivo reemplace la promo de la
> semana; se puede destildar para acumular. De paso desaparece el pisón de la
> carga vieja, que no hacía upsert y duplicaba las ofertas al re-subir el mismo
> archivo. Avisa en rojo cuántos productos del archivo están **inactivos** (con
> etiqueta y todo, no se ven en el catálogo).
> **(2) Acciones en bloque de etiquetas** en la selección por casillas que ya
> existía: 🔥 Flash Sale / Pre-Order / Disponible, y marcar/quitar ✨ Nuevo. A
> pedido del usuario en la misma sesión, **un botón que no cambiaría nada
> aparece deshabilitado** con el motivo en el tooltip (marcar 🔥 sobre una
> selección que ya es toda 🔥, Activar sobre lo que ya está activo, etc.). Se
> calcula con `availabilityAfter()`, espejo del trigger, no con la etiqueta a
> secas — por eso distingue "ya están así" de "la disponibilidad la manda su
> stock" (Pre-Order sobre productos con stock ≥ 1 no cambia nada tampoco, pero
> por otro motivo, y decirlo bien es lo que evita que el admin lo intente tres
> veces). Con selección mixta siguen habilitados: la acción aplica al
> subconjunto que sí cambia.
> **(3) Filtros por grupo de producto en la pestaña Precios** (marca, línea,
> activo, con/sin stock, Pre-Order, 🔥, ✨), los mismos de Productos, extraídos a
> `pages/admin/ui.jsx` (`ProductFilters` + `productMatchesFilters`) para que las
> dos pestañas no puedan divergir; los contadores con/sin precios se recalculan
> sobre el grupo filtrado, que es lo único que hace útil la combinación.
>
> **Dos detalles que importan para no romper esto en el futuro.** El primero:
> Disponible y Pre-Order **no son libres**, las deriva del stock el trigger
> `products_availability_from_stock` (invariante de la tabla desde 2026-08-04),
> y solo `flash` se respeta siempre. O sea que un bulk de Pre-Order sobre
> productos con stock **no queda**, y desmarcar 🔥 devuelve el producto a
> Disponible o a Pre-Order según su stock. En vez de esconderlo, el panel relee
> después de aplicar y reporta el número real ("N con la etiqueta aplicada · M
> recalculados por su stock"). El segundo: los updates masivos van **en tandas
> de 100 ids** (`updateByIds` en `lib/supabase.js`). PostgREST manda el
> `id=in.(...)` en la query string: 300 uuids son ~11 KB de URL, y el bulk
> "Activar" sobre todo lo filtrado (3,500 productos, ~130 KB) se habría caído
> antes de llegar a la base — el `.in()` suelto que arrastraba `bulkSetActive`
> desde 2026-07-14 era una bomba de tiempo con esa selección.
>
> Verificado: build limpio; chequeo de que toda key `t()` exista en es/en (316 y
> 316, sin huérfanas nuevas tras borrar las ~25 keys de la pestaña vieja); el
> trigger contra un **PostgreSQL 18 desechable** con la tabla y el trigger
> copiados de `schema.sql` (4 escenarios: marcar 🔥 gana siempre, desmarcar
> manda stock 0/negativo a Pre-Order, Pre-Order en bloque se revierte con
> stock, ✨ Nuevo es independiente); la lógica de marcar/desmarcar contra el
> Excel real con un catálogo simulado; y **en navegador real con Playwright**:
> el catálogo (no queda sección ni countdown, no se llama más a
> `get_flash_sales()`, el chip 🔥 filtra 6 de 40); la **matriz de 52 aserciones
> de los botones deshabilitados** (6 selecciones × 7 botones, más los dos
> motivos y que un click forzado sobre un botón apagado no manda ningún PATCH);
> y **el panel admin con sesión
> de Supabase mockeada** — 29 aserciones, subiendo el `Special Flash Sale.xlsx`
> de verdad por el input y con un servidor falso que aplica los PATCH y
> reproduce el trigger: la vista previa da 295/7/5/23 y 4 inactivos, confirmar
> escribe 295 + 7 en tandas de 100+100+95 y 7, el aviso del bulk dice 150/150
> (exactamente lo que quedó en la base) y los filtros de Precios recortan la
> matriz con sus contadores. **Nada de esto tocó producción**: todas las
> llamadas a Supabase estaban interceptadas.
>
> 2026-08-06, **punto 50: pestaña 📈 Métricas** (`/admin/metrics`,
> `MetricsAdmin.jsx` + `migration-2026-08-06-sa-metrics.sql`), a pedido del
> usuario: los KPIs de todo el sistema en una pantalla, **en vivo**. Solo
> superadmin — la pestaña se renderiza solo si `isSuper`, `AdminLayout.jsx` corta
> la ruta `/admin/metrics` igual que la de 🔐 Superadmin, y la RPC exige
> `is_superadmin()` adentro (`not authorized`). Ocho tarjetas (monto capturado,
> pedidos, ticket promedio, cotizaciones, vendedoras activas, tiempo promedio a
> atender, cotizaciones convertidas, cancelados), fallos de envío del período,
> mini-gráfico de barras del monto por día y tabla "Adopción por vendedora" con
> export a Excel. Selector de rango 7/14/30 días, default 14.
> **Tres decisiones de diseño**: (1) **una sola RPC** `sa_metrics_overview` y
> nada de consultas a las tablas desde el cliente — los agregados cruzan a todas
> las vendedoras y con RLS el número saldría distinto según quién mira, además de
> obligar a bajarse el detalle de cada pedido para calcular un promedio; son 7
> consultas que en una RPC son un round-trip cada 60 s en vez de 7. (2) **polling
> y no Realtime de Supabase**: un evento de Realtime avisa que cambió UN pedido,
> y para saber el nuevo promedio hay que volver a pedir todo igual — el timer es
> la misma llamada sin el websocket abierto. (3) es la **única `sa_*` que no
> audita**: es de solo lectura, y una fila por refresco dejaría una por minuto
> por pestaña abierta en `admin_audit_log`.
> **Cuentas de prueba excluidas** de todos los agregados
> (`sa_metrics_test_vendedora_patterns()`, array de patrones ILIKE editable en un
> solo lugar), sin borrar ni tocar nada — y la RPC devuelve los nombres que
> matchearon (`excluidas`) para que el panel los muestre al pie de la tabla: si
> alguna vendedora real cae en un patrón, se ve, en vez de desaparecer del
> ranking en silencio. El tiempo de atención sale de `admin_audit_log` con
> `min(created_at)` por `order_id` sobre `update_order_status` +
> `detail->>'to_status' = 'done'` — `min` y no el último, porque un pedido puede
> ir done → new → done varias veces y lo que se mide es la primera atención; da
> `null` (y la tarjeta muestra "—" con el motivo) si todavía no hay ninguno.
> De paso, `t()` en `i18n.jsx` acepta un segundo argumento opcional con
> `{placeholders}`: frases como "Actualizado hace 12 s" / "Updated 12 s ago"
> cambian el orden de las palabras entre idiomas y partirlas en dos keys dejaba
> una mitad sin sentido en el diccionario. Las ~330 keys sin variables no se
> tocan. **Migración corrida en producción** (verificado el 2026-08-12:
> `sa_metrics_overview` existe y devuelve `42501` para `anon`). El frontend se
> podía desplegar antes: sin la RPC la pestaña muestra "Falta correr
> migration-2026-08-06-sa-metrics.sql…" (detecta el `PGRST202` de PostgREST) en
> vez de romper. Verificado: build limpio, i18n 314/314 keys pareadas, y la
> migración probada de verdad contra un PostgreSQL 18 desechable arrancando del
> estado real (schema.sql de HEAD + la migración) y también con `schema.sql` solo
> — ~35 asserts, incluidos el cuadre de `por_vendedora` contra
> `totals.monto_capturado`, el `min()` con un pedido que fue done → new → done,
> la serie diaria sin huecos que suma el total del período, el clamp de `p_days`,
> y la exclusión de `SystemsPruebas` (sus pedidos de 88.888/77.777 no suman ni
> aparecen, y su pedido atendido a las 1000 h no movió el promedio). Gating
> verificado como rol `authenticated`: superadmin recibe el `jsonb`, **admin
> común y vendedora reciben `not authorized`**, `anon` no tiene ni `execute`.
>
> 2026-08-06, **punto 52: un producto sin precio no sale en el catálogo**
> (`migration-2026-08-06-require-price.sql`), a pedido del usuario. `get_catalog`
> ya excluía los productos **sin fila** en `product_prices` para la lista del
> cliente; el agujero era el **precio 0**. `product_prices.price` es
> `numeric(10,2) not null check (price >= 0)` —o sea que 0 es válido para la
> tabla— y la regex de parseo de `apply_price_list` (`^[0-9]+(\.[0-9]+)?$`)
> matchea `"0"` y `"0.00"` igual que cualquier número: una celda en 0 en el Excel
> de precios (o una columna corrida) alcanzaba para que el producto saliera en el
> catálogo en **$0.00**, se pudiera agregar al carrito y se registrara **un pedido
> con total $0.00**. `create_order` recalcula el precio del lado del servidor,
> pero 0 era "un precio" para toda la cadena, así que lo tomaba como bueno.
> **La regla nueva, en un enunciado: un precio de 0 es lo mismo que no tener
> precio**, y un producto sin precio no se muestra, no se cotiza y no se puede
> pedir. Se aplica en las cinco puertas que llevan a lo mismo: `get_catalog`
> (`pp.price > 0`), `get_flash_sales` (`fs.price > 0` — `flash_sales.price` tiene
> el mismo check, así que una carga masiva con la columna corrida podía llenar la
> sección de $0.00), `compute_order_items` (los dos lookups piden `> 0`, así un 0
> se comporta **igual que "no hay fila"** y todo lo que ya manejaba "sin precio"
> —el total que no suma, el `—` de la tabla de pedidos, el PDF sin precios— sigue
> andando sin tocarlo), `create_order` (un pedido real con una línea sin precio se
> rechaza **entero** y queda en `order_failures` con los SKU culpables, para que el
> admin cargue el precio y le dé "Recuperar"; una cotización sí se guarda sin
> precios, es su función) y `convert_quote_to_order` (misma regla por la puerta del
> admin, con `raise exception` que nombra los SKU). Además `apply_price_list` pasa
> a contar un `0` como **precio inválido**: entra en `invalid_prices`, que el
> preview ya muestra antes de confirmar, y no se upsertea ni activa el producto.
> **Dos decisiones**: (1) la rama de la lista `quote` de `get_catalog` **no se
> toca** — ahí devolver todo con `price = null` es el diseño (catálogo de
> cotización), no un dato faltante; (2) `compute_order_items` **no descarta** la
> línea sin precio, la deja con `price: null` — descartarla la haría desaparecer de
> la vista de cotizaciones con precio vigente (`get_quotes_live_pricing`) sin decir
> nada, y en este proyecto una línea que se cae en silencio ya costó un pedido de
> ~10k. Quien decide qué hacer con una línea sin precio es el que crea el pedido.
> En la pestaña Precios, una celda en 0 se muestra en **rojo con ⚠** y los
> contadores "con precios / sin precios" cuentan el 0 como sin precio: si no, el
> panel diría "con precio" de un producto que el catálogo esconde.
> **No borra ni corrige ningún dato**: las filas con `price = 0` que ya existan
> quedan donde están y simplemente dejan de publicar el producto (el final del
> archivo trae las consultas para listarlas y el `delete` opcional).
> Verificado contra un PostgreSQL 18 desechable: primero se **reprodujo el agujero
> sobre el `schema.sql` de HEAD** (el producto en 0 sale en el catálogo en $0.00 y
> se registra un pedido de 5 unidades con total $0.00), después se corrió la
> migración sobre ese mismo estado y pasaron las 14 asserts de las 5 puertas —
> incluidas la lista `quote` intacta, la cotización que sí se guarda sin precios, y
> que el `type = Flash Sale` del Excel sigue mapeando a `availability = flash`.
> También en instalación desde cero (`schema.sql` solo), re-corriendo la migración,
> con el `schema.sql` completo encima, y confirmando que la migración de métricas
> sigue corriendo sobre ese estado. Al copiar las 6 funciones al archivo de
> migración se usó un diff automático contra `schema.sql` ignorando comentarios —
> agarró que la primera copia a mano de `apply_price_list` había perdido el caso
> `flash` del parseo de availability y había renombrado `list` a
> `list_code`/`list_label`, lo que habría roto el preview de la carga de precios.
>
> 2026-08-06, **punto 51: el grupo de Flash Sales que volvía al catálogo
> mientras el panel decía "Desactivada"**. ⚠ **Historia**: al día siguiente
> (punto 53) se eliminó esa pestaña entera y el concepto de oferta con
> countdown — este apartado describe algo que ya no existe. Se deja porque
> explica por qué el modelo viejo era confuso. Reportado por el usuario: le puso al
> grupo una fecha de vencimiento nueva para el mes siguiente, el panel siguió
> mostrando "Desactivada" y el catálogo empezó a mostrar la sección Flash Sale.
> Las dos cosas eran ciertas **sobre filas distintas del mismo grupo**: el badge
> rojo sale solo con `active = false`, mientras una oferta que apenas pasó su
> fecha sigue con `active = true` y se pinta "Expiró" (gris) — y un "grupo" es un
> armado del frontend (mismo `batch_id` o misma `expires_at`) que puede ser
> **mixto**. "Aplicar al grupo" escribía **solo `expires_at`**, así que con la
> fecha nueva todas las filas `active = true` volvían al catálogo en el acto
> (`get_flash_sales()` solo exige `active` + estar dentro del rango) y las
> `active = false` seguían apagadas. Encima, desactivar era un **camino de ida**:
> no había ningún botón para volver a prender una oferta, y de ahí que
> reprogramar la fecha se usara como workaround — que funcionó a medias y produjo
> exactamente la contradicción reportada.
> **No era un bug de la base**: `get_flash_sales()` filtra `active` bien y nunca
> publicó una oferta apagada. Reproducido y verificado contra un PostgreSQL 18
> desechable con el `schema.sql` real (8 aserciones): partiendo de un grupo mixto
> vencido, escribir solo `expires_at` deja el catálogo mostrando 3 ofertas
> mientras 2 filas siguen apagadas — y ninguna de esas 2 aparece nunca en
> `get_flash_sales()`. Arreglado **enteramente en `FlashSalesAdmin.jsx`, sin
> migración**: (1) el encabezado del grupo muestra su composición real en badges
> ("2 LIVE · 3 Expiró · 1 Desactivada"), así un grupo mixto se ve de una;
> (2) "Aplicar al grupo" pide confirmación diciendo cuántas van a volver al
> catálogo en el acto y cuántas están desactivadas y seguirán apagadas, con dos
> salidas — "Solo reprogramar" o "Reprogramar y reactivar todo"; (3) **"Reactivar"
> por fila y "Reactivar grupo (N)"**, la pieza que faltaba; (4) los grupos se
> arman sobre la lista **completa** y el filtro de estado se aplica después, solo
> a qué filas se muestran — antes se agrupaba la lista ya filtrada, así que con
> el filtro "Expiró" puesto un "Desactivar grupo" apagaba media promo sin
> decirlo (ahora el encabezado avisa "(N no se muestran por el filtro)" y los
> botones traen el total entre paréntesis); (5) los errores de update ya no se
> descartan en silencio y (6) una leyenda explica que "Expiró" se arregla con la
> fecha y "Desactivada" solo con Reactivar. La fecha nueva se escribe siempre a
> **todo** el grupo aunque no se reactive: si fuera solo a las activas, las otras
> se quedarían con la fecha vieja y el grupo se partiría en dos al recargar
> (los que no tienen `batch_id` se agrupan justamente por `expires_at`).
>
> 2026-08-05: **perfil superadmin** (`migration-2026-08-05-superadmin.sql` +
> `supabase/functions/superadmin-users` + pestaña 🔐 Superadmin), a pedido del
> usuario: las acciones que obligaban a entrar al SQL Editor o al dashboard de
> Auth pasan al panel, pero solo para `support5@firstchoiceonline.com` — hacer
> o quitar admin, cambiar la contraseña de cualquier acceso, y agregar/quitar
> dueñas de una lista de precio (incluido cuál es la principal). Sumado sin que
> lo pidiera pero en la misma línea de "no volver al SQL Editor": crear un admin
> desde cero (usuario de Auth + rol en un paso), listado de todos los usuarios
> con su rol y último acceso, reasignar de una vez los clientes que quedaron
> con una vendedora que dejó de ser dueña de su lista (el footgun que la
> migración del 08-04 documentaba para resolver a mano), y crear/renombrar/
> borrar listas de precio (crear una lista era un INSERT a mano: así nacieron
> `quote` y `luzmar`). **Decisión de diseño central**: la marca de superadmin
> vive en una tabla propia `superadmins` con RLS activo y CERO policies (desde
> la app no existe para nadie, ni para él mismo) y no en una columna de
> `admins`, porque `admins` tenía policy `admin_all` — o sea que cualquier
> admin podía escribirla vía API y se habría podido coronar solo. De paso, esa
> policy se cerró: `admins` y `price_list_owners` ahora tienen escritura solo
> superadmin + lectura admin. `is_admin()` pasa a incluir al superadmin (no
> puede dejarse afuera del panel ni por error) y `get_my_role()` sigue
> devolviendo `'admin'` para él a propósito: hay ~6 páginas que comparan
> `role === 'admin'` para mostrar sus controles de edición y un valor nuevo ahí
> las habría dejado en solo lectura — el panel pregunta aparte con
> `is_superadmin()`. **Corrida en producción el 2026-08-05** (ver el cierre de
> este párrafo; requería
> `migration-2026-07-14-client-admin-actions.sql` y
> `migration-2026-08-04-shared-price-lists.sql` ya corridas; el archivo tiene
> preflight que corta con mensaje claro) y **de desplegar la Edge Function**
> (`supabase functions deploy superadmin-users`; sin eso fallan solo los dos
> botones que necesitan la Admin API de Auth). Verificado: build limpio + la
> migración probada de verdad contra un PostgreSQL 18 desechable, arrancando
> del estado real de producción (schema.sql de HEAD + migración 08-04) y con 18
> bloques de assert — identidad de los 3 roles, rechazo de las RPC a un admin
> común, RLS de las 3 tablas actuando como el rol `authenticated`, ciclo
> completo de dueñas (agregar, cambiar principal, quitar la principal →
> promoción automática de la que queda, clientes colgados detectados y
> reasignados, idempotencia), validación del código de lista, guardas del
> borrado y auditoría de las 11 acciones nuevas; además idempotencia de
> re-correr la migración y de correr el `schema.sql` completo encima.
> **Corrida en producción y Edge Function desplegada el mismo 2026-08-05**
> (confirmado por el usuario; este párrafo la listaba como pendiente por error).
>
> 2026-08-05, **el pedido de ~10k que se envió por WhatsApp y no quedó
> registrado**. Reportado por el usuario: una vendedora le mandó el link a un
> cliente, el cliente armó un pedido grande, el mensaje de WhatsApp llegó con
> todos los productos, pero el pedido **no apareció en el sistema** — y al
> reintentar, tampoco. Lo desconcertante era que otros pedidos **más caros** sí
> entraban. Causa encontrada leyendo `create_order` y **reproducida** en un
> PostgreSQL 18 desechable con el schema real: la función rechazaba con un
> `return null` mudo cualquier pedido de más de **200 líneas distintas**, y
> `CartDrawer.jsx` abría WhatsApp igual, mostraba el ✓ de "Pedido registrado" y
> **vaciaba el carrito**. El tope nunca tuvo que ver con el monto sino con la
> cantidad de referencias: un mayorista que pide 50 unidades de 20 SKUs entra
> con 20 líneas y $15k; un cliente que recorre el catálogo y agrega 1–2 de cada
> cosa llega a 250 líneas con $10k y rebotaba. Y como el rechazo es
> determinista, el segundo intento falló idéntico. Medido en el cluster local
> para elegir el tope nuevo: 48 ms con 200 líneas, 232 ms con 500, 651 ms con
> 1000, 2.4 s con 2000, 9.8 s con 4000 — crece superlineal porque el acumulador
> `v_items := v_items || ...` copia el jsonb entero en cada vuelta, así que el
> tope **no se podía sacar del todo**: pasando las ~2000 líneas se choca con el
> `statement_timeout` del rol `anon` y volvería el mismo fallo silencioso por
> otra puerta. Quedó en 1000 (5x el caso que falló, ~0.65 s). Arreglo en tres
> capas, porque el tope era solo la causa inmediata — el problema de fondo era
> que **un pedido podía desaparecer sin que nadie se enterara**: (1) tope a
> 1000; (2) **todo rechazo deja fila en `order_failures`** con motivo, conteo y
> payload, más un aviso rojo en la bandeja de Pedidos con botón "Recuperar"
> (`recover_order_failure`) que lo carga como pedido con los precios vigentes —
> antes el único registro era un `console.warn` en el teléfono del cliente, o
> sea nada; (3) **el carrito ya no se vacía si el registro falló**: aviso rojo
> con "Reintentar registro" y el pedido sigue ahí, los fallos de red se
> reintentan solos y los rechazos del RPC no (darían lo mismo siempre). Para que
> reintentar no duplique, `CartContext` genera un `request_id` por carrito y
> `create_order` es idempotente sobre él (`orders.request_id` con índice único
> parcial + captura del `unique_violation` para la carrera de dos envíos
> simultáneos). `migration-2026-08-05-order-capture.sql`, **corrida en
> producción** (verificado el 2026-08-12 sondeando PostgREST; este párrafo decía
> "pendiente y urgente — hasta que corra, el bug sigue vivo" por error, ver
> punto 56). Abre con
> preflight (corta si falta `compute_order_items` o las funciones del rol
> vendedora) y crea `orders.stock_applied`/`admin_audit_log.order_id` con
> `if not exists`, porque el trigger que reescribe nombra `stock_applied` y sin
> la columna reventaría en el primer `update` a `orders`. **Correr el SQL antes
> de desplegar el frontend**; si el orden se invierte no se cae, `CartDrawer`
> detecta el error de firma y reintenta sin `p_request_id`. Verificado: build
> limpio, chequeo de que toda key `t()` exista en es/en (289 y 289, ninguna
> huérfana), y contra el cluster desechable — 199/200 líneas entran, 250 entra
> después del cambio, 1001 rechaza y deja la fila, el mismo `request_id` tres
> veces devuelve el mismo `order_id` y deja **un** pedido, un frontend viejo (3
> y 4 argumentos) sigue funcionando, `recover_order_failure` rechaza a anon/a
> una vendedora ajena/al segundo intento y audita, RLS de `order_failures` como
> rol `authenticated` (admin todo, vendedora solo lo suyo, anon nada, ninguno
> escribe), el preflight corta sin crear nada, la migración es idempotente y
> corre limpio sobre el schema de HEAD.
>
> 2026-08-12, **un producto sin stock sale del catálogo**. Pedido del usuario:
> *"cuando un producto quede con stock 0 en la base de datos, que se siga
> poniendo en pre-order pero que se desactive, es decir, que no salga en el
> catálogo"*. Revierte a propósito **media** decisión del 2026-07-14, que decía
> textualmente "un producto con stock 0 ahora se MUESTRA como pre-order; ocultarlo
> es una acción manual aparte": lo que se mantiene es la **etiqueta** (sigue
> quedando en `preorder`, que es el dato con el que la asesora sabe que se puede
> reservar), lo que cambia es la **publicación**. La regla nueva vive donde ya
> vivía la vieja, en el trigger `products_availability_from_stock`, así que no
> importa quién escriba —el sync de n8n, el Excel de productos, el de precios, la
> carga masiva, el formulario, el descuento de un pedido atendido o un request
> directo con la anon key—: un producto en 0 no puede quedar publicado. **La
> pieza que hace que esto no sea destructivo es la columna nueva
> `products.deactivated_by_stock`**: no es "está sin stock" (eso ya lo dice
> `stock`) sino "esta regla fue la que lo apagó", y es lo único que permite
> reactivar solo por stock sin resucitar de paso lo que un admin apagó a mano ni
> —peor— los productos de la exclusión de no-catálogo (SKU `-SPECIAL`,
> beauty/electronics/support/packing/test), que tienen stock de sobra y no deben
> verse nunca. Tres decisiones confirmadas antes de escribir: vuelve solo cuando
> entra stock pero **solo el que apagó esta regla**; un 🔥 Flash Sale con stock 0
> **también** se despublica (conserva la etiqueta, pero una Flash Sale es para
> mover inventario y sin inventario no hay nada que mover); y los que hoy están
> publicados con stock 0 se apagan **en la misma migración** (paso de backfill,
> con la bandera puesta), porque si no seguirían visibles hasta la próxima corrida
> del sync. Dos efectos colaterales que había que resolver para que el cambio no
> rompiera nada: (1) **la línea del carrito** — `compute_order_items` descarta en
> silencio la línea de un producto inactivo, así que un cliente que manda el
> pedido dos minutos después de que el sync bajó el stock habría perdido ítems sin
> que nadie se enterara (en este proyecto una línea que se cae en silencio ya
> costó un pedido de ~10k); ahora busca con `(active or deactivated_by_stock)`, o
> sea que lo que salió del catálogo por falta de stock se sigue pudiendo pedir y
> lo que apagó una persona no. (2) **el preview de la carga de precios** —
> `apply_price_list` contaba como "a reactivar" productos que el trigger iba a
> dejar apagados; se les dio un contador propio (`blocked_by_stock`, chip "📦 N no
> vuelven (stock 0)"), y de paso el UPDATE que desactiva lo que quedó fuera del
> archivo ahora **borra** la bandera: sacarlo de la lista es decisión de una
> persona, así que no puede volver solo en la próxima entrada de inventario. En el
> panel, lo que importaba era que no mintiera: "Activar" sobre algo sin stock no
> lo publica pero **no es un no-op** (queda marcado y se publica cuando entre
> stock), así que el aviso separa "3 activados · 5 siguen inactivos por stock 0" en
> vez de contar 8 aplicados; "Desactivar" apaga la bandera y por eso sigue
> habilitado sobre un producto ya inactivo por stock —es la única forma de decir
> "este no vuelve", ya que el badge de la fila solo ofrece activar—; el badge de
> estado lleva 📦 con el porqué en el tooltip; y hay un filtro nuevo "📦 Inactivos
> por stock 0" que separa lo que se arregla solo de lo que hay que revisar a mano.
> `migration-2026-08-12-hide-out-of-stock.sql`, **corrida en producción el
> 2026-08-12** (confirmado por el usuario) — había que correrla **junto con el
> deploy**, no después: sin la columna, el filtro nuevo no encuentra nada y los
> `update` que la mencionan fallan. **Verificado de verdad**: `npm run build` limpio + la migración probada
> contra un PostgreSQL 18 desechable arrancando del `schema.sql` de HEAD (o sea el
> estado real de producción), con 10 bloques de assert — ciclo 5→0→3→−2, apagado a
> mano que no revive con stock, 🔥 que conserva etiqueta y no publica, `stock` null
> que no toca nada, `get_catalog` en los dos sentidos, línea de carrito que
> sobrevive y la del apagado a mano que no, contadores y bandera de
> `apply_price_list` (incluido que lo sacado del archivo NO vuelve al entrar
> stock), pedido atendido/reabierto y el backfill —, corridos cuatro veces: tras
> la migración, re-aplicándola, con el `schema.sql` completo encima y en una
> instalación desde cero. Y el panel probado **en navegador real** (Chromium con
> el host de Supabase interceptado y un servidor en memoria que reproduce el
> trigger, receta del 2026-08-07): 15 aserciones sobre badge 📦, filtro nuevo,
> botones apagados con su motivo, los tres avisos y el regreso automático al
> entrar stock.
>
> 2026-08-12, **punto 56: "las órdenes del cliente Robert Carlos Pacheco no se
> registraron"**. Reportado como incidente crítico de soporte. **No era un
> problema de captura: era de búsqueda.** El buscador de la bandeja de Pedidos
> filtraba con `name.toLowerCase().includes(q)`, o sea **una subcadena
> contigua**; el nombre que guarda el sync es el `Name` completo de SellerCloud
> —"Robert Edu Carlos Pacheco"— mientras el negocio lo conoce por su
> `CorporateName`, que en el export real es literalmente **"Robert Carlos"**.
> Comprobado con el nombre exacto de la base: buscar `"robert carlos"`,
> `"robert carlos pacheco"` o `"Robert Carlos"` devolvía **cero resultados**
> sobre un cliente que sí podía tener pedidos, y una bandeja vacía se lee como
> "no se registró nada". El nombre de en medio no es una excepción: los datos
> vienen de SellerCloud, donde el mismo cliente aparece como
> `Name`/`CorporateName`/`ContactName`, así que la app casi siempre tiene
> guardada una variante más larga que la que alguien va a tipear.
> **Arreglo**: `src/utils/search.js` (`normalizeText`/`searchTerms`/
> `matchesTerms`) — todos los términos tienen que aparecer, en cualquier orden,
> sin acentos y sin importar mayúsculas. Aplicado al buscador de **Pedidos** y
> al de **Clientes** (si el cliente no se encuentra ahí, tampoco se puede
> revisar su lista ni su vendedora para explicar un pedido). **Con una sola
> palabra se comporta exactamente igual que antes**, así que no cambia ningún
> resultado que ya funcionaba — verificado con 11 consultas de una palabra
> contra nombres reales del export, 0 diferencias. Dos decisiones: los términos
> **no se reparten entre campos distintos** (que "juan perez" matchee el nombre
> "Juan" más la vendedora "Perez" sería un falso positivo, y en una bandeja de
> pedidos un falso positivo cuesta lo mismo que un falso negativo), y la
> comparación ignora acentos (`\p{Diacritic}`, no un rango de caracteres
> combinantes literales, que en el fuente son invisibles y cualquier reformateo
> los pierde) para que "ramon nunez" encuentre a "Ramón Núñez".
> **Segundo hallazgo, mismo síntoma por otra puerta**: `fetchAll`
> (`src/lib/supabase.js`) pide las páginas de 1,000 filas **en paralelo**, cada
> una con su propio `range`, y Postgres no garantiza ningún orden entre filas
> que **empatan** en la clave de ordenamiento — con un empate en el borde de una
> página, una fila puede salir en dos páginas o **en ninguna**, o sea
> desaparecer de la tabla del admin estando en la base. No era hipotético:
> `product_prices` se paginaba ordenando solo por `product_id`, que tiene **una
> fila por lista de precio**, así que había empates en todos los bordes de sus
> ~20 páginas (una celda de la matriz de Precios podía figurar como "sin
> precio"). `fetchAll` ahora acepta varias columnas de orden y los call sites
> pasan una combinación única: `['created_at','id']` en Pedidos y Registro,
> `['name','id']` en Productos/Clientes/Vendedoras, `['product_id',
> 'price_list_id']` en Precios. Sin migración: todo es frontend.
> **Estado real de producción comprobado de paso**, con la anon key y sin
> escribir nada — ver la sección "Auditoría del estado real (2026-08-12)" más
> abajo para la tabla completa. El titular: de las 8 migraciones que los docs
> listaban como pendientes, **6 ya estaban corridas**; la única realmente
> pendiente y verificada era `migration-2026-08-12-hide-out-of-stock.sql`, que
> el usuario corrió ese mismo día — **al 2026-08-12 no queda ninguna
> pendiente**.
> **Sobre el método, porque me equivoqué primero y vale la pena que quede
> escrito**: arranqué leyendo el `hint` del `PGRST202` (PostgREST sugiere la
> firma real cuando la función tiene un solo parámetro), y con eso concluí que
> `sa_metrics_overview` no existía. **Era falso**: el `hint` tampoco aparece para
> `get_quotes_live_pricing(p_order_ids uuid[])`, que sí existe, así que la
> ausencia de `hint` no prueba nada. **El test que sí sirve** es llamar a la
> función con el **nombre real de sus parámetros** y mirar el código de error:
> `PGRST202` = no existe; `42501` (permission denied) o un `P0001` propio de la
> función = existe y solo falta permiso. Para una columna, `select=<col>` sobre
> la tabla: `42703` = no existe, `[]` = existe y RLS no devuelve filas. Elegir
> siempre funciones de **lectura** (o `immutable`), nunca una que escriba.
> Queda **sin verificar del lado de los datos** si además hubo un rechazo real:
> eso se responde con `supabase/diagnostico-2026-08-12-pedidos-no-registrados.sql`
> (lo escribió otra sesión el mismo día), que lista los pedidos y los
> `order_failures` de ese cliente.

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
- [x] `schema.sql` con el rol vendedora (`vendedores.user_id`/`login_email`,
  `is_vendedora()`/`current_vendedora_id()`/`get_my_role()`, policies RLS,
  RPC `link_vendedora_login`) corrido en Supabase.
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
  `admin`.
- [x] `og:image` ajustado (2026-07-06) a `https://catalogozimaxx.netlify.app/zimaxx.png`, la URL real del sitio en Netlify (el sitio se llama `catalogozimaxx`). Ojo: si conectan un dominio propio más adelante, hay que volver a actualizar esta línea en `index.html` y redesplegar.
- [ ] Excel de clientes reales cargado (incluyendo precios Special)
- [x] **Catálogo de cotización sin precios** (2026-07-08): lista `quote`
  sembrada en `price_lists`, seleccionable en el selector "Lista" de
  cualquier cliente; `get_catalog`/`create_order` la detectan por `code`.
  SQL corrido y código desplegado.
- [x] `schema.sql` con `flash_sales.batch_id` corrido en producción
  (2026-07-09).
- [x] `supabase/migration-2026-07-09-new-until.sql` corrido en producción
  (2026-07-09, segunda tanda) — agrega `products.new_until` y `is_new`
  en `get_catalog` (etiqueta ✨ Nuevo).
- [x] Código de toda la sesión del 2026-07-09 commiteado (`157af9b`
  "cambios catalogo, pdf, barra de busqueda, flash sales, etc etc",
  `87c081d` "buscador mejorado, badge pre order cambiado, excel de
  productos sin foto") y desplegado en Netlify.
- [x] **Corridas, en este orden** (2026-07-09; confirmado indirectamente el
  2026-08-05 — el preflight de `migration-2026-08-04-shared-price-lists.sql`
  exige `luzmar-owner-link` y el de `migration-2026-08-05-superadmin.sql` exige
  la del 08-04, y ambas corrieron bien. Este ítem había quedado sin tildar por
  error):
  1. `migration-2026-07-09-luzmar-list.sql` (agrega la lista de precio
     `luzmar`; solo un INSERT, sin riesgo de deadlock).
  2. `migration-2026-07-09-luzmar-admin.sql` (la vincula como admin por su
     email; requiere que ya tenga usuario en Supabase Auth).
  3. `migration-2026-07-09-luzmar-owner-link.sql` (vincula la lista a su
     fila de `vendedores` por nombre y crea el trigger
     `clients_enforce_owner_vendedora` — garantiza que un cliente con esa
     lista siempre quede asignado a ella, aunque el admin panel, un
     Excel o un request directo digan otra cosa).
  Después: subirle Excel de precios a su lista desde la pestaña Precios.
- [x] `migration-2026-07-10-sellercloud-sync.sql` corrida en producción
  (2026-07-10) y **probada a mano** con los selects comentados del final
  del archivo (productos, precios, clientes y el caso de lista personal
  con el trigger pisando la vendedora) — todo OK, filas de prueba
  limpiadas.
- [x] `migration-2026-07-10-sellercloud-sync-v2.sql` corrida en
  producción (2026-07-10, mismo día) y **probada a mano**: las 3 filas de
  prueba dieron el resultado esperado — match de vendedora normalizado
  funcionando ("LUZMAR QUINTERO" en mayúsculas asignó a Luzmar Quintero),
  salesman inexistente quedó sin vendedora + contado en
  `unmatched_salesman`, y los tres clientes sin lista de precio
  (`price_list_id` null, asignación manual).
- [x] **`migration-2026-07-13-exclude-noncatalog.sql` CORRIDA** (verificado el 2026-08-12 sondeando PostgREST, ver “Auditoría del estado real”;
  `sync_is_noncatalog_product` existe y responde). Lo que hizo (desactiva los productos no-catálogo ya cargados — SKU
  `-SPECIAL` + categorías beauty/electronics/support/packing and shipping
  supplies/test — y blinda `sync_upsert_products`). Contra el export
  `119389.xlsx` la regla toca 209 productos (111 `-SPECIAL` + 98 por
  categoría), deja 3450 de catálogo. El código de la carga manual de Excel
  ya está desplegado con el mismo filtro.
- [x] **`migration-2026-07-14-inventory-stock.sql` corrida en producción**
  (agrega `products.stock` y hace que `InventoryAvailableQTY` del sync
  controle la disponibilidad: `>= 1` available, `0`/negativo preorder,
  respetando flash; `active` NO lo toca el sync). **Confirmado por el
  usuario el 2026-08-04**: el flujo de n8n ya está corriendo y actualizando
  el stock de los productos constantemente — este ítem había quedado
  marcado como pendiente en el doc por error (nadie lo actualizó cuando se
  corrió). Si hace falta re-confirmar el estado real:
  `select count(*) as total, count(stock) as con_stock from public.products
  where active;`
- [x] **`migration-2026-07-14-product-upc.sql` CORRIDA** (verificado el 2026-08-12 sondeando PostgREST, ver “Auditoría del estado real”;
  la columna `products.upc` existe). Lo que hizo (agrega `products.upc` y hace que `sync_upsert_products` lo
  guarde). El frontend (columna/campo/búsqueda por UPC) ya se puede
  desplegar. El n8n debe mapear `UPC` → `upc`.
- [x] **`migration-2026-07-14-client-admin-actions.sql` corrida** (crea
  `admin_audit_log` + RPC `reassign_client`/`delete_client`). Marcada como hecha
  el 2026-08-05: el preflight de `migration-2026-08-05-superadmin.sql` corta si
  `admin_audit_log` no existe, y esa migración corrió bien — así que esta ya
  estaba aplicada (la fecha exacta no quedó registrada).
- [x] **Workflow de n8n armado y corriendo en producción** (llama a las 3
  funciones `sync_upsert_*` con la **service_role key** — no la anon, esas
  funciones no son ejecutables por anon/authenticated). **Confirmado por el
  usuario el 2026-08-04**: está corriendo y "actualizando constantemente el
  stock de los productos", además del resync completo de clientes dos veces
  al día que ya se había confirmado el 2026-07-16. Sigue pendiente del lado
  de n8n el **nodo de cierre de `sync_runs`** (el `PATCH` final con los
  contadores) — ver más abajo; sin eso la tabla de auditoría no muestra
  cuántas filas procesó cada corrida.
- [x] ~~`migration-2026-07-15-restrict-vendedora-luzmar.sql`~~ **ya no hace
  falta correrla** (2026-08-04): quedó reemplazada por
  `migration-2026-08-04-shared-price-lists.sql`, que deja las mismas dos
  policies pero ya adaptadas a listas con varias dueñas. Nunca se corrió y ya no
  hace falta: con la del 08-04 aplicada, el blanket viejo (cualquier vendedora
  viendo la lista de Luzmar en la matriz de Precios) quedó cerrado.
- [x] **Edge Function `admin-create-vendedora-user` DESPLEGADA** (verificado el
  2026-08-12: `POST /functions/v1/admin-create-vendedora-user` devuelve **403**,
  o sea que existe y rechaza por falta de JWT — una función no desplegada da
  **404**). Historia: el 2026-07-15 el primer `supabase functions deploy` tenía
  un typo (`admin0create-vendedora-user`) y falló; el reintento con el nombre
  correcto sí terminó OK. "Vincular acceso" (usuario ya existente) no depende de esto
  y ya funciona.
- [x] **`migration-2026-08-12-hide-out-of-stock.sql` CORRIDA** (2026-08-12,
  confirmado por el usuario el mismo día — el sondeo de la mañana la había
  encontrado pendiente: `products.deactivated_by_stock` devolvía
  `42703 column does not exist`). Agregó esa
  columna, amplió el trigger `products_availability_from_stock` para que
  `stock <= 0` además **despublique** el producto, hizo el backfill de los que
  estaban publicados con stock 0, y ajustó `apply_price_list` y
  `compute_order_items`.
  - Había que **correrla junto con el deploy del frontend, no después**: la
    pestaña Productos nombra la columna (filtro "📦 Inactivos por stock 0",
    badge y los `update` que la escriben), así que sin la migración esos
    caminos fallan.
  - El número que reportó el `raise notice` del backfill no quedó anotado; si se
    necesita, sale de `select count(*) from products where deactivated_by_stock;`

- [x] **`migration-2026-07-15-order-status-cancelled.sql` corrida** (confirmado
  por el usuario el 2026-08-12; el sondeo con la anon key no podía determinarlo
  porque solo recrea un CHECK). Recrea el CHECK de `orders.status` para sumar
  `'cancelled'` a `'new'/'done'`. Sin esto, marcar un pedido como cancelado
  desde `/admin/orders` fallaba contra la base.
- [x] **`migration-2026-07-15-vendedora-update-price-list.sql` corrida**
  (confirmado por el usuario el 2026-08-12; no se había sondeado porque la RPC
  escribe). Crea la RPC `update_client_price_list`, que reemplaza el
  `update` directo que hacía `ClientsAdmin.jsx` para cambiar la lista de
  un cliente. Era **rompedora si no se corría**: el selector de lista con
  confirmación fallaba para TODOS, admin incluido, porque el frontend ya no usa
  el update viejo. Requería `migration-2026-07-14-client-admin-actions.sql`
  antes (crea `admin_audit_log`, donde esta función también audita), que ya
  estaba.
- [x] `migration-2026-07-15-fix-duplicate-client-phones.sql` corrida en
  producción (2026-07-16, confirmado con query de diagnóstico): limpió
  315 clientes duplicados (mismo cliente cargado con y sin código de país
  en el teléfono), corrigió `sync_upsert_clients` para que no lo vuelva a
  hacer, y agregó el índice único **parcial** por teléfono normalizado
  (`clients_phone_normalized_key`, respeta la excepción
  `allow_shared_phone` — 2 pares de clientes reales que comparten
  teléfono y el usuario decidió mantener separados, ver sección 6). El
  código de esta sesión (frontend + migración) está commiteado
  localmente (`9ce3020`), **pendiente de `git push`** (el usuario lo hace
  a su criterio).
- [x] `migration-2026-07-16-cleanup-unlinked-duplicate-clients.sql`
  corrida en producción (2026-07-16) — borró 86 clientes huérfanos de la
  carga inicial (2026-07-02) confirmados como duplicados de un cliente
  que ya existe vinculado a SellerCloud con otro teléfono.
- [x] `migration-2026-07-16-reassign-vendedora-mismatches.sql` corrida en
  producción (2026-07-16) — reasignó 21 clientes reales que estaban con
  la vendedora equivocada.
- [x] **Ya explicado (2026-07-16), no es un bug de n8n**: por qué 18 de
  los 21 clientes de vendedora incorrecta quedaron bajo "Maria Fernanda
  Sardua". Los 21 tienen `created_at = 2026-07-02` (carga masiva manual
  original, **antes** de que existiera el sync con SellerCloud) y ya
  tenían `price_list_id` asignado — la vendedora vieja viene de esa
  carga, no de un fallback de n8n. Lo que pasó después: un sync
  posterior los vinculó a SellerCloud por teléfono (rama `linked_by_phone`
  de `sync_upsert_clients`), que hace `vendedora_id = coalesce(v_vendedora_id,
  vendedora_id)` — si en ese momento no matcheó el `Internal.SalesMan`
  contra ninguna vendedora, conservó la vendedora vieja en vez de
  corregirla. No hace falta tocar el n8n por esto — la migración
  `migration-2026-07-16-reassign-vendedora-mismatches.sql` ya corrige el
  dato puntual. **Pregunta real pendiente para el n8n** (la lleva otra
  sesión con Claude Desktop, que no tenía visibilidad de los cambios de
  esquema aplicados hoy vía SQL Editor en esta sesión): ¿el flujo hace
  *resync completo* de clientes que YA tienen `sellercloud_id` (para
  refrescar el vendedor si cambió en SellerCloud), o solo procesa
  altas/cambios nuevos? Si es solo incremental, este tipo de
  desactualización puede repetirse y explicaría también por qué hay 35
  clientes reales de SellerCloud que todavía no existen en la app.

**Respuesta de Claude Desktop (2026-07-16, mismo día)**: el flujo de n8n
SÍ hace resync completo en cada corrida — `SC: Clientes listado` pagina
el listado entero de SellerCloud (`Customers?model.companyIds=172`, sin
filtro de fecha/delta, ~882-884 `UserID`) y **todos** pasan por
`SC: Cliente detalle` → `sync_upsert_clients` dos veces al día, no solo
los nuevos/cambiados. Con el `coalesce()` de la función, la vendedora de
los 21 casos debería autocorregirse sola en la próxima corrida una vez
que SellerCloud tenga el `Internal.SalesMan` correcto (que aparentemente
ya lo tiene, según el export real que generó el usuario) — no hace falta
ninguna acción de n8n para esto.

**Sobre los 35 faltantes**: Claude Desktop reportó que en la última
corrida real, de 884 clientes solo 867 llegaron completos a
"Mapear cliente" — ~17 se cayeron por timeouts intermitentes
(`ETIMEDOUT`) contra la API de SellerCloud, a pesar de retry/batching.
Eso explica una parte del gap, no las 35 completas. Lista exacta de los
35 `sellercloud_id` faltantes (generada cruzando `Clientes+Salesman.txt`
vs `clients_export.txt`, ambos locales, no en git) para cotejar contra
los logs de timeouts de corridas recientes: **~11-12 son basura/test de
SellerCloud** ("PruebaVendedor1-4", "TEST API NO USAR", "Test Uno",
"Cliente Interno" ×2, etc. — está bien que NO estén en la app) y **~23
son clientes con nombre/teléfono real** (ej. Roxana Ortega tel.
`7864779121`, Dadlie Desir tel. `7869560554`, Karla Romero) — estos son
los candidatos genuinos a cruzar contra los timeouts.

**Pendiente, prioridad de la sesión de n8n**: armar el nodo de cierre de
`sync_runs` (el `PATCH` final con los conteos) — sin esto no hay forma de
ver desde la tabla de auditoría cuántos clientes procesó cada corrida
exacta, lo que habría hecho este diagnóstico mucho más directo.

- [x] **`migration-2026-07-17-orders-edit-live-quotes.sql` CORRIDA** (verificado el 2026-08-12 sondeando PostgREST, ver “Auditoría del estado real”;
  `get_quotes_live_pricing` existe y contesta su propio “no autorizado”).
  Lo que hizo (2026-07-17): agrega `admin_audit_log.order_id`, el
  trigger `orders_guard_items_edit` (blinda `items`/`total`/`status`/
  `kind` de `orders`), el helper `compute_order_items` (nuevo cuerpo de
  `create_order`, mismo comportamiento externo) y las RPC
  `update_order_items`/`update_order_status`/`convert_quote_to_order`/
  `get_quotes_live_pricing`. Sin esto: el botón "Editar" de una
  cotización falla, "Convertir en pedido" falla, marcar atendido/
  cancelar/reabrir falla (ahora pasa por `update_order_status`, ya no es
  un `update` directo), y las cotizaciones se ven sin precio en vez de
  mostrar el precio vigente. El frontend (OrdersAdmin, CartDrawer,
  AuditLogAdmin) ya se puede desplegar.
- [x] **`migration-2026-08-04-order-stock.sql` CORRIDA** (verificado el 2026-08-12 sondeando PostgREST, ver “Auditoría del estado real”;
  la columna `orders.stock_applied` existe). Lo que hizo (2026-08-04): agrega `orders.stock_applied`, el trigger
  `products_availability_from_stock` sobre `products`, el helper
  `apply_order_stock`, suma `stock_applied` al trigger
  `orders_guard_items_edit`, y reescribe `update_order_status` /
  `convert_quote_to_order` para mover el stock. **Requiere que
  `migration-2026-07-17-orders-edit-live-quotes.sql` ya esté corrida** —
  reescribe funciones que aquella crea, así que corriéndola sola quedarían
  las versiones nuevas sin el resto de esa tanda. Crea `products.stock` con
  `if not exists`, así que no depende de
  `migration-2026-07-14-inventory-stock.sql` (pero conviene correr esa
  igual: es la que hace que el sync escriba el inventario, y **ya está
  corrida** — ver el ítem de arriba). Sin esta migración el panel de Pedidos
  sigue funcionando, solo no descuenta nada. El frontend ya se puede
  desplegar.
  **El dato de entrada ya existe** (corregido 2026-08-04): el sync de n8n
  está corriendo y mantiene `products.stock` al día, así que el descuento
  tiene de dónde restar desde el momento en que se corra esta migración. Un
  producto con `stock` null es la excepción (nunca sincronizado), no la
  regla — el descuento lo saltea y lo reporta como "sin dato de stock".
- [x] **`migration-2026-08-04-shared-price-lists.sql` corrida** (2026-08-04,
  confirmada el 2026-08-05: el preflight de la migración del superadmin corta si
  `price_list_owners` o sus helpers no existen, y esa corrió bien): reemplaza
  `price_lists.owner_vendedora_id` (una
  sola dueña) por la tabla `price_list_owners` (varias), para poder
  **compartir** una lista entre dos vendedoras. Migra la dueña existente como
  principal, **dropea la columna vieja**, reescribe el trigger
  `clients_enforce_owner_vendedora` / `reassign_client` /
  `update_client_price_list`, y deja las policies de `price_lists` /
  `product_prices` / `price_list_owners`. Requiere
  `migration-2026-07-09-luzmar-owner-link.sql` y
  `migration-2026-07-14-client-admin-actions.sql` ya corridas.
  **Sola no cambia nada funcional** (Luzmar sigue siendo única dueña); para
  compartir hay que correr aparte el `insert` comentado al final del archivo,
  con el nombre de la otra vendedora.
  **Orden obligatorio: esta migración ANTES de desplegar el frontend.**
  `ClientsAdmin.jsx` ya pide `price_list_owners` embebido en el select de
  `price_lists`; si la tabla no existe, `fetchAll` tira error, `load()` lo
  come en silencio y la pestaña Clientes queda sin listas ni clientes.
- [x] **`migration-2026-08-05-superadmin.sql` corrida en producción**
  (2026-08-05, confirmado por el usuario): crea el perfil **superadmin** —
  tabla `superadmins` (RLS sin policies, invisible desde la app) sembrada con
  `support5@firstchoiceonline.com`, `is_superadmin()`, `is_admin()` que lo
  incluye, las policies nuevas de `admins`/`price_list_owners` (escritura solo
  superadmin, lectura admin) y las 12 RPC `sa_*` del panel. Como el archivo
  abre con un preflight que corta si faltan
  `migration-2026-07-14-client-admin-actions.sql` (admin_audit_log) o
  `migration-2026-08-04-shared-price-lists.sql` (price_list_owners + helpers),
  el hecho de que esta haya corrido **confirma indirectamente que esas dos ya
  estaban aplicadas** (ver más arriba). También termina con un
  `raise exception` si el email de la semilla no existe en `auth.users`, así que
  el superadmin quedó efectivamente sembrado.
- [x] **Edge Function `superadmin-users` desplegada** (2026-08-05, confirmado
  por el usuario): `supabase functions deploy superadmin-users`. Es la que
  respalda los dos únicos botones que necesitan la Admin API de Auth
  ("Cambiar contraseña" y "+ Crear admin").
- [x] **`migration-2026-08-06-require-price.sql` corrida** en producción
  (confirmado por el usuario el 2026-08-12; el sondeo con la anon key no podía
  determinarlo porque solo reemplaza cuerpos de funciones, sin huella visible
  desde la API) — un producto sin precio (o con precio 0) deja de salir en el
  catálogo, de cotizarse y de poder pedirse. Reemplaza 6 funciones
  (`get_catalog`, `get_flash_sales`, `compute_order_items`, `create_order`,
  `convert_quote_to_order`, `apply_price_list`) y **no crea ni borra nada**.
  - **Sin orden obligatorio respecto del frontend**: el efecto del catálogo es
    inmediato al correr el SQL (`get_catalog` es server-side), y el frontend de
    esta tanda solo cambia los contadores de la pestaña Precios.
  - Preflight que corta sin tocar nada si falta `apply_price_list`,
    `compute_order_items`, `order_failures` o la firma de `create_order` con
    `p_request_id`: o sea que **necesita `migration-2026-08-05-order-capture.sql`
    corrida antes**, igual que la de métricas.
  - Antes de correrla conviene mirar qué va a esconder (las consultas están al
    final del archivo):
    `select pl.code, p.sku, p.name, pp.price from public.product_prices pp join public.products p on p.id = pp.product_id join public.price_lists pl on pl.id = pp.price_list_id where pp.price <= 0 order by pl.code, p.sku;`
- [x] **`migration-2026-08-06-sa-metrics.sql` CORRIDA** (verificado el 2026-08-12 sondeando PostgREST, ver “Auditoría del estado real”:
  `sa_metrics_overview` existe — devuelve `42501 permission denied`, o sea que
  la función está y anon no tiene `execute`, exactamente el diseño). Lo que hizo
  (2026-08-06) — habilita la pestaña 📈 Métricas. Crea
  `sa_metrics_overview(p_days int default 14)`, los dos helpers de cuentas de
  prueba (`sa_metrics_test_vendedora_patterns` / `sa_is_test_vendedora`, sin
  grant a `authenticated`) y dos índices: `orders_created_idx` y
  `admin_audit_log_order_status_idx` (parcial, `where action =
  'update_order_status'`).
  - **Sin orden obligatorio: el frontend se puede desplegar antes.** Sin la RPC,
    la pestaña muestra el aviso "Falta correr
    migration-2026-08-06-sa-metrics.sql en la base de datos…" en vez de romper
    (detecta el código `PGRST202` de PostgREST), y ninguna otra pestaña se toca.
  - Abre con un **preflight** que corta sin tocar nada si falta
    `is_superadmin()` (`migration-2026-08-05-superadmin.sql`, ya corrida),
    `admin_audit_log` u `order_failures`. Los tres existen ya en producción
    (order-capture verificada el 2026-08-12, ver arriba), así que el preflight
    de esta no debería cortar por ese lado.
  - Es re-corrible (`create or replace` + `create index if not exists`) y no
    modifica ninguna función ni policy existente: solo agrega.
  - Verificación en el SQL Editor (corre como `postgres`, así que `auth.uid()` es
    null y la RPC tira `not authorized` — es lo esperado). Para verla igual,
    suplantando al superadmin:
    `set local role authenticated;`
    `set local request.jwt.claims = '{"sub":"<uuid del superadmin>","role":"authenticated"}';`
    `select jsonb_pretty(public.sa_metrics_overview(14));`
    El uuid sale de `select user_id from public.superadmins;`. Qué cuentas queda
    afuera del cálculo:
    `select name from public.vendedores where public.sa_is_test_vendedora(name);`
- [x] **`migration-2026-08-05-order-capture.sql` CORRIDA** en producción
  (verificado el 2026-08-12 sondeando PostgREST con la anon key: la tabla
  `order_failures` responde y `recover_order_failure(p_failure_id)` existe —
  PostgREST la sugiere en el `hint` del `PGRST202`, lo que solo hace con
  funciones de un parámetro). **Este ítem decía "pendiente y URGENTE" por
  error**; no asumir que el tope de 200 líneas sigue vivo. Lo que hizo: era el
  arreglo del pedido de ~10k que se envió por
  WhatsApp y no quedó registrado. Sube el
  tope de `create_order` de 200 a 1000 líneas, crea `order_failures` (+ RLS +
  `grant select`), agrega `orders.request_id` con índice único parcial, suma
  `request_id` al trigger `orders_guard_items_edit` y crea
  `recover_order_failure`. Dropea la firma vieja de 4 argumentos de
  `create_order` para no dejar una sobrecarga ambigua (PostgREST devolvería 300
  si quedaran las dos).
  - **Orden: el SQL ANTES de desplegar el frontend.** El frontend nuevo manda
    `p_request_id`, que la función vieja no acepta. No se cae si el orden se
    invierte — `CartDrawer.jsx` detecta ese error y reintenta sin el parámetro
    —, pero pierde la idempotencia hasta que corra el SQL.
  - Abre con **preflight** que corta sin tocar nada si falta
    `compute_order_items` (o sea `migration-2026-07-17-orders-edit-live-quotes.sql`)
    o las funciones del rol vendedora. Y crea `orders.stock_applied` /
    `admin_audit_log.order_id` con `if not exists` por si las migraciones del
    07-17 y 08-04 no corrieron: el trigger que reescribe nombra `stock_applied`,
    y sin la columna compilaría igual pero reventaría en el primer `update` a
    `orders` con "record new has no field".
  - Probada contra un PostgreSQL 18 desechable con el schema real (ver la
    bitácora del 2026-08-05 arriba para la lista completa de asserts).
- [x] **Bug preexistente de `schema.sql` corregido** (2026-08-04, encontrado
  al verificar lo de arriba): el archivo **fallaba en una instalación desde
  cero** desde el 2026-07-15, con `ERROR: function public.is_admin() does not
  exist`. Causa: el bloque de RLS de `admin_audit_log` se había mergeado justo
  después de su `create table`, o sea *antes* de la definición de
  `is_admin()` — y una policy sí valida sus funciones al crearse (a
  diferencia de un cuerpo plpgsql, que resuelve en runtime). No se había
  notado porque producción se creó antes de ese merge y nadie volvió a correr
  el archivo completo. Se movió el bloque a la sección "RLS" del final, donde
  vive el resto. Verificado: `schema.sql` corre limpio desde cero **y** dos
  veces seguidas (idempotente).

- [x] **Área de Flash Sales eliminada** (2026-08-07, punto 53): la pestaña del
  panel y la sección con countdown del catálogo. **No requiere migración** —
  la tabla `flash_sales` y `get_flash_sales()` quedan en la base sin uso,
  marcadas como LEGADO en `schema.sql`. Solo hay que **desplegar el frontend**.
  En la misma tanda: carga de Flash Sales por Excel y acciones en bloque de
  etiquetas en Productos, y filtros por grupo de producto en Precios (todo
  frontend, sin SQL).

---


## Auditoría del estado real (2026-08-12)

Comprobado contra la Supabase de producción con la **anon key** (que es pública:
va horneada en el bundle de Vite), **sin escribir nada**. Motivo: la lista de
pendientes de arriba se había equivocado en las dos direcciones — marcaba como
pendiente lo que ya estaba corrido y como corrido lo que no.

**Cómo se comprueba** (reusable, sin service_role ni SQL Editor):

- **Una función**: `POST /rest/v1/rpc/<fn>` con el **nombre real de sus
  parámetros**. `PGRST202` = no existe. `42501 permission denied` o un `P0001`
  propio de la función = **existe**, solo falta el permiso. Usar solo funciones
  de lectura o `immutable` — nunca una que escriba.
- **Una columna**: `GET /rest/v1/<tabla>?select=<col>&limit=1`. `42703` = la
  columna no existe. `[]` = existe y RLS simplemente no devuelve filas.
- **Una Edge Function**: `POST /functions/v1/<nombre>`. `404` = no desplegada;
  `401`/`403` = desplegada y rechazando por falta de JWT.
- ⚠️ **No sirve** el `hint` del `PGRST202`: PostgREST solo sugiere la firma
  cuando la función tiene un parámetro, y ni siquiera siempre
  (`get_quotes_live_pricing(p_order_ids uuid[])` existe y no la sugiere). Con
  ese criterio concluí, mal, que faltaba la de métricas.
- ⚠️ **No sondear `create_order` con un token falso**: eso la ejecuta de verdad
  y deja una fila basura en `order_failures`, que sale como pedido perdido en el
  banner rojo del panel.

**Las 25 migraciones de `supabase/`, en orden cronológico** — esta tabla es la
fuente de verdad del estado de la base; el archivo no tiene ninguna otra
migración (`schema.sql` y `diagnostico-2026-08-12-*.sql` no cuentan).

| Migración | Estado | Evidencia |
|---|---|---|
| `migration-2026-07-09-new-until.sql` | ✅ corrida | 2026-07-09, confirmado por el usuario; `products.new_until` + `is_new` en `get_catalog` |
| `migration-2026-07-09-luzmar-list.sql` | ✅ corrida | 2026-07-09; la lista `luzmar` aparece en el selector de Clientes |
| `migration-2026-07-09-luzmar-admin.sql` | ✅ corrida | 2026-07-09; Luzmar entra al panel con vista admin completa |
| `migration-2026-07-09-luzmar-owner-link.sql` | ✅ corrida | el preflight de `shared-price-lists` la exige y esa corrió |
| `migration-2026-07-10-sellercloud-sync.sql` | ✅ corrida | 2026-07-10, probada a mano con los selects del final del archivo |
| `migration-2026-07-10-sellercloud-sync-v2.sql` | ✅ corrida | `clients.sellercloud_id` existe |
| `migration-2026-07-13-exclude-noncatalog.sql` | ✅ corrida | `sync_is_noncatalog_product('X-SPECIAL','beauty')` → `true` |
| `migration-2026-07-14-inventory-stock.sql` | ✅ corrida | `products.stock` existe |
| `migration-2026-07-14-product-upc.sql` | ✅ corrida | `products.upc` existe |
| `migration-2026-07-14-client-admin-actions.sql` | ✅ corrida | el preflight de `superadmin` exige `admin_audit_log` y esa corrió |
| ~~`migration-2026-07-15-restrict-vendedora-luzmar.sql`~~ | ⛔ nunca se corrió, **no hace falta** | la reemplazó `migration-2026-08-04-shared-price-lists.sql`, que sí está corrida |
| `migration-2026-07-15-order-status-cancelled.sql` | ✅ corrida | confirmado por el usuario (2026-08-12). Desde la API no se veía: solo recrea un CHECK |
| `migration-2026-07-15-vendedora-update-price-list.sql` | ✅ corrida | confirmado por el usuario (2026-08-12). No se sondeó porque la RPC escribe |
| `migration-2026-07-15-fix-duplicate-client-phones.sql` | ✅ corrida | `clients.allow_shared_phone` existe |
| `migration-2026-07-16-cleanup-unlinked-duplicate-clients.sql` | ✅ corrida | 2026-07-16, confirmado por el usuario (borró 86 filas huérfanas) |
| `migration-2026-07-16-reassign-vendedora-mismatches.sql` | ✅ corrida | 2026-07-16, confirmado por el usuario (reasignó 21 clientes) |
| `migration-2026-07-17-apply-price-list.sql` | ✅ corrida | confirmado por el usuario (2026-08-12); además el preflight de `require-price` exige `apply_price_list` y esa corrió |
| `migration-2026-07-17-orders-edit-live-quotes.sql` | ✅ corrida | `get_quotes_live_pricing` → `P0001 no autorizado` |
| `migration-2026-08-04-order-stock.sql` | ✅ corrida | `orders.stock_applied` existe |
| `migration-2026-08-04-shared-price-lists.sql` | ✅ corrida | el preflight de `superadmin` exige `price_list_owners` + helpers y esa corrió |
| `migration-2026-08-05-superadmin.sql` | ✅ corrida | 2026-08-05, confirmado por el usuario; la pestaña 🔐 Superadmin funciona |
| `migration-2026-08-05-order-capture.sql` | ✅ corrida | `order_failures` responde, `orders.request_id` existe, `recover_order_failure` existe |
| `migration-2026-08-06-sa-metrics.sql` | ✅ corrida | `sa_metrics_overview` → `42501` (existe, anon sin `execute`) |
| `migration-2026-08-06-require-price.sql` | ✅ corrida | confirmado por el usuario (2026-08-12). Desde la API no se veía: solo reemplaza cuerpos de funciones |
| `migration-2026-08-12-hide-out-of-stock.sql` | ✅ corrida | el sondeo de la mañana dio `products.deactivated_by_stock` → `42703`; el usuario la corrió ese mismo día y lo confirmó |

**✅ Cierre (2026-08-12): no queda ninguna migración pendiente.** El sondeo con
la anon key dejó una sola pendiente confirmada
(`migration-2026-08-12-hide-out-of-stock.sql`) y tres sin determinar; el usuario
corrió la primera y confirmó las otras tres el mismo día. La única que sigue sin
correr es `restrict-vendedora-luzmar`, y está bien así: quedó reemplazada.

Si en el futuro hay que volver a verificar los tres que la API no muestra, es en
el SQL Editor:
`select pg_get_functiondef('public.create_order(text,jsonb,numeric,text,uuid)'::regprocedure);`
(si el cuerpo pide `pp.price > 0`, require-price está corrida),
`select pg_get_constraintdef(oid) from pg_constraint where conname like 'orders_status%';`
(si acepta `'cancelled'`, la del 07-15 está corrida) y
`select 'public.update_client_price_list(uuid,uuid)'::regprocedure;` (si tira
error, no existe).

**Nota aparte, sin confirmar**: la Edge Function `superadmin-users` devolvió
`404` donde `admin-create-vendedora-user` devuelve `403`, lo que sugiere que no
está desplegada — pero contradice lo que el usuario confirmó el 2026-08-05, así
que puede ser una limitación del sondeo. Vale revisarlo con
`supabase functions list` antes de sacar conclusiones.

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
    ├── i18n.jsx                ← diccionario es/en + LanguageProvider + useI18n (t(key, vars) interpola {placeholders} desde 2026-08-06)
    ├── lib/
    │   └── supabase.js         ← cliente Supabase (vars de entorno)
    ├── context/
    │   └── CartContext.jsx     ← carrito en memoria + localStorage
    ├── components/
    │   ├── Header.jsx          ← logo, nombre cliente, buscador, selector de idioma, botón carrito (desktop) — sticky junto con FilterBar (ver Catalog.jsx)
    │   ├── FilterBar.jsx       ← chips de categoría/línea/disponibilidad (2026-07-09, extraído de Catalog.jsx)
    │   ├── ProductCard.jsx     ← tarjeta con precio y botón agregar (memoizada)
    │   ├── ProductImage.jsx    ← imagen con fallback emoji
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
    │       ├── AuditLogAdmin.jsx
    │       ├── OrdersAdmin.jsx
    │       ├── SuperAdminPanel.jsx  ← solo superadmin (usuarios/roles/contraseñas + dueñas de listas)
    │       └── MetricsAdmin.jsx     ← solo superadmin (KPIs en vivo por polling + gráfico SVG + adopción por vendedora)
    └── utils/
        ├── format.js           ← money(), cleanPhone()
        ├── whatsapp.js         ← buildOrderMessage(), whatsappUrl()
        ├── pdf.js              ← downloadOrderPdf() (async, jsPDF lazy)
        ├── token.js            ← generateToken() con crypto.getRandomValues
        └── excel.js            ← parseSheet(), normalizeHeader(), pick(), downloadOrderExcel(), downloadAuditLogExcel(), downloadMetricsExcel() (XLSX lazy)
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
| `price_list_owners` | Dueñas de una lista de precio (2026-08-04, `migration-2026-08-04-shared-price-lists.sql` — **reemplaza** a la columna `price_lists.owner_vendedora_id` de 2026-07-09, que se dropeó). PK `(price_list_id, vendedora_id)`, así que una lista puede tener **varias** dueñas: sin filas = lista general (la usa cualquier vendedora), una fila = lista personal (comportamiento idéntico al de antes), varias = lista **compartida** (solo esas vendedoras la ven, y cada cliente queda con una de ellas). `is_primary` (índice único parcial: una sola por lista) marca la dueña por defecto — la que se asigna cuando un cliente entra a la lista con una vendedora que no es dueña. RLS: admin todo; una vendedora solo lee las filas de las listas que puede usar, y desde 2026-08-05 la escritura es **solo del superadmin** (antes era `admin_all`), desde la pestaña 🔐 Superadmin |
| `clients` | Clientes con token único, lista asignada y `vendedora_id` (FK a `vendedores`). Desde la v2 del sync (2026-07-10): `sellercloud_id` (integer unique nullable, el General.ID de SellerCloud — llave del sync automático; null en clientes cargados a mano/Excel) y `price_list_id` pasó a ser **nullable** (los clientes nuevos del sync entran sin lista; un cliente sin lista ve catálogo vacío y no puede pedir hasta que se la asignen a mano) |
| `vendedores` | Nombre + teléfono de cada vendedora (2026-07-06; antes texto libre en `clients`). Desde el rol vendedora (2026-07-06): `user_id` (FK a `auth.users`, nullable, único) + `login_email` (solo display) para vincular su login |
| `products` | Catálogo de productos (`availability`: 'available' \| 'preorder' \| 'flash', este último desde 2026-07-08 — etiqueta "Flash Sale" del Excel de inventario, sin relación con la tabla `flash_sales`). `product_line` (2026-07-08, texto libre, nullable): tipo real del perfume desde `PRODUCT_CATEGORY` del export SellerCloud (`Perfume` / `Perfume - Arabes`), **distinto** de `category` que acá guarda la marca/Brand. `new_until` (2026-07-09, timestamptz nullable): mientras `now() < new_until` el producto lleva la etiqueta ✨ Nuevo en catálogo y admin; se setea automático (+10 días) al crear el producto y es editable en el formulario. `stock` (2026-07-14, int nullable, `migration-2026-07-14-inventory-stock.sql`): InventoryAvailableQTY de SellerCloud — **no** se expone en el catálogo del cliente (`get_catalog` no lo incluye), solo visible en el admin. Decide la disponibilidad en cada carga/sync (`>= 1` available, `0`/negativo preorder, respetando flash); NO toca `active`. null = "todavía no se sabe el stock" (distinto de 0 = sin stock). **Desde 2026-08-04 esa regla vive en un trigger de la tabla** (`products_availability_from_stock`, `migration-2026-08-04-order-stock.sql`) y no solo en cada camino de escritura: cualquier insert/update con `stock` no-null y `availability <> 'flash'` deja `availability` derivada del stock, venga del sync, del Excel, del bulk, del formulario, del descuento de un pedido atendido o de un request directo. Eso además tapó un agujero real: `apply_price_list` ponía `availability = 'available'` a todos los productos de un Excel de precios sin columna `Type`, con stock 0 incluido. El `stock` también **baja solo** al marcar un pedido Atendido (ver `apply_order_stock`) y es editable a mano en el formulario de la pestaña Productos. `deactivated_by_stock` (2026-08-12, boolean not null default false, `migration-2026-08-12-hide-out-of-stock.sql`): desde esa fecha el trigger no solo pone la etiqueta, también **despublica** — `stock <= 0` deja el producto en `preorder` **y** `active = false`, así que sale del catálogo (revierte a propósito media decisión del 2026-07-14: "stock 0 se muestra como pre-order, ocultarlo es manual"). La columna **no** es "está sin stock" (eso ya lo dice `stock`) sino "esta regla fue la que lo apagó", y es lo único que permite reactivarlo solo cuando entre stock sin resucitar de paso lo que apagó una persona ni la exclusión de no-catálogo (SKU `-SPECIAL`, beauty/electronics/support/packing/test), que tienen stock de sobra. Invariante: `true` = inactivo por falta de stock, vuelve solo con `stock >= 1`; `false` = si está inactivo lo apagó una persona y solo una persona lo reactiva. Un producto `flash` con stock 0 conserva la etiqueta 🔥 pero **también** se despublica (la etiqueta no publica nada). Quién borra la bandera a propósito, porque es decisión humana: el botón Desactivar (fila o selección) del panel, la columna `Activo` del Excel de productos, y el UPDATE de `apply_price_list` que desactiva lo que quedó fuera del archivo. `upc` (2026-07-14, text nullable, `migration-2026-07-14-product-upc.sql`): código de barras, dato interno del admin (**no** lo expone `get_catalog`), visible/editable en la pestaña Productos y buscable |
| `product_prices` | Precio por producto+lista (clave compuesta) |
| `flash_sales` | **LEGADO desde 2026-08-07**: ofertas con precio promo + fecha de expiración. La app ya no la lee (se eliminó la pestaña Flash Sales y la sección del catálogo). No se borró nada: la tabla y sus datos siguen ahí, sin migración de por medio, así que volver atrás es reponer código. `compute_order_items` todavía la consulta para revalorizar una línea vieja marcada `flash` de un pedido anterior — sin ofertas vigentes cae al precio de lista, que es lo correcto |
| `orders` | Pedidos del checkout — fuente de verdad (precios recalculados en el servidor) con `status` 'new' \| 'done' \| 'cancelled'. `stock_applied` (2026-08-04, boolean not null default false, `migration-2026-08-04-order-stock.sql`): ¿este pedido ya descontó su stock? Marcar Atendido descuenta las cantidades de `products.stock`, reabrir/cancelar las devuelve, y esta bandera — **no** el estado — es la que evita el doble descuento (un pedido puede ir done → new → done varias veces). `request_id` (2026-08-05, uuid nullable + índice único **parcial** `where request_id is not null`, `migration-2026-08-05-order-capture.sql`): identifica al **carrito**, no al envío — `CartContext` lo genera una vez y lo rota al vaciar el carrito, así reintentar un envío que falló devuelve el pedido ya guardado en vez de duplicarlo. Null en los pedidos previos al cambio y en los que llegan de un frontend sin actualizar (de ahí que el índice sea parcial). Las dos columnas están blindadas por el trigger `orders_guard_items_edit` igual que `items`/`total`/`status`/`kind` |
| `order_failures` | **Los pedidos que el cliente envió y NO entraron** (2026-08-05, `migration-2026-08-05-order-capture.sql`). Existe porque un pedido de ~10k se perdió sin dejar rastro: `create_order` lo rechazó con un `return null` mudo (superaba el tope de líneas de entonces, 200) y el único registro del rechazo era un `console.warn` en el teléfono del cliente. Guarda `client_id` (nullable, `on delete set null`), `token_hint` (los primeros 8 caracteres, para rastrear sin guardar la credencial completa), `reason` (texto legible: 'token inválido' \| 'payload vacío o mal formado' \| 'demasiadas líneas: N (el tope es 1000)' \| 'ningún ítem válido…'), `line_count`, `kind`, `items` (el payload, **solo si el token era válido** — con token inválido se guarda nada más el motivo y el conteo, para que nadie con la anon key infle la tabla) y `recovered_order_id` (FK a `orders`, null = sin recuperar, que es lo que muestra el aviso de `OrdersAdmin.jsx`). RLS de **solo lectura**, mismo criterio que `admin_audit_log`: admin todo, vendedora los de sus propios clientes, `anon` nada, y sin policy de insert/update/delete para nadie — solo la escribe `create_order` (SECURITY DEFINER). El `grant select to authenticated` es explícito y no heredado de los default privileges de Supabase |
| `admins` | user_id de Supabase Auth autorizados como admin. Desde 2026-08-05 la **escribe solo el superadmin** (policies `superadmin_all` + `admin_read_only`; antes tenía `admin_all`, o sea que cualquier admin podía nombrar admins vía API aunque no hubiera UI) |
| `superadmins` | El perfil superadmin (2026-08-05, `migration-2026-08-05-superadmin.sql`): `user_id` + `created_at`, sembrada con `support5@firstchoiceonline.com`. **RLS activo y CERO policies** — desde la app no existe para nadie, ni para el propio superadmin; solo la leen las funciones SECURITY DEFINER y el SQL Editor. Tabla aparte y no una columna en `admins` justamente porque `admins` era escribible por cualquier admin: la marca de "llave maestra" no puede vivir en una tabla que el resto puede tocar. Sumar/quitar superadmins es a propósito solo por SQL |
| `sync_runs` | Auditoría del sync SellerCloud→Supabase vía n8n (2026-07-10, `migration-2026-07-10-sellercloud-sync.sql`): `started_at`/`finished_at`, `status` 'running' \| 'ok' \| 'error', contadores `rows_products`/`rows_prices`/`rows_clients`, `error_detail`. n8n la escribe directo con la service_role key (salta RLS); admins solo lectura |
| `admin_audit_log` | Auditoría de acciones sensibles (2026-07-14, `migration-2026-07-14-client-admin-actions.sql`; suma `update_price_list` 2026-07-15, `edit_order_items`/`update_order_status`/`convert_quote_to_order` 2026-07-17, y `recover_order_failure` 2026-08-05): `action` ('reassign_client' \| 'delete_client' \| 'update_price_list' \| 'edit_order_items' \| 'update_order_status' \| 'convert_quote_to_order' \| 'recover_order_failure' \| las `sa_*` del superadmin), `performed_by`/`performed_by_email` (quién), `client_id`/`client_name` (snapshot del cliente dueño del pedido/acción), `order_id` (2026-07-17, nullable, SIN FK por el mismo motivo que `client_id` — sobrevive si el pedido se borra a futuro), `detail` jsonb, `created_at`. Solo lectura para admin (RLS); la escriben solo las RPC `reassign_client`/`delete_client`/`update_client_price_list`/`update_order_items`/`update_order_status`/`convert_quote_to_order`/`recover_order_failure`/`sa_log` |

### Listas de precio sembradas por el schema

| code | label |
|---|---|
| `us_min` | US Minimum Order ($800+) |
| `us_wholesale` | US Wholesale ($2,000+) |
| `ve_min` | VE Minimum Order |
| `ve_wholesale` | VE Wholesale |
| `special` | Special Order ($15,000+, **cualquier región**, precio fijo real) |
| `quote` | Cotización (sin precio) — catálogo completo sin precio, ver más abajo |
| `luzmar` | Luzmar - Precio Especial (2026-07-09, lista exclusiva de Luzmar Quintero, sin lógica especial — precio real como cualquier otra lista) |

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
- Filtra por `p.active`, que desde 2026-08-12 también deja afuera **lo que se
  quedó sin stock**: el trigger `products_availability_from_stock` desactiva
  cualquier producto con `stock <= 0` (ver la tabla `products`). No hizo falta
  tocar esta función para eso — es justamente la ventaja de que la regla viva en
  la tabla.
- **No expone el SKU** (es interno).
- Devuelve (mismo contrato JSON de siempre; `vendedora`/`vendedora_phone`
  se resuelven ahora con un join a `vendedores` en vez de leerse directo
  de `clients`; `is_quote_only` es nuevo, 2026-07-08, y es un booleano
  calculado — `price_list_code = 'quote'` — no una columna de `clients`):
  ```json
  {
    "client": { "name", "vendedora", "vendedora_phone", "price_list_code", "is_quote_only" },
    "products": [ { "id", "name", "category", "product_line", "image_url", "availability", "price" } ]
  }
  ```
  `product_line` se agregó 2026-07-08 (junto con la columna en `products`).
- Si la lista resuelta del cliente tiene `code = 'quote'`, ignora
  `product_prices` por completo: devuelve **todos** los productos activos
  con `price: null` siempre (catálogo de cotización, ver "Base de datos"
  más arriba).

### `get_flash_sales() → jsonb`
- **LEGADO desde 2026-08-07: sin llamadores.** El catálogo dejó de pedirla al
  eliminarse la sección de ofertas con countdown. Sigue creada (y con sus
  grants) por si hubiera que volver atrás; ver la nota de la tabla
  `flash_sales`.
- Acceso: `anon` y `authenticated`. Sin token.
- Devuelve solo las ofertas activas con `starts_at <= now() < expires_at`.

### `create_order(p_token, p_items, p_total, p_kind, p_request_id) → uuid`
- Acceso: `anon` y `authenticated`.
- Valida el token; si es inválido devuelve `null` sin explicar nada al cliente
  (pero desde 2026-08-05 **sí queda registrado** en `order_failures`).
- **Los precios y el total se recalculan en el servidor** con la lista del
  cliente y las flash sales vigentes (fallback a precio de lista si la
  oferta expiró). Del payload solo se usan `id`, `qty` y `flash` de cada
  ítem; `p_total` se ignora (se mantiene en la firma por compatibilidad).
- Límites: **máx. 1000 líneas** (era 200 hasta 2026-08-05), qty 1–9999; ítems
  malformados o de productos inactivos se descartan sin tumbar el pedido. Si no
  sobrevive ninguno → `null`.
- **2026-08-05 — el arreglo del pedido que se perdió.** Un pedido de ~10k se
  envió por WhatsApp y no apareció en el sistema, dos veces seguidas: superaba
  las 200 líneas y esta función lo rechazaba con un `return null` mudo mientras
  el frontend abría WhatsApp igual y mostraba el ✓. Que otros pedidos más
  **caros** sí entraran fue lo que despistó: el tope nunca fue por monto sino
  por cantidad de líneas distintas (muchas referencias × 1–2 unidades vs. pocas
  referencias × mucha cantidad). Tres cambios:
  - Tope a 1000 líneas. No más, porque `compute_order_items` crece superlineal
    (medido: 48 ms con 200 líneas, 232 ms con 500, 651 ms con 1000, 2.4 s con
    2000, 9.8 s con 4000 — el acumulador `v_items || ...` copia el jsonb entero
    en cada vuelta) y pasando las ~2000 se choca con el `statement_timeout` del
    rol `anon`: sería el mismo fallo silencioso por otra puerta.
  - **Todo `return null` deja fila en `order_failures`** con el motivo, la
    cantidad de líneas y el payload (el payload solo si el token era válido;
    con token inválido se guarda únicamente motivo y conteo, para que nadie con
    la anon key infle la tabla).
  - `p_request_id` (uuid, opcional) hace **idempotente** el alta: se guarda en
    `orders.request_id` (índice único parcial) y un segundo intento con el mismo
    valor devuelve el pedido ya creado en vez de duplicarlo. `CartContext`
    genera uno por carrito y lo rota al vaciarlo. También cubre la carrera de
    dos envíos simultáneos: el índice deja pasar uno y el `unique_violation` se
    captura para devolver ese mismo pedido. Omitirlo sigue funcionando (un
    frontend sin actualizar manda 3 o 4 argumentos y el default es `null`).
- `p_kind`: `'order'` o `'quote'`, tal cual lo pida el caller (por defecto
  `'order'`), **salvo que la lista del cliente sea `'quote'`**: en ese caso
  el servidor fuerza `kind = 'quote'` y nunca calcula precio para ningún
  ítem, sin importar lo que mande el navegador (2026-07-08). Pedidos viejos
  con `kind = 'quote'` (de cuando Special era cotización) siguen
  mostrándose como tal en `/admin/orders`.
- Los ítems guardados incluyen el SKU real del producto (solo visible en el admin).
- Devuelve el `id` del pedido creado; el frontend (`CartDrawer`) revisa el
  retorno y avisa al cliente si el registro falló (WhatsApp sale igual). Desde
  2026-08-05 ese aviso **no se puede pasar por alto**: el carrito NO se vacía,
  el drawer muestra un bloque rojo con "Reintentar registro" y el pedido sigue
  ahí. Antes era una línea ámbar dentro del acuse de ✓ con el carrito ya vacío
  — nadie la leía y el pedido se perdía.
- 2026-07-17: `CartDrawer` también la llama con `p_kind: 'quote'` al
  descargar el PDF desde el carrito (antes solo lo hacía el checkout por
  WhatsApp) — así toda solicitud de PDF queda registrada como cotización
  en `/admin/orders`, sin bloquear la descarga si el guardado falla.
- 2026-07-17: el cuerpo de cálculo de precios se factorizó al helper
  `compute_order_items(p_client_id, p_items, p_kind)` (mismo
  comportamiento externo de `create_order`, sin cambios de firma), para
  reusarlo en `update_order_items` y `get_quotes_live_pricing` de abajo.

### `compute_order_items(p_client_id uuid, p_items jsonb, p_kind text) → jsonb`
- Acceso: ninguno (revoke a public; sin grant a anon/authenticated).
  Helper interno (2026-07-17) — solo lo llaman `create_order`,
  `update_order_items` y `get_quotes_live_pricing`, todas SECURITY
  DEFINER del mismo dueño.
- Recalcula `{items, total}` para una lista de `{id, qty, flash}`: precio
  de flash sale vigente si `flash`, si no precio de lista del cliente —
  **nunca** si `p_kind = 'quote'` (una cotización jamás congela precio,
  se recalcula siempre al vuelo, ver `get_quotes_live_pricing`).
- **Busca el producto con `(active or deactivated_by_stock)`** (2026-08-12): una
  línea cuyo producto no se encuentra se descarta **en silencio** (`continue`), y
  desde esa fecha quedarse sin stock desactiva. Sin esa condición, el cliente que
  manda el pedido dos minutos después de que el sync bajó el stock a 0 perdería
  esa línea sin que nadie se entere. Lo que salió del catálogo por falta de stock
  se puede pedir igual (es un pre-order, y el carrito ya avisa que la
  disponibilidad la confirma la asesora); lo que apagó una persona, no. Para
  volver atrás alcanza con sacar el `or p.deactivated_by_stock`.

### `update_order_items(p_order_id uuid, p_items jsonb) → jsonb`
- Acceso: solo `authenticated`. (2026-07-17, a pedido del usuario: una
  vendedora puede corregir una cotización ya recibida sin pedirle al
  admin que entre a la base.)
- Permiso: admin siempre; vendedora solo si el pedido es de uno de sus
  propios clientes (si no, `raise exception`).
- **Solo cotizaciones** (`kind = 'quote'`) **y solo mientras siguen
  `new`**: rechaza si `kind = 'order'` ("solo se pueden editar
  cotizaciones") o si `status <> 'new'` ("solo se pueden editar
  cotizaciones nuevas") — ajuste del mismo día a pedido del usuario,
  sobre una primera versión que permitía editar cualquier pedido no
  cancelado. Un pedido real ya confirmado no se toca desde acá; para
  eso existe `convert_quote_to_order` (abajo), que congela precio recién
  en ese momento.
- Recalcula ítems/total con `compute_order_items` (mismo criterio que
  `create_order`: una cotización sigue sin congelar precio al editarla).
- Audita antes/después en `admin_audit_log` (acción `edit_order_items`,
  `detail` con `before_items`/`before_total`/`after_items`/`after_total`)
  **antes** de escribir el pedido — no hay forma de que la edición pase
  sin dejar rastro.
- El trigger `orders_guard_items_edit` en `orders` bloquea cualquier
  `update` directo que cambie `items`/`total`/`status`/`kind` sin pasar
  por esta función (o por `update_order_status`/`convert_quote_to_order`
  de abajo — la que corresponda habilita la escritura con
  `set_config('app.allow_order_edit', 'on', true)`, transacción-local) —
  sin este trigger, la policy `vendedora_update_own_orders` (pensada solo
  para que una vendedora marque su propio pedido atendido/nuevo) también
  le hubiera permitido tocar cualquiera de esas 4 columnas directo, sin
  auditar.

### `apply_order_stock(p_order_id uuid, p_direction int) → jsonb`
- Acceso: ninguno (revoke a public; sin grant a anon/authenticated).
  Helper interno (2026-08-04, `migration-2026-08-04-order-stock.sql`) —
  solo lo llaman `update_order_status` y `convert_quote_to_order`, ambas
  SECURITY DEFINER del mismo dueño (mismo patrón que
  `compute_order_items`).
- `p_direction`: `-1` descuenta (pedido marcado Atendido), `1` devuelve
  (reabierto o cancelado). Cualquier otro valor → `raise exception`.
- **Suma las cantidades por producto antes de tocar el stock**: un pedido
  puede traer el mismo producto en dos líneas (la clave del carrito es
  `id+flash`: una de oferta y otra a precio de lista) y sin agrupar el
  segundo update pisaría al primero. Descarta ítems malformados (filtro de
  formato de uuid/qty) sin tumbar el cambio de estado del pedido.
- **No toca los productos con `stock` null** (nunca sincronizados: no se
  puede restar de un dato que no existe) ni los que ya no existen — los
  devuelve en `skipped` con el motivo, para que el panel lo muestre.
- **No calcula la disponibilidad**: la deriva el trigger
  `products_availability_from_stock`, así el resultado es idéntico venga el
  cambio de stock de donde venga. Un producto que llega a 0 pasa a
  Pre-Order solo; cuando vuelve a entrar stock, vuelve a Disponible solo.
  **Desde 2026-08-12 el que llega a 0 además se despublica** (queda inactivo con
  `deactivated_by_stock = true`) y **vuelve al catálogo solo** al devolverse el
  stock — o sea que reabrir o cancelar un pedido deshace las dos cosas, no solo
  la etiqueta.
- El stock puede quedar **negativo** si el pedido supera lo disponible (ej.
  −5) — también es Pre-Order, y así queda registro de lo que se debe.
- Devuelve `{direction, moved:[{product_id, sku, qty, stock_before,
  stock_after, availability}], skipped:[{product_id, sku, qty, reason}]}`,
  que las dos RPC de arriba guardan en `admin_audit_log.detail->'stock'`.

### `update_order_status(p_order_id uuid, p_status text) → jsonb`
- Acceso: solo `authenticated`. (2026-07-17, a pedido del usuario: antes
  "Marcar atendido"/"Cancelar"/"Reabrir" hacían un `update` directo sin
  dejar rastro.)
- Permiso: admin siempre; vendedora solo sus propios pedidos.
  `p_status` debe ser `'new'`/`'done'`/`'cancelled'`, si no
  `raise exception`. No-op (sin auditar) si el estado no cambia.
- **Mueve el stock** (2026-08-04, a pedido del usuario) vía
  `apply_order_stock`, **solo si `kind = 'order'`**: pasar a `'done'` sin
  `stock_applied` descuenta y prende la bandera; salir de `'done'` con la
  bandera prendida devuelve y la apaga. Una cotización nunca mueve
  inventario (decisión del usuario: si no, un cliente bajando 5 PDF
  mientras mira el catálogo vaciaría el stock solo — para que descuente hay
  que pasarla a pedido con `convert_quote_to_order`).
- Audita el cambio (`update_order_status`, `detail` con
  `from_status`/`to_status`, más `stock` con el movimiento cuando hubo
  uno). Devuelve `{ok, status, stock_applied, stock}`.
- La llama `OrdersAdmin.jsx` después de que el usuario confirma en el
  modal "¿Confirmás esta acción?" (2026-07-17, a pedido del usuario) —
  ya no se aplica con un solo click. El modal avisa qué va a pasar con el
  stock antes de aplicar, y la fila muestra el resultado después
  (2026-08-04; hasta entonces un error de esta RPC se descartaba en
  silencio, ahora se muestra inline).

### `convert_quote_to_order(p_order_id uuid) → jsonb`
- Acceso: solo `authenticated`. (2026-07-17, a pedido del usuario: una
  cotización se puede cerrar como pedido real.)
- Permiso: admin siempre; vendedora solo sus propios pedidos. Rechaza si
  `kind <> 'quote'`, si `status = 'cancelled'`, o si la lista de precio
  del cliente sigue siendo `'quote'` (no hay precio real que congelar —
  primero hay que asignarle una lista real).
- A diferencia de una cotización (que nunca congela precio, ver
  `get_quotes_live_pricing`), acá **sí** se congela: recalcula con
  `compute_order_items(..., 'order')` contra la lista de precio real del
  cliente y guarda `kind = 'order'` con ese precio — desde ese momento ya
  no se sigue ajustando a cambios de precio futuros.
- **Borde de stock** (2026-08-04): convertir por sí solo NO descuenta — el
  camino normal es cotización nueva → pedido nuevo → Atendido, y el
  descuento pasa en `update_order_status`. La excepción es una cotización
  que ya estaba marcada Atendida: como una cotización nunca descuenta, al
  pasar a pedido real el descuento tiene que ocurrir acá mismo (si no, ese
  pedido quedaría `done` sin haber descontado nunca). Lee los ítems ya
  guardados porque la conversión recalcula precios, no productos ni
  cantidades.
- Audita la conversión (`convert_quote_to_order`, `detail` con
  `items`/`total` resultantes, más `stock` si hubo movimiento). Devuelve
  `{items, total, stock_applied, stock}`.

### `recover_order_failure(p_failure_id uuid) → jsonb`
- Acceso: solo `authenticated`; exige `is_admin()` **o** `is_vendedora()`
  adentro, y una vendedora solo puede recuperar los fallos de sus propios
  clientes (2026-08-05, `migration-2026-08-05-order-capture.sql`).
- Rescata un pedido que el cliente envió y no entró (fila de
  `order_failures`), **sin pedirle que lo rearme**: toma los ítems guardados y
  los inserta como pedido de ese mismo cliente. Los precios se recalculan con
  la lista **vigente** vía `compute_order_items`, no con los que veía cuando lo
  armó.
- Rechaza con mensaje claro: fallo inexistente, ya recuperado
  (`recovered_order_id` no nulo), sin `client_id`/`items` (fue token inválido,
  no hay con qué), cliente borrado, ningún producto sigue activo, o más de 2000
  líneas (tope más alto que el de `create_order` porque un admin decidiendo a
  mano no es un payload sospechoso, pero no infinito: arriba de eso
  `compute_order_items` tarda más que el `statement_timeout` y la recuperación
  fallaría a mitad — hay que partir el pedido en dos).
- Marca la fila con `recovered_order_id` y audita en `admin_audit_log`
  (`recover_order_failure`, con el motivo original y los ítems resultantes).
  Devuelve `{ok, order_id, total, lines}`.
- La llama el aviso rojo de `OrdersAdmin.jsx` (botón "Recuperar").

### `get_quotes_live_pricing(p_order_ids uuid[]) → jsonb`
- Acceso: solo `authenticated`. (2026-07-17.)
- Devuelve `{order_id: {items, total}}` con el precio **vigente** (no el
  guardado) de cada ítem de los pedidos `kind = 'quote'` de la lista
  recibida — así una cotización se ajusta sola a cambios de precio
  posteriores. Pedidos que no son cotización o que el caller no tiene
  permiso de ver (admin siempre; vendedora solo las suyas) se omiten del
  resultado en vez de tirar error, para poder pedir varias de una sola
  vez sin que una ajena tumbe el resto.
- La llama `OrdersAdmin.jsx` una vez al cargar la bandeja (bulk, todas
  las cotizaciones visibles) y de nuevo para un solo pedido después de
  editarlo.

### `is_admin() → boolean`
- Acceso: solo `authenticated`.
- Comprueba si `auth.uid()` está en `admins` **o es superadmin** (2026-08-05).
  Usada en las políticas RLS. La segunda mitad es para que el superadmin no
  pueda quedarse afuera del panel ni borrándose a sí mismo de `admins` con el
  botón nuevo.

### `is_superadmin() → boolean`
- Acceso: solo `authenticated`. (2026-08-05,
  `migration-2026-08-05-superadmin.sql`.)
- `auth.uid()` está en `superadmins`. SECURITY DEFINER: la tabla no es legible
  desde la app (RLS sin policies), así que esta función es la única forma de
  preguntarlo. La llaman `AdminLayout.jsx` (para armar la pestaña y cortar la
  ruta), la Edge Function `superadmin-users` (con el JWT de quien llama) y todas
  las RPC `sa_*`.

### `sa_*` — RPC del panel Superadmin (2026-08-05)
- Acceso: `authenticated`, pero **todas exigen `is_superadmin()` adentro** y
  tiran `raise exception 'solo el superadmin puede…'` si no. Ocultar la pestaña
  es UI; el límite real es este.
- Todas auditan en `admin_audit_log` vía `sa_log(action, target, detail)`
  (interna, sin grant a `authenticated`), que guarda el **objetivo** de la
  acción en `client_name` — email del usuario o nombre de la lista. De ahí que
  la pestaña Registro de movimientos titule esa columna "Cliente / objetivo".
- Usuarios: `sa_list_users()` (lee `auth.users`, que no es legible desde el
  cliente: email, rol, vendedora vinculada, alta y último acceso; omite los
  borrados), `sa_set_admin(user_id, bool)` (rechaza quitarle el admin a un
  superadmin y tocar un usuario borrado), `sa_register_new_admin(user_id)` y
  `sa_log_password_change(user_id)` — estas dos las llama la Edge Function
  después de hacer su parte con la Admin API de GoTrue. La contraseña nunca
  pasa por Postgres.
- Listas: `sa_price_list_overview()` (por lista: dueñas, clientes, precios
  cargados, y **cuántos clientes quedaron con una vendedora que no es dueña** —
  los conteos server-side porque `product_prices` pasa las 20,000 filas),
  `sa_add_price_list_owner(list, vendedora, is_primary)` (la primera dueña
  siempre entra como principal; si se pide principal, baja la anterior antes por
  el índice único parcial), `sa_remove_price_list_owner` (si se va la principal
  y quedan dueñas, promueve a la más antigua), `sa_set_primary_price_list_owner`,
  `sa_sync_price_list_clients(list)` (pasa a la dueña principal los clientes
  colgados — la versión auditada del UPDATE que la migración de listas
  compartidas dejaba comentado para correr a mano; idempotente),
  `sa_create_price_list(code, label)` (valida `^[a-z][a-z0-9_]{1,30}$`,
  normaliza a minúsculas), `sa_update_price_list(id, label)` (**solo el nombre
  visible**: el `code` lo lee código real —`quote`/`special` en get_catalog, los
  alias de `PricesUpload.jsx`— y renombrarlo rompería esos caminos en silencio;
  audita como `update_price_list_label`, no como `update_price_list`, que ya
  significa otra cosa) y `sa_delete_price_list(id)` (solo listas que no siembra
  `schema.sql` — `sa_protected_price_list_codes()` — y solo si no tienen
  clientes, precios ni dueñas; sin cascada a propósito).
- **Al probarlas en el SQL Editor**: corre como `postgres`, así que `auth.uid()`
  es null, `is_superadmin()` da false y todas tiran la excepción. Es lo
  esperado: se prueban desde el panel, logueado.

### `sa_metrics_overview(p_days int default 14) → jsonb` (2026-08-06)
- Acceso: `authenticated`, con `is_superadmin()` como **primera línea**
  (`raise exception 'not authorized'`). Es la RPC de la pestaña 📈 Métricas y la
  **única `sa_*` que no llama a `sa_log()`**: es de solo lectura y el panel la
  llama cada 60 s — auditarla dejaría una fila por minuto por pestaña abierta.
- Devuelve **todo lo que dibuja la pestaña en un solo `jsonb`**, porque son 7
  consultas distintas y desde el frontend serían 7 round-trips por refresco:
  - `period` → `{ days, from, to }`. `p_days` se clampea a `[1, 365]`
    (`coalesce(p_days, 14)`), así un valor a mano no genera un
    `generate_series` gigante.
  - `totals` → `pedidos`, `cotizaciones`, `vendedoras_activas`,
    `monto_capturado`, `ticket_promedio`, `cancelados`. Convenciones usadas en
    todas las secciones: **pedido** = `kind = 'order' and status <> 'cancelled'`,
    **cotización** = `kind = 'quote'`, **cancelado** = `kind = 'order' and
    status = 'cancelled'`. Un cancelado no suma monto ni cuenta como pedido.
  - `por_vendedora` → `[{ vendedora, pedidos, monto, ticket, cotizaciones }]`
    ordenado por monto desc (desempate por nombre, para que la tabla no
    "parpadee" entre refrescos). Agrupa por **nombre** (hay un único índice sobre
    `lower(name)`), así el grupo de los pedidos **sin vendedora** sale con
    `vendedora: null` y la suma de la columna monto cuadra exactamente con
    `totals.monto_capturado`.
  - `tiempo_a_atender_horas` → promedio de horas desde `orders.created_at` hasta
    la **primera** vez que el pedido llegó a `done`: `min(created_at)` por
    `order_id` sobre `admin_audit_log` con `action = 'update_order_status'` y
    `detail->>'to_status' = 'done'`. `min` y no el último porque un pedido puede
    ir done → new → done varias veces. `null` si ninguno del período llegó a
    `done` (la tarjeta muestra "—" con el motivo).
  - `cotizaciones_convertidas` → count de `convert_quote_to_order` en
    `admin_audit_log`. Se cuenta ahí y no en `orders` porque después de
    convertirla la fila ya dice `kind = 'order'` y no queda rastro.
  - `fallos` → `{ total, recuperados }` sobre `order_failures` (de ahí que el
    preflight de la migración exija esa tabla).
  - `serie_diaria` → `[{ dia, monto, pedidos }]` con **un bucket por día, sin
    huecos** (`generate_series` + left join, los días sin ventas vienen en 0).
    Son `p_days + 1` buckets: la ventana arranca a la hora actual de hace N días,
    así que el primer día es parcial — a cambio, la serie suma exactamente el
    total del período.
  - `excluidas` → los nombres de las cuentas de prueba que quedaron afuera.
- **Cuentas de prueba**: `sa_metrics_test_vendedora_patterns()` (array de
  patrones ILIKE contra `vendedores.name`: `systemspruebas%`, `%prueba%`,
  `%demo%`) + `sa_is_test_vendedora(name)`. Editar ese array es el **único**
  lugar donde vive la lista. No borra ni toca nada: solo deja esas filas afuera
  del cálculo. Los dos helpers **no** tienen `execute` para `authenticated` (ni
  para el superadmin): los llama solo la RPC, que corre como el dueño.
- Índices que agrega la migración: `orders_created_idx` (sin él la ventana
  `created_at >= now() - N days` era un seq scan cada 60 s por pestaña abierta) y
  `admin_audit_log_order_status_idx` (parcial, `where action =
  'update_order_status'`).

### `is_vendedora() → boolean` / `current_vendedora_id() → uuid` / `get_my_role() → text`
- Acceso: solo `authenticated`. (2026-07-06, rol vendedora.)
- `is_vendedora()`: existe una fila en `vendedores` con `user_id = auth.uid()`.
- `current_vendedora_id()`: el `id` de esa fila (usado en las policies RLS de `clients`/`orders`).
- `get_my_role()`: `'admin'` si `is_admin()`, si no `'vendedora'` si `is_vendedora()`, si no `null`. Es el único RPC que llama `AdminLayout.jsx` para decidir qué pestañas mostrar.

### `sync_upsert_products(p_products jsonb)` / `sync_upsert_prices(p_price_list_code text, p_rows jsonb)` / `sync_upsert_clients(p_rows jsonb)` → jsonb
- Acceso: **solo `service_role`** (revoke a public; ni anon ni
  authenticated pueden llamarlas). (2026-07-10,
  `migration-2026-07-10-sellercloud-sync.sql` — para el sync automático
  SellerCloud → Supabase vía n8n.)
- Las tres replican el criterio de las cargas por Excel del admin:
  **upsert, nunca delete** — un export parcial o viejo no borra
  productos, precios ni tokens en uso.
- `sync_upsert_products`: array de `{sku, name, category, product_line,
  availability, image_url}`, upsert por `sku`. En updates, los campos
  opcionales solo pisan si vienen con dato (un export sin fotos no borra
  las URLs cargadas a mano); `new_until` no se toca en updates;
  productos nuevos entran con `new_until = now() + 10 días`
  (misma etiqueta ✨ Nuevo del alta manual). `availability` se normaliza
  a available/preorder/flash; valores desconocidos conservan el
  existente. Devuelve `{inserted, updated, skipped}`. **Desde 2026-07-13
  (`migration-2026-07-13-exclude-noncatalog.sql`)** salta (cuenta en
  `skipped`) los productos no-catálogo vía `sync_is_noncatalog_product(sku,
  product_line)`: SKU terminado en `-SPECIAL` o `product_line` (=
  PRODUCT_CATEGORY del export, **no** `category`/marca) en beauty/
  electronics/support/packing and shipping supplies/test. Misma regla
  replicada en la carga manual por Excel (`ProductsAdmin.jsx`,
  `EXCLUDED_LINES`/`SPECIAL_SKU_PATTERN`) — cambiar una lista implica
  cambiar la otra. **Desde 2026-07-14
  (`migration-2026-07-14-inventory-stock.sql`)** el inventario del payload
  (`inventory` o `inventory_available_qty`, mapeado de
  `InventoryAvailableQTY`) se guarda en `products.stock` y controla la
  **disponibilidad** (no `active`): `>= 1` → available, `0`/negativo →
  preorder, salvo `flash` que se conserva (`coalesce(entrante, existente) =
  'flash'`). Si la fila no trae inventario, `stock`/`availability` no se
  pisan. `active` a propósito ya NO se toca en el sync — es decisión manual
  del admin (bulk activar/desactivar) + la exclusión de no-catálogo. Mismo
  criterio en la carga manual por Excel (`ProductsAdmin.jsx`,
  `COLS.inventory`/`parseStock()`/`resolveAvailability()`, solo si el
  archivo trae la columna). **Desde 2026-07-14
  (`migration-2026-07-14-product-upc.sql`)** también guarda `upc` (campo
  `upc` del payload; en updates solo pisa si trae dato, coalesce).
- `sync_upsert_prices`: resuelve la lista por `code` (exception si no
  existe o si es `quote`, que no lleva precios); filas `{sku, price}`,
  upsert por `(product_id, price_list_id)`. SKUs desconocidos y precios
  inválidos se omiten sin tumbar la corrida. Devuelve `{upserted,
  skipped, skipped_skus}` (primeros 50).
- `sync_upsert_clients` **(v2, 2026-07-10,
  `migration-2026-07-10-sellercloud-sync-v2.sql` — reemplaza la versión
  v1 que matcheaba por teléfono)**: filas `{sellercloud_id, name, phone,
  salesman_name}`, upsert por `sellercloud_id` (General.ID de
  SellerCloud) — nunca por teléfono en este flujo (el teléfono sigue
  siendo el criterio de la carga manual por Excel, que no cambió).
  Detalles: (a) `salesman_name` se matchea contra `vendedores.name`
  normalizando ambos lados con `sync_normalize_name()` (minúsculas + sin
  acentos; usa `unaccent()` si la extensión está, si no `translate()`
  manual); sin match → `vendedora_id` null en inserts / se conserva la
  asignación existente en updates, y suma al contador
  `unmatched_salesman` + `unmatched_names` (primeros 20) del retorno —
  NO crea vendedoras sobre la marcha (a diferencia del Excel). (b)
  `price_list_id` no se toca nunca: clientes nuevos entran con lista
  null (asignación manual pendiente), existentes conservan la suya. (c)
  Adopción one-shot: si el `sellercloud_id` no existe pero hay un
  cliente por Excel (sellercloud_id null) con el mismo teléfono, se le
  graba el id en vez de insertar un duplicado (contador
  `linked_by_phone`) — sin esto la primera corrida chocaría con el
  unique de `clients.phone` para cada cliente ya cargado. (d) Teléfono
  que ya es de otro cliente con otro sellercloud_id → la fila se salta y
  cuenta en `phone_conflicts`. (e) El trigger
  `clients_enforce_owner_vendedora` sigue corriendo sin cambios (lista
  con dueña pisa vendedora). Devuelve `{created, updated,
  linked_by_phone, skipped, phone_conflicts, unmatched_salesman,
  unmatched_names}` — loguearlo en `sync_runs.error_detail`.
- Al final del archivo de migración hay selects comentados para probar
  cada función a mano en el SQL Editor antes de conectar n8n (el editor
  corre como postgres, así que puede llamarlas aunque el grant sea solo
  service_role) + el ciclo insert/update de `sync_runs` como lo haría
  n8n, y la limpieza de las filas de prueba.

### `link_vendedora_login(p_vendedora_id uuid, p_email text) → boolean`
- Acceso: solo `authenticated`; internamente exige `is_admin()` (si no, `raise exception`). (2026-07-06.)
- Busca `p_email` en `auth.users` (tabla no legible directo por el cliente) y, si existe, setea `vendedores.user_id`/`login_email`. Devuelve `false` si el email no corresponde a ningún usuario. Lo llama `VendedoresAdmin.jsx` al presionar "Vincular acceso" — evita que el admin tenga que ir al SQL Editor, pero el usuario de Supabase Auth se sigue creando a mano en el dashboard.

### `price_list_has_owners(uuid)` / `is_price_list_owner(uuid, uuid)` / `price_list_primary_owner(uuid)` / `can_vendedora_use_price_list(uuid)`
- Acceso: los tres primeros `authenticated` salvo `price_list_primary_owner`
  (revoke a public, uso interno del trigger). (2026-08-04,
  `migration-2026-08-04-shared-price-lists.sql`.)
- Todos **SECURITY DEFINER a propósito**: los usan las policies RLS de
  `price_lists`/`product_prices`/`price_list_owners` y el trigger de
  `clients`, así que no pueden depender de que quien pregunta tenga permiso
  de leer `price_list_owners` — si no, la policy se muerde la cola. Mismo
  criterio que `is_admin()`/`current_vendedora_id()`.
- `can_vendedora_use_price_list(id)` es la regla única que aplican las
  policies: la lista no tiene dueñas (general) **o** la vendedora logueada es
  una de ellas.
- `price_list_primary_owner(id)`: la dueña `is_primary`, con `order by
  is_primary desc, created_at, vendedora_id` para cubrir el caso raro de que
  ninguna esté marcada.

### `reassign_client(p_client_id uuid, p_vendedora_id uuid) → jsonb` / `delete_client(p_client_id uuid) → jsonb`
- Acceso: solo `authenticated`; internamente exigen `is_admin()` (si no, `raise exception`). (2026-07-14, `migration-2026-07-14-client-admin-actions.sql`.)
- SECURITY DEFINER a propósito (no `update`/`delete` directos desde el frontend): así el registro en `admin_audit_log` es atómico e imposible de saltear — no hay forma de reasignar/borrar sin dejar rastro (quién vía `auth.uid()` + email de `auth.users`).
- `reassign_client`: cambia `clients.vendedora_id` (null = sin asignar). Si la lista del cliente **tiene dueñas** (ej. luzmar), el destino tiene que ser una de ellas — si no, `raise exception` (2026-08-04; antes rechazaba de plano cualquier cliente con lista personal, pero con una lista compartida repartir sus clientes entre las dueñas es justamente lo que hay que poder hacer; el trigger revertiría cualquier otro destino igual). Devuelve `{ok, from, to}`.
- `delete_client`: borra el cliente. **Rechaza si tiene pedidos** (`orders.client_id`, FK RESTRICT sin cascade — borrarlo perdería el historial, y `orders` no guarda copia del nombre). Inserta la fila de auditoría ANTES del delete (snapshot). Devuelve `{ok}`.
- Las lanza `ClientsAdmin.jsx` (select de vendedora por fila + botón Eliminar con confirmación inline); el mensaje de `raise exception` (en español) llega como `error.message` y se muestra en un banner. El **Registro de movimientos** (sección colapsable, solo admin) lee `admin_audit_log` directo (RLS `admin_read_audit`).

---

## RLS — Resumen de seguridad

- **`anon` no puede leer ni escribir ninguna tabla directamente** (RLS activo en todas).
- Todo acceso público es vía las RPC SECURITY DEFINER.
- **`authenticated` + `is_admin() = true`**: acceso total (policy `admin_all` en todas las tablas) **menos `admins` y `price_list_owners`** desde 2026-08-05, donde solo lee.
- **Rol superadmin** (2026-08-05, `migration-2026-08-05-superadmin.sql`): tabla `superadmins` con RLS activo y **sin ninguna policy** — invisible e inescribible desde la app para todos, incluido él mismo; solo la ven las funciones SECURITY DEFINER y el SQL Editor. `is_admin()` pasa a ser "en `admins` **o** superadmin". `admins` y `price_list_owners` salieron del loop de `admin_all` y quedaron con `superadmin_all` (for all) + `admin_read_only` (select). El motivo concreto: `admin_all` sobre `admins` significaba que **cualquier admin podía nombrar admins con un request directo** (nunca hubo UI, pero el permiso estaba); poner UI encima de eso habría convertido el agujero en un botón, y una marca de superadmin guardada ahí habría sido auto-otorgable. Las 12 RPC `sa_*` validan `is_superadmin()` adentro, así que la pestaña oculta es solo comodidad.
- No hay políticas para `anon` sobre las tablas → denegado implícitamente.
- **Rol vendedora** (2026-07-06): `authenticated` + `is_vendedora() = true` (vía `vendedores.user_id = auth.uid()`) obtiene, mediante policies aditivas a `admin_all` (Postgres las combina con OR para el mismo comando):
  - `select` en `vendedores` limitado a su propia fila (`user_id = auth.uid()`).
  - `select` en `clients` y `orders` limitado a `vendedora_id = current_vendedora_id()` (en `orders`, vía `client_id in (select id from clients where ...)`).
  - `update` en `orders` con el mismo filtro en `using`/`with check` — permite marcar sus propios pedidos atendido/nuevo sin poder reasignarlos a otro cliente.
  - `select` en `order_failures` (2026-08-05) limitado a los fallos de sus propios clientes; los que no tienen cliente resuelto (token inválido) los ve solo el admin. La tabla es de **solo lectura para todos** (sin policy de insert/update/delete para nadie, ni siquiera admin): la escribe únicamente `create_order`, igual criterio que `admin_audit_log`.
  - `select` de solo lectura en `price_lists`, `products`, `product_prices`, `flash_sales`.
  - `insert` en `clients` (2026-07-07, policy `vendedora_insert_own_clients`) **solo si `vendedora_id = current_vendedora_id()`** — puede darse de alta clientes propios pero no crear uno sin asignar ni para otra vendedora.
  - Sin ninguna otra policy → no puede insertar/actualizar/borrar nada fuera de eso. La UI (`AdminLayout.jsx` + páginas admin) además oculta los controles de edición para este rol, pero el límite real está en RLS.
- **Trigger `clients_enforce_owner_vendedora`** (2026-07-09; reescrito 2026-08-04 para listas compartidas): antes de cualquier `insert`/`update` en `clients`, si la lista elegida tiene dueñas en `price_list_owners` (ej. `'luzmar'`), el cliente tiene que quedar con **una de ellas** — si la vendedora que viene ya es dueña se respeta (así se reparten los clientes de una lista compartida), y si no se pisa con la dueña principal, sin importar qué mande el caller. Con una sola dueña el comportamiento es idéntico al original. Corre ANTES de evaluar las policies RLS de arriba, así que a una vendedora que no sea dueña ni siquiera le sirve saltarse la UI e insertar directo: el trigger fuerza `vendedora_id` a la principal, y `vendedora_insert_own_clients` (`vendedora_id = current_vendedora_id()`) rechaza la fila igual porque ya no coincide con su propio id. **Corre en TODO insert/update a propósito** (una versión intermedia se salteaba los updates que no tocaban `price_list_id`/`vendedora_id`, y se descartó porque dejaba huérfanas para siempre las filas de una dueña que se quitó de la lista: son estas escrituras las que las enderezan). Ojo al probar: como la regla respeta a cualquier dueña, un `update` que no cambia nada relevante tampoco cambia la asignación.
- **Trigger `orders_guard_items_edit`** (2026-07-17, ampliado el mismo día; 2026-08-04 suma `stock_applied`): antes de cualquier `update` en `orders`, si cambian `items`, `total`, `status`, `kind` o `stock_applied` y no está prendida la bandera de sesión `app.allow_order_edit` (transacción-local, la prenden `update_order_items`/`update_order_status`/`convert_quote_to_order`, cada una antes de escribir), tira excepción. La policy `vendedora_update_own_orders` le da a una vendedora `update` crudo sobre sus propios pedidos (pensada solo para cambiar `status` desde `OrdersAdmin.jsx`); sin este trigger, esa misma policy le hubiera permitido reescribir cualquiera de esas columnas a mano, sin pasar por ninguna RPC ni quedar auditado — incluida `stock_applied`, con lo que podría saltearse o duplicar el descuento de stock de un pedido. Ojo al probarlo: el trigger compara con `is distinct from`, así que un `update` que escribe el **mismo** valor que ya estaba no cuenta como cambio y pasa (no es un agujero: no cambia nada).
- **Trigger `products_availability_from_stock`** (2026-08-04; ampliado 2026-08-12): antes de cualquier `insert`/`update` en `products`, si `stock` no es null y `availability` no es `'flash'`, pisa `availability` con `stock >= 1 ? 'available' : 'preorder'`. **Desde 2026-08-12 también decide la publicación**: `stock <= 0` pone `active = false` + `deactivated_by_stock = true` (solo si venía activo, para no pisar la bandera de lo que ya estaba apagado), y `stock >= 1` reactiva **únicamente** lo que tenga la bandera puesta. Por eso un producto en 0 no puede quedar publicado venga la escritura de donde venga, y "Activar" a mano sobre uno sin stock no lo publica: lo deja marcado para publicarse cuando haya. Convierte en invariante de la tabla la regla que antes vivía repetida en cada camino de escritura (`sync_upsert_products` en SQL, `resolveAvailability()` en `ProductsAdmin.jsx`) y que `apply_price_list` rompía sin querer. No es seguridad sino consistencia de datos, pero el criterio es el mismo que `clients_enforce_owner_vendedora`: la garantía vive en la base, no en la UI.
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
- **🔥 Flash Sales por Excel** (2026-08-07): el archivo semanal "Special Flash
  Sale" tal cual. Solo usa la columna SKU y **le pone la etiqueta 🔥** a esos
  productos; **la columna Price se ignora a propósito** (una Flash Sale ya no
  tiene precio propio — el precio sale de la lista del cliente, pestaña
  Precios). Vista previa antes de aplicar: a marcar / a desmarcar / ya
  etiquetados / SKU sin producto, con aviso rojo si alguno del archivo está
  inactivo. Por defecto **reemplaza la promo** (les quita 🔥 a los que no
  vienen en el archivo); se puede destildar para acumular. Al desmarcar, el
  producto vuelve a Disponible o a Pre-Order **según su stock** (lo decide el
  trigger `products_availability_from_stock`, no el frontend). Los updates van
  en tandas de 100 ids (`updateByIds` en `lib/supabase.js`): PostgREST manda el
  `id=in.(...)` en la URL y 300 uuids arman una query string de ~11 KB.
- **Acciones en bloque** (selección por casillas, solo admin): activar/
  desactivar, etiqueta 🔥 Flash Sale / Pre-Order / Disponible, y marcar/quitar
  ✨ Nuevo. Ojo: Disponible y Pre-Order **las decide el stock** (mismo trigger),
  así que pedir Pre-Order sobre algo con stock no queda — el panel relee
  después de aplicar y avisa "N con la etiqueta aplicada · M recalculados por
  su stock" en vez de dar por hecho que se aplicó a todos.
- **Una acción que no cambiaría nada se muestra deshabilitada**, con el motivo
  en el tooltip. El cálculo usa `availabilityAfter()` (espejo del trigger: con
  qué disponibilidad va a quedar el producto si le escribimos X), no la
  etiqueta a secas, así que distingue dos casos: *"todos los seleccionados ya
  están así"* (marcar 🔥 sobre puros 🔥, Activar sobre activos, ✨ Marcar sobre
  los que ya la llevan, ✨ Quitar cuando ninguno la tiene) y *"la
  disponibilidad la manda su stock"* (Pre-Order sobre productos con stock ≥ 1,
  Disponible sobre productos en 0). Con selección mixta quedan habilitados: la
  acción aplica al subconjunto que sí cambia.
- **Activar/Desactivar con la regla de stock 0** (2026-08-12): activar un
  producto sin stock **no lo publica**, pero tampoco es un no-op — queda marcado
  (`deactivated_by_stock`) y se publica solo cuando entre stock. El aviso separa
  las dos cosas ("3 activados · 5 siguen inactivos por stock 0"), y desde el
  badge de la fila dice lo mismo, para que nadie lo intente dos veces creyendo
  que falló. Tercer motivo de botón apagado: *"Sin stock no se publica"*, cuando
  todos los seleccionados ya están marcados. **Desactivar apaga la bandera** (si
  lo apaga una persona, no tiene que volver solo) y por eso sigue habilitado
  sobre un producto **ya inactivo por stock**: es la única forma de decir "este
  no vuelve", ya que el badge de la fila solo ofrece activar mientras esté
  inactivo. Ahí el aviso dice "2 ya no vuelven solos cuando entre stock".
- **Filtro de estado "📦 Inactivos por stock 0"** (2026-08-12,
  `productMatchesStatus` en `pages/admin/ui.jsx`, compartido con la pestaña
  Precios), separado de "Inactivos": los primeros se arreglan solos con el
  próximo sync, los segundos son los únicos que hay que revisar a mano. El badge
  de estado de la tabla lleva 📦 en ese caso, con el porqué en el tooltip.

### Precios (Excel/CSV) — 2026-07-17: una lista por archivo + preview/confirmar
- Elegir arriba a qué lista corresponde el archivo (selector con
  `price_lists`, sin `quote`); columnas: `SKU`, precio (genérica `Price`/
  `Precio` o con el nombre de la lista, ej. `US Minimum Order`) y
  `Type`/`Tipo`/`Disponibilidad` (`Available`/`Pre Order`/`Flash Sale`).
- El frontend arma `{ sku, price, type }` por fila y llama a la RPC
  `apply_price_list(p_price_list_code, p_rows, p_commit)`
  (`migration-2026-07-17-apply-price-list.sql`):
  1. `p_commit: false` → preview sin escribir nada: cuenta a actualizar,
     a reactivar, a **desactivar** (productos con precio hoy en esa lista
     que no vinieron en el archivo — pierden el precio de esa lista y
     quedan inactivos **globalmente**), SKU sin producto y precios
     inválidos, con muestra de los primeros 50 de cada uno.
  2. El admin confirma → mismo llamado con `p_commit: true`, recién ahí
     se aplica.
- **Contador `blocked_by_stock`** (2026-08-12,
  `migration-2026-08-12-hide-out-of-stock.sql`): los que traen precio y están
  inactivos pero **no** vuelven a verse con esta carga porque su stock está en 0
  — el trigger los deja apagados y marcados para publicarse cuando entre stock.
  Antes caían en "a reactivar" y el preview prometía de más (decía "12 a
  reactivar" y volvían 7); ahora tienen chip propio, "📦 N no vuelven (stock 0)".
  La carga sigue escribiendo `active = true` para todo lo que trae precio, a
  propósito: el archivo dice "este producto se publica" y el trigger decide
  cuándo. Del otro lado, el UPDATE que desactiva lo que quedó **fuera** del
  archivo apaga también `deactivated_by_stock`: lo saca una persona, así que no
  puede volver solo con el próximo inventario.
- La RPC deduplica por SKU del lado del servidor (última fila del archivo
  gana): un SKU repetido ya no revienta el upsert con "ON CONFLICT DO
  UPDATE command cannot affect row a second time" (pasaba con el archivo
  real de US Minimum Order, SKU `ZX_PE-MA-U-599175` duplicado).
- El parser normaliza encabezados (sin acentos, minúsculas) → aceptan variaciones.
- **Filtros por grupo de producto en la matriz** (2026-08-07): además del
  buscador y del selector de lista, se filtra por marca, línea de perfume y
  estado (activo/inactivo, con/sin stock, Pre-Order, 🔥 Flash Sale, ✨ Nuevo).
  Son los MISMOS de la pestaña Productos, compartidos en `pages/admin/ui.jsx`
  (`ProductFilters` + `productMatchesFilters`) para que las dos pestañas no
  puedan divergir sobre los mismos productos. Los contadores "con precios /
  sin precios" se recalculan **sobre el grupo filtrado** — sirve para
  responder "¿los 🔥 de esta semana tienen precio en US Wholesale?" —, pero el
  buscador de texto no los mueve, para que el número no baile tecla a tecla.
  Cada fila muestra las etiquetas del producto (🔥 / Pre-Order / ✨ Nuevo /
  Inactivo).

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

### Pedidos (`/admin/orders`, `OrdersAdmin.jsx`)
- **Sin tope: se cargan todos los pedidos** (2026-08-07, a pedido del
  usuario). Antes la consulta traía los últimos 200, con dos consecuencias
  feas: el conteo del encabezado **mentía** apenas se pasaba de ahí (decía
  "200" hubiera 200 o 900), y los pedidos más viejos no se podían ver ni
  marcar atendidos. Ahora usa `fetchAll` (páginas de 1,000 en paralelo,
  ordenadas ascendente por `created_at` y dadas vuelta en el cliente porque
  `fetchAll` necesita un orden estable para el `range`). Tres cosas que van
  de la mano y conviene no deshacer:
  1. **Scroll infinito** (`useInfiniteRows(100)`): traerlos todos no es
     dibujarlos todos — cada fila puede desplegar su detalle.
  2. **`get_quotes_live_pricing` en tandas de 100 ids** (`LIVE_PRICING_CHUNK`).
     Esa RPC recalcula el precio vigente de cada línea de cada cotización:
     pedirle 800 de una es una sola consulta larga que puede chocar con el
     `statement_timeout`, y si falla no se muestra **ningún** precio vigente.
  3. **Estado de carga**: hasta que termine, la tabla no puede decir "aún no
     hay pedidos" (diría que no hay ninguno mientras todavía están viniendo),
     y si la carga falla se avisa en rojo en vez de mostrar una lista
     incompleta como si fuera completa.
  El aviso rojo de `order_failures` de arriba sigue con su `limit(50)`: es una
  alarma de pedidos sin recuperar, no el listado de pedidos.
- Click en una fila expande un detalle de ancho completo (2026-07-17,
  ajuste visual sobre una primera versión que lo abría angosto dentro de
  la columna Ítems y quedaba muy alto y feo): fila propia con
  `colSpan`, tabla Producto/Cantidad/Precio/Subtotal.
- **Marcar atendido / Cancelar / Reabrir** ahora piden confirmación
  (2026-07-17, a pedido del usuario: modal "¿Confirmás esta acción?"
  antes de aplicar) y quedan auditados por la RPC `update_order_status`
  — antes era un `update` directo a la tabla, sin ningún rastro.
- Cada fila suma botones **Descargar PDF** (2026-07-17, mismo `pdf.js`
  que el carrito del cliente) y **Descargar Excel** en una fila; debajo,
  separados, **Editar** y **Convertir en pedido** — estos dos solo
  aparecen para cotizaciones (`kind = 'quote'`), nunca para un pedido
  real.
- **Editar** (2026-07-17, a pedido del usuario; ajustado el mismo día:
  solo cotizaciones, y solo mientras siguen `new` — ni una cotización
  atendida ni una cancelada se puede editar, igual que un pedido real):
  abre una tarjeta propia de ancho completo con la lista de ítems
  (cantidad editable, botón Quitar) y un buscador para agregar producto
  (igual UI que el alta de Flash Sale). Guardar llama a la RPC
  `update_order_items`, que recalcula precio/total en el servidor (el
  frontend nunca manda precio) y audita el cambio — ver "RPC" y "RLS"
  más arriba. Cualquiera con acceso al pedido puede editarlo (admin
  siempre; vendedora solo los de sus propios clientes, vía RLS ya
  existente).
- **Convertir en pedido** (2026-07-17, a pedido del usuario): cierra una
  cotización como pedido real vía `convert_quote_to_order` — a
  diferencia de la cotización (que siempre muestra precio vigente, ver
  abajo), el pedido resultante congela el precio de ese momento y ya no
  se sigue ajustando. Falla con un mensaje inline si el cliente sigue
  en la lista `quote` (no hay precio real que congelar) o si la
  cotización está cancelada.
- **Aviso de pedidos que no se registraron** (2026-08-05): bloque rojo arriba de
  la lista con las filas de `order_failures` sin recuperar — cliente, fecha,
  motivo y cantidad de líneas — y un botón **Recuperar** por fila que llama a
  `recover_order_failure` (lo carga como pedido con los precios vigentes de la
  lista del cliente y marca la fila como recuperada). Los errores se muestran
  inline en la fila. Aparece **también cuando todavía no hay ningún pedido**,
  para que el "aún no hay pedidos" no tape justo lo que hay que ver. Una
  vendedora solo ve y recupera los de sus propios clientes (RLS). El botón no
  aparece en los fallos por token inválido: no hay `client_id` ni payload con
  qué reconstruir el pedido.
- **Cotizaciones con precio vigente** (2026-07-17): las filas
  `kind = 'quote'` no muestran el precio guardado en `orders.items`
  (que para una cotización siempre es `null`) sino el que calcula al
  vuelo `get_quotes_live_pricing` — se pide una vez al cargar la bandeja
  (bulk, todas las cotizaciones visibles) y de nuevo para un pedido
  puntual después de editarlo. Si el admin cambió el precio de un
  producto después de que el cliente pidió la cotización, la fila lo
  refleja solo con recargar la página — no queda anclada al precio viejo.
  Excel/PDF exportados desde esta pantalla usan ese mismo precio vigente.
- El carrito del cliente (`CartDrawer.jsx`) ahora también genera un
  pedido `kind = 'quote'` al descargar el PDF (antes ese botón no tocaba
  la base) — ver `create_order` en "RPC".

### 🛡️ Registro de movimientos (`/admin/audit`, `AuditLogAdmin.jsx`)

Solo lectura de `admin_audit_log` (RLS `admin_read_audit` = `is_admin()`, o sea
admin **y** superadmin; una vendedora no tiene la pestaña). La tabla muestra los
**últimos 200** movimientos con filtros client-side por usuario, acción (las
opciones agrupan varias acciones por etiqueta, ej. las tres de dueñas de lista) y
rango de fechas.

**Descargar Excel** (2026-08-05, a pedido del usuario): baja **todo** el
historial, no los 200 de la tabla — usa `fetchAll` para pasar el corte de 1,000
filas de PostgREST. Los filtros activos se respetan, así que también sirve para
"bajame todo lo que hizo tal usuario" aunque en pantalla no entre; el botón dice
"(todo el historial)" o "(filtrado)" según corresponda. Columnas: Fecha (como
`YYYY-MM-DD HH:MM:SS` en hora local, texto ordenable a propósito para no depender
de cómo interprete Excel una fecha según la configuración regional), Usuario,
Acción, Cliente / objetivo, Detalle (el mismo resumen legible de la tabla), ID
cliente, ID pedido y **Datos completos (JSON)** — el `detail` jsonb crudo, porque
es un registro de auditoría y el resumen deja cosas afuera (ej. el antes/después
ítem por ítem de una edición de pedido). Si el filtro no deja ninguna fila no se
genera archivo: avisa "Sin movimientos registrados".

### 🔐 Superadmin (`/admin/superadmin`, `SuperAdminPanel.jsx`, 2026-08-05)

Pestaña visible **solo** para el superadmin (`is_superadmin()`), última del
menú. Junta lo que antes obligaba a entrar al SQL Editor de Supabase o al
dashboard de Auth. Dos secciones:

- **Usuarios y accesos**: tabla de todos los usuarios de Supabase Auth
  (`sa_list_users`) con email, rol (Superadmin / Admin / Vendedora / Sin rol —
  un usuario puede ser admin **y** vendedora a la vez, caso Luzmar, y se
  muestran los dos badges), vendedora vinculada, fecha de alta y último acceso,
  con buscador por email. Por fila: **"Hacer admin"** / **"Quitar admin"** (con
  confirmación inline, `sa_set_admin`) y **"Cambiar contraseña"** (campo inline;
  sirve para cualquier acceso, vendedora/admin/el propio superadmin). Arriba,
  **"+ Crear admin"**: email + contraseña inicial y queda creado y con rol en un
  solo paso.
- **Listas de precio y dueñas** (`sa_price_list_overview`): una tarjeta por
  lista con su `code`, nombre visible, cuántos clientes y cuántos precios tiene,
  y sus dueñas como chips con la principal marcada (★). Se puede **agregar** una
  dueña (select de vendedoras que todavía no lo son), **quitarla**, **cambiar
  cuál es la principal**, **renombrar** el nombre visible, **crear** una lista
  nueva (código validado — minúsculas/números/`_`, y no se puede cambiar
  después) y **eliminar** una lista que no sea de las base y esté vacía. Si al
  mover dueñas quedaron clientes con una vendedora que ya no es dueña, la
  tarjeta muestra el aviso con el número y un botón para pasarlos a la principal
  (`sa_sync_price_list_clients`) — no se mueven solos a propósito: una
  reasignación masiva silenciosa es justo lo que no se quiere.

Notas de implementación: los formularios inline solo se cierran si la acción
salió bien (si falla, no se pierde lo tipeado); después de cada acción el panel
recarga todo en vez de parchear el estado local, porque casi todas tienen
efectos cruzados (quitar una dueña puede promover a otra, agregar una deja
clientes inconsistentes) y reconstruir eso en el frontend sería duplicar las
reglas del SQL. Los mensajes de error que se muestran son los `raise exception`
de las RPC, escritos en español para mostrarse tal cual.

### 📈 Métricas (`/admin/metrics`, `MetricsAdmin.jsx`, 2026-08-06)

Pestaña visible **solo** para el superadmin (`is_superadmin()`), al lado de
🔐 Superadmin. Triple candado, igual que aquélla: la entrada del menú se
renderiza solo si `isSuper`, `AdminLayout.jsx` redirige `/admin/metrics` a
Productos para cualquier otro, y la RPC exige `is_superadmin()` adentro — un
admin común que la llame a mano con la anon key recibe `not authorized`.

Arriba, selector de rango **7 / 14 / 30 días** (default 14), botón
**"↻ Actualizar"** y el cartel **"Actualizado hace X"**. Se refresca solo cada
**60 s** (`REFRESH_MS`, una const clara arriba del archivo) con `setInterval`
limpiado en unmount; el contador de la antigüedad late aparte cada 5 s
(`AGE_TICK_MS`) para no re-renderizar la pantalla entera una vez por segundo.

Contenido, de arriba abajo:

- **Ocho tarjetas de KPI**: monto capturado, pedidos, ticket promedio,
  cotizaciones, vendedoras activas, **tiempo promedio a atender**, cotizaciones
  convertidas y cancelados. El tiempo a atender muestra **"—" en gris con el
  motivo** ("aún sin pedidos marcados atendidos") cuando la RPC devuelve `null`
  — el motivo va en el `title` y también visible, porque en el teléfono no hay
  hover. El ticket promedio hace lo mismo: `money(null)` daría "$0.00", y "sin
  pedidos en el período" no es "el ticket fue cero".
- **Una línea con los fallos de envío** del período (`order_failures`) y cuántos
  se recuperaron, más el "actualizado hace X".
- **Mini-gráfico de barras del monto por día**, SVG propio sin librería de charts
  (recharts arrastra d3, ~200 kB para una serie de 15 puntos). Es responsive sin
  medir nada en JS: `viewBox` de 10 unidades por día + `preserveAspectRatio="none"`,
  así el SVG se estira al ancho del contenedor — y por eso adentro solo hay
  `<rect>` (que toleran bien el estirón) y las fechas van en HTML abajo, donde no
  se deforman. Los días sin ventas dibujan una astilla en el color de las
  hairlines: se ve que el día existe y no vendió, en vez de un hueco que se
  confunde con "falta el dato". Cada barra tiene `<title>` con día, monto y
  cantidad de pedidos.
- **Tabla "Adopción por vendedora"** (vendedora, pedidos, monto, ticket,
  cotizaciones) ordenada por monto, con **fila de total del período** que cuadra
  con las tarjetas, y **"⬇️ Descargar Excel"** (`downloadMetricsExcel` en
  `utils/excel.js`, XLSX lazy como el resto; los números van crudos, no
  formateados, para poder sumarlos en Excel). Los pedidos sin vendedora salen
  agrupados en una fila **"—"**.
- **Al pie**, los nombres de las cuentas de prueba excluidas del cálculo.

Notas de implementación: un contador de pedidos en vuelo (`reqRef`) descarta la
respuesta de un rango viejo que llegue después de la del nuevo, y también
invalida lo que quede en vuelo al desmontar. Si falla un refresco automático
(wifi caído, migración sin correr) **no se borra la última foto buena**: se
muestra con el aviso arriba, en vez de vaciar la pantalla. El error se guarda
crudo y se traduce en el render, así cambiar de idioma no dispara una recarga con
spinner. Si la RPC todavía no existe (frontend desplegado antes que la
migración), el `PGRST202` de PostgREST se detecta y el aviso dice exactamente qué
archivo falta correr.

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
17. **Catálogo de cotización sin precios** (2026-07-08, a pedido del usuario, distinto de Special) — necesitaba un link genérico para mandar a un prospecto sin lista asignada, que muestre todos los perfumes disponibles y pre-order sin precio en ningún lado, y que igual arme una lista y la mande por WhatsApp a la vendedora asignada (misma lógica de `vendedora_phone` que un cliente normal). **Primer intento, rechazado por el usuario en la misma sesión**: un flag en `clients` (`is_quote_only`, con `price_list_id` nullable) más un checkbox aparte en el alta de cliente que ocultaba el selector de lista. El usuario lo rechazó: obligaba a crear un cliente nuevo cada vez que alguien quisiera una cotización, y un cliente "sin lista asignada" (price_list_id null) quedaba incómodo de editar después. **Diseño final**: `quote` es una fila más en `price_lists` (como `special`), elegible en el mismo selector "Lista" de siempre (alta individual, tabla de Clientes, Excel) — se reasigna hacia/adentro/afuera de esa lista igual que cualquier otro nivel, sin checkbox ni estado especial, y el cliente sigue teniendo vendedora asignada como cualquiera. `get_catalog`/`create_order` detectan el modo cotización resolviendo el `code` de la lista del cliente (no un flag): si es `'quote'`, `get_catalog` ignora `product_prices` y devuelve todos los productos activos con `price: null`; `create_order` fuerza `kind = 'quote'` sin calcular precio, sin importar el payload del navegador (mismo patrón de "el servidor decide, no el cliente" que ya usaba el recálculo de precios). `PricesUpload.jsx` excluye `quote` de la matriz/carga de precios. En el frontend casi todo el ocultamiento de precio ya existía gratis porque `ProductCard`/`CartDrawer`/`CartBar`/`Header` ya condicionaban el render en `price != null` / `cart.hasPrices` (resabio de Special-como-cotización, punto 11) — solo hubo que: (a) arreglar un bug real en `ProductCard.jsx` donde `Number(product.price)` convertía un precio `null` en `0` en vez de mantenerlo `null` (rompía `hasPrices` y por lo tanto el mínimo de pedido); (b) ocultar `FlashSaleSection` por completo para estos clientes (las ofertas siempre traen precio real, no dependen del cliente); (c) en `whatsapp.js`/`pdf.js`, omitir la línea de Total y usar título/saludo de "Solicitud de cotización" cuando ningún ítem tiene precio. **Hecho** (2026-07-08): se corrió el `schema.sql` actualizado en Supabase (agrega la fila `quote` a `price_lists`, `on conflict do nothing`) y se desplegó el código.
18. **Availability `'flash'` para el Type "Flash Sale" del Excel** (2026-07-08, a pedido del usuario) — antes `parseAvailability()` en `ProductsAdmin.jsx` solo distinguía Pre Order de todo lo demás; "Flash Sale" en la columna Type (ej. del Excel "Wholesale Perfume") caía en `available` sin dejar rastro. Ojo: esto **no tiene relación** con la tabla `flash_sales` (ofertas con precio promo y countdown que se gestionan en su propia pestaña) — es solo una tercera etiqueta de disponibilidad del producto, sin precio asociado; un producto puede tener el badge sin ninguna oferta activa y viceversa. Se agregó el valor `'flash'` a `products.availability` (columna sin CHECK constraint, no hizo falta migración) y se replicó exactamente el patrón que ya existía para `preorder`: badge 🔥 en `ProductCard.jsx` (esquina superior, mismo lugar que el de Pre-Order pero con colores invertidos para diferenciarlo), chip de filtro "🔥 Flash Sale" en `Catalog.jsx` junto a Disponible/Pre-Order (el bloque de chips ahora se muestra si hay preorder **o** flash, cada chip condicionado a que existan productos de ese tipo), y en `ProductsAdmin.jsx` un contador/filtro igual al de Pre-Order más el badge en la fila de la tabla. Se reutilizó la key de i18n `flashSale` (ya existía en el diccionario pero no se usaba en ningún lado — la usa el título hardcodeado de `FlashSaleSection.jsx`). **No se propagó** al carrito/WhatsApp/PDF como sí pasa con `preorder` (no fue parte del pedido): el campo `flash` que ya existe en los ítems del carrito es la marca de "vino de una oferta de `flash_sales`", nombre que se dejó intacto a propósito para no chocar con este nuevo significado.
19. **Carga masiva de Flash Sales por Excel** (2026-07-08, a pedido del usuario, mismo día que el punto 18 pero *no relacionado* — esto sí es la tabla `flash_sales` de ofertas con precio) — hasta entonces `FlashSalesAdmin.jsx` solo permitía cargar una oferta a la vez (producto + precio + fechas a mano). El usuario tiene un archivo semanal, `Special Flash Sale.xlsx` (mismo formato letterhead que las listas wholesale de precios: `UPC`/`Sku`/`Brand`/`Title Product`/`Price`/`Type`/`Qty`/`Total Price`, con `Type = 'Flash Sale'` en todas las filas y precio con `$` — ej. `$22.00`), y quería subirlo entero fijando la fecha de la promo con un calendario en vez de cargar producto por producto. Se agregó una sección de carga masiva en la misma pestaña: dos `datetime-local` (inicio/fin, igual estilo que el alta manual) que valen para **todo el archivo** — la fecha no sale del Excel — más un `UploadZone` que reusa `parseSheet()`. Matchea por SKU contra los productos activos ya cargados (mismo patrón que `PricesUpload.jsx`/`ClientsAdmin.jsx`: `bySku` en minúsculas) y usa el precio propio de cada fila (`Number(...).replace(/[$,\s]/g,'')`, ya soporta el `$`). Filas sin SKU coincidente o con precio inválido se cuentan como omitidas, no tumban la carga. Verificado contra el archivo real del usuario: de 324 filas de datos, 323 parsean SKU+precio válidos (1 fila sin SKU). **Decisión importante que hay que recordarle al usuario si vuelve a preguntar**: esto **no hace upsert** — cada carga inserta filas nuevas en `flash_sales` (mismo comportamiento que el alta manual, que tampoco tiene upsert), así que volver a subir el mismo archivo la semana siguiente crea ofertas duplicadas en vez de reemplazar las anteriores; para "cambiar la promo de la semana" hay que desactivar a mano las viejas en la tabla antes de subir el archivo nuevo (no se automatizó porque no se pidió, y automatizarlo mal — ej. desactivar todo lo que no está en el archivo nuevo — podría apagar ofertas vigentes de otro producto que no tenía por qué tocarse).
20. **Estados de Flash Sale más claros en el admin** (2026-07-08, mismo día, a pedido del usuario) — el usuario preguntó si hacía falta desactivar manualmente una promo al llegar su fecha límite. La respuesta ya era "no": `get_flash_sales()` (RPC público) y `FlashSaleSection.jsx` (filtro cliente-side, con tick de 1s) ya excluyen por `now() < expires_at`/`now < expires_at` sin que nadie toque `flash_sales.active` — ese booleano solo sirve para cortar una oferta **antes** de su fecha normal. El problema real era de UI: la tabla de `/admin/flash` mostraba "Inactivo" tanto para una oferta que expiró sola por fecha como para una desactivada a mano, dando la impresión de que hacía falta el paso manual. Se reemplazó `isLive()` (booleano) por `saleStatus(s)` con 4 casos — `deactivated` (`!active`) / `scheduled` (`now < starts_at`) / `expired` (`now >= expires_at`, con `active` todavía en `true`) / `live` — cada uno con su badge y color propio (`STATUS_STYLES` en `FlashSalesAdmin.jsx`, keys i18n `flashStatus_live/scheduled/expired/deactivated`). No cambió ningún comportamiento real, solo la claridad de qué está pasando y por qué.
21. **`product_line` (tipo de perfume, distinto de `category`/marca)** (2026-07-08, a pedido del usuario) — el usuario tiene un export de SellerCloud (`119389.xlsx`, en la raíz del repo) con columnas separadas `PRODUCTBRAND` (marca) y `PRODUCT_CATEGORY` (tipo real: `Perfume` = diseñador, `Perfume - Arabes` = dupes árabes, más basura tipo `Beauty`/`Electronics`/`Packing and Shipping Supplies` para SKUs que no son perfume). Pidió explícitamente que se lea `PRODUCT_CATEGORY`, **no** `PRODUCTBRAND` — el campo `category` existente en el proyecto ya guarda la marca, así que se agregó una columna nueva y separada, `products.product_line` (texto libre, sin CHECK, nullable — `ProductsAdmin.jsx`: `COLS.line = ['product_category', 'product category', 'línea', 'linea', 'segmento']`). Se replicó el patrón ya usado para `category`/`availability`: en `ProductsAdmin.jsx` un select de filtro (con opción "Sin categoría" vía `'__none__'`, igual que el de marca) más un badge chico junto a la marca en la tabla; en `Catalog.jsx` un chip de filtro nuevo (solo se muestra si hay 2+ valores distintos de `product_line` — con un solo valor no tendría sentido filtrar) y se sumó `product_line` a la búsqueda de texto junto a nombre/categoría. `get_catalog` devuelve el campo en el JSON de productos (agregado a las dos ramas, la de `quote` y la normal). Verificado end a end contra el archivo real del usuario simulando el `parseSheet()`/`pick()` reales: 3659 filas, `hasCategory: false` (confirma que `PRODUCTBRAND` no matchea ningún alias de `category`, tal como pidió el usuario que no se tocara) y `hasLine: true`, con conteos post-filtro-de-basura de 2164 `Perfume` / 1391 `Perfume - Arabes` / algunos residuales (`Beauty`, `Electronics`, etc., que si el admin sube ese archivo completo entrarían igual al catálogo salvo que ya estén cubiertos por `JUNK_PATTERN` — eso es una decisión de qué Excel subir, no algo que este cambio resuelva).
22. **PDF del pedido separa Pre-Order de los ítems normales/flash sale** (2026-07-09, a pedido del usuario) — `downloadOrderPdf()` en `pdf.js` listaba todos los ítems del carrito en el orden en que estaban, mezclando disponibles/flash con pre-order. Ahora filtra `items` en dos grupos usando el flag `preorder` que ya traía cada ítem del carrito (`CartContext.jsx`, seteado en `makeItem()` desde `product.availability === 'preorder'`): dibuja primero los normales/flash, y si hay al menos un ítem pre-order agrega un subtítulo en negrita (reusa la key i18n `preorder`, "Pre-Order"/"Pre-Order") antes de listarlos. El total al final sigue sumando todos los ítems sin cambios — solo cambió el agrupamiento visual de las filas.
23. **Filtro por estado + desactivar por lote en Flash Sales** (2026-07-09, a pedido del usuario) — `FlashSalesAdmin.jsx` no tenía forma de filtrar la tabla por estado (LIVE/Programada/Expiró/Desactivada) ni de desactivar de una sola vez todas las ofertas que vinieron juntas en una carga masiva por Excel. Se agregó: (a) un select de filtro que usa la misma `saleStatus()` ya existente (punto 20); (b) columna nueva `flash_sales.batch_id` (uuid, nullable, `add column if not exists` + índice parcial en `schema.sql`) que `handleBulkFile` llena con un `crypto.randomUUID()` generado una vez por carga — todas las filas de ese Excel comparten el mismo valor, las cargadas a mano o antes de este cambio quedan en `null`. La tabla agrupa filas con el mismo `batch_id` bajo un encabezado (cantidad total + cuántas siguen activas) con un botón "Desactivar grupo" que hace `update ... where batch_id = X and active = true`; el resto de las filas (sin lote) se sigue mostrando suelto como antes. **Corrido**: el `schema.sql` actualizado se corrió en producción el 2026-07-09 (agrega `batch_id`, no rompe nada si ya hay filas). Hasta que corrió, las cargas nuevas insertaban sin ese campo y fallaban.
24. **Buscador movido al Header** (2026-07-09, a pedido del usuario) — desde que `FlashSaleSection` se renderiza arriba del todo en `Catalog.jsx`, el buscador (que vivía debajo, junto a los chips de categoría) quedaba empujado fuera de la vista inicial en clientes con varias ofertas activas. Se movió el `<input type="search">` a `Header.jsx` (que ya es `sticky top-0`), como una segunda fila debajo del logo/carrito — así queda visible siempre, incluso con scroll. `Header` ahora recibe `search`/`onSearchChange`/`showSearch` como props (el estado sigue viviendo en `Catalog.jsx`, solo se re-ubicó el input); `showSearch = validClient && !loading` para no mostrarlo en la pantalla de "link inválido" ni durante la carga. Los chips de categoría/línea/disponibilidad se quedaron donde estaban, debajo de Flash Sale — solo se movió el input de texto. Probado con Playwright headless (recién instalado en esta sesión, antes no estaba disponible en el sandbox) mockeando las RPC `get_catalog`/`get_flash_sales` con `page.route()` para no depender de un token real: confirmado visualmente en mobile y desktop que el buscador queda arriba de Flash Sale y sigue filtrando (`page.fill` + verificar conteo de resultados).
25. **Filtros pegados al buscador + optimización de rendimiento** (2026-07-09, mismo día, a pedido del usuario) — dos problemas después de mover el buscador al Header (punto 24): (a) los chips de categoría/línea/disponibilidad seguían viviendo debajo de `FlashSaleSection`, así que con varias ofertas activas quedaban igual de escondidos; (b) el usuario reportó que "la página a veces lagea". **Filtros**: se extrajeron a un componente nuevo `FilterBar.jsx` (mismo JSX que antes, sin cambios de lógica) y se envolvió `<Header/>` + `<FilterBar/>` juntos en un único `<div className="sticky top-0 z-30">` en `Catalog.jsx` — en vez de calcular a mano cuántos px mide el header para posicionar una segunda barra sticky por separado, ambos comparten el mismo contenedor sticky y crecen/se pegan como una sola unidad. Se le sacó `sticky top-0 z-30` al `<header>` interno de `Header.jsx` (ya lo pone el wrapper). **Rendimiento**, tres cambios: (1) `FlashSaleSection.jsx` tenía un `setInterval` de 1 segundo que recalculaba `activeSales` (filtrando expirados) SIEMPRE, forzando el re-render de toda la grilla — con 60-300 ofertas activas (carga masiva semanal, ver punto 19) esto re-renderizaba cientos de tarjetas una vez por segundo sin que nada relevante cambiara casi nunca. Se reemplazó por un único `setTimeout` reprogramado dinámicamente para el próximo vencimiento exacto (`cutoff` state en vez de `now` con tick fijo) — el grid solo vuelve a renderizar cuando de verdad hay algo que ocultar. El `Countdown` de cada tarjeta (badge "Ends in HH:MM:SS") sigue con su propio tick de 1s — eso es aislado y liviano, no se tocó. (2) `Catalog.jsx`: el buscador filtraba el array completo de productos (miles) en cada tecla; ahora hay `searchInput` (lo que se ve, sin demora) separado de `search` (con debounce de 150ms, lo que de verdad dispara el filtro) — la tipeada se siente igual de fluida pero el filtrado pesado solo corre cuando el usuario hace una pausa. (3) `ProductCard.jsx` envuelto en `React.memo` — sin esto, cada tecla del buscador o cada lote nuevo del scroll infinito re-renderizaba TODAS las tarjetas visibles (48+), no solo las que de verdad cambiaron. **Verificado con Playwright** (instalado el mismo día, ver punto 24) mockeando un catálogo de 2,500 productos + 60 flash sales activas simultáneas vía `page.route()`: capturas confirmando que el buscador+chips quedan pegados arriba incluso haciendo scroll dentro de una sección Flash Sale larga, y que tipear + scrollear sobre ese catálogo grande no cuelga la página (sin JS errors, sin timeouts).
26. **Flash Sale se oculta con búsqueda/filtro activo** (2026-07-09, mismo día, a pedido del usuario) — `FlashSaleSection` se seguía mostrando siempre, incluso buscando o con un chip de categoría/línea/disponibilidad activo, compitiendo visualmente con los resultados filtrados. En `Catalog.jsx`: `hasActiveFilters = !!search.trim() || !!category || !!line || !!availability` (usa el `search` con debounce, el mismo que ya alimenta `filtered`, para que ocultar la sección y actualizar la grilla pase en el mismo instante) — con eso en `true` no se renderiza `<FlashSaleSection/>`; en `false` (buscador y todos los chips en "Todos") vuelve a aparecer igual que al entrar. Verificado con Playwright: Flash Sale desaparece al escribir en el buscador, reaparece al vaciarlo, y también desaparece al activar el chip Pre-Order.
27. **Grupos de Flash Sales generalizados + edición de fechas** (2026-07-09, mismo día, a pedido del usuario — segunda iteración del punto 23) — el agrupamiento original solo funcionaba por `batch_id`, así que las ofertas cargadas a mano o antes de que existiera esa columna nunca se agrupaban. Ahora `FlashSalesAdmin.jsx` agrupa por `batch_id ?? 'exp:' + expires_at`: un lote de Excel es un grupo, y las ofertas sueltas que comparten fecha de vencimiento exacta también (encabezado "Mismo vencimiento" vs "Lote de carga masiva"); grupos de 1 se muestran como fila suelta. Como los grupos se arman client-side, `deactivateGroup(items)` y `updateExpiry(ids, fecha)` operan con `.in('id', ids)` en vez de un WHERE por batch — el mismo código sirve para ambos tipos de grupo. Además se agregó edición de fechas ("apartado para ajustar fechas"): cada fila tiene el vencimiento clickeable (patrón del teléfono en VendedoresAdmin: click → `datetime-local` → Enter/blur guarda, Esc cancela; componente `ExpiryCell`), y cada encabezado de grupo tiene un `datetime-local` + botón "Aplicar al grupo" que reprograma el vencimiento de todas las ofertas del grupo de una vez.
28. **Etiqueta ✨ Nuevo con vencimiento automático** (2026-07-09, mismo día, a pedido del usuario) — al crear un producto que no existía (carga masiva por Excel o alta manual) se le pone `products.new_until = ahora + 10 días` (constante `NEW_TAG_DAYS` en `ProductsAdmin.jsx`; el usuario pidió "~1 semana, quizás un poco más"). Mientras `now() < new_until` el producto lleva el badge ✨ Nuevo y se puede filtrar por nuevos; después la etiqueta expira sola. **Detalle técnico de la carga masiva**: PostgREST exige que todas las filas de un upsert tengan las mismas columnas, así que `handleFile` separa en dos tandas — SKUs nuevos (con `new_until`) y existentes (sin él, para no re-etiquetar como nuevo un producto viejo al re-subir el archivo). Schema: columna `new_until timestamptz` nullable + `get_catalog` devuelve `is_new` calculado server-side (`now() < new_until`) en ambas ramas (normal y quote). Frontend cliente: badge verde arriba-derecha en `ProductCard.jsx` (derecha para no chocar con Pre-Order/Flash Sale que van a la izquierda), chip "✨ Nuevo" en `FilterBar.jsx` (estado `onlyNew` en `Catalog.jsx`, entra en `hasActiveFilters` así que también oculta Flash Sale al activarse; el chip "Todos" de esa fila resetea availability Y onlyNew juntos). Admin: badge + contador-chip + opción en el select de estado en `ProductsAdmin.jsx`, y el formulario de alta/edición tiene el campo "✨ Nuevo hasta" (`datetime-local`, el "apartado para ajustar fechas" de productos — dejar vacío quita la etiqueta). **Corrido en producción el 2026-07-09** vía `migration-2026-07-09-new-until.sql` (columna `new_until` + `get_catalog` con `is_new`) — sin eso el catálogo no recibía `is_new` y la creación de productos fallaba al insertar `new_until`.
29. **Buscador de producto en el alta individual de Flash Sale + badge Pre-Order rediseñado** (2026-07-09, mismo día, a pedido del usuario) — (a) El `<select>` del formulario "+ Flash Sale" listaba miles de productos y era inusable; se reemplazó por un buscador (nombre o SKU, mismos matches que `searchProducts`) que muestra hasta 30 resultados clickeables; al elegir uno queda fijado como chip con botón "Cambiar" (key i18n nueva `change`). Como ya no hay `<select required>`, `save()` valida `form.product_id` a mano y muestra `selectProduct` como error si falta. (b) El badge Pre-Order de `ProductCard.jsx` era tinta oscura sobre la imagen oscura del producto y se perdía; ahora es crema con texto tinta, anillo dorado y un puntito dorado pulsante (mismo lenguaje visual que el countdown de Flash Sale). **Dato no obvio**: usa los tonos de la paleta en **hex fijo** (`#f0e6c8`/`#16130d`/`#c9a227`/`#a3821a`) en vez de las clases del tema, porque la imagen de producto detrás es oscura en ambos temas (degradé fijo de `ProductImage`) pero `gold-pale` se vuelve oscuro en dark mode — con clases del tema el badge desaparecería de noche. Verificado con Playwright en ambos temas.
30. **Exportar Excel de productos sin foto** (2026-07-09, mismo día, a pedido del usuario) — junto al contador "📷 N sin foto" de la pestaña Productos hay ahora un botón "⬇️ Descargar Excel" (solo admin) que genera `zimaxx-productos-sin-foto-<fecha>.xlsx` vía `downloadMissingPhotosExcel()` en `src/utils/excel.js` (XLSX lazy, igual que los otros exports). **El formato es deliberadamente el mismo que acepta la carga "Fotos por Excel" de esa pestaña**: columnas `SKU` / `Nombre` / `Imagen` (vacía) — se completa la columna Imagen con los links y se re-sube el archivo tal cual, sin tocar encabezados. Round-trip verificado con Node + el xlsx real del proyecto: los encabezados normalizan a `sku`/`nombre`/`imagen`, todos alias de `IMAGE_COLS` en `ProductsAdmin.jsx`; filas aún sin link se cuentan como omitidas al subir (comportamiento ya existente del parser de fotos). Exporta el mismo conjunto que muestra el contador (todos los productos sin `image_url`, activos e inactivos), para que el número de filas coincida con el chip.
31. **Lista de precio + acceso admin para Luzmar Quintero (jefa de vendedoras)** (2026-07-09, a pedido del usuario) — dos cosas separadas, cada una con su propio archivo de migración chico (mismo criterio que la migración de `new_until`: evitar re-correr el `schema.sql` completo y su riesgo de deadlock). (a) **Lista de precio propia** (`migration-2026-07-09-luzmar-list.sql`, solo un INSERT — sin riesgo de lock, a diferencia de un ALTER TABLE): nueva fila `code = 'luzmar'` en `price_lists` (agregada también al seed de `schema.sql` para instalaciones nuevas), sin ninguna lógica de negocio especial como `quote`/`special` — es una lista de precio normal más, aparece sola en el selector "Lista" de `ClientsAdmin.jsx` porque ese selector ya lee `price_lists` dinámicamente de la base (no hubo que tocar el frontend de clientes). Se le sube Excel de precios igual que a cualquier otra en la pestaña Precios: se agregó a `LIST_ALIASES`/`LIST_ORDER` en `PricesUpload.jsx` (alias de columna: "Luzmar", "Luzmar Special", "Precio Luzmar", "Luzmar Especial") y al hint de i18n. (b) **Vista admin completa** (`migration-2026-07-09-luzmar-admin.sql`): insert en `admins` con su `user_id` (resuelto por email desde `auth.users`) — como `get_my_role()` chequea `is_admin()` antes que `is_vendedora()`, con esto ve todos los clientes/pedidos/vendedoras igual que cualquier admin, sin perder su fila de `vendedores` (sigue recibiendo clientes asignados y su teléfono sigue funcionando para el link de WhatsApp). No hubo que tocar código frontend para esta parte: el sistema de roles ya soportaba que una persona sea vendedora Y admin a la vez, solo faltaba la fila en la tabla. Requiere que ya exista su usuario en Supabase Auth (mismo que se usa para el login de vendedora).
32. **Garantía: cliente con lista "personal" siempre queda con su dueña** (2026-07-09, a pedido del usuario, tras preguntar "¿alguien puede ponerle la lista de Luzmar a un cliente y asignarlo a otra vendedora?" — la respuesta era sí, nada lo impedía) — se agregó el concepto de lista "personal": `price_lists.owner_vendedora_id` (nullable, FK a `vendedores`; migración `migration-2026-07-09-luzmar-owner-link.sql`, vincula `code = 'luzmar'` a la fila "Luzmar Quintero" por nombre). **Dos capas, no una sola**: (a) *UX en `ClientsAdmin.jsx`*: al elegir una lista con dueña en el alta de cliente, el campo Vendedora se reemplaza por texto fijo con su nombre (ya no es un select editable); en la edición inline de lista de un cliente existente (`updateList`) y en la carga masiva por Excel (`handleFile`), la vendedora se fuerza al dueño de la lista sin importar qué diga el formulario/archivo. Una vendedora sin rol admin además ni siquiera ve en su selector una lista personal ajena (`selectablePriceLists` filtra por `owner_vendedora_id === myVendedoraId`), para que no pueda auto-asignarse un cliente con precios que no le pertenecen. (b) *Garantía real en la base*: trigger `clients_enforce_owner_vendedora` (`before insert or update on clients`, función `enforce_owner_vendedora()`) que pisa `vendedora_id` con el dueño de la lista SIEMPRE que la lista tenga uno — cubre cualquier escritura que se le escape a la UI (API directa, script, etc.), no solo los tres caminos ya cubiertos en el frontend. La UI sigue siendo necesaria aparte del trigger: sin ella el cliente vería el campo Vendedora "aceptando" una selección que en realidad el trigger va a pisar en silencio, lo cual confundiría más que ayudar.
33. **Dos correcciones tras probar en producción** (2026-07-09, mismo día, a pedido del usuario, después de correr las migraciones de Luzmar). (a) *Filtro de listas seguía mostrando la lista ajena*: el usuario entró como una vendedora que no es Luzmar y vio "Luzmar - Precio Especial" en el filtro de listas de la pestaña Clientes — el candado del punto 32 solo se había aplicado al selector del alta de cliente, no a este otro `<select>` de `listFilter` (usaba `priceLists` sin filtrar). Corregido: también usa `selectablePriceLists`. (b) *WhatsApp no abría en iPhone*: el usuario notó que un teléfono de vendedora sin código de país "funciona" en WhatsApp Android (adivina el país del dispositivo) pero el link `wa.me` no abre el chat en iPhone — tuvo que agregar el código a mano. Se agregó `hasCountryCode()` en `format.js` (heurística: 11+ dígitos limpios) y se usa en tres puntos para que no vuelva a pasar: el alta y la edición inline de teléfono en `VendedoresAdmin.jsx` **bloquean** guardar un teléfono de menos de 11 dígitos con un mensaje explicando el porqué (hint permanente bajo el campo del alta); la carga de clientes por Excel (`ClientsAdmin.jsx`) descarta el teléfono de vendedora que venga sin código de país en vez de guardarlo roto (se cuenta y reporta en el resultado de la carga); y la tabla de Vendedoras muestra un ⚠️ junto a cualquier teléfono YA guardado que le falte el código, para pescar los que quedaron mal antes de este fix. El teléfono del cliente (no usado para WhatsApp, solo para identificarlo/deduplicar) no se tocó — el problema era específico del teléfono de vendedora, el único que arma el link `wa.me`.
34. **Etiquetas amigables + normalización para `product_line`** (2026-07-08, mismo día, a pedido del usuario) — el usuario aclaró que la idea era poder filtrar **directamente** para ver solo diseñador o solo árabes, no navegar una lista de valores crudos del Excel. Se agregó `parseLine()` en `ProductsAdmin.jsx` que normaliza al importar: cualquier valor con "arabe" (sin importar mayúsculas/acentos) → `'Perfume - Arabes'`, cualquier variante de "perfume"/"perfums" (typo real que aparece 1 vez en `119389.xlsx`) → `'Perfume'`; todo lo demás (Beauty, Electronics...) queda tal cual. Además, tanto `Catalog.jsx` como `ProductsAdmin.jsx` tienen ahora una función local `lineLabel(raw)` que traduce esos dos valores canónicos a `t('lineDesigner')`/`t('lineArabic')` ("Diseñador"/"Árabes") al mostrarlos en chips/selects/badges — el valor guardado en la base sigue siendo el texto en inglés (`'Perfume'`/`'Perfume - Arabes'`), solo cambia lo que se renderiza. No se compartió la función entre los dos archivos porque depende de `t()` (i18n), que ya está disponible en cada componente vía `useI18n()` — duplicar una función de 1 línea salió más simple que armar un helper compartido para eso.
35. **Infraestructura SQL para el sync SellerCloud → Supabase vía n8n** (2026-07-10, a pedido del usuario) — `migration-2026-07-10-sellercloud-sync.sql`, mismo criterio de migración chica e idempotente que las anteriores (sin re-correr `schema.sql`, `lock_timeout = '5s'`). Solo el lado base de datos: tabla `sync_runs` (auditoría de corridas: status running/ok/error + contadores + error_detail; RLS con lectura solo-admin, n8n escribe directo con la service_role key que bypassea RLS) y tres funciones SECURITY DEFINER ejecutables **solo por `service_role`** — `sync_upsert_products` / `sync_upsert_prices` / `sync_upsert_clients` (detalle en la sección RPC). Decisiones no obvias: (a) las tres replican el criterio de las cargas Excel existentes — upsert, **nunca delete** ni desactivación, para que un export parcial no mate datos; (b) en updates de productos los campos opcionales (`category`/`product_line`/`image_url`/`availability`) solo pisan si vienen con dato, y `new_until` no se toca (re-sincronizar no re-etiqueta ✨ Nuevo), pero productos nuevos sí entran con `new_until = +10 días` como el alta manual; (c) los tokens de clientes nuevos se generan server-side con `sync_generate_token()` — mismo alfabeto de 54 caracteres sin ambiguos de `token.js`, con entropía de `gen_random_uuid()` (RNG fuerte) y no `random()` de Postgres, porque el token es lo único que protege el catálogo; (d) `sync_upsert_clients` no maneja listas personales a propósito — el trigger `clients_enforce_owner_vendedora` (punto 32) ya corre en esos insert/update y pisa `vendedora_id`, así que duplicar esa lógica en la función solo crearía dos lugares que mantener; (e) `sync_upsert_prices` rechaza `code = 'quote'` con exception (esa lista no lleva precios, `PricesUpload.jsx` también la excluye). El workflow de n8n en sí NO está hecho; el orden esperado es: correr la migración → probar con los selects comentados al final del archivo → conectar n8n con la service_role key.
36. **Stock en la BD + disponibilidad automática por stock** (2026-07-14, a pedido del usuario — evolución de "en el catálogo se muestran productos sin inventario ni a la venta"). El primer intento de este día (borrador `migration-2026-07-14-inventory-active.sql`, **borrado**, nunca corrido) hacía que el inventario controlara `active`; el usuario lo replanteó: mejor **registrar el stock** en la BD (oculto en la app) y usarlo para decidir la disponibilidad, dejando activo/inactivo como decisión manual. Diseño final (confirmado con AskUserQuestion — el usuario eligió "stock solo decide disponibilidad" y "stock manda pero respeta flash", y aclaró que el stock negativo también es pre-order): (a) nueva columna `products.stock int` nullable (null = "no se sabe aún", distinto de 0 = sin stock), NO expuesta en `get_catalog`; (b) en cada carga/sync la disponibilidad se deriva del stock: `>= 1` → available, `0`/negativo → preorder, salvo que sea `flash` (Type = Flash Sale, entrante o ya guardado) que se conserva — el stock solo alterna available↔preorder; (c) `active` ya NO lo toca el sync (revierte el enfoque del borrador): es 100% manual (bulk, ver punto 37) + la exclusión de no-catálogo. Implementación: `migration-2026-07-14-inventory-stock.sql` (reescribe `sync_upsert_products` sobre la versión de no-catálogo — agrega `stock` al insert/update y deriva `availability` con `coalesce(entrante, existente) = 'flash'` para respetar flash; `active` fuera del insert/update) y `ProductsAdmin.jsx` (`COLS.inventory` + `parseStock()` + `resolveAvailability()` con la MISMA regla que el SQL, `hasInventory` guard — solo aplica si el archivo trae la columna). **Sólido ante campo ausente**: fila sin inventario → `stock`/`availability` no se pisan. **Sin backfill**: `products` no tenía la cantidad de stock hasta ahora, así que los productos sin stock ya cargados (por el Excel `119389.xlsx`, que NO trae columna de inventario — solo ProductID/UPC/PRODUCTBRAND/ProductName/GalleryImageURL/PRODUCT_CATEGORY) se corrigen recién en la primera corrida del sync con `InventoryAvailableQTY`, o se apagan a mano con el bulk mientras tanto. **Corrida**: `migration-2026-07-14-inventory-stock.sql` está en producción (confirmado por el usuario el 2026-08-04, verificado el 2026-08-12: `products.stock` existe); el n8n ya mapea `InventoryAvailableQTY` → `inventory`. El código ya se puede desplegar. Verificado: build limpio + tests de `parseStock()`/`resolveAvailability()` (0/negativo→preorder, ≥1→available, flash se conserva, JS idéntico al SQL) + selects de prueba comentados en la migración.
37. **Activar/desactivar productos en bloque (por casillas)** (2026-07-14, a pedido del usuario, mismo día que el punto 36) — `ProductsAdmin.jsx`: columna de casillas (solo admin) + casilla de encabezado que selecciona/deselecciona **todos los productos que pasan los filtros actuales** (no solo los renderizados por el scroll infinito — usa `filtered`, no `visibleRows`). Estado `selected` (Set de ids). Con 1+ seleccionados aparece una barra sticky con el conteo y botones Activar/Desactivar (`bulkSetActive(value)` → `supabase.from('products').update({active}).in('id', ids)`, limpia la selección y recarga) + Limpiar. También se agregó la columna **Stock** en la tabla (número, rojo si `<= 0`, "—" si null) y dos opciones de filtro por stock en el select de estado (Con stock `>= 1` / Sin stock `<= 0`), para identificar rápido qué apagar/prender. i18n nuevas: `stock`/`inStock`/`outOfStock`/`selected`/`selectAll`/`activate`/`deactivate`/`clearSelection`. Este bulk es la contraparte manual del punto 36: como el stock ya no apaga productos solo, el admin apaga/prende a mano (ej. los sin stock ya cargados hasta que corra el sync).
38. **UPC del producto en el admin** (2026-07-14, a pedido del usuario) — nueva columna `products.upc` (text nullable, `migration-2026-07-14-product-upc.sql`, que reescribe `sync_upsert_products` sobre la versión de stock del punto 36, agregando solo el `upc` con coalesce). Dato interno del admin: **no** lo expone `get_catalog` (como sku/stock). En `ProductsAdmin.jsx`: `COLS.upc` (alias `upc`/`barcode`/`ean`/`codigo de barras`) en la carga por Excel (`hasUpc` guard), campo UPC en el formulario de alta/edición, columna UPC en la tabla y sumado a la búsqueda de texto (nombre/SKU/UPC). Verificado contra `119389.xlsx`: la columna `UPC` se detecta y se lee (ej. `6290362349730`). El n8n, cuando se arme, debe mapear `UPC` → `upc` en el payload de `sync_upsert_products`.
39. **Reasignar y eliminar clientes con auditoría** (2026-07-14, a pedido del usuario) — dos acciones sensibles en la pestaña Clientes, **solo admin**, que quedan REGISTRADAS para saber qué usuario las hizo. Decisión de diseño clave: se hacen vía RPC SECURITY DEFINER (`reassign_client`/`delete_client`), NO con `update`/`delete` directos desde el frontend — así el insert en `admin_audit_log` (quién por `auth.uid()`+email, qué acción, snapshot del cliente, cuándo) es atómico e imposible de saltear. `migration-2026-07-14-client-admin-actions.sql` crea la tabla `admin_audit_log` (RLS: lectura solo admin, la escriben solo esas funciones) + las dos RPC. **Reglas**: `reassign_client` (p_vendedora_id null = sin asignar) rechaza clientes con lista personal (`owner_vendedora_id` — el trigger `clients_enforce_owner_vendedora` lo revertiría igual, mejor error claro); `delete_client` rechaza si el cliente tiene pedidos (`orders.client_id` es FK RESTRICT sin cascade y `orders` no guarda copia del nombre → borrarlo perdería el historial de ventas; el admin puede reasignar pero no borrar esos). **Frontend** (`ClientsAdmin.jsx`): la columna Vendedora pasó de texto estático a un `<select>` de reasignación por fila (salvo lista personal, que queda estática); botón "Eliminar" con confirmación inline (Sí/No en la misma fila, no `window.confirm`); banner de error arriba de la tabla para los `raise exception` de las RPC; y una sección colapsable "🛡️ Registro de movimientos" (solo admin) que lee `admin_audit_log` (fecha, email del usuario, acción, cliente, detalle — reasignación muestra "de → a", borrado muestra tel/vendedora/lista). i18n nuevas: `deleteAction`/`deleteConfirmClient`/`yes`/`no`/`reassign`/`activityLog`/`user`/`action`/`actionReassign`/`actionDelete`/`noActivity`. **Decisión señalada**: admin-only porque reasignar a OTRA vendedora y borrar son inherentemente acciones de gestión del equipo; si más adelante se quiere que una vendedora pueda algo de esto, se ajustan las RPC. Verificado: build limpio (la lógica admin real requiere sesión autenticada, no probable en el sandbox — mismo criterio que otros cambios admin-only).
40. **Flash Sales oculto para vendedora + lista "personal" solo para su dueña** (2026-07-15, a pedido del usuario, correcciones antes de armar la creación de otros accesos de vendedora) — dos huecos de acceso detectados sobre lo ya construido. (a) *Flash Sales*: `AdminLayout.jsx` armaba esa pestaña para cualquier rol autenticado (a diferencia de Vendedoras, que ya estaba `isAdmin`-gated); se cambió a `...(isAdmin ? [...] : [])` igual que Vendedoras, y se sumó `/admin/flash` al mismo `if` de redirect que ya protegía `/admin/vendedoras` por URL directa. No se tocó RLS de `flash_sales` (blanket `is_vendedora()` sigue igual) porque las ofertas no son un dato sensible por vendedora — son las mismas que ve cualquier cliente vía `get_flash_sales()` público; acá el pedido era puramente ocultar la pestaña. (b) *Lista "personal" (`luzmar`)*: `ClientsAdmin.jsx` ya filtraba `selectablePriceLists` para que una vendedora no-dueña no pudiera **asignar** un cliente a esa lista (punto 32/33), pero la matriz de `PricesUpload.jsx` y su selector de listas no tenían ningún candado — mostraban la columna/precio real de Luzmar a cualquier vendedora, porque `vendedora_select_readonly` daba a **cualquier** vendedora `select` de **toda** `price_lists`/`product_prices` sin distinguir dueña. Se sacó `price_lists`/`product_prices` del loop genérico de esa policy y se agregaron dos policies propias (`vendedora_select_price_lists`/`vendedora_select_product_prices`) que exigen `owner_vendedora_id is null or owner_vendedora_id = current_vendedora_id()` — la fila de `luzmar` directamente no viene en la respuesta de Supabase para el resto, así que ni la matriz ni el selector necesitaron tocarse (ya renderizan lo que Supabase les da). `migration-2026-07-15-restrict-vendedora-luzmar.sql`, mismo criterio idempotente + `lock_timeout` corto que las anteriores — **nunca se corrió y ya no hace falta**: quedó reemplazada por `migration-2026-08-04-shared-price-lists.sql` (corrida el 2026-08-04), que deja las mismas dos policies ya adaptadas a listas con varias dueñas, así que el blanket viejo quedó cerrado igual. `schema.sql` también se actualizó para que una instalación nueva nazca con la policy correcta. Frontend: nada nuevo, ya filtraba lo suficiente en `ClientsAdmin.jsx`. Verificado: build limpio; no se pudo probar en vivo con una segunda vendedora real (requiere producción), la garantía real vive en RLS igual que el resto del rol vendedora.
41. **Registro de movimientos en panel propio + crear accesos de vendedora desde el admin** (2026-07-15, mismo día que el punto 40, a pedido del usuario) — dos cosas separadas. (a) *Panel propio*: el Registro de movimientos (auditoría de reasignar/eliminar clientes, punto 39) vivía como sección colapsable al fondo de `ClientsAdmin.jsx`; se pidió que fuera un panel aparte, entre Clientes y Vendedoras. Se creó `AuditLogAdmin.jsx` (carga directo al montar, sin toggle — ya no hace falta ocultarlo dentro de otra pestaña) con la misma tabla/estilos que tenía la sección vieja, ruta `/admin/audit`, y se sacó todo el estado/JSX de auditoría de `ClientsAdmin.jsx`. `AdminLayout.jsx`: nueva pestaña `isAdmin`-gated entre Clientes y Vendedoras, y `/admin/audit` sumado al mismo redirect que ya protegía `/admin/vendedoras`/`/admin/flash` si una vendedora entra por URL directa. (b) *Crear accesos de vendedora*: hasta ahora `VendedoresAdmin.jsx` solo podía **vincular** (`link_vendedora_login`) un usuario de Supabase Auth ya creado a mano en el dashboard — el usuario pidió poder **crearlo** directo desde el panel. Se le preguntó al usuario cómo debía funcionar la contraseña inicial (AskUserQuestion: admin la escribe / se genera sola y se muestra una vez / invitación por email) y eligió **"el admin la escribe"** — mismo criterio que ya usa con el link del catálogo (se la pasa por WhatsApp, sin depender de que un email de invitación llegue o no). Crear un usuario CON contraseña requiere la Admin API de GoTrue (`auth.admin.createUser`), que solo acepta la **service_role key** — nunca se puede llamar desde el navegador, así que no podía ser una RPC de Postgres como `link_vendedora_login` (esa sí, porque solo lee/escribe tablas normales). Se armó `supabase/functions/admin-create-vendedora-user/index.ts`, la primera Edge Function del proyecto (antes solo se había *analizado* una para SellerCloud, nunca implementada — ver Roadmap): valida que quien llama sea admin llamando a la RPC `is_admin()` ya existente **con el JWT de quien llama** (no con la service_role key, para no duplicar esa regla en dos lugares), crea el usuario (`email_confirm: true`, no hace falta que confirme el email — no hay flujo de email configurado en este proyecto) y en el mismo paso vincula `vendedores.user_id`/`login_email`; si el link fallara por lo que sea, borra el usuario recién creado para no dejar un usuario de Auth huérfano sin vendedora asociada. Frontend: `VendedoresAdmin.jsx` — en la columna Acceso, si no hay login vinculado, aparecen dos caminos: el "Vincular acceso" que ya existía (para un usuario que ya existe en Auth) y un link nuevo "+ Crear acceso" que abre un formulario chico inline (email + contraseña, mínimo 6 caracteres) y llama `supabase.functions.invoke('admin-create-vendedora-user', ...)`. Manejo de error no obvio: `functions.invoke` de supabase-js, ante una respuesta no-2xx, devuelve un `FunctionsHttpError` cuyo `.message` es genérico ("Edge Function returned a non-2xx status code") — el mensaje real que arma la función (ej. "esta vendedora ya tiene un acceso vinculado") hay que leerlo de `error.context.json()`, no de `error.message` directo. **Ya desplegada** (verificado el 2026-08-12: `POST /functions/v1/admin-create-vendedora-user` devuelve `403`, o sea que existe y rechaza por falta de JWT; una función no desplegada daría `404`). Como toda Edge Function no se auto-despliega — hubo que correr `supabase functions deploy admin-create-vendedora-user` una vez (con `supabase login`/`supabase link` si es la primera función del proyecto). No hacen falta secrets nuevos: `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` ya vienen inyectadas por el runtime de Edge Functions. Verificado: build limpio; no se pudo probar la Edge Function en vivo (necesita estar desplegada en un proyecto real de Supabase, imposible en este sandbox) — mismo criterio que el resto de features que dependen de producción.
42. **Estado "Cancelado" para pedidos** (2026-07-15, mismo día que los puntos 40/41, a pedido del usuario — "por si las órdenes son armadas pero después las cancelan") — `orders.status` solo aceptaba `'new'`/`'done'` (CHECK constraint `orders_status_check`, agregado en el punto 8 del ciclo de vida original). Se sumó `'cancelled'`. Diseño: en vez de convertir el botón único "Marcar atendido ↔ Reabrir" en un `<select>` de 3 estados, se mantuvo el patrón de botones existente pero condicionado — un pedido `new` (el default) muestra **dos** botones, "Marcar atendido" y "Cancelar" (ambos parten de Nuevo, ninguno tiene sentido para el otro); un pedido `done` o `cancelled` muestra un solo botón "Reabrir" que vuelve a `new` (mismo texto/acción que ya existía, ahora también sirve para deshacer una cancelación). Badge de estado con color propio para cada uno (`STATUS_STYLES` en `OrdersAdmin.jsx`, mismo patrón que `STATUS_STYLES` de `FlashSalesAdmin.jsx` — rojo para cancelado). El filtro de estado de la pestaña Pedidos suma la tercera opción. **Nada de RLS nuevo**: la policy `vendedora_update_own_orders` (punto 12) ya permite a una vendedora actualizar cualquier campo de sus propios pedidos, así que puede cancelar/reabrir los suyos igual que ya podía marcar atendido — es el mismo nivel de confianza que ya existía, no uno nuevo. El contador de pedidos sin atender del menú admin (`AdminLayout.jsx`) sigue contando solo `status = 'new'`, sin cambios. `migration-2026-07-15-order-status-cancelled.sql`: solo recrea el CHECK constraint (drop + add), no toca filas — **corrida en producción** (confirmado por el usuario el 2026-08-12); hasta que corrió, intentar cancelar un pedido fallaba contra la base (constraint viejo lo rechazaba). `schema.sql` también actualizado (el `ADD COLUMN IF NOT EXISTS ... CHECK (...)` original no se vuelve a aplicar en una instalación ya existente, así que el CHECK se separó en su propio `ALTER TABLE ... ADD CONSTRAINT`, drop+create, para que quede correcto tanto en instalaciones nuevas como reaplicando el schema). Verificado: build limpio.
43. **Vendedora puede cambiar la lista de precio de sus clientes (con confirmación) + filtros en el Registro de movimientos** (2026-07-15, mismo día que los puntos 40/41/42, a pedido del usuario) — dos cosas relacionadas. (a) *Cambiar lista*: hasta ahora, cambiar `clients.price_list_id` desde `ClientsAdmin.jsx` era un `update` directo contra la tabla, mostrado solo si `isAdmin` — una vendedora no tiene (ni tenía) ninguna policy RLS de UPDATE en `clients` (solo `select`/`insert` de lo suyo), así que ni habilitando el control en la UI hubiera funcionado. Se creó la RPC `update_client_price_list(p_client_id, p_price_list_id)`: permite admin (cualquier cliente) o vendedora (solo si `client.vendedora_id = current_vendedora_id()`), rechaza que una vendedora asigne una lista "personal" ajena (mismo candado que ya existía en `selectablePriceLists` del frontend, reforzado server-side), y **audita el cambio en `admin_audit_log`** con acción `update_price_list` — algo que el `update` directo de antes NUNCA había registrado, ni siquiera para admin. Frontend: se agregó **confirmación antes de aplicar** (a pedido explícito del usuario: "se abre el dropdown, seleccionás una opción y sale una alerta, ¿estás seguro?, confirmar o cancelar") — en vez de un `window.confirm()` nativo (el proyecto ya evita esos, ver el patrón Sí/No inline de "Eliminar cliente"), se armó `ListPicker` (componente nuevo, top-level en `ClientsAdmin.jsx` — no anidado adentro del componente de la pestaña, porque un componente definido dentro de otro se recrea en cada render y podría perder foco/estado): elegir una opción no dispara el cambio, deja un `pendingList = {clientId, listId}` y muestra un cartel "¿Cambiar la lista a X?" con Confirmar/Cancelar; cancelar no hace nada (el `<select>` es controlado y vuelve solo al valor viejo). Mismo componente reusado para admin (con `priceLists`, todas las listas) y vendedora (con `selectablePriceLists`, sin las personales ajenas) — antes una vendedora ni veía un selector acá, ahora sí. **Decisión importante**: el campo "$ inversión → nivel" (auto-aplica el nivel según el monto, solo admin) sigue siendo instantáneo, SIN confirmación — el pedido del usuario era específicamente sobre el dropdown, y ese campo está pensado para carga rápida (Enter/blur aplica al toque); agregarle fricción hubiera roto ese flujo a propósito. `migration-2026-07-15-vendedora-update-price-list.sql` — **corrida en producción** (confirmado por el usuario el 2026-08-12) **y era rompedora hasta que corrió**: como el frontend ya no usa el `update` directo (fue reemplazado por completo por la RPC), cambiar la lista de un cliente fallaba para CUALQUIERA, admin incluido. De paso se detectó y corrigió un gap viejo: `admin_audit_log` (tabla + RLS `admin_read_audit`), creada en `migration-2026-07-14-client-admin-actions.sql`, nunca se había mergeado de vuelta a `schema.sql` — se agregó ahí también, porque la RPC nueva la necesita para que una instalación nueva desde cero funcione (ver Roadmap: `schema.sql` viene atrasado desde el sync de SellerCloud, 2026-07-10; no se intentó reconciliar todo lo demás en esta sesión, sería un cambio grande aparte). (b) *Filtros en el Registro de movimientos*: `AuditLogAdmin.jsx` (recién creado en el punto 41 el mismo día) sumó selector de usuario (emails distintos entre las filas ya cargadas, mismo patrón que el filtro de vendedora de `OrdersAdmin.jsx`), selector de acción (Reasignación/Eliminación/**Cambio de lista**, esta última nueva por (a)) y rango de fechas (`dateFrom`/`dateTo`, dos `<input type="date">`, comparados contra `created_at.slice(0, 10)` — alcanza porque son fechas ISO). El límite de filas cargadas subió de 100 a 200 (mismo criterio que "Últimos 200" de Pedidos) para que los filtros tengan más para trabajar; sigue sin ser fetchAll completo, así que un filtro de fecha muy viejo puede no traer nada si esas filas ya cayeron fuera de la ventana de 200 — no se pidió paginación completa y hubiera sido sobre-ingeniería para el alcance de este pedido. Verificado: build limpio; no se pudo probar en vivo el flujo de confirmación ni la RPC (requieren producción).
44. **Clientes duplicados por formato de teléfono (con/sin código de país)** (2026-07-15, mismo día, reportado por el usuario: "hubo un duplicado de algunos clientes debido a que algunos tenían el número con el código de país y otros el mismo número pero sin el código") — el usuario corrió el query de diagnóstico que se le dio (agrupar por `right(regexp_replace(phone, '\D', '', 'g'), 10)`, los últimos 10 dígitos) y devolvió **~45 pares duplicados**, todos con un patrón idéntico: la fila vieja (creada 2026-07-02, con teléfono `51...` — código de país de Perú — y con lista de precio/vendedora/a veces pedidos) y una fila nueva (creada 2026-07-15 16:09:03.365952+00, **exactamente el mismo timestamp en las ~45 filas** — la huella de una corrida en lote, no de altas manuales separadas —, con el mismo teléfono SIN el `51`, `price_list_id` null y 0 pedidos). Ese patrón (`price_list_id` null en el insert, timestamp idéntico en lote) es exactamente el comportamiento documentado de `sync_upsert_clients` (punto 35): **evidencia fuerte, aunque no confirmada explícitamente por el usuario, de que el workflow de n8n del sync SellerCloud→Supabase ya está corriendo en producción** — el Roadmap decía "el workflow de n8n en sí NO está hecho", hay que confirmar con el usuario si esto cambió sin que quedara registrado acá. **Causa raíz encontrada en dos lugares con el mismo bug** (comparar el teléfono como string completo en vez de por el número nacional real): (a) `ClientsAdmin.jsx` (`handleFile`, carga por Excel) — corregido en el commit anterior de esta misma sesión (ver memoria de esa conversación) con `phoneKey(phone) = cleanPhone(phone).slice(-10)`, ya usado en el `Map` de matching y en el chequeo previo al insert de "+ Nuevo cliente". (b) `sync_upsert_clients` (SQL, `migration-2026-07-10-sellercloud-sync-v2.sql`) — el paso de "adopción one-shot por teléfono" (línea `regexp_replace(phone, '\D', '', 'g') = v_phone`) tenía el mismo problema: si SellerCloud manda el teléfono sin el `51` y la fila ya cargada lo tiene, no la encuentra y crea un cliente nuevo con `sellercloud_id` seteado — origen real de los ~45 duplicados. `migration-2026-07-15-fix-duplicate-client-phones.sql` hace tres cosas en orden: (1) **adopta** el `sellercloud_id` de cada fila "basura" (sin lista, sin pedidos, creada por el sync) en la fila real correspondiente, ANTES de borrar — así queda vinculada ya mismo, sin depender de la próxima corrida del sync; (2) **borra** las filas basura, con una regla deliberadamente conservadora (`price_list_id is null` AND `sellercloud_id is not null` AND cero pedidos AND existe otra fila con el mismo teléfono normalizado que sí tiene lista) — si alguien ya le asignó lista a mano a una de esas filas antes de correr la migración, la condición (a) la excluye del borrado sola, sin arriesgar perder trabajo manual; (3) recrea `sync_upsert_clients` (mismo cuerpo que la v2, único cambio real: la adopción por teléfono ahora compara `right(...,10)` en vez del string completo) y agrega un **índice único** `clients_phone_normalized_key` sobre el teléfono normalizado — con los duplicados ya limpios, este índice blinda a nivel de base de datos contra que el bug vuelva a colarse por CUALQUIER camino (Excel, alta manual, o el sync), no solo por los dos que ya se corrigieron a mano; un intento de insertar un teléfono que ya existe en otro formato choca con `unique_violation`, que `sync_upsert_clients` ya atrapaba (cuenta en `phone_conflicts`, no tumba la corrida) y que el frontend ya evita de entrada con `phoneKey()`. **Por qué el número nacional son los últimos 10 dígitos, no una cantidad fija por país**: tanto US/Canadá (código "1", número nacional de 10 dígitos) como Perú (código "51", visto en esta corrida real) como Venezuela (código "58" o troncal "0", número nacional de 10 dígitos) coinciden en que el número nacional real son 10 dígitos — no hizo falta detectar/mapear el código de cada país, solo ignorarlo al comparar. **Corrida en producción** (verificado el 2026-08-12: `clients.allow_shared_phone` existe) — era urgente porque, con el sync activo, **cada corrida nueva seguía creando más duplicados** con el mismo patrón. Verificado: la query de diagnóstico y el análisis del patrón se hicieron sobre el resultado real que pegó el usuario (no en un sandbox); la migración en sí no se pudo ejecutar ni verificar en vivo (requiere producción, y este entorno no tiene la service_role key ni acceso directo a la base).

45. **Fix del orden de `migration-2026-07-15-fix-duplicate-client-phones.sql` + backup** (2026-07-15, mismo día, continuación del punto 44 — el usuario corrió la migración y reportó `ERROR: duplicate key value violates unique constraint "clients_sellercloud_id_key"`; el análisis de esta sesión retomó después de una falla eléctrica que cortó la sesión anterior a mitad de este mismo arreglo). **Causa real**: el orden original (adoptar el `sellercloud_id` en la fila real ANTES de borrar la fila basura) deja, durante el mismo `UPDATE`, un instante en el que la fila real y la fila basura comparten el mismo `sellercloud_id` — el índice único lo rechaza ahí mismo, no hace falta llegar al `DELETE`. **Fix**: se reescribió en una transacción explícita (`begin`/`commit`, las tablas temporales son `on commit drop` así que tienen que sobrevivir hasta el commit final) con el orden invertido: (1a) capturar en tablas temporales (`_dup_merge_map`/`_dup_junk_ids`) qué fila borrar y a quién adoptar, sin tocar nada todavía; (1b) borrar primero las filas basura (libera el valor en el índice único); (1c) recién ahí copiar el `sellercloud_id` capturado a la fila real, cuando ya no hay ningún choque posible. Además, a pedido explícito del usuario, se agregó un paso de backup antes de tocar nada: `create table public.clients_backup_20260715 as select * from public.clients` (tabla normal, no temporal, para poder inspeccionar o revertir a mano después del commit; se borra manualmente una vez confirmado que todo quedó bien). **Caso borde documentado, no resuelto en este archivo**: el `distinct on (k.id)` de `_dup_merge_map` evita que una misma fila real reciba dos `sellercloud_id` distintos, pero no cubre lo inverso — si dos filas reales vivas (ambas con lista de precio, ninguna con `sellercloud_id`) compartieran el mismo teléfono normalizado, ambas competirían por adoptar el mismo `sellercloud_id` y el `UPDATE` volvería a chocar contra el índice único. Se le señaló al usuario como riesgo de datos preexistente (no algo que cause el sync), pendiente de confirmar con un SELECT antes de correr si se quiere descartar del todo. **Resuelto**: la versión actual del archivo (no la que falló) se corrió en producción y quedó verificada el 2026-08-12 — `clients.allow_shared_phone` existe.

46. **Descuento de stock al atender un pedido + disponibilidad dinámica + aviso y limpieza del carrito** (2026-08-04, a pedido del usuario, tres cosas en una tanda). El disparador fue de negocio: el catálogo arrastra inventario de una de las primeras cargas ("hace mucho tiempo y no está completamente al día"), así que hay productos que se muestran Disponibles cuando ya se agotaron, y dos clientes pueden pedir la misma mercadería. **(a) Descuento de stock**: marcar un pedido como Atendido resta sus cantidades de `products.stock` (ejemplo textual del usuario: stock 20 de Adidas Fresh, un cliente pide 10, la asesora lo marca Atendido → queda 10). Va en `update_order_status` vía el helper nuevo `apply_order_stock(p_order_id, p_direction)` — `-1` descuenta, `+1` devuelve —, y el movimiento queda en `admin_audit_log.detail->'stock'` con SKU, cantidad y antes/después de cada producto. **Tres decisiones que se le preguntaron al usuario con AskUserQuestion antes de escribir código**, porque cada una cambiaba el comportamiento de raíz: (1) *qué descuenta* → **solo pedidos reales** (`kind = 'order'`); una cotización no toca el stock, y si pasa a pedido con `convert_quote_to_order`, descuenta cuando ESE pedido se marca Atendido (respuesta literal del usuario). El motivo de fondo: el botón "Descargar PDF" del carrito crea una cotización (2026-07-17), así que un cliente bajando 5 PDF mientras mira el catálogo habría vaciado el inventario solo. (2) *reversa* → **reabrir o cancelar devuelve el stock**, para que marcar Atendido por error se pueda deshacer; volver a marcarlo descuenta otra vez, nunca dos veces. La idempotencia la garantiza la columna nueva `orders.stock_applied` (boolean), **no** el estado — un pedido puede ir done → new → done varias veces. (3) *productos con `stock` null* → **se saltean**, no se puede restar de un dato que no existe; se cuentan aparte en `skipped` y el panel lo muestra ("N sin dato de stock"). **(b) Disponibilidad derivada del stock, por trigger**: la regla "stock 0 → Pre-Order, stock ≥ 1 → Disponible, flash se conserva" ya existía pero vivía **duplicada** en cada camino de escritura (`sync_upsert_products` en SQL y `resolveAvailability()` en `ProductsAdmin.jsx`, con el comentario explícito de "cambiar una implica cambiar la otra") y encima `apply_price_list` la pisaba sin querer: un Excel de precios sin columna `Type` dejaba `availability = 'available'` a todos sus productos, con stock 0 incluido. Se agregó el trigger `products_availability_from_stock` (`before insert or update on products`) que la convierte en invariante de la tabla — mismo criterio que `clients_enforce_owner_vendedora` (punto 32): la garantía vive en la base, no en cada llamador. Con eso, el descuento del punto (a) no calcula disponibilidad: solo mueve `stock` y el trigger hace el resto, así el resultado es idéntico venga el cambio del sync, del Excel, del bulk, del formulario o de un pedido atendido. Como el stock también puede quedar **negativo** (pedido que supera lo disponible), eso también es Pre-Order — el usuario ya había decidido eso en el punto 36. Se agregó además **campo Stock editable** en el formulario de la pestaña Productos: sin él no había forma manual de reponer y sacar un producto de Pre-Order ("hasta que llegue stock y se vuelva a poner como disponible"), porque el stock solo entraba por Excel o por el sync. **(c) Aviso en el carrito + limpieza**: bloque de advertencia arriba de la lista de ítems (y repetido en el diálogo de confirmación) de que disponibilidad y precio están sujetos a cambio y hay que confirmarlos con la asesora; y el carrito se **vacía** al enviar el pedido por WhatsApp o al generar la cotización con el PDF, mostrando un acuse ("Pedido registrado" / "Cotización generada" + botón "Armar otro pedido") en lugar de "carrito vacío". Detalle no obvio del pedido del usuario ("que no quede guardado en el cache del dispositivo"): `CartContext` ahora **borra** la clave de `localStorage` cuando el carrito queda vacío, en vez de guardar un `[]` — el link del catálogo se comparte por WhatsApp y se abre en teléfonos que a veces no son del cliente. `handlePdf` pasó a ser `async` y espera el `create_order` para saber si avisar del fallo (el PDF ya se descargó antes, así que no bloquea nada), y los dos botones se deshabilitan mientras la operación corre. **Bug preexistente encontrado y corregido de paso**: la key de i18n `inStock` estaba **duplicada** (línea 9 catálogo "Disponible", línea 118 admin "Con stock") y la segunda pisaba a la primera, así que el chip de disponibilidad del catálogo del cliente decía "Con stock" en español; la del admin pasó a `withStock`. También se quitó una key `deactivate` duplicada (mismo valor, solo ruido). Ambas generaban warnings de build que ahora no están. `migration-2026-08-04-order-stock.sql`, **corrida en producción** (verificado el 2026-08-12: `orders.stock_applied` existe) — requería `migration-2026-07-17-orders-edit-live-quotes.sql` antes, porque reescribe funciones que aquella crea, y esa ya estaba. **Verificado de verdad, no solo build**: además del `npm run build` limpio, la lógica SQL se probó contra un **PostgreSQL 18 real** — se levantó un cluster desechable en el scratchpad con `initdb`/`pg_ctl` en el puerto 55432 (el servicio local del usuario no se tocó), se recreó el esquema mínimo con stubs de `auth.uid()`/`is_admin()`, y se corrieron 16 casos: el ejemplo exacto del usuario, producto repetido en dos líneas (6+4 = 10, para confirmar que el agrupado por producto no pierde una), agotarse a 0 → Pre-Order, reponer → Disponible solo, `flash` conservado con stock 0, `stock` null salteado, producto inexistente salteado, doble Atendido idempotente, reabrir y cancelar devolviendo, sobrepedido a −5, cotización que no mueve nada, el borde de cotización-ya-atendida al convertir, y los tres updates directos contra el trigger (bloquea `stock_applied` y `status`, permite uno inocuo). El cluster quedó borrado. Lo único que **no** se pudo probar en vivo es el frontend autenticado del panel (requiere producción, mismo criterio que el resto de features admin-only). **Corrección del mismo día, importante**: la primera versión de esta entrada decía que el descuento "no tenía de dónde restar" porque `products.stock` estaría en null para todos, basándose en que este doc listaba `migration-2026-07-14-inventory-stock.sql` como pendiente. **El usuario aclaró que el flujo de n8n ya está corriendo y actualizando el stock constantemente**, o sea que esa migración ya se había corrido y el doc había quedado atrás (nadie lo marcó al correrla). El dato de entrada existe, y esta migración también quedó corrida.

**Cómo convive el descuento con el sync (la pregunta que abrió esto, respondida por el usuario)**: se le planteó que el resync completo de n8n (dos veces al día) pisa `products.stock` con el `InventoryAvailableQTY` de SellerCloud, y que por lo tanto el descuento se pierde en la próxima corrida si la orden todavía no se cargó en SellerCloud. Se le ofrecieron tres caminos (columna `reserved` que sobreviva al sync, con o sin liberación automática, o dejarlo como está). **Eligió dejarlo como está, y explicó el por qué del diseño**: el descuento existe justamente "para no tener que traer lo que viene del inventario cada 5 min para que siempre esté al día". El flujo acordado es: la asesora marca la orden Atendida → **acto seguido monta la orden de compra en SellerCloud** → mientras tanto, el sistema ya restó el stock internamente y el catálogo está protegido → la próxima corrida de n8n trae el número real de SellerCloud, que **reemplaza** (no suma) el valor de la base. Textual del usuario: "lo que venga de sellercloud no se suma a lo que quedó en la base de datos, sino que un valor reemplaza al otro, es decir, el de sellercloud reemplaza al valor que está en la base de datos". Eso **ya es el comportamiento de `sync_upsert_products`** (`stock = coalesce(v_stock, p.stock)`: si la fila trae inventario lo asigna, nunca acumula), así que no hubo que tocar nada — el descuento es un puente de vida corta que cubre el hueco entre "cerrada en la app" y "cargada en SellerCloud", y SellerCloud sigue siendo la fuente de verdad. Con el trigger `products_availability_from_stock`, apenas el sync reemplaza el stock la disponibilidad se recalcula sola. **Consecuencia aceptada explícitamente por el usuario, no un bug**: si una asesora marca Atendido y NO carga la orden en SellerCloud, la próxima corrida del sync devuelve el stock viejo y la protección se pierde — el flujo depende de que ese segundo paso se haga. Si algún día eso se vuelve un problema real, la opción ya diseñada es la columna `reserved` (el descuento suma ahí en vez de tocar `stock`, y la disponibilidad se calcula con `stock - reserved`).

47. **Listas de precio compartidas entre varias vendedoras** (2026-08-04, a pedido del usuario: "que sea una lista compartida entre luzmar y otra vendedora"). Arrancó como una pregunta chica — "¿cómo le asigno la lista de Luzmar a otra vendedora, se puede por SQL Editor?" — y la respuesta honesta era que con el modelo de entonces **no**: `price_lists.owner_vendedora_id` era **una sola** uuid, así que solo había dos caminos, los dos malos: transferir la lista (Luzmar la perdía, y sus clientes quedaban con ella mientras la lista pasaba a otra) o poner la columna en null (la lista se volvía general y la veían TODAS las vendedoras en la matriz de Precios). Se le ofrecieron las dos como queries y se le avisó que "compartida entre dos" pedía un cambio de esquema; pidió el cambio de esquema. **Diseño**: la columna se reemplaza por la tabla `price_list_owners (price_list_id, vendedora_id, is_primary, created_at)` con PK compuesta, y la columna vieja **se dropea** — a propósito, no se deja "por si acaso": dos fuentes de verdad para un candado de acceso es exactamente cómo se cuela un bug (un lector que se olvide de la tabla nueva y siga leyendo la columna vería "lista general" y saltearía el candado); dropeándola, cualquier código que quede leyéndola falla fuerte y claro. Tres estados posibles ahora: sin filas = lista general, una fila = lista personal (**comportamiento idéntico al anterior**, por eso la migración sola no cambia nada funcional), varias = lista compartida. **Decisión clave: `is_primary`** (una sola por lista, índice único parcial `where is_primary`). Sin ella, el trigger no tendría qué hacer cuando un cliente entra a una lista compartida con una vendedora que no es dueña (ej. el admin mueve un cliente de Maria a la lista compartida): la alternativa era tirar excepción y obligar a elegir en cada camino de escritura (Excel, sync, RPC, formulario), donde cualquier olvido rompe una carga entera. Con dueña principal hay default sano, ningún camino se rompe, y con una sola dueña el comportamiento es exactamente el de antes. **Regla del trigger reescrito** (`enforce_owner_vendedora`): lista sin dueñas → no toca nada; la vendedora que viene ya es dueña → **se respeta** (esto es lo que permite repartir los clientes de una lista compartida entre sus dueñas); si no → se fuerza la principal. **Bug propio encontrado por las pruebas y corregido**: la primera versión del trigger tenía un early-return para los updates que no tocaban `price_list_id`/`vendedora_id` (razonando que un cambio de nombre no tiene por qué reescribir la asignación). La prueba 18 lo destapó: al quitarle una co-dueña a la lista, sus clientes quedaban asignados a alguien que ya no es dueña y **ninguna escritura posterior los corregía** — encima rompía el truco de "tocar la fila para re-aplicar la regla" (`update clients set vendedora_id = vendedora_id`) que se le había dado al usuario en la respuesta anterior. Se quitó el early-return: el trigger corre en todo insert/update, y como la regla respeta a cualquier dueña, correr siempre no pisa nada legítimo, solo endereza lo inconsistente. Se agregaron al archivo los queries para detectar filas inconsistentes y pasarlas a la principal. **Helpers nuevos**, todos SECURITY DEFINER porque los usan las policies RLS y el trigger (si dependieran del permiso del que pregunta, la policy se muerde la cola): `price_list_has_owners`, `is_price_list_owner`, `price_list_primary_owner` (revoke a public, uso interno) y `can_vendedora_use_price_list`, que es la regla única que aplican las policies. **RLS**: `vendedora_select_price_lists`/`vendedora_select_product_prices` pasan a usar el helper, y `price_list_owners` nace con `admin_all` + lectura para la vendedora limitada a las listas que puede usar (nadie escribe desde la app: agregar/quitar dueñas es por SQL). Esta migración **reemplaza a `migration-2026-07-15-restrict-vendedora-luzmar.sql`**, que nunca se corrió — no hace falta correrla más. **RPC tocadas**: `reassign_client` ahora acota el destino a las dueñas de la lista en vez de rechazar de plano (era lo que impedía repartir clientes entre co-dueñas), y `update_client_price_list` cambia el chequeo de lista ajena a los helpers. **Frontend** (`ClientsAdmin.jsx`): `fetchAll('price_lists', '*, price_list_owners(vendedora_id, is_primary)')` trae las dueñas embebidas; `ownerVendedoraId()` se reemplaza por `listOwners()`/`primaryOwner()`/`ownerFor()` (este último es el espejo exacto del trigger, y se usa en la carga por Excel, el alta individual y el parche optimista de `updateList`); `selectablePriceLists` filtra por membresía; el alta de cliente muestra texto fijo con una dueña y un **selector acotado a las dueñas** con dos o más (key i18n nueva `sharedListOwners`); y la columna Vendedora de la tabla pasa a select acotado a las dueñas cuando la lista es compartida (con una sola dueña sigue siendo texto fijo, no hay nada que elegir). De paso se arregló que el parche optimista de `updateList` no actualizaba el nombre embebido (`vendedores`), así que la columna mostraba la vendedora vieja hasta la próxima recarga. **Agregar la segunda dueña es un `insert` que quedó comentado al final del archivo de migración** (con los queries para quitar una dueña, cambiar cuál es la principal, y verificar) — no se hizo UI porque no se pidió. **Verificado contra PostgreSQL 18 real** (cluster desechable en el scratchpad, borrado después): se recreó el estado previo exacto de producción (columna vieja + trigger viejo + policies blanket + las RPC de 2026-07-14/15), se corrió la migración encima y después 20 casos — migración de la dueña existente, columna vieja efectivamente dropeada, comportamiento idéntico con una dueña, agregar la segunda, una sola principal por lista, cliente que queda con la co-dueña, intruso pisado a la principal, cliente sin vendedora pisado, reasignar entre dueñas (antes imposible), reasignar a una no-dueña y a null bloqueados, reasignar libre en lista general, mover un cliente ajeno a la lista compartida, `can_vendedora_use_price_list` para dueña/co-dueña/ajena, vendedora ajena bloqueada y co-dueña permitida en `update_client_price_list`, quitar la co-dueña + enderezar los inconsistentes, y el estado final de las policies. **Bug preexistente encontrado de rebote**: al querer verificar `schema.sql` desde cero, el archivo **no corría** — fallaba con `function public.is_admin() does not exist` desde el 2026-07-15, porque el bloque de RLS de `admin_audit_log` se había mergeado antes de la definición de `is_admin()` y una policy sí valida sus funciones al crearse. Confirmado corriendo el `schema.sql` de HEAD en el mismo cluster, para descartar que fuera algo mío. Se movió ese bloque a la sección RLS del final; ahora `schema.sql` corre limpio desde cero y dos veces seguidas. **Orden de despliegue, importante**: la migración va ANTES del frontend — `ClientsAdmin.jsx` ya pide `price_list_owners` embebido, y si la tabla no existe `fetchAll` tira error, `load()` lo come en silencio (`catch {}`) y la pestaña Clientes queda vacía.

48. **Perfil superadmin: nombrar admins, cambiar contraseñas y asignar listas desde el panel** (2026-08-05, a pedido del usuario: "quiero tener un perfil que sea superadmin, ya que las acciones tipo de hacer admin, cambiar la contraseña y ahora la de asignar o desasignar una lista a alguna vendedora deberían de poder hacerse sin necesidad de meterme en el sql editor... pero que solo un perfil tenga acceso, el del correo support5@firstchoiceonline.com, además de alguna que otra función que puedas agregar"). **Lo primero que apareció al mirar el modelo no fue una feature faltante sino un permiso de más**: `admins` tenía la policy `admin_all` (`for all`), o sea que cualquier admin ya podía insertar filas ahí con un request directo y nombrarse/nombrar admins — nunca hubo UI, así que en la práctica no pasó, pero ponerle UI encima habría convertido el permiso en un botón. Por eso el diseño arranca cerrando eso: `admins` y `price_list_owners` salen del loop de `admin_all` y quedan con `superadmin_all` (escritura) + `admin_read_only` (lectura — la de `price_list_owners` la usa `ClientsAdmin.jsx`, que pide las dueñas embebidas). **Decisión de diseño central: dónde vive la marca de superadmin.** No en una columna de `admins` (ver arriba: cualquiera se habría podido coronar) sino en una tabla propia `superadmins` con **RLS activo y CERO policies** — desde la app no existe para nadie, ni para el propio superadmin; solo la leen las funciones SECURITY DEFINER y el SQL Editor, y encima se le hizo `revoke all ... from anon, authenticated`. Sumar o quitar un superadmin queda a propósito como acción de SQL Editor: es la llave maestra, no un permiso más del panel (los queries están al final de la migración). **Segunda decisión: `is_admin()` pasa a ser "está en `admins` o es superadmin"** — así el superadmin no puede dejarse afuera del panel ni tocando el botón "Quitar admin" sobre sí mismo (la RPC igual lo rechaza), y las ~15 policies + RPC que ya usaban `is_admin()` lo dejan entrar sin tocarlas una por una. **Tercera: `get_my_role()` sigue devolviendo `'admin'` para él, no `'superadmin'`** — hay 6 páginas admin que comparan `role === 'admin'` para mostrar sus controles de edición (`ProductsAdmin`, `PricesUpload`, `ClientsAdmin`, `FlashSalesAdmin`, `OrdersAdmin`, `AdminLayout`), así que devolver un valor nuevo ahí habría dejado al superadmin en modo solo-lectura en todo el panel; `AdminLayout.jsx` pregunta aparte con `is_superadmin()` (las dos RPC salen en un solo `Promise.all`) y pasa `isSuper` por el `Outlet context` junto a `role`. **12 RPC `sa_*`** (todas con `is_superadmin()` adentro y todas auditadas vía `sa_log()`, que guarda el objetivo de la acción en `admin_audit_log.client_name` — de ahí que la columna de la pestaña Registro pasara a titularse "Cliente / objetivo"): usuarios (`sa_list_users` sobre `auth.users`, que no es legible desde el cliente; `sa_set_admin`; `sa_register_new_admin`; `sa_log_password_change`) y listas (`sa_price_list_overview`, `sa_add_price_list_owner`, `sa_remove_price_list_owner`, `sa_set_primary_price_list_owner`, `sa_sync_price_list_clients`, `sa_create_price_list`, `sa_update_price_list`, `sa_delete_price_list`). **Lo que no puede hacer Postgres**: crear un usuario de Auth o cambiarle la contraseña necesita la Admin API de GoTrue (service_role), imposible desde el navegador — eso vive en la Edge Function nueva `supabase/functions/superadmin-users` (una sola función con `action`, porque cada Edge Function es un deploy aparte), que valida `is_superadmin()` con el JWT de quien llama y después vuelve a Postgres **con ese mismo JWT** para dejar la auditoría con su `auth.uid()` real; la contraseña no se guarda ni se loguea en ninguna parte (se verificó con un assert). **Funciones agregadas sin que se pidieran, en la misma línea de "no volver al SQL Editor"**: crear un admin desde cero (usuario + rol en un paso), el listado de usuarios con rol y último acceso, **reasignar de una vez los clientes que quedaron con una vendedora que dejó de ser dueña de su lista** (el footgun que la migración del 08-04 documentaba para resolver a mano con un UPDATE) y crear/renombrar/borrar listas de precio (crear una lista era un INSERT a mano: así nacieron `quote` y `luzmar`). Tres criterios ahí: el `code` de una lista **no** se puede renombrar (lo lee código real — `quote`/`special` en `get_catalog`, los alias de `PricesUpload.jsx`), el borrado solo aplica a listas que no siembra `schema.sql` y que estén completamente vacías (es para deshacer un alta con el código mal escrito, no una herramienta de limpieza), y quitar una dueña **no** mueve sus clientes solo: el panel avisa cuántos quedaron y ofrece el botón. **Colisión de nombres detectada y corregida antes de terminar**: el rename de lista iba a auditarse como `update_price_list`, que ya existe en `admin_audit_log` con otro significado (`update_client_price_list`, cuando se le cambia la lista a un cliente) — quedó como `update_price_list_label`. De paso, `AuditLogAdmin.jsx` pasó de una cadena de 6 ternarios a dos mapas (`ACTION_LABELS`/`ACTION_STYLES`) porque con 16 acciones era ilegible, y el filtro por acción agrupa varias acciones por opción (las 3 de dueñas comparten etiqueta). **Verificado de verdad**: `npm run build` limpio, y la migración probada contra un **PostgreSQL 18 real** (cluster desechable en el scratchpad, borrado al terminar) arrancando del estado real de producción — `schema.sql` de HEAD + `migration-2026-08-04-shared-price-lists.sql` — con 18 bloques de assert: identidad de los 3 roles (incluido que `get_my_role()` sigue diciendo `'admin'` y que el superadmin **no** tiene fila en `admins`), rechazo de las RPC a un admin común y a una vendedora, RLS de las 3 tablas **actuando como el rol `authenticated`** (postgres saltea RLS, así que probarlo como superusuario no probaba nada), ciclo completo de dueñas (agregar, cambiar principal, quitar la principal → promoción automática de la que queda, clientes colgados detectados y reasignados, idempotencia, lista que vuelve a general), validación del código de lista, guardas del borrado, y auditoría de las 11 acciones nuevas. Además: la migración es re-corrible y `schema.sql` completo corre encima sin romper nada (las policies quedan exactamente en `superadmin_all` + `admin_read_only`, sin `admin_all` colgado). Dos falsos positivos fueron **errores de mis propias expectativas de test**, no del código: una vendedora que no es dueña ve 0 filas de `price_list_owners` (no 1) porque la RLS se las oculta, y `'MAYUSCULAS'` sí es un código válido porque la RPC lo normaliza a minúsculas. **Hecho el mismo 2026-08-05** (confirmado por el usuario): se corrió `migration-2026-08-05-superadmin.sql` (después de las dos que lista el preflight) y se desplegó `supabase functions deploy superadmin-users`; el frontend se podía desplegar antes, sin la migración la pestaña simplemente no aparece.

49. **Export a Excel del Registro de movimientos** (2026-08-05, segunda tanda del día, a pedido del usuario: "quiero para la vista admin y superadmin la posibilidad de descargar un excel desde el área del registro de movimientos con todos los movimientos que se hayan realizado"). No hizo falta tocar permisos: la pestaña ya es admin-only y la RLS `admin_read_audit` usa `is_admin()`, que desde el punto 48 incluye al superadmin — así que "admin y superadmin" ya era exactamente quién puede leer `admin_audit_log`. **La decisión de diseño real fue el alcance del archivo**: la tabla en pantalla carga solo los **últimos 200** movimientos (`.limit(200)`) y los filtros son client-side sobre esos 200, así que exportar "lo que se ve" habría entregado un recorte silencioso justo en la pantalla donde eso más importa. El export usa `fetchAll('admin_audit_log', '*', 'created_at')` — pagina más allá del corte de 1,000 filas de PostgREST — y después aplica **los mismos filtros activos**, con lo cual también resuelve el caso "bajame todo lo que hizo tal usuario" o un rango de fechas más viejo que los 200 visibles (en pantalla se vería vacío, en el Excel viene completo). Para que eso no sea una trampa, el botón dice "(todo el historial)" o "(filtrado)" según el estado de los filtros y hay una línea de ayuda explicando la diferencia. El criterio de filtrado se factorizó en `matchesFilters()`, usado por la tabla y por el export, para que no puedan divergir. **Columnas**: Fecha, Usuario, Acción, Cliente / objetivo, Detalle, ID cliente, ID pedido y **Datos completos (JSON)**. Dos detalles: (a) la fecha se escribe como `YYYY-MM-DD HH:MM:SS` en hora local **como texto**, no como celda de fecha — así ordena y filtra bien en cualquier Excel sin depender de la configuración regional de la máquina; (b) se incluye el `detail` jsonb crudo además del resumen legible, porque es un registro de auditoría y el resumen pierde información a propósito (el antes/después ítem por ítem de una edición de pedido, el movimiento de stock producto por producto, los ids de las dueñas). Si los filtros no dejan ninguna fila no se genera un archivo vacío: avisa "Sin movimientos registrados". **Implementación**: `downloadAuditLogExcel({rows, header, widths, sheetName, filenameStamp})` en `utils/excel.js` (XLSX lazy, igual que los otros dos exports) recibe las filas y los encabezados **ya armados** desde el componente — al revés que `downloadOrderExcel`/`downloadMissingPhotosExcel`, que se arman solos — porque las etiquetas de acción y el texto de detalle dependen de `t()` (idioma del panel) y de la forma del `detail` de cada acción, que ya vive resuelta en `AuditLogAdmin.jsx`; duplicar eso en `excel.js` habría sido la vía rápida a que el Excel y la pantalla digan cosas distintas. De paso se reemplazó el último encabezado hardcodeado de la tabla ("Detalle") por la key nueva `auditDetail`. **Verificado**: build limpio, i18n sin keys duplicadas (277 por idioma, ninguna sin par), y el export probado de verdad con Node — 10 filas que imitan cada tipo de movimiento (incluidos `detail` null y una acción desconocida, que caen en el label por defecto y celda vacía sin romper), escribiendo el `.xlsx` con la misma llamada de XLSX que hace el navegador y **releyéndolo** para confirmar encabezados en orden, orden descendente por fecha, formato de fecha ordenable, el resumen de cada acción, que el JSON exportado se vuelve a parsear con el detalle ítem por ítem intacto, que la fila de cambio de contraseña no lleva ninguna contraseña, y los 4 casos de filtrado (por usuario, por rango de fechas, por grupo de acciones y filtro sin resultados → no genera archivo). Una de las aserciones falló al principio por una doble negación mal escrita en el test, no por el código.

50. **Pestaña 📈 Métricas (solo superadmin)** (2026-08-06) — ver el detalle en la narrativa del principio del documento (punto 50).

51. **El grupo de Flash Sales que volvía al catálogo mientras el panel decía "Desactivada"** (2026-08-06) — ver la narrativa del principio (punto 51). **Quedó obsoleto al día siguiente**: el punto 53 eliminó esa pestaña entera.

52. **Un producto sin precio (o con precio 0) no sale en el catálogo, no se cotiza y no se puede pedir** (2026-08-06, `migration-2026-08-06-require-price.sql`) — ver la narrativa del principio (punto 52).

53. **Se eliminó el área de Flash Sales; la Flash Sale pasa a ser una etiqueta del producto** (2026-08-07, a pedido del usuario: "vamos a quitar la seccion de flash sales que esta al lado de la seccion de vendedoras, los flash sales no hace falta que tengan un countdown, ya que realmente se usa como una estrategia para vender productos de los cuales se quiere mover inventario") — se fueron `FlashSalesAdmin.jsx`, `FlashSaleSection.jsx` y la llamada a `get_flash_sales()`; queda la etiqueta 🔥 (`products.availability = 'flash'`) con su badge y su chip de filtro. **Sin migración**: la tabla `flash_sales` y sus datos quedan en la base marcados como LEGADO. En la misma tanda, y también a pedido: **carga de Flash Sales por Excel** en la pestaña Productos (el "Special Flash Sale" semanal, solo la columna SKU, con vista previa y modo reemplazo que desmarca lo que no viene en el archivo), **acciones en bloque de etiquetas** (🔥 / Pre-Order / Disponible / ✨ Nuevo) y **filtros por grupo de producto en la pestaña Precios**. Detalle completo y las dos trampas a recordar (el trigger de stock que pisa Disponible/Pre-Order, y los updates en tandas de 100 ids por el largo de la URL de PostgREST) en la narrativa del principio.

54. **La bandeja de Pedidos deja de estar topeada en 200** (2026-08-07, a pedido del usuario: "esta limitado a marcar hasta 200 pedidos, quitale el limite para que se vea siempre la cantidad precisa de pedidos") — `OrdersAdmin.jsx` traía los últimos 200, así que el conteo del encabezado mentía apenas se pasaba de ahí y los pedidos viejos no se podían ver ni marcar atendidos. Ahora carga todo con `fetchAll` (páginas de 1,000 en paralelo) y se renderiza por lotes con scroll infinito; `get_quotes_live_pricing` pasa a pedirse en tandas de 100 ids para no mandar una sola consulta larga que pueda chocar con el `statement_timeout`; y se agregó estado de carga + aviso de error, porque una lista incompleta mostrada como completa es el mismo problema que el tope. Verificado en navegador con 2,340 pedidos mockeados (10 aserciones): pagina 1000+1000+340, el encabezado dice 2340, los filtros cuentan sobre el total, el 8º pedido más viejo aparece al buscarlo por teléfono, y no se dibujan las 2,340 filas de golpe. El `limit(50)` del aviso de `order_failures` se dejó como está: es una alarma, no el listado.

55. **Un producto con stock 0 sale del catálogo (sigue en Pre-Order, pero desactivado)** (2026-08-12, a pedido del usuario: "cuando un producto quede con stock 0 en la base de datos, que se siga poniendo en pre-order pero que se desactive, es decir, que no salga en el catálogo") — `migration-2026-08-12-hide-out-of-stock.sql`, **corrida en producción el 2026-08-12** (confirmado por el usuario; había que correrla junto con el deploy, no después: sin la columna nueva el filtro no encuentra nada y los `update` que la mencionan fallan). Revierte a propósito media decisión del 2026-07-14: la etiqueta sigue siendo `preorder`, lo que cambia es la publicación. Columna nueva `products.deactivated_by_stock` = "esta regla fue la que lo apagó", que es lo único que permite reactivar solo por stock sin resucitar lo que apagó una persona ni la exclusión de no-catálogo. Un 🔥 con stock 0 también se despublica; `compute_order_items` pasa a buscar con `(active or deactivated_by_stock)` para no perder en silencio la línea de un carrito ya armado; `apply_price_list` gana el contador `blocked_by_stock` y su desactivación por quedar fuera del archivo borra la bandera. Detalle completo, los porqués y la verificación (10 bloques de assert en PostgreSQL 18 + 15 aserciones en navegador real) en la narrativa del principio.

56. **"Las órdenes del cliente Robert Carlos Pacheco no se registraron"** (2026-08-12, incidente crítico de soporte) — **no era captura, era búsqueda.** El buscador de la bandeja de Pedidos filtraba con `name.toLowerCase().includes(q)`, o sea una **subcadena contigua**: el sync guarda el `Name` completo de SellerCloud ("Robert Edu Carlos Pacheco") y el negocio lo conoce por su `CorporateName`, que en el export real es literalmente "Robert Carlos" — así que buscarlo por el nombre con el que se lo nombra daba **cero resultados**, y una bandeja vacía se lee como "no se registró nada". Arreglado con `src/utils/search.js` (todos los términos, en cualquier orden, sin acentos), aplicado a **Pedidos** y **Clientes**; con una sola palabra se comporta igual que antes (11 consultas verificadas contra nombres reales del export, 0 diferencias), y los términos **no se reparten entre campos distintos** para no fabricar falsos positivos. En la misma revisión apareció el mismo síntoma por otra puerta: **`fetchAll` paginaba en paralelo ordenando por una clave con empates** (`product_prices` por `product_id`, que tiene una fila por lista de precio), y una fila que empata en el borde de una página puede salir en dos páginas o en **ninguna** — ahora acepta varias columnas de orden y cada call site pasa una combinación única. **Sin migración** (todo frontend). De paso quedó verificado contra producción que `migration-2026-08-05-order-capture.sql` **sí está corrida** (los docs la listaban como "pendiente y URGENTE" por error), y de paso que **6 de las 8 migraciones listadas como pendientes ya estaban aplicadas** — la única pendiente confirmada era `migration-2026-08-12-hide-out-of-stock.sql`, que el usuario corrió ese mismo día, junto con la confirmación de las tres que el sondeo no podía determinar: **al 2026-08-12 no queda ninguna migración pendiente**. Detalle completo, el truco para sondear qué hay vivo en PostgREST sin escribir nada, y qué queda por confirmar del lado de los datos, en la narrativa del principio.
