# Backfill de `clients.sellercloud_id`

Vincula los clientes de Supabase con sus customers de SellerCloud, UNA vez y
desde tu máquina — nunca corre en producción ni en la app. Sin `sellercloud_id`
el botón "📦 Enviar a SellerCloud" rechaza los pedidos del cliente.

## Requisitos

- Node 23+ (importa el `sellercloud.ts` real de la Edge Function).
- Variables de entorno (las mismas credenciales que los secrets del push +
  la service_role de Supabase):

```
SELLERCLOUD_BASE_URL=https://<servidor>.api.sellercloud.com
SELLERCLOUD_USERNAME=...
SELLERCLOUD_PASSWORD=...
SELLERCLOUD_COMPANY_ID=...
SUPABASE_URL=https://<proyecto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...   # Settings → API → service_role (¡no la anon!)
```

## Comandos (desde `zimaxx-store/`)

```bash
# 1) DRY-RUN (default): baja ambos universos, matchea y escribe los CSVs en
#    ./out — NO escribe nada en la base.
node scripts/backfill-sellercloud-ids/backfill.mjs

# 2) Revisar ./out:
#    - matches.csv    → los automáticos (email > teléfono > nombre único)
#    - ambiguous.csv  → a decidir a mano: completá la columna sellercloud_id
#                       con el candidato correcto (o dejala vacía para
#                       resolverlo después desde la ficha del cliente)
#    - unmatched.csv  → sin candidato allá: crearlos desde el panel
#                       ("Crear en SellerCloud" en la ficha) o allá a mano

# 3) Aplicar SOLO los automáticos (idempotente: un cliente que ya tenga ID
#    no se pisa jamás; re-correrlo no cambia nada):
node scripts/backfill-sellercloud-ids/backfill.mjs --apply

# 4) Aplicar los ambiguos que resolviste en el CSV (usa las columnas
#    client_id y sellercloud_id; las filas con sellercloud_id vacío se
#    ignoran):
node scripts/backfill-sellercloud-ids/backfill.mjs --apply-file out/ambiguous.csv
```

`--out <dir>` cambia la carpeta de salida (default `./out`).

## Reglas de matching (ver `matching.mjs`)

Por confianza descendente, cada cliente juega una sola vez:

1. **Email** exacto (minúsculas, trim) → automático si es 1:1.
2. **Teléfono** (solo dígitos, comparado por los últimos 10 para ignorar el
   código de país) → automático si es 1:1 **y** el teléfono no es compartido
   (`allow_shared_phone` o duplicado local): compartido = a revisión.
3. **Nombre** normalizado (sin acentos, minúsculas, espacios colapsados) →
   automático solo si es único de ambos lados.

Cualquier colisión manda a todos los involucrados a `ambiguous.csv` con los 3
candidatos más parecidos por nombre. Un customer solo puede asignarse a un
cliente (y viceversa). Nota técnica: el listado de SellerCloud no trae
teléfono, así que el script además busca server-side (`model.phoneNumber`) el
teléfono de cada cliente sin resolver antes de la pasada final.

## Errores

Rate limits (429), 5xx y fallos de red se reintentan con backoff exponencial
(hasta 6 intentos). En `--apply`, cada vínculo que NO se aplicó se lista al
final con su motivo exacto (ya tenía ID, ID tomado por otro cliente, error
HTTP) y el proceso termina con exit ≠ 0 — nunca aplica parcialmente en
silencio.

## Verificación

`node tests/backfill-matching-tests.mjs` corre los casos sintéticos del
matching (email gana a teléfono, teléfono compartido a revisión, nombre
duplicado a revisión, ya-vinculado intacto, idempotencia).
