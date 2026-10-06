const { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  const supabase = getSupabaseAdminClient();
  try {
    if (event.httpMethod === 'GET') {
      const { mode } = event.queryStringParameters || {};
      const actor = await resolveSession(supabase, extractSessionToken(event));
      if (!actor.businessId) return { statusCode: 400, body: JSON.stringify({ error: 'ator não vinculado a um estabelecimento' }) };
      if (mode === 'stats') {
        const { data, error } = await supabase.rpc('business_coupon_stats', { p_tenant_id: actor.tenantId, p_business_id: actor.businessId });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      if (mode === 'my-data') {
        const { data, error } = await supabase.rpc('business_get_own', { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      if (mode === 'shuttles') {
        const { data, error } = await supabase.rpc('business_list_shuttle_services', { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId });
        if (error) return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: rpcErrorCode(error) }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      // ---- Fila de reservas de translado ----
      // A empresa e a dona da reserva: status e date sao escolha de tela (vem da
      // query), mas o escopo sempre deriva da sessao. p_tenant_id/p_actor_user_id
      // NUNCA vem da query: e o que impede a empresa A de ler a fila da empresa B.
      // A resposta carrega telefone e observacao do cliente -> no-store.
      if (mode === 'reservations') {
        const { status: statusFiltro, date } = event.queryStringParameters || {};
        const { data, error } = await supabase.rpc('business_list_shuttle_reservations', {
          p_tenant_id: actor.tenantId,
          p_actor_user_id: actor.userId,
          p_status: statusFiltro || null,
          p_date: date || null,
        });
        if (error) return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: rpcErrorCode(error) }) };
        const list = Array.isArray(data) ? data : [];
        return {
          statusCode: 200,
          headers: { 'Cache-Control': 'no-store' },
          body: JSON.stringify({ reservations: list, count: list.length }),
        };
      }
      // ---- Relatorio de performance (somente leitura) ----
      // Fica DEPOIS de `shuttles` e ANTES do default (empresa_dashboard) para
      // nao mudar o comportamento de nenhum mode existente.
      //
      // O periodo e validado AQUI, no handler, e nao no banco: `days=abc` e
      // `from` com data quebrada sao entrada do cliente, e o Postgres nao tem
      // como recusar isso com a assinatura da RPC. O banco continua sendo a
      // autoridade do dado; aqui so decide o que chega a ser perguntado.
      //
      // REGRA 3 (IDOR): `p_tenant_id`/`p_actor_user_id` vem SEMPRE do
      // resolveSession. Um `businessId` na query e ignorado de proposito — a RPC
      // resolve o negocio a partir do ator, e nao de parametro do cliente.
      if (mode === 'report') {
        const { from, to, days } = event.queryStringParameters || {};
        const MS_DAY = 86400000;
        const DEFAULT_DAYS = 30;
        const MAX_DAYS = 366;
        const badPeriod = () => ({ statusCode: 400, body: JSON.stringify({ error: 'INVALID_PERIOD' }) });
        // Aceita `YYYY-MM-DD` ou ISO-8601 completo. Devolve `null` quando o
        // parametro nao veio (cai no default) e `undefined` quando veio mas nao
        // e data utilizavel (400).
        const parseWhen = (v) => {
          if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) return undefined;
          const ms = Date.parse(v);
          return Number.isNaN(ms) ? undefined : ms;
        };
        const rawFrom = String(from === null || from === undefined ? '' : from).trim();
        const rawTo = String(to === null || to === undefined ? '' : to).trim();
        const rawDays = String(days === null || days === undefined ? '' : days).trim();
        const msFrom = rawFrom ? parseWhen(rawFrom) : null;
        const msTo = rawTo ? parseWhen(rawTo) : null;
        if (msFrom === undefined || msTo === undefined) return badPeriod();
        // `days` e validado sempre que vier (1..366 inteiro): uma tela que manda
        // periodo invalido tem de tomar 400 mesmo mandando from/to junto.
        let daysUsed = DEFAULT_DAYS;
        if (rawDays) {
          if (!/^\d+$/.test(rawDays)) return badPeriod();
          daysUsed = Number(rawDays);
          if (daysUsed < 1 || daysUsed > MAX_DAYS) return badPeriod();
        }
        const now = Date.now();
        let pDe;
        let pAte;
        let msDe;
        let msAte;
        if (msFrom !== null || msTo !== null) {
          // from/to mandam: a data que veio vai CRUA para a RPC, para o periodo
          // do banco bater com o que a tela pediu (inclusive `YYYY-MM-DD`).
          msDe = msFrom === null ? now - DEFAULT_DAYS * MS_DAY : msFrom;
          msAte = msTo === null ? now : msTo;
          pDe = msFrom === null ? new Date(msDe).toISOString() : rawFrom;
          pAte = msTo === null ? new Date(msAte).toISOString() : rawTo;
        } else {
          msDe = now - daysUsed * MS_DAY;
          msAte = now;
          pDe = new Date(msDe).toISOString();
          pAte = new Date(msAte).toISOString();
        }
        if (msAte < msDe) return badPeriod();
        if (msAte - msDe > MAX_DAYS * MS_DAY) return badPeriod();
        // business_report_v3 e a fonte do relatorio. business_report (v2, sem
        // os blocos drivers/billing/shuttle) e o fallback para a aba subir antes
        // da migracao business-report-v3.sql estar aplicada: degradar e melhor
        // que 500. `source` diz qual das duas respondeu.
        const missingReportFn = (e) => {
          const message = String((e && e.message) || '');
          return String((e && e.code) || '') === '42883'
            || /function\s+business_report_v3/i.test(message)
            || /does not exist/i.test(message);
        };
        const rpcArgs = { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_de: pDe, p_ate: pAte };
        let source = 'business_report_v3';
        let report = await supabase.rpc('business_report_v3', rpcArgs);
        if (report.error && missingReportFn(report.error)) {
          source = 'business_report';
          report = await supabase.rpc('business_report', rpcArgs);
        }
        if (report.error) return { statusCode: rpcErrorStatus(report.error), body: JSON.stringify({ error: rpcErrorCode(report.error) }) };
        const data = report.data && typeof report.data === 'object' && !Array.isArray(report.data) ? report.data : {};
        const period = data.period && typeof data.period === 'object' ? data.period : {};
        return {
          statusCode: 200,
          // Relatorio e dado do negocio: nunca em cache de CDN/browser.
          headers: { 'Cache-Control': 'no-store' },
          body: JSON.stringify({
            ...data,
            source,
            // `days` derivado da janela resolvida: e o que a tela 7/30/90
            // precisa para se legendar sem recalcular nada.
            period: { from: period.from || pDe, to: period.to || pAte, days: Math.max(1, Math.round((msAte - msDe) / MS_DAY)) },
          }),
        };
      }
      // ---- Cota de cupons gratis do plano FREE ----
      // `business_coupon_allowance` e da p8: enquanto a p8 nao estiver aplicada a
      // RPC nao existe, e a tela precisa subir assim mesmo. Degradar para
      // `available:false` e melhor que 500 -- e `false` em vez de `limited:false`
      // porque "cota desconhecida" e "cota zero" (que e bloqueio) precisam ser
      // coisas diferentes na tela.
      if (mode === 'allowance') {
        const missingAllowanceFn = (e) => {
          const message = String((e && e.message) || '');
          return String((e && e.code) || '') === '42883'
            || /function\s+business_coupon_allowance/i.test(message)
            || /does not exist/i.test(message);
        };
        const { data, error } = await supabase.rpc('business_coupon_allowance', { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId });
        if (error) {
          if (missingAllowanceFn(error)) return { statusCode: 200, headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ available: false }) };
          return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: rpcErrorCode(error) }) };
        }
        const row = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        return {
          statusCode: 200,
          headers: { 'Cache-Control': 'no-store' },
          body: JSON.stringify({
            available: true,
            limited: row.limited === true,
            allowance: row.allowance,
            used: row.used,
            remaining: row.remaining,
          }),
        };
      }

      const { data, error } = await supabase.rpc('empresa_dashboard', { p_tenant_id: actor.tenantId, p_business_id: actor.businessId });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      // Auto-cadastro público da empresa (não exige sessão).
      if (body.action === 'register_business') {
        const lat = body.lat === null || body.lat === undefined || body.lat === '' ? null : Number(body.lat);
        const lng = body.lng === null || body.lng === undefined || body.lng === '' ? null : Number(body.lng);
        const { data, error } = await supabase.rpc('register_business', {
          p_tenant_slug: body.tenantSlug, p_name: body.name || null, p_category: body.category || null,
          p_city: body.city || null, p_phone: body.phone || null, p_email: body.email || null,
          p_cnpj: body.cnpj || null, p_website: body.website || null, p_logo_url: body.logoUrl || null,
          p_instagram: body.instagram || null,
          p_lat: lat, p_lng: lng, p_internal_code: body.internalCode || null, p_pin: body.pin || null,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, internalCode: data.internalCode }) };
      }

      const actor = await resolveSession(supabase, extractSessionToken(event, body));
      if (!actor.businessId) return { statusCode: 400, body: JSON.stringify({ error: 'ator não vinculado a um estabelecimento' }) };

      if (body.action === 'create_campaign') {
        const { data, error } = await supabase.rpc('create_campaign', {
          p_tenant_id: actor.tenantId, p_business_id: actor.businessId, p_actor_user_id: actor.userId, p_title: body.title,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      if (body.action === 'create_template') {
        const { data, error } = await supabase.rpc('create_coupon_template', {
          p_tenant_id: actor.tenantId, p_business_id: actor.businessId, p_campaign_id: body.campaignId,
          p_actor_user_id: actor.userId, p_title: body.title, p_benefit_type: body.benefitType,
          p_benefit_value: body.benefitValue, p_total_stock: body.totalStock ?? null, p_image_url: body.imageUrl || null,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      if (body.action === 'toggle_template') {
        const { data, error } = await supabase.rpc('business_toggle_template', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_template_id: body.templateId, p_is_active: !!body.isActive,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, changed: !!data }) };
      }
      if (body.action === 'update_template') {
        const { data, error } = await supabase.rpc('business_update_template', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_template_id: body.templateId,
          p_title: body.title, p_benefit_type: body.benefitType, p_benefit_value: body.benefitValue,
          p_total_stock: body.totalStock ?? null, p_image_url: body.imageUrl || null,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, changed: !!data }) };
      }
      if (body.action === 'delete_template') {
        const { data, error } = await supabase.rpc('business_delete_template', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_template_id: body.templateId,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, deleted: !!data }) };
      }
      if (body.action === 'update_my_data') {
        const lat = body.lat === null || body.lat === undefined || body.lat === '' ? null : Number(body.lat);
        const lng = body.lng === null || body.lng === undefined || body.lng === '' ? null : Number(body.lng);
        const { error } = await supabase.rpc('business_update_own', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_name: body.name || null,
          p_phone: body.phone || null, p_email: body.email || null, p_city: body.city || null, p_logo_url: body.logoUrl || null,
          p_category: body.category || null, p_lat: lat, p_lng: lng,
          // String vazia e o sinal de "limpar", e NULL o de "nao veio no
          // formulario" (ver a regra do NULL na p9). A distincao importa: sem
          // ela, salvar o formulario com o campo em branco apagaria o dado.
          p_website: body.website === undefined ? null : (body.website || ''),
          p_instagram: body.instagram === undefined ? null : (body.instagram || ''),
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
      if (body.action === 'set_coupon_featured') {
        // Self-service: a empresa destaca o proprio cupom ate p_until.
        // Sem prorrogacao: banners + contato direto ficam no app do admin.
        const until = body.until ? new Date(body.until).toISOString() : null;
        const { error } = await supabase.rpc('business_set_coupon_featured', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId,
          p_template_id: body.templateId, p_until: until,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, until }) };
      }
      if (body.action === 'set_pin') {
        const { data, error } = await supabase.rpc('business_set_pin', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_new_pin: body.newPin,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, changed: !!data }) };
      }

      // ---- Translado/proximidade: gestao dos servicos de translado ----
      if (body.action === 'save_shuttle_service') {
        const toCoord = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
        const { data, error } = await supabase.rpc('business_save_shuttle_service', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_service_id: body.serviceId || null,
          p_name: body.name || null, p_description: body.description || null, p_service_type: body.serviceType || 'shuttle',
          p_origin_lat: toCoord(body.originLat), p_origin_lng: toCoord(body.originLng),
          p_dest_lat: toCoord(body.destLat), p_dest_lng: toCoord(body.destLng),
          p_stops: Array.isArray(body.stops) ? body.stops : (body.stops ? [body.stops] : []),
          p_price_cents: body.priceCents === '' || body.priceCents === null || body.priceCents === undefined ? null : Number(body.priceCents),
          p_opens_at: body.opensAt || null, p_closes_at: body.closesAt || null,
          p_active_days: Array.isArray(body.activeDays) ? body.activeDays.map(Number) : null,
        });
        if (error) return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: rpcErrorCode(error) }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      if (body.action === 'toggle_shuttle_service') {
        const { data, error } = await supabase.rpc('business_toggle_shuttle_service', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId,
          p_service_id: body.serviceId, p_is_active: !!body.isActive,
        });
        if (error) return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: rpcErrorCode(error) }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, changed: !!data }) };
      }
      if (body.action === 'delete_shuttle_service') {
        const { data, error } = await supabase.rpc('business_delete_shuttle_service', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_service_id: body.serviceId,
        });
        if (error) return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: rpcErrorCode(error) }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, deleted: !!data }) };
      }

      // ---- Decisao sobre reserva de translado ----
      // decision fora de confirm/reject/cancel e 400 ANTES da RPC: uma decision
      // invalida nao chega ao banco para virar erro de constraint. O escopo
      // (tenant/ator) vem da sessao, nunca do corpo.
      if (body.action === 'review_reservation') {
        if (!['confirm', 'reject', 'cancel'].includes(body.decision)) {
          return { statusCode: 400, body: JSON.stringify({ error: 'ACTION_INVALID' }) };
        }
        if (!body.reservationId) return { statusCode: 400, body: JSON.stringify({ error: 'RESERVATION_ID_REQUIRED' }) };
        const { data, error } = await supabase.rpc('business_review_shuttle_reservation', {
          p_tenant_id: actor.tenantId,
          p_actor_user_id: actor.userId,
          p_reservation_id: body.reservationId,
          p_action: body.decision,
          p_reason: body.reason || null,
        });
        if (error) return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: rpcErrorCode(error) }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }

      return { statusCode: 400, body: JSON.stringify({ error: 'action inválida' }) };
    }

    return { statusCode: 405, body: '{}' };
  } catch (err) {
    const code = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    const body = code === 401 ? err.message : 'erro interno';
    if (code === 500) console.error('empresa: ' + (err && err.message));
    return { statusCode: code, body: JSON.stringify({ error: body }) };
  }
};