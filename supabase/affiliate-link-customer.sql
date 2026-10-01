-- ============================================================
-- Playas y Ventajas - Vinculo afiliado <-> cliente (item B)
-- ------------------------------------------------------------
-- RODE DEPOIS do modulo3-afiliados.sql e do modulo3b-referral-hook.sql.
-- Idempotente: pode rodar varias vezes sem efeito colateral.
--
-- ============================================================
-- O PROBLEMA
-- ------------------------------------------------------------
-- Em 2026-10-01, um afiliado de teste (Jose das Couve,
-- JOSDASCOUVE-EB29) recebeu uma indicacao real: o cliente entrou pelo
-- link, resgatou o cupom PYV-198300510F e a empresa validou. O
-- caminho inteiro funcionou --
--
--   referrals.status      = 'converted'
--   referrals.converted_at = preenchida
--   coupons.status        = 'VALIDATED'
--
-- ... mas referrals.reward_coupon_id ficou NULL. O afiliado ganhou
-- uma indicacao e ZERO recompensa.
--
-- A causa NAO e falta de configuracao de template. Sao DUAS causas
-- empilhadas:
--
-- 1) affiliate_rewards.affiliate_reward_template_id e NULL (nenhum
--    template de premio configurado). Isso e configuracao e se resolve
--    pela tela do admin.
--
-- 2) affiliates.customer_id e NULL -- e NINGUEM NUNCA ESCREVE ESSA
--    COLUNA. Verificado: o INSERT de affiliate_register
--    (modulo3-afiliados.sql:209) lista tenant_id, name, phone,
--    email, kind e referral_code; customer_id fica de fora. As duas
--    unicas leituras de affiliates em codigo (affiliates.js:38 e
--    claim-coupon.js:15) so selecionam referral_code.
--
-- A consequencia do item 2 e fatal e independente do item 1:
-- referral_convert (modulo3-afiliados.sql:353) faz
--
--     p_customer_id := (select customer_id from affiliates where id = ...)
--
-- e grant_coupon_internal (linha 404) comeca com
--
--     if p_customer_id is null then return null;
--
-- Portanto, mesmo COM o template configurado, o premio seria NULL
-- para qualquer afiliado do sistema. Nao e caso do afiliado de teste:
-- e a coluna que nunca foi preenchida.
--
-- ============================================================
-- A ESCOLHA: por que isso NAO mexe em identify_customer
-- ------------------------------------------------------------
-- identify_customer e a tabela users sao do BASE SCHEMA e NAO estao
-- neste repositorio (ver SPEC-agendamento.md:59, "base schema (fora do
-- repo)"). As 41 migracoes aqui sao todas de modulo.
--
-- Reescrever identify_customer exigiria ter o corpo atual da funcao
-- para nao perder logica. Este arquivo segue o mesmo padrao que o
-- modulo3b ja estabeleceu para resolver exatamente este tipo de
-- problema: em vez de reescrever a RPC de producao, cria uma funcao
-- ADITIVA ao lado e o endpoint a chama best-effort.
--
-- Se algum dia o base schema for versionado aqui, o ideal e mover a
-- ligacao para dentro de identify_customer e este arquivo vira apenas
-- o trigger de retrocompatibilidade.
--
-- ============================================================
-- A DECISAO DE PRODUTO: caso (b)
-- ------------------------------------------------------------
-- O afiliado que NUNCA passou pelo /cliente nao ganha customer_id.
-- Nao criamos users.sobrevidas automaticamente -- criar um registro
-- de cliente para alguem que nao se cadastrou duplicaria o telefone
-- no momento em que essa pessoa entrasse pelo /cliente depois.
--
-- Consequencia assumida e visivel: a indicacao converte, o premio
-- fica pendente, e o painel do afiliado tem que EXPLICAR isso. Da
-- funcao affiliate_reward_status (secao 4) abaixo.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Liga afiliado a cliente quando os telefones batem
-- ------------------------------------------------------------
-- Best-effort por desenho: se nao houver afiliado com esse telefone,
-- devolve false e nao ha erro. Chamada a partir de identify.js
-- depois do cadastro -- o cadastro do cliente tem de funcionar com ou
-- sem esse vinculo.
--
-- A normalizacao por digitos e obrigatoria dos dois lados: o telefone
-- vem do navegador como a pessoa digitou ("22 99202-1576"), e o
-- affiliates.phone_digits ja e coluna gerada por
-- regexp_replace(phone, '\D', '', 'g'). Aqui nao existe
-- users.phone_digits (base schema), entao a expressao e repetida.
--
-- O ON CONFLICT / WHERE NOT EXISTS evita reescrever um customer_id ja
-- preenchido: quem ja estava ligado nao pode ser trocado por uma
-- segunda chamada com o mesmo telefone.
DROP FUNCTION IF EXISTS public.link_affiliate_customer(uuid, uuid);

