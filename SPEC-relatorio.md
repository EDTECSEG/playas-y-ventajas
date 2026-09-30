# Spec: Relatório de Performance da Empresa

> Módulo `relatorio-empresa` — aba de desempenho da empresa em `/empresa`.
> Data: 29/09/2026. Repo: `pyv-web` (Next.js 14 + Cloudflare Pages Worker/Advanced Mode + Supabase Postgres).
> Escopo desta leva: **somente leitura**. Nenhuma escrita, nenhum novo endpoint, nenhuma rota nova no Worker.

## Objetivo

A empresa autenticada em `/empresa` passa a ver, num lugar só e por período, o desempenho do
próprio negócio: resgates, valores, quebra por campanha/cupom, frota de motoristas, situação
de assinatura e (quando existir módulo de agendamento) corridas de translado.

O relatório é **do negócio da sessão, do período pedido e de mais nada** — sem dado de
cliente (nome/telefone/e-mail) no payload, sem IDOR e sem inventar agregação que já exista.

### Critérios de aceite mensuráveis

1. `GET /.netlify/functions/empresa?mode=report` sem `Authorization` → **401** `SESSION_REQUIRED`;
   token expirado → **401** `SESSION_EXPIRED`. Nunca 200 (Regra 3 do `AGENTS.md`).
2. A chamada ao banco usa **exclusivamente** `p_tenant_id` e `p_actor_user_id` vindos de
   `resolveSession`. Um `businessId`/`tenantId` enviado no cliente é **ignorado** (não lido).
3. `from`/`to`/`days` inválidos (data não-ISO, `from > to`, janela > 366 dias) → **400**
   `INVALID_PERIOD`; ausentes → últimos 30 dias (comportamento de `business_report`).
4. Toda métrica do relatório tem **uma** fonte de verdade já existente, listada em
   "Fontes de verdade por métrica". Nenhuma métrica é recalculada no browser.
5. O corpo da resposta **não** contém `customerName`, `customerPhone`, `email`, `cpnj`, `pin`
   nem `token`. Teste automatizado faz essa asserção.
6. Erros de regra do banco voltam como **código**, nunca como `error.message` cru:
   `rpcErrorCode`/`rpcErrorStatus` (`FORBIDDEN` → 403).
7. `worker/main.js` `ROUTES` **não muda** (o modo novo nasce dentro do endpoint `empresa`
   já roteado) e `tests/function-contract.test.cjs` continua verde.
8. `npm run build` e `npm test` verdes; nenhuma suite existente quebra
   (baseline: 233 testes / 227 passando / 0 falhas / 6 pulados).

## Integrações existentes a tocar

