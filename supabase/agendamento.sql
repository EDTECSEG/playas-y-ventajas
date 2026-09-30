-- ============================================================
-- Playas y Ventajas - Agendamento de Translado (SPEC-agendamento)
-- ------------------------------------------------------------
-- RODE NO SQL EDITOR DO SUPABASE (Settings > SQL Editor > New query)
-- Este arquivo e idempotente: pode rodar varias vezes.
--
-- O que entra aqui:
--
--   tabela shuttle_reservations
--   coluna shuttle_services.duration_minutes
--   shuttle_create_reservation              cliente cria (3 campos)
--   shuttle_cancel_reservation              cliente cancela
--   shuttle_list_customer_reservations      cliente acompanha as reservas
--   business_list_shuttle_reservations      empresa ve a fila
--   business_review_shuttle_reservation     empresa decide
--   driver_list_shuttle_runs                motorista ve as corridas do dia
--   driver_complete_shuttle_reservation     motorista conclui a corrida
--
-- E o que muda em RPC existente:
--
--   business_save_shuttle_service           + p_duration_minutes
--   business_delete_shuttle_service         recusa apagar com reserva viva
--
-- Mesmo padrao do projeto: SECURITY DEFINER, autorizacao DENTRO da funcao,
-- acesso so do service_role, erro de negocio como 'CODIGO: detalhe' para o
-- rpcErrorCode/rpcErrorStatus traduzirem em HTTP correto.
--
-- FUSO DE REFERENCIA: 'America/Sao_Paulo', fixo e escrito dentro das
-- funcoes. Isso responde a Q1 da spec (pendente de confirmacao do dono):
-- nao existe AT TIME ZONE em nenhum outro SQL do repo, entao "dia da semana",
-- "hora na janela" e "dia da agenda" ficariam indefinidos sem uma referencia
-- explicita. Se o fuso vier do tenant depois, e trocar a constante e os
-- AT TIME ZONE para `v_tz` — nada mais muda.
--
-- DEPOIS DE RODAR: supabase/close-function-exec.sql e conferir
-- app_ainda_abertas = 0 (DROP + CREATE reabre o ACL, ver secao 10).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tabela de reservas
-- ------------------------------------------------------------
-- `business_id` e copia do servico no momento da reserva: a lista da empresa
-- nao depende de join e continua correta se o serviso for desativado depois.
--
-- `shuttle_id` e ON DELETE RESTRICT, o oposto de vehicle_positions.shuttle_id
-- (ON DELETE SET NULL): apagar servico com reserva e erro de negocio explicito
-- (business_delete_shuttle_service devolve SHUTTLE_HAS_RESERVATIONS), nao
-- apagadao silencioso. Manter FK e o que garante que o historico do cliente
-- nunca some.
--
-- Duracao: a janela ocupada e [scheduled_for, scheduled_for + duration). O
-- DEFAULT 60min vem de shuttle_services.duration_minutes (Q2 da spec: um tour
-- de 3h e um transfer de 30min nao podem ter a mesma janela).
CREATE TABLE IF NOT EXISTS public.shuttle_reservations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  business_id      uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  shuttle_id       uuid NOT NULL REFERENCES public.shuttle_services(id) ON DELETE RESTRICT,
  -- Cliente identificado: um users (role CUSTOMER) devolvido por
  -- identify_customer. Nao existe tabela customers separada.
  customer_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  scheduled_for    timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
  passengers       integer NOT NULL CHECK (passengers BETWEEN 1 AND 20),
  -- Snapshot do preco na criacao; NULL = "a combinar", como o card do cliente.
  price_cents      integer CHECK (price_cents IS NULL OR price_cents >= 0),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','rejected','cancelled','completed')),
  -- Telefone do cliente no momento da reserva (a empresa e a dona do dado).
  contact_phone    text,
  notes            text,
  -- Justificativa da empresa em rejected/cancelled (mesmo papel do
  -- p_reason de driver_review_document).
  reason           text,
  decided_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Fila da empresa: pendentes do tenant, por ordem de horario.
CREATE INDEX IF NOT EXISTS shuttle_reservations_tenant_status_idx
  ON public.shuttle_reservations (tenant_id, status, scheduled_for);

