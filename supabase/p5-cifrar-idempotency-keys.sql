-- ============================================================================
-- p5-cifrar-idempotency-keys.sql
--
-- Cifra em repouso o resultado de coupon.claim em idempotency_keys, para que o
-- rawToken do cupom deixe de estar em texto claro na tabela.
--
-- ---------------------------------------------------------------------------
-- O QUE ESTA MIGRATION FAZ
-- ---------------------------------------------------------------------------
--   1) cria public.idempotency_keys_secret, com uma chave de 32 bytes
--      (AES-256 via pgcrypto) que SO o postgres le;
--   2) adiciona idempotency_keys.result_enc (bytea) e tira o NOT NULL de
--      result, com um CHECK que exige exatamente um dos dois preenchido;
--   3) reescreve claim_coupon para cifrar ao gravar e decifrar no replay.
--
-- ---------------------------------------------------------------------------
-- POR QUE SO coupon.claim
-- ---------------------------------------------------------------------------
-- As duas operacoes da tabela nao tem o mesmo risco, e por isso nao levam o
-- mesmo tratamento:
--
--   coupon.claim -> guarda rawToken e shortCode. Sao SEGREDOS: e o que o QR
--                    carrega e o que da direito ao desconto. Cifrado aqui.
--   coupon.validate -> guarda businessName, couponId, customerName,
--                    customerPhone, issuedAt, validatedAt. Nao ha segredo,
--                    mas ha DADO PESSOAL (nome e telefone), que fica em texto
--                    claro. Ver "O QUE FICA DE FORA" no fim.
--
-- A restricao tecnica que fixa esta separacao: claim_coupon e SECURITY
-- DEFINER (roda como postgres, dono da chave), mas validate_and_redeem_coupon
-- e SECURITY INVOKER e executa como service_role, que nao leria uma chave
-- restrita a postgres. Cifrar as duas exigiria ou dar a chave ao service_role
-- (que defeats o proposito) ou promover validate_and_redeem_coupon a
-- DEFINER, mudaria a postura de RLS dela numa rota de dinheiro. Fora do
-- escopo, e por isso validate_and_redeem_coupon NAO e tocada.
--
-- ---------------------------------------------------------------------------
-- O QUE ISTO PROTEGE -- E O QUE NAO PROTEGE
-- ---------------------------------------------------------------------------
-- ANTES: qualquer papel com SELECT na tabela lia todos os rawTokens de uma
-- vez. service_role tem esse SELECT (verificado em 2026-10-03). Uma chave de
-- servico vazada, um job deBI ou um SELECT acidental expurrava todos os
-- tokens ativos.
--
-- DEPOIS: service_role continua lendo a tabela, mas coupon.claim devolve
-- bytea. Quem quiser os tokens precisa de SELECT na idempotency_keys_secret
-- ALEM disso, e essa tabela nao concede nada a ninguem alem do postgres.
--
-- O QUE ISTO NAO PROTEGE, e seria desonesto nao dizer:
--   - dump completo do banco: leva a tabela e a chave juntas;
--   - acesso de superusuario / compromise do proprio Postgres;
--   - quem chame a claim_coupon com a CHAVE DE IDEMPOTENCIA certa: o replay
--     decifra e devolve o token por design. Quem tem a chave e o cliente
--     original, e a chave tem 128 bits de crypto.getRandomValues no
--     navegador (ver claimKeyFor em app/cliente/page.jsx). E um modelo de
--     capacidade, nao de autenticacao.
--
-- A protecao real e contra leitura parcial: replica somente-leitura, export
-- de tabela, BI, log de query, ferramenta que le idempotency_keys sem saber
-- da tabela de chaves. E o cenario comum.
--
-- ---------------------------------------------------------------------------
-- POR QUE result_enc E UMA COLUNA NOVA, E NAO RECICLAR result
-- ---------------------------------------------------------------------------
-- idempotency_keys e compartilhada, e validate_and_redeem_coupon grava em
-- `result` direto. Sobrepor o tipo em bytea quebraria as 73 linhas de
-- coupon.validate ja gravadas e a funcao que as le. Uma coluna nova deixa as
-- linhas antigas intocadas e o CHECK impede que alguem grave texto claro e
-- cifrao na mesma linha.
--
-- O CHECK e XOR: exatamente um dos dois preenchido. `result is null` XOR
-- `result_enc is null`. Sem ele, uma linha poderia ficar sem nada (replay
-- quebrado em silencio) ou com os dois (texto claro convivendo com a cifra).
--
-- Linhas coupon.claim existentes: ZERO (verificado em 2026-10-03), porque a
-- p3 acabou de aplicar. Nao ha resultado em texto claro para migrar. Se
-- algum dia existir, a migracao tem que ser extendsida -- o CHECK sozinho
-- rejeitaria a insercao, o que e o comportamento desejado.
--
-- ---------------------------------------------------------------------------
-- POR QUE INVALIDAR O CACHE E MELHOR QUE DEVOLVER TOKEN ERRADO
-- ---------------------------------------------------------------------------
-- Se a chave sumir ou for trocada, as linhas antigas ficam indecifraveis. O
-- replay trata isso com IDEMPOTENCY_UNAVAILABLE em vez de propagar o erro do
-- pgcrypto (que poderia carregar detalhe da cifra). O cliente ve "nao deu",
-- tenta de novo sem chave e ganha um cupom novo, limitado por
-- per_customer_limit. Como o expurgo da p4 apaga tudo acima de 7 dias, a
-- janela de quebra e curta.
--
-- TROCAR A CHAVE depois e seguro porem nao instantaneo: ate as linhas antigas
-- sairem pela janela de 7 dias, os replays delas falham. Se for rotacionar,
-- primeiro confira que nao ha coupon.claim com menos de 7 dias.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- supabase/p5-cifrar-idempotency-keys.rollback.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Tabela da chave. Uma linha so.
-- ---------------------------------------------------------------------------
create table if not exists public.idempotency_keys_secret (
  singleton boolean primary key default true,
  -- `text`, NAO `bytea`. A senha do pgcrypto e text nas duas pontas:
  --   pgp_sym_encrypt(text, text) -> bytea
  --   pgp_sym_decrypt(bytea, text) -> text
  -- Guardar a chave em bytea e passar direto nao compila (42883). Ver a nota
  -- "ASSINATURA" no fim. Base64 de 32 bytes = 44 chars = 256 bits de entropia.
  key       text not null,
  criado_em timestamptz not null default now(),
  -- So uma linha pode existir: a constraint PRIMARY KEY sozinha permitiria
  -- varias linhas com singleton=false.
  constraint idempotency_keys_secret_unica check (singleton),
  -- Trava contra chave encurtada por erro de digitacao ou por um INSERT
  -- futuro com valor hardcoded fraco. 44 chars = 32 bytes.
  constraint idempotency_keys_secret_tamanho check (length(key) >= 40)
);

