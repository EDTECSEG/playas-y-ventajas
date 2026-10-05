-- =============================================================================
-- p7 — CPF obrigatorio no cadastro de motorista
-- =============================================================================
--
-- O QUE ESTA MIGRATION FAZ, E SO ISSO:
--   Reescreve public.driver_register para recusar cadastro sem CPF valido.
--
-- O QUE ELA NAO FAZ, E POR QUE:
--   Nao torna drivers.cpf NOT NULL. A coluna tem linhas NULL -- todos os
--   motoristas cadastrados antes da p6 -- e um SET NOT NULL aqui derrubaria a
--   migration em producao com "column contains null values", nao com um erro
--   legivel. Alem disso, NOT NULL aqui passaria a valer tambem para UPDATE de
--   linhas antigas por qualquer caminho que nao seja a RPC.
--
--   A exigencia e por RPC, nao por schema. Quem decide o que e obrigatorio no
--   cadastro e a regra de negocio, e a regra mora na funcao que faz o cadastro.
--
-- QUANDO APLICAR:
--   SOMENTE depois que o worker novo estiver no ar. O worker anterior manda 6
--   argumentos e nao manda CPF: aplicando esta migration antes do deploy, todo
--   cadastro novo passa a devolver CPF_REQUIRED e o cadastro fica fora do ar.
--   A sequencia esta em API.md e o guard que protege a ordem e o
--   tests/driver-cpf-cnpj-guard.test.cjs.
--
-- O QUE CONTINUA SENDO OPCIONAL:
--   CNPJ e razao social. MEI tem os dois; autonomo so o CPF. Exigir CNPJ
--   deixaria de fora a maioria dos motoristas de translado.
-- =============================================================================

-- A sobrecarga antiga de 6 parametros e derrubada aqui tambem, e nao so a de 9.
-- Na sequencia normal (p6 -> p7) ela ja nao existe e este drop e no-op. Mas se
-- alguem rodar a p7 sem a p6, ou reaplicar o modulo4-motoristas.sql DEPOIS da
-- p7, a versao de 6 parametros volta a existir ao lado da de 9 -- e toda
-- chamada com 6 argumentos ou menos passa a responder 'function ... is not
-- unique'. E o erro mais confuso que existe aqui: nada no codigo parece errado,
-- a RPC simplesmente para de resolver. Derrubar as duas assinaturas deixa cada
-- migration segura de aplicar sozinha.
drop function if exists public.driver_register(uuid, text, text, text, uuid, text);
drop function if exists public.driver_register(uuid, text, text, text, uuid, text, text, text, text);

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

  -- ---- CPF / CNPJ: normalizados ANTES das regras de obrigatoriedade ----
  v_cpf        := nullif(public.digits_only(p_cpf), '');
  v_cnpj       := nullif(public.digits_only(p_cnpj), '');
  v_legal_name := nullif(btrim(coalesce(p_legal_name, '')), '');

  -- A diferenca entre esta e a p6 sao estas quatro linhas. A ordem e
  -- obrigatoria: 'ausente' antes de 'invalido'. Sem CPF chega aqui como NULL,
  -- e public.is_valid_cpf(NULL) devolvia false -- o mesmo erro para "esqueci de
  -- preencher" e para "digitei um numero errado". O motorista veria "CPF
  -- invalido" num campo que ele simplesmente nao preencheu, e nao saberia o que
  -- corrigir.
  if v_cpf is null then
    raise exception 'CPF_REQUIRED';
  end if;
  if not public.is_valid_cpf(v_cpf) then
    raise exception 'CPF_INVALID';
  end if;

  -- CNPJ permanece opcional. Se veio, tem de passar no DV e vir com razao.
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

  -- email tambem e unico por tenant (drivers_tenant_email_uniq). Verificamos
  -- aqui para devolver erro legivel em vez de deixar a constraint estourar
  -- com 'duplicate key value violates unique constraint'.
  if exists (select 1 from public.drivers where tenant_id = p_tenant_id and lower(email) = v_email) then
    raise exception 'EMAIL_ALREADY_REGISTERED';
  end if;

  -- CPF unico por tenant. Mesmo motivo do email: exists() primeiro para
  -- devolver CPF_ALREADY_REGISTERED em vez do erro cru da unique.
  if exists (
    select 1 from public.drivers where tenant_id = p_tenant_id and cpf = v_cpf
  ) then
    raise exception 'CPF_ALREADY_REGISTERED';
  end if;

  -- CNPJ unico por tenant. Uma empresa nao pode ter dois motoristas.
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

-- ACL fechado aqui, na propria migration, e nao so no close-function-exec.sql.
-- A assinatura de 9 argumentos foi DROPpada acima, entao esta funcao nasce
-- nova e herda o default do schema: EXECUTE para PUBLIC, que inclui anon e
-- authenticated. Rodar o close-function-exec.sql depois (Regra 4 do AGENTS.md,
-- obrigatorio) fecha, mas deixa uma janela entre a aplicacao e o close em que
-- a cadastro de motorista fica chamavel direto pelo navegador, sem passar pelo
-- worker. Duas linhas aqui fecham essa janela.
revoke execute on function public.driver_register(uuid, text, text, text, uuid, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.driver_register(uuid, text, text, text, uuid, text, text, text, text) to service_role;