-- Historico do cliente, mais recente primeiro.
CREATE INDEX IF NOT EXISTS shuttle_reservations_customer_idx
  ON public.shuttle_reservations (customer_id, scheduled_for DESC);

-- E o indice que a checagem de sobreposicao usa: toda checacao e
-- shuttle_id + intervalo, entao e o indice quente do modulo.
CREATE INDEX IF NOT EXISTS shuttle_reservations_slot_idx
  ON public.shuttle_reservations (shuttle_id, scheduled_for)
  WHERE status IN ('pending','confirmed');

-- RLS ligada e SEM policy, como vehicle_positions (modulo1b) e
-- driver_sessions: nao existe acesso direto pelo PostgREST, todo caminho passa
-- por SECURITY DEFINER com service_role. Criar policy para anon/authenticated
-- aqui abriria a tabela inteira.
ALTER TABLE public.shuttle_reservations ENABLE ROW LEVEL SECURITY;

-- updated_at sem trigger: cada RPC que muda status ja escreve o campo, e o
-- projeto nao usa trigger em nenhuma outra tabela (modulo1/modulo4 tambem
-- escrevem updated_at na mao).

-- ------------------------------------------------------------
-- 2) Duracao da corrida, como propriedade do servico
-- ------------------------------------------------------------
-- Default 60 mantem business_save_shuttle_service funcionando sem parametro
-- novo obrigatorio. Q2 da spec: se o dono preferir um valor por empresa em vez
-- de por servico, e esta coluna que sai (a reserva continua usando o snapshot).
ALTER TABLE public.shuttle_services
  ADD COLUMN IF NOT EXISTS duration_minutes integer NOT NULL DEFAULT 60;

