-- ===========================================================================
-- p9 - Contato publico da empresa (Instagram) + ficha publica do estabelecimento
-- ===========================================================================
-- Pedido do dono: na tela do cupom em /cliente, a logo da empresa deve aparecer
-- maior e centralizada no inicio, e abaixo do QR Code devem aparecer os dados
-- de contato do estabelecimento - telefone, site e Instagram.
--
-- O QUE EXISTIA (medido em producao antes de escrever esta migration):
--   - businesses tem phone, email, website e logo_url. NAO tem instagram.
--   - A unica coluna com esse nome no schema era `users.instagram`, que e do
--     CLIENTE, nao da empresa. Nao havia lugar nenhum para a empresa informar o
--     Instagram dela.
--   - businesses.custom_fields existe (jsonb), mas nenhuma linha preenchia e
--     nenhuma parte do app lia.
--   - business_logo_by_id devolvia so { businessId, name, logoUrl }.
--   - list_offers devolvia businessName e logoUrl, mas nao telefone/site.
--   - list_customer_coupons devolvia businessPhone, mas nao businessId nem logo,
--     de modo que o modal "Meus cupons" dependia do localStorage para saber de
--     qual empresa era o cupom.
--
-- DECISOES (e o porque de cada uma):
--
-- 1. `instagram` entra como COLUNA REAL, e nao em custom_fields.
--    Um caminho novo de escrita em jsonb livre seria invisivel em revisao de
--    diff: o dado entraria no banco sem ninguem ver, e o dono nao acharia o
--    campo para corrigir. Coluna nomeada aparece no \d da tabela e no diff da
--    migration.
--
-- 2. A coluna e NULLABLE, e sem DEFAULT explicito.
--    A tabela tem linhas e nenhuma tem Instagram. NOT NULL barraria a migration
--    inteira - e o erro so apareceria em producao, no momento de aplicar.
--
-- 3. As 4 funcoes de escrita mudam de assinatura com `p_instagram text
--    DEFAULT NULL` (e `p_website` em business_update_own) SEMPRE NO FIM.
--    - Sem o DEFAULT, a chamada de N argumentos do worker em producao passaria a
--      dar "function does not exist", e cadastro/edicao da empresa pararia ate
--      o deploy. Com o DEFAULT, o worker antigo continua funcionando durante a
--      janela entre esta migration e o deploy.
--    - O parametro novo tem de vir DEPOIS de todos os outros: no Postgres, um
--      parametro com DEFAULT nao pode ser seguido de um sem DEFAULT.
--
-- 4. REGRA DO NULL (a parte que evita perda de dado na janela de deploy):
--    nos parametros novos, NULL significa "nao informado, MANTER o valor atual";
--    string vazia depois de trim significa "LIMPAR o campo".
--    Sem isso, o worker antigo -- que manda 10 argumentos, portanto manda
--    p_instagram = NULL -- apagaria o Instagram de quem ja tivesse preenchido,
--    bastando alguem editar "Meus dados" na janela entre a migration e o
--    deploy. Por isso os campos novos usam `case when p_x is null then col else
--    nullif(btrim(p_x),'') end` em vez do `coalesce(p_x, col)` dos campos
--    antigos, que ja leem o vazio como "nao informado".
--
-- 5. `create or replace` NAO aceita parametro novo. As 4 de escrita sao, portanto,
--    DROP + CREATE: sem o DROP sobrariam duas sobrecargas de pe e toda chamada
--    passaria a responder "function ... is not unique" - a RPC simplesmente
--    pararia de resolver, sem erro visivel no codigo que chama. Por isso cada
--    uma delas fecha o ACL logo abaixo (Regra 4 do AGENTS.md).
--
-- 6. `business_logo_by_id` NAO foi tocada. Ela e a ficha antiga, e continua
--    servindo ao cliente ja em producao; mexer nela trocaria o formato da
--    resposta sem ninguem pedir. A ficha nova e `business_public_card`, uma
--    funcao a parte, e o app so passa a usa-la depois do deploy.
--
-- SEGURANCA:
--   - business_public_card e a unica funcao nova que precisa ler `businesses`
--     por conta propria: SECURITY DEFINER, com search_path fixo (mesmo padrao
--     de business_logo_by_id).
--   - Ela devolve CONTATO COMERCIAL de uma empresa, nao dado de cliente. E o
--     mesmo dado que `list_offers` ja expunha para quem abre a home; a ficha
--     so evita uma segunda ida ao banco. Nao ha CPF, telefone de cliente nem
--     e-mail de cliente neste caminho.
--   - list_offers e list_customer_coupons mudam de ASSINATURA? Nao. Por isso
--     usam CREATE OR REPLACE e o ACL delas em producao se preserva: nao ha
--     janela de reabertura para anon/authenticated.
--   - admin_list_businesses tambem nao muda de assinatura: e CREATE OR REPLACE,
--     so devolvendo `instagram` alem do que ja devolvia. E leitura de painel
--     admin (service_role). Sem o campo de volta, o input de Instagram no /admin
--     nasceria vazio e salvar qualquer outra edicao ali apagaria o dado.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. A coluna
-- ---------------------------------------------------------------------------
alter table public.businesses
  add column if not exists instagram text