| Camada | Arquivo | O que já existe | O que este módulo faz |
| --- | --- | --- | --- |
| Endpoint (CJS, canônico) | `netlify/functions/empresa.js` | `GET` com `mode=stats` / `my-data` / `shuttles` e default `empresa_dashboard`; guarda `if (!actor.businessId) → 400` antes dos modes | Novo ramo `mode === 'report'` depois de `shuttles`, com o mesmo padrão de erro (`rpcErrorCode`/`rpcErrorStatus`) |
| Sessão | `netlify/functions/_supabaseAdmin.js` | `resolveSession`, `extractSessionToken`, `rpcErrorCode`, `rpcErrorStatus` | Reusar sem alterar (é o único helper de sessão; o par CJS/ESM foi eliminado em 2026-09-30) |
| Painel | `app/empresa/page.jsx` | Abas por `useState('tab')` com carregamento preguiçoso (`loadShuttles`, `loadDrivers`), `card`/`btn`/`smallBtn`/`input` do tema, i18n com fallback `t.x ?? 'texto'` | Nova aba `'relatorio'` + `loadReport(s, days)` seguindo exatamente o padrão das abas existentes |
| i18n | `lib/i18n.js` | Blocos pt/en/es | Chaves novas (mínimo: fallback `t.reportTab ?? '📈 Relatório'`, como `tabShuttles`/`tabDrivers`) |
| Banco (já aplicada, **sem `.sql` no repo**) | `business_report(p_tenant_id, p_actor_user_id, p_de, p_ate)` | Já devolve `period`, `totals` (issued/validated/available/conversionPct/newCustomers/totalCustomers/returningCustomers), `daily`, `byCampaign`, `byTemplate`. Está no `fix-business-report-v2.sql` e listada no `RELATORIO-FUNCIONALIDADES.md` §7, **mas nenhum handler a chama hoje** | Passa a ser a fonte do relatório — sem reescrever agregação de resgate |
| Banco (produção) | `business_coupon_stats(p_tenant_id, p_business_id)` | `totalIssued/totalValidated/totalAvailable/totalExpired/totalBilledCents` (acumulado, sem período) | Mantida em `mode=stats`; serve de conferência e de valor **acumulado** |
| Banco (produção) | `driver_list_for_business(p_tenant_id, p_actor_user_id, p_status)` | Lista da frota com documentos, escopo "empresa vê os próprios + independentes" | Fonte da lista da aba Motoristas; as **contagens** do relatório precisam usar o mesmo escopo |
| Banco (produção) | `empresa_dashboard(p_tenant_id, p_business_id)` | Campanhas, templates, lista de resgates (com `customerName`/`customerPhone`) | Intocado; é a origem do card "Estatísticas" e da tabela de resgates existentes. **Não** expandir para o relatório (PII) |
| Banco (`p2-taxa-por-cupom.sql`, `billing-mercadopago-subscriptions.sql`) | `billing_charges(tenant_id, business_id, coupon_id, amount_cents, created_at, provider, provider_payment_id)` | Taxa por resgate (`coupon_id` preenchido) e cobrança recorrente (`coupon_id` NULL, dedupe por `provider_payment_id`) | Soma/contagem por período dentro da RPC nova |
| Banco (`p2-taxa-por-cupom.sql`) | `businesses.billing_plan/billing_status/monthly_fee_cents/billing_fee_cents` | Plano e valores; `billing_subscription_id/url` | Bloco de assinatura, lido no banco com escopo do ator |
| Endpoint `billing` | `netlify/functions/billing.js` | `POST { action:'status' }` → `{ subscriptionId, subscriptionUrl }` (o segredo do MP nunca sai) | Reutilizado **como está** para o botão de checkout/assinatura; o relatório não duplica nada disso |
| Banco (Módulo 1) | `shuttle_services`, `vehicle_positions` | Serviços de translado do negócio e posições reportadas; **não existe** tabela de reservas/corridas | Só o que é contável hoje; corridas ficam estocadas |
| Worker | `worker/main.js` | Whitelist `ROUTES` | **Nenhuma alteração** (endpoint já roteado) |

## Mudanças propostas (RPC/endpoint, sem SQL)

### Endpoint — `mode=report`

Branco novo em `GET` do handler `empresa`, nos **dois dialetos**, inserido depois de
`mode=shuttles` (mesma ordem de checagem, para não alterar o comportamento dos modos atuais).

Sequência do ramo (sem código aqui, apenas a ordem de decisões):

1. `resolveSession(...)` — já ocorre antes de qualquer mode. Mantido.
2. `if (!actor.businessId) → 400 'ator não vinculado a um estabelecimento'` — mantida.
3. Ler `from`, `to`, `days` da query string. Normalizar:
   - `days` alone → `p_de = now() - days`, `p_ate = now()`.
   - `from`/`to` em ISO (`YYYY-MM-DD` ou ISO-8601) → repassados como `timestamptz`.
   - nada → 30 dias (default do banco).
   - Recusar: data não parseável, `from > to`, janela > 366 dias → `400 INVALID_PERIOD`.
     A validação é no handler (entrada do cliente) — o banco continua sendo a authority.
4. Chamar **uma** RPC com `p_tenant_id: actor.tenantId`, `p_actor_user_id: actor.userId`,
   `p_de`, `p_ate`. **Nunca** `p_business_id` vindo do cliente.
5. Se a RPC nova ainda não existir em produção (erro do Postgres do tipo
   *function does not exist*), degradar para `business_report` e marcar `source` no payload.
   Isso permite subir a aba antes da migração sem 500.
6. `if (error) → { statusCode: rpcErrorStatus(error), error: rpcErrorCode(error) }`.
   Sem `error.message` cru (diferente do `mode=stats`, que hoje vaza texto do banco — ver
   "Perguntas em aberto").
7. Devolver 200 com o objeto do relatório, acrescentando `period.days`.