-- Autocorrecao: se esta p5 ja tiver sido aplicada antes da correcao (ver nota
-- ASSINATURA), a coluna ainda e bytea e a funcao esta quebrada. O alter e
-- no-op quando a tabela ja nasceu correta, e o que salva o ambiente antigo.
alter table public.idempotency_keys_secret
  alter column key type text using key::text;

-- gen_random_bytes(32) = 256 bits, que e o que o AES-256 do pgcrypto usa.
-- ON CONFLICT DO NOTHING: reaplicar o arquivo NAO pode gerar uma chave nova,
-- senao todas as linhas ja cifradas ficam indecifraveis. Este arquivo nao tem
-- como reverter um DELETE da tabela -- por isso o ON CONFLICT.
insert into public.idempotency_keys_secret (singleton, key)
values (true, encode(gen_random_bytes(32), 'base64'))
on conflict (singleton) do nothing;

-- Belt and braces: ACL e o que barra de fato (RLS nao vale para service_role,
-- que tem BYPASSRLS).
alter table public.idempotency_keys_secret enable row level security;
revoke all on table public.idempotency_keys_secret from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Coluna nova + CHECK de exatamente um
-- ---------------------------------------------------------------------------
alter table idempotency_keys add column if not exists result_enc bytea;

-- As linhas de coupon.validate (73) so tem `result`; as de coupon.claim so
-- terao `result_enc`. Nenhuma das duas formas quebra aqui.
alter table idempotency_keys alter column result drop not null;

alter table idempotency_keys drop constraint if exists idempotency_keys_exatamente_um;
alter table idempotency_keys
  add constraint idempotency_keys_exatamente_um
  check ((result is null) <> (result_enc is null));

