-- ============================================================
-- Playas y Ventajas - Login/cadastro por EMAIL + OTP (Slice 1)
-- ============================================================
-- Objetivo (decisões do dono):
--   A1) Admin/dono da plataforma passa a entrar por EMAIL + código OTP
--       (igual o cliente), em vez de internalCode+pin.
--   B2) Empresa tem AUTO-CADASTRO aberto, mas o email do responsável
--       PRECISA ser validado por OTP (como todos os outros cadastros).
--   C)  Plano configurável por empresa: Free com CARÊNCIA (N meses, default 3)
--       -> vira Nível 1 automaticamente; ou é cancelado se a empresa quiser.
--
-- IMPORTANTE sobre o OTP:
--   O código é HMAC/HMAC-SHA256 gerado NO SERVIDOR (function `_otp.js`),
--   nunca no banco. Portanto este SQL NÃO valida código — a validação do OTP
--   acontece na Netlify function (`.netlify/functions/login-by-email`) e só
--   então ela chama o RPC abaixo, que emite a sessão. Isso espelha o padrão
--   já usado pelo identify.js (email + emailCode validado server-side).
--
-- Uso:
--   1) Rode este arquivo inteiro no SQL Editor do Supabase.
--   2) Deploy das functions `login-by-email.js` / `register-by-email.js`.
-- ============================================================