Sem `POST` novo. Sem rota nova em `ROUTES`. Sem helper novo (helper em `netlify/functions/`
viraria rota — ver `function-contract.test.cjs`).

### Banco — RPCs previstas (a criar; **não criadas nesta leva**)

| RPC | Arquivo `.sql` previsto | Assinatura | Papel |
| --- | --- | --- | --- |
| `business_report_v3` | `supabase/business-report-v3.sql` | `(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamptz DEFAULT NULL, p_ate timestamptz DEFAULT NULL) RETURNS jsonb` | Versão **aditiva** de `business_report`: mesmo nome de bloco `totals`/`daily`/`byCampaign`/`byTemplate` (mesma agregação, mesmo período) + blocos novos `drivers`, `billing`, `shuttle`. `STABLE SECURITY DEFINER`, `search_path = public, extensions`, ator resolvido por `p_actor_user_id` (nunca `business_id` do cliente), `raise exception 'CODIGO: detalhe'`, `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE ... TO service_role` |
| (dependência, não nova) `business_report` | já em produção | idem | Fonte do fallback e referência de formato |
| (índice, opcional) | dentro do mesmo `.sql` | — | `CREATE INDEX IF NOT EXISTS billing_charges_business_created_idx ON billing_charges (business_id, created_at DESC)` — só se `EXPLAIN` mostrar seq scan; hoje existe só `idx_billing_charges_business_id` |

Por que `business_report_v3` e não sobrescrever `business_report`: `DROP` + `CREATE` **zera o
ACL** da função e reabre execução para `anon`/`authenticated` (Regra 4 do `AGENTS.md`, já
aconteceu com `admin_driver_reset_pin`). Uma função **nova** com nome novo nasce fechada por
padrão do projeto e não mexe na que está em produção servindo outra finalidade.

Dependências que a RPC usa (todas já existentes, nenhuma criada aqui): `users`, `businesses`,
`coupons`, `campaigns`, `coupon_templates`, `drivers`, `driver_documents`, `shuttle_services`,
`vehicle_positions`, `billing_charges`. Índices de apoio já existentes:
`coupons_business_issued_idx`, `coupons_tenant_issued_idx`, `shuttle_services_business_idx`.

Depois de aplicar o `.sql`: rodar `supabase/close-function-exec.sql` e conferir
`app_ainda_abertas = 0` (Regra 4).

### O que a RPC nova acrescenta (e de onde vem cada campo)

- `drivers`: `total`, `approved`, `pending`, `rejected` (e `documentsPending`) contados de
  `drivers`/`driver_documents` com o **mesmo predicado de escopo** de
  `driver_list_for_business` (empresa vê `business_id = ator.business_id` **ou**
  `business_id is null`). Sem isso, o número do relatório discordaria da aba Motoristas.
- `billing`: `plan`, `status`, `monthlyFeeCents`, `feePerCouponCents` (de `businesses`) +
  `chargedCents` e `charges` do período (`sum(amount_cents)`, `count(*)` em `billing_charges`
  filtrado por `business_id` e `created_at` no intervalo). **Não** expor
  `billing_subscription_url` aqui — quem abre o checkout é o endpoint `billing`.
- `shuttle`: `services`, `activeServices` (`shuttle_services` do negócio),
  `vehiclesReporting` (`vehicle_positions`Fresh ligado aos serviços do negócio). Sem
  "corridas": não existe tabela de reservas/viagens.
- `rides`: sempre `null` nesta leva (slot reservado para o módulo de agendamento).

## API (contrato do `mode report`)

```
GET /.netlify/functions/empresa?mode=report&days=30
GET /.netlify/functions/empresa?mode=report&from=2026-09-01&to=2026-09-29
Authorization: Bearer <sessionToken>
```

Parâmetros (query string):

| Param | Formato | Default | Regra |
| --- | --- | --- | --- |
| `mode` | `report` | — | valor literal; qualquer outro valor cai no comportamento atual (default = `empresa_dashboard`) |
| `days` | inteiro 1..366 | `30` | usado quando `from`/`to` não vêm |
| `from` | `YYYY-MM-DD` ou ISO-8601 | `now() - 30d` | junto com `to`; `from > to` → 400 |
| `to` | `YYYY-MM-DD` ou ISO-8601 | `now()` | idem |

Resposta 200 (síntese do contrato, não é código):

