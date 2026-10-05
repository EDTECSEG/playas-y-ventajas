-- ============================================================================
-- p7-cpf-obrigatorio-motorista.rollback.sql
--
-- Desfaz p7-cpf-obrigatorio-motorista.sql.
--
-- O QUE VOLTA
--   driver_register deixa de exigir CPF e volta a aceitar cadastro sem ele.
--   E o estado exato da p6: a MESMA funcao de 9 parametros, so que voltando a
--   tratar CPF ausente como permissivel em vez de recusar com CPF_REQUIRED.
--
-- POR QUE NAO BASTA UM "DROP" DA REGRA
--   O que a p7 mudou foi o CORPO da funcao, nao a assinatura. Nao ha coluna e
--   nao ha parametro novo para desfazer -- os tres campos (cpf, cnpj,
--   legal_name) continuam existindo e continuam sendo gravados.
--
-- POR QUE "create or replace" E SEGURO AQUI
--   A p6 e a p7 declaram a assinatura com os mesmos nomes e tipos, so mudando
--   DEFAULT NULL -> DEFAULT NULL e o corpo. Trocar o corpo e exatamente o que
--   se quer, e o CREATE OR REPLACE preserva as ACLs (revoke/grant) que ja
--   valem para a funcao em producao -- um DROP + CREATE as perderia no caminho.
--
-- O QUE ESTE ARQUIVO NAO CONSERVA
--   Nada. A p7 nao apaga, nao altera e nao bloqueia nenhum cadastro: ela apenas
--   RECUSA cadastros novos sem CPF. Os motoristas cadastrados entre a p7 e este
--   rollback permanecem, com o CPF que foi exigido na epoca.
--   Voltar a aceitar CPF nulo nao volta nenhum cadastro antigo: eles ja tinham
--   CPF por causa da exigencia.
--
-- IMPACTO EM PRODUCAO
--   Se o worker NOVO (que exige CPF na tela) estiver no ar quando este rollback
--   rodar, a tela segue exigindo CPF e a RPC volta a aceitar -- nao ha quebra.
--   Se o cadastro parar de funcionar depois do rollback, a causa nao e este
--   arquivo: e a p7 ter sido aplicada antes do deploy (ver o "QUANDO APLICAR"
--   no cabecalho da p7).
-- ============================================================================

