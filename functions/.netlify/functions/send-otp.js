import { json } from './_shared.js';
import { sendOtp } from './_otp.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'INVALID_JSON' }, 400); }
  const { email, name } = body || {};
  const result = await sendOtp(env, { email, name });
  if (!result.ok) return json({ error: result.reason }, 400);
  return json({ ok: true });
}