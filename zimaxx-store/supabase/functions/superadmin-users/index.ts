// Acciones de superadmin que Postgres no puede hacer (2026-08-05, a pedido
// del usuario): cambiarle la contraseña a cualquier usuario y crear un admin
// nuevo desde cero. Las dos necesitan la Admin API de GoTrue
// (auth.admin.updateUserById / auth.admin.createUser), que solo se puede
// llamar con la service_role key — nunca desde el navegador. El resto de las
// acciones del panel Superadmin sí son RPC de Postgres (ver
// migration-2026-08-05-superadmin.sql).
//
// Misma estructura que admin-create-vendedora-user, con dos diferencias:
//   * valida `is_superadmin()` (no `is_admin()`) con el JWT de quien llama;
//   * después de hacer el trabajo con la service_role key, vuelve a llamar a
//     Postgres CON EL JWT DEL LLAMADOR (sa_register_new_admin /
//     sa_log_password_change) para que la fila de auditoría salga con su
//     auth.uid() real y con el mismo candado de superadmin. Así la regla y el
//     rastro viven en un solo lugar y no se duplican acá.
//
// Las dos acciones van en una sola función a propósito: cada Edge Function es
// un deploy aparte y este panel se toca poco, no vale la pena pagar dos.
//
// Deploy (una sola vez, desde `zimaxx-store/`):
//   supabase functions deploy superadmin-users
// No hace falta configurar secrets: SUPABASE_URL/SUPABASE_ANON_KEY/
// SUPABASE_SERVICE_ROLE_KEY ya vienen inyectadas por el runtime.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const MIN_PASSWORD = 6 // mismo mínimo que Supabase Auth y que el alta de vendedoras

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

  // Quién llama: se valida con SU propio JWT contra is_superadmin(), no con la
  // service_role key. La regla de "solo el superadmin" sigue viviendo en la
  // base (misma función que usan las RPC sa_*).
  const authHeader = req.headers.get('Authorization') ?? ''
  const callerClient = createClient(SUPABASE_URL!, ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: isSuper, error: roleError } = await callerClient.rpc('is_superadmin')
  if (roleError || !isSuper) {
    return json({ error: 'solo el superadmin puede hacer esto' }, 403)
  }

  let body: { action?: string; user_id?: string; email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'body inválido' }, 400)
  }

  const action = body.action?.trim()
  const password = body.password ?? ''
  if (action !== 'set_password' && action !== 'create_admin') {
    return json({ error: 'acción inválida' }, 400)
  }
  if (password.length < MIN_PASSWORD) {
    return json({ error: `la contraseña debe tener al menos ${MIN_PASSWORD} caracteres` }, 400)
  }

  const admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!)

  // ---------- Cambiar la contraseña de un usuario existente ----------
  // Sirve para cualquier acceso: vendedora, admin o el propio superadmin.
  // Nota: las sesiones ya abiertas de ese usuario NO se cierran (GoTrue no lo
  // hace al cambiar la contraseña); el token viejo sigue válido hasta que
  // expire. Alcanza para el caso real (alguien se olvidó la clave).
  if (action === 'set_password') {
    const userId = body.user_id?.trim()
    if (!userId) return json({ error: 'falta user_id' }, 400)

    const { error } = await admin.auth.admin.updateUserById(userId, { password })
    if (error) return json({ error: error.message }, 400)

    // La contraseña ya cambió: si el registro de auditoría falla, se avisa
    // pero no se miente diciendo que la acción no pasó.
    const { error: logError } = await callerClient.rpc('sa_log_password_change', {
      p_user_id: userId,
    })
    return json({ ok: true, warning: logError?.message })
  }

  // ---------- Crear un admin desde cero (usuario de Auth + rol) ----------
  const email = body.email?.trim()
  if (!email) return json({ error: 'falta el email' }, 400)

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createError) return json({ error: createError.message }, 400)

  const { error: registerError } = await callerClient.rpc('sa_register_new_admin', {
    p_user_id: created.user.id,
  })
  if (registerError) {
    // Sin esto quedaría un usuario de Auth huérfano: creado, sin rol admin y
    // sin rastro de por qué existe.
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: registerError.message }, 400)
  }

  return json({ ok: true, user_id: created.user.id })
})
