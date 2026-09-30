-- ============================================================================
-- notificacoes.sql
--
-- Fase 1 do modulo de notificacoes: FILA + AUDITORIA.
-- NAO APLIQUE ainda (ver "Ponto de decisao" no fim): o modulo entra em producao
-- junto com a publicacao do helper e do hook do claim-coupon.
--
-- O QUE ISTO FAZ
--   1) Tabela outbound_messages: uma linha por (evento, canal), com o status do
--      aviso, o destino e o codigo de erro resumido. Guarda a prova de que o
--      aviso saiu — ou de que ficou em noop por falta de provedor.
--   2) Dedupe por evento/canal: no maximo 1 linha por resgate e canal, para
--      que um retry do handler (ou um duplo clique do cliente) nao gere spam.
--   3) Quatro RPCs, todas SECURITY DEFINER com search_path travado e EXECUTE
--      apenas para service_role: outbound_enqueue (a unica escrita),
--      outbound_mark_sent, outbound_mark_failed e outbound_list.
--
-- POR QUE TABELA + RPC E NAO SO LOG
-- O comportamento observavel do default e' no-op, e log some. A auditoria e'
-- durable: e' ela que permite conferir depois "este resgate foi notificado?",
-- quantas vezes o provedor foi chamado e com que codigo de erro. Sem provider
-- configurado a linha nasce com status='noop' e provider='none' — o gancho
-- fica visivel mesmo sem entrega nenhuma.
--
-- POR QUE outbound_dispatch_pending NAO ESTA AQUI
-- Despachar fila agendado so faz sentido com provedor real (credencial do dono).
-- Esta fase nao tem provedor: nao ha nada para despachar, e uma rotina
-- agendada seria codigo mortorodando em producao.
--
-- Idempotente: pode rodar varias vezes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Tabela: fila/auditoria de avisos ao cliente
-- ---------------------------------------------------------------------------
-- coupon_id e booking_ref nao tem FK de proposito: sao a chave de dedupe do
-- evento, nao a integridade do dado. Se um cupom for removido, a prova de que
-- o aviso saiu continua de pe (auditoria > conveniencia de cascade).
CREATE TABLE IF NOT EXISTS public.outbound_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  event               text NOT NULL CHECK (event IN ('coupon_claimed', 'shuttle_booking_confirmed')),
  channel             text NOT NULL CHECK (channel IN ('WHATSAPP', 'EMAIL')),
  provider            text NOT NULL CHECK (provider IN ('none', 'whatsapp_cloud_api', 'smtp')),
  destination         text,   -- telefone so com digitos+DDD, ou endereco de email
  subject             text,
  body                text,   -- NUNCA contem token, segredo ou codigo interno
  status              text NOT NULL CHECK (status IN ('noop', 'queued', 'sent', 'failed')),
  provider_message_id text,   -- id devolvido pelo provedor
  error_code          text,   -- codigo curto; nunca a mensagem crua do terceiro
  attempts            integer NOT NULL DEFAULT 0,
  last_attempt_at     timestamptz,
  coupon_id           uuid,
  booking_ref         text
);

-- Dedupe: no maximo 1 aviso por evento/canal por resgate. Sao dois indices
-- (e nao um) porque cupom e reserva sao chaves mutuamente exclusivas: um indice
-- unico sobre (coupon_id, booking_ref) deixaria passar a segunda linha quando
-- booking_ref e' NULL — que e' exatamente o caso de todo resgate de cupom.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_messages_dedupe_coupon
  ON public.outbound_messages (tenant_id, event, customer_id, channel, coupon_id)
  WHERE coupon_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_messages_dedupe_booking
  ON public.outbound_messages (tenant_id, event, customer_id, channel, booking_ref)
  WHERE booking_ref IS NOT NULL;

-- Fila (quem ainda esta queued/failed) e auditoria (ordem recente do tenant).
CREATE INDEX IF NOT EXISTS idx_outbound_messages_status_created
  ON public.outbound_messages (status, created_at);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_tenant_created
  ON public.outbound_messages (tenant_id, created_at DESC);