```
{ period: { from, to, days },
  source: "business_report_v3" | "business_report",
  totals:  { issued, validated, available, conversionPct, newCustomers, totalCustomers, returningCustomers },
  daily:   [ { day, issued, validated } ],
  byCampaign: [ { campaignId, title, issued, validated } ],
  byTemplate: [ { templateId, title, issued, validated } ],
  drivers: { total, approved, pending, rejected, documentsPending },
  billing: { plan, status, monthlyFeeCents, feePerCouponCents, chargedCents, charges },
  shuttle: { services, activeServices, vehiclesReporting } | null,
  rides:   null }
```

Regras de contrato:

- `daily`, `byCampaign`, `byTemplate` vêm **sempre** como array (vazio quando não há dado) —
  mesmo contrato de `shuttle` (`{ services: [], vehicles: [] }`).
- `shuttle` e `rides` podem ser `null`: ausência de dado é dita explicitamente, nunca
  preenchida com zero inventado.
- Campo novo ausente numa RPC antiga = `undefined`; a UI trata `?? 0` **só na exibição**,
  nunca para recalcular.
- Zero cliente no payload (critério 5).

Erros:

| Situação | Status | `error` |
| --- | --- | --- |
| sem token / token inválido | 401 | `SESSION_REQUIRED` / `SESSION_EXPIRED` |
| ator sem `businessId` | 400 | `ator não vinculado a um estabelecimento` (contrato existente, inalterado) |
| período inválido | 400 | `INVALID_PERIOD` |
| ator não autorizado na RPC | 403 | `FORBIDDEN` |
| regra de negócio do banco | mapeado | `rpcErrorCode` (ex.: `BUSINESS_NOT_FOUND` → 404) |
| erro inesperado | 500 | `erro interno` + `console.error('empresa: ...')` (já existente) |

## UI (janela da aba/ajustes)

- Nova aba `'relatorio'` na fita de botões de `app/empresa/page.jsx`, seguindo o padrão
  exato das outras: `onClick={() => { setTab('relatorio'); loadReport(); }}`.
- Seletor de período: **7 / 30 / 90 dias** (botões ou `<select>` com o mesmo `input` do
  tema). Default 30. Trocar o período recarrega só a aba.
- Estado próprio `report`, `reportBusy`, `reportMsg` (padrão de `shuttles`/`drivers`).
- Layout: linha de cartões de totais (resgates, validados, conversão %, novos clientes);
  série diária como lista/`<table>` simples (o projeto **não** tem lib de gráfico — não
  introduzir dependência); tabela por campanha; tabela por cupom; bloco de motoristas;
  bloco de assinatura.
- Assinatura: cartão mostra plano, status e o valor cobrado no período; o botão de
  assinar/retomar chama `POST /.netlify/functions/billing { action: 'status' }` (e
  `create`/`cancel` quando o dono quiser) — **nenhuma chamada nova ao MP no relatório**.
- Empty states honestos, no idioma do resto: "Nenhum resgate no período", "Nenhum serviço
  de translado cadastrado", "Nenhuma corrida registrada (módulo de agendamento não
  ativo)". Sem cartão com `0` onde não há leitura.
- i18n: chaves em pt/en/es em `lib/i18n.js`; enquanto não existirem em todos os idiomas,
  usar o fallback `t.reportTab ?? '📈 Relatório'`, como já é feito com `tabShuttles`.
- Fora de escopo da UI: gráfico, exportação CSV/PDF, comparação com período anterior,
  metas/benchmark.

## Comandos (build/test verdes)

```bash
npm test                      # node --test "tests/*.test.cjs"
npm run build                 # next build + postbuild (bundle-worker.mjs → out/_worker.js)
```

Ordem do fluxo padrão do `AGENTS.md` (Regras 1–4): backup validado em
`C:\Users\REUNIAO\Desktop\pyv-backups\pyv-web-backup-<data>-<n>.zip` → implementação →
aplicar a migração + `close-function-exec.sql` com `app_ainda_abertas = 0` → `npm test` +
`npm run build` → bateria de segurança → **perguntar "posso fazer o deploy?"** → só com SIM.

Verificações de banco após a migração (SQL Editor): `select * from business_report_v3(...)`
com um MERCHANT real; verificação de ACL com `aclexplode` (nada de `proacl::text ILIKE`,
Regra 5).

