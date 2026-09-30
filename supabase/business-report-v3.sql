-- ============================================================
-- business_report_v3 - Relatorio de performance da empresa
-- ------------------------------------------------------------
-- RODE NO SQL EDITOR (ainda NAO aplicada nesta leva).
-- Idempotente: pode rodar varias vezes.
--
-- POR QUE UMA FUNCAO NOVA E NAO UM `business_report` NOVO:
-- `DROP FUNCTION` + `CREATE` zera o ACL da funcao e reabre EXECUTE para
-- PUBLIC/anon/authenticated (Regra 4 do AGENTS.md, ja aconteceu com
-- admin_driver_reset_pin). `business_report` esta em producao servindo outra
-- finalidade, entao ela fica intacta: a v3 e aditiva e nasce fechada, e o
-- handler degrada para a v2 enquanto esta migracao nao estiver aplicada
-- (fallback por `function ... does not exist`, com `source` no payload).
--
-- O QUE MUDA EM RELACAO A `business_report` (fix-business-report-v2.sql):
--   * os blocos `totals`/`daily`/`byCampaign`/`byTemplate` sao a MESMA
--     agregacao, copiada na integra - e o que faz os numeros baterem com a aba
--     "Criar e gerenciar ofertas" e com `business_coupon_stats` (acumulado).
--   * + `drivers`  - contagem de frota no MESMO escopo de
--     `driver_list_for_business` (empresa ve os proprios E os independentes),
--     para o relatorio nao discordar da aba Motoristas.
--   * + `billing`  - plano/status/fees do negocio + valor COBRADO no periodo
--     (`billing_charges`). "Valor" aqui e taxa cobrada, nao desconto concedido.
--   * + `shuttle`  - servicos do negocio + veiculos reportando posicao.
--   * + `rides`    - slot reservado, sempre `null` (modulo de agendamento).
--
-- ATOR: resolvido por `p_actor_user_id`. `p_business_id` NAO existe nesta
-- assinatura de proposito - e o que impede o endpoint de repassar um id de
-- cliente e abrir um IDOR.
--
-- PII: nenhum nome/telefone/e-mail de cliente sai daqui. Zero dado de cliente
-- no payload do relatorio.
--
-- Dependencias (todas ja em producao): users, businesses, coupons, campaigns,
-- coupon_templates, drivers, driver_documents, shuttle_services,
-- vehicle_positions, billing_charges.
-- ============================================================