-- RLS ligado e SEM policy: anon/authenticated nao leem nem escrevem nada.
-- Todo acesso passa pelas RPCs abaixo, com service_role.
ALTER TABLE public.outbound_messages ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2) outbound_enqueue — a unica escrita do modulo
-- ---------------------------------------------------------------------------
-- Grava e devolve; nao envia. O provedor e' chamado pelo handler depois.
--
-- p_provider e p_status entram porque o default do modulo e' no-op e a
-- auditoria precisa registrar isso na propria linha (provider='none',
-- status='noop') em vez de inferir depois.
--
-- Retorno: { inserted, id }. inserted=false = dedupe (o aviso ja foi
-- registrado para este evento/canal) e nao e' erro — e' o que impede o retry
-- do handler de enviar duas vezes. p_strict=true troca esse silencio por
-- OUTBOUND_DUPLICATE, para quem quiser o erro explicito.
CREATE OR REPLACE FUNCTION public.outbound_enqueue(
  p_tenant_id     uuid,
  p_event         text,
  p_channel       text,
  p_destination   text DEFAULT NULL,
  p_subject       text DEFAULT NULL,
  p_body          text DEFAULT NULL,
  p_customer_id   uuid DEFAULT NULL,
  p_coupon_id     uuid DEFAULT NULL,
  p_booking_ref   text DEFAULT NULL,
  p_provider      text DEFAULT 'none',
  p_status        text DEFAULT 'noop',
  p_strict        boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, extensions
AS $function$
DECLARE
  v_id       uuid;
  v_event    text := trim(coalesce(p_event, ''));
  v_channel  text := upper(trim(coalesce(p_channel, '')));
  v_provider text := lower(trim(coalesce(p_provider, 'none')));
  v_status   text := lower(trim(coalesce(p_status, 'noop')));
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'OUTBOUND_FORBIDDEN: tenant ausente';
  END IF;
  IF v_event = '' THEN
    RAISE EXCEPTION 'OUTBOUND_EVENT_INVALID: evento ausente';
  END IF;
  IF v_channel NOT IN ('WHATSAPP', 'EMAIL') THEN
    RAISE EXCEPTION 'OUTBOUND_CHANNEL_INVALID: %', v_channel;
  END IF;
  -- Valores desconhecidos caem no default conservative em vez de entrar na base.
  IF v_provider NOT IN ('none', 'whatsapp_cloud_api', 'smtp') THEN v_provider := 'none'; END IF;
  IF v_status   NOT IN ('noop', 'queued', 'sent', 'failed')  THEN v_status   := 'noop'; END IF;

  INSERT INTO outbound_messages (
    tenant_id, customer_id, event, channel, provider, destination,
    subject, body, status, coupon_id, booking_ref
  )
  VALUES (
    p_tenant_id, p_customer_id, v_event, v_channel, v_provider,
    nullif(trim(coalesce(p_destination, '')), ''),
    p_subject, p_body, v_status, p_coupon_id,
    nullif(trim(coalesce(p_booking_ref, '')), '')
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    IF coalesce(p_strict, false) THEN
      RAISE EXCEPTION 'OUTBOUND_DUPLICATE: aviso ja registrado para este evento/canal';
    END IF;
    RETURN jsonb_build_object('inserted', false, 'id', null);
  END IF;

  RETURN jsonb_build_object('inserted', true, 'id', v_id);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3) outbound_mark_sent / outbound_mark_failed
-- ---------------------------------------------------------------------------
-- Idempotentes: marcar 'sent' duas vezes nao muda nada. Id inexistente (ou ja
-- removido) e' OUTBOUND_NOT_FOUND — o handler so usa isso para log interno.
CREATE OR REPLACE FUNCTION public.outbound_mark_sent(
  p_message_id          uuid,
  p_provider_message_id text DEFAULT NULL
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, extensions
AS $function$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM outbound_messages WHERE id = p_message_id;
  IF NOT found THEN
    RAISE EXCEPTION 'OUTBOUND_NOT_FOUND: aviso inexistente';
  END IF;
  IF v_status = 'sent' THEN RETURN true; END IF;

  UPDATE outbound_messages
     SET status = 'sent',
         provider_message_id = coalesce(nullif(trim(coalesce(p_provider_message_id, '')), ''), provider_message_id),
         error_code = NULL,
         attempts = attempts + 1,
         last_attempt_at = now()
   WHERE id = p_message_id;
  RETURN true;
END;
$function$;

-- error_code passa por um filtro de caracteres: e' um codigo, nao um texto. Se
-- algum dia alguém mandar a mensagem crua do provedor, o que entra na base e'
-- so o esqueleto dela.
CREATE OR REPLACE FUNCTION public.outbound_mark_failed(
  p_message_id uuid,
  p_error_code text DEFAULT NULL
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, extensions
AS $function$
DECLARE
  v_status text;
  v_code   text;
BEGIN
  SELECT status INTO v_status FROM outbound_messages WHERE id = p_message_id;
  IF NOT found THEN
    RAISE EXCEPTION 'OUTBOUND_NOT_FOUND: aviso inexistente';
  END IF;

  v_code := left(regexp_replace(coalesce(p_error_code, 'UNKNOWN'), '[^A-Za-z0-9_\-]', '', 'g'), 64);
  IF v_code = '' THEN v_code := 'UNKNOWN'; END IF;

  UPDATE outbound_messages
     SET status = 'failed',
         error_code = v_code,
         attempts = attempts + 1,
         last_attempt_at = now()
   WHERE id = p_message_id;
  RETURN true;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4) outbound_list — conferencia no painel
-- ---------------------------------------------------------------------------
-- Autorizacao no banco (padrao business_*): a sessao ja foi resolvida pelo
-- handler, mas quem pode ver o que e' quem mora aqui, nao no frontend.
--   SUPER_ADMIN: qualquer tenant. ADMIN: so o proprio. MERCHANT: proibido.
-- Nao devolve body nem destination: a listagem nao precisa de PII do cliente.
CREATE OR REPLACE FUNCTION public.outbound_list(
  p_tenant_id     uuid,
  p_actor_user_id uuid,
  p_status        text DEFAULT NULL,
  p_limit         integer DEFAULT 50
)
  RETURNS TABLE (
    id                  uuid,
    event               text,
    channel             text,
    provider            text,
    status              text,
    created_at          timestamptz,
    attempts            integer,
    error_code          text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, extensions
AS $function$
DECLARE
  v_role   text;
  v_tenant uuid;
  v_status text := lower(trim(coalesce(p_status, '')));
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 200);
BEGIN
  IF p_tenant_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'OUTBOUND_FORBIDDEN: ator ou tenant ausente';
  END IF;

  SELECT role, tenant_id INTO v_role, v_tenant FROM users WHERE id = p_actor_user_id;
  IF NOT found OR v_role NOT IN ('ADMIN', 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'OUTBOUND_FORBIDDEN: papel sem acesso a auditoria de avisos';
  END IF;
  IF v_role = 'ADMIN' AND v_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'OUTBOUND_FORBIDDEN: tenant nao pertence ao ator';
  END IF;

  RETURN QUERY
  SELECT m.id, m.event, m.channel, m.provider, m.status, m.created_at, m.attempts, m.error_code
    FROM outbound_messages m
   WHERE m.tenant_id = p_tenant_id
     AND (v_status = '' OR m.status = v_status)
   ORDER BY m.created_at DESC
   LIMIT v_limit;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5) ACL: fecha EXECUTE para o cliente; so service_role executa
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.outbound_enqueue(uuid,text,text,text,text,text,uuid,uuid,text,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.outbound_enqueue(uuid,text,text,text,text,text,uuid,uuid,text,text,text,boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.outbound_mark_sent(uuid,text)  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.outbound_mark_sent(uuid,text)  TO service_role;
REVOKE EXECUTE ON FUNCTION public.outbound_mark_failed(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.outbound_mark_failed(uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.outbound_list(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.outbound_list(uuid,uuid,text,integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 6) Verificacao: nenhuma das funcoes pode estar aberta ao cliente
-- ---------------------------------------------------------------------------
-- aberta_ao_cliente DEVE ser 0 em todas as linhas. Rode tambem
-- close-function-exec.sql no fim (app_ainda_abertas = 0).
SELECT p.proname,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) x
         WHERE x.privilege_type = 'EXECUTE' AND x.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)
       )) AS aberta_ao_cliente
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('outbound_enqueue', 'outbound_mark_sent', 'outbound_mark_failed', 'outbound_list')
 GROUP BY p.proname
 ORDER BY p.proname;

-- Ponto de decisao (pergunta em aberto P9 da SPEC): aplicar agora ou esperar o
-- emissor da reserva de translado? Enquanto a reserva nao existir, a tabela
-- registra so coupon_claimed. Aplicar e' seguro (RLS fechada, so service_role
-- escreve) e deixa o gancho observavel; esperar mantem o banco sem objetos
-- nao usados. O dono decide.
