import { getSupabaseAdminClient, json } from './_shared.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { base64, contentType, folder } = await request.json();
    if (!base64 || !contentType) return json({ error: 'base64 e contentType obrigatórios' }, 400);
    const ext = contentType.split('/')[1] || 'png';
    const path = `${folder || 'misc'}/${crypto.randomUUID()}.${ext}`;

    // decodifica base64 sem depender de Buffer (API Node) - so APIs padrao Web,
    // portavel entre Netlify Functions e Cloudflare Workers.
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const supabase = getSupabaseAdminClient(env);
    const { error } = await supabase.storage.from('pyv-images').upload(path, bytes, { contentType, upsert: false });
    if (error) return json({ error: error.message }, 400);

    const { data: pub } = supabase.storage.from('pyv-images').getPublicUrl(path);
    return json({ url: pub.publicUrl });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