;

comment on column public.businesses.instagram is
  'Perfil publico de Instagram da empresa, sem @ e sem https:// (ex.: playas). Escrito por /empresa "Meus dados" e por /admin.';

-- ---------------------------------------------------------------------------
-- 2. normalize_instagram: um jeito so de gravar o mesmo perfil
-- ---------------------------------------------------------------------------
-- A empresa pode digitar "@playas", "instagram.com/playas",
-- "https://www.instagram.com/playas/" ou "playas". Sem isto, o banco guarda
-- quatro formatos do mesmo perfil e o app precisa adivinhar na hora de montar o
-- link -- e um erro ali abre uma URL errada para o cliente.
--
-- Tris coisas que tem de estar nesta ordem, e que so foram conferidas depois de
-- aplicar (ver fix-normalize-instagram.sql, 2026-10-06):
--   1. btrim na ENTRADA antes dos anchored. `^@+` nao casa se a string comeca
--      com espaco, entao "  @playas  " guardava "@playas" no banco. O btrim de
--      fora nao resolve, porque ele roda depois.
--   2. o prefixo instagram.com precisa casar SEM exigir o esquema:
--      "^((https?://)?(www\.)?instagram\.com/?)". Com "^https?://" so,
--      "instagram.com/playas" passava inteiro e o cliente montava
--      "https://instagram.com/instagram.com/playas".
--   3. lower() no fim: o API.md documenta handle em minusculas, e a funcao
--      estava devolvendo "PLAYAS".
--
-- IMMUTABLE porque e funcao pura de texto (o planner pode pre-calcular).
-- search_path = pg_temp porque um objeto malicioso no schema do usuario nao
-- pode entrar no meio do calculo. Mesmo padrao de public.digits_only (p6).
create or replace function public.normalize_instagram(p_handle text)
returns text
language sql
immutable
set search_path = pg_temp
as $function$
  select nullif(
    lower(
      btrim(
        regexp_replace(
          regexp_replace(
            regexp_replace(btrim(coalesce(p_handle, '')), '^((https?://)?(www\.)?instagram\.com/?)', '', 'i'),
            '^@+', ''
          ),
          '/+$', ''
        )
      )
    ),
    ''
  );
$function$
;