-- 1) Sem chave e sem valor padrao: a regra volta a ser "CPF ausente e
--    permissivel, CPF presente tem de passar no DV".
create or replace function public.driver_register(
  p_tenant_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_business_id uuid DEFAULT NULL,
  p_invite_code text DEFAULT NULL,
  p_cpf text DEFAULT NULL,
  p_cnpj text DEFAULT NULL,
  p_legal_name text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_phone        text;
  v_email        text;
  v_driver_id    uuid;
  v_invite       public.business_invites%rowtype;
  v_business_id  uuid;
  v_pin_token    text;
  v_upload_token text;
  v_recent       integer;
  v_cpf          text;
  v_cnpj         text;
  v_legal_name   text;
begin
  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_email := lower(trim(coalesce(p_email, '')));
  if p_name is null or btrim(p_name) = '' then raise exception 'NAME_REQUIRED'; end if;
  if length(v_phone) < 10 then raise exception 'PHONE_INVALID'; end if;
  if v_email not like '%@%' then raise exception 'EMAIL_INVALID'; end if;
  if length(v_phone) > 15 then raise exception 'PHONE_INVALID'; end if;
  if length(btrim(p_name)) > 120 then raise exception 'NAME_TOO_LONG'; end if;

  -- ---- CPF / CNPJ: normalizados ANTES das regras de duplicidade ----
  v_cpf        := nullif(public.digits_only(p_cpf), '');
  v_cnpj       := nullif(public.digits_only(p_cnpj), '');
  v_legal_name := nullif(btrim(coalesce(p_legal_name, '')), '');

  -- Ausencia e permissivel (estado da p6). So o que veio e conferido.
  if v_cpf is not null and not public.is_valid_cpf(v_cpf) then
    raise exception 'CPF_INVALID';
  end if;
  if v_cnpj is not null and not public.is_valid_cnpj(v_cnpj) then
    raise exception 'CNPJ_INVALID';
  end if;
  if v_cnpj is not null and v_legal_name is null then
    raise exception 'LEGAL_NAME_REQUIRED';
  end if;
  if v_legal_name is not null and length(v_legal_name) > 160 then
    raise exception 'LEGAL_NAME_TOO_LONG';
  end if;

  -- teto de cadastros por hora por tenant
  select count(*) into v_recent
  from public.drivers
  where tenant_id = p_tenant_id and created_at > now() - interval '1 hour';
  if v_recent >= 20 then raise exception 'REGISTRATION_RATE_LIMITED'; end if;

  -- telefone ja cadastrado no tenant? nao cria duplicado
  if exists (select 1 from public.drivers where tenant_id = p_tenant_id and regexp_replace(phone,'\D','','g') = v_phone) then
    raise exception 'PHONE_ALREADY_REGISTERED';
  end if;

  -- email tambem e unico por tenant (drivers_tenant_email_uniq).
  if exists (select 1 from public.drivers where tenant_id = p_tenant_id and lower(email) = v_email) then
    raise exception 'EMAIL_ALREADY_REGISTERED';
  end if;

  -- CPF unico por tenant, quando informado.
  if v_cpf is not null and exists (
    select 1 from public.drivers where tenant_id = p_tenant_id and cpf = v_cpf
  ) then
    raise exception 'CPF_ALREADY_REGISTERED';
  end if;

  -- CNPJ unico por tenant.
  if v_cnpj is not null and exists (
    select 1 from public.drivers where tenant_id = p_tenant_id and cnpj = v_cnpj
  ) then
    raise exception 'CNPJ_ALREADY_REGISTERED';
  end if;

  -- convite de empresa parceira: se vier, ele define a empresa
  v_business_id := p_business_id;
  if p_invite_code is not null and btrim(p_invite_code) <> '' then
    select * into v_invite
    from public.business_invites
    where tenant_id = p_tenant_id and code = upper(btrim(p_invite_code))
    for update;
    if not found then raise exception 'INVITE_INVALID'; end if;
    if v_invite.revoked_at is not null then raise exception 'INVITE_INVALID'; end if;
    if v_invite.expires_at is not null and v_invite.expires_at <= now() then raise exception 'INVITE_EXPIRED'; end if;
    if v_invite.uses >= v_invite.max_uses then raise exception 'INVITE_EXHAUSTED'; end if;
    if v_invite.business_id is not null then
      if p_business_id is not null and p_business_id <> v_invite.business_id then raise exception 'INVITE_BUSINESS_MISMATCH'; end if;
      v_business_id := v_invite.business_id;
    end if;
  end if;

  -- empresa parceira tem que ser do mesmo tenant
  if v_business_id is not null then
    if not exists (select 1 from public.businesses where id = v_business_id and tenant_id = p_tenant_id) then
      raise exception 'BUSINESS_NOT_FOUND';
    end if;
  end if;

  insert into public.drivers (tenant_id, name, phone, email, business_id, status, cpf, cnpj, legal_name)
  values (p_tenant_id, btrim(p_name), v_phone, v_email, v_business_id, 'pending',
          v_cpf, v_cnpj, v_legal_name)
  returning id into v_driver_id;

  v_pin_token    := encode(gen_random_bytes(32), 'hex');
  v_upload_token := encode(gen_random_bytes(32), 'hex');
  insert into public.driver_registration_tokens (tenant_id, driver_id, purpose, token_hash, expires_at)
  values
    (p_tenant_id, v_driver_id, 'pin',    encode(digest(v_pin_token,    'sha256'), 'hex'), now() + interval '2 hours'),
    (p_tenant_id, v_driver_id, 'upload', encode(digest(v_upload_token, 'sha256'), 'hex'), now() + interval '24 hours');

  if v_invite.id is not null then
    update public.business_invites set uses = uses + 1 where id = v_invite.id;
  end if;

  return jsonb_build_object(
    'driverId', v_driver_id,
    'status', 'pending',
    'pinToken', v_pin_token,
    'uploadToken', v_upload_token,
    'message', 'Cadastro criado. Defina seu PIN, envie os documentos e aguarde a aprovacao da empresa.'
  );
end $function$
;

-- O CREATE OR REPLACE preserva o ACL que a funcao ja tem em producao, entao
-- estas duas linhas nao sao estritamente necessarias. Ficam mesmo assim porque o
-- rollback e o caminho que se usa quando algo deu errado: se ele for executado
-- sobre um estado cujo ACL ja estava aberto, ele nao deve perpetuar isso. São
-- idempotentes e nao mudam nada quando o ACL ja esta correto.
revoke execute on function public.driver_register(uuid, text, text, text, uuid, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.driver_register(uuid, text, text, text, uuid, text, text, text, text) to service_role;

-- 2) A sobrecarga de 6 parametros NAO volta aqui, e isso e intencional.
--    Ela nao existia depois da p6 (a p6 a dropou e criou a de 9 com DEFAULT),
--    entao o estado que este arquivo desfaz e o estado da p6: uma funcao so.
--    Recriar a de 6 aqui deixaria as duas de pe ao mesmo tempo, que e
--    exatamente a ambiguidade que a p7 existe para eliminar.

-- ---------------------------------------------------------------------------
-- Como conferir depois
-- ---------------------------------------------------------------------------
-- O corpo tem de voltar a NAO recusar CPF ausente:
--   select count(*) from pg_proc where proname = 'driver_register';
--   -- esperado: 1 (so a de 9 parametros)
--
-- E o cadastro sem CPF tem a de ser aceito de novo. Para conferir sem gravar
-- nada, leia o corpo:
--   select prosrc ~ 'CPF_REQUIRED' as ainda_exige_cpf
--   from pg_proc where proname = 'driver_register';
--   -- esperado: false