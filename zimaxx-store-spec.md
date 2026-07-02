# Zimaxx Store — Especificación de proyecto

> Instrucciones para el agente: este documento es la especificación completa para construir el proyecto de principio a fin. Prioriza en este orden: (1) esquema de datos en Supabase con RLS, (2) catálogo funcional con resolución de precio por token, (3) carrito y checkout vía WhatsApp, (4) panel admin con carga de Excel, (5) build y configuración lista para desplegar en Netlify. Si algo no está definido explícitamente, toma la decisión más simple y documéntala en el README del repo en vez de bloquear el avance.

## 1. Resumen del proyecto

Zimaxx Perfumes es un distribuidor mayorista de fragancias árabes y de diseñador (Doral, FL) que vende B2B a distribuidores y revendedores en Latam, principalmente por WhatsApp e Instagram. El proyecto es un catálogo interactivo web donde el cliente arma un carrito de productos y genera su pedido, dirigido automáticamente a su vendedora asignada.

No hay login de cliente. Cada cliente accede mediante un link único con un token que identifica automáticamente su lista de precios, sin que el cliente tenga que hacer nada ni ver que existen otras listas.

## 2. Marca

- **Nombre del sitio:** Zimaxx Store
- **Color primario:** negro — `#0D0D0D`
- **Color secundario:** dorado — `#D4AF37` (hover/acentos más oscuros: `#B8962E`)
- **Fondo neutro:** blanco roto — `#F7F6F2` (para no forzar negro puro de fondo en pantallas grandes)
- Estos valores van como variables CSS (`--color-primary`, `--color-secondary`, `--color-bg`) para poder ajustarlos después sin tocar componentes.
- Tipografía: sans-serif moderna para UI (ej. system font stack o Inter). Si se quiere un acento de marca, un serif solo para el logo/nombre "Zimaxx Store" en el header. Esto es sugerencia, no restricción.

## 3. Idioma

- Detección automática según idioma del dispositivo/navegador (`navigator.language`): si empieza con `es`, mostrar español; cualquier otro caso, inglés por defecto.
- Selector manual de idioma visible en el header (por si el navegador no coincide con la preferencia real del cliente).
- Todos los textos de interfaz (botones, categorías, mensajes de carrito, checkout) deben pasar por un diccionario simple de traducción (objeto JS con claves `es`/`en`), no hace falta librería de i18n pesada.

## 4. Responsividad

- Mobile-first. La mayoría de clientes van a abrir el link desde WhatsApp en el celular.
- Breakpoints estándar: móvil (base), tablet (`≥768px`), desktop (`≥1024px`).
- El carrito debe ser accesible con una mano en móvil (botón flotante o barra inferior fija con total + "Ver carrito").

## 5. Listas de precios

| Lista | Comportamiento |
|---|---|
| US Minimum Order | Lista fija, resuelta por token del cliente |
| US Wholesale | Lista fija, resuelta por token del cliente |
| VE Minimum Order | Lista fija, resuelta por token del cliente |
| VE Wholesale | Lista fija, resuelta por token del cliente |
| Special Order | No es autoservicio. Botón "Solicitar cotización personalizada" que envía el detalle de productos deseados a la vendedora sin mostrar precio |
| Flash Sale | Set rotativo de productos en oferta (cambia cada ~15 días, sin frecuencia fija). Visible para cualquier cliente sin importar su lista. Tiene cuenta regresiva visible y expira automáticamente por fecha/hora |

Todas las listas y precios están en USD (no hay conversión de moneda entre US y VE).

## 6. Identificación de clientes por token

- Cada cliente tiene un registro con: nombre, teléfono, lista de precio asignada, vendedora asignada, y un **token único** (string no adivinable, ej. 8-10 caracteres alfanuméricos).
- El link que la vendedora envía por WhatsApp tiene el formato: `https://zimaxxstore.com/?c=<token>`
- El token se resuelve del lado del servidor (ver sección 8) para determinar qué lista de precio mostrar. El cliente nunca ve ni puede adivinar otras listas.
- **Actualización periódica desde Excel:** Zimaxx ya tiene un Excel con la lista de clientes actuales. El panel admin debe permitir subir ese Excel (o uno actualizado) para:
  - Crear clientes nuevos que no existan (genera token automáticamente).
  - Actualizar clientes existentes (match por teléfono, ya que es el identificador más estable) si cambia su lista de precio o vendedora asignada.
  - Nunca borrar clientes que no aparezcan en el Excel subido (solo crear/actualizar, para evitar que un archivo desactualizado elimine tokens en uso).
