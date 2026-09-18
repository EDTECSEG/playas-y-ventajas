const { getSupabaseAdminClient, resolveSession, extractSessionToken } = require('./_supabaseAdmin');
const { randomUUID } = require('crypto');

const MAX_BYTES = 6 * 1024 * 1024; // 6 MB

// Tipos permitidos e extensao derivada SERVIDOR, nunca do cliente.
const ALLOWED_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const ALLOWED_FOLDERS = new Set(['business-logos', 'campaign-images', 'misc']);

function matchesMagic(type, buf) {
  if (buf.length < 12) return false;
  if (type === 'image/png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (type === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'image/webp') {
    return buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  }
  return false;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const body = JSON.parse(event.body || '{}');
    const supabase = getSupabaseAdminClient();
    // Exige sessao valida (qualquer perfil autenticado: merchant ou admin).
    await resolveSession(supabase, extractSessionToken(event, body));

    const { base64, contentType, folder } = body;
    if (!base64 || !contentType) return { statusCode: 400, body: JSON.stringify({ error: 'base64 e contentType obrigatórios' }) };

    const ext = ALLOWED_TYPES[contentType];
    if (!ext) return { statusCode: 400, body: JSON.stringify({ error: 'tipo de arquivo não permitido (use PNG, JPEG ou WEBP)' }) };

    const safeFolder = ALLOWED_FOLDERS.has(folder) ? folder : 'misc';
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) return { statusCode: 400, body: JSON.stringify({ error: 'arquivo vazio' }) };
    if (buffer.length > MAX_BYTES) return { statusCode: 400, body: JSON.stringify({ error: 'arquivo excede o limite de 6 MB' }) };
    if (!matchesMagic(contentType, buffer)) return { statusCode: 400, body: JSON.stringify({ error: 'conteúdo não corresponde ao tipo informado' }) };

    const path = `${safeFolder}/${randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('pyv-images').upload(path, buffer, { contentType, upsert: false });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };

    const { data: pub } = supabase.storage.from('pyv-images').getPublicUrl(path);
    return { statusCode: 200, body: JSON.stringify({ url: pub.publicUrl }) };
  } catch (err) {
    const code = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    return { statusCode: code, body: JSON.stringify({ error: err.message }) };
  }
};