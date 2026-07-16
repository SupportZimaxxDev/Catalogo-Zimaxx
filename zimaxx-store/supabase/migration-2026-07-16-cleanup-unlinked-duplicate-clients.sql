-- Limpieza de clientes duplicados sin sellercloud_id (2026-07-16, a pedido
-- del usuario). Contexto: la app todavía no está en producción, así que
-- la tabla `clients` debería ser un reflejo fiel de SellerCloud. Se
-- comparó el export real de SellerCloud (868 clientes activos, vía n8n)
-- contra los 1023 clientes de la app y aparecieron ~190 filas sin
-- `sellercloud_id` (nunca vinieron del sync, son de la carga masiva
-- inicial del 2026-07-02). De esas, 86 son duplicados CONFIRMADOS: el
-- mismo nombre ya existe en la app correctamente vinculado a SellerCloud
-- con otro `sellercloud_id` y su teléfono real — la fila vieja quedó
-- huérfana porque su teléfono (mal tipeado/incompleto en la carga
-- original) no coincidía ni siquiera en los últimos 10 dígitos con el
-- teléfono real de SellerCloud, así que el índice único de teléfono
-- (`clients_phone_normalized_key`) nunca la detectó como duplicado.
--
-- Las otras ~103 filas sin match (no existen bajo ningún nombre en el
-- export de SellerCloud) NO se tocan en esta migración — el usuario
-- pidió revisarlas por separado antes de decidir.
--
-- Esta migración SOLO borra las 86 filas listadas abajo por teléfono
-- exacto, y solo si siguen sin sellercloud_id y sin pedidos (por si algo
-- cambió entre el diagnóstico y la corrida). No toca la fila real que ya
-- tiene el sellercloud_id correcto — esa permanece intacta.
set lock_timeout = '10s';

begin;

-- Backup específico de esta limpieza (más chico que el del
-- 2026-07-15, solo de las filas candidatas) — por si hace falta revertir.
create table public.clients_backup_20260716_unlinked_dupes as
select * from public.clients
where sellercloud_id is null
  and not allow_shared_phone
  and phone in (
    '1786546938', '50577992738', '13059302660', '51992274269', '50588524764',
    '50251140346', '51928986623', '51980737877', '51934066355', '50576619680',
    '51928893071', '50588828388', '51958349602', '51905974209', '50231215843',
    '51943522572', '51962204052', '584146330638', '17866080721', '50586845898',
    '51991423231', '51951994981', '51940199260', '50578013905', '18296444279',
    '50557634064', '51932117765', '529612839588', '50585818841', '523339902070',
    '51947255091', '51913138509', '50581492557', '51943690939', '7865252944',
    '50576478619', '50583244175', '51930412790', '150584126875', '51961738288',
    '50583804044', '51991404127', '50586324120', '50585107195', '59995231019',
    '5930964136120', '50557255784', '50582831399', '50589222375', '3054775878',
    '18096693788', '17865235395', '50259716337', '51924901682', '50587465440',
    '13054646469', '50587530457', '50247605290', '5215666053533', '14424615616',
    '7863321351', '51923631051', '584140454549', '584243276704', '5216624510590',
    '51985471585', '7862231255', '51949252726', '51966229956', '50588524765',
    '51906156911', '734137877', '17866879611', '1990928345', '51992268397',
    '17866007296', '50557146782', '50586785841', '51947526675', '51923815248',
    '50577863969', '50588778186', '4147092434', '584144482906', '584127877632',
    '584244594899'
  );

-- Borra solo lo que sigue calzando el patrón (sin sellercloud_id, sin
-- pedidos, no marcado como excepción de teléfono compartido). Si alguna
-- de estas filas ganó un pedido entre el diagnóstico y ahora, se salta —
-- no se pierde ningún pedido por esta limpieza.
delete from public.clients c
where c.sellercloud_id is null
  and not c.allow_shared_phone
  and not exists (select 1 from public.orders o where o.client_id = c.id)
  and c.phone in (
    '1786546938', '50577992738', '13059302660', '51992274269', '50588524764',
    '50251140346', '51928986623', '51980737877', '51934066355', '50576619680',
    '51928893071', '50588828388', '51958349602', '51905974209', '50231215843',
    '51943522572', '51962204052', '584146330638', '17866080721', '50586845898',
    '51991423231', '51951994981', '51940199260', '50578013905', '18296444279',
    '50557634064', '51932117765', '529612839588', '50585818841', '523339902070',
    '51947255091', '51913138509', '50581492557', '51943690939', '7865252944',
    '50576478619', '50583244175', '51930412790', '150584126875', '51961738288',
    '50583804044', '51991404127', '50586324120', '50585107195', '59995231019',
    '5930964136120', '50557255784', '50582831399', '50589222375', '3054775878',
    '18096693788', '17865235395', '50259716337', '51924901682', '50587465440',
    '13054646469', '50587530457', '50247605290', '5215666053533', '14424615616',
    '7863321351', '51923631051', '584140454549', '584243276704', '5216624510590',
    '51985471585', '7862231255', '51949252726', '51966229956', '50588524765',
    '51906156911', '734137877', '17866879611', '1990928345', '51992268397',
    '17866007296', '50557146782', '50586785841', '51947526675', '51923815248',
    '50577863969', '50588778186', '4147092434', '584144482906', '584127877632',
    '584244594899'
  );

commit;

-- ---------- Verificación manual ----------
-- Debería confirmar que las 86 filas se borraron (0 filas):
-- select count(*) from public.clients_backup_20260716_unlinked_dupes b
-- where exists (select 1 from public.clients c where c.id = b.id);
--
-- Nuevo total y nuevo diff por vendedora (comparar contra el export de
-- SellerCloud):
-- select v.name, count(*) from public.clients c
-- join public.vendedores v on v.id = c.vendedora_id
-- group by 1 order by 2 desc;
--
-- El backup (`clients_backup_20260716_unlinked_dupes`) se puede borrar a
-- mano una vez confirmado que todo quedó bien:
-- drop table public.clients_backup_20260716_unlinked_dupes;
