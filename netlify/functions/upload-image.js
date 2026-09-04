const { getSupabaseAdminClient } = require('./_supabaseAdmin');
const { randomUUID } = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { base64, contentType, folder } = JSON.parse(event.body || '{}');
    if (!base64 || !contentType) return { statusCode: 400, body: JSON.stringify({ error: 'base64 e contentType obrigatórios' }) };
    const ext = contentType.split('/')[1] || 'png';
    const path = `${folder || 'misc'}/${randomUUID()}.${ext}`;
    const buffer = Buffer.from(base64, 'base64');

    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.storage.from('pyv-images').upload(path, buffer, { contentType, upsert: false });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };

    const { data: pub } = supabase.storage.from('pyv-images').getPublicUrl(path);
    return { statusCode: 200, body: JSON.stringify({ url: pub.publicUrl }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
