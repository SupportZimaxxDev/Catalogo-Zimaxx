-- Delta mínimo del 2026-07-09 (etiqueta ✨ Nuevo) para correr en el SQL
-- Editor de Supabase SIN re-ejecutar todo el schema.sql. El script
-- completo tomaba locks sobre varias tablas a la vez y chocó con los
-- RPC del sitio en producción (deadlock); esto solo necesita un lock
-- breve sobre `products`.
--
-- lock_timeout: si la tabla está ocupada (alguien navegando el catálogo),
-- falla rápido con "canceling statement due to lock timeout" en vez de
-- quedarse esperando y arriesgar otro deadlock — en ese caso simplemente
-- volver a correrlo.
set lock_timeout = '5s';

-- Mientras now() < new_until el producto lleva la etiqueta ✨ Nuevo en el
-- catálogo y el admin. Se setea automático (+10 días) al crear productos;
-- editable desde el formulario de edición en el panel admin.
alter table public.products
  add column if not exists new_until timestamptz;

-- get_catalog ahora devuelve is_new (calculado server-side) en ambas
-- ramas. Reemplazar una función no bloquea a los lectores.
create or replace function public.get_catalog(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_client          public.clients%rowtype;
  v_code            text;
  v_vendedora_name  text;
  v_vendedora_phone text;
  v_products        jsonb;
begin
  if p_token is null or length(p_token) = 0 then
    return null;
  end if;

  select * into v_client from public.clients where token = p_token;
  if not found then
    return null;
  end if;

  select code into v_code from public.price_lists where id = v_client.price_list_id;
  select name, phone into v_vendedora_name, v_vendedora_phone
  from public.vendedores where id = v_client.vendedora_id;

  if v_code = 'quote' then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',           p.id,
          'name',         p.name,
          'category',     p.category,
          'product_line', p.product_line,
          'image_url',    p.image_url,
          'availability', p.availability,
          'is_new',       (p.new_until is not null and now() < p.new_until),
          'price',        null
        )
        order by p.category nulls last, p.name
      ),
      '[]'::jsonb
    )
    into v_products
    from public.products p
    where p.active;
  else
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',           p.id,
          'name',         p.name,
          'category',     p.category,
          'product_line', p.product_line,
          'image_url',    p.image_url,
          'availability', p.availability,
          'is_new',       (p.new_until is not null and now() < p.new_until),
          'price',        pp.price
        )
        order by p.category nulls last, p.name
      ),
      '[]'::jsonb
    )
    into v_products
    from public.products p
    left join public.product_prices pp
      on pp.product_id = p.id
     and pp.price_list_id = v_client.price_list_id
    where p.active
      and pp.price is not null;
  end if;

  return jsonb_build_object(
    'client', jsonb_build_object(
      'name',            v_client.name,
      'vendedora',       v_vendedora_name,
      'vendedora_phone', v_vendedora_phone,
      'price_list_code', v_code,
      'is_quote_only',   v_code = 'quote'
    ),
    'products', v_products
  );
end;
$$;

revoke execute on function public.get_catalog(text) from public;
grant execute on function public.get_catalog(text) to anon, authenticated;
