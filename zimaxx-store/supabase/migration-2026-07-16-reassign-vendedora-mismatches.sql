-- Reasigna vendedora en 21 clientes reales (2026-07-16, a pedido del
-- usuario). Mismo diagnóstico que
-- migration-2026-07-16-cleanup-unlinked-duplicate-clients.sql: se
-- comparó el export real de SellerCloud (vía n8n) contra la app y estos
-- 21 clientes tienen `sellercloud_id` correcto (SÍ existen de verdad) pero
-- quedaron con una vendedora distinta a la que dice SellerCloud —
-- 18 de ellos estaban mal puestos bajo "Maria Fernanda Sardua" cuando en
-- realidad son de Manuela Henriquez, Luzmila Ernandez, Yusleidy Romero,
-- Jesus Rodriguez o Daniela Bohorquez (esto también explica por qué esas
-- 4 primeras vendedoras aparecían con MENOS clientes en la app que en
-- SellerCloud en el diagnóstico: sus clientes reales estaban mal
-- asignados a Maria Fernanda). No es un caso de clientes "de más": son
-- clientes reales, solo mal etiquetados.
--
-- UPDATE directo (no vía la RPC `reassign_client`): esa RPC exige
-- `is_admin()` sobre el JWT de quien llama, pensada para el panel admin
-- interactivo — correr esto desde el SQL Editor no tiene esa sesión, así
-- que se actualiza `clients` directamente. Esto SÍ deja rastro en
-- `admin_audit_log` distinto al de la RPC (no aplica), por tratarse de
-- una corrección de datos masiva y no una acción de un admin desde la UI.
set lock_timeout = '10s';

begin;

create table public.clients_backup_20260716_reassign as
select * from public.clients
where sellercloud_id in (
  1651811, 1232967, 1427460, 1609366, 1354478, 1529853, 1495667, 1632558,
  1615349, 1555832, 1481358, 1358352, 1484089, 1555658, 1561499, 1358576,
  1507330, 1545768, 1580146, 1416901, 1549260
);

with pairs (sellercloud_id, real_vendedora_name) as (
  values
    (1651811, 'Manuela Henriquez'),
    (1232967, 'Edilmar Sanchez'),
    (1427460, 'Adriana Montilla'),
    (1609366, 'Manuela Henriquez'),
    (1354478, 'Manuela Henriquez'),
    (1529853, 'Daniela Bohorquez'),
    (1495667, 'Yusleidy Romero'),
    (1632558, 'Manuela Henriquez'),
    (1615349, 'Luzmila Ernandez'),
    (1555832, 'Luzmila Ernandez'),
    (1481358, 'Luzmila Ernandez'),
    (1358352, 'Luzmila Ernandez'),
    (1484089, 'Manuela Henriquez'),
    (1555658, 'Jesus Rodriguez'),
    (1561499, 'Luzmila Ernandez'),
    (1358576, 'Luzmila Ernandez'),
    (1507330, 'Yusleidy Romero'),
    (1545768, 'Jesus Rodriguez'),
    (1580146, 'Yusleidy Romero'),
    (1416901, 'Jesus Rodriguez'),
    (1549260, 'Jesus Rodriguez')
)
update public.clients c
set vendedora_id = v.id
from pairs p
join public.vendedores v on public.sync_normalize_name(v.name) = public.sync_normalize_name(p.real_vendedora_name)
where c.sellercloud_id = p.sellercloud_id;

commit;

-- ---------- Verificación manual ----------
-- Deberían quedar 21 filas actualizadas con la vendedora correcta:
-- select c.sellercloud_id, c.name, v.name as vendedora_actual
-- from public.clients c
-- join public.vendedores v on v.id = c.vendedora_id
-- where c.sellercloud_id in (
--   1651811, 1232967, 1427460, 1609366, 1354478, 1529853, 1495667, 1632558,
--   1615349, 1555832, 1481358, 1358352, 1484089, 1555658, 1561499, 1358576,
--   1507330, 1545768, 1580146, 1416901, 1549260
-- )
-- order by v.name;
--
-- El backup (`clients_backup_20260716_reassign`) se puede borrar a mano
-- una vez confirmado que todo quedó bien:
-- drop table public.clients_backup_20260716_reassign;
