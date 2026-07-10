-- Da acceso admin completo a Luzmar Quintero (jefa de vendedoras), a
-- pedido del usuario (2026-07-09): además de su lista de precio especial
-- (ver migration-2026-07-09-luzmar-list.sql) y de su fila en `vendedores`
-- (para que le sigan asignando clientes y el link de WhatsApp funcione
-- igual), se le agrega a `admins` para que get_my_role() le devuelva
-- 'admin' — is_admin() se chequea antes que is_vendedora(), así que ve
-- TODO igual que cualquier otro admin (todos los clientes, todos los
-- pedidos, todas las vendedoras), sin perder su identidad de vendedora.
--
-- Requisito: que ya exista un usuario en Supabase Auth con este email
-- (Authentication → Users → Add user, si todavía no lo tiene) — es el
-- mismo paso que ya se usa para vincular su acceso de vendedora en la
-- pestaña Vendedoras, no hace falta un usuario nuevo si ya lo tiene.
insert into public.admins (user_id)
select id from auth.users where email = 'quintero@zimaxx.com'
on conflict do nothing;

-- Verificación: debe devolver una fila. Si no devuelve nada, el usuario
-- de Auth con ese email todavía no existe (crearlo primero y re-correr).
select u.email, a.user_id is not null as es_admin
from auth.users u
left join public.admins a on a.user_id = u.id
where u.email = 'quintero@zimaxx.com';
