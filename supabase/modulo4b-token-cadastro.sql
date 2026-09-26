-- ============================================================================
-- modulo4b-token-cadastro.sql
--
-- Fecha os dois caminhos de ataque do modulo 4 e adiciona convite de empresa.
--
-- PROBLEMAS QUE ESTE ARQUIVO CORRIGE
-- -----------------------------------
-- 1) driver_set_pin(tenant, phone, pin) nao exigia sessao nem token nem
--    checava status. Quem soubesse tenant_id + telefone de um motorista
--    APROVADO sobrescrevia o PIN e entrava na conta (tomada de conta).
--
-- 2) driver_add_document(..., p_session_token) com p_session_token NULO pulava
--    o bloco de autenticacao inteiro e anexava documento em qualquer
--    driver_id. Pior: ao reenviar, o status de um motorista 'approved' voltava
--    para 'pending' (modulo4-motoristas.sql:351), entao o atacante rebaixava
--    um motorista real e ainda injetava um documento falso para a empresa
--    revisar.
--
-- DECISAO DE PRODUTO (usuario, 2026-09-25)
-- ---------------------------------------
-- Convite da empresa + auto-cadastro com token. O convite e OPCIONAL: o
-- auto-cadastro continua existindo, protegido por token de posse e rate limit.
--
-- O QUE ISTO NAO PROVE
-- --------------------
-- Sem SMS nao da para provar que o telefone pertence a quem cadastrou. Quem
-- registrar primeiro fica com o numero. O que este arquivo garante e a
-- propriedade que importa: o token so e emitido na CRIACAO da linha, entao
-- NAO serve para sequestrar um motorista que ja existe. A aprovacao humana
-- da empresa continua sendo o portao de entrada.
--
-- REGRA 4 DO AGENTS.md: este arquivo cria e recria funcoes, e DROP+CREATE zera
-- o ACL (a funcao nasce com EXECUTE para PUBLIC, e anon e membro de PUBLIC).
-- As revogacoes estao no fim do arquivo, mas rode supabase/close-function-exec.sql
-- depois de aplicar e confirme app_ainda_abertas = 0.
-- ============================================================================


-- ============================================================================
-- 1) TABELA: convite de empresa
-- ============================================================================
create table if not exists public.business_invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  code        text not null,
  max_uses    integer not null default 1,
  uses        integer not null default 0,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create unique index if not exists business_invites_tenant_code_uniq
  on public.business_invites (tenant_id, code);
create index if not exists business_invites_lookup_idx
  on public.business_invites (tenant_id, code)
  where revoked_at is null;

comment on table public.business_invites is
  'Codigo de convite de cadastro de motorista, gerado pela empresa. max_uses limita quantos cadastros ele libera.';

-- ============================================================================
-- 2) TABELA: token de posse do cadastro
-- ----------------------------------------------------------------------------
-- Guarda somente o HASH do token (sha256). O valor cru so existe na resposta
-- da RPC driver_register, uma vez. sha256 e adequado aqui porque o token tem
-- 256 bits de entropia (nao e senha de usuario, entao nao precisa de bcrypt).
-- ============================================================================
create table if not exists public.driver_registration_tokens (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  driver_id  uuid not null references public.drivers(id) on delete cascade,
  purpose    text not null,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint driver_registration_tokens_purpose_ck
    check (purpose in ('pin', 'upload'))
);

create unique index if not exists driver_registration_tokens_hash_uniq
  on public.driver_registration_tokens (token_hash);
create index if not exists driver_registration_tokens_driver_idx
  on public.driver_registration_tokens (driver_id, purpose);

comment on table public.driver_registration_tokens is
  'Token de posse emitido no cadastro. purpose=pin define o PIN; purpose=upload anexa documentos. Valido apenas enquanto o motorista esta pending/rejected.';

-- RLS ligado, sem policy: acesso somente por service_role, como o resto do
-- modulo 4. Sem policy, anon nao le nem escreve.
alter table public.business_invites enable row level security;
alter table public.driver_registration_tokens enable row level security;


-- ============================================================================
-- 3) business_generate_invite - a empresa gera o codigo
-- ----------------------------------------------------------------------------
-- Ator vem por parametro, mas validado: precisa existir no tenant, estar
-- ativo, ter role de empresa/admin e estar ligado a uma empresa do tenant.
-- Nao confiar em userId vindo do cliente (Regra 3 / IDOR).
-- ============================================================================
create or replace function public.business_generate_invite(
  p_tenant_id     uuid,
  p_actor_user_id uuid,
  p_max_uses      integer default 1,
  p_expires_hours integer default 72
)
 returns jsonb
 language plpgsql
 security definer set search_path = public, extensions