-- ------------------------------------------------------------
-- 1) A funcao
-- ------------------------------------------------------------
-- `CREATE OR REPLACE` (sem DROP) mantem o ACL: a v3 nunca fica executavel
-- pelo cliente, desde que a secao 3 seja rodada junto.
CREATE OR REPLACE FUNCTION public.business_report_v3(
  p_tenant_id     uuid,
  p_actor_user_id uuid,
  p_de            timestamptz DEFAULT NULL,
  p_ate           timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
SET search_path = public, extensions
AS $function$
declare
  v_actor    users%rowtype;
  v_business businesses%rowtype;
  v_de       timestamptz;
  v_ate      timestamptz;
begin
  -- ---------- ator: o unico caminho de autoridade ----------
  select * into v_actor
  from users
  where id = p_actor_user_id and tenant_id = p_tenant_id;

  if not found then
    raise exception 'FORBIDDEN: ator nao pertence a este tenant';
  end if;

  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN: papel sem acesso ao relatorio';
  end if;

  -- Sem negocio nao ha escopo proprio para agregar. O endpoint ja recusa
  -- ator sem businessId com 400 antes de chegar aqui; o raise cobre o resto.
  if v_actor.business_id is null then
    raise exception 'BUSINESS_NOT_FOUND: ator nao vinculado a um negocio';
  end if;

  select * into v_business
  from businesses
  where id = v_actor.business_id and tenant_id = p_tenant_id;

  if not found then
    raise exception 'BUSINESS_NOT_FOUND: negocio do ator nao existe neste tenant';
  end if;

  -- Periodo default: ultimos 30 dias (mesmo default de business_report).
  v_de  := coalesce(p_de,  now() - interval '30 days');
  v_ate := coalesce(p_ate, now());

  return jsonb_build_object(
    'period', jsonb_build_object('from', v_de, 'to', v_ate),

    -- ============================================================
    -- totals - MESMA agregacao de business_report (v2)
    -- ============================================================
    'totals', (
      select jsonb_build_object(
        'issued',        count(*),
        'validated',     count(*) filter (where c.validated_at is not null),
        'available',     count(*) filter (where c.validated_at is null),
        'conversionPct', case when count(*) = 0 then 0
                              else round(100.0 * count(*) filter (where c.validated_at is not null) / count(*), 1)
                             end,
        -- Clientes ATRIBUIVEIS a esta empresa: os que resgataram cupom dela no
        -- periodo. Clientes nao tem business_id, entao a unica atribuicao
        -- confiavel e via cupom; "first_seen" = primeira vez que este cliente
        -- apareceu na empresa (nao re-conta se ja era cliente antes no periodo).
        'newCustomers',  (
          select count(*) from (
            select c2.customer_id
            from coupons c2
            where c2.tenant_id = p_tenant_id
              and c2.business_id = v_business.id
              and c2.customer_id is not null
              and c2.issued_at >= v_de and c2.issued_at <= v_ate
            group by c2.customer_id
            having min(c2.issued_at) >= v_de
          ) nc
        ),
        -- Total de clientes unicos que ja resgataram desta empresa (nao
        -- limitado ao periodo) - denominador de fidelizacao.
        'totalCustomers', (
          select count(distinct c3.customer_id)
          from coupons c3
          where c3.tenant_id = p_tenant_id
            and c3.business_id = v_business.id
            and c3.customer_id is not null
        ),
        -- Quantos desses clientes voltaram (resgataram 2+ vezes).
        'returningCustomers', (
          select count(*) from (
            select c4.customer_id
            from coupons c4
            where c4.tenant_id = p_tenant_id
              and c4.business_id = v_business.id
              and c4.customer_id is not null
            group by c4.customer_id
            having count(*) > 1
          ) rc
        )
      )
      from coupons c
      where c.tenant_id = p_tenant_id
        and c.business_id = v_business.id
        and c.issued_at  >= v_de
        and c.issued_at  <= v_ate
    ),

    -- ============================================================
    -- daily - MESMA agregacao de business_report (v2)
    -- ============================================================
    'daily', (
      select coalesce(jsonb_agg(
        jsonb_build_object('day', d.dia, 'issued', d.emitidos, 'validated', d.validados)
        order by d.dia
      ), '[]'::jsonb)
      from (
        select
          date_trunc('day', c.issued_at)::date as dia,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_business.id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) d
    ),

    -- ============================================================
    -- byCampaign - MESMA agregacao de business_report (v2)
    -- ============================================================
    'byCampaign', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'campaignId', g.campanha_id,
          'title',      coalesce(camp.title, 'Sem campanha'),
          'issued',     g.emitidos,
          'validated',  g.validados
        ) order by g.emitidos desc
      ), '[]'::jsonb)
      from (
        select
          c.campaign_id as campanha_id,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_business.id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) g
      left join campaigns camp on camp.id = g.campanha_id
    ),

    -- ============================================================
    -- byTemplate - MESMA agregacao de business_report (v2)
    -- ============================================================
    'byTemplate', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'templateId', t.template_id,
          'title',      coalesce(ct.title, 'Sem cupom'),
          'issued',     t.emitidos,
          'validated',  t.validados
        ) order by t.emitidos desc
      ), '[]'::jsonb)
      from (
        select
          c.template_id,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_business.id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) t
      join coupon_templates ct on ct.id = t.template_id
    ),

    -- ============================================================
    -- drivers - NOVO
    -- O predicado de escopo e o MESMO de driver_list_for_business: a empresa
    -- ve os proprios motoristas E os independentes (business_id is null), que
    -- sao os que ela pode aprovar. Contar so os proprios faria o relatorio
    -- discordar da aba Motoristas.
    -- ============================================================
    'drivers', (
      select jsonb_build_object(
        'total',    count(*),
        'approved', count(*) filter (where d.status = 'approved'),
        'pending',  count(*) filter (where d.status = 'pending'),
        'rejected', count(*) filter (where d.status = 'rejected'),
        -- Documentos ainda nao revisados (nao sao os mesmos do motorista
        -- pendente: um doc pode ficar na fila depois da decisao).
        'documentsPending', (
          select count(*)
          from driver_documents dd
          where dd.tenant_id = p_tenant_id
            and dd.status = 'pending'
            and dd.driver_id in (
              select d2.id from drivers d2
              where d2.tenant_id = p_tenant_id
                and (
                  v_actor.role = 'SUPER_ADMIN'
                  or d2.business_id is null
                  or d2.business_id = v_business.id
                )
            )
        )
      )
      from drivers d
      where d.tenant_id = p_tenant_id
        and (
          v_actor.role = 'SUPER_ADMIN'
          or d.business_id is null
          or d.business_id = v_business.id
        )
    ),

    -- ============================================================
    -- billing - NOVO
    -- `chargedCents` e a TAXA COBRADA no periodo (billing_charges), tanto a
    -- taxa por resgate (coupon_id preenchido) quanto a assinatura recorrente
    -- (coupon_id NULL, dedupe por provider_payment_id). Nao e desconto
    -- concedido ao cliente: nao ha fonte confiavel para isso.
    --
    -- billing_subscription_url NAO sai daqui: quem abre o checkout e o endpoint
    -- `billing` (POST { action:'status' }), que tambem e quem fala com o MP.
    -- ============================================================
    'billing', (
      select jsonb_build_object(
        'plan',             v_business.billing_plan,
        'status',           v_business.billing_status,
        'monthlyFeeCents',  v_business.monthly_fee_cents,
        'feePerCouponCents', v_business.billing_fee_cents,
        'chargedCents', coalesce((
          select sum(bc.amount_cents) from billing_charges bc
          where bc.tenant_id = p_tenant_id
            and bc.business_id = v_business.id
            and bc.created_at >= v_de
            and bc.created_at <= v_ate
        ), 0),
        'charges', coalesce((
          select count(*) from billing_charges bc
          where bc.tenant_id = p_tenant_id
            and bc.business_id = v_business.id
            and bc.created_at >= v_de
            and bc.created_at <= v_ate
        ), 0)
      )
    ),

    -- ============================================================
    -- shuttle - NOVO
    -- "Corridas" NAO entram aqui: nao existe tabela de reservas/viagens. O
    -- veiculo conta como "reportando" com a MESMA janela de frescor de
    -- list_live_vehicles (p_max_age_s = 300s), senao o numero contaria
    -- veiculos parados a noite como se estivem ao vivo.
    -- ============================================================
    'shuttle', (
      select jsonb_build_object(
        'services', (
          select count(*) from shuttle_services s
          where s.tenant_id = p_tenant_id
            and s.business_id = v_business.id
        ),
        'activeServices', (
          select count(*) from shuttle_services s
          where s.tenant_id = p_tenant_id
            and s.business_id = v_business.id
            and s.is_active
        ),
        'vehiclesReporting', (
          select count(*)
          from vehicle_positions vp
          join shuttle_services s on s.id = vp.shuttle_id
          where s.tenant_id = p_tenant_id
            and s.business_id = v_business.id
            and vp.recorded_at > now() - interval '5 minutes'
        )
      )
    ),

    -- ============================================================
    -- rides - slot reservado para o modulo de agendamento.
    -- `null` explicito: ausencia de dado dita, nunca zero inventado.
    -- ============================================================
    'rides', null
  );