revoke execute on function public.normalize_instagram(text) from public, anon, authenticated;
grant  execute on function public.normalize_instagram(text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. business_get_own: a empresa precisa LER o proprio Instagram
-- ---------------------------------------------------------------------------
-- Mesma assinatura (2 parametros), entao CREATE OR REPLACE preserva o ACL que
-- ja vale em producao. Nao ha o que fechar aqui.
create or replace function public.business_get_own(p_tenant_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
set search_path to public, extensions
as $function$
declare v_actor users%rowtype; v_business businesses%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.business_id is null then raise exception 'FORBIDDEN'; end if;
  select * into v_business from businesses where id=v_actor.business_id;
  return jsonb_build_object('name',v_business.name,'phone',v_business.phone,'email',v_business.email,
    'city',v_business.city,'category',v_business.category,'cnpj',v_business.cnpj,'website',v_business.website,
    'instagram',v_business.instagram,
    'logoUrl',v_business.logo_url,
    'lat', case when v_business.location is not null then ST_Y(v_business.location::geometry) else null end,
    'lng', case when v_business.location is not null then ST_X(v_business.location::geometry) else null end);
end $function$
;

-- ---------------------------------------------------------------------------
-- 4. business_public_card: a ficha que a tela do cupom consome
-- ---------------------------------------------------------------------------
-- Nova. Fica ao lado de business_logo_by_id em vez de substitui-la: a funcao
-- antiga ja responde ao cliente em producao, e trocar o formato dela em
-- silenceio seria trocar o contrato de um endpoint vivo.
--
-- Nao filtra por is_active de proposito. Um cupom ja resgatado continua
-- precisando mostrar a quem pertence; se a empresa foi desativada depois, o
-- cliente tem de ver o nome e o contato dela, nao um espaco em branco. E o
-- mesmo criterio de business_logo_by_id.
create or replace function public.business_public_card(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to public
as $function$
declare
  v_row businesses%rowtype;
begin
  select * into v_row from businesses b where b.id = p_business_id;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'businessId', p_business_id,
    'name', v_row.name,
    'logoUrl', v_row.logo_url,
    'phone', v_row.phone,
    'email', v_row.email,
    'website', v_row.website,
    'instagram', v_row.instagram,
    'category', v_row.category,
    'city', v_row.city
  );
end $function$
;

revoke execute on function public.business_public_card(uuid) from public, anon, authenticated;
grant  execute on function public.business_public_card(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4b. admin_list_businesses: o Instagram precisa VOLTAR para o /admin
-- ---------------------------------------------------------------------------
-- Sem isto, o campo de Instagram no painel do admin nasce vazio sempre. Pior:
-- como o valor nao volta, abrir a edicao de uma empresa para arrumar o telefone
-- e salvar enviaria string vazia no Instagram -- apagando um dado real sem
-- ninguem ter tocado no campo. Ja agora ele volta preenchido.
--
-- E uma funcao de LEITURA, so service_role, que ja existia com a mesma
-- assinatura: CREATE OR REPLACE mantem o ACL, entao nao ha REVOKE/GRANT para
-- repetir aqui.
create or replace function public.admin_list_businesses(p_tenant_id uuid, p_actor_user_id uuid)
  returns jsonb
  language plpgsql
  set search_path to 'public', 'extensions'
as $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'name', b.name, 'category', b.category, 'city', b.city, 'phone', b.phone, 'email', b.email,
    'cnpj', b.cnpj, 'website', b.website, 'instagram', b.instagram, 'logoUrl', b.logo_url,
    'lat', st_y(b.location::geometry), 'lng', st_x(b.location::geometry), 'isActive', b.is_active,
    'billingPlan', b.billing_plan, 'billingStatus', b.billing_status,
    'monthlyFeeCents', b.monthly_fee_cents, 'billingFeeCents', b.billing_fee_cents,
    'ownerInternalCode', u.internal_code
  ) order by b.created_at desc), '[]'::jsonb)
  from businesses b join users u on u.id = b.owner_user_id where b.tenant_id = p_tenant_id);
end $function$;