as $function$
declare
  v_actor   public.users%rowtype;
  v_code    text;
  v_expires timestamptz;
begin
  if p_max_uses is null or p_max_uses < 1 or p_max_uses > 100 then
    raise exception 'INVITE_MAX_USES_INVALID';
  end if;
  if p_expires_hours is null or p_expires_hours < 1 or p_expires_hours > 720 then
    raise exception 'INVITE_EXPIRES_INVALID';
  end if;

  select * into v_actor from public.users
  where id = p_actor_user_id and tenant_id = p_tenant_id;

  if not found then raise exception 'FORBIDDEN'; end if;
  if not coalesce(v_actor.is_active, false) then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT', 'ADMIN', 'STAFF', 'SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;
  if v_actor.business_id is null or not exists (
    select 1 from public.businesses
    where id = v_actor.business_id and tenant_id = p_tenant_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  v_code     := upper(encode(gen_random_bytes(6), 'hex'));
  v_expires  := now() + make_interval(hours => p_expires_hours);

  insert into public.business_invites
    (tenant_id, business_id, code, max_uses, expires_at, created_by)
  values
    (p_tenant_id, v_actor.business_id, v_code, p_max_uses, v_expires, p_actor_user_id);

  return jsonb_build_object(
    'code', v_code,
    'businessId', v_actor.business_id,
    'maxUses', p_max_uses,
    'expiresAt', v_expires
  );
end
$function$
;


-- ============================================================================
-- 4) driver_register - agora devolve os tokens de posse
-- ----------------------------------------------------------------------------
-- Rate limit por tenant: 20 cadastros/hora. Sem isso, o endpoint publico seria
-- um vetor de spam de linhas pending.
-- ============================================================================
drop function if exists public.driver_register(uuid, text, text, text, uuid);

create or replace function public.driver_register(
  p_tenant_id   uuid,
  p_name        text,
  p_phone       text,
  p_email       text,
  p_business_id uuid   default null,
  p_invite_code text   default null
)
 returns jsonb
 language plpgsql
 security definer set search_path = public, extensions
as $function$
declare
  v_phone        text;
  v_email        text;
  v_driver_id    uuid;
  v_invite       public.business_invites%rowtype;
  v_business_id  uuid;
  v_pin_token    text;
  v_upload_token text;
  v_recent       integer;
begin
  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_email := lower(trim(coalesce(p_email, '')));
  if p_name is null or btrim(p_name) = '' then raise exception 'NAME_REQUIRED'; end if;
  if length(v_phone) < 10 then raise exception 'PHONE_INVALID'; end if;
  if v_email not like '%@%' then raise exception 'EMAIL_INVALID'; end if;
  if length(v_phone) > 15 then raise exception 'PHONE_INVALID'; end if;
  if length(btrim(p_name)) > 120 then raise exception 'NAME_TOO_LONG'; end if;

  -- rate limit por tenant (nao por IP: o endpoint ve o IP na borda, nao aqui)
  select count(*) into v_recent
  from public.drivers
  where tenant_id = p_tenant_id
    and created_at > now() - interval '1 hour';
  if v_recent >= 20 then raise exception 'REGISTRATION_RATE_LIMITED'; end if;

  -- telefone ja cadastrado no tenant? nao cria duplicado
  if exists (
    select 1 from public.drivers
    where tenant_id = p_tenant_id
      and regexp_replace(phone, '\D', '', 'g') = v_phone
  ) then
    raise exception 'PHONE_ALREADY_REGISTERED';
  end if;

  if exists (
    select 1 from public.drivers where tenant_id = p_tenant_id and lower(email) = v_email
  ) then
    raise exception 'EMAIL_ALREADY_REGISTERED';
  end if;

  -- convite: opcional, mas se veio tem que ser valido
  v_business_id := p_business_id;
  if p_invite_code is not null and btrim(p_invite_code) <> '' then
    select * into v_invite
    from public.business_invites
    where tenant_id = p_tenant_id
      and code = upper(btrim(p_invite_code))
    for update;

    if not found then raise exception 'INVITE_INVALID'; end if;
    if v_invite.revoked_at is not null then raise exception 'INVITE_INVALID'; end if;
    if v_invite.expires_at is not null and v_invite.expires_at <= now() then
      raise exception 'INVITE_EXPIRED';
    end if;
    if v_invite.uses >= v_invite.max_uses then raise exception 'INVITE_EXHAUSTED'; end if;

    -- convite de empresa vincula o motorista a ela
    if v_invite.business_id is not null then
      if p_business_id is not null and p_business_id <> v_invite.business_id then
        raise exception 'INVITE_BUSINESS_MISMATCH';
      end if;
      v_business_id := v_invite.business_id;
    end if;
  end if;

  -- empresa parceira tem que ser do mesmo tenant
  if v_business_id is not null then
    if not exists (
      select 1 from public.businesses where id = v_business_id and tenant_id = p_tenant_id
    ) then
      raise exception 'BUSINESS_NOT_FOUND';
    end if;
  end if;

  insert into public.drivers (tenant_id, name, phone, email, business_id, status)
  values (p_tenant_id, btrim(p_name), v_phone, v_email, v_business_id, 'pending')
  returning id into v_driver_id;

  -- token de PIN: 2h. Token de upload: 24h. Ambos valem enquanto o motorista
  -- estiver pending/rejected (a checagem fica nas funcoes consumidoras).
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
end
$function$
;