end $function$
;

-- ------------------------------------------------------------
-- 2) Indice de apoio: a consulta do periodo e por
--    (business_id, created_at). Hoje so existe idx_billing_charges_business_id
--    (business_id), que nao serve para um range de data - sem este indice o
--    relatorio de 7 dias faz seq scan da tabela de cobrancas a cada chamada.
--    IF NOT EXISTS: rodar de novo nao faz nada.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS billing_charges_business_created_idx
  ON public.billing_charges (business_id, created_at DESC);

-- ------------------------------------------------------------
-- 3) ACL: fecha EXECUTE. Funcao nova nasce com `=X` para PUBLIC (Regra 4);
--    so o REVOKE explicito no objeto fecha.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.business_report_v3(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.business_report_v3(uuid, uuid, timestamptz, timestamptz) TO service_role;

-- ------------------------------------------------------------
-- 4) Verificacao (Regra 5: aclexplode, nunca proacl::text ILIKE)
--    aberta_ao_cliente tem que ser 0.
--    Compare com `business_report` (a v2, que segue em producao) para ver que
--    a v3 nao abriu nada.
-- ------------------------------------------------------------
SELECT p.proname,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) x
         WHERE x.privilege_type = 'EXECUTE'
           AND x.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)
       )) AS aberta_ao_cliente
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('business_report_v3','business_report')
 GROUP BY p.proname
 ORDER BY p.proname;

-- ------------------------------------------------------------
-- 5) Fim
-- ------------------------------------------------------------
-- Apos aplicar: rodar supabase/close-function-exec.sql e conferir
-- `app_ainda_abertas = 0`.
-- Conferir o retorno com um MERCHANT de verdade:
--   select jsonb_pretty(business_report_v3(
--     '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9',
--     (select id from users where role='MERCHANT' and business_id is not null limit 1),
--     now() - interval '30 days', now()
--   ));
-- Esperado: period/totals/daily/byCampaign/byTemplate/drivers/billing/shuttle
-- presentes e `rides` = null.
