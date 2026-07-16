# Zimaxx Store — Referencia completa del proyecto

> Documento de referencia para retomar el trabajo en cualquier sesión.
> Creado: 2026-07-02. Actualizado: 2026-07-09 (PDF separa Pre-Order;
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
> (`migration-2026-07-15-restrict-vendedora-luzmar.sql`, **pendiente de
> correr en producción**). El Registro de movimientos ahora es una
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
> recrea el CHECK de la columna, **pendiente de correr en producción**.
> Una vendedora ahora puede cambiarle la lista de precio a sus propios
> clientes (con confirmación "¿Cambiar a X?" antes de aplicar) vía la RPC
> nueva `update_client_price_list`, que además audita el cambio en
> `admin_audit_log` — `migration-2026-07-15-vendedora-update-price-list.sql`,
> **pendiente de correr en producción** (requiere que
> `migration-2026-07-14-client-admin-actions.sql` ya esté corrida). El
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
> pisar uno de los dos. **Pendiente y urgente de correr en producción**
> (si el sync sigue activo, cada corrida antes de esta migración sigue
> generando más duplicados). 2026-07-16: auditoría completa comparando el
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
- [ ] **Pendiente: correr, en este orden**:
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
- [ ] **Pendiente: correr `migration-2026-07-13-exclude-noncatalog.sql`**
  en producción (desactiva los productos no-catálogo ya cargados — SKU
  `-SPECIAL` + categorías beauty/electronics/support/packing and shipping
  supplies/test — y blinda `sync_upsert_products`). Contra el export
  `119389.xlsx` la regla toca 209 productos (111 `-SPECIAL` + 98 por
  categoría), deja 3450 de catálogo. El código de la carga manual de Excel
  ya está desplegado con el mismo filtro.
- [ ] **Pendiente: correr `migration-2026-07-14-inventory-stock.sql`** en
  producción (agrega `products.stock` y hace que `InventoryAvailableQTY`
  del sync controle la disponibilidad: `>= 1` available, `0`/negativo
  preorder, respetando flash; `active` NO lo toca el sync). Sin cantidad de
  stock guardada de antes, los productos sin stock ya cargados se corrigen
  recién en la primera corrida del sync que traiga el campo (o a mano con
  el bulk). El código del frontend (stock + bulk activar/desactivar +
  disponibilidad por stock en la carga manual) ya se puede desplegar.
- [ ] **Pendiente: correr `migration-2026-07-14-product-upc.sql`** en
  producción (agrega `products.upc` y hace que `sync_upsert_products` lo
  guarde). El frontend (columna/campo/búsqueda por UPC) ya se puede
  desplegar. El n8n debe mapear `UPC` → `upc`.
- [ ] **Pendiente: correr `migration-2026-07-14-client-admin-actions.sql`**
  en producción (crea `admin_audit_log` + RPC `reassign_client`/
  `delete_client`). Sin esto, los botones de reasignar/eliminar del panel
  de Clientes fallan (la RPC no existe). El frontend ya se puede desplegar.
- [ ] **Pendiente: workflow de n8n** que llame a las 3 funciones
  `sync_upsert_*` con la **service_role key** (no la anon — las
  funciones no son ejecutables por anon/authenticated) y registre cada
  corrida en `sync_runs` (insert al arrancar con status 'running',
  update al cerrar con 'ok'/'error' + contadores).
- [ ] **Pendiente: correr `migration-2026-07-15-restrict-vendedora-luzmar.sql`**
  en producción (restringe `price_lists`/`product_prices` para que una
  vendedora no vea la lista/precios "personales" de otra — antes
  `vendedora_select_readonly` era un blanket sin distinguir dueña). El
  código de Flash Sales oculto para vendedora ya se puede desplegar sin
  esperar esta migración (es solo frontend).
- [ ] **Pendiente: confirmar el deploy de la Edge Function
  `supabase/functions/admin-create-vendedora-user`** (2026-07-15): el
  usuario corrió `supabase login` + `supabase link --project-ref
  yukulanekksquqkateqk` bien, pero el primer `supabase functions deploy`
  tenía un typo (`admin0create-vendedora-user`) y falló — falta confirmar
  que el reintento con el nombre correcto (`admin-create-vendedora-user`)
  terminó OK. "Vincular acceso" (usuario ya existente) no depende de esto
  y ya funciona.
- [ ] **Pendiente: correr `migration-2026-07-15-order-status-cancelled.sql`**
  en producción (recrea el CHECK de `orders.status` para sumar
  `'cancelled'` a `'new'/'done'`). Sin esto, marcar un pedido como
  cancelado desde `/admin/orders` falla contra la base — el frontend ya
  se puede desplegar.
- [ ] **Pendiente: correr `migration-2026-07-15-vendedora-update-price-list.sql`**
  en producción (crea la RPC `update_client_price_list`, que reemplaza el
  `update` directo que hacía `ClientsAdmin.jsx` para cambiar la lista de
  un cliente). **Sin esto, el selector de lista con confirmación falla
  para TODOS, admin incluido** — el frontend ya no usa el update viejo.
  Requiere que `migration-2026-07-14-client-admin-actions.sql` ya haya
  corrido (crea `admin_audit_log`, donde esta función también audita).
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
    │   ├── Header.jsx          ← logo, nombre cliente, buscador, selector de idioma, botón carrito (desktop) — sticky junto con FilterBar (ver Catalog.jsx)
    │   ├── FilterBar.jsx       ← chips de categoría/línea/disponibilidad (2026-07-09, extraído de Catalog.jsx)
    │   ├── ProductCard.jsx     ← tarjeta con precio y botón agregar (memoizada)
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
| `clients` | Clientes con token único, lista asignada y `vendedora_id` (FK a `vendedores`). Desde la v2 del sync (2026-07-10): `sellercloud_id` (integer unique nullable, el General.ID de SellerCloud — llave del sync automático; null en clientes cargados a mano/Excel) y `price_list_id` pasó a ser **nullable** (los clientes nuevos del sync entran sin lista; un cliente sin lista ve catálogo vacío y no puede pedir hasta que se la asignen a mano) |
| `vendedores` | Nombre + teléfono de cada vendedora (2026-07-06; antes texto libre en `clients`). Desde el rol vendedora (2026-07-06): `user_id` (FK a `auth.users`, nullable, único) + `login_email` (solo display) para vincular su login |
| `products` | Catálogo de productos (`availability`: 'available' \| 'preorder' \| 'flash', este último desde 2026-07-08 — etiqueta "Flash Sale" del Excel de inventario, sin relación con la tabla `flash_sales`). `product_line` (2026-07-08, texto libre, nullable): tipo real del perfume desde `PRODUCT_CATEGORY` del export SellerCloud (`Perfume` / `Perfume - Arabes`), **distinto** de `category` que acá guarda la marca/Brand. `new_until` (2026-07-09, timestamptz nullable): mientras `now() < new_until` el producto lleva la etiqueta ✨ Nuevo en catálogo y admin; se setea automático (+10 días) al crear el producto y es editable en el formulario. `stock` (2026-07-14, int nullable, `migration-2026-07-14-inventory-stock.sql`): InventoryAvailableQTY de SellerCloud — **no** se expone en el catálogo del cliente (`get_catalog` no lo incluye), solo visible en el admin. Decide la disponibilidad en cada carga/sync (`>= 1` available, `0`/negativo preorder, respetando flash); NO toca `active`. null = "todavía no se sabe el stock" (distinto de 0 = sin stock). `upc` (2026-07-14, text nullable, `migration-2026-07-14-product-upc.sql`): código de barras, dato interno del admin (**no** lo expone `get_catalog`), visible/editable en la pestaña Productos y buscable |
| `product_prices` | Precio por producto+lista (clave compuesta) |
| `flash_sales` | Ofertas con fecha de expiración |
| `orders` | Pedidos del checkout — fuente de verdad (precios recalculados en el servidor) con `status` 'new' \| 'done' |
| `admins` | user_id de Supabase Auth autorizados como admin |
| `sync_runs` | Auditoría del sync SellerCloud→Supabase vía n8n (2026-07-10, `migration-2026-07-10-sellercloud-sync.sql`): `started_at`/`finished_at`, `status` 'running' \| 'ok' \| 'error', contadores `rows_products`/`rows_prices`/`rows_clients`, `error_detail`. n8n la escribe directo con la service_role key (salta RLS); admins solo lectura |
| `admin_audit_log` | Auditoría de acciones sensibles del admin sobre clientes (2026-07-14, `migration-2026-07-14-client-admin-actions.sql`): `action` ('reassign_client' \| 'delete_client'), `performed_by`/`performed_by_email` (quién), `client_id`/`client_name` (snapshot, `client_id` SIN FK para sobrevivir al borrado), `detail` jsonb, `created_at`. Solo lectura para admin (RLS); la escriben solo las RPC `reassign_client`/`delete_client` |

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

### `reassign_client(p_client_id uuid, p_vendedora_id uuid) → jsonb` / `delete_client(p_client_id uuid) → jsonb`
- Acceso: solo `authenticated`; internamente exigen `is_admin()` (si no, `raise exception`). (2026-07-14, `migration-2026-07-14-client-admin-actions.sql`.)
- SECURITY DEFINER a propósito (no `update`/`delete` directos desde el frontend): así el registro en `admin_audit_log` es atómico e imposible de saltear — no hay forma de reasignar/borrar sin dejar rastro (quién vía `auth.uid()` + email de `auth.users`).
- `reassign_client`: cambia `clients.vendedora_id` (null = sin asignar). Rechaza si la lista del cliente es "personal" (`owner_vendedora_id`, ej. luzmar — el trigger lo revertiría igual). Devuelve `{ok, from, to}`.
- `delete_client`: borra el cliente. **Rechaza si tiene pedidos** (`orders.client_id`, FK RESTRICT sin cascade — borrarlo perdería el historial, y `orders` no guarda copia del nombre). Inserta la fila de auditoría ANTES del delete (snapshot). Devuelve `{ok}`.
- Las lanza `ClientsAdmin.jsx` (select de vendedora por fila + botón Eliminar con confirmación inline); el mensaje de `raise exception` (en español) llega como `error.message` y se muestra en un banner. El **Registro de movimientos** (sección colapsable, solo admin) lee `admin_audit_log` directo (RLS `admin_read_audit`).

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
- **Trigger `clients_enforce_owner_vendedora`** (2026-07-09): antes de cualquier `insert`/`update` en `clients`, si `price_lists.owner_vendedora_id` está seteado para la lista elegida (ej. `'luzmar'`), pisa `vendedora_id` con ese valor — sin importar qué mande el caller. Corre ANTES de evaluar las policies RLS de arriba, así que a una vendedora que no sea la dueña ni siquiera le sirve saltarse la UI e insertar directo: el trigger fuerza `vendedora_id` a la dueña, y `vendedora_insert_own_clients` (`vendedora_id = current_vendedora_id()`) rechaza la fila igual porque ya no coincide con su propio id.
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
18. **Availability `'flash'` para el Type "Flash Sale" del Excel** (2026-07-08, a pedido del usuario) — antes `parseAvailability()` en `ProductsAdmin.jsx` solo distinguía Pre Order de todo lo demás; "Flash Sale" en la columna Type (ej. del Excel "Wholesale Perfume") caía en `available` sin dejar rastro. Ojo: esto **no tiene relación** con la tabla `flash_sales` (ofertas con precio promo y countdown que se gestionan en su propia pestaña) — es solo una tercera etiqueta de disponibilidad del producto, sin precio asociado; un producto puede tener el badge sin ninguna oferta activa y viceversa. Se agregó el valor `'flash'` a `products.availability` (columna sin CHECK constraint, no hizo falta migración) y se replicó exactamente el patrón que ya existía para `preorder`: badge 🔥 en `ProductCard.jsx` (esquina superior, mismo lugar que el de Pre-Order pero con colores invertidos para diferenciarlo), chip de filtro "🔥 Flash Sale" en `Catalog.jsx` junto a Disponible/Pre-Order (el bloque de chips ahora se muestra si hay preorder **o** flash, cada chip condicionado a que existan productos de ese tipo), y en `ProductsAdmin.jsx` un contador/filtro igual al de Pre-Order más el badge en la fila de la tabla. Se reutilizó la key de i18n `flashSale` (ya existía en el diccionario pero no se usaba en ningún lado — la usa el título hardcodeado de `FlashSaleSection.jsx`). **No se propagó** al carrito/WhatsApp/PDF como sí pasa con `preorder` (no fue parte del pedido): el campo `flash` que ya existe en los ítems del carrito es la marca de "vino de una oferta de `flash_sales`", nombre que se dejó intacto a propósito para no chocar con este nuevo significado.
19. **Carga masiva de Flash Sales por Excel** (2026-07-08, a pedido del usuario, mismo día que el punto 18 pero *no relacionado* — esto sí es la tabla `flash_sales` de ofertas con precio) — hasta entonces `FlashSalesAdmin.jsx` solo permitía cargar una oferta a la vez (producto + precio + fechas a mano). El usuario tiene un archivo semanal, `Special Flash Sale.xlsx` (mismo formato letterhead que las listas wholesale de precios: `UPC`/`Sku`/`Brand`/`Title Product`/`Price`/`Type`/`Qty`/`Total Price`, con `Type = 'Flash Sale'` en todas las filas y precio con `$` — ej. `$22.00`), y quería subirlo entero fijando la fecha de la promo con un calendario en vez de cargar producto por producto. Se agregó una sección de carga masiva en la misma pestaña: dos `datetime-local` (inicio/fin, igual estilo que el alta manual) que valen para **todo el archivo** — la fecha no sale del Excel — más un `UploadZone` que reusa `parseSheet()`. Matchea por SKU contra los productos activos ya cargados (mismo patrón que `PricesUpload.jsx`/`ClientsAdmin.jsx`: `bySku` en minúsculas) y usa el precio propio de cada fila (`Number(...).replace(/[$,\s]/g,'')`, ya soporta el `$`). Filas sin SKU coincidente o con precio inválido se cuentan como omitidas, no tumban la carga. Verificado contra el archivo real del usuario: de 324 filas de datos, 323 parsean SKU+precio válidos (1 fila sin SKU). **Decisión importante que hay que recordarle al usuario si vuelve a preguntar**: esto **no hace upsert** — cada carga inserta filas nuevas en `flash_sales` (mismo comportamiento que el alta manual, que tampoco tiene upsert), así que volver a subir el mismo archivo la semana siguiente crea ofertas duplicadas en vez de reemplazar las anteriores; para "cambiar la promo de la semana" hay que desactivar a mano las viejas en la tabla antes de subir el archivo nuevo (no se automatizó porque no se pidió, y automatizarlo mal — ej. desactivar todo lo que no está en el archivo nuevo — podría apagar ofertas vigentes de otro producto que no tenía por qué tocarse).
20. **Estados de Flash Sale más claros en el admin** (2026-07-08, mismo día, a pedido del usuario) — el usuario preguntó si hacía falta desactivar manualmente una promo al llegar su fecha límite. La respuesta ya era "no": `get_flash_sales()` (RPC público) y `FlashSaleSection.jsx` (filtro cliente-side, con tick de 1s) ya excluyen por `now() < expires_at`/`now < expires_at` sin que nadie toque `flash_sales.active` — ese booleano solo sirve para cortar una oferta **antes** de su fecha normal. El problema real era de UI: la tabla de `/admin/flash` mostraba "Inactivo" tanto para una oferta que expiró sola por fecha como para una desactivada a mano, dando la impresión de que hacía falta el paso manual. Se reemplazó `isLive()` (booleano) por `saleStatus(s)` con 4 casos — `deactivated` (`!active`) / `scheduled` (`now < starts_at`) / `expired` (`now >= expires_at`, con `active` todavía en `true`) / `live` — cada uno con su badge y color propio (`STATUS_STYLES` en `FlashSalesAdmin.jsx`, keys i18n `flashStatus_live/scheduled/expired/deactivated`). No cambió ningún comportamiento real, solo la claridad de qué está pasando y por qué.
21. **`product_line` (tipo de perfume, distinto de `category`/marca)** (2026-07-08, a pedido del usuario) — el usuario tiene un export de SellerCloud (`119389.xlsx`, en la raíz del repo) con columnas separadas `PRODUCTBRAND` (marca) y `PRODUCT_CATEGORY` (tipo real: `Perfume` = diseñador, `Perfume - Arabes` = dupes árabes, más basura tipo `Beauty`/`Electronics`/`Packing and Shipping Supplies` para SKUs que no son perfume). Pidió explícitamente que se lea `PRODUCT_CATEGORY`, **no** `PRODUCTBRAND` — el campo `category` existente en el proyecto ya guarda la marca, así que se agregó una columna nueva y separada, `products.product_line` (texto libre, sin CHECK, nullable — `ProductsAdmin.jsx`: `COLS.line = ['product_category', 'product category', 'línea', 'linea', 'segmento']`). Se replicó el patrón ya usado para `category`/`availability`: en `ProductsAdmin.jsx` un select de filtro (con opción "Sin categoría" vía `'__none__'`, igual que el de marca) más un badge chico junto a la marca en la tabla; en `Catalog.jsx` un chip de filtro nuevo (solo se muestra si hay 2+ valores distintos de `product_line` — con un solo valor no tendría sentido filtrar) y se sumó `product_line` a la búsqueda de texto junto a nombre/categoría. `get_catalog` devuelve el campo en el JSON de productos (agregado a las dos ramas, la de `quote` y la normal). Verificado end a end contra el archivo real del usuario simulando el `parseSheet()`/`pick()` reales: 3659 filas, `hasCategory: false` (confirma que `PRODUCTBRAND` no matchea ningún alias de `category`, tal como pidió el usuario que no se tocara) y `hasLine: true`, con conteos post-filtro-de-basura de 2164 `Perfume` / 1391 `Perfume - Arabes` / algunos residuales (`Beauty`, `Electronics`, etc., que si el admin sube ese archivo completo entrarían igual al catálogo salvo que ya estén cubiertos por `JUNK_PATTERN` — eso es una decisión de qué Excel subir, no algo que este cambio resuelva).
22. **PDF del pedido separa Pre-Order de los ítems normales/flash sale** (2026-07-09, a pedido del usuario) — `downloadOrderPdf()` en `pdf.js` listaba todos los ítems del carrito en el orden en que estaban, mezclando disponibles/flash con pre-order. Ahora filtra `items` en dos grupos usando el flag `preorder` que ya traía cada ítem del carrito (`CartContext.jsx`, seteado en `makeItem()` desde `product.availability === 'preorder'`): dibuja primero los normales/flash, y si hay al menos un ítem pre-order agrega un subtítulo en negrita (reusa la key i18n `preorder`, "Pre-Order"/"Pre-Order") antes de listarlos. El total al final sigue sumando todos los ítems sin cambios — solo cambió el agrupamiento visual de las filas.
23. **Filtro por estado + desactivar por lote en Flash Sales** (2026-07-09, a pedido del usuario) — `FlashSalesAdmin.jsx` no tenía forma de filtrar la tabla por estado (LIVE/Programada/Expiró/Desactivada) ni de desactivar de una sola vez todas las ofertas que vinieron juntas en una carga masiva por Excel. Se agregó: (a) un select de filtro que usa la misma `saleStatus()` ya existente (punto 20); (b) columna nueva `flash_sales.batch_id` (uuid, nullable, `add column if not exists` + índice parcial en `schema.sql`) que `handleBulkFile` llena con un `crypto.randomUUID()` generado una vez por carga — todas las filas de ese Excel comparten el mismo valor, las cargadas a mano o antes de este cambio quedan en `null`. La tabla agrupa filas con el mismo `batch_id` bajo un encabezado (cantidad total + cuántas siguen activas) con un botón "Desactivar grupo" que hace `update ... where batch_id = X and active = true`; el resto de las filas (sin lote) se sigue mostrando suelto como antes. **Pendiente: correr el `schema.sql` actualizado en Supabase** (agrega `batch_id`, no rompe nada si ya hay filas) — hasta entonces todas las cargas nuevas insertarían sin ese campo y fallarían, así que hay que avisarle al usuario que corra el schema antes de la próxima carga masiva.
24. **Buscador movido al Header** (2026-07-09, a pedido del usuario) — desde que `FlashSaleSection` se renderiza arriba del todo en `Catalog.jsx`, el buscador (que vivía debajo, junto a los chips de categoría) quedaba empujado fuera de la vista inicial en clientes con varias ofertas activas. Se movió el `<input type="search">` a `Header.jsx` (que ya es `sticky top-0`), como una segunda fila debajo del logo/carrito — así queda visible siempre, incluso con scroll. `Header` ahora recibe `search`/`onSearchChange`/`showSearch` como props (el estado sigue viviendo en `Catalog.jsx`, solo se re-ubicó el input); `showSearch = validClient && !loading` para no mostrarlo en la pantalla de "link inválido" ni durante la carga. Los chips de categoría/línea/disponibilidad se quedaron donde estaban, debajo de Flash Sale — solo se movió el input de texto. Probado con Playwright headless (recién instalado en esta sesión, antes no estaba disponible en el sandbox) mockeando las RPC `get_catalog`/`get_flash_sales` con `page.route()` para no depender de un token real: confirmado visualmente en mobile y desktop que el buscador queda arriba de Flash Sale y sigue filtrando (`page.fill` + verificar conteo de resultados).
25. **Filtros pegados al buscador + optimización de rendimiento** (2026-07-09, mismo día, a pedido del usuario) — dos problemas después de mover el buscador al Header (punto 24): (a) los chips de categoría/línea/disponibilidad seguían viviendo debajo de `FlashSaleSection`, así que con varias ofertas activas quedaban igual de escondidos; (b) el usuario reportó que "la página a veces lagea". **Filtros**: se extrajeron a un componente nuevo `FilterBar.jsx` (mismo JSX que antes, sin cambios de lógica) y se envolvió `<Header/>` + `<FilterBar/>` juntos en un único `<div className="sticky top-0 z-30">` en `Catalog.jsx` — en vez de calcular a mano cuántos px mide el header para posicionar una segunda barra sticky por separado, ambos comparten el mismo contenedor sticky y crecen/se pegan como una sola unidad. Se le sacó `sticky top-0 z-30` al `<header>` interno de `Header.jsx` (ya lo pone el wrapper). **Rendimiento**, tres cambios: (1) `FlashSaleSection.jsx` tenía un `setInterval` de 1 segundo que recalculaba `activeSales` (filtrando expirados) SIEMPRE, forzando el re-render de toda la grilla — con 60-300 ofertas activas (carga masiva semanal, ver punto 19) esto re-renderizaba cientos de tarjetas una vez por segundo sin que nada relevante cambiara casi nunca. Se reemplazó por un único `setTimeout` reprogramado dinámicamente para el próximo vencimiento exacto (`cutoff` state en vez de `now` con tick fijo) — el grid solo vuelve a renderizar cuando de verdad hay algo que ocultar. El `Countdown` de cada tarjeta (badge "Ends in HH:MM:SS") sigue con su propio tick de 1s — eso es aislado y liviano, no se tocó. (2) `Catalog.jsx`: el buscador filtraba el array completo de productos (miles) en cada tecla; ahora hay `searchInput` (lo que se ve, sin demora) separado de `search` (con debounce de 150ms, lo que de verdad dispara el filtro) — la tipeada se siente igual de fluida pero el filtrado pesado solo corre cuando el usuario hace una pausa. (3) `ProductCard.jsx` envuelto en `React.memo` — sin esto, cada tecla del buscador o cada lote nuevo del scroll infinito re-renderizaba TODAS las tarjetas visibles (48+), no solo las que de verdad cambiaron. **Verificado con Playwright** (instalado el mismo día, ver punto 24) mockeando un catálogo de 2,500 productos + 60 flash sales activas simultáneas vía `page.route()`: capturas confirmando que el buscador+chips quedan pegados arriba incluso haciendo scroll dentro de una sección Flash Sale larga, y que tipear + scrollear sobre ese catálogo grande no cuelga la página (sin JS errors, sin timeouts).
26. **Flash Sale se oculta con búsqueda/filtro activo** (2026-07-09, mismo día, a pedido del usuario) — `FlashSaleSection` se seguía mostrando siempre, incluso buscando o con un chip de categoría/línea/disponibilidad activo, compitiendo visualmente con los resultados filtrados. En `Catalog.jsx`: `hasActiveFilters = !!search.trim() || !!category || !!line || !!availability` (usa el `search` con debounce, el mismo que ya alimenta `filtered`, para que ocultar la sección y actualizar la grilla pase en el mismo instante) — con eso en `true` no se renderiza `<FlashSaleSection/>`; en `false` (buscador y todos los chips en "Todos") vuelve a aparecer igual que al entrar. Verificado con Playwright: Flash Sale desaparece al escribir en el buscador, reaparece al vaciarlo, y también desaparece al activar el chip Pre-Order.
27. **Grupos de Flash Sales generalizados + edición de fechas** (2026-07-09, mismo día, a pedido del usuario — segunda iteración del punto 23) — el agrupamiento original solo funcionaba por `batch_id`, así que las ofertas cargadas a mano o antes de que existiera esa columna nunca se agrupaban. Ahora `FlashSalesAdmin.jsx` agrupa por `batch_id ?? 'exp:' + expires_at`: un lote de Excel es un grupo, y las ofertas sueltas que comparten fecha de vencimiento exacta también (encabezado "Mismo vencimiento" vs "Lote de carga masiva"); grupos de 1 se muestran como fila suelta. Como los grupos se arman client-side, `deactivateGroup(items)` y `updateExpiry(ids, fecha)` operan con `.in('id', ids)` en vez de un WHERE por batch — el mismo código sirve para ambos tipos de grupo. Además se agregó edición de fechas ("apartado para ajustar fechas"): cada fila tiene el vencimiento clickeable (patrón del teléfono en VendedoresAdmin: click → `datetime-local` → Enter/blur guarda, Esc cancela; componente `ExpiryCell`), y cada encabezado de grupo tiene un `datetime-local` + botón "Aplicar al grupo" que reprograma el vencimiento de todas las ofertas del grupo de una vez.
28. **Etiqueta ✨ Nuevo con vencimiento automático** (2026-07-09, mismo día, a pedido del usuario) — al crear un producto que no existía (carga masiva por Excel o alta manual) se le pone `products.new_until = ahora + 10 días` (constante `NEW_TAG_DAYS` en `ProductsAdmin.jsx`; el usuario pidió "~1 semana, quizás un poco más"). Mientras `now() < new_until` el producto lleva el badge ✨ Nuevo y se puede filtrar por nuevos; después la etiqueta expira sola. **Detalle técnico de la carga masiva**: PostgREST exige que todas las filas de un upsert tengan las mismas columnas, así que `handleFile` separa en dos tandas — SKUs nuevos (con `new_until`) y existentes (sin él, para no re-etiquetar como nuevo un producto viejo al re-subir el archivo). Schema: columna `new_until timestamptz` nullable + `get_catalog` devuelve `is_new` calculado server-side (`now() < new_until`) en ambas ramas (normal y quote). Frontend cliente: badge verde arriba-derecha en `ProductCard.jsx` (derecha para no chocar con Pre-Order/Flash Sale que van a la izquierda), chip "✨ Nuevo" en `FilterBar.jsx` (estado `onlyNew` en `Catalog.jsx`, entra en `hasActiveFilters` así que también oculta Flash Sale al activarse; el chip "Todos" de esa fila resetea availability Y onlyNew juntos). Admin: badge + contador-chip + opción en el select de estado en `ProductsAdmin.jsx`, y el formulario de alta/edición tiene el campo "✨ Nuevo hasta" (`datetime-local`, el "apartado para ajustar fechas" de productos — dejar vacío quita la etiqueta). **Pendiente: correr el `schema.sql` actualizado** (columna `new_until` + `get_catalog` con `is_new`) — sin eso el catálogo no recibe `is_new` y la creación de productos fallaría al insertar `new_until`.
29. **Buscador de producto en el alta individual de Flash Sale + badge Pre-Order rediseñado** (2026-07-09, mismo día, a pedido del usuario) — (a) El `<select>` del formulario "+ Flash Sale" listaba miles de productos y era inusable; se reemplazó por un buscador (nombre o SKU, mismos matches que `searchProducts`) que muestra hasta 30 resultados clickeables; al elegir uno queda fijado como chip con botón "Cambiar" (key i18n nueva `change`). Como ya no hay `<select required>`, `save()` valida `form.product_id` a mano y muestra `selectProduct` como error si falta. (b) El badge Pre-Order de `ProductCard.jsx` era tinta oscura sobre la imagen oscura del producto y se perdía; ahora es crema con texto tinta, anillo dorado y un puntito dorado pulsante (mismo lenguaje visual que el countdown de Flash Sale). **Dato no obvio**: usa los tonos de la paleta en **hex fijo** (`#f0e6c8`/`#16130d`/`#c9a227`/`#a3821a`) en vez de las clases del tema, porque la imagen de producto detrás es oscura en ambos temas (degradé fijo de `ProductImage`) pero `gold-pale` se vuelve oscuro en dark mode — con clases del tema el badge desaparecería de noche. Verificado con Playwright en ambos temas.
30. **Exportar Excel de productos sin foto** (2026-07-09, mismo día, a pedido del usuario) — junto al contador "📷 N sin foto" de la pestaña Productos hay ahora un botón "⬇️ Descargar Excel" (solo admin) que genera `zimaxx-productos-sin-foto-<fecha>.xlsx` vía `downloadMissingPhotosExcel()` en `src/utils/excel.js` (XLSX lazy, igual que los otros exports). **El formato es deliberadamente el mismo que acepta la carga "Fotos por Excel" de esa pestaña**: columnas `SKU` / `Nombre` / `Imagen` (vacía) — se completa la columna Imagen con los links y se re-sube el archivo tal cual, sin tocar encabezados. Round-trip verificado con Node + el xlsx real del proyecto: los encabezados normalizan a `sku`/`nombre`/`imagen`, todos alias de `IMAGE_COLS` en `ProductsAdmin.jsx`; filas aún sin link se cuentan como omitidas al subir (comportamiento ya existente del parser de fotos). Exporta el mismo conjunto que muestra el contador (todos los productos sin `image_url`, activos e inactivos), para que el número de filas coincida con el chip.
31. **Lista de precio + acceso admin para Luzmar Quintero (jefa de vendedoras)** (2026-07-09, a pedido del usuario) — dos cosas separadas, cada una con su propio archivo de migración chico (mismo criterio que la migración de `new_until`: evitar re-correr el `schema.sql` completo y su riesgo de deadlock). (a) **Lista de precio propia** (`migration-2026-07-09-luzmar-list.sql`, solo un INSERT — sin riesgo de lock, a diferencia de un ALTER TABLE): nueva fila `code = 'luzmar'` en `price_lists` (agregada también al seed de `schema.sql` para instalaciones nuevas), sin ninguna lógica de negocio especial como `quote`/`special` — es una lista de precio normal más, aparece sola en el selector "Lista" de `ClientsAdmin.jsx` porque ese selector ya lee `price_lists` dinámicamente de la base (no hubo que tocar el frontend de clientes). Se le sube Excel de precios igual que a cualquier otra en la pestaña Precios: se agregó a `LIST_ALIASES`/`LIST_ORDER` en `PricesUpload.jsx` (alias de columna: "Luzmar", "Luzmar Special", "Precio Luzmar", "Luzmar Especial") y al hint de i18n. (b) **Vista admin completa** (`migration-2026-07-09-luzmar-admin.sql`): insert en `admins` con su `user_id` (resuelto por email desde `auth.users`) — como `get_my_role()` chequea `is_admin()` antes que `is_vendedora()`, con esto ve todos los clientes/pedidos/vendedoras igual que cualquier admin, sin perder su fila de `vendedores` (sigue recibiendo clientes asignados y su teléfono sigue funcionando para el link de WhatsApp). No hubo que tocar código frontend para esta parte: el sistema de roles ya soportaba que una persona sea vendedora Y admin a la vez, solo faltaba la fila en la tabla. Requiere que ya exista su usuario en Supabase Auth (mismo que se usa para el login de vendedora).
32. **Garantía: cliente con lista "personal" siempre queda con su dueña** (2026-07-09, a pedido del usuario, tras preguntar "¿alguien puede ponerle la lista de Luzmar a un cliente y asignarlo a otra vendedora?" — la respuesta era sí, nada lo impedía) — se agregó el concepto de lista "personal": `price_lists.owner_vendedora_id` (nullable, FK a `vendedores`; migración `migration-2026-07-09-luzmar-owner-link.sql`, vincula `code = 'luzmar'` a la fila "Luzmar Quintero" por nombre). **Dos capas, no una sola**: (a) *UX en `ClientsAdmin.jsx`*: al elegir una lista con dueña en el alta de cliente, el campo Vendedora se reemplaza por texto fijo con su nombre (ya no es un select editable); en la edición inline de lista de un cliente existente (`updateList`) y en la carga masiva por Excel (`handleFile`), la vendedora se fuerza al dueño de la lista sin importar qué diga el formulario/archivo. Una vendedora sin rol admin además ni siquiera ve en su selector una lista personal ajena (`selectablePriceLists` filtra por `owner_vendedora_id === myVendedoraId`), para que no pueda auto-asignarse un cliente con precios que no le pertenecen. (b) *Garantía real en la base*: trigger `clients_enforce_owner_vendedora` (`before insert or update on clients`, función `enforce_owner_vendedora()`) que pisa `vendedora_id` con el dueño de la lista SIEMPRE que la lista tenga uno — cubre cualquier escritura que se le escape a la UI (API directa, script, etc.), no solo los tres caminos ya cubiertos en el frontend. La UI sigue siendo necesaria aparte del trigger: sin ella el cliente vería el campo Vendedora "aceptando" una selección que en realidad el trigger va a pisar en silencio, lo cual confundiría más que ayudar.
33. **Dos correcciones tras probar en producción** (2026-07-09, mismo día, a pedido del usuario, después de correr las migraciones de Luzmar). (a) *Filtro de listas seguía mostrando la lista ajena*: el usuario entró como una vendedora que no es Luzmar y vio "Luzmar - Precio Especial" en el filtro de listas de la pestaña Clientes — el candado del punto 32 solo se había aplicado al selector del alta de cliente, no a este otro `<select>` de `listFilter` (usaba `priceLists` sin filtrar). Corregido: también usa `selectablePriceLists`. (b) *WhatsApp no abría en iPhone*: el usuario notó que un teléfono de vendedora sin código de país "funciona" en WhatsApp Android (adivina el país del dispositivo) pero el link `wa.me` no abre el chat en iPhone — tuvo que agregar el código a mano. Se agregó `hasCountryCode()` en `format.js` (heurística: 11+ dígitos limpios) y se usa en tres puntos para que no vuelva a pasar: el alta y la edición inline de teléfono en `VendedoresAdmin.jsx` **bloquean** guardar un teléfono de menos de 11 dígitos con un mensaje explicando el porqué (hint permanente bajo el campo del alta); la carga de clientes por Excel (`ClientsAdmin.jsx`) descarta el teléfono de vendedora que venga sin código de país en vez de guardarlo roto (se cuenta y reporta en el resultado de la carga); y la tabla de Vendedoras muestra un ⚠️ junto a cualquier teléfono YA guardado que le falte el código, para pescar los que quedaron mal antes de este fix. El teléfono del cliente (no usado para WhatsApp, solo para identificarlo/deduplicar) no se tocó — el problema era específico del teléfono de vendedora, el único que arma el link `wa.me`.
34. **Etiquetas amigables + normalización para `product_line`** (2026-07-08, mismo día, a pedido del usuario) — el usuario aclaró que la idea era poder filtrar **directamente** para ver solo diseñador o solo árabes, no navegar una lista de valores crudos del Excel. Se agregó `parseLine()` en `ProductsAdmin.jsx` que normaliza al importar: cualquier valor con "arabe" (sin importar mayúsculas/acentos) → `'Perfume - Arabes'`, cualquier variante de "perfume"/"perfums" (typo real que aparece 1 vez en `119389.xlsx`) → `'Perfume'`; todo lo demás (Beauty, Electronics...) queda tal cual. Además, tanto `Catalog.jsx` como `ProductsAdmin.jsx` tienen ahora una función local `lineLabel(raw)` que traduce esos dos valores canónicos a `t('lineDesigner')`/`t('lineArabic')` ("Diseñador"/"Árabes") al mostrarlos en chips/selects/badges — el valor guardado en la base sigue siendo el texto en inglés (`'Perfume'`/`'Perfume - Arabes'`), solo cambia lo que se renderiza. No se compartió la función entre los dos archivos porque depende de `t()` (i18n), que ya está disponible en cada componente vía `useI18n()` — duplicar una función de 1 línea salió más simple que armar un helper compartido para eso.
35. **Infraestructura SQL para el sync SellerCloud → Supabase vía n8n** (2026-07-10, a pedido del usuario) — `migration-2026-07-10-sellercloud-sync.sql`, mismo criterio de migración chica e idempotente que las anteriores (sin re-correr `schema.sql`, `lock_timeout = '5s'`). Solo el lado base de datos: tabla `sync_runs` (auditoría de corridas: status running/ok/error + contadores + error_detail; RLS con lectura solo-admin, n8n escribe directo con la service_role key que bypassea RLS) y tres funciones SECURITY DEFINER ejecutables **solo por `service_role`** — `sync_upsert_products` / `sync_upsert_prices` / `sync_upsert_clients` (detalle en la sección RPC). Decisiones no obvias: (a) las tres replican el criterio de las cargas Excel existentes — upsert, **nunca delete** ni desactivación, para que un export parcial no mate datos; (b) en updates de productos los campos opcionales (`category`/`product_line`/`image_url`/`availability`) solo pisan si vienen con dato, y `new_until` no se toca (re-sincronizar no re-etiqueta ✨ Nuevo), pero productos nuevos sí entran con `new_until = +10 días` como el alta manual; (c) los tokens de clientes nuevos se generan server-side con `sync_generate_token()` — mismo alfabeto de 54 caracteres sin ambiguos de `token.js`, con entropía de `gen_random_uuid()` (RNG fuerte) y no `random()` de Postgres, porque el token es lo único que protege el catálogo; (d) `sync_upsert_clients` no maneja listas personales a propósito — el trigger `clients_enforce_owner_vendedora` (punto 32) ya corre en esos insert/update y pisa `vendedora_id`, así que duplicar esa lógica en la función solo crearía dos lugares que mantener; (e) `sync_upsert_prices` rechaza `code = 'quote'` con exception (esa lista no lleva precios, `PricesUpload.jsx` también la excluye). El workflow de n8n en sí NO está hecho; el orden esperado es: correr la migración → probar con los selects comentados al final del archivo → conectar n8n con la service_role key.
36. **Stock en la BD + disponibilidad automática por stock** (2026-07-14, a pedido del usuario — evolución de "en el catálogo se muestran productos sin inventario ni a la venta"). El primer intento de este día (borrador `migration-2026-07-14-inventory-active.sql`, **borrado**, nunca corrido) hacía que el inventario controlara `active`; el usuario lo replanteó: mejor **registrar el stock** en la BD (oculto en la app) y usarlo para decidir la disponibilidad, dejando activo/inactivo como decisión manual. Diseño final (confirmado con AskUserQuestion — el usuario eligió "stock solo decide disponibilidad" y "stock manda pero respeta flash", y aclaró que el stock negativo también es pre-order): (a) nueva columna `products.stock int` nullable (null = "no se sabe aún", distinto de 0 = sin stock), NO expuesta en `get_catalog`; (b) en cada carga/sync la disponibilidad se deriva del stock: `>= 1` → available, `0`/negativo → preorder, salvo que sea `flash` (Type = Flash Sale, entrante o ya guardado) que se conserva — el stock solo alterna available↔preorder; (c) `active` ya NO lo toca el sync (revierte el enfoque del borrador): es 100% manual (bulk, ver punto 37) + la exclusión de no-catálogo. Implementación: `migration-2026-07-14-inventory-stock.sql` (reescribe `sync_upsert_products` sobre la versión de no-catálogo — agrega `stock` al insert/update y deriva `availability` con `coalesce(entrante, existente) = 'flash'` para respetar flash; `active` fuera del insert/update) y `ProductsAdmin.jsx` (`COLS.inventory` + `parseStock()` + `resolveAvailability()` con la MISMA regla que el SQL, `hasInventory` guard — solo aplica si el archivo trae la columna). **Sólido ante campo ausente**: fila sin inventario → `stock`/`availability` no se pisan. **Sin backfill**: `products` no tenía la cantidad de stock hasta ahora, así que los productos sin stock ya cargados (por el Excel `119389.xlsx`, que NO trae columna de inventario — solo ProductID/UPC/PRODUCTBRAND/ProductName/GalleryImageURL/PRODUCT_CATEGORY) se corrigen recién en la primera corrida del sync con `InventoryAvailableQTY`, o se apagan a mano con el bulk mientras tanto. **Pendiente del usuario**: correr `migration-2026-07-14-inventory-stock.sql`; el n8n (cuando se arme) mapea `InventoryAvailableQTY` → `inventory`. El código ya se puede desplegar. Verificado: build limpio + tests de `parseStock()`/`resolveAvailability()` (0/negativo→preorder, ≥1→available, flash se conserva, JS idéntico al SQL) + selects de prueba comentados en la migración.
37. **Activar/desactivar productos en bloque (por casillas)** (2026-07-14, a pedido del usuario, mismo día que el punto 36) — `ProductsAdmin.jsx`: columna de casillas (solo admin) + casilla de encabezado que selecciona/deselecciona **todos los productos que pasan los filtros actuales** (no solo los renderizados por el scroll infinito — usa `filtered`, no `visibleRows`). Estado `selected` (Set de ids). Con 1+ seleccionados aparece una barra sticky con el conteo y botones Activar/Desactivar (`bulkSetActive(value)` → `supabase.from('products').update({active}).in('id', ids)`, limpia la selección y recarga) + Limpiar. También se agregó la columna **Stock** en la tabla (número, rojo si `<= 0`, "—" si null) y dos opciones de filtro por stock en el select de estado (Con stock `>= 1` / Sin stock `<= 0`), para identificar rápido qué apagar/prender. i18n nuevas: `stock`/`inStock`/`outOfStock`/`selected`/`selectAll`/`activate`/`deactivate`/`clearSelection`. Este bulk es la contraparte manual del punto 36: como el stock ya no apaga productos solo, el admin apaga/prende a mano (ej. los sin stock ya cargados hasta que corra el sync).
38. **UPC del producto en el admin** (2026-07-14, a pedido del usuario) — nueva columna `products.upc` (text nullable, `migration-2026-07-14-product-upc.sql`, que reescribe `sync_upsert_products` sobre la versión de stock del punto 36, agregando solo el `upc` con coalesce). Dato interno del admin: **no** lo expone `get_catalog` (como sku/stock). En `ProductsAdmin.jsx`: `COLS.upc` (alias `upc`/`barcode`/`ean`/`codigo de barras`) en la carga por Excel (`hasUpc` guard), campo UPC en el formulario de alta/edición, columna UPC en la tabla y sumado a la búsqueda de texto (nombre/SKU/UPC). Verificado contra `119389.xlsx`: la columna `UPC` se detecta y se lee (ej. `6290362349730`). El n8n, cuando se arme, debe mapear `UPC` → `upc` en el payload de `sync_upsert_products`.
39. **Reasignar y eliminar clientes con auditoría** (2026-07-14, a pedido del usuario) — dos acciones sensibles en la pestaña Clientes, **solo admin**, que quedan REGISTRADAS para saber qué usuario las hizo. Decisión de diseño clave: se hacen vía RPC SECURITY DEFINER (`reassign_client`/`delete_client`), NO con `update`/`delete` directos desde el frontend — así el insert en `admin_audit_log` (quién por `auth.uid()`+email, qué acción, snapshot del cliente, cuándo) es atómico e imposible de saltear. `migration-2026-07-14-client-admin-actions.sql` crea la tabla `admin_audit_log` (RLS: lectura solo admin, la escriben solo esas funciones) + las dos RPC. **Reglas**: `reassign_client` (p_vendedora_id null = sin asignar) rechaza clientes con lista personal (`owner_vendedora_id` — el trigger `clients_enforce_owner_vendedora` lo revertiría igual, mejor error claro); `delete_client` rechaza si el cliente tiene pedidos (`orders.client_id` es FK RESTRICT sin cascade y `orders` no guarda copia del nombre → borrarlo perdería el historial de ventas; el admin puede reasignar pero no borrar esos). **Frontend** (`ClientsAdmin.jsx`): la columna Vendedora pasó de texto estático a un `<select>` de reasignación por fila (salvo lista personal, que queda estática); botón "Eliminar" con confirmación inline (Sí/No en la misma fila, no `window.confirm`); banner de error arriba de la tabla para los `raise exception` de las RPC; y una sección colapsable "🛡️ Registro de movimientos" (solo admin) que lee `admin_audit_log` (fecha, email del usuario, acción, cliente, detalle — reasignación muestra "de → a", borrado muestra tel/vendedora/lista). i18n nuevas: `deleteAction`/`deleteConfirmClient`/`yes`/`no`/`reassign`/`activityLog`/`user`/`action`/`actionReassign`/`actionDelete`/`noActivity`. **Decisión señalada**: admin-only porque reasignar a OTRA vendedora y borrar son inherentemente acciones de gestión del equipo; si más adelante se quiere que una vendedora pueda algo de esto, se ajustan las RPC. Verificado: build limpio (la lógica admin real requiere sesión autenticada, no probable en el sandbox — mismo criterio que otros cambios admin-only).
40. **Flash Sales oculto para vendedora + lista "personal" solo para su dueña** (2026-07-15, a pedido del usuario, correcciones antes de armar la creación de otros accesos de vendedora) — dos huecos de acceso detectados sobre lo ya construido. (a) *Flash Sales*: `AdminLayout.jsx` armaba esa pestaña para cualquier rol autenticado (a diferencia de Vendedoras, que ya estaba `isAdmin`-gated); se cambió a `...(isAdmin ? [...] : [])` igual que Vendedoras, y se sumó `/admin/flash` al mismo `if` de redirect que ya protegía `/admin/vendedoras` por URL directa. No se tocó RLS de `flash_sales` (blanket `is_vendedora()` sigue igual) porque las ofertas no son un dato sensible por vendedora — son las mismas que ve cualquier cliente vía `get_flash_sales()` público; acá el pedido era puramente ocultar la pestaña. (b) *Lista "personal" (`luzmar`)*: `ClientsAdmin.jsx` ya filtraba `selectablePriceLists` para que una vendedora no-dueña no pudiera **asignar** un cliente a esa lista (punto 32/33), pero la matriz de `PricesUpload.jsx` y su selector de listas no tenían ningún candado — mostraban la columna/precio real de Luzmar a cualquier vendedora, porque `vendedora_select_readonly` daba a **cualquier** vendedora `select` de **toda** `price_lists`/`product_prices` sin distinguir dueña. Se sacó `price_lists`/`product_prices` del loop genérico de esa policy y se agregaron dos policies propias (`vendedora_select_price_lists`/`vendedora_select_product_prices`) que exigen `owner_vendedora_id is null or owner_vendedora_id = current_vendedora_id()` — la fila de `luzmar` directamente no viene en la respuesta de Supabase para el resto, así que ni la matriz ni el selector necesitaron tocarse (ya renderizan lo que Supabase les da). `migration-2026-07-15-restrict-vendedora-luzmar.sql`, mismo criterio idempotente + `lock_timeout` corto que las anteriores — **pendiente de correr en producción**; hasta entonces el blanket viejo sigue activo. `schema.sql` también se actualizó para que una instalación nueva nazca con la policy correcta. Frontend: nada nuevo, ya filtraba lo suficiente en `ClientsAdmin.jsx`. Verificado: build limpio; no se pudo probar en vivo con una segunda vendedora real (requiere producción), la garantía real vive en RLS igual que el resto del rol vendedora.
41. **Registro de movimientos en panel propio + crear accesos de vendedora desde el admin** (2026-07-15, mismo día que el punto 40, a pedido del usuario) — dos cosas separadas. (a) *Panel propio*: el Registro de movimientos (auditoría de reasignar/eliminar clientes, punto 39) vivía como sección colapsable al fondo de `ClientsAdmin.jsx`; se pidió que fuera un panel aparte, entre Clientes y Vendedoras. Se creó `AuditLogAdmin.jsx` (carga directo al montar, sin toggle — ya no hace falta ocultarlo dentro de otra pestaña) con la misma tabla/estilos que tenía la sección vieja, ruta `/admin/audit`, y se sacó todo el estado/JSX de auditoría de `ClientsAdmin.jsx`. `AdminLayout.jsx`: nueva pestaña `isAdmin`-gated entre Clientes y Vendedoras, y `/admin/audit` sumado al mismo redirect que ya protegía `/admin/vendedoras`/`/admin/flash` si una vendedora entra por URL directa. (b) *Crear accesos de vendedora*: hasta ahora `VendedoresAdmin.jsx` solo podía **vincular** (`link_vendedora_login`) un usuario de Supabase Auth ya creado a mano en el dashboard — el usuario pidió poder **crearlo** directo desde el panel. Se le preguntó al usuario cómo debía funcionar la contraseña inicial (AskUserQuestion: admin la escribe / se genera sola y se muestra una vez / invitación por email) y eligió **"el admin la escribe"** — mismo criterio que ya usa con el link del catálogo (se la pasa por WhatsApp, sin depender de que un email de invitación llegue o no). Crear un usuario CON contraseña requiere la Admin API de GoTrue (`auth.admin.createUser`), que solo acepta la **service_role key** — nunca se puede llamar desde el navegador, así que no podía ser una RPC de Postgres como `link_vendedora_login` (esa sí, porque solo lee/escribe tablas normales). Se armó `supabase/functions/admin-create-vendedora-user/index.ts`, la primera Edge Function del proyecto (antes solo se había *analizado* una para SellerCloud, nunca implementada — ver Roadmap): valida que quien llama sea admin llamando a la RPC `is_admin()` ya existente **con el JWT de quien llama** (no con la service_role key, para no duplicar esa regla en dos lugares), crea el usuario (`email_confirm: true`, no hace falta que confirme el email — no hay flujo de email configurado en este proyecto) y en el mismo paso vincula `vendedores.user_id`/`login_email`; si el link fallara por lo que sea, borra el usuario recién creado para no dejar un usuario de Auth huérfano sin vendedora asociada. Frontend: `VendedoresAdmin.jsx` — en la columna Acceso, si no hay login vinculado, aparecen dos caminos: el "Vincular acceso" que ya existía (para un usuario que ya existe en Auth) y un link nuevo "+ Crear acceso" que abre un formulario chico inline (email + contraseña, mínimo 6 caracteres) y llama `supabase.functions.invoke('admin-create-vendedora-user', ...)`. Manejo de error no obvio: `functions.invoke` de supabase-js, ante una respuesta no-2xx, devuelve un `FunctionsHttpError` cuyo `.message` es genérico ("Edge Function returned a non-2xx status code") — el mensaje real que arma la función (ej. "esta vendedora ya tiene un acceso vinculado") hay que leerlo de `error.context.json()`, no de `error.message` directo. **Pendiente del usuario**: como toda Edge Function, no se auto-despliega — hay que correr `supabase functions deploy admin-create-vendedora-user` una vez (con `supabase login`/`supabase link` si es la primera función del proyecto). No hacen falta secrets nuevos: `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` ya vienen inyectadas por el runtime de Edge Functions. Verificado: build limpio; no se pudo probar la Edge Function en vivo (necesita estar desplegada en un proyecto real de Supabase, imposible en este sandbox) — mismo criterio que el resto de features que dependen de producción.
42. **Estado "Cancelado" para pedidos** (2026-07-15, mismo día que los puntos 40/41, a pedido del usuario — "por si las órdenes son armadas pero después las cancelan") — `orders.status` solo aceptaba `'new'`/`'done'` (CHECK constraint `orders_status_check`, agregado en el punto 8 del ciclo de vida original). Se sumó `'cancelled'`. Diseño: en vez de convertir el botón único "Marcar atendido ↔ Reabrir" en un `<select>` de 3 estados, se mantuvo el patrón de botones existente pero condicionado — un pedido `new` (el default) muestra **dos** botones, "Marcar atendido" y "Cancelar" (ambos parten de Nuevo, ninguno tiene sentido para el otro); un pedido `done` o `cancelled` muestra un solo botón "Reabrir" que vuelve a `new` (mismo texto/acción que ya existía, ahora también sirve para deshacer una cancelación). Badge de estado con color propio para cada uno (`STATUS_STYLES` en `OrdersAdmin.jsx`, mismo patrón que `STATUS_STYLES` de `FlashSalesAdmin.jsx` — rojo para cancelado). El filtro de estado de la pestaña Pedidos suma la tercera opción. **Nada de RLS nuevo**: la policy `vendedora_update_own_orders` (punto 12) ya permite a una vendedora actualizar cualquier campo de sus propios pedidos, así que puede cancelar/reabrir los suyos igual que ya podía marcar atendido — es el mismo nivel de confianza que ya existía, no uno nuevo. El contador de pedidos sin atender del menú admin (`AdminLayout.jsx`) sigue contando solo `status = 'new'`, sin cambios. `migration-2026-07-15-order-status-cancelled.sql`: solo recrea el CHECK constraint (drop + add), no toca filas — **pendiente de correr en producción**; hasta entonces intentar cancelar un pedido falla contra la base (constraint viejo lo rechaza). `schema.sql` también actualizado (el `ADD COLUMN IF NOT EXISTS ... CHECK (...)` original no se vuelve a aplicar en una instalación ya existente, así que el CHECK se separó en su propio `ALTER TABLE ... ADD CONSTRAINT`, drop+create, para que quede correcto tanto en instalaciones nuevas como reaplicando el schema). Verificado: build limpio.
43. **Vendedora puede cambiar la lista de precio de sus clientes (con confirmación) + filtros en el Registro de movimientos** (2026-07-15, mismo día que los puntos 40/41/42, a pedido del usuario) — dos cosas relacionadas. (a) *Cambiar lista*: hasta ahora, cambiar `clients.price_list_id` desde `ClientsAdmin.jsx` era un `update` directo contra la tabla, mostrado solo si `isAdmin` — una vendedora no tiene (ni tenía) ninguna policy RLS de UPDATE en `clients` (solo `select`/`insert` de lo suyo), así que ni habilitando el control en la UI hubiera funcionado. Se creó la RPC `update_client_price_list(p_client_id, p_price_list_id)`: permite admin (cualquier cliente) o vendedora (solo si `client.vendedora_id = current_vendedora_id()`), rechaza que una vendedora asigne una lista "personal" ajena (mismo candado que ya existía en `selectablePriceLists` del frontend, reforzado server-side), y **audita el cambio en `admin_audit_log`** con acción `update_price_list` — algo que el `update` directo de antes NUNCA había registrado, ni siquiera para admin. Frontend: se agregó **confirmación antes de aplicar** (a pedido explícito del usuario: "se abre el dropdown, seleccionás una opción y sale una alerta, ¿estás seguro?, confirmar o cancelar") — en vez de un `window.confirm()` nativo (el proyecto ya evita esos, ver el patrón Sí/No inline de "Eliminar cliente"), se armó `ListPicker` (componente nuevo, top-level en `ClientsAdmin.jsx` — no anidado adentro del componente de la pestaña, porque un componente definido dentro de otro se recrea en cada render y podría perder foco/estado): elegir una opción no dispara el cambio, deja un `pendingList = {clientId, listId}` y muestra un cartel "¿Cambiar la lista a X?" con Confirmar/Cancelar; cancelar no hace nada (el `<select>` es controlado y vuelve solo al valor viejo). Mismo componente reusado para admin (con `priceLists`, todas las listas) y vendedora (con `selectablePriceLists`, sin las personales ajenas) — antes una vendedora ni veía un selector acá, ahora sí. **Decisión importante**: el campo "$ inversión → nivel" (auto-aplica el nivel según el monto, solo admin) sigue siendo instantáneo, SIN confirmación — el pedido del usuario era específicamente sobre el dropdown, y ese campo está pensado para carga rápida (Enter/blur aplica al toque); agregarle fricción hubiera roto ese flujo a propósito. `migration-2026-07-15-vendedora-update-price-list.sql` — **pendiente de correr en producción, y es rompedora si no se corre**: como el frontend ya no usa el `update` directo (fue reemplazado por completo por la RPC), cambiar la lista de un cliente falla para CUALQUIERA, admin incluido, hasta que esta migración corra. De paso se detectó y corrigió un gap viejo: `admin_audit_log` (tabla + RLS `admin_read_audit`), creada en `migration-2026-07-14-client-admin-actions.sql`, nunca se había mergeado de vuelta a `schema.sql` — se agregó ahí también, porque la RPC nueva la necesita para que una instalación nueva desde cero funcione (ver Roadmap: `schema.sql` viene atrasado desde el sync de SellerCloud, 2026-07-10; no se intentó reconciliar todo lo demás en esta sesión, sería un cambio grande aparte). (b) *Filtros en el Registro de movimientos*: `AuditLogAdmin.jsx` (recién creado en el punto 41 el mismo día) sumó selector de usuario (emails distintos entre las filas ya cargadas, mismo patrón que el filtro de vendedora de `OrdersAdmin.jsx`), selector de acción (Reasignación/Eliminación/**Cambio de lista**, esta última nueva por (a)) y rango de fechas (`dateFrom`/`dateTo`, dos `<input type="date">`, comparados contra `created_at.slice(0, 10)` — alcanza porque son fechas ISO). El límite de filas cargadas subió de 100 a 200 (mismo criterio que "Últimos 200" de Pedidos) para que los filtros tengan más para trabajar; sigue sin ser fetchAll completo, así que un filtro de fecha muy viejo puede no traer nada si esas filas ya cayeron fuera de la ventana de 200 — no se pidió paginación completa y hubiera sido sobre-ingeniería para el alcance de este pedido. Verificado: build limpio; no se pudo probar en vivo el flujo de confirmación ni la RPC (requieren producción).
44. **Clientes duplicados por formato de teléfono (con/sin código de país)** (2026-07-15, mismo día, reportado por el usuario: "hubo un duplicado de algunos clientes debido a que algunos tenían el número con el código de país y otros el mismo número pero sin el código") — el usuario corrió el query de diagnóstico que se le dio (agrupar por `right(regexp_replace(phone, '\D', '', 'g'), 10)`, los últimos 10 dígitos) y devolvió **~45 pares duplicados**, todos con un patrón idéntico: la fila vieja (creada 2026-07-02, con teléfono `51...` — código de país de Perú — y con lista de precio/vendedora/a veces pedidos) y una fila nueva (creada 2026-07-15 16:09:03.365952+00, **exactamente el mismo timestamp en las ~45 filas** — la huella de una corrida en lote, no de altas manuales separadas —, con el mismo teléfono SIN el `51`, `price_list_id` null y 0 pedidos). Ese patrón (`price_list_id` null en el insert, timestamp idéntico en lote) es exactamente el comportamiento documentado de `sync_upsert_clients` (punto 35): **evidencia fuerte, aunque no confirmada explícitamente por el usuario, de que el workflow de n8n del sync SellerCloud→Supabase ya está corriendo en producción** — el Roadmap decía "el workflow de n8n en sí NO está hecho", hay que confirmar con el usuario si esto cambió sin que quedara registrado acá. **Causa raíz encontrada en dos lugares con el mismo bug** (comparar el teléfono como string completo en vez de por el número nacional real): (a) `ClientsAdmin.jsx` (`handleFile`, carga por Excel) — corregido en el commit anterior de esta misma sesión (ver memoria de esa conversación) con `phoneKey(phone) = cleanPhone(phone).slice(-10)`, ya usado en el `Map` de matching y en el chequeo previo al insert de "+ Nuevo cliente". (b) `sync_upsert_clients` (SQL, `migration-2026-07-10-sellercloud-sync-v2.sql`) — el paso de "adopción one-shot por teléfono" (línea `regexp_replace(phone, '\D', '', 'g') = v_phone`) tenía el mismo problema: si SellerCloud manda el teléfono sin el `51` y la fila ya cargada lo tiene, no la encuentra y crea un cliente nuevo con `sellercloud_id` seteado — origen real de los ~45 duplicados. `migration-2026-07-15-fix-duplicate-client-phones.sql` hace tres cosas en orden: (1) **adopta** el `sellercloud_id` de cada fila "basura" (sin lista, sin pedidos, creada por el sync) en la fila real correspondiente, ANTES de borrar — así queda vinculada ya mismo, sin depender de la próxima corrida del sync; (2) **borra** las filas basura, con una regla deliberadamente conservadora (`price_list_id is null` AND `sellercloud_id is not null` AND cero pedidos AND existe otra fila con el mismo teléfono normalizado que sí tiene lista) — si alguien ya le asignó lista a mano a una de esas filas antes de correr la migración, la condición (a) la excluye del borrado sola, sin arriesgar perder trabajo manual; (3) recrea `sync_upsert_clients` (mismo cuerpo que la v2, único cambio real: la adopción por teléfono ahora compara `right(...,10)` en vez del string completo) y agrega un **índice único** `clients_phone_normalized_key` sobre el teléfono normalizado — con los duplicados ya limpios, este índice blinda a nivel de base de datos contra que el bug vuelva a colarse por CUALQUIER camino (Excel, alta manual, o el sync), no solo por los dos que ya se corrigieron a mano; un intento de insertar un teléfono que ya existe en otro formato choca con `unique_violation`, que `sync_upsert_clients` ya atrapaba (cuenta en `phone_conflicts`, no tumba la corrida) y que el frontend ya evita de entrada con `phoneKey()`. **Por qué el número nacional son los últimos 10 dígitos, no una cantidad fija por país**: tanto US/Canadá (código "1", número nacional de 10 dígitos) como Perú (código "51", visto en esta corrida real) como Venezuela (código "58" o troncal "0", número nacional de 10 dígitos) coinciden en que el número nacional real son 10 dígitos — no hizo falta detectar/mapear el código de cada país, solo ignorarlo al comparar. **Pendiente y urgente del usuario**: correr esta migración en producción — mientras no se corra, si el sync sigue activo, **cada corrida nueva sigue creando más duplicados** con el mismo patrón. Verificado: la query de diagnóstico y el análisis del patrón se hicieron sobre el resultado real que pegó el usuario (no en un sandbox); la migración en sí no se pudo ejecutar ni verificar en vivo (requiere producción, y este entorno no tiene la service_role key ni acceso directo a la base).

45. **Fix del orden de `migration-2026-07-15-fix-duplicate-client-phones.sql` + backup** (2026-07-15, mismo día, continuación del punto 44 — el usuario corrió la migración y reportó `ERROR: duplicate key value violates unique constraint "clients_sellercloud_id_key"`; el análisis de esta sesión retomó después de una falla eléctrica que cortó la sesión anterior a mitad de este mismo arreglo). **Causa real**: el orden original (adoptar el `sellercloud_id` en la fila real ANTES de borrar la fila basura) deja, durante el mismo `UPDATE`, un instante en el que la fila real y la fila basura comparten el mismo `sellercloud_id` — el índice único lo rechaza ahí mismo, no hace falta llegar al `DELETE`. **Fix**: se reescribió en una transacción explícita (`begin`/`commit`, las tablas temporales son `on commit drop` así que tienen que sobrevivir hasta el commit final) con el orden invertido: (1a) capturar en tablas temporales (`_dup_merge_map`/`_dup_junk_ids`) qué fila borrar y a quién adoptar, sin tocar nada todavía; (1b) borrar primero las filas basura (libera el valor en el índice único); (1c) recién ahí copiar el `sellercloud_id` capturado a la fila real, cuando ya no hay ningún choque posible. Además, a pedido explícito del usuario, se agregó un paso de backup antes de tocar nada: `create table public.clients_backup_20260715 as select * from public.clients` (tabla normal, no temporal, para poder inspeccionar o revertir a mano después del commit; se borra manualmente una vez confirmado que todo quedó bien). **Caso borde documentado, no resuelto en este archivo**: el `distinct on (k.id)` de `_dup_merge_map` evita que una misma fila real reciba dos `sellercloud_id` distintos, pero no cubre lo inverso — si dos filas reales vivas (ambas con lista de precio, ninguna con `sellercloud_id`) compartieran el mismo teléfono normalizado, ambas competirían por adoptar el mismo `sellercloud_id` y el `UPDATE` volvería a chocar contra el índice único. Se le señaló al usuario como riesgo de datos preexistente (no algo que cause el sync), pendiente de confirmar con un SELECT antes de correr si se quiere descartar del todo. **Pendiente y urgente del usuario**: seguir sin correr; correr la versión actual del archivo (no la que falló) en producción.