-- ============================================================================
-- 5) driver_set_pin - agora EXIGE o token de posse
-- ----------------------------------------------------------------------------
-- O token e valido apenas enquanto o motorista nao foi aprovado. Apos a
-- aprovacao, o status sai de pending/rejected e o token morre junto, entao
-- nao da para redefinir o PIN de um motorista ativo.
--
-- O token nao e de uso unico: o motorista precisa poder corrigir o PIN durante
-- a montagem do cadastro (e uma exception faz rollback de tudo, entao PIN
-- invalido nao queima o token). O que protege e a janela + o status.
-- ============================================================================
drop function if exists public.driver_set_pin(uuid, text, text);

create or replace function public.driver_set_pin(
  p_tenant_id uuid,
  p_phone     text,
  p_pin       text,
  p_pin_token text
)
 returns jsonb
 language plpgsql
 security definer set search_path = public, extensions
as $function$
declare
  v_driver public.drivers%rowtype;
begin
  if p_pin is null or not (p_pin ~ '^[0-9]{4,8}$') then
    raise exception 'PIN_INVALID: use de 4 a 8 digitos';
  end if;

  select * into v_driver
  from public.drivers
  where tenant_id = p_tenant_id
    and regexp_replace(phone, '\D', '', 'g') = regexp_replace(coalesce(p_phone,''), '\D', '', 'g');

  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;

  -- sem token nao ha como provar posse deste cadastro
  if p_pin_token is null or btrim(p_pin_token) = '' then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not exists (
    select 1 from public.driver_registration_tokens t
    where t.driver_id = v_driver.id
      and t.purpose = 'pin'
      and t.token_hash = encode(digest(btrim(p_pin_token), 'sha256'), 'hex')
      and t.expires_at > now()
  ) then
    raise exception 'TOKEN_INVALID';
  end if;

  -- porte da aprovacao: com o status aprovado, o token de setup nao vale mais
  if v_driver.status not in ('pending', 'rejected') then
    raise exception 'TOKEN_INVALID';
  end if;

  update public.drivers
  set pin_hash = crypt(p_pin, gen_salt('bf')),
      pin_updated_at = now(),
      updated_at = now()
  where id = v_driver.id;

  return jsonb_build_object('ok', true, 'driverId', v_driver.id);
end
$function$
;


-- ============================================================================
-- 6) driver_add_document - sessao OU token de upload, nunca os dois nulos
-- ----------------------------------------------------------------------------
-- O caminho "sessao nula passava" foi removido. E a checagem de status impede
-- que um token de setup continue anexando depois da aprovacao: com o status
-- aprovado, o motorista so anexa usando a sessao do login.
-- ============================================================================
drop function if exists public.driver_add_document(uuid, uuid, text, text, text, date, uuid);

create or replace function public.driver_add_document(
  p_tenant_id      uuid,
  p_driver_id      uuid,
  p_doc_type       text,
  p_doc_url        text,
  p_doc_number     text default null,
  p_doc_expires_at date default null,
  p_session_token  uuid default null,
  p_upload_token   text default null
)
 returns jsonb
 language plpgsql
 security definer set search_path = public, extensions
as $function$
declare
  v_driver public.drivers%rowtype;
  v_doc_id uuid;
