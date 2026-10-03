-- ============================================================================
-- p5-cifrar-idempotency-keys.rollback.sql
--
-- Desfaz p5-cifrar-idempotency-keys.sql.
--
-- ATENCAO — ISTO E UM ROLLBACK QUE VOLTA A UM ESTADO MENOS SEGURO:
-- o texto claro do rawToken volta a ser gravado em idempotency_keys.
-- Se a razao do rollback for um incidente de seguranca, religar o texto
-- claro agrava o problema.
--
-- O QUE ESTE ARQUIVO NAO CONSERVA
-- ---------------------------------------------------------------------------
-- As linhas de coupon.claim escritas enquanto a cifragem esteve ativa sao
-- APAGADAS. Nao ha como reverter pgp_sym_encrypt para texto claro de forma
-- confiavel (a chave e simetrica e o formato nao e reversivel sem ela), e
-- ainda assim as opcoes seriam guardar a chave em texto claro no dump ou
-- aceitar que o token foi perdido.
--
-- Consequencia para o cliente: um resgate cujo cupom foi gravado com
-- cifragem e nunca chegou a ser salvo (QR nao renderizado, tela fechada) fica
-- sem recuperacao por replay. Ele ainda tem o cupom no banco; o que se perde
-- e a capacidade de a tela reconectar. Um novo resgate pode emitir um segundo
-- cupom, limitado por per_customer_limit.
--
-- E por isso que o arquivo apaga as linhas em vez de tentar converter: e
-- preferivel perder um cache a reintroduzir o segredo em claro.
-- ============================================================================

-- 1) Volta claim_coupon para a versao da p3 (texto claro em `result`).
--    DROP sem CASCADE: dependencia inesperada aborta em vez de derrubar.
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
set search_path to 'public', 'extensions'
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
  v_result jsonb;
begin
  select * into v_template from coupon_templates where id = p_template_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'NOT_FOUND: template'; end if;
  if not v_template.is_active then raise exception 'COUPON_INACTIVE'; end if;

  if p_idempotency_key is not null then
    select result into v_cached
      from idempotency_keys
      where tenant_id = p_tenant_id and operation = 'coupon.claim' and idempotency_key = p_idempotency_key;
    if v_cached is not null then
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

  if p_idempotency_key is not null then
    insert into idempotency_keys (tenant_id, operation, idempotency_key, result)
    values (p_tenant_id, 'coupon.claim', p_idempotency_key, v_result)
    on conflict (tenant_id, operation, idempotency_key) do nothing;
  end if;

  return v_result;
end;
$function$;

revoke execute on function public.claim_coupon(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.claim_coupon(uuid, uuid, text, text, text, text, text) to service_role;

-- 2) As linhas cifradas nao tem mais quem as le: a tabela perde a coluna.
--    (Antes do DROP, para nao deixar lixo orfao se algo der errado no meio.)
delete from idempotency_keys where operation = 'coupon.claim' and result_enc is not null;

alter table idempotency_keys drop constraint if exists idempotency_keys_exatamente_um;
alter table idempotency_keys drop column if exists result_enc;
alter table idempotency_keys alter column result set not null;

-- 3) Derruba a chave. A tabela SOME — se o pgcrypto ainda fosse necessario
--    por outro motivo, a chave seria recriada com valor novo e as linhas
--    antigas (ja apagadas acima) nao seriam recoverable.
drop table if exists public.idempotency_keys_secret;