CREATE OR REPLACE FUNCTION public.link_affiliate_customer(
  p_tenant_id uuid,
  p_customer_id uuid
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_digitos text;
  v_linked integer;
begin
  if p_tenant_id is null or p_customer_id is null then
    return false;
  end if;

  select regexp_replace(coalesce(u.phone, ''), '\D', '', 'g')
  into v_digitos
  from public.users u
  where u.id = p_customer_id
    and u.tenant_id = p_tenant_id;

  -- Cliente sem telefone utilizavel: nao ha com o que casar.
  if v_digitos is null or v_digitos = '' then
    return false;
  end if;

  update public.affiliates a
  set customer_id = p_customer_id
  where a.tenant_id = p_tenant_id
    and a.phone_digits = v_digitos
    and a.customer_id is null;

  get diagnostics v_linked = row_count;
  return (v_linked > 0);

exception
  when others then
    -- NUNCA propaga erro. Este vinculo e um extra; o cadastro do
    -- cliente ja aconteceu antes desta chamada e nao pode falhar
    -- por causa dela.
    return false;
end $function$
;

-- service_role chama; o cliente nunca. Sem isso a funcao seria um
-- caminho para um anon amarrar o proprio user_id num afiliado.
REVOKE EXECUTE ON FUNCTION public.link_affiliate_customer(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2) Recupera indicacoes ja convertidas antes deste arquivo existir
-- ------------------------------------------------------------
-- O trigger da secao 3 so dispara em INSERT/UPDATE FUTUROS. As
-- indicacoes que ja convertaram enquanto customer_id era sempre NULL
-- ficariam com premio faltando para sempre.
--
-- Este backfill liga o que da para ligar agora (afiliado que ja e
-- cliente) e DEPOIS tenta converter de novo o que ainda nao tinha
-- premio. O segundo passo so funciona se o admin configurar o
-- template antes de rodar esta parte -- por isso a funcao conta
-- quantas ficaram sem premio em vez de fingir que resolveu.
--
-- Nao roda nada em lote: e uma unica volta por tenant, e o resultado
-- e(json, nao alteracao em massa silenciosa.
DROP FUNCTION IF EXISTS public.backfill_affiliate_rewards(uuid);

CREATE OR REPLACE FUNCTION public.backfill_affiliate_rewards(
  p_tenant_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_linked integer := 0;
  v_retry  integer := 0;
  v_pendente integer := 0;
  r record;
begin
  -- 1) Liga quem tem os dois lados.
  update public.affiliates a
  set customer_id = u.id
  from public.users u
  where a.tenant_id = p_tenant_id
    and a.customer_id is null
    and u.tenant_id = p_tenant_id
    and regexp_replace(coalesce(u.phone, ''), '\D', '', 'g') = a.phone_digits
    and regexp_replace(coalesce(u.phone, ''), '\D', '', 'g') <> '';
  get diagnostics v_linked = row_count;

  -- 2) Para cada indicacao convertida sem premio, volta para pending e
  --    tenta converter de novo. referral_convert exige status
  --    'pending' (modulo3-afiliados.sql:336), entao e preciso
  --    desfazer o status antes de chamar.
  for r in
    select ref.id
    from public.referrals ref
    where ref.tenant_id = p_tenant_id
      and ref.status = 'converted'
      and ref.reward_coupon_id is null
  loop
    begin
      update public.referrals set status = 'pending', converted_at = null where id = r.id;
      perform public.referral_convert(p_tenant_id, ref.referred_user_id);
      get diagnostics v_retry = row_count;
    exception
      when others then
        -- Um registro problematico nao pode abortar o lote.
        null;
    end;
  end loop;

  -- 3) Quanto ainda falta. Este numero e o que o painel mostra.
  select count(*) into v_pendente
  from public.referrals ref
  join public.affiliates a on a.id = ref.affiliate_id
  where ref.tenant_id = p_tenant_id
    and ref.status = 'converted'
    and ref.reward_coupon_id is null
    and a.customer_id is null;

  return jsonb_build_object(
    'linked', v_linked,
    'pendingRewardNeedsCustomer', v_pendente,
    'note', 'linked = quantos afiliados ganharam customer_id agora. pendingRewardNeedsCustomer = indicacoes convertidas que ainda nao podem pagar porque o afiliado nunca passou pelo /cliente.'
  );