-- ---------------------------------------------------------------------------
-- 5. list_offers: a home do cliente passa a trazer o contato da empresa
-- ---------------------------------------------------------------------------
-- Mesma assinatura de 6 parametros: CREATE OR REPLACE preserva o ACL. O
-- telefone/site/Instagram e contato COMERCIAL de uma empresa que o proprio
-- cliente ja veria ao falar com o balcao -- e nao ha aqui nenhum dado de
-- cliente.
create or replace function public.list_offers(
  p_tenant_id uuid,
  p_city text default null::text,
  p_category text default null::text,
  p_lat double precision default null::double precision,
  p_lng double precision default null::double precision,
  p_radius_km double precision default null::double precision
)
returns jsonb
language sql
stable
set search_path to public, extensions
as $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'templateId', t.id,
      'title', t.title,
      'benefitType', t.benefit_type,
      'benefitValue', t.benefit_value,
      'businessId', b.id,
      'businessName', b.name,
      'category', b.category,
      'city', b.city,
      'imageUrl', t.image_url,
      'logoUrl', b.logo_url,
      'businessPhone', b.phone,
      'businessWebsite', b.website,
      'businessInstagram', b.instagram,
      'featuredRank', b.featured_rank,
      'featured', (t.featured_until is not null and t.featured_until > now()),
      'featuredUntil', t.featured_until,
      'distanceKm',
        case when p_lat is not null and b.location is not null
             then round((st_distance(b.location, st_makepoint(p_lng, p_lat)::geography) / 1000)::numeric, 2)
             else null end
    ) order by
      (t.featured_until is not null and t.featured_until > now()) desc,
      b.featured_rank desc,
      case when p_lat is not null and b.location is not null
           then st_distance(b.location, st_makepoint(p_lng, p_lat)::geography) else null end asc,
      b.name asc,
      t.title asc
  ), '[]'::jsonb)
  from public.coupon_templates t
  join public.campaigns c on c.id = t.campaign_id and c.status = 'PUBLISHED'
  join public.businesses b on b.id = t.business_id and b.is_active
  where t.tenant_id = p_tenant_id
    and t.is_active
    and (t.total_stock is null or t.issued_count < t.total_stock)
    and (t.valid_until is null or t.valid_until > now())
    and (p_city is null or lower(b.city) = lower(p_city))
    and (p_category is null or public.norm_categoria(b.category) = public.norm_categoria(p_category))
    and (p_radius_km is null or p_lat is null or p_lng is null
         or (b.location is not null
             and st_dwithin(b.location, st_makepoint(p_lng, p_lat)::geography, p_radius_km * 1000)));
$function$
;

-- ---------------------------------------------------------------------------
-- 6. list_customer_coupons: a ficha do cupom, sem depender do localStorage
-- ---------------------------------------------------------------------------
-- Mesma assinatura de 2 parametros: CREATE OR REPLACE preserva o ACL. Antes
-- desta migration a tela "Meus cupons" descobria a empresa do cupom por uma
-- copia do localStorage, que se perde quando o cliente troca de aparelho --
-- e o nome do estabelecimento sumia da lista. businessId vem do banco agora.
create or replace function public.list_customer_coupons(p_tenant_id uuid, p_customer_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'publicId', co.public_id,
    'status', co.status,
    'issuedAt', co.issued_at,
    'expiresAt', co.expires_at,
    'validatedAt', co.validated_at,
    'title', t.title,
    'businessId', b.id,
    'businessName', b.name,
    'businessLogoUrl', b.logo_url,
    'businessPhone', b.phone,
    'businessWebsite', b.website,
    'businessInstagram', b.instagram
  ) order by co.issued_at desc), '[]'::jsonb)
  from coupons co
  join coupon_templates t on t.id = co.template_id
  join businesses b on b.id = co.business_id
  where co.tenant_id = p_tenant_id and co.customer_id = p_customer_id;
$function$
;

-- ===========================================================================
-- 7. As 4 funcoes de ESCRITA
-- ===========================================================================
-- DROP explicito da assinatura antiga ANTES de criar a nova. Sem o DROP ficam
-- duas sobrecargas de pe e a RPC responde "is not unique" sem erro no cliente.