begin
  if p_doc_type not in ('cnh', 'rg', 'crv') then raise exception 'DOC_TYPE_INVALID'; end if;
  if p_doc_url is null or btrim(p_doc_url) = '' then raise exception 'DOC_URL_REQUIRED'; end if;
  if length(p_doc_url) > 500 then raise exception 'DOC_URL_TOO_LONG'; end if;

  if p_session_token is not null then
    -- caminho autenticado: sessao valida do DONO do cadastro
    select * into v_driver from public.drivers
    where id = p_driver_id and tenant_id = p_tenant_id
      and exists (
        select 1 from public.driver_sessions s
        where s.token = p_session_token and s.driver_id = p_driver_id and s.expires_at > now()
      );
    if not found then raise exception 'FORBIDDEN'; end if;

  elsif p_upload_token is not null and btrim(p_upload_token) <> '' then
    -- caminho de setup: token de posse emitido no cadastro
    select * into v_driver from public.drivers
    where id = p_driver_id and tenant_id = p_tenant_id
      and status in ('pending', 'rejected')
      and exists (
        select 1 from public.driver_registration_tokens t
        where t.driver_id = p_driver_id
          and t.purpose = 'upload'
          and t.token_hash = encode(digest(btrim(p_upload_token), 'sha256'), 'hex')
          and t.expires_at > now()
      );
    if not found then raise exception 'FORBIDDEN'; end if;

  else
    -- antes, p_session_token nulo pulava a autenticacao inteira
    raise exception 'AUTH_REQUIRED';
  end if;

  delete from public.driver_documents where driver_id = p_driver_id and doc_type = p_doc_type;

  insert into public.driver_documents (tenant_id, driver_id, doc_type, doc_url, doc_number, doc_expires_at, status)
  values (p_tenant_id, p_driver_id, p_doc_type, btrim(p_doc_url), nullif(trim(coalesce(p_doc_number,'')),''), p_doc_expires_at, 'pending')
  returning id into v_doc_id;

  update public.drivers
  set status = case when status = 'approved' then 'pending' else status end,
      updated_at = now()
  where id = p_driver_id;

  return jsonb_build_object('documentId', v_doc_id, 'status', 'pending');
end
$function$
;


-- ============================================================================
-- 7) Revogacao imediata (Regra 4 do AGENTS.md)
-- ----------------------------------------------------------------------------
-- As tres funcoes acima foram DROP+CREATE, entao nasceram com EXECUTE para
-- PUBLIC. Revogando aqui para que o arquivo nunca deixe funcao aberta, mesmo
-- se o close-function-exec.sql for esquecido.
-- ============================================================================
revoke execute on function public.driver_register(uuid, text, text, text, uuid, text)          from public;
revoke execute on function public.driver_set_pin(uuid, text, text, text)                        from public;
revoke execute on function public.driver_add_document(uuid, uuid, text, text, text, date, uuid, text) from public;
revoke execute on function public.business_generate_invite(uuid, uuid, integer, integer)         from public;

revoke execute on function public.driver_register(uuid, text, text, text, uuid, text)          from anon;
revoke execute on function public.driver_set_pin(uuid, text, text, text)                        from anon;
revoke execute on function public.driver_add_document(uuid, uuid, text, text, text, date, uuid, text) from anon;
revoke execute on function public.business_generate_invite(uuid, uuid, integer, integer)         from anon;

revoke execute on function public.driver_register(uuid, text, text, text, uuid, text)          from authenticated;
revoke execute on function public.driver_set_pin(uuid, text, text, text)                        from authenticated;
revoke execute on function public.driver_add_document(uuid, uuid, text, text, text, date, uuid, text) from authenticated;
revoke execute on function public.business_generate_invite(uuid, uuid, integer, integer)         from authenticated;

grant execute on function public.driver_register(uuid, text, text, text, uuid, text)          to service_role;
grant execute on function public.driver_set_pin(uuid, text, text, text)                        to service_role;
grant execute on function public.driver_add_document(uuid, uuid, text, text, text, date, uuid, text) to service_role;
grant execute on function public.business_generate_invite(uuid, uuid, integer, integer)         to service_role;


-- ============================================================================
-- 8) Verificacao: app_ainda_abertas tem que ser 0
-- ============================================================================
select
  count(*) filter (where e.extname is null) as funcs_app,
  count(*) filter (where e.extname is null and exists (
    select 1 from aclexplode(coalesce(p.proacl,'{}'::aclitem[])) x
    where x.privilege_type = 'EXECUTE'
      and x.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)
  )) as app_ainda_abertas
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
left join pg_extension e on e.oid = d.refobjid
where n.nspname = 'public' and p.prokind = 'f';