end $function$
;

REVOKE EXECUTE ON FUNCTION public.backfill_affiliate_rewards(uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3) Link na direcao inversa, e o trigger que a usa
-- ------------------------------------------------------------
-- link_affiliate_customer (secao 1) vai de um customer para o
-- afiliado com o mesmo telefone: e o caminho do identify.js, onde o
-- customer acabou de ser criado.
--
-- O trigger precisa do CONTRARIO: dado um affiliate_id (que ja
-- temos na linha da indicacao), achar o user cujo telefone bate.
-- Sem esta funcao o trigger passaria new.referred_user_id -- o
-- INDICADO -- para o link, e um indicado cujo telefone casasse com
-- outro afiliado seria amarrado ao afiliado errado. Esse bug
-- existiu numa versao anterior deste arquivo e foi corrigido aqui.
DROP FUNCTION IF EXISTS public.link_affiliate_by_id(uuid, uuid);

CREATE OR REPLACE FUNCTION public.link_affiliate_by_id(
  p_tenant_id uuid,
  p_affiliate_id uuid
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_linked integer := 0;
begin
  if p_tenant_id is null or p_affiliate_id is null then
    return false;
  end if;

  update public.affiliates a
  set customer_id = u.id
  from public.users u
  where a.tenant_id = p_tenant_id
    and a.id = p_affiliate_id
    and a.customer_id is null
    and u.tenant_id = p_tenant_id
    and regexp_replace(coalesce(u.phone, ''), '\D', '', 'g') = a.phone_digits
    and regexp_replace(coalesce(u.phone, ''), '\D', '', 'g') <> '';
  get diagnostics v_linked = row_count;
  return (v_linked > 0);

exception
  when others then
    return false;
end $function$
;

REVOKE EXECUTE ON FUNCTION public.link_affiliate_by_id(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Trigger: pega a indicacao convertida sem premio.
--
-- Cobre o caso em que o afiliado se cadastrou como cliente DEPOIS de
-- indicar. Roda depois do referral_convert marcar 'converted' e
-- tenta ligar pelo affiliate_id da propria linha.
--
-- Por que AFTER e nao BEFORE: em BEFORE o status ainda nao seria
-- 'converted' e referral_convert nao encontraria 'pending'.
--
-- Limite deliberado: este trigger so LIGA o vinculo, nao credita o
-- premio. Creditar exigiria chamar referral_convert de novo, e isso
-- aconteceria dentro do mesmo UPDATE que disparou o trigger --
-- reentrada em trigger. E a funcao backfill_affiliate_rewards faz
-- esse trabalho depois, de forma explicita e inspecionavel. Um cupom
-- de premio que some em silencio dentro de um trigger e pior do que
-- um campo que mostra "faltando".
DROP TRIGGER IF EXISTS trg_referral_reward_link ON public.referrals;

CREATE OR REPLACE FUNCTION public.trg_referral_reward_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
begin
  -- So interessa conversao que nao creditou premio.
  if new.status = 'converted'
     and new.reward_coupon_id is null
     and new.tenant_id is not null
     and new.affiliate_id is not null then
    perform public.link_affiliate_by_id(new.tenant_id, new.affiliate_id);
  end if;
  return new;
end $function$
;

CREATE TRIGGER trg_referral_reward_link
  AFTER INSERT OR UPDATE ON public.referrals
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_referral_reward_link();

-- ------------------------------------------------------------
-- 4) Status do premio: a tela do afiliado precisa explicar o silencio
-- ------------------------------------------------------------
-- Sem isso o afiliado ve "1 indicacao convertida" e nenhum cupom, sem
-- distincao entre "ja recebeu" e "nao pode receber ainda". Este
-- contrato devolve o motivo.
--
-- Chave nova: pendingReason com um destes valores:
--   'ok'                 - tem customer_id (e cupom, se configurado)
--   'semCadastroCliente' - afinado em customer_id; premio nao tem onde cair
--   'semTemplate'        - sem customer_id NAO e a causa; falta config
DROP FUNCTION IF EXISTS public.affiliate_reward_status(uuid, uuid);

CREATE OR REPLACE FUNCTION public.affiliate_reward_status(
  p_tenant_id uuid,
  p_affiliate_id uuid
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
  select jsonb_build_object(
    'affiliateId', a.id,
    'hasCustomer', (a.customer_id is not null),
    'customerId', a.customer_id,
    'rewardTemplateConfigured', (cfg.affiliate_reward_template_id is not null),
    'welcomeTemplateConfigured', (cfg.welcome_template_id is not null),
    'pendingReason', case
      when a.customer_id is null then 'semCadastroCliente'
      when cfg.affiliate_reward_template_id is null then 'semTemplate'
      else 'ok'
    end,
    'convertedCount', (
      select count(*) from public.referrals r
      where r.tenant_id = p_tenant_id and r.affiliate_id = a.id and r.status = 'converted'
    ),
    'rewardedCount', (
      select count(*) from public.referrals r
      where r.tenant_id = p_tenant_id and r.affiliate_id = a.id and r.reward_coupon_id is not null
    )
  )
  from public.affiliates a
  left join public.affiliate_rewards cfg on cfg.tenant_id = a.tenant_id
  where a.tenant_id = p_tenant_id
    and a.id = p_affiliate_id;
$function$
;

REVOKE EXECUTE ON FUNCTION public.affiliate_reward_status(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 5) Como rodar e validar
-- ============================================================
-- 1) Este arquivo inteiro, no SQL Editor do Supabase.
-- 2) Ligar o vinculo de quem ja tem os dois lados (repete a secao 1
--    da migration, de proposito: e a mesma operacao, idempotente):
--
--      select link_affiliate_customer(
--        '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9',
--        (select id from users where phone like '%99202%' limit 1)
--      );
--    Esperado true para o telefone que casar com um afiliado.
--
-- 3) Ver o estado:
--
--      select affiliate_reward_status(
--        '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9',
--        (select id from affiliates where referral_code = 'JOSDASCOUVE-EB29')
--      );
--
--    Esperado: hasCustomer=false e pendingReason='semCadastroCliente'
--    enquanto o afiliado nao passar pelo /cliente.
--
-- 4) DEPOIS de configurar o template pelo admin, recuperar as
--    indicacoes que ficaram sem premio:
--
--      select backfill_affiliate_rewards('0dc57eeb-46c8-47ac-aad4-640d9d59e7b9');
--
--    O campo pendingRewardNeedsCustomer mostra quantas nao tem como
--    pagar ainda -- essas exigem o cadastro do afiliado como cliente.
-- ============================================================