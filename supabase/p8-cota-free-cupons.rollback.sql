-- ============================================================================
-- p8-cota-free-cupons.rollback.sql
--
-- Desfaz p8-cota-free-cupons.sql.
--
-- ESTE ROLLBACK E SEGURO (ao contrario do da p5): nao reintroduz texto claro
-- em lugar nenhum. A p5voltou o rawToken para idempotency_keys; aqui o que
-- volta e apenas a funcao da p5, que continua cifrando.
--
-- O QUE ESTE ARQUIVO NAO CONSERVA
-- ---------------------------------------------------------------------------
-- As duas colunas (free_coupon_allowance, free_coupons_used) e os numeros que
-- nelas estavam. Nao ha como recupera-los depois do DROP.
--
-- Isso NAO perde informacao de negocio: `coupons` continua inteiro e
-- intocado, e used era exatamente count(coupons) por negocio com
-- status <> 'CANCELLED'. Reaplicar a p8 recalcula os dois numeros a partir
-- dos cupons, e o resultado e o mesmo -- com uma diferenca: a empresa que
-- tiver emitido cupom novo entre o rollback e a reaplicacao volta ao allowance
-- earned those coupons, nao a allowance congelada no dia do rollback.
--
-- Nenhum cupom e apagado. Nenhuma campanha e apagada.
-- ============================================================================

-- 1) A RPC de leitura some primeiro: ela le as duas colunas e passaria a
--    falhar em runtime se as colunas caissem antes dela.
--    DROP sem CASCADE: dependencia inesperada aborta em vez de derrubar.
drop function if exists public.business_coupon_allowance(uuid, uuid);

-- 2) claim_coupon volta EXATAMENTE a versao da p5 (cifra preservada). A diferenca
--    para a p8 e so o bloco (3) da cota, que e removido inteiro.
drop function if exists public.claim_coupon(uuid, uuid, text, text, text, text, text);

create function public.claim_coupon(
  p_tenant_id uuid,
  p_template_id uuid,
  p_customer_phone text,
  p_customer_name text,
  p_customer_instagram text default null::text,
  p_customer_email text default null::text,
  p_idempotency_key text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions'
as $function$
declare
  v_customer_id uuid;
  v_template coupon_templates%rowtype;
  v_raw_token text;
  v_public_id text;
  v_coupon_id uuid;
  v_already_has int;
  v_short_code text;
  v_cached jsonb;
  v_cipher bytea;
  v_result jsonb;
  v_key text;
begin
  -- (1) Serializa requisicoes concorrentes do MESMO template. ANTES da leitura
  -- do cache, ver a nota de ordem em p3-idempotencia-claim-coupon.sql.
  select * into v_template from coupon_templates where id = p_template_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'NOT_FOUND: template'; end if;
  if not v_template.is_active then raise exception 'COUPON_INACTIVE'; end if;

  -- (2) Replay: devolve o MESMO cupom, agora decifrando.
  if p_idempotency_key is not null then
    select result_enc into v_cipher
      from idempotency_keys
      where tenant_id = p_tenant_id and operation = 'coupon.claim' and idempotency_key = p_idempotency_key;

    if v_cipher is not null then
      select key into v_key from public.idempotency_keys_secret where singleton;
      if v_key is null then
        raise exception 'IDEMPOTENCY_UNAVAILABLE';
      end if;
      begin
        v_cached := pgp_sym_decrypt(v_cipher, v_key)::jsonb;
      exception when others then
        raise exception 'IDEMPOTENCY_UNAVAILABLE';
      end;
      return v_cached || jsonb_build_object('idempotent', true);
    end if;
  end if;

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

  v_result := jsonb_build_object('couponId', v_coupon_id, 'publicId', v_public_id, 'rawToken', v_raw_token, 'shortCode', v_short_code, 'customerId', v_customer_id);

  -- (3) Guarda a resposta CIFRADA.
  if p_idempotency_key is not null then
    select key into v_key from public.idempotency_keys_secret where singleton;
    if v_key is null then
      raise exception 'IDEMPOTENCY_UNAVAILABLE';
    end if;
    insert into idempotency_keys (tenant_id, operation, idempotency_key, result_enc)
    values (p_tenant_id, 'coupon.claim', p_idempotency_key, pgp_sym_encrypt(v_result::text, v_key))
    on conflict (tenant_id, operation, idempotency_key) do nothing;
  end if;

  return v_result;
end;
$function$;

revoke execute on function public.claim_coupon(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.claim_coupon(uuid, uuid, text, text, text, text, text) to service_role;

-- 3) As colunas da cota. As constraints caem junto; o DROP das constraints
--    antes e explicito para o arquivo continuar legivel como lista do que a
--    p8 criou.
alter table public.businesses drop constraint if exists businesses_free_coupon_allowance_nonneg;
alter table public.businesses drop constraint if exists businesses_free_coupons_used_nonneg;
alter table public.businesses drop column if exists free_coupon_allowance;
alter table public.businesses drop column if exists free_coupons_used;

-- ---------------------------------------------------------------------------
-- Como conferir depois
-- ---------------------------------------------------------------------------
-- select count(*) from information_schema.columns
--  where table_schema = 'public' and table_name = 'businesses'
--    and column_name in ('free_coupon_allowance', 'free_coupons_used');
--   -- esperado: 0
--
-- select count(*) from pg_proc where proname = 'business_coupon_allowance';
--   -- esperado: 0
--
-- select count(*) from coupons;
--   -- esperado: o MESMO numero de antes do rollback. Se mudou, o erro foi
--   -- deste arquivo, e nao uma consequencia aceitavel.