-- Delta mínimo del 2026-07-09 (lista de precio de Luzmar Quintero) para
-- correr en el SQL Editor de Supabase SIN re-ejecutar todo el schema.sql.
-- A diferencia de las migraciones anteriores, este es un simple INSERT
-- (no un ALTER TABLE), así que no debería toparse con el deadlock del
-- schema.sql completo: no pide un lock exclusivo, solo agrega una fila.
insert into public.price_lists (code, label) values
  ('luzmar', 'Luzmar - Precio Especial')
on conflict (code) do nothing;
