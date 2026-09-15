import { createClient } from '@supabase/supabase-js';

export function getSupabaseAdminClient(env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Env vars ausentes: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, serviceKey);
}

export async function resolveSession(supabase, sessionToken) {
  if (!sessionToken) throw new Error('SESSION_REQUIRED');
  const { data, error } = await supabase.rpc('auth_verify_session', { p_session_token: sessionToken });
  if (error) throw new Error('SESSION_EXPIRED');
  return data;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