## Estratégia de teste

Novo arquivo `tests/empresa-report.test.cjs`, no padrão de `shuttle-manage.test.cjs`:
`makeFakeSupabase` + `actorFake(VALID_ACTORS.merchant, ...)` + `loadFunction('empresa.js', fake)`
+ `makeEvent` + `parseBody`.

Casos (mínimo):

1. sem token → 401 `SESSION_REQUIRED`; token expirado → 401.
2. ator sem `businessId` → 400 (mesma mensagem de hoje).
3. `mode=report` → 200; asserção de que a chamada leva `p_tenant_id`/`p_actor_user_id` do ator
   e `p_de`/`p_ate` derivados de `days`.
4. `from`/`to` explícitos chegam crus como `p_de`/`p_ate`; `from > to` → 400 `INVALID_PERIOD`;
   data inválida → 400; `days=400` → 400.
5. `businessId` enviado pelo cliente é ignorado (a RPC não recebe `p_business_id`).
6. `FORBIDDEN` vindo da RPC → 403 com `error: 'FORBIDDEN'` (só o código, sem detalhe).
7. `business_report_v3` inexistente → cai para `business_report` e devolve
   `source: 'business_report'` (sem 500).
8. O corpo devolvido não contém `customerName`/`customerPhone`/`email`/`pin`/token
   (asserção sobre a string do body).
9. `shuttle`/`rides` nulos são aceitos e repassados como `null` (contrato).
10. Modos existentes (`stats`, `my-data`, `shuttles`, default) continuam idênticos — os testes
    de `empresa.test.cjs` e `shuttle-manage.test.cjs` já cobrem isso e devem seguir verdes.

`tests/function-contract.test.cjs` não precisa de mudança (nenhum arquivo novo em
`netlify/functions/`), e ele é o que garante que todo handler novo exporte
`exports.handler` e que nenhum helper vire rota.

Suíte opcional: nada de `live.smoke` para este módulo; se quiser, um caso `RUN_LIVE=1`
chamando `mode=report` com sessão de produção (somente leitura).

## Fontes de verdade por métrica

| Métrica | Fonte de verdade | Onde |
| --- | --- | --- |
| Resgates/validados/disponíveis/conversão no período | `business_report_v3` → bloco `totals` (ou `business_report` no fallback) | RPC nova (base: agregação idêntica à de `business_report`) |
| Série diária | `business_report_v3` → `daily` | idem |
| Resgates por campanha / por cupom | `business_report_v3` → `byCampaign` / `byTemplate` | idem |
| Acumulado histórico (issued/validated/available/expired) | `business_coupon_stats` (`mode=stats`) | RPC de produção, já consumida pela aba atual |
| Valor total acumulado cobrado | `business_coupon_stats.totalBilledCents` | idem (soma de `billing_charges`, sem período) |
| Valor cobrado **no período** | `business_report_v3` → `billing.chargedCents` (`billing_charges.created_at`) | RPC nova |
| Plano, status e fees | `businesses.billing_plan/billing_status/monthly_fee_cents/billing_fee_cents` | RPC nova (via ator) |
| Assinatura ativa / link de checkout | `POST /billing { action:'status' }` → `billing_mp_prepare` | endpoint `billing.js` (reutilizado, intocado) |
| Lista de motoristas e documentos | `driver-list-for-business` → `driver_list_for_business` | aba Motoristas (reutilizada) |
| Contagem de motoristas (total/aprovados/pendentes) | `business_report_v3` → `drivers`, mesmo escopo da lista acima | RPC nova |
| Serviços de translado do negócio | `mode=shuttles` → `business_list_shuttle_services` | aba Translado (reutilizada) |
| Veículos reportando posição | `business_report_v3` → `shuttle.vehiclesReporting` (`vehicle_positions`) | RPC nova |
| Corridas de translado | **inexistente** — sem tabela de reservas/viagens | módulo de agendamento (futuro) |
| Card de campanhas/templates e lista de resgates | `empresa_dashboard` | aba atual (intocada, tem PII) |

## Fronteiras

**Always**
- Reusar `business_report` / `business_coupon_stats` / `driver_list_for_business` /
  `empresa_dashboard` / `billing.js` antes de qualquer agregação nova; uma métrica sem fonte
  listada não entra no escopo.
