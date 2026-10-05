-- =============================================================================
-- p8 — Cota de 10 cupons no plano FREE
-- =============================================================================
--
-- O QUE O DONO PEDIU
--   "Plano FREE com 10 cupons gratuitos". Confirmado: COTA de 10 cupons no
--   TOTAL, VITALICIA (uma vez, nao renova).
--
-- ONDE A COTA E COBRADA, E PORQUE ESSE LUGAR
--   Em public.claim_coupon, no caminho que emite o cupom. Nao em
--   create_coupon_template: template e a OFERTA ("10% off"), e cupom e o
--   documento que o cliente recebe. Contar template deixaria a empresa criar
--   10 ofertas e emitir 10.000 cupons -- o que nao e o que foi pedido.
--
-- POR QUE MEXER EM claim_coupon, QUE ESTAVA MARCADO "NAO TOCAR"
--   O aviso em modulo3b-referral-hook.sql:24 e sobre alterar a SEMANTICA do
--   caminho idempotente, nao sobre adicionar uma verificacao antes dele. Aqui:
--     - a assinatura nao muda (7 parametros, igual a p3/p5);
--     - o replay idempotente acontece ANTES da cota (bloco (2) da p5), entao
--       repetir a mesma chave nao consome cota duas vezes;
--     - a trava de serializacao do p5 (select ... for update no template) segue
--       intacta e vem antes;
--     - nada do que a funcao devolve muda. O cliente recebe o mesmo JSON.
--   A unica coisa nova e um UPDATE condicional e um erro novo.
--
-- POR QUE "DEPOIS PRECISA PAGAR" VIRA "DEPOIS PRECISA MIGRAR DE PLANO"
--   Nao existe cobranca automatica para o plano FREE, e esse nao e um detalhe de
--   implementacao: `billing_record_coupon_tax` (p2-taxa-por-cupom.sql:75) so
--   cobra empresa PER_COUPON e devolve false para todas as outras; e
--   `billing_mp_prepare` (p2:117) recusa assinatura justamente para FREE e para
--   plano NULL. Nao ha job, cron ou webhook que mude billing_plan -- a mudanca
--   de plano e 100% manual, via admin_set_billing (p2:160-181).
--   Alem disso MP_ACCESS_TOKEN esta ausente do ambiente (health 503 em
--   mercadopago), entao nem tentativa de cobranca automatica funcionaria hoje.
--   Portanto: ao estourar as 10, o resgate e RECUSADO e a empresa sobe de plano
--   por atendimento. Cobrar de verdade e uma fatura separada, que depende de
--   credencial de pagamento e de mexer no motor de cobranca.
--
-- O QUE NAO CONTA PARA A COTA
--   - Cupons de afiliado/indicacao (grant_coupon_internal, modulo3:422): sao
--     concessao do sistema, nao emissao da empresa, e nao passam por
--     claim_coupon. Se contassem, bastaria uma empresa com indicacao rodando
--     para ignorar a cota.
--   - Cupons validados no caixa: o cupom ja foi contado quando foi emitido.
--
-- NULL DE billing_plan CONTA COMO FREE
--   Mesmo criterio de p2:117 (`IS NULL OR = 'FREE'`). businesses.billing_plan
--   tem default no cadastro (register-business.sql:44) mas a coluna veio do
--   banco sem NOT NULL, e uma empresa com NULL pagaria taxa igual a FREE
--   (p2:75) -- logo tem de ter a mesma cota. Sem este coalesce, a empresa mais
--   exposta do sistema ficaria sem limite nenhum.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Colunas
-- -----------------------------------------------------------------------------
-- allowance em coluna, e nao constante no codigo: e o numero que o dono pode
-- querer mudar depois ("sao 15, nao 10") sem deploy, e e o que o /empresa
-- mostra. 0 = bloqueia tudo (kill switch de admin) e NAO "sem cota": um 0
-- silenciosamente removeria a protecao, que e o erro que custa dinheiro. O
-- escape para "plano novo que ja cobra" nao precisa deste 0 -- plano pago nao
-- entra em v_is_free (bloco 3) e nunca chega nesta conta.
alter table public.businesses
  add column if not exists free_coupon_allowance integer not null default 10,
  add column if not exists free_coupons_used     integer not null default 0;

-- Trava contra UPDATE manual com numero negativo. Um -1 aqui valeria 11 cupons
-- gratis na proxima compra, sem nenhum codigo malicioso envolvido: so um erro
-- de digitacao em uma tela de admin.
alter table public.businesses drop constraint if exists businesses_free_coupon_allowance_nonneg;
alter table public.businesses add constraint businesses_free_coupon_allowance_nonneg check (free_coupon_allowance >= 0);

alter table public.businesses drop constraint if exists businesses_free_coupons_used_nonneg;
alter table public.businesses add constraint businesses_free_coupons_used_nonneg check (free_coupons_used >= 0);

comment on column public.businesses.free_coupon_allowance is 'Cupons gratuitos no plano FREE. Vitalicio. 0 = bloqueia tudo (kill switch de admin).';
comment on column public.businesses.free_coupons_used     is 'Cupons ja consumidos da cota. Consome claim_coupon.';

