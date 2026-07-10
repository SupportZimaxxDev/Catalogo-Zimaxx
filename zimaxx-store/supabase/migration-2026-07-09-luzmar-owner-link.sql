-- Vincula la lista de precio 'luzmar' con la fila de Luzmar Quintero en
-- `vendedores`, y agrega un trigger que garantiza a nivel de base de
-- datos que cualquier cliente con esa lista quede SIEMPRE asignado a
-- ella (2026-07-09, a pedido del usuario: evitar que un cliente con su
-- lista de precios especiales termine en la cuenta de otra vendedora,
-- por error de UI, carga de Excel o escritura directa a la tabla).
--
-- Correr DESPUÉS de `migration-2026-07-09-luzmar-list.sql` (esa crea la
-- fila `code = 'luzmar'` en price_lists; si todavía no corriste esa, el
-- UPDATE de abajo no encuentra la fila y no hace nada — re-correr este
-- archivo después no tiene problema). Requiere también que ya exista la
-- vendedora "Luzmar Quintero" en la pestaña Vendedoras del admin (el
-- nombre debe coincidir exactamente, sin importar mayúsculas).
--
-- lock_timeout: el ALTER TABLE de abajo pide un lock exclusivo breve
-- sobre price_lists; si la tabla está ocupada falla rápido y limpio en
-- vez de arriesgar el deadlock que ya pasó con el schema.sql completo —
-- en ese caso, solo hay que volver a correrlo.
set lock_timeout = '5s';

alter table public.price_lists add column if not exists owner_vendedora_id uuid references public.vendedores (id);

update public.price_lists
set owner_vendedora_id = (select id from public.vendedores where lower(name) = 'luzmar quintero')
where code = 'luzmar'
  and owner_vendedora_id is null;

-- El trigger real: antes de cualquier insert/update en clients, si la
-- lista tiene owner_vendedora_id seteado, pisa vendedora_id con ese
-- valor. ClientsAdmin.jsx ya evita esto en la UI, pero esto es lo que
-- lo hace imposible de saltar de verdad.
create or replace function public.enforce_owner_vendedora()
returns trigger
language plpgsql
as $$
declare
  v_owner uuid;
begin
  select owner_vendedora_id into v_owner
  from public.price_lists where id = new.price_list_id;

  if v_owner is not null then
    new.vendedora_id := v_owner;
  end if;
  return new;
end;
$$;

drop trigger if exists clients_enforce_owner_vendedora on public.clients;
create trigger clients_enforce_owner_vendedora
  before insert or update on public.clients
  for each row execute function public.enforce_owner_vendedora();

-- Verificación: debe devolver una fila con owner_vendedora_id no nulo.
-- Si sale null, revisar que el nombre en la pestaña Vendedoras sea
-- exactamente "Luzmar Quintero" (o ajustar el nombre en el where de
-- arriba y re-correr este archivo).
select code, label, owner_vendedora_id from public.price_lists where code = 'luzmar';