- `p_actor_user_id` e `p_tenant_id` sempre vindos de `resolveSession`; nunca do cliente.
- Mesma guarda, mesmo `try/catch`, mesmo `rpcErrorCode`/`rpcErrorStatus` do arquivo.
- Alterar `netlify/functions/*.js` (fonte única; o espelho `functions/.netlify/functions/` foi removido em 2026-09-30).
- Zero PII de cliente no payload; erro = código, nunca `error.message` cru.
- Backup antes (Regra 1), `close-function-exec.sql` ao final (Regra 4), deploy só com
  "SIM" explícito (Regra 2), `npm test` + `npm run build` verdes.

**Ask first**
- Mudar `empresa_dashboard` ou `business_coupon_stats` (produção, sem `.sql` no repo).
- Sobrescrever `business_report`/`admin_report` em vez de criar `business_report_v3`.
- Adicionar códigos novos ao mapa `RPC_ERROR_STATUS` (exige alterar os dois dialetos).
- Introduzir qualquer dependência de UI (gráfico, export).
- Preencher a lacuna de PII que hoje existe em `mode=stats`/`default` (`error.message` cru) —
  é correção de segurança fora deste módulo.
- Tabelas novas (`shuttle_rides`, agendamento) e qualquer coisa de billing que afete o MP.

**Never**
- Ler/escrever `.env` ou `.dev.vars`; tocar em `SUPABASE_SERVICE_ROLE_KEY`, `MP_ACCESS_TOKEN`
  ou `MP_WEBHOOK_SECRET` no cliente.
- Confiar em `businessId`/`userId`/`tenantId` do corpo ou da query.
- Expor `billing_subscription_url`, `pin_hash`, documento do motorista ou o segredo do MP na
  resposta do relatório; documento de motorista segue por URL assinada de 5 min
  (`driver-document-url`).
- Adicionar rota em `worker/main.js` sem handler correspondente (e vice-versa) — a whitelist
  é o roteamento real.
- Criar/aplicar migração, rodar `wrangler pages deploy` ou `git push` nesta tarefa.
- Deletar/renomear RPC de produção a partir deste módulo.

## Critérios de sucesso

- Aba "Relatório" carrega em 1 request autenticado, com período funcional (7/30/90) e números
  batendo com a aba "Criar e gerenciar ofertas" para o mesmo intervalo (mesma agregação).
- Números de motoristas batem com a aba Motoristas (mesmo escopo).
- 401 sem sessão, 400 em período inválido, 403 em ator não autorizado, sem 500 em RPC ausente.
- `npm test` e `npm run build` verdes; `function-contract.test.cjs` confirma o contrato do diretório.
- `close-function-exec.sql` com `app_ainda_abertas = 0` depois da migração.
- `API.md` e `RELATORIO-FUNCIONALIDADES.md` atualizados (rota `mode=report` na seção `/empresa`).

## Perguntas em aberto

1. `business_report` está aplicada e com a v2 (`fix-business-report-v2.sql`) em **produção**?
   O repo a documenta mas não a expõe. Se sim, o fallback da UI é dispensável; se não, a aba
   precisa da `business_report_v3` para funcionar.
2. "Valor" no relatório é **receita cobrada da empresa** (taxa em `billing_charges`) ou
   **valor de desconto concedido** (`coupon_templates.benefit_value` somado aos validados)?
   A spec assume a primeira; a segunda não tem fonte today confiável.
3. Os 7/30 dias podem ser fixos ou o dono quer intervalo de datas customizado na UI?
4. Contagens de motoristas devem seguir o escopo amplo de `driver_list_for_business`
   (próprios + independentes) ou só `business_id = ator.business_id`? A spec assumiu o
   primeiro para não discordar da aba existente.
5. "Negócios/proximidade" no escopo significa só o card de proximidade de `list_offers`
   (sem métrica persistida) ou o dono espera alguma métrica de alcance/vizinhança? Hoje não há
   fonte — se houver expectativa, é módulo novo.
6. "Corridas de translado" fica para o módulo de agendamento? Confirmado: esta leva só deixa o
   slot `rides: null` estocado.
7. Assinatura: o bloco deve ser só leitura (informativo) ou já incluir "assinar/retomar" dentro
   da aba? A spec reaproveita `POST /billing` para o botão, sem novo código de backend.