-- -----------------------------------------------------------------------------
-- 2) Backfill: as empresas FREE que ja emitiram cupons
-- -----------------------------------------------------------------------------
-- "10 cupons NO TOTAL" so e verdade se a contagem comecar de onde a empresa
-- esta. Sem este UPDATE, uma empresa que ja emitiu 300 cupons receberia 10
-- novos de graca -- e o resultado seria exatamente o oposto do que foi pedido.
--
-- Contagem por cupom VIVO (status <> 'CANCELLED'), que e o mesmo criterio de
-- LIMIT_REACHED na p5:230. Cupom cancelado nao consumiu estoque do cliente.
--
-- Empresa FREE sem cupom nenhum nao aparece no UPDATE e fica com used = 0 do
-- default, que e o resultado certo.
update public.businesses b
   set free_coupons_used = c.n
  from (
    select business_id, count(*)::integer as n
      from public.coupons
     where status <> 'CANCELLED'
     group by business_id
  ) c
 where c.business_id = b.id
   and coalesce(b.billing_plan, 'FREE') = 'FREE';

-- 2b) GRANDCLAUSE: quem ja passou de 10 nao fica "estourado"
--
-- Decisao do dono: o ambiente ainda esta em TESTE, e as campanhas e os cupons
-- ja emitidos ficam como estao. Nenhum cupom e apagado, nenhuma empresa e
-- bloqueada na hora do deploy.
--
-- O que este UPDATE faz e "regularizar os numeros para enquadrar na regra": a
-- empresa que ja emitiu 12 recebe allowance = 12, e nao allowance = 10 com
-- used = 12. Nas duas situacoes o saldo mostraria 0, mas so na segunda a
-- empresa estaria DENTRO da regra (used <= allowance). O valor impresso no
-- cadastro -- "12 de 12" -- tambem fica honesto, em vez de "12 de 10", que
-- parece um bug de tela.
--
-- Repare que o allowance NAO e inflado para 15 nem para 100: e exatamente o
-- numero que a empresa ja consumiu. Ela nao ganha cupom novo nenhum -- o que
-- muda e que para de existir um estado invalido no banco.
--
-- Empresa dentro do limite (n <= 10) nao entra neste UPDATE e continua com
-- allowance = 10, que e a regra que vale para toda empresa nova.
--
-- Depois deste ponto, used <= allowance vale para TODA empresa FREE do banco.
update public.businesses b
   set free_coupon_allowance = c.n
  from (
    select business_id, count(*)::integer as n
      from public.coupons
     where status <> 'CANCELLED'
     group by business_id
  ) c
 where c.business_id = b.id
   and coalesce(b.billing_plan, 'FREE') = 'FREE'
   and c.n > b.free_coupon_allowance;

-- Se alguma empresa ja estiver com allowance > used, o saldo e esse aqui.

-- -----------------------------------------------------------------------------
-- 3) A cota dentro de claim_coupon
-- -----------------------------------------------------------------------------
-- DROP + CREATE (nao CREATE OR REPLACE) pelo mesmo motivo da p5:155-160 -- se
-- sobrasse alguma versao antiga, as duas com DEFAULT deixariam a chamada do
-- PostgREST ambigua e o resgate publico cairia. DROP sem CASCADE: dependencia
-- inesperada aborta tudo em vez de derrubar o resgate inteiro.
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
  v_is_free boolean;