-- ------------------------------------------------------------
-- 3) Cliente: cria reserva
-- ------------------------------------------------------------
-- Ordem das regras (a da spec, e a ordem importa para o que o cliente ve):
--   1) cliente existe no tenant
--   2) servico existe, ativo, do mesmo tenant e com negocio ativo
--   3) horario no futuro
--   4) dia da semana local em active_days
--   5) hora local dentro de opens_at..closes_at
--   6) janela nao sobrepoe outra reserva viva do MESMO servico
--   7) insere pending com snapshot de price_cents
--
-- Regra 6 tem lock pessimista na linha do servico (SELECT ... FOR UPDATE)
-- ANTES da checagem: duas requisicoes simultaneas no mesmo servico ficam
-- serializadas ali, entao a segunda ve a linha ja commitada da primeira e leva
-- SLOT_CONFLICT. Sem o lock, duas transacoes leem o mesmo vazio e as duas
-- inserem.
CREATE OR REPLACE FUNCTION public.shuttle_create_reservation(
  p_tenant_id      uuid,
  p_customer_id    uuid,
  p_service_id     uuid,
  p_scheduled_for  timestamptz,
  p_passengers     integer,
  p_notes          text  DEFAULT NULL,
  p_contact_phone  text  DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_tz            constant text := 'America/Sao_Paulo';
  v_lock_id       uuid;
  v_business_id   uuid;
  v_price_cents   integer;
  v_duration      integer;
  v_opens_at      time;
  v_closes_at     time;
  v_active_days   smallint[];
  v_local         timestamp;
  v_dow           integer;
  v_id            uuid;
begin
  if p_tenant_id is null or p_customer_id is null or p_service_id is null
     or p_scheduled_for is null then
    raise exception 'BAD_REQUEST';
  end if;

  -- 1) Cliente do proprio tenant. Sem isso, um customer_id de outro tenant
  -- (ou inventado) criaria reserva orfa.
  if not exists (
    select 1 from public.users
    where id = p_customer_id and tenant_id = p_tenant_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  if p_passengers is null or p_passengers < 1 or p_passengers > 20 then
    raise exception 'INVALID_PASSENGERS';
  end if;

  -- 2) Servico: mesmo tenant, ativo, e com a empresa ativa. O mesmo erro para
  -- os tres casos de proposito — responder 404/403 diferente confirmaria a
  -- existencia de um servico de outro tenant.
  select s.id into v_lock_id
    from public.shuttle_services s
    where s.id = p_service_id
      and s.tenant_id = p_tenant_id
      and s.is_active
    for update;
  if v_lock_id is null then
    raise exception 'SHUTTLE_NOT_FOUND';
  end if;

  select s.business_id, s.price_cents, s.duration_minutes,
         s.opens_at, s.closes_at, s.active_days
    into v_business_id, v_price_cents, v_duration, v_opens_at, v_closes_at, v_active_days
    from public.shuttle_services s
    join public.businesses b on b.id = s.business_id
    where s.id = p_service_id
      and s.tenant_id = p_tenant_id
      and s.is_active
      and b.is_active;
  if v_business_id is null then
    raise exception 'SHUTTLE_NOT_FOUND';
  end if;

  if v_duration is null or v_duration <= 0 then
    v_duration := 60;
  end if;

  -- 3) Nada no passado. (Q11 da spec: nao ha antecedencia minima alem disso.)
  if p_scheduled_for <= now() then
    raise exception 'INVALID_SCHEDULE';
  end if;

  -- 4) e 5) Dia e hora LOCAIS: sao o que active_days e opens_at/closes_at
  -- querem dizer, e o front formata no fuso do navegador — sem converter, um
  -- horario de 23:30 cairia no dia seguinte aqui.
  v_local := p_scheduled_for at time zone v_tz;
  v_dow   := extract(dow from v_local)::integer;

  -- active_days vazio/null = todos os dias (mesma normalizacao do
  -- business_save_shuttle_service, que troca {} pela semana inteira).
  if coalesce(array_length(v_active_days, 1), 0) > 0
     and not (v_dow = any (v_active_days)) then
    raise exception 'DAY_NOT_ACTIVE';
  end if;

  if v_opens_at is not null and v_local::time < v_opens_at then
    raise exception 'OUTSIDE_HOURS';
  end if;
  if v_closes_at is not null and v_local::time > v_closes_at then
    raise exception 'OUTSIDE_HOURS';
  end if;

  -- 6) Sobreposicao de [inicio, inicio + duracao) com reservas vivas do mesmo
  -- servico. '[)' deixa encostar: uma corrida que termina 10:00 e outra que
  -- comeca 10:00 nao conflitam.
  if exists (
    select 1
    from public.shuttle_reservations r
    where r.shuttle_id = p_service_id
      and r.status in ('pending','confirmed')
      and tstzrange(
            r.scheduled_for,
            r.scheduled_for + make_interval(mins => r.duration_minutes),
            '[)'
          ) && tstzrange(
            p_scheduled_for,
            p_scheduled_for + make_interval(mins => v_duration),
            '[)'
          )
  ) then
    raise exception 'SLOT_CONFLICT';
  end if;

  -- 7) Snapshot: preco e duracao sao copiados agora, para a reserva nao mudar
  -- de valor se a empresa editar o servico depois.
  insert into public.shuttle_reservations (
    tenant_id, business_id, shuttle_id, customer_id, scheduled_for,
    duration_minutes, passengers, price_cents, status, contact_phone, notes
  ) values (
    p_tenant_id, v_business_id, p_service_id, p_customer_id, p_scheduled_for,
    v_duration, p_passengers, v_price_cents, 'pending',
    nullif(btrim(coalesce(p_contact_phone, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_id;

  return jsonb_build_object(
    'reservationId',  v_id,
    'shuttleId',      p_service_id,
    'status',         'pending',
    'scheduledFor',   p_scheduled_for,
    'durationMinutes',v_duration,
    'passengers',     p_passengers,
    'priceCents',     v_price_cents,
    'createdAt',      now()
  );
end
$function$
;

-- ------------------------------------------------------------
-- 4) Cliente: cancela a propria reserva
-- ------------------------------------------------------------
-- So o dono (customer_id), so de pending/confirmed. Livre em qualquer momento:
-- Q8 da spec nao definiu prazo, e qualquer outro status e INVALID_STATUS_TRANSITION
-- (rejeitada, cancelada ou concluida nao voltam).
CREATE OR REPLACE FUNCTION public.shuttle_cancel_reservation(
  p_tenant_id      uuid,
  p_customer_id    uuid,
  p_reservation_id uuid,
  p_reason         text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_res public.shuttle_reservations%rowtype;
begin
  if p_tenant_id is null or p_customer_id is null or p_reservation_id is null then
    raise exception 'BAD_REQUEST';
  end if;

  -- Escopo pelo customer_id: reserva de outra pessoa e RESERVATION_NOT_FOUND,
  -- nao FORBIDDEN — nao confirmar a existencia de um id que nao e seu.
  select * into v_res
    from public.shuttle_reservations
    where id = p_reservation_id
      and tenant_id = p_tenant_id
      and customer_id = p_customer_id
    for update;
  if v_res.id is null then
    raise exception 'RESERVATION_NOT_FOUND';
  end if;

  if v_res.status not in ('pending','confirmed') then
    raise exception 'INVALID_STATUS_TRANSITION';
  end if;

  update public.shuttle_reservations
    set status = 'cancelled',
        reason = nullif(btrim(coalesce(p_reason, '')), ''),
        updated_at = now()
    where id = v_res.id;

  return jsonb_build_object(
    'reservationId', v_res.id,
    'status', 'cancelled'
  );
end
$function$
;

-- ------------------------------------------------------------
-- 5) Cliente: lista as proprias reservas
-- ------------------------------------------------------------
-- p_status e escolha de TELA (o filtro da UI), nao de autoridade: o escopo
-- continua sendo o customer_id, conferido dentro da funcao. Devolve businessName
-- e businessPhone porque o card de confirmacao monta o link de WhatsApp com o
-- telefone que veio do BANCO, nunca digitado no browser.
CREATE OR REPLACE FUNCTION public.shuttle_list_customer_reservations(
  p_tenant_id   uuid,
  p_customer_id uuid,
  p_status      text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
begin
  if p_tenant_id is null or p_customer_id is null then
    raise exception 'BAD_REQUEST';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'reservationId',   r.id,
        'shuttleId',       r.shuttle_id,
        'serviceName',     s.name,
        'businessName',    b.name,
        'businessPhone',   b.phone,
        'scheduledFor',    r.scheduled_for,
        'durationMinutes', r.duration_minutes,
        'passengers',      r.passengers,
        'priceCents',      r.price_cents,
        'status',          r.status,
        'reason',          r.reason,
        'createdAt',       r.created_at
      ) order by r.scheduled_for desc
    )
    from public.shuttle_reservations r
    join public.shuttle_services s on s.id = r.shuttle_id
    join public.businesses b on b.id = r.business_id
    where r.tenant_id = p_tenant_id
      and r.customer_id = p_customer_id
      and (p_status is null or r.status = p_status)
  ), '[]'::jsonb);
