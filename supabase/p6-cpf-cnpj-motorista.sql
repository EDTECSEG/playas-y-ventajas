-- =============================================================================
-- p6 — CPF / CNPJ / razao social do motorista
-- =============================================================================
--
-- O que entra:
--   drivers.cpf         11 digitos, OBRIGATORIO a partir de p7 (verporque nao aqui)
--   drivers.cnpj        14 digitos, opcional (MEI tem os dois; autonomo so o CPF)
--   drivers.legal_name  razao social, exigida sempre que houver CNPJ
--
-- GUARDA DE COMPATIBILIDADE (leia antes de aplicar):
--   Este arquivo NAO exige CPF. Ele apenas passa a ACEITAR. A exigencia real
--   fica na p7, aplicada so depois que o worker novo estiver no ar.
--
--   Sem essa separacao nao ha como fazer o deploy: hoje o worker em producao
--   chama driver_register com 6 argumentos e nao manda CPF. Se a exigencia
--   viesse na p6, todo cadastro novo passaria a devolver CPF_REQUIRED ate o
--   deploy do worker -- e o deploy do worker antes da migration quebraria pelo
--   outro lado (RPC com argumento a mais). Nenhuma ordem de aplicacao resolve;
--   so a separacao em duas fases resolve.
--
--   Ordem de deploy: p6 -> push do codigo -> p7.
--   Enquanto a p7 nao entrar, um cadastro sem CPF simplesmente fica com
--   cpf = NULL, que e o estado dos motoristas ja existentes.
--
-- ARMAZENAMENTO: os dois vao com SO DIGITOS, sem mascara.
--   businesses.cnpj aceita formatado ('00.000.000/0000-00') ou 14 digitos, e a
--   comparacao la e feita no formato que o usuario digitou. Aqui seria um
--   convite a divergencia: '12.345.678/0001-90' e '12345678000190' seriam dois
--   cadastros para a mesma empresa, porque o indice unico compara o texto.
--   Guardando digitos, a mascara passa a ser responsabilidade da tela
--   (maskCpf/maskCnpj em app/motorista/logic.js) e a unicidade e real.
--
-- LGPD: cpf e dado pessoal sensivel de identificacao. Fica em texto claro, como
-- ja ficam phone e email desta mesma tabela -- cifrar so o CPF deixaria o
-- conjunto incoerente sem fechar o vazamento (basta SELECT em drivers). O
-- registro esta em SECURITY-DECISIONS.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Validadores de DV (CPF e CNPJ), imutaveis
-- -----------------------------------------------------------------------------
-- No banco, e nao so na tela. A tela valida por UX, o que evita erro de
-- digitacao; o banco valida porque e a autoridade. Se a validacao vivesse so
-- no front, qualquer outro chamador da RPC passaria por fora -- foi
-- exatamente o que aconteceu com validate_and_redeem_coupon, que gera a
-- idempotency key no servidor e nunca viu a chave do cliente.
--
-- search_path = pg_temp: sao funcoes puras, sem acesso a tabela, e fixa-la
-- assim impede que um objeto malicioso criado depois no schema do usuario
-- seja encontrado no meio do calculo.
-- -----------------------------------------------------------------------------

-- So digitos, sem mascara.
create or replace function public.digits_only(p_raw text)
returns text
language sql
immutable
parallel safe
set search_path = pg_temp
as $$
  select regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g');
$$;