-- ============================================================================
-- 9) COMO O ENDPOINT DEVE CHAMAR (fatia 2)
-- ----------------------------------------------------------------------------
-- ATENCAO: as assinaturas antigas foram DROPPED, nao sobrescritas. Chamar
-- driver_set_pin com 3 argumentos devolve "function does not exist", e nao um
-- erro de validacao. Isso e o desejado (o ponto de entrada do sequestro deixa
-- de existir), mas significa que o endpoint NUNCA pode ter caminho de fallback
-- sem token. Se o token faltar, a chamada tem que falhar, nao degradar.
--
--   driver_register(tenant, nome, telefone, email, business_id?, inviteCode?)
--     -> { driverId, status, pinToken, uploadToken, message }
--        pinToken/uploadToken: devolver ao cliente e descartar. So o sha256 fica no banco.
--        Nunca logar esses valores.
--
--   driver_set_pin(tenant, telefone, pin, pinToken)
--     -> { ok, driverId }
--        4 argumentos sempre. pinToken e o pinToken devolvido no register.
--
--   driver_add_document(tenant, driverId, tipo, url, numero?, validade?, sessionToken?, uploadToken?)
--     -> { documentId, status }
--        Exatamente um dos dois: sessionToken (motorista logado) OU uploadToken
--        (montagem do cadastro). Nunca os dois nulos, nunca os dois juntos.
--
--   business_generate_invite(tenant, atorUserId, maxUses?, expiraHoras?)
--     -> { code, businessId, maxUses, expiresAt }
--        atorUserId tem de vir da sessao autenticada da empresa no servidor,
--        nunca do corpo da requisicao (Regra 3 / IDOR).
--
-- Pin trocado com sucesso deixa de exigir token: da proxima vez o caminho e
-- driver_login(tenant, telefone, pin), que so libera sessao com status approved.
--
-- ============================================================================
-- 10) EVIDENCIA DE TESTE (2026-09-25)
-- ----------------------------------------------------------------------------
-- Rodado em transacao com ROLLBACK, 26 asercoes, todas verdes. Produção
-- confirmada intacta depois do teste (funcao antiga presente, 0 tabelas novas,
-- 0 residuo de QA, 0 funcoes do app abertas).
--
--   T01 register devolve pinToken + uploadToken, status pending
--   T02 telefone ja cadastrado no tenant -> PHONE_ALREADY_REGISTERED
--   T03a assinatura antiga de 3 args -> "does not exist" (hijack sem porta de entrada)
--   T03b token NULL explicito  -> AUTH_REQUIRED
--   T03c token em branco       -> AUTH_REQUIRED
--   T03d token do driver A nao abre o driver B -> TOKEN_INVALID
--   T03e driver B continua sem pin_hash apos a tentativa
--   T03f telefone inexistente  -> DRIVER_NOT_FOUND
--   T04 token errado           -> TOKEN_INVALID
--   T05 token correto          -> pin gravado e confere via crypt()
--   T06 PIN de 3 digitos       -> PIN_INVALID
--   T07 documento sem sessao e sem token -> AUTH_REQUIRED  (ataque #2 fechado)
--   T08 documento com uploadToken        -> criado, status pending
--   T09 uploadToken nao transfere entre drivers -> FORBIDDEN
--   T10 empresa aprova via driver_review_document
--   T11 apos aprovar, o pinToken nao redefine mais o PIN -> TOKEN_INVALID  (anti-hijack)
--   T12 apos aprovar, uploadToken nao anexa mais -> FORBIDDEN
--   T14 MERCHANT gera convite de 12 chars hex
--   T15 CUSTOMER nao gera convite -> FORBIDDEN
--   T16 cadastro com convite herda business_id da empresa que convidou
--   T17 convite inexistente  -> INVITE_INVALID
--   T18 convite esgotado     -> INVITE_EXHAUSTED
--   T19 rate limit barra exatamente no 20o cadastro/hora/tenant
--   T20 0 das 4 funcoes com EXECUTE para anon/authenticated/PUBLIC
--   T21 RLS ligado e 0 policies nas 2 tabelas novas
--   T22 apenas sha256 gravado, token cru nunca aparece no banco
-- ============================================================================
