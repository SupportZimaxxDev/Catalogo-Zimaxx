// Crear el acceso (usuario de Supabase Auth) de una vendedora directo
// desde el panel admin (2026-07-15, a pedido del usuario). Hasta ahora
// VendedoresAdmin.jsx solo podía VINCULAR un usuario ya creado a mano en
// el dashboard de Supabase Auth (RPC link_vendedora_login); esto crea el
// usuario de una — el admin define la contraseña inicial y se la pasa a
// la vendedora (mismo criterio que el link del catálogo: WhatsApp, no
// email).
//
// Tiene que ser una Edge Function y no una RPC de Postgres porque crear
// un usuario de Auth con contraseña requiere la Admin API de GoTrue
// (auth.admin.createUser), que solo se puede llamar con la service_role
// key — nunca desde el navegador. La verificación de admin reusa la RPC
// is_admin() que ya existe (no se duplica esa lógica acá).
//
// Deploy (el admin lo corre una sola vez, no está automatizado):
//   supabase functions deploy admin-create-vendedora-user
// No hace falta configurar secrets: SUPABASE_URL/SUPABASE_ANON_KEY/
// SUPABASE_SERVICE_ROLE_KEY ya vienen inyectadas por el runtime de Edge
// Functions.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // Quién llama: se valida contra is_admin() con SU propio JWT (reenviado
  // tal cual llega), no con la service_role key — así la regla de "solo
  // admin" sigue viviendo en un solo lugar (la misma que usan las RPC
  // reassign_client/delete_client).
  const authHeader = req.headers.get('Authorization') ?? ''
  const callerClient = createClient(SUPABASE_URL!, ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: isAdmin, error: roleError } = await callerClient.rpc('is_admin')
  if (roleError || !isAdmin) {
    return json({ error: 'solo un admin puede crear accesos de vendedora' }, 403)
  }

  let body: { vendedora_id?: string; email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'body inválido' }, 400)
  }

  const vendedoraId = body.vendedora_id?.trim()
  const email = body.email?.trim()
  const password = body.password ?? ''
  if (!vendedoraId || !email || !password) {
    return json({ error: 'faltan vendedora_id/email/password' }, 400)
  }
  if (password.length < 6) {
    return json({ error: 'la contraseña debe tener al menos 6 caracteres' }, 400)
  }

  const admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!)

  // Que la vendedora exista y no tenga ya un acceso vinculado (evita
  // pisar sin querer el acceso de otra persona).
  const { data: vendedora, error: vendedoraError } = await admin
    .from('vendedores')
    .select('id, user_id')
    .eq('id', vendedoraId)
    .maybeSingle()
  if (vendedoraError || !vendedora) return json({ error: 'vendedora no encontrada' }, 404)
  if (vendedora.user_id) return json({ error: 'esta vendedora ya tiene un acceso vinculado' }, 400)

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createError) return json({ error: createError.message }, 400)

  const { error: linkError } = await admin
    .from('vendedores')
    .update({ user_id: created.user.id, login_email: email })
    .eq('id', vendedoraId)

  if (linkError) {
    // Sin esto quedaría un usuario de Auth huérfano (creado pero sin
    // vendedora asociada) si el update fallara por la razón que sea.
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: linkError.message }, 400)
  }

  return json({ ok: true, user_id: created.user.id })
})
