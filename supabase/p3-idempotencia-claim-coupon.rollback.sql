-- ============================================================================
-- p3-idempotencia-claim-coupon.rollback.sql
--
-- Reverte p3-idempotencia-claim-coupon.sql, restaurando a definição ANTERIOR
-- de claim_coupon (6 parâmetros, sem idempotência) exatamente como estava.
--
-- O texto abaixo foi copiado de pg_get_functiondef em 2026-10-03, antes da
-- aplicação. Não edite à mão: se precisar, reextraia com
--
--   select pg_get_functiondef(p.oid)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname='public' and p.proname='claim_coupon';
--
-- IMPORTANTE — o rollback DEIXA O JS QUEBRADO se o claim-coupon.js já estiver
-- mandando p_idempotency_key: depois desta transação a função não aceita o 7º
-- argumento e o resgate passa a responder 400. Se for reverter, reverta o JS
-- junto (deploy coordenado) ou suba o banco de novo.
--
-- Ordem sugerida em caso de emergência:
--   1) rodar este arquivo;
--   2) reverter o claim-coupon.js para a versão que manda 6 argumentos;
--   3) rodar p3-idempotencia-claim-coupon.sql de novo se quiser reidempotizar.
-- ============================================================================

DROP FUNCTION IF EXISTS public.claim_coupon(uuid, uuid, text, text, text, text, text);

CREATE FUNCTION public.claim_coupon(
  p_tenant_id uuid,
  p_template_id uuid,
  p_customer_phone text,
  p_customer_name text,
  p_customer_instagram text DEFAULT NULL::text,
  p_customer_email text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
declare v_customer_id uuid; v_template coupon_templates%rowtype; v_raw_token text; v_public_id text; v_coupon_id uuid; v_already_has int; v_short_code text;
begin
  select * into v_template from coupon_templates where id = p_template_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'NOT_FOUND: template'; end if;
  if not v_template.is_active then raise exception 'COUPON_INACTIVE'; end if;
  select id into v_customer_id from users where tenant_id = p_tenant_id and internal_code = p_customer_phone;
  if not found then
    insert into users (tenant_id, internal_code, role, phone, name, instagram, email)
      values (p_tenant_id, p_customer_phone, 'CUSTOMER', p_customer_phone, p_customer_name, p_customer_instagram, p_customer_email) returning id into v_customer_id;
  else
    update users set name = coalesce(p_customer_name, name), instagram = coalesce(p_customer_instagram, instagram), email = coalesce(p_customer_email, email) where id = v_customer_id;
  end if;
  select count(*) into v_already_has from coupons where template_id = p_template_id and customer_id = v_customer_id and status <> 'CANCELLED';
  if v_already_has >= v_template.per_customer_limit then raise exception 'LIMIT_REACHED: customer already claimed this offer'; end if;
  if v_template.total_stock is not null and v_template.issued_count >= v_template.total_stock then raise exception 'COUPON_OUT_OF_STOCK'; end if;
  v_raw_token := encode(gen_random_bytes(32), 'base64');
  v_public_id := 'PYV-' || upper(encode(gen_random_bytes(5), 'hex'));
  v_short_code := lpad(floor(random() * 1000000)::text, 6, '0');
  insert into coupons (public_id, secure_token_hash, short_code_hash, tenant_id, template_id, campaign_id, business_id, customer_id, status, expires_at)
  values (v_public_id, encode(digest(v_raw_token,'sha256'),'hex'), encode(digest(v_short_code,'sha256'),'hex'), p_tenant_id, p_template_id, v_template.campaign_id, v_template.business_id, v_customer_id, 'AVAILABLE', v_template.valid_until)
  returning id into v_coupon_id;
  update coupon_templates set issued_count = issued_count + 1 where id = p_template_id;
  return jsonb_build_object('couponId', v_coupon_id, 'publicId', v_public_id, 'rawToken', v_raw_token, 'shortCode', v_short_code, 'customerId', v_customer_id);
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_coupon(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_coupon(uuid, uuid, text, text, text, text) TO service_role;