begin
  -- (1) Serializa requisicoes concorrentes do MESMO template. ANTES da leitura
  -- do cache, ver a nota de ordem em p3-idempotencia-claim-coupon.sql.
  select * into v_template from coupon_templates where id = p_template_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'NOT_FOUND: template'; end if;
  if not v_template.is_active then raise exception 'COUPON_INACTIVE'; end if;

  -- (2) Replay: devolve o MESMO cupom, agora decifrando. Fica ANTES da cota de
  -- proposito: repetir a mesma chave de idempotencia devolve o cupom original
  -- sem consumir uma segunda unidade. Se a cota viesse antes, um retry de rede
  -- -- que o cliente nao confirmou -- consumiria allowance e devolveria
  -- FREE_COUPON_QUOTA_EXCEEDED para um cupom que ele ja tem.
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

  -- (3) COTA DO PLANO FREE. Nova nesta migration.
  --
  -- Fica aqui, e nao antes: os erros de cliente e de estoque sao mais
  -- especificos que "esgotou a cota", e a ordem mantem a mensagem que o
  -- cliente ja conhece para os casos que ele pode resolver sozinho.
  --
  -- O UPDATE e condicional de proposito, e faz duas coisas ao mesmo tempo:
  --   - pega o lock da linha, entao dois resgates simultaneos do MESMO negocio
  --     se serializam em vez de ler o mesmo used e escrever em cima;
  --   - so incrementa se ainda havia saldo.
  -- Um `if free_coupons_used < allowance then update ... end if` separado nao
  -- seria atômico: os dois blocos passariam juntos com used = 9 e o allowance
  -- estouraria para 11 sem ninguem notar. E o tipo de bug que so aparece em
  -- producao, no pico de um evento.
  select (coalesce(billing_plan, 'FREE') = 'FREE') into v_is_free
    from businesses where id = v_template.business_id;

  if v_is_free then
    update businesses
       set free_coupons_used = free_coupons_used + 1
     where id = v_template.business_id
       and free_coupons_used < free_coupon_allowance;
    -- Nenhuma linha afetada: negocio FREE ja no limite.
    if not found then
      raise exception 'FREE_COUPON_QUOTA_EXCEEDED';
    end if;
  end if;

  v_raw_token := encode(gen_random_bytes(32), 'base64');
  v_public_id := 'PYV-' || upper(encode(gen_random_bytes(5), 'hex'));
  v_short_code := lpad(floor(random() * 1000000)::text, 6, '0');

  insert into coupons (public_id, secure_token_hash, short_code_hash, tenant_id, template_id, campaign_id, business_id, customer_id, status, expires_at)
  values (v_public_id, encode(digest(v_raw_token,'sha256'),'hex'), encode(digest(v_short_code,'sha256'),'hex'), p_tenant_id, p_template_id, v_template.campaign_id, v_template.business_id, v_customer_id, 'AVAILABLE', v_template.valid_until)
  returning id into v_coupon_id;

  update coupon_templates set issued_count = issued_count + 1 where id = p_template_id;

  v_result := jsonb_build_object('couponId', v_coupon_id, 'publicId', v_public_id, 'rawToken', v_raw_token, 'shortCode', v_short_code, 'customerId', v_customer_id);

  -- (4) Guarda a resposta CIFRADA. A linha so existe se o cliente mandou
  -- chave; sem chave o comportamento e o de sempre (ver p3).
  if p_idempotency_key is not null then
    select key into v_key from public.idempotency_keys_secret where singleton;
    if v_key is null then
      -- Sem chave de cifra nao ha gravacao POSSIVEL sem guardar o rawToken em
      -- texto claro, que e exatamente o que esta migration existe para
      -- impedir. Falha alto e visivel em vez de degradar para o vazamento.
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

-- -----------------------------------------------------------------------------
-- 4) Ler a cota (para o /empresa mostrar "7 de 10")
-- -----------------------------------------------------------------------------
-- RPC nova e so de leitura. Sem ela a tela teria que fazer a conta em cima de
-- business_coupon_stats, que e acumulado historico e sem .sql no repo -- e
-- inventar um segundo numero, que divergiria do contador real.
--
-- O par (allowance, used) vem das MESMAS colunas que a cota consome. Se a tela
-- lesse de outro lugar, o numero mostrado e o erro real seriam de fontes
-- diferentes, e o primeiro sintoma seria um cliente reclamando de um limite que
-- o sistema nunca aplicou.
drop function if exists public.business_coupon_allowance(uuid, uuid);

create function public.business_coupon_allowance(
  p_tenant_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public', 'extensions'
as $function$
declare
  v_actor users%rowtype;
  v_is_free boolean;
begin
  -- Mesma regra de escopo de driver_list_for_business (modulo4:717+): o ator
  -- precisa existir no tenant e ter papel de empresa. Sem isto, qualquer
  -- customer autenticado leria a cota de qualquer empresa por id.
  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  select (coalesce(b.billing_plan, 'FREE') = 'FREE') into v_is_free
    from businesses b where b.id = v_actor.business_id and b.tenant_id = p_tenant_id;

  -- Dois casos caem aqui e nenhum dos dois e erro:
  --   - plano pago (BASIC/PRO/PER_COUPON), que nao tem cota nenhuma;
  --   - ADMIN/SUPER_ADMIN sem business_id, para quem a cota nao se aplica.
  -- Em ambos, limited = false e a tela nao desenha contador. Sem este early
  -- return, o SELECT do final devolveria NULL em vez de false -- e a tela
  -- trataria null como "cota desconhecida", mostrando "de 10" sem numero.
  if not coalesce(v_is_free, false) then
    return jsonb_build_object('limited', false, 'plan', null, 'allowance', null, 'used', null, 'remaining', null);
  end if;

  return (
    select jsonb_build_object(
      'limited',  true,
      'plan',     coalesce(b.billing_plan, 'FREE'),
      'allowance', b.free_coupon_allowance,
      'used',      b.free_coupons_used,
      -- greatest(0, ...) porque allowance pode ser reduzido por um admin
      -- depois da empresa ter usado mais do que o novo limite: o remaining
      -- negativo mostraria "-3 de 10" na tela, e o cliente acharia que tem
      -- 3 cupons a ganhar.
      'remaining', greatest(0, b.free_coupon_allowance - b.free_coupons_used)
    )
    from businesses b
    where b.id = v_actor.business_id and b.tenant_id = p_tenant_id
  );
end;
$function$;

revoke execute on function public.business_coupon_allowance(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.business_coupon_allowance(uuid, uuid) to service_role;