- Columnas esperadas del Excel (a confirmar con el archivo real antes de programar el parser): nombre, teléfono, lista de precio, vendedora.

## 7. Arquitectura de datos (Supabase)

Tablas:

- `clients` — id, name, phone, token (unique), price_list_id (FK), vendedora
- `price_lists` — id, code (`us_min`, `us_wholesale`, `ve_min`, `ve_wholesale`), label
- `products` — id, sku (unique), name, category, image_url, active
- `product_prices` — product_id (FK), price_list_id (FK), price
- `flash_sales` — id, product_id (FK), price, starts_at, expires_at, active
- `orders` — id, client_id (FK), items (jsonb), total, created_at
- `admins` — user_id (FK a `auth.users`), solo para autorizar escritura desde el panel admin

**Regla de seguridad no negociable:** las tablas `clients` y `product_prices` NO deben ser legibles directamente por el rol `anon` vía RLS. El catálogo público solo accede a los datos a través de dos funciones RPC (`SECURITY DEFINER`):

- `get_catalog(p_token text)` → resuelve el cliente por token internamente y devuelve productos + precio de su lista únicamente. Token inválido devuelve vacío, no un error descriptivo.
- `get_flash_sales()` → devuelve productos activos en flash sale con su `expires_at`. Es pública, no requiere token.

El panel admin, autenticado vía Supabase Auth, tiene permisos de escritura sobre todas las tablas solo si `auth.uid()` está presente en `admins`.

`orders` permite `INSERT` público (para registrar el pedido al confirmar carrito, como respaldo/auditoría) pero nunca `SELECT`, `UPDATE` ni `DELETE` desde el cliente.

## 8. Funcionalidades del catálogo (cliente)

- Ver productos por categoría, con buscador simple.
- Precio mostrado = el de la lista resuelta por su token (vía `get_catalog`).
- Sección "Flash Sale" destacada arriba del catálogo si hay productos activos, con cuenta regresiva en vivo hasta `expires_at`. Al expirar, se oculta sola sin recargar la página.
- Agregar/quitar productos del carrito, ajustar cantidades.
- Resumen del carrito con subtotales por producto y total.
- **Checkout:**
  - Genera un mensaje de WhatsApp formateado (`wa.me/<número de la vendedora>?text=...`) con el detalle del pedido (SKU, producto, cantidad, precio unitario, subtotal, total).
  - Botón adicional para descargar el mismo detalle como PDF (jsPDF), por si el cliente quiere adjuntarlo.
  - Al confirmar, se guarda una copia del pedido en `orders` (fallback de auditoría, no depende del CRM).
- **Special Order:** flujo separado, sin precios. El cliente arma una lista de productos deseados y el botón envía un mensaje de "solicitud de cotización" a la vendedora, sin montos.

## 9. Panel admin

- Ruta separada, ej. `/admin`, con login por email/password (Supabase Auth).
- **Carga de precios:** subir Excel/CSV con columnas SKU + una columna por lista de precio. Se parsea en el navegador (SheetJS) y se hace upsert sobre `product_prices`.
- **Carga de clientes:** subir el Excel de clientes (ver sección 6). Se parsea y se hace upsert sobre `clients`, generando tokens para los nuevos.
- **Gestión de productos:** alta, edición, imagen, categoría, activo/inactivo.
- **Gestión de flash sale:** seleccionar producto(s), precio promocional, fecha/hora de expiración.
- **Vista simple de pedidos:** listado de lo guardado en `orders`, solo lectura, útil para verificar que el checkout está funcionando.

## 10. Stack técnico

- Frontend: React + Vite (SPA).
- Estilos: Tailwind CSS.
- Datos/backend: Supabase (Postgres + Auth + RPC), vía `supabase-js`.
- Librerías: SheetJS (`xlsx`) para parseo de Excel en el panel admin, `jspdf` para el PDF de la orden.
- Hosting: Netlify. Build estático, variables de entorno para la URL y anon key de Supabase (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).

## 11. Fuera de alcance (por ahora)

- Integración directa con el CRM (Bigin/Zoho) vía webhook — queda para una fase posterior, no bloquea el lanzamiento.
- Registro/login de clientes — descartado explícitamente.
- Multi-moneda — todo en USD.

## 12. Entregables esperados

- Repositorio funcional, con build listo para Netlify (`netlify.toml` si aplica).
- Script SQL de Supabase: creación de tablas, políticas RLS, y las dos funciones RPC (`get_catalog`, `get_flash_sales`).
- README con instrucciones de deploy: variables de entorno necesarias, cómo correr localmente, cómo crear el primer usuario admin.