-- ------------------------------------------------------------
-- 1) auth_login_by_email — login de MERCHANT / ADMIN / SUPER_ADMIN
--    por email. Espelha auth_login: mesma tabela de sessões, mesmo shape
--    de retorno, mesmo bloqueio por tentativas (login_attempts).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_login_by_email(
  p_tenant_slug text,
  p_email text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_tenant       tenants%rowtype;
  v_user         users%rowtype;
  v_session_token uuid;
  v_attempt      login_attempts%rowtype;
  v_locked_reason text := null;
begin
  select * into v_tenant from tenants where slug = p_tenant_slug;
  if not found then return jsonb_build_object('error', 'TENANT_NOT_FOUND'); end if;

  -- Login por email ignora maiúsculas/minúsculas (mesmo critério do auth_login
  -- com internal_code).
  select * into v_user
    from users
   where tenant_id = v_tenant.id
     and lower(email) = lower(p_email);
  if not found then return jsonb_build_object('error', 'USER_NOT_FOUND'); end if;

  -- Role: este RPC é SÓ para empresa (a vencer nosso app) e admin da plataforma.
  if v_user.role not in ('MERCHANT', 'ADMIN', 'SUPER_ADMIN') then
    return jsonb_build_object('error', 'FORBIDDEN');
  end if;
  if not v_user.is_active then return jsonb_build_object('error', 'USER_DISABLED'); end if;

  -- Bloqueio por tentativas, chave = email (mesmo padrão de auth_login, mas
  -- usa o email como chave única de login_attempts).
  select * into v_attempt
    from login_attempts
   where tenant_id = v_tenant.id
     and internal_code = lower(p_email)
   for update;
  if found and v_attempt.locked_until is not null and v_attempt.locked_until > now() then
    return jsonb_build_object('error', 'ACCOUNT_LOCKED');
  end if;
  delete from login_attempts
   where tenant_id = v_tenant.id and internal_code = lower(p_email);

  -- Emite a MESMA sessão que auth_login emite (única forma de o
  -- auth_verify_session resolver o token por igual).
  insert into sessions (tenant_id, user_id)
  values (v_tenant.id, v_user.id)
  returning token into v_session_token;

  return jsonb_build_object(
    'sessionToken', v_session_token,
    'userId', v_user.id,
    'tenantId', v_tenant.id,
    'role', v_user.role,
    'businessId', v_user.business_id,
    'mustChangePin', coalesce(v_user.must_change_pin, false)
  );
end;
$function$;

-- ------------------------------------------------------------
-- 2) register_business_by_email — auto-cadastro aberto de empresa,
--    validando o email do responsável (o OTP foi conferido na function).
--    Espelha register_business (MERCHANT + businesses + owner), mas deriva
--    o internal_code a partir do email pra manter a unicidade e o login
--    antigo funcional pra quem já tinha conta.
-- ------------------------------------------------------------
-- (Atenção: register_business exige p_internal_code e p_pin. Aqui mantemos
--  esses campos para o schema continuar consistente, mas o que AUTENTICA o
--  dono passa a ser o email validado por OTP; internal_code é derivado.)
CREATE OR REPLACE FUNCTION public.register_business_by_email(
  p_tenant_slug text,
  p_name text,
  p_category text,
  p_city text,
  p_phone text,
  p_email text,
  p_cnpj text,
  p_website text,
  p_logo_url text,
  p_lat double precision,
  p_lng double precision,
  p_internal_code text,
  p_pin text,
  p_grace_months int default 3
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_tenant      tenants%rowtype;
  v_owner_id    uuid;
  v_business_id uuid;
  v_internal    text;
begin
  select * into v_tenant from tenants where slug = p_tenant_slug;
  if not found then return jsonb_build_object('error', 'TENANT_NOT_FOUND'); end if;
  if p_name is null or trim(p_name) = '' then return jsonb_build_object('error', 'INVALID_NAME'); end if;
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('error', 'INVALID_EMAIL');
  end if;
  if p_pin is null or length(p_pin) < 6 then return jsonb_build_object('error', 'WEAK_PIN: minimo de 6 caracteres'); end if;
  if not(coalesce(p_cnpj,'') ~ '^$') and p_cnpj !~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3}/[0-9]{4}-[0-9]{2}$|^[0-9]{14}$' then
    return jsonb_build_object('error', 'INVALID_CNPJ');
  end if;

  -- internal_code derivado do email (parte antes do @, limpa), com sufixo
  -- de unicidade. Garante NOT NULL/uniq sem exigir que o dono o invente.
  v_internal := coalesce(p_internal_code, '') ;
  if v_internal = '' then
    v_internal := lower(regexp_replace(split_part(p_email, '@', 1), '[^a-z0-9._-]', '', 'g'));
    v_internal := left(v_internal, 40);
    if v_internal = '' then v_internal := 'emp'; end if;
    -- unicidade: se já existir esse internal_code no tenant, apende sufixo.
    if exists(select 1 from users where tenant_id = v_tenant.id and internal_code = v_internal) then
      v_internal := v_internal || '_' || left(replace(v_tenant.slug,'.'||'', ''), 4)
                     || '_' || upper(substr(md5(random()::text), 1, 4));
    end if;
  elsif v_internal !~ '^[A-Za-z0-9._-]{2,64}$' then
    return jsonb_build_object('error', 'INVALID_CODE');
  end if;

  -- Cria o usuário dono (MERCHANT)
  insert into users (tenant_id, internal_code, role, pin_hash, name, phone, email)
  values (
    v_tenant.id, v_internal, 'MERCHANT',
    encode(digest(p_pin, 'sha256'), 'hex'),
    trim(p_name), p_phone, p_email
  )
  returning id into v_owner_id;

  -- Cria a empresa, com plano FREE + CARÊNCIA (grace_ends_at)
  insert into businesses (
    tenant_id, name, category, city, phone, email, location,
    owner_user_id, billing_plan, billing_status, cnpj, website, logo_url, billing_grace_ends_at
  )
  values (
    v_tenant.id, trim(p_name), coalesce(p_category, 'servico'), p_city, p_phone, p_email,
    case when p_lat is not null and p_lng is not null then ST_MakePoint(p_lng, p_lat)::geography else null end,
    v_owner_id,
    'FREE', 'TRIAL',
    nullif(p_cnpj,''), p_website, p_logo_url,
    now() + make_interval(mins => p_grace_months * 60 * 24 * 30)
  )
  returning id into v_business_id;

  update users set business_id = v_business_id where id = v_owner_id;

  return jsonb_build_object(
    'businessId', v_business_id,
    'ownerUserId', v_owner_id,
    'internalCode', v_internal
  );
end;
$function$;