end
$function$
;

-- ------------------------------------------------------------
-- 6) Empresa: fila de reservas
-- ------------------------------------------------------------
-- Ator e escopo sao os de driver_list_for_business: role de empresa +
-- business_id do proprio ator, com SUPER_ADMIN vendo todas. p_tenant_id e
-- p_actor_user_id chegam da sessao (resolveSession), nunca da query.
--
-- Aqui entra contact_phone e notes: a empresa e a dona da reserva e precisa do
-- telefone para combinar o embarque.
CREATE OR REPLACE FUNCTION public.business_list_shuttle_reservations(
  p_tenant_id     uuid,
  p_actor_user_id uuid,
  p_status        text DEFAULT NULL,
  p_date          date   DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_tz         constant text := 'America/Sao_Paulo';
  v_actor      public.users%rowtype;
begin
  select * into v_actor
    from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'reservationId',   r.id,
        'shuttleId',       r.shuttle_id,
        'serviceName',     s.name,
        'businessName',    b.name,
        'businessPhone',   b.phone,
        'scheduledFor',    r.scheduled_for,
        'durationMinutes', r.duration_minutes,
        'passengers',      r.passengers,
        'priceCents',      r.price_cents,
        'status',          r.status,
        'contactPhone',    r.contact_phone,
        'notes',           r.notes,
        'reason',          r.reason,
        'createdAt',       r.created_at,
        'decidedAt',       r.decided_at
      ) order by r.scheduled_for asc
    )
    from public.shuttle_reservations r
    join public.shuttle_services s on s.id = r.shuttle_id
    join public.businesses b on b.id = r.business_id
    where r.tenant_id = p_tenant_id
      -- Escopo: SUPER_ADMIN ve todas; empresa so a propria. E o que impede a
      -- empresa A de ler a fila da empresa B com um id na query.
      and (v_actor.role = 'SUPER_ADMIN' or r.business_id = v_actor.business_id)
      and (p_status is null or r.status = p_status)
      -- p_date e dia LOCAL: o mesmo cuidado do agendamento, senao 22:00 do dia
      -- 1 viraria dia 2 no filtro.
      and (p_date is null or (r.scheduled_for at time zone v_tz)::date = p_date)
  ), '[]'::jsonb);