-- Sequencia repetida ('00000000000', '11111111111', ...) e rejeitada antes do
-- calculo. E o caso que o DV sozinho NAO pega: uma sequencia de digitos
-- identicos sempre satisfaz a conta, portanto passaria como valida. Nao existe
-- tal CPF/CNPJ na Receita, logo e recusado.
create or replace function public.is_valid_cpf(p_cpf text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_temp
as $$
declare
  v  text := public.digits_only(p_cpf);
  i  integer;
  s  integer := 0;
  d1 integer;
  d2 integer;
begin
  if length(v) <> 11 then
    return false;
  end if;
  if v ~ '^(.)\1{10}$' then
    return false;
  end if;

  -- DV1: pesos 10..2 sobre os 9 primeiros digitos. Formula classica
  -- (soma * 10) % 11, com 10 normalizado para 0.
  for i in 1..9 loop
    s := s + (substr(v, i, 1))::integer * (11 - i);
  end loop;
  d1 := mod(s * 10, 11);
  if d1 = 10 then d1 := 0; end if;

  if (substr(v, 10, 1))::integer <> d1 then
    return false;
  end if;

  -- DV2: pesos 11..2 sobre os 10 primeiros digitos.
  s := 0;
  for i in 1..10 loop
    s := s + (substr(v, i, 1))::integer * (12 - i);
  end loop;
  d2 := mod(s * 10, 11);
  if d2 = 10 then d2 := 0; end if;

  return (substr(v, 11, 1))::integer = d2;
end;
$$;

create or replace function public.is_valid_cnpj(p_cnpj text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_temp
as $$
declare
  v  text := public.digits_only(p_cnpj);
  i  integer;
  s  integer := 0;
  d1 integer;
  d2 integer;
begin
  if length(v) <> 14 then
    return false;
  end if;
  if v ~ '^(.)\1{13}$' then
    return false;
  end if;

  -- DV1: pesos 5,4,3,2,9,8,7,6,5,4,3,2 sobre os 12 primeiros digitos.
  -- resto < 2 produz DV 0 (os casos 10 e 11).
  s := 0;
  for i in 1..12 loop
    s := s + (substr(v, i, 1))::integer *
      (case i when 1 then 5 when 2 then 4 when 3 then 3 when 4 then 2
              when 5 then 9 when 6 then 8 when 7 then 7 when 8 then 6
              when 9 then 5 when 10 then 4 when 11 then 3 else 2 end);
  end loop;
  d1 := 11 - mod(s, 11);
  if d1 >= 10 then d1 := 0; end if;

  if (substr(v, 13, 1))::integer <> d1 then
    return false;
  end if;

  -- DV2: pesos 6,5,4,3,2,9,8,7,6,5,4,3,2 sobre os 13 primeiros digitos.
  s := 0;
  for i in 1..13 loop
    s := s + (substr(v, i, 1))::integer *
      (case i when 1 then 6 when 2 then 5 when 3 then 4 when 4 then 3 when 5 then 2
              when 6 then 9 when 7 then 8 when 8 then 7 when 9 then 6 when 10 then 5
              when 11 then 4 when 12 then 3 else 2 end);
  end loop;
  d2 := 11 - mod(s, 11);
  if d2 >= 10 then d2 := 0; end if;

  return (substr(v, 14, 1))::integer = d2;
end;
$$;

-- Os validadores nao hao laco nenhum, entao nao ha o que revogar. As duas
-- excecoes que valem registrar: public.digits_only e public.is_valid_* sao
-- puras e nao vazam nada, mas o projeto mantem a postura de nao deixar
-- qualquer funcao nova em public aberta para anon/authenticated.
revoke execute on function public.digits_only(text) from public, anon, authenticated;
revoke execute on function public.is_valid_cpf(text) from public, anon, authenticated;
revoke execute on function public.is_valid_cnpj(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2) Colunas
-- -----------------------------------------------------------------------------
-- cpf e NOT NULL seria o erro classico aqui: existem motoristas ja cadastrados
-- (a tabela nao esta vazia) e nenhum deles tem CPF. Tornar a coluna obrigatoria
-- agora barra a migration. A exigencia vale para quem se CADASTRA daqui pra
-- frente, e isso e papel da RPC, nao da coluna. P7 fecha o cerco para quem
-- ainda nao tem.
alter table public.drivers add column if not exists cpf         text;
alter table public.drivers add column if not exists cnpj        text;
alter table public.drivers add column if not exists legal_name  text;

comment on column public.drivers.cpf        is 'Somente digitos, 11. Exigido em novos cadastros (p7).';
comment on column public.drivers.cnpj       is 'Somente digitos, 14. Opcional. MEI tem cpf e cnpj.';
comment on column public.drivers.legal_name is 'Razao social. Exigida quando ha cnpj.';

-- -----------------------------------------------------------------------------
-- 3) Unicidade por tenant
-- -----------------------------------------------------------------------------
-- Parcial (where cpf is not null) porque o unique do Postgres ja ignora NULL,
-- mas a clausula deixa a intencao explicita e protege o indice de crescer com
-- as linhas NULL dos cadastros antigos. O indice e por (tenant_id, cpf) e nao
-- por cpf: dois tenants diferentes podem ter o mesmo motorista, e a unicidade
-- que interessa e a do cadastro DENTRO da empresa -- o mesmo padrao de
-- drivers_tenant_email_uniq.
--
-- A unicidade e o que impede a mesma pessoa de virar dois motoristas na
-- mesma empresa. Como a RPC ainda valida antes do INSERT (para devolver erro
-- legivel), estes indices sao a rede de seguranca, nao o mecanismo principal:
-- sem eles, dois cadastros simultaneos do mesmo CPF passariam pelos dois
-- exists() e so o indice que o impediria -- com o erro cru do banco, que o
-- rpcErrorCode nao sabe traduzir para o motorista.
create unique index if not exists drivers_tenant_cpf_uniq
  on public.drivers (tenant_id, cpf)
  where cpf is not null;

create unique index if not exists drivers_tenant_cnpj_uniq
  on public.drivers (tenant_id, cnpj)
  where cnpj is not null;

-- -----------------------------------------------------------------------------
-- 4) driver_register aceita os campos novos
-- -----------------------------------------------------------------------------
-- Os tres parametros entram com DEFAULT NULL, e o motivo e operacional, nao
-- cosmetico: sem o DEFAULT, a chamada de 6 argumentos do worker hoje em
-- producao passa a dar "function does not exist", porque nao existe sobrecarga
-- de 6. Com o DEFAULT, o worker antigo continua resolvendo para a mesma funcao
-- e so volta a errar em p7, quando passar a ser explicito.
drop function if exists public.driver_register(uuid, text, text, text, uuid, text);

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
  --
  -- A normalizacao vem antes de proposito: comparar '12.345.678/0001-90' com
  -- '12345678000190' como texto reprova a regra e deixa passar cadastro
  -- duplicado. Digitos nos dois lados fecham isso.
  --
  -- Vazio e null sao o mesmo negocio aqui: campo opcional nao enviado e campo
  -- enviado em branco tem de dar o mesmo resultado, senao a tela e o worker
  -- divergem conforme mandam '' ou omitem a chave.
  v_cpf        := nullif(public.digits_only(p_cpf), '');
  v_cnpj       := nullif(public.digits_only(p_cnpj), '');
  v_legal_name := nullif(btrim(coalesce(p_legal_name, '')), '');

  -- Validacao de formato so quando veio alguma coisa. Ausencia e permissivel
  -- nesta fase de proposito; ver a guarda de compatibilidade no cabecalho.
  if v_cpf is not null and not public.is_valid_cpf(v_cpf) then
    raise exception 'CPF_INVALID';
  end if;
  if v_cnpj is not null and not public.is_valid_cnpj(v_cnpj) then
    raise exception 'CNPJ_INVALID';
  end if;

  -- CNPJ sem razao social nao serve para nada: a empresa usa a razao para
  -- conferir o documento, e um CNPJ sem nome e um campo solto. Exigir o par
  -- evita guardar metade do registro fiscal.
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
  if v_cpf is not null and exists (
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

-- A assinatura antiga foi DROPpada e esta nasce nova, entao o ACL volta ao
-- default do schema: EXECUTE para PUBLIC, que inclui anon e authenticated.
-- Sem estas duas linhas a driver_register fica chamavel direto pelo navegador
-- entre a aplicacao desta migration e a execucao do close-function-exec.sql --
-- uma janela de bypass de autenticacao que nao precisa existir. O
-- close-function-exec.sql continua sendo obrigatorio no fim do modulo (Regra 4
-- do AGENTS.md), mas a migracao nao deve depender dele para nao expor nada.
revoke execute on function public.driver_register(uuid, text, text, text, uuid, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.driver_register(uuid, text, text, text, uuid, text, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- 5) A empresa ve CPF, CNPJ e razao social na revisao
-- -----------------------------------------------------------------------------
-- driver_list_for_business alimenta a aba Motoristas, que e onde a empresa
-- confere o documento antes de aprovar. Sem cnpj/cpf ali, o dado seria coletado
-- e nunca confrontado com nada -- o cadastro do CNPJ nao valeria nada.
--
-- A decisao de exibir o CPF e do dono (LGPD: dado pessoal, escopo restrito ao
-- tenant e ao papel da empresa). Nao ha outro leitor: nem list_live_vehicles nem
-- driver_shuttle_runs selecionam estes campos, entao o CPF nao vaza para o
-- cliente nem para a agenda de corridas.
-- -----------------------------------------------------------------------------
drop function if exists public.driver_list_for_business(uuid, uuid, text);

create or replace function public.driver_list_for_business(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_status text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
begin
  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'driverId', d.id,
      'name', d.name,
      'phone', d.phone,
      'email', d.email,
      'cpf', d.cpf,
      'cnpj', d.cnpj,
      'legalName', d.legal_name,
      'status', d.status,
      'businessId', d.business_id,
      'createdAt', d.created_at,
      'approvedAt', d.approved_at,
      'documents', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', dd.id,
          'docType', dd.doc_type,
          'status', dd.status,
          'reviewedAt', dd.reviewed_at
        ) order by dd.created_at), '[]'::jsonb)
        from driver_documents dd where dd.driver_id = d.id
      )
    ) order by d.created_at desc)
    from drivers d
    where d.tenant_id = p_tenant_id
      and (p_status is null or d.status = p_status)
      -- SUPER_ADMIN ve todos; empresa ve os proprios e os independentes
      and (
        v_actor.role = 'SUPER_ADMIN'
        or d.business_id is null
        or d.business_id = v_actor.business_id
      )
  ), '[]'::jsonb);
end $function$
;

-- Mesma razao do driver_register acima, e aqui o pior caso e maior: esta funcao
-- devolve nome, telefone, e-mail, CPF e CNPJ de todos os motoristas do tenant.
-- DROP + CREATE zera o ACL e a reabre para PUBLIC -- que inclui anon -- ate o
-- close-function-exec.sql rodar. Uma function de dados pessoais aberta para anon
-- e leitura direta da tabela via PostgREST, nao um detalhe teorico.
revoke execute on function public.driver_list_for_business(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.driver_list_for_business(uuid, uuid, text) to service_role;