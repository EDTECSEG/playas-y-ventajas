-- ============================================================
-- Playas y Ventajas - Modulo 4: Login e habilitacao de motoristas
-- ------------------------------------------------------------
-- RODE DEPOIS do modulo1-motoristas-translado-proximity.sql.
-- Idempotente: pode rodar varias vezes.
--
-- POR QUE PIN E NAO OTP DE EMAIL
-- O dono decidiu que a comunicacao com o cliente e por WhatsApp, nao por
-- email (o Resend esta em modo de teste e so entrega para o titular da
-- conta). Se o login do motorista dependesse de email, nenhum motorista
-- real conseguiria entrar: o OTP nunca chegaria.
-- Entao o login aqui e TELEFONE + PIN, que nao depende de nenhum servico
-- externo:
--   - o proprio motorista define o PIN no cadastro;
--   - a empresa aprova os documentos e habilita o cadastro;
--   - esquecimento de PIN e resolvido pela empresa (admin_driver_reset_pin).
-- O padrao de sessao e o mesmo do login da empresa (tabela sessions +
-- token), mas em tabela propria (driver_sessions) porque motorista NAO e
-- um users: e uma identidade propria, com regras proprias.
--
-- Seguranca:
--   - PIN guardado com bcrypt (crypt do pgcrypto), nunca em texto;
--   - bloqueio por tentativas reaproveitando login_attempts (mesmo
--     mecanismo do login da empresa);
--   - so entra quem tem status 'approved' â€” documento reprovado nao entra.
-- ============================================================

-- ------------------------------------------------------------
-- 1) PIN do motorista
-- ------------------------------------------------------------
-- crypt/gen_salt vem do pgcrypto (bcrypt do PIN). IF NOT EXISTS: se o
-- modulo1 ja criou, aqui e no-op.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS pin_updated_at timestamptz;

-- ------------------------------------------------------------
-- 2) Sessoes do motorista
-- ------------------------------------------------------------
ALTER TABLE public.driver_documents
  ADD COLUMN IF NOT EXISTS review_note text;