end
$function$
;

-- ------------------------------------------------------------
-- 7) Empresa: decide a reserva
-- ------------------------------------------------------------
-- Transicoes validas:
--   pending  -> confirmed | rejected | cancelled
--   confirmed-> cancelled
-- qualquer outra (pending->completed, rejected->confirm, ...) e
-- INVALID_STATUS_TRANSITION, com 409 no handler.
--
-- Lock na linha da reserva: dois atendentes clicando em "confirmar" ao mesmo
-- tempo nao produzem um historico com dois decidores.
CREATE OR REPLACE FUNCTION public.business_review_shuttle_reservation(
  p_tenant_id      uuid,
  p_actor_user_id  uuid,
  p_reservation_id uuid,
  p_action         text,
  p_reason         text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_actor  public.users%rowtype;
  v_res    public.shuttle_reservations%rowtype;
  v_next   text;
begin
  select * into v_actor
    from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  if p_action is null or p_action not in ('confirm','reject','cancel') then
    raise exception 'ACTION_INVALID';
  end if;

  -- Escopo no mesmo select do lock: reserva de outra empresa nem chega a ser
  -- encontrada.
  select * into v_res
    from public.shuttle_reservations
    where id = p_reservation_id
      and tenant_id = p_tenant_id
      and (v_actor.role = 'SUPER_ADMIN' or business_id = v_actor.business_id)
    for update;
  if v_res.id is null then
    raise exception 'RESERVATION_NOT_FOUND';
  end if;

  v_next := case p_action
              when 'confirm' then 'confirmed'
              when 'reject'  then 'rejected'
              else 'cancelled'
            end;

  if not (
       (v_res.status = 'pending'  and v_next in ('confirmed','rejected','cancelled'))
    or (v_res.status = 'confirmed' and v_next = 'cancelled')
  ) then
    raise exception 'INVALID_STATUS_TRANSITION';
  end if;

  -- Rejeitar sem motivo deixa a fila sem informacao para o cliente; o resto
  -- aceita vazio.
  if v_next = 'rejected' and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;

  update public.shuttle_reservations
    set status = v_next,
        reason = nullif(btrim(coalesce(p_reason, '')), ''),
        decided_by = p_actor_user_id,
        decided_at = now(),
        updated_at = now()
    where id = v_res.id;

  return jsonb_build_object(
    'reservationId', v_res.id,
    'status', v_next
  );
end
$function$
;

-- ------------------------------------------------------------
-- 8) Motorista: agenda do dia
-- ------------------------------------------------------------
-- Credencial = driver_sessions (a mesma de driver-position), com o gate
-- completo: sessao nao expirada + status approved. O driver_id, tenant_id e
-- business_id sao DERIVADOS da sessao aqui dentro — nenhum vem do corpo, e por
-- isso nao ha como pedir a corrida de outro motorista.
--
-- A lista NAO devolve nome nem telefone do cliente (Q6 da spec): e a agenda da
-- rota, nao uma folha de contato de terceiros. Devolve horario, servico,
-- origem -> destino e n de passageiros.
CREATE OR REPLACE FUNCTION public.driver_list_shuttle_runs(
  p_session_token uuid,
  p_date          date DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_tz      constant text := 'America/Sao_Paulo';
  v_drivers public.drivers%rowtype;
  v_day     date;
begin
  select d.* into v_drivers
    from public.driver_sessions s
    join public.drivers d on d.id = s.driver_id
    where s.token = p_session_token
      and s.expires_at > now();
  if v_drivers.id is null then
    raise exception 'SESSION_EXPIRED';
  end if;
  if v_drivers.status <> 'approved' then
    raise exception 'NOT_APPROVED';
  end if;

  v_day := coalesce(p_date, (now() at time zone v_tz)::date);

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'reservationId',   r.id,
        'shuttleId',       r.shuttle_id,
        'serviceName',     s.name,
        'scheduledFor',    r.scheduled_for,
        'durationMinutes', r.duration_minutes,
        'passengers',      r.passengers,
        -- {lat,lng} como em list_shuttle_services/business_list_shuttle_services:
        -- shuttle_services guarda a rota como geography, nao como endereco, e o
        -- front ja sabe desenhar esse par.
        'origin',          jsonb_build_object(
                             'lat', ST_Y(s.origin::geometry),
                             'lng', ST_X(s.origin::geometry)),
        'destination',     jsonb_build_object(
                             'lat', ST_Y(s.destination::geometry),
                             'lng', ST_X(s.destination::geometry)),
        'status',          r.status
      ) order by r.scheduled_for asc
    )
    from public.shuttle_reservations r
    join public.shuttle_services s on s.id = r.shuttle_id
    where r.tenant_id = v_drivers.tenant_id
      -- "da sua frota": o servico pertence a um negocio da empresa do motorista.
      and s.business_id = v_drivers.business_id
      and r.status in ('confirmed','completed')
      and (r.scheduled_for at time zone v_tz)::date = v_day
  ), '[]'::jsonb);
