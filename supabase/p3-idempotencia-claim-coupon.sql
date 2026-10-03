-- ============================================================================
-- p3-idempotencia-claim-coupon.sql
--
-- Idempotência no RESGATE (claim_coupon), seguindo exatamente o padrão já
-- usado em validate_and_redeem_coupon (operation='coupon.validate').
--
-- O que este arquivo faz:
--   1) claim_coupon ganha um 7º parâmetro OPCIONAL p_idempotency_key.
--   2) Replay com a mesma chave devolve o MESMO cupom (campo `idempotent:
--      true`), sem emitir cupom novo e sem incrementar issued_count.
--   3) ACL fechada para PUBLIC/anon/authenticated; só service_role executa.
--
-- ---------------------------------------------------------------------------
-- POR QUE DROP + CREATE, E NÃO CREATE OR REPLACE
-- ---------------------------------------------------------------------------
-- Assinatura diferente = função diferente no Postgres. Um CREATE OR REPLACE
-- com o 7º parâmetro CRIARIA um overload em vez de substituir, deixando duas
-- claim_coupon — ambas com DEFAULT. Nesse estado, a chamada do PostgREST com
-- os 6 argumentos nomeados fica ambígua e devolve
-- "function claim_coupon(...) is not unique": o resgate público cai.
-- (É a mesma classe de problema do list_offers em coupon-management.sql.)
--
-- Por isso o DROP e o CREATE têm de ficar na MESMA transação: ou o commit
-- torna a função nova visível, ou o rollback não deixa rastro. Nunca existem
-- as duas. Aplicado pela ferramenta de migration, que roda o arquivo inteiro
-- numa transação, isso é garantido. Rodado à mão no psql SEM transação
-- explícita, a garantia se perde: rode dentro de BEGIN/COMMIT nesse caso.
-- O DROP é sem CASCADE de propósito: se existir dependência inesperada, ele
-- falha e aborta tudo, em vez de derrubar algo junto.
--
-- ---------------------------------------------------------------------------
-- p_idempotency_key NULL = COMPORTAMENTO ATUAL, BIT A BIT
-- ---------------------------------------------------------------------------
-- A coluna idempotency_keys.idempotency_key é NOT NULL. validate_and_redeem_coupon
-- insere sem guardar o NULL porque o JS nunca manda NULL (usa
-- `body.idempotencyKey || randomUUID()`). Copiar o padrão às cegas quebraria
-- TODO resgate: o claim-coupon.js atual manda 6 argumentos, a chave viria
-- NULL, e o INSERT morreria em violação de not-null. Por isso os dois pontos
-- de uso são guardados por `if p_idempotency_key is not null`. Com a chave
-- ausente o comportamento é idêntico ao de antes — o deploy do banco antes do
-- JS é seguro.
--
-- ---------------------------------------------------------------------------
-- POR QUE A LEITURA DO CACHE VEM DEPOIS DO `for update`
-- ---------------------------------------------------------------------------
-- validate_and_redeem_coupon lê o cache antes de qualquer lock. Aqui a ordem é
-- invertida de propósito: com o lock do template primeiro, duas requisições
-- com a mesma chave não passam as duas pelo cache. A segunda trava no
-- `for update`, só volta quando a primeira comitou, e então lê a chave já
-- gravada. Se o cache fosse lido antes do lock, as duas leriam vazio e as duas
-- emitiriam cupom — que é justamente o que a idempotência deve impedir.
--
-- Consequência aceita: se o template for desativado entre o resgate original
-- e o replay, o replay responde COUPON_INACTIVE em vez de devolver o cupom
-- antigo. Preferimos não reentregar oferta desativada.
--
-- O INSERT usa ON CONFLICT DO NOTHING como segunda rede: mesmo num cenário de
-- corrida que não conseguimos antecipar, a função jamais lança erro por
-- chave duplicada.
--
-- ROLLBACK: supabase/p3-idempotencia-claim-coupon.rollback.sql (restaura a
-- definição anterior na íntegra). A definição original também está no histórico
-- deste arquivo.
-- ============================================================================

-- ------------------------------------------------------------
-- 1) Substitui a função (7º parâmetro opcional)
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.claim_coupon(uuid, uuid, text, text, text, text);

CREATE FUNCTION public.claim_coupon(
  p_tenant_id uuid,
  p_template_id uuid,
  p_customer_phone text,
  p_customer_name text,
  p_customer_instagram text DEFAULT NULL::text,
  p_customer_email text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
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
  -- (1) Serializa requisições concorrentes do MESMO template. Fica ANTES da
  -- leitura do cache — ver a nota sobre a ordem no cabeçalho deste arquivo.
  select * into v_template from coupon_templates where id = p_template_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'NOT_FOUND: template'; end if;
  if not v_template.is_active then raise exception 'COUPON_INACTIVE'; end if;

  -- (2) Replay: devolve o cupom original, sem emitir outro e sem contar estoque.
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

  -- (3) Guarda a resposta para o replay. Guardado por causa do NOT NULL:
  -- sem chave, nada e gravado e o comportamento e o de sempre.
  if p_idempotency_key is not null then
    insert into idempotency_keys (tenant_id, operation, idempotency_key, result)
    values (p_tenant_id, 'coupon.claim', p_idempotency_key, v_result)
    on conflict (tenant_id, operation, idempotency_key) do nothing;
  end if;

  return v_result;
end;
$function$;

-- ------------------------------------------------------------
-- 2) ACL: só service_role executa (mesmo formato do p2)
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.claim_coupon(uuid, uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_coupon(uuid, uuid, text, text, text, text, text) TO service_role;