import { getSupabaseAdminClient, resolveSession, extractSessionToken, json } from './_shared.js';

const MAX_BYTES = 6 * 1024 * 1024; // 6 MB

// Tipos permitidos e extensao derivada SERVIDOR, nunca do cliente.
const ALLOWED_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const ALLOWED_FOLDERS = new Set(['business-logos', 'campaign-images', 'misc']);

function matchesMagic(type, u8) {
  if (u8.length < 12) return false;
  if (type === 'image/png') {
    return u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47;
  }
  if (type === 'image/jpeg') {
    return u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff;
  }
  if (type === 'image/webp') {
    return String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) === 'RIFF' &&
      String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === 'WEBP';
  }
  return false;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json();
    const supabase = getSupabaseAdminClient(env);
    // Exige sessao valida (qualquer perfil autenticado: merchant ou admin).
    await resolveSession(supabase, extractSessionToken(request, body));

    const { base64, contentType, folder } = body;
    if (!base64 || !contentType) return json({ error: 'base64 e contentType obrigatórios' }, 400);

    const ext = ALLOWED_TYPES[contentType];
    if (!ext) return json({ error: 'tipo de arquivo não permitido (use PNG, JPEG ou WEBP)' }, 400);

    const safeFolder = ALLOWED_FOLDERS.has(folder) ? folder : 'misc';

    // decodifica base64 sem depender de Buffer (API Node) - so APIs padrao Web,
    // portavel entre Netlify Functions e Cloudflare Workers.
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    if (bytes.length === 0) return json({ error: 'arquivo vazio' }, 400);
    if (bytes.length > MAX_BYTES) return json({ error: 'arquivo excede o limite de 6 MB' }, 400);
    if (!matchesMagic(contentType, bytes)) return json({ error: 'conteúdo não corresponde ao tipo informado' }, 400);

    const path = `${safeFolder}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('pyv-images').upload(path, bytes, { contentType, upsert: false });
    if (error) return json({ error: error.message }, 400);

    const { data: pub } = supabase.storage.from('pyv-images').getPublicUrl(path);
    return json({ url: pub.publicUrl });
  } catch (err) {
    const status = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    return json({ error: err.message }, status);
  }
}