end
$function$
;

-- ------------------------------------------------------------
-- 9) Motorista: conclui a corrida
-- ------------------------------------------------------------
-- confirmed -> completed, e so se a corrida for de um servico da empresa dele.
-- Q7 da spec: a empresa tambem pode concluir na mao; aqui so o motorista.
CREATE OR REPLACE FUNCTION public.driver_complete_shuttle_reservation(
  p_session_token   uuid,
  p_reservation_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_drivers public.drivers%rowtype;
  v_res     public.shuttle_reservations%rowtype;
begin
  select d.* into v_drivers
    from public.driver_sessions s
    join public.drivers d on d.id = s.driver_id
    where s.token = p_session_token
      and s.expires_at > now();
  if v_drivers.id is null then
    raise exception 'SESSION_EXPIRED';
  end if;
  if v_drivers.status <> 'approved' then
    raise exception 'NOT_APPROVED';
  end if;

  if p_reservation_id is null then
    raise exception 'BAD_REQUEST';
  end if;

  -- Escopo + lock num passo so: corrida de outra frota nem aparece.
  select r.* into v_res
    from public.shuttle_reservations r
    join public.shuttle_services s on s.id = r.shuttle_id
    where r.id = p_reservation_id
      and r.tenant_id = v_drivers.tenant_id
      and s.business_id = v_drivers.business_id
    for update of r;
  if v_res.id is null then
    raise exception 'RESERVATION_NOT_FOUND';
  end if;

  if v_res.status <> 'confirmed' then
    raise exception 'INVALID_STATUS_TRANSITION';
  end if;

  update public.shuttle_reservations
    set status = 'completed',
        completed_at = now(),
        updated_at = now()
    where id = v_res.id;

  return jsonb_build_object(
    'reservationId', v_res.id,
    'status', 'completed',
    'completedAt', now()
  );
end
$function$
;

-- ------------------------------------------------------------
-- 10) RPCs existentes que mudam
-- ------------------------------------------------------------
-- DROP antes de CREATE, e nao CREATE OR REPLACE: a assinatura muda
-- (p_duration_minutes entra no fim), e no PostgreSQL isso criaria uma SOBRECARGA
-- — as duas versoes convivendo, e a versao antiga ficaria com o ACL antigo
-- (aberta para PUBLIC). Mesmo cuidado de driver_list_for_business, em
-- modulo4-motoristas.sql:707.

-- 10.1) Salvar servico: + duracao da corrida
DROP FUNCTION IF EXISTS public.business_save_shuttle_service(
  uuid, uuid, uuid, text, text, text, double precision, double precision,
  double precision, double precision, jsonb, integer, time, time, smallint[]
);