CREATE TABLE IF NOT EXISTS public.driver_sessions (
  token       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS driver_sessions_driver_idx
  ON public.driver_sessions (driver_id);
CREATE INDEX IF NOT EXISTS driver_sessions_expires_idx
  ON public.driver_sessions (expires_at);

ALTER TABLE public.driver_sessions ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 3) driver_register - cadastro publico do motorista
-- ------------------------------------------------------------
-- Cria o cadastro com status 'pending'. NAO cria sessao: sem aprovacao da
-- empresa o motorista nao consegue nem entrar na area dele.
-- O PIN e definido logo em seguida por driver_set_pin.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.driver_register(uuid, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.driver_register(
  p_tenant_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_business_id uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_phone text;
  v_email text;
  v_driver_id uuid;
begin
  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_email := lower(trim(coalesce(p_email, '')));
  if p_name is null or btrim(p_name) = '' then raise exception 'NAME_REQUIRED'; end if;
  if length(v_phone) < 10 then raise exception 'PHONE_INVALID'; end if;
  if v_email not like '%@%' then raise exception 'EMAIL_INVALID'; end if;

  -- telefone ja cadastrado no tenant? nao cria duplicado
  if exists (select 1 from drivers where tenant_id = p_tenant_id and regexp_replace(phone,'\D','','g') = v_phone) then
    raise exception 'PHONE_ALREADY_REGISTERED';
  end if;

  -- email tambem e unico por tenant (drivers_tenant_email_uniq). Verificamos
  -- aqui para devolver erro legivel em vez de deixar a constraint estourar
  -- com 'duplicate key value violates unique constraint'.
  if exists (select 1 from drivers where tenant_id = p_tenant_id and lower(email) = v_email) then
    raise exception 'EMAIL_ALREADY_REGISTERED';
  end if;

  -- empresa parceira tem que ser do mesmo tenant
  if p_business_id is not null then
    if not exists (select 1 from businesses where id = p_business_id and tenant_id = p_tenant_id) then
      raise exception 'BUSINESS_NOT_FOUND';
    end if;
  end if;

  insert into drivers (tenant_id, name, phone, email, business_id, status)
  values (p_tenant_id, btrim(p_name), v_phone, v_email, p_business_id, 'pending')
  returning id into v_driver_id;

  return jsonb_build_object(
    'driverId', v_driver_id,
    'status', 'pending',
    'message', 'Cadastro criado. Envie seus documentos e aguarde a aprovacao da empresa.'
  );
end $function$
;

-- ------------------------------------------------------------
-- 4) driver_set_pin - o proprio motorista define o PIN
-- ------------------------------------------------------------
-- Roda no cadastro (ainda pending) e na troca de PIN. Guardamos o hash
-- bcrypt, entao nao existe caminho de leitura do PIN no banco.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.driver_set_pin(uuid, text, text);

CREATE OR REPLACE FUNCTION public.driver_set_pin(
  p_tenant_id uuid,
  p_phone text,
  p_pin text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_driver drivers%rowtype;
begin
  if p_pin is null or not (p_pin ~ '^[0-9]{4,8}$') then
    raise exception 'PIN_INVALID: use de 4 a 8 digitos';
  end if;

  select * into v_driver
  from drivers
  where tenant_id = p_tenant_id
    and regexp_replace(phone, '\D', '', 'g') = regexp_replace(coalesce(p_phone,''), '\D', '', 'g');

  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;

  update drivers
  set pin_hash = crypt(p_pin, gen_salt('bf')),
      pin_updated_at = now(),
      updated_at = now()
  where id = v_driver.id;

  return jsonb_build_object('ok', true, 'driverId', v_driver.id);
end $function$
;

-- ------------------------------------------------------------
-- 5) driver_login - telefone + PIN
-- ------------------------------------------------------------
-- So aprova quem tem status 'approved'. Reproveita login_attempts para
-- travar forca bruta (mesmo chave/padrao do login da empresa).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.driver_login(uuid, text, text);

CREATE OR REPLACE FUNCTION public.driver_login(
  p_tenant_id uuid,
  p_phone text,
  p_pin text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_phone text;
  v_driver drivers%rowtype;
  v_token uuid;
  v_attempt login_attempts%rowtype;
begin
  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if v_phone = '' or p_pin is null then
    return jsonb_build_object('error', 'CREDENTIALS_REQUIRED');
  end if;

  -- bloqueio por tentativas (chave = telefone)
  select * into v_attempt
  from login_attempts
  where tenant_id = p_tenant_id and internal_code = v_phone
  for update;
  if found and v_attempt.locked_until is not null and v_attempt.locked_until > now() then
    return jsonb_build_object('error', 'ACCOUNT_LOCKED');
  end if;

  select * into v_driver
  from drivers
  where tenant_id = p_tenant_id
    and regexp_replace(phone, '\D', '', 'g') = v_phone;

  if not found then
    -- nao diga se o telefone existe: mesma resposta para telefone errado
    -- e senha errada, para nao vazar cadastro.
    return jsonb_build_object('error', 'INVALID_CREDENTIALS');
  end if;

  -- confere o PIN (bcrypt). Mesma resposta para PIN errado e nao definido.
  if v_driver.pin_hash is null or crypt(p_pin, v_driver.pin_hash) <> v_driver.pin_hash then
    -- Registra a tentativa. Colunas e indice reais de login_attempts:
    -- (tenant_id, internal_code, fail_count, locked_until) — ver
    -- security-hardening.sql. NAO existe col updated_at nesta tabela.
    --
    -- 5 falhas => 15 min de bloqueio.mais duro que os 5 min do auth_login
    -- porque um PIN de 4-8 digitos e adivinhavel por forca bruta; o login
    -- interno (internal_code) e longo. Reinicio de PIN e feito pela
    -- empresa (admin_driver_reset_pin), entao o usuario nunca fica preso.
    insert into login_attempts (tenant_id, internal_code, fail_count, locked_until)
    values (p_tenant_id, v_phone, 1, null)
    on conflict (tenant_id, internal_code) do update
      set fail_count = login_attempts.fail_count + 1,
          locked_until = case
            when login_attempts.fail_count + 1 >= 5
              then now() + interval '15 minutes'
            else login_attempts.locked_until
          end;
    return jsonb_build_object('error', 'INVALID_CREDENTIALS');
  end if;

  -- PIN certo, mas cadastro nao liberado
  if v_driver.status <> 'approved' then
    return jsonb_build_object('error',
      case v_driver.status
        when 'pending'   then 'PENDING_APPROVAL'
        when 'rejected'  then 'REGISTRATION_REJECTED'
        when 'suspended' then 'ACCOUNT_SUSPENDED'
        else 'NOT_APPROVED'
      end,
      'status', v_driver.status
    );
  end if;

  -- login ok: limpa tentativas e emite sessao
  delete from login_attempts where tenant_id = p_tenant_id and internal_code = v_phone;

  insert into driver_sessions (driver_id, tenant_id)
  values (v_driver.id, p_tenant_id)
  returning token into v_token;

  return jsonb_build_object(
    'sessionToken', v_token,
    'driverId', v_driver.id,
    'tenantId', p_tenant_id,
    'name', v_driver.name,
    'phone', v_driver.phone,
    'businessId', v_driver.business_id,
    'status', v_driver.status
  );
end $function$
;

-- ------------------------------------------------------------
-- 6) driver_verify_session / driver_logout
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.driver_verify_session(uuid);

CREATE OR REPLACE FUNCTION public.driver_verify_session(p_session_token uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select case when d.id is null then null else jsonb_build_object(
    'driverId', d.id,
    'tenantId', d.tenant_id,
    'name', d.name,
    'phone', d.phone,
    'email', d.email,
    'businessId', d.business_id,
    'status', d.status
  ) end
  from driver_sessions s
  join drivers d on d.id = s.driver_id
  where s.token = p_session_token
    and s.expires_at > now()
    and d.status = 'approved'
  limit 1;
$function$
;

DROP FUNCTION IF EXISTS public.driver_logout(uuid);

CREATE OR REPLACE FUNCTION public.driver_logout(p_session_token uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
  delete from driver_sessions where token = p_session_token;
$function$
;

-- ------------------------------------------------------------
-- 7) Documentos
-- ------------------------------------------------------------
-- 7a) motorista anexa documento
DROP FUNCTION IF EXISTS public.driver_add_document(uuid, text, text, text, date, uuid);

CREATE OR REPLACE FUNCTION public.driver_add_document(
  p_tenant_id uuid,
  p_driver_id uuid,
  p_doc_type text,
  p_doc_url text,
  p_doc_number text DEFAULT NULL,
  p_doc_expires_at date DEFAULT NULL,
  p_session_token uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_driver drivers%rowtype;
  v_doc_id uuid;
begin
  if p_doc_type not in ('cnh','rg','crv') then raise exception 'DOC_TYPE_INVALID'; end if;
  if p_doc_url is null or btrim(p_doc_url) = '' then raise exception 'DOC_URL_REQUIRED'; end if;

  -- se veio sessao, o motorista so anexa em nome proprio
  if p_session_token is not null then
    select * into v_driver from drivers
    where id = p_driver_id and tenant_id = p_tenant_id
      and exists (select 1 from driver_sessions s where s.token = p_session_token and s.driver_id = p_driver_id and s.expires_at > now());
    if not found then raise exception 'FORBIDDEN'; end if;
  else
    select * into v_driver from drivers where id = p_driver_id and tenant_id = p_tenant_id;
    if not found then raise exception 'DRIVER_NOT_FOUND'; end if;
  end if;

  -- um documento por tipo: reenvio substitui o anterior (historico fica
  -- no log de revisao, nao em outra linha, para nao duplicar pendencia)
  delete from driver_documents where driver_id = p_driver_id and doc_type = p_doc_type;

  insert into driver_documents (tenant_id, driver_id, doc_type, doc_url, doc_number, doc_expires_at, status)
  values (p_tenant_id, p_driver_id, p_doc_type, btrim(p_doc_url), nullif(trim(coalesce(p_doc_number,'')),''), p_doc_expires_at, 'pending')
  returning id into v_doc_id;

  -- se ja estava aprovado e o motorista reenviou, volta para pendente
  update drivers
  set status = case when status = 'approved' then 'pending' else status end,
      updated_at = now()
  where id = p_driver_id;

  return jsonb_build_object('documentId', v_doc_id, 'status', 'pending');
end $function$
;

-- 7b) listar documentos do proprio motorista
-- Exige sessao valida do DONO do cadastro. Nao ha caminho para listar
-- documentos de outro motorista por esta RPC (a visao da empresa, que ve
-- varios, e a driver_list_for_business e valida o ator).
DROP FUNCTION IF EXISTS public.driver_list_documents(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.driver_list_documents(
  p_tenant_id uuid,
  p_driver_id uuid,
  p_session_token uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  if p_session_token is null or not exists (
    select 1 from driver_sessions s
    where s.token = p_session_token
      and s.driver_id = p_driver_id
      and s.tenant_id = p_tenant_id
      and s.expires_at > now()
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', dd.id,
      'docType', dd.doc_type,
      'status', dd.status,
      'docNumber', dd.doc_number,
      'expiresAt', dd.doc_expires_at,
      'reviewedAt', dd.reviewed_at,
      'createdAt', dd.created_at
    ) order by dd.created_at)
    from driver_documents dd
    where dd.tenant_id = p_tenant_id and dd.driver_id = p_driver_id
  ), '[]'::jsonb);
