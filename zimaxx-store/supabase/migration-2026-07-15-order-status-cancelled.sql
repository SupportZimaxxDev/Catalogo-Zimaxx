-- Agrega el estado 'cancelled' al ciclo de vida del pedido (2026-07-15,
-- a pedido del usuario: a veces el cliente arma y confirma el pedido pero
-- después lo cancela, y hasta ahora `orders.status` solo aceptaba
-- 'new'/'done' — no había forma de reflejar eso en el admin).
--
-- Solo toca el CHECK constraint (no la columna, que ya existe): se
-- recrea con el valor nuevo permitido. `status` no cambia para ningún
-- pedido existente, así que no hace falta backfill.
--
-- Idempotente (drop + create del mismo constraint) y sin riesgo de
-- deadlock: no toca filas ni tipos, solo la regla de validación.
set lock_timeout = '10s';

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new', 'done', 'cancelled'));

-- ---------- Verificación manual (SQL Editor) ----------
-- Confirmar que el constraint quedó con los 3 valores:
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.orders'::regclass and conname = 'orders_status_check';
--
-- Un valor fuera de la lista debe rechazarse:
-- update public.orders set status = 'algo_invalido' where false; -- no-op, solo para leer el mensaje si se prueba con un id real