-- 7.1 register_business: cadastro publico da empresa ------------------------
drop function if exists public.register_business(text, text, text, text, text, text, text, text, text, double precision, double precision, text, text);
create function public.register_business(
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
  p_instagram text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to public, extensions
as $function$
declare
  v_tenant tenants%rowtype;
  v_owner_id uuid;
  v_business_id uuid;
begin
  SELECT * INTO v_tenant FROM tenants WHERE slug = p_tenant_slug;
  IF NOT found THEN RAISE EXCEPTION 'TENANT_NOT_FOUND'; END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN RAISE EXCEPTION 'INVALID_NAME'; END IF;
  IF p_internal_code IS NULL OR p_internal_code !~ '^[A-Za-z0-9._-]{2,64}$' THEN RAISE EXCEPTION 'INVALID_CODE'; END IF;
  IF length(p_pin) < 6 THEN RAISE EXCEPTION 'WEAK_PIN: minimo de 6 caracteres'; END IF;

  IF EXISTS (SELECT 1 FROM users WHERE tenant_id = v_tenant.id AND internal_code = p_internal_code) THEN
    RAISE EXCEPTION 'CODE_TAKEN: este código de login já está em uso';
  END IF;

  INSERT INTO users (tenant_id, internal_code, role, pin_hash, name, phone, email)
  VALUES (v_tenant.id, p_internal_code, 'MERCHANT', encode(digest(p_pin,'sha256'),'hex'), trim(p_name), p_phone, p_email)
  RETURNING id INTO v_owner_id;

  INSERT INTO businesses (tenant_id, name, category, city, phone, email, location, owner_user_id, billing_plan, billing_status, cnpj, website, logo_url, instagram)
  VALUES (v_tenant.id, trim(p_name), coalesce(p_category,'servico'), p_city, p_phone, p_email,
          CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL THEN ST_MakePoint(p_lng,p_lat)::geography ELSE NULL END,
          v_owner_id, 'FREE', 'TRIAL', p_cnpj,
          nullif(btrim(p_website), ''), p_logo_url,
          public.normalize_instagram(p_instagram))
  RETURNING id INTO v_business_id;

  UPDATE users SET business_id = v_business_id WHERE id = v_owner_id;

  RETURN jsonb_build_object('businessId', v_business_id, 'ownerUserId', v_owner_id, 'internalCode', p_internal_code);
END $function$
;
revoke execute on function public.register_business(text, text, text, text, text, text, text, text, text, double precision, double precision, text, text, text) from public, anon, authenticated;
grant  execute on function public.register_business(text, text, text, text, text, text, text, text, text, double precision, double precision, text, text, text) to service_role;

-- 7.2 admin_create_business: cadastro pelo painel -----------------------------
drop function if exists public.admin_create_business(uuid, uuid, text, text, text, text, text, double precision, double precision, text, text, text, text, text, text);
create function public.admin_create_business(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_category text,
  p_city text,
  p_phone text,
  p_email text,
  p_lat double precision,
  p_lng double precision,
  p_owner_internal_code text,
  p_owner_pin text,
  p_billing_plan text,
  p_cnpj text default null::text,
  p_website text default null::text,
  p_logo_url text default null::text,
  p_instagram text default null::text
)
returns jsonb
language plpgsql
set search_path to public, extensions
as $function$
declare v_actor users%rowtype; v_owner_id uuid; v_business_id uuid;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  if length(p_owner_pin) < 6 then raise exception 'WEAK_PIN: minimo de 6 caracteres'; end if;

  select id into v_owner_id from users where tenant_id = p_tenant_id and internal_code = p_owner_internal_code;
  if not found then
    insert into users (tenant_id, internal_code, role, pin_hash)
      values (p_tenant_id, p_owner_internal_code, 'MERCHANT', encode(digest(p_owner_pin,'sha256'),'hex'))
      returning id into v_owner_id;
  end if;

  insert into businesses (tenant_id, name, category, city, phone, email, location, owner_user_id, billing_plan, billing_status, cnpj, website, logo_url, instagram)
  values (p_tenant_id, p_name, p_category, p_city, p_phone, p_email,
          case when p_lat is not null and p_lng is not null then ST_MakePoint(p_lng,p_lat)::geography else null end,
          v_owner_id, coalesce(p_billing_plan,'FREE'), 'TRIAL', p_cnpj,
          nullif(btrim(p_website), ''), p_logo_url,
          public.normalize_instagram(p_instagram))
  returning id into v_business_id;

  update users set business_id = v_business_id where id = v_owner_id;
  return jsonb_build_object('businessId', v_business_id, 'ownerUserId', v_owner_id);
end $function$
;
revoke execute on function public.admin_create_business(uuid, uuid, text, text, text, text, text, double precision, double precision, text, text, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.admin_create_business(uuid, uuid, text, text, text, text, text, double precision, double precision, text, text, text, text, text, text, text) to service_role;

-- 7.3 admin_update_business: edicao pelo painel ------------------------------
drop function if exists public.admin_update_business(uuid, uuid, uuid, text, text, text, text, text, text, text, text);
create function public.admin_update_business(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_business_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_category text,
  p_city text,
  p_cnpj text,
  p_website text,
  p_logo_url text,
  p_instagram text default null::text
)
returns void
language plpgsql
set search_path to public, extensions
as $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  -- `coalesce` nos campos antigos: vazio ja entrava como NULL do worker.
  -- `case` nos novos: NULL = manter, '' = limpar (ver decisao 4 no cabecalho).
  update businesses set name=coalesce(p_name,name), phone=coalesce(p_phone,phone), email=coalesce(p_email,email),
    category=coalesce(p_category,category), city=coalesce(p_city,city), cnpj=coalesce(p_cnpj,cnpj),
    website=coalesce(p_website,website), logo_url=coalesce(p_logo_url,logo_url),
    instagram=case when p_instagram is null then instagram else public.normalize_instagram(p_instagram) end
    where id=p_business_id and tenant_id=p_tenant_id;
end $function$
;
revoke execute on function public.admin_update_business(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.admin_update_business(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text) to service_role;

-- 7.4 business_update_own: "Meus dados" em /empresa -------------------------
-- Ganha website E instagram: a empresa nao conseguia editar o proprio site nem
-- porque o parametro nao existia, entao o campo aparecia so no cadastro.
drop function if exists public.business_update_own(uuid, uuid, text, text, text, text, text, text, double precision, double precision);
create function public.business_update_own(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_city text,
  p_logo_url text,
  p_category text default null::text,
  p_lat double precision default null::double precision,
  p_lng double precision default null::double precision,
  p_website text default null::text,
  p_instagram text default null::text
)
returns void
language plpgsql
set search_path to public, extensions
as $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;
  update public.businesses set
    name = coalesce(p_name, name),
    phone = coalesce(p_phone, phone),
    email = coalesce(p_email, email),
    city = coalesce(p_city, city),
    logo_url = coalesce(p_logo_url, logo_url),
    category = coalesce(p_category, category),
    website = case when p_website is null then website else nullif(btrim(p_website), '') end,
    instagram = case when p_instagram is null then instagram else public.normalize_instagram(p_instagram) end,
    location = case when p_lat is not null and p_lng is not null
                    then st_makepoint(p_lng, p_lat)::geography
                    else location end
  where id = v_actor.business_id and tenant_id = p_tenant_id;
end $function$
;
revoke execute on function public.business_update_own(uuid, uuid, text, text, text, text, text, text, double precision, double precision, text, text) from public, anon, authenticated;
grant  execute on function public.business_update_own(uuid, uuid, text, text, text, text, text, text, double precision, double precision, text, text) to service_role;