end $function$
;

-- ------------------------------------------------------------
-- 8) Empresa/admin revisa documento e habilita o motorista
-- ------------------------------------------------------------
-- Ator precisa ser dono do negocio do motorista (users.business_id igual ao
-- drivers.business_id) ou SUPER_ADMIN do mesmo tenant. Sem isso, qualquer
-- empresa poderia aprovar motorista de outra.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.driver_review_document(uuid, uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.driver_review_document(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_document_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
  v_doc driver_documents%rowtype;
  v_driver drivers%rowtype;
  v_pendentes int;
begin
  if p_action not in ('approve','reject') then raise exception 'ACTION_INVALID'; end if;

  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role <> 'SUPER_ADMIN'
     and (v_actor.business_id is null or v_actor.role not in ('MERCHANT','ADMIN','STAFF')) then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_doc from driver_documents where id = p_document_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND'; end if;

  select * into v_driver from drivers where id = v_doc.driver_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;

  -- empresa so pode revisar motorista do proprio negocio (ou sem empresa)
  if v_actor.role <> 'SUPER_ADMIN' and v_driver.business_id is not null
     and v_actor.business_id <> v_driver.business_id then
    raise exception 'FORBIDDEN: motorista de outra empresa';
  end if;

  -- a revisao muda o status e registra quem revisou; nao altera o numero
  -- nem a URL que o motorista enviou. p_reason guarda o motivo da
  -- reprovacao, que e o que a empresa precisa explicar ao motorista.
  update driver_documents
  set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
      reviewed_by = p_actor_user_id,
      reviewed_at = now(),
      review_note = case
        when p_action = 'reject' then nullif(trim(coalesce(p_reason, '')), '')
        else review_note
      end
  where id = p_document_id;

  -- conta documentos pendentes deste motorista
  select count(*) into v_pendentes
  from driver_documents
  where driver_id = v_driver.id and status = 'pending';

  -- se reprovou qualquer documento, o cadastro vai para 'rejected'
  if exists (select 1 from driver_documents where driver_id = v_driver.id and status = 'rejected') then
    update drivers set status = 'rejected', approved_at = null, updated_at = now() where id = v_driver.id;
  -- se nao ha mais pendencia e ha ao menos um aprovado, habilita
  elsif v_pendentes = 0
        and exists (select 1 from driver_documents where driver_id = v_driver.id and status = 'approved') then
    update drivers set status = 'approved', approved_at = coalesce(approved_at, now()), updated_at = now() where id = v_driver.id;
  end if;

  return jsonb_build_object(
    'documentId', p_document_id,
    'documentStatus', case when p_action = 'approve' then 'approved' else 'rejected' end,
    'driverStatus', (select status from drivers where id = v_driver.id)
  );
end $function$
;

-- ------------------------------------------------------------
-- 9) Reset de PIN pela empresa/admin
-- ------------------------------------------------------------
-- Sem isso, um motorista que esquece o PIN nao tem caminho de volta sem
-- email â€” que foi descartado como canal.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_driver_reset_pin(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.admin_driver_reset_pin(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_driver_id uuid,
  p_new_pin text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
  v_driver drivers%rowtype;
begin
  if p_new_pin is null or not (p_new_pin ~ '^[0-9]{4,8}$') then
    raise exception 'PIN_INVALID: use de 4 a 8 digitos';
  end if;

  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;

  select * into v_driver from drivers where id = p_driver_id and tenant_id = p_tenant_id;
  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;

  -- Mesma regra de escopo de driver_review_document / driver_list_for_business:
  -- SUPER_ADMIN ve todos; uma empresa gerencia os proprios motoristas E os
  -- independentes (business_id NULL). Sem essa excecao, a empresa que aprova
  -- um motorista independente nao conseguiria resetar o PIN dele — e, sem um
  -- SUPER_ADMIN no tenant, o motorista ficaria sem caminho para recuperar
  -- o acesso.
  if v_actor.role <> 'SUPER_ADMIN'
     and v_driver.business_id is not null
     and v_actor.business_id is distinct from v_driver.business_id then
    raise exception 'FORBIDDEN: so a empresa do motorista ou o admin';
  end if;

  update drivers
  set pin_hash = crypt(p_new_pin, gen_salt('bf')),
      pin_updated_at = now(),
      updated_at = now()
  where id = p_driver_id;

  -- derruba as sessoes: se o PIN vazou, o acesso antigo tem que cair
  delete from driver_sessions where driver_id = p_driver_id;

  return jsonb_build_object('ok', true, 'driverId', p_driver_id, 'sessionsRevoked', true);
end $function$
;

-- ------------------------------------------------------------
-- 10) Painel da empresa: motoristas e pendencias
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.driver_list_for_business(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.driver_list_for_business(
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

-- ------------------------------------------------------------
-- 11) Fim do Modulo 4
-- ------------------------------------------------------------
-- Fluxo completo:
--   1) POST /driver      { name, phone, email, businessId? }  -> driverRegister
--   2) POST /driver      { phone, pin }                       -> driverSetPin
--   3) POST /driver/documents  (upload)                       -> driverAddDocument
--   4) empresa: GET /driver?mode=pending  + review            -> aprova
--   5) POST /driver      { phone, pin }                       -> driverLogin
--      (so funciona se status = 'approved')