CREATE OR REPLACE FUNCTION public.business_save_shuttle_service(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_service_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_service_type text DEFAULT 'shuttle',
  p_origin_lat double precision DEFAULT NULL,
  p_origin_lng double precision DEFAULT NULL,
  p_dest_lat double precision DEFAULT NULL,
  p_dest_lng double precision DEFAULT NULL,
  p_stops jsonb DEFAULT '[]'::jsonb,
  p_price_cents integer DEFAULT NULL,
  p_opens_at time DEFAULT NULL,
  p_closes_at time DEFAULT NULL,
  p_active_days smallint[] DEFAULT NULL,
  -- Novo no fim, com DEFAULT: a assinatura antiga continua valendo para quem
  -- ja chama sem o parametro. NULL mantem o que o servico ja tem.
  p_duration_minutes integer DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
  v_geo geography;
  v_id uuid;
  v_days smallint[] := coalesce(p_active_days, '{0,1,2,3,4,5,6}'::smallint[]);
  v_day smallint;
  v_duration integer;
begin
  -- Ator: usuario do proprio tenant, vinculado a um estabelecimento.
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'FORBIDDEN';
  end if;
  if v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'NAME_REQUIRED';
  end if;
  if p_service_type is null or p_service_type not in ('shuttle','transfer','tour') then
    raise exception 'INVALID_TYPE';
  end if;
  if p_origin_lat is null or p_origin_lng is null
     or p_origin_lat < -90 or p_origin_lat > 90
     or p_origin_lng < -180 or p_origin_lng > 180
     or p_dest_lat is null or p_dest_lng is null
     or p_dest_lat < -90 or p_dest_lat > 90
     or p_dest_lng < -180 or p_dest_lng > 180 then
    raise exception 'INVALID_COORDS';
  end if;
  if p_stops is null or jsonb_typeof(p_stops) <> 'array' then
    raise exception 'INVALID_STOPS';
  end if;
  if p_price_cents is not null and p_price_cents < 0 then
    raise exception 'INVALID_PRICE';
  end if;
  if p_opens_at is not null and p_closes_at is not null and p_closes_at < p_opens_at then
    raise exception 'INVALID_HOURS';
  end if;

  -- active_days: so 0..6, sem duplicados. Vazio = todos os dias.
  if p_active_days is not null then
    if array_length(p_active_days, 1) = 0 then
      v_days := '{0,1,2,3,4,5,6}'::smallint[];
    else
      foreach v_day in array p_active_days loop
        if v_day is null or v_day < 0 or v_day > 6 then
          raise exception 'INVALID_DAYS';
        end if;
      end loop;
      if (select count(distinct d) = count(*) from unnest(p_active_days) d) is false then
        raise exception 'INVALID_DAYS';
      end if;
      v_days := p_active_days;
    end if;
  end if;

  -- Duracao: 15..720min. Fora disso a janela reservada nao faz sentido (1min
  -- e' erro de digitacao, 12h e' um tour que o dono cadastrou como shuttle).
  if p_duration_minutes is not null then
    if p_duration_minutes < 15 or p_duration_minutes > 720 then
      raise exception 'INVALID_DURATION';
    end if;
    v_duration := p_duration_minutes;
  end if;

  if p_service_id is null then
    insert into public.shuttle_services (
      tenant_id, business_id, name, description, service_type,
      origin, destination, stops, price_cents, opens_at, closes_at,
      active_days, duration_minutes
    ) values (
      p_tenant_id, v_actor.business_id, btrim(p_name), p_description, p_service_type,
      ST_SetSRID(ST_MakePoint(p_origin_lng, p_origin_lat), 4326)::geography,
      ST_SetSRID(ST_MakePoint(p_dest_lng, p_dest_lat), 4326)::geography,
      p_stops, p_price_cents, p_opens_at, p_closes_at, v_days,
      coalesce(v_duration, 60)
    )
    returning id into v_id;
  else
    -- So o dono edita o proprio servico.
    if not exists (
      select 1 from public.shuttle_services s
      where s.id = p_service_id
        and s.tenant_id = p_tenant_id
        and s.business_id = v_actor.business_id
    ) then
      raise exception 'FORBIDDEN';
    end if;
    update public.shuttle_services set
      name = btrim(p_name),
      description = p_description,
      service_type = p_service_type,
      origin = ST_SetSRID(ST_MakePoint(p_origin_lng, p_origin_lat), 4326)::geography,
      destination = ST_SetSRID(ST_MakePoint(p_dest_lng, p_dest_lat), 4326)::geography,
      stops = p_stops,
      price_cents = p_price_cents,
      opens_at = p_opens_at,
      closes_at = p_closes_at,
      active_days = v_days,
      duration_minutes = coalesce(v_duration, duration_minutes),
      updated_at = now()
    where id = p_service_id
    returning id into v_id;
  end if;

  return jsonb_build_object('shuttleId', v_id);
end $function$;

-- 10.2) Apagar servico: recusa com reserva viva
-- Sem isso, o ON DELETE RESTRICT do FK shuttle_reservations.shuttle_id
-- estouraria como erro generico de FK — o painel mostraria 500 e o cliente
-- perderia o historico sem saber por que. A orientacao de produto e DESATIVAR
-- (business_toggle_shuttle_service) em vez de apagar.
DROP FUNCTION IF EXISTS public.business_delete_shuttle_service(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.business_delete_shuttle_service(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_service_id uuid
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
  v_deleted boolean := false;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  -- Reserva viva = pendente ou confirmada. Rejeitada, cancelada e concluida
  -- nao bloqueiam: sao historico, e historico nao impede desativar/apagar.
  if exists (
    select 1 from public.shuttle_reservations r
    where r.shuttle_id = p_service_id
      and r.status in ('pending','confirmed')
  ) then
    raise exception 'SHUTTLE_HAS_RESERVATIONS';
  end if;

  delete from public.shuttle_services
  where id = p_service_id
    and tenant_id = p_tenant_id
    and business_id = v_actor.business_id
  returning true into v_deleted;

  if v_deleted is not true then
    raise exception 'FORBIDDEN';
  end if;
  -- vehicle_positions.shuttle_id tem ON DELETE SET NULL: veiculos que apontavam
  -- para o servico apagado seguem visiveis, apenas sem rotulo de servico.
  return v_deleted;
end $function$;

-- ------------------------------------------------------------
-- 11) Acessos: so o service_role executa (mesmo padrao do projeto)
-- ------------------------------------------------------------
-- Cada REVOKE/GRANT nomeia a assinatura EXATA. Para as duas funcoes
-- recriadas na secao 10 sao as assinaturas novas; se divergirem, o comando
-- falha em vez de silenciosamente nao revogar nada.
REVOKE ALL ON FUNCTION public.shuttle_create_reservation(uuid,uuid,uuid,timestamptz,integer,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shuttle_cancel_reservation(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shuttle_list_customer_reservations(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.business_list_shuttle_reservations(uuid,uuid,text,date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.business_review_shuttle_reservation(uuid,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.driver_list_shuttle_runs(uuid,date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.driver_complete_shuttle_reservation(uuid,uuid) FROM PUBLIC, anon, authenticated;

GRANT  EXECUTE ON FUNCTION public.shuttle_create_reservation(uuid,uuid,uuid,timestamptz,integer,text,text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.shuttle_cancel_reservation(uuid,uuid,uuid,text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.shuttle_list_customer_reservations(uuid,uuid,text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.business_list_shuttle_reservations(uuid,uuid,text,date) TO service_role;
GRANT  EXECUTE ON FUNCTION public.business_review_shuttle_reservation(uuid,uuid,uuid,text,text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.driver_list_shuttle_runs(uuid,date) TO service_role;
GRANT  EXECUTE ON FUNCTION public.driver_complete_shuttle_reservation(uuid,uuid) TO service_role;

-- As duas recriadas na secao 10 (DROP + CREATE reabre o ACL — por isso a
-- assinatura nova tem que aparecer aqui).
REVOKE ALL ON FUNCTION public.business_save_shuttle_service(uuid,uuid,uuid,text,text,text,double precision,double precision,double precision,double precision,jsonb,integer,time,time,smallint[],integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.business_delete_shuttle_service(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;

GRANT  EXECUTE ON FUNCTION public.business_save_shuttle_service(uuid,uuid,uuid,text,text,text,double precision,double precision,double precision,double precision,jsonb,integer,time,time,smallint[],integer) TO service_role;
GRANT  EXECUTE ON FUNCTION public.business_delete_shuttle_service(uuid,uuid,uuid) TO service_role;

-- ------------------------------------------------------------
-- 12) Fim do modulo de agendamento
-- ------------------------------------------------------------
-- FALTA RODAR (Regra 4/5, coordinate com o dono):
--   1) este arquivo
--   2) supabase/close-function-exec.sql e conferir app_ainda_abertas = 0
--   3) advisors de security e performance: nenhum aviso novo
-- DROP + CREATE na secao 10 reabre o ACL das duas funcoes alteradas; e
-- exatamente por isso que o passo 2 nao e opcional.
