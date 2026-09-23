const { getSupabaseAdminClient, buildCustomerToken } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { tenantId, templateId, phone, name, instagram, email } = JSON.parse(event.body || '{}');
    if (!tenantId || !templateId || !phone) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId, templateId, phone obrigatórios' }) };
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.rpc('claim_coupon', {
      p_tenant_id: tenantId, p_template_id: templateId, p_customer_phone: phone, p_customer_name: name || '',
      p_customer_instagram: instagram || null, p_customer_email: email || null,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
    if (email && data?.publicId) {
      const { sendEmail } = require('./_resend');
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #E5E5E5;border-radius:12px">
          <img src="${data.logoUrl || ''}" alt="${data.businessName || ''}" style="height:40px;border-radius:8px;margin-bottom:10px" />
          <h2 style="margin:0 0 6px;color:#0A6E4F">🎟️ ${data.title || 'Seu cupom'}</h2>
          <p style="margin:0 0 16px;color:#555;font-size:14px">${data.businessName || ''}${data.benefitValue != null ? ` · ${Number(data.benefitValue)}% OFF` : ''}</p>
          <div style="background:#FDF3D7;border:1px dashed #E8C46A;border-radius:8;padding:14px;text-align:center;font-family:monospace;font-size:20px;font-weight:800;letter-spacing:3px;color:#0B6E4F">${data.publicId}</div>
          <p style="margin:16px 0 0;font-size:12px;color:#999">Mostre este código no estabelecimento para validar seu cupom.</p>
        </div>`;
      await sendEmail({ to: email, subject: `🎟️ ${data.title || 'Seu cupom'}`, html });
    }
    return { statusCode: 200, body: JSON.stringify({ ...data, customerToken: buildCustomerToken(data.customerId) }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};