-- ---------------------------------------------------------------------------
-- 3) claim_coupon cifrando ao gravar, decifrando no replay
-- ---------------------------------------------------------------------------
-- DROP + CREATE (nao CREATE OR REPLACE) porque a assinatura muda de novo: os
-- parametros sao os mesmos da p3, mas o tipo do retorno interno nao. Mesmo
-- criterio da p3: se sobrasse alguma versao antiga, duas claim_coupon com
-- DEFAULT deixariam a chamada do PostgREST ambigua e o resgate publico cairia.
-- DROP sem CASCADE: dependencia inesperada aborta tudo em vez de derrubar.
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
set search_path to 'public', 'extensions'
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
begin
  -- (1) Serializa requisicoes concorrentes do MESMO template. ANTES da leitura
  -- do cache, ver a nota de ordem em p3-idempotencia-claim-coupon.sql.
  select * into v_template from coupon_templates where id = p_template_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'NOT_FOUND: template'; end if;
  if not v_template.is_active then raise exception 'COUPON_INACTIVE'; end if;

  -- (2) Replay: devolve o MESMO cupom, agora decifrando.
  if p_idempotency_key is not null then
    select result_enc into v_cipher
      from idempotency_keys
      where tenant_id = p_tenant_id and operation = 'coupon.claim' and idempotency_key = p_idempotency_key;

    if v_cipher is not null then
      -- A chave e lida aqui, e nao no inicio da funcao: um resgate sem chave
      -- (o caminho antigo, ainda valido) nao paga esse custo.
      select key into v_key from public.idempotency_keys_secret where singleton;
      if v_key is null then
        raise exception 'IDEMPOTENCY_UNAVAILABLE';
      end if;
      begin
        v_cached := pgp_sym_decrypt(v_cipher, v_key)::jsonb;
      exception when others then
        -- Chave trocada/ausente, ou cifra corrompida. O erro do pgcrypto nao
        -- sobe: poderia carregar detalhe da cifra. O cliente so precisa saber
        -- que o replay nao deu.
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

  v_raw_token := encode(gen_random_bytes(32), 'base64');
  v_public_id := 'PYV-' || upper(encode(gen_random_bytes(5), 'hex'));
  v_short_code := lpad(floor(random() * 1000000)::text, 6, '0');

  insert into coupons (public_id, secure_token_hash, short_code_hash, tenant_id, template_id, campaign_id, business_id, customer_id, status, expires_at)
  values (v_public_id, encode(digest(v_raw_token,'sha256'),'hex'), encode(digest(v_short_code,'sha256'),'hex'), p_tenant_id, p_template_id, v_template.campaign_id, v_template.business_id, v_customer_id, 'AVAILABLE', v_template.valid_until)
  returning id into v_coupon_id;

  update coupon_templates set issued_count = issued_count + 1 where id = p_template_id;

  v_result := jsonb_build_object('couponId', v_coupon_id, 'publicId', v_public_id, 'rawToken', v_raw_token, 'shortCode', v_short_code, 'customerId', v_customer_id);

  -- (3) Guarda a resposta CIFRADA. A linha so existe se o cliente mandou
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

-- ---------------------------------------------------------------------------
-- 4) Como conferir depois
-- ---------------------------------------------------------------------------
-- Nenhuma linha de coupon.claim deve ter texto claro:
--   select count(*) from idempotency_keys where operation='coupon.claim' and result is not null;
--   -- esperado: 0
--
-- As linhas de coupon.validate continuam em texto claro (ver "O QUE FICA DE
-- FORA"): so nao tem segredo.
--   select operation, count(*), count(result) as claro, count(result_enc) as cifrado
--     from idempotency_keys group by operation;
--
-- A chave nao pode ser lida por service_role:
--   select has_table_privilege('service_role','public.idempotency_keys_secret','SELECT');
--   -- esperado: false

-- ============================================================================
-- ASSINATURA (aqui quebrou a primeira vez)
-- ---------------------------------------------------------------------------
-- Esta p5 foi aplicada UMA VEZ com `key bytea` e pgp_sym_encrypt(v_result::text,
-- v_key) onde v_key era bytea. O teste de round-trip no ar pegou:
--
--   ERROR 42883: function pgp_sym_encrypt(text, bytea) does not exist
--
-- A versao instalada (pgcrypto 1.3 / PG 17.6) so expoe:
--   extensions.pgp_sym_encrypt(text, text [, text]) -> bytea
--   extensions.pgp_sym_decrypt(bytea, text [, text]) -> text
--
-- Ou seja: a SENHA e text dos dois lados; so o texto cifrado e bytea. O
-- `alter column key type text` acima existe para consertar o ambiente onde a
-- versao quebrada ja rodou.
--
-- Como o bug so aparecia no caminho COM chave, e o frontend com idempotencyKey
-- nao estava publicado, nada quebrou para usuario -- a chamada de 6 argumentos
-- (p_idempotency_key = NULL) nunca chega na cifragem. O teste de round-trip foi
-- o que pegou, nao o smoke test do caminho antigo. Vale rerodar o teste completo
-- apos mexer nestas linhas.
-- ============================================================================