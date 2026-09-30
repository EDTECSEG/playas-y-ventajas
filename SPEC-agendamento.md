# Spec: Agendamento de Translado

> Documento de especificação. **Nada aqui foi implementado**: nenhum arquivo existente
> foi alterado, nenhuma SQL foi executada, nenhuma dependência foi adicionada.
> Data: 29/09/2026. Base: `API.md`, `RELATORIO-FUNCIONALIDADES.md`, `AGENTS.md`,
> `worker/main.js` (24 rotas), `package.json` (`node:test`; baseline **233 testes / 227 passando /
> 0 falhas / 6 pulados**, registrado em `RELATORIO-FUNCIONALIDADES.md:90`).

---

## Objetivo

Cliente identificado escolhe um **serviço de translado ativo** + **data/hora** + **nº de passageiros**
e cria uma reserva. A empresa confirma/rejeita/cancela. O motorista aprovado vê as corridas do dia
da sua frota.

### Para quem

| Papel | Ganho concreto |
| --- | --- |
| Cliente (`/cliente`) | Deixa de copiar msg para o WhatsApp: cria a reserva em 3 campos e acompanha o status sem falar com ninguém. |
| Empresa (`/empresa`) | Deixa de ler reservas no WhatsApp/DM: tem fila de pendências com confirmar/rejeitar/cancelar, no mesmo padrão da aba Motoristas. |
| Motorista (`/motorista`) | Deixa de perguntar "qual corrida é a minha?": vê a agenda do dia das reservas confirmadas da sua frota. |

### Escopo

**Dentro:** reserva de translado (criar, listar, decidir, cancelar, concluir, ver do dia).
**Fora (neste pacote):** pagamento, cupom de desconto aplicado à reserva, notificação push/e-mail,
reagendamento automático, multi-tenant real (hoje o `TENANT_ID` é fixo) e avaliação do motorista.

### Critérios de aceite mensuráveis

1. Cliente sem `customerId` **não** consegue criar reserva: a UI oferece o `identify` e o endpoint
   recusa com `401 CUSTOMER_TOKEN_INVALID`.
2. Reserva para serviço inativo, de outro tenant ou inexistente → `404 SHUTTLE_NOT_FOUND`.
3. Reserva fora de `opens_at`/`closes_at` → `400 OUTSIDE_HOURS`; em dia fora de `active_days` → `400 DAY_NOT_ACTIVE`.
4. Reserva que sobreponha outra `pending`/`confirmed` do **mesmo serviço** → `409 SLOT_CONFLICT`;
   não pode existir duplicata mesmo com duas requisições simultâneas.
5. `empresa` só enxerga reservas do próprio `business_id` (derivado da sessão no banco, nunca do corpo).
6. `motorista` sem `status='approved'` → `403 NOT_APPROVED`; com aprovação, só vê reservas
   `confirmed` de serviços do seu `business_id`.
7. Nenhuma resposta de erro carrega `error.message` cru: só o código antes do `':'`
   (`rpcErrorCode`), e 500 devolve literalmente `{"error":"erro interno"}`.
8. Toda resposta com dado pessoal (`/shuttle-reservation`, `empresa?mode=reservations`,
   `driver-shuttle-runs`) leva `Cache-Control: no-store`.
9. `npm test` continua verde e `npm run build` (que roda o `postbuild` → `out/_worker.js`) sem erro.
10. Advisors do Supabase (security) sem aviso novo ligado a estas funções; `app_ainda_abertas = 0`.

---

## Integrações existentes (pontos exatos que serão tocados)

### Banco — reaproveitado, não alterado

| Objeto | Arquivo / origem | O que é usado aqui |
| --- | --- | --- |
| `shuttle_services` | `supabase/modulo1-motoristas-translado-proximity.sql:113` | `id`, `tenant_id`, `business_id`, `opens_at`, `closes_at`, `active_days`, `is_active`, `price_cents`, `origin`/`destination`, `stops`, `service_type`. Fonte da regra de horário e do conflito. |
| `businesses` | produção (`list_shuttle_services:257` já exige `b.is_active` no join) | `id`, `tenant_id`, `is_active`. |
| `users` (role `CUSTOMER`) | base schema (fora do repo); usado em `modulo2-relatorios.sql:162` (`cu.role = 'CUSTOMER'`) e `coupon-management.sql:190` | O "cliente" **é** um `users` com `role='CUSTOMER'` — `identify_customer` devolve o `users.id`. Não existe tabela `customers` separada. |
| `drivers` | `supabase/modulo1-motoristas-translado-proximity.sql:37` | `drivers.business_id` = **vínculo com a frota** (é por ele que a corrida "da sua frota" é derivada). |
| `driver_sessions` | `supabase/modulo4-motoristas.sql:48` | Sessão do motorista (`p_session_token` → `driver_id` + `business_id` derivados no banco). |
| `auth_verify_session` | produção | `resolveSession` → `{ userId, tenantId, role, businessId }` (`_supabaseAdmin.js:25`). |

### Handlers

| Arquivo | Papel neste módulo |
| --- | --- |
| `netlify/functions/identify.js` | Fornece `customerId` + `customerToken` (HMAC). **Não muda.** |
| `netlify/functions/_supabaseAdmin.js` | `verifyCustomerToken:51`, `buildCustomerToken`, `resolveSession:25`, `extractSessionToken:34`, `rpcErrorCode:63`, `rpcErrorStatus:89`, mapa `RPC_ERROR_STATUS:69`. Único ponto a **acrescentar** códigos novos no mapa. |
| `netlify/functions/shuttle.js` | Catálogo público de serviços. **Não muda** — a reserva é fluxo separado, com sessão própria. |
| `netlify/functions/empresa.js` | `mode === 'shuttles'` em `:20`; bloco de escrita de serviço em `:120-149` (`save_shuttle_service:122`, `toggle_shuttle_service:136`, `delete_shuttle_service:144`). |
| `netlify/functions/driver-position.js` | Referência de credencial: `p_session_token` vai para a RPC e o `driver_id` é derivado no banco (`translado-write-flow.sql:273`, join em `:294`). O novo `driver-shuttle-runs` copia esse desenho. |
| `netlify/functions/driver-list-for-business.js` / `driver-review-document.js` | **Padrão a espelhar** para o lado empresa: lista de pendências (`GET`, filtro opcional de tela) + decisão (`POST` com `action` e `reason`). No banco: `driver_list_for_business` em `modulo4-motoristas.sql:709` (papel em `:724`, escopo em `:752-756`) e `driver_review_document` em `:574`. |

### Worker

`worker/main.js:83` (`ROUTES`) + `worker/main.js:44-67` (imports estáticos). Fora da whitelist → **404 em produção**.
A regex de rota (`:155`) só aceita `[a-z0-9-]`: os nomes novos já nascem nesse formato.
`worker/main.js:130` `DEFAULT_CACHE_CONTROL = 'no-store'`; `:135` `SESSION_ERRORS` = `{SESSION_REQUIRED, SESSION_EXPIRED}` (contrato com o front).

### Testes

- `tests/helpers.cjs` — `makeFakeSupabase`, `makeEvent`, `loadFunction`, `parseBody`, `VALID_ACTORS`, `customerTokenFor`. Reusar **sem alteração**.
- `tests/function-contract.test.cjs` — exige que todo handler não-helper em `netlify/functions` exporte `exports.handler`, que helper não exporte handler, que `HELPERS` bata com o grafo de imports e que nenhum arquivo carregue segredo. Substituiu o `consistency.test.cjs` em 2026-09-30, quando o espelho ESM foi removido.
- `tests/shuttle-manage.test.cjs` (15 casos) e `tests/shuttle.test.cjs` (10 casos) — moldes mais próximos: `mode=shuttles`, `save/toggle/delete_shuttle_service`, `driver-position`, contrato/erro do catálogo.
- `tests/cliente-offers-guard.test.cjs` — molde para guarda de página (não dá para renderizar JSX neste runner; o teste trava o padrão no fonte).
- Convenção de live: `tests/live.<nome>.test.cjs`, com `RUN_LIVE=1` (`package.json` → `test:live`, `test:live:approval`, `test:live:position`).

### Front

| Arquivo | Ponto |
| --- | --- |
| `app/cliente/page.jsx:791` | Card **"🚐 Translado e proximidade"**; `shuttle.services` em `:812`, preço/horário em `:821-822`; `TENANT_ID` fixo em `:14`; `customerId` + `localStorage.pyv_customer` (`:112-116`, `:273`); `fetchComTimeout` (`:22`); card de cupons em `:852`. |
| `app/empresa/page.jsx` | Aba `tab === 'translado'` (`:1072`); padrão de pendências em `tab === 'motoristas'` (`:778`) com `driversMsg`/`driversBusy` (`:74-75`, `:785-786`), botão reprovar + `motivo` inline (`:812-835`) e **recarregar/limpar depois da decisão** (`:540`). Nova aba `reservas` seguindo esse molde. |
| `app/motorista/page.jsx` | `canDrive(session.status)` (import `:22`, uso `:110`/`:315`/`:324`) e a lista `servicos` via `carregarServicos` (`:128`). Nova seção "Minhas corridas de hoje" sob o mesmo `canDrive`. |
| `app/motorista/logic.js` | Lógica pura testada (sem React/rede/import). `TENANT_ID:12`, `friendlyMessage:64`, `canDrive:107`, `buildPositionRequest:201`. |
| `lib/i18n.js` | Chaves novas em pt/en/es. |

---

## Mudanças propostas no banco

> **Nenhuma linha de SQL é executável aqui.** Só o desenho. Aplicação via MCP/`supabase`
> com migração versionada + advisors (Regra 4 do `AGENTS.md`).

### 1) Tabela `shuttle_reservations` (nova)

Colunas (padrão `modulo1`/`modulo4`: `tenant_id` em tudo, `created_at`/`updated_at`):

| Coluna | Tipo | Regra |
| --- | --- | --- |
| `id` | `uuid PK` | `gen_random_uuid()` |
| `tenant_id` | `uuid NOT NULL` | → `tenants(id)` ON DELETE CASCADE |
| `business_id` | `uuid NOT NULL` | → `businesses(id)`. Cópia do serviço **no momento da reserva** (o serviço não muda de dono, mas aí a lista da empresa não depende de join). |
| `shuttle_id` | `uuid NOT NULL` | → `shuttle_services(id)` **ON DELETE RESTRICT** (o oposto de `vehicle_positions.shuttle_id`, que é `ON DELETE SET NULL` em `modulo1-…sql:163` e `translado-write-flow.sql:216`: apagar serviço com reserva é erro de negócio explícito, não apagão silencioso). Efeito colateral a decidir: `shuttle_services.business_id` é `ON DELETE CASCADE` (`:116`), então excluir a **empresa** passa a falhar se houver reserva viva — precisa de desativar/empresa-soft-delete antes (ver Q3). |
| `customer_id` | `uuid NOT NULL` | → `users(id)`. Cliente identificado. |
| `scheduled_for` | `timestamptz NOT NULL` | Início da corrida. |
| `duration_minutes` | `integer NOT NULL` default `60` | **Janela ocupada** = `[scheduled_for, scheduled_for + duration)`. Ver pergunta aberta Q2. |
| `passengers` | `integer NOT NULL` | `CHECK (passengers BETWEEN 1 AND 20)` — teto a confirmar (Q3). |
| `price_cents` | `integer` | Snapshot do `shuttle_services.price_cents` na criação; NULL = "a combinar", como o card do cliente já mostra. |
| `status` | `text NOT NULL` default `'pending'` | `CHECK (status IN ('pending','confirmed','rejected','cancelled','completed'))` |
| `contact_phone` | `text` | Telefone do cliente no momento da reserva. |
| `notes` | `text` | Livre, opcional, do cliente. |
| `reason` | `text` | Justificativa da empresa em `rejected`/`cancelled` (mesmo papel de `p_reason` em `driver_review_document`). |
| `decided_by` | `uuid` | → `users(id)` ON DELETE SET NULL |
| `decided_at` | `timestamptz` | |
| `completed_at` | `timestamptz` | |
| `created_at` / `updated_at` | `timestamptz` | `now()` |

Índices: `(tenant_id, status, scheduled_for)`, `(customer_id, scheduled_for DESC)` e
`(shuttle_id, scheduled_for)` — o último é o que a checagem de sobreposição usa.

**RLS:** `ALTER TABLE public.shuttle_reservations ENABLE ROW LEVEL SECURITY;` **sem policy** — mesmo
padrão de `modulo1b-proximity-offers.sql:177-180` (tabelas novas ligadas ali, sem policy) e de
`driver_sessions`. Todo acesso passa por função `SECURITY DEFINER` com `service_role`.

### 2) Coluna em `shuttle_services` (nova, pequena)

`duration_minutes integer NOT NULL DEFAULT 60` — o comprimento da corrida é propriedade do
**serviço** (um tour de 3 h e um transfer de 30 min não podem ter a mesma janela). Default 60
mantém o `business_save_shuttle_service` atual funcionando sem alteração de assinatura obrigatória;
ver Q2.

### 3) RPCs novas (todas `SECURITY DEFINER`, `search_path = public, extensions`)

| RPC | Assinatura | Autorização e regras (dentro da função) |
| --- | --- | --- |
| `shuttle_create_reservation` | `(p_tenant_id, p_customer_id, p_service_id, p_scheduled_for, p_passengers, p_notes, p_contact_phone)` → `jsonb` | 1) cliente existe em `users` e é do tenant; 2) serviço existe, `is_active`, `businesses.is_active` e do mesmo tenant → senão `SHUTTLE_NOT_FOUND`; 3) `p_scheduled_for` no futuro → `INVALID_SCHEDULE`; 4) dia da semana no fuso local ∈ `active_days` (`smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}'` em `modulo1-…sql:133`, ou seja **não** é array vazio: o default é todos os dias) → `DAY_NOT_ACTIVE`; 5) hora local ∈ `opens_at..closes_at` (NULL = livre) → `OUTSIDE_HOURS`; 6) **lock pessimista na linha do serviço** (`SELECT ... FOR UPDATE`) e depois checa sobreposição de `[scheduled_for, +duration)` com reservas `pending`/`confirmed` do mesmo `shuttle_id` → `SLOT_CONFLICT`; 7) insere `pending` com snapshot de `price_cents`. |
| `shuttle_cancel_reservation` | `(p_tenant_id, p_customer_id, p_reservation_id, p_reason)` → `jsonb` | Só o dono do `customer_id`; só de `pending`/`confirmed`; senão `INVALID_STATUS_TRANSITION`. Status → `cancelled`. |
| `shuttle_list_customer_reservations` | `(p_tenant_id, p_customer_id, p_status)` → `jsonb` | Filtra por `customer_id` + `tenant_id`; `p_status` opcional (escolha de tela, não de autoridade). Retorna `{ reservationId, shuttleId, serviceName, businessName, businessPhone, scheduledFor, durationMinutes, passengers, priceCents, status, reason, createdAt }`. |
| `business_list_shuttle_reservations` | `(p_tenant_id, p_actor_user_id, p_status, p_date)` → `jsonb` | Ator: `users` do tenant com role em `MERCHANT,ADMIN,STAFF,SUPER_ADMIN` (`modulo4-motoristas.sql:724`); escopo por `business_id = v_actor.business_id`, `SUPER_ADMIN` vê todos (`:752-756`). `p_date` filtra o dia local. **Não devolve `contact_phone` de outro negócio** — só da própria empresa. |
| `business_review_shuttle_reservation` | `(p_tenant_id, p_actor_user_id, p_reservation_id, p_action, p_reason)` → `jsonb` | Mesmo ator/escopo (`driver_review_document:833`). `p_action ∈ ('confirm','reject','cancel')`. Transições válidas: `pending→confirmed|rejected|cancelled`; `confirmed→cancelled`; qualquer outra → `INVALID_STATUS_TRANSITION`. Grava `decided_by`/`decided_at`/`reason`. |
| `driver_list_shuttle_runs` | `(p_session_token, p_date)` → `jsonb` | Deriva `driver_id`/`tenant_id`/`business_id` da sessão (`driver_sessions` não expirada, `status='approved'`, senão `SESSION_EXPIRED`/`NOT_APPROVED` — mesmo gate de `driver_report_position`). Lista `confirmed`/`completed` do dia cujo `shuttle_id` pertence a um serviço do `business_id` **do motorista**. **Não devolve nome nem telefone do cliente** (ver Q6). |
| `driver_complete_shuttle_reservation` | `(p_session_token, p_reservation_id)` → `jsonb` | `confirmed → completed`; só se a corrida for de um serviço da sua frota. `completed_at = now()`. |

**Acesso:** `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated;` + `GRANT EXECUTE ... TO service_role;`
para todas as sete. Molde: os `REVOKE` de `translado-write-flow.sql:346-350` e os `GRANT` por função
de `modulo4b-token-cadastro.sql:452-455`. Depois, Roda 4: `supabase/close-function-exec.sql`
(verificação em `:60`) e confere `app_ainda_abertas = 0` — `DROP` + `CREATE` reabre o ACL.

**Erros** como `raise exception 'CODIGO: detalhe'`, para `rpcErrorCode`/`rpcErrorStatus` cortarem no `:`:
`SHUTTLE_NOT_FOUND`, `RESERVATION_NOT_FOUND`, `INVALID_SCHEDULE`, `OUTSIDE_HOURS`, `DAY_NOT_ACTIVE`,
`INVALID_PASSENGERS`, `SLOT_CONFLICT`, `INVALID_STATUS_TRANSITION`, `FORBIDDEN`, `SESSION_EXPIRED`,
`NOT_APPROVED`.

> **As regras 4 e 5 dependem da resposta de Q1 (fuso).** Não existe `AT TIME ZONE` em lugar nenhum do
> SQL atual e o front formata no fuso do navegador, então "dia local" e "hora local" precisam de uma
> referência explícita (assumo `America/Sao_Paulo` fixo, aplicado dentro da função). Enquanto Q1 não
> tiver resposta, essas duas regras não são implementáveis — e o mesmo vale para o agrupamento por
> "dia" em `p_date`.

### 4) Alteração em RPC existente

`business_delete_shuttle_service` passa a recusar `SHUTTLE_HAS_RESERVATIONS` quando existir reserva
`pending`/`confirmed` para o serviço. Hoje o `DELETE` é livre (`translado-write-flow.sql:207`); com o
`ON DELETE RESTRICT` do FK, apagar serviço com reserva viraria erro 500 genérico — o RPC precisa dar
o código certo. `business_save_shuttle_service` ganha o parâmetro opcional `p_duration_minutes`.

### 5) Nenhuma policy de RLS para `anon`/`authenticated`

Não existe acesso direto: `shuttle_reservations` fica inacessível pelo PostgREST, igual a
`driver_sessions` e `vehicle_positions`.

---

## API

Três endpoints novos + `empresa` estendido. Todos em `netlify/functions` (CJS, fonte única
desde 2026-09-30) e com entrada no `ROUTES` de `worker/main.js`.

### 1) `GET|POST /.netlify/functions/shuttle-reservation` — cliente

**Autenticação:** `customerId` + `customerToken` (HMAC), verificados por `verifyCustomerToken`
(exatamente o anti-IDOR de `offers?mode=my-coupons`, `offers.js:45`). Erro → `401 CUSTOMER_TOKEN_INVALID`.

**`GET`** — query: `tenantId`, `customerId`, `customerToken`, `status?`.
→ `200 { reservations: [...], count }` — chaves em camelCase, sempre array. `Cache-Control: no-store`.

**`POST`** — body:

| Campo | Obrig. | Observação |
| --- | --- | --- |
| `action` | não | `'create'` (padrão) ou `'cancel'`. Ausente/vazio = `create`. |
| `tenantId`, `customerId`, `customerToken` | sim | `tenantId` validado; token conferido. |
| `shuttleId` | `create` | UUID do serviço. |
| `scheduledFor` | `create` | ISO-8601 **com offset** (`2026-10-02T14:00:00-03:00`). O banco valida o dia/hora local. |
| `passengers` | `create` | Inteiro 1..20. |
| `notes`, `contactPhone` | não | |
| `reservationId` | `cancel` | |
| `reason` | `cancel` | Opcional (como `p_reason` em `driver-review-document`). |

→ `200` em `create`: `{ reservationId, shuttleId, serviceName, businessName, businessPhone, scheduledFor, durationMinutes, passengers, priceCents, status: 'pending', createdAt }`
→ `200` em `cancel`: `{ reservationId, status: 'cancelled' }`
→ `Cache-Control: no-store` nos dois.

### 2) `GET|POST /.netlify/functions/empresa` — empresa (extensão)

**`GET ?mode=reservations&status=&date=`** com `Authorization: Bearer <sessionToken>`.
`status` e `date` são **escolha de tela** (vêm da query); `p_tenant_id`/`p_actor_user_id` vêm da
sessão (`resolveSession`), nunca da query.
→ `200 { reservations: [...], count }` com `contactPhone` e `notes` incluídos (é a empresa dona).
`Cache-Control: no-store`.

**`POST`** — o envelope usa `action` (roteamento interno, como os demais handlers de escrita) e a
decisão vem em `decision`, para não colidir com ele:

```jsonc
{ "action": "review_reservation", "reservationId": "…", "decision": "confirm" | "reject" | "cancel", "reason": "opcional" }
```

`decision` fora dessa lista → `400 ACTION_INVALID` (mesmo guard de `driver-review-document.js:38`).
→ `200 { reservationId, status }` | `405` para método não suportado.

### 3) `GET|POST /.netlify/functions/driver-shuttle-runs` — motorista

**`GET ?date=YYYY-MM-DD`** com `Authorization: Bearer <sessionToken>` de **motorista**
(a mesma credencial de `driver-position`; `uploadToken` não vale — `logic.js:201`).
→ `200 { date, runs: [ { reservationId, shuttleId, serviceName, scheduledFor, durationMinutes, passengers, origin, destination, status } ], count }`.
Sem `date`, assume o dia corrente no fuso de referência de Q1. `Cache-Control: no-store`.

**`POST`** `{ reservationId }` → `200 { reservationId, status: 'completed', completedAt }`.

### Códigos de erro

| Código | HTTP | Origem | Quando |
| --- | --- | --- | --- |
| `INVALID_JSON` | 400 | handler | corpo não parseável |
| `*_REQUIRED` | 400 | handler | faltou `tenantId`/`shuttleId`/`scheduledFor`/`reservationId` — padrão `DOCUMENT_ID_REQUIRED` de `driver-review-document.js:36` |
| `ACTION_INVALID` | 400 | handler | `decision` fora de `confirm/reject/cancel` (`driver-review-document.js:38`) |
| `CUSTOMER_TOKEN_INVALID` | 401 | handler | HMAC ausente/adulterado/trocado de `customerId` |
| `AUTH_REQUIRED` | 401 | handler | sem token no header |
| `SESSION_EXPIRED` | 401 | RPC/handler | sessão expirada (contrato do front, `worker/main.js:135`) |
| `FORBIDDEN` | 403 | RPC | ator sem `business_id` ou fora do escopo |
| `NOT_APPROVED` | 403 | RPC | motorista sem `approved` |
| `INVALID_PASSENGERS` | 400 | RPC | fora de 1..20 |
| `INVALID_SCHEDULE` | 400 | RPC | data no passado / formato inválido |
| `OUTSIDE_HOURS` | 400 | RPC | fora de `opens_at..closes_at` |
| `DAY_NOT_ACTIVE` | 400 | RPC | dia fora de `active_days` |
| `SHUTTLE_NOT_FOUND` | 404 | RPC | inexistente, inativo, de outro tenant, ou negócio inativo |
| `RESERVATION_NOT_FOUND` | 404 | RPC | não existe / não é do cliente / não é da empresa |
| `SLOT_CONFLICT` | **409** | RPC | sobreposição no mesmo serviço |
| `INVALID_STATUS_TRANSITION` | **409** | RPC | `pending→completed`, `rejected→confirm`, … |
| `SHUTTLE_HAS_RESERVATIONS` | **409** | RPC | apagar serviço com reserva viva |
| `METHOD_NOT_ALLOWED` | 405 | handler | |
| `erro interno` | 500 | handler | sanitizado (nunca `err.message`) |

**Mudança obrigatória em `RPC_ERROR_STATUS`:** acrescentar `RESERVATION_NOT_FOUND: 404`,
`SLOT_CONFLICT: 409`, `INVALID_STATUS_TRANSITION: 409`, `SHUTTLE_HAS_RESERVATIONS: 409`,
`OUTSIDE_HOURS: 400`, `DAY_NOT_ACTIVE: 400`, `INVALID_PASSENGERS: 400`, `INVALID_SCHEDULE: 400` —
**nos dois dialetos** (`_supabaseAdmin.js:69` e `_shared.js:44`), senão a mesma regra devolve 400
na Netlify e 409 no Worker.

---

## UI

Sem mockup. Só as janelas de mudança.

### `/cliente` — `app/cliente/page.jsx`

- Card "🚐 Translado e proximidade" (título em `:791`, lista em `:812`): cada serviço ganha um botão
  **"Reservar"** ao lado do preço e do horário (`:821-822`, que já imprimem `R$ …` ou "Preço a
  combinar" e `opensAt-closesAt` só quando existem).
- Ao clicar: painel inline (não modal) com **data**, **hora** (slots de 30 min dentro de
  `opensAt..closesAt`, filtrados por `activeDays`), **passageiros** (1..20) e **observação** (opcional).
  Fora da janela o botão fica desabilitado com o motivo escrito — sem erro por tentativa.
- Sem `customerId`: o painel mostra o mesmo texto de identificação que já existe em `:559-565` e
  **oferece identificar agora** (reaproveitando o `finalizeRegistration`, `:266`) em vez de
  mandar o cliente para o topo da página.
- Sucesso: card de confirmação com data/hora, nº de passageiros, preço ou "a combinar", nome da
  empresa e **botão "Falar no WhatsApp"** montado com `buildWaLink` de `_wa.js` — mesmo caminho de
  `claim-coupon:94`, com o texto vindo do **banco** (a RPC devolve `businessPhone`), nunca do browser.
- Novo card **"Minhas reservas"** (ao lado de "Meus cupons", `:852`): filtro `pending/confirmed/
  cancelled` no mesmo formato do filtro existente em `:864`, com **cancelar** disponível em
  `pending`/`confirmed`. O carregamento reaproveita o par `customerId`/`customerToken` que a página
  já tem em `:112-116`.
- Guards (padrão de `cliente-offers-guard.test.cjs`): `res.ok` checado antes de `setState`,
  `Array.isArray` antes de renderizar, estado de erro **separado** do estado de lista, e
  `fetchComTimeout` em toda chamada nova (`:22`). Sem isso a tela inteira quebra como já quebrou.

### `/empresa` — `app/empresa/page.jsx`

- Nova aba **"📅 Reservas"** na fita de abas (botões em `:774-775`, catálogo em `:46`), entre
  "Translado" (`:1072`) e "Motoristas" (`:778`).
- Lista no molde da aba Motoristas: `reservationsMsg` + `reservationsBusy` (como `:74-75` / `:785-786`),
  badge de status colorida por `status`, linhas com data/hora, serviço, passageiros, telefone e
  observação do cliente.
- Filtro de tela: "Só pendentes" (espelha o `?status=pending` de `driver-list-for-business`).
- Ação **Confirmar** (verde) só em `pending`; **Rejeitar** e **Cancelar** abrem o input de motivo
  inline, igual ao par aprovar/reprovar em `:812-835` (input em `:828-830`).
- Depois da decisão, **recarrega a lista** e limpa o motivo (`:540`) em vez de remendar o array local.
- Contador de pendências no título da aba, para a fila ser visível sem clicar.

### `/motorista` — `app/motorista/page.jsx` + `logic.js`

- Novo card **"Minhas corridas de hoje"**, sob o mesmo `canDrive(session.status)` (`:324`) que já
  protege a transmissão de posição. Não aparece para `pending`/`rejected`.
- Lista ordenada por horário: hora, serviço, origem → destino, nº de passageiros, badge de status.
- Ação **"Concluir corrida"** só em `confirmed`.
- Carregamento junto do `useEffect` que já chama `carregarServicos()` (`:110`).
- Toda a lógica nova (montar a requisição, rótulos, `friendlyMessage` dos códigos novos, dia local)
  entra em `app/motorista/logic.js` como função pura, coberta por `tests/motorista-logic.test.cjs`.
- Sem nome e sem telefone do cliente na tela (ver Q6).

### i18n

Chaves novas em pt/en/es em `lib/i18n.js`, com fallback no padrão `t.x ?? 'texto'` que o projeto já usa.

---

## Comandos

Nada aqui foi executado. Quando a implementação existir, a ordem é a do `AGENTS.md`:

```powershell
# 0) Regra 1 — backup antes de qualquer alteração
#    pyv-web-backup-<data>-<indice>.zip em C:\Users\REUNIAO\Desktop\pyv-backups\
#    (exclui node_modules/.wrangler/.next/out/.git e nunca .env/.dev.vars)

# 1) Testes (baseline 233 / 227 passando / 6 pulados — RELATORIO-FUNCIONALIDADES.md:90)
npm test                                    # node --test "tests/*.test.cjs"
node --test "tests/shuttle-reservation.test.cjs"
node --test "tests/empresa-reservations.test.cjs"
node --test "tests/driver-shuttle-runs.test.cjs"
node --test "tests/function-contract.test.cjs"

# 2) Build (o postbuild roda scripts/bundle-worker.mjs e gera out/_worker.js)
npm run build

# 3) Banco, se e quando aprovado (Regra 4): migration via MCP/supabase
#    → supabase/close-function-exec.sql → app_ainda_abertas tem que ser 0 (Regra 5, via aclexplode)
#    → advisors de security e performance, sem aviso novo

# 4) Live opcional (cria e apaga dados em produção; cleanup no after())
$env:RUN_LIVE='1'
npm run test:live                            # tests/live.smoke.test.cjs
node --test tests/live.shuttle-reservation.test.cjs

# 5) Deploy: perguntar "posso fazer o deploy?" e esperar SIM explícito (Regra 2)
```

**Invariantes que quebram o build se violadas:** `tests/function-contract.test.cjs` (`exports.handler`
em todo handler, helper sem handler, `HELPERS` coerente com o grafo de imports, nenhum segredo no
fonte), `worker-assets.test.cjs`
(rota fora da whitelist = 404, delegate para `ASSETS`), `worker-headers.test.cjs`
(`no-store` em toda resposta do adaptador; 500 sem detalhe interno).

---

## Estratégia de teste

### Testes novos (unitários, `node:test`, sem banco)

**`tests/shuttle-reservation.test.cjs`** — espelha `shuttle-manage.test.cjs`:
- sem `tenantId` → 400 e **nenhuma** RPC chamada (o mesmo contrato de `shuttle.test.cjs`);
- `customerToken` inválido/trocado → `401 CUSTOMER_TOKEN_INVALID` e nenhuma RPC;
- `create` com `customerTokenFor(customerId)` válido → 200, corpo enviado com `p_customer_id`,
  `p_scheduled_for` e `p_passengers` convertidos; resposta traz `businessName`/`businessPhone`;
- `cancel` → 200 `{ reservationId, status: 'cancelled' }`;
- `GET` normaliza `reservations` para array mesmo com `data: null` (o que `driver-list-for-business.js:56`
  faz com `documents`);
- erro `SLOT_CONFLICT: detalhe` → **409** com corpo `{ error: 'SLOT_CONFLICT' }` (detalhe não vaza);
- `SHUTTLE_NOT_FOUND` → 404; `OUTSIDE_HOURS` → 400; JSON inválido → `400 INVALID_JSON`;
- 500 inesperado → `{ error: 'erro interno' }`, sem `err.message`;
- **IDOR**: `customerToken` do cliente A com `customerId` de B → 401, e a RPC não é chamada.

**`tests/empresa-reservations.test.cjs`** — `GET ?mode=reservations` e `POST review_reservation`:
- `p_tenant_id`/`p_actor_user_id` vêm da sessão (`t-1`/`u-merchant-1`), nunca da query;
- `FORBIDDEN` → 403; `SESSION_EXPIRED` → 401; `INVALID_STATUS_TRANSITION` → 409;
- `decision` inválido → `400 ACTION_INVALID`; `RESERVATION_NOT_FOUND` → 404;
- `Cache-Control: no-store` no `GET`.

**`tests/driver-shuttle-runs.test.cjs`** — sem token → 401; `NOT_APPROVED` → 403; `SESSION_EXPIRED` → 401;
resposta com `runs` normalizado; `p_date` repassado; `Cache-Control: no-store`.

**`tests/shuttle-routes.test.cjs`** (ou extensão do `consistency`) — os dois nomes novos estão no
`ROUTES` de `worker/main.js` e ambos batem com a regex `[a-z0-9-]+`.

**`tests/motorista-logic.test.cjs`** (extensão) — `friendlyMessage` para os códigos novos;
montagem da requisição de conclusão; formatação de dia/hora; `canDrive` continua barrando quem não
é `approved`.

**`tests/cliente-shuttle-reservation-guard.test.cjs`** — no estilo de `cliente-offers-guard.test.cjs`:
travar no fonte que (a) nenhuma chamada nova passa a resposta direto para o state, (b) toda chamada
nova usa `fetchComTimeout`, (c) o estado de erro é testado **antes** do "nenhuma reserva" no render,
(d) o `setReservations([])` vem junto do `set...Erro` no caminho de erro.

### Testes live (opcionais, `RUN_LIVE=1`)

`tests/live.shuttle-reservation.test.cjs`, no formato de `live.driver-position.test.cjs`:
empresa loga → cria serviço → cliente `identify` → cria reserva → empresa confirma → motorista
aprovado vê a corrida do dia → conclui → cliente cancela uma segunda reserva. **Cria e apaga dados
em produção**, com cleanup no `after()` mesmo se uma asserção falhar no meio. O runner lê a service
role do ambiente local (`.dev.vars`, como os live tests já fazem) e nunca a imprime nem a versiona —
esta spec não lê esse arquivo.

### Fora do escopo de teste

Regressão visual no navegador. O padrão do projeto é o mesmo do Módulo 1: prova de comportamento
feita à mão, guarda automatizada travando o padrão no fonte.

---

## Fronteiras

### Always (fazer sempre, sem perguntar)

- **Backup completo antes de qualquer alteração** (Regra 1), validado no disco, sem `.env`/`.dev.vars`.
- **Par CJS + ESM** para cada handler novo, mesma lista de funções exportadas.
- **Entrar no `ROUTES`** de `worker/main.js` junto com o handler — sem isso o endpoint retorna 404 em produção.
- `p_tenant_id` e `p_actor_user_id` **da sessão**; `customer_id` do token HMAC conferido; `driver_id`
  derivado da sessão **no banco**. Nunca do corpo, nunca da query.
- `Cache-Control: no-store` em toda resposta com nome, telefone ou reserva.
- Erro de negócio como `'CODIGO: detalhe'`; resposta HTTP só com o código; 500 = `erro interno`.
- `REVOKE` de `PUBLIC/anon/authenticated` + `GRANT` só a `service_role` em **cada** função nova;
  `close-function-exec.sql` e `app_ainda_abertas = 0` no fim do módulo.
- RLS ligada e **sem policy** na tabela nova.
- Recarregar a lista depois de uma decisão, em vez de remendar o state.
- `t.x ?? 'fallback'` em todo texto novo; lógica pura testável em `logic.js`.
- Testes + `npm run build` verdes **antes** de perguntar sobre deploy.

### Ask first (perguntar antes)

- **Mudança de schema** — criar `shuttle_reservations`, adicionar `duration_minutes`, alterar a
  assinatura de `business_delete_shuttle_service` / `business_save_shuttle_service`. Passa por migração
  versionada e advisors.
- **Aplicar SQL em produção** (MCP/`supabase`) — e aplicar `close-function-exec.sql`.
- **Nova dependência** em `package.json` (a proposta **não** precisa de nenhuma: só `node:test`,
  `node:crypto`, `@supabase/supabase-js`).
- **Endpoint novo na whitelist do Worker** (mexe no plano Free e é superfície pública).
- **Deploy** (`wrangler pages deploy`) e `git push` — Regra 2 e `AGENTS.md`.
- Mudança de regra de negócio já existente (teto de passageiros, janela de conflito, tetos de
  horário) ou o i18n de uma mensagem já existente.
- **Definir o fuso de referência** (Q1): hoje não existe `AT TIME ZONE` em lugar nenhum do SQL, e
  "dia/hora local" muda o significado de `active_days`, `opens_at`/`closes_at` e do agrupamento por dia.
- Enviar notificação ao cliente/empresa (WhatsApp automático) em vez de só montar o link.
- Excluir empresa com reservas vivas (o `ON DELETE CASCADE` de `shuttle_services.business_id` passaria
  a falhar com o FK em `RESTRICT` — precisa de desativar antes).

### Never (não fazer, nem com autorização implícita)

- Ler, imprimir, logar ou versionar `.env`, `.env.local` ou `.dev.vars`; expor
  `SUPABASE_SERVICE_ROLE_KEY`, `customerToken` ou `HMAC` em resposta, log ou URL.
- Confiar em `customerId`, `tenantId`, `driverId` ou `businessId` vindos do cliente sem verificação.
- Devolver `error.message` cru ao cliente; devolver detalhe de Postgres/Supabase.
- Deixar `shuttle_reservations` com policy para `anon`/`authenticated`, ou criar tabela nova sem RLS.
- Pular `npm test`/`npm run build` porque "já parece certo", ou rodar comando que mude estado
  (`git push`, deploy, SQL em produção) sem autorização explícita; editar produção direto no
  dashboard sem migração versionada.
- Tornar o endpoint de reserva público/anônimo, ou afrouxar a exigência de `customerToken` "só por
  conveniência da UI".
- Apagar serviço de translado (ou a própria empresa, por cascata) com reserva viva — perde o
  histórico do cliente. Desativar antes de excluir.
- Reutilizar a sessão de empresa no contexto de motorista (ou vice-versa): são `sessions` e
  `driver_sessions` distintas.

---

## Critérios de sucesso (testáveis)

1. `npm test` verde e `npm run build` sem erro, com `out/_worker.js` gerado.
2. `tests/function-contract.test.cjs` verde: os handlers novos exportam `exports.handler` e estão no `ROUTES`.
3. `POST /shuttle-reservation` com `customerToken` válido cria reserva `pending` e responde 200 com
   `businessPhone` e `status: 'pending'`.
4. Mesmo pedido sem token, ou com token de outro `customerId` → `401 CUSTOMER_TOKEN_INVALID`, **sem** gravação.
5. `shuttleId` de serviço inativo / de outro tenant → `404 SHUTTLE_NOT_FOUND` (não revela existência).
6. Horário fora de `opens_at..closes_at` → `400 OUTSIDE_HOURS`; dia fora de `active_days` → `400 DAY_NOT_ACTIVE`.
7. Duas reservas `pending` no mesmo serviço com janelas sobrepostas → a segunda leva `409 SLOT_CONFLICT`;
   com duas requisições **simultâneas**, continua havendo no máximo uma (lock na linha do serviço).
8. `GET /empresa?mode=reservations` devolve só reservas do `business_id` da sessão; `p_actor_user_id`
   nunca vem da query.
9. `POST /empresa { action: 'review_reservation', decision: 'reject' }` move para `rejected` com `reason`;
   `confirm` em reserva já `rejected` leva `409 INVALID_STATUS_TRANSITION`.
10. `GET /driver-shuttle-runs` sem `approved` → `403 NOT_APPROVED`; com `approved`, devolve só
    `confirmed`/`completed` do dia dos serviços da sua empresa, sem nome nem telefone do cliente.
11. `POST /driver-shuttle-runs` conclui a corrida → `200 { status: 'completed' }` e a empresa vê `completed`.
12. Apagar serviço com reserva `pending` → `409 SHUTTLE_HAS_RESERVATIONS` (não apaga nada).
13. Nenhum endpoint novo devolve 500 com detalhe interno; `SESSION_EXPIRED` continua chegando ao front
    com o texto original (`worker/main.js:135`).
14. Advisors de security sem aviso novo; `app_ainda_abertas = 0` (verificado com `aclexplode`).
15. Nenhuma resposta nova em cache: `no-store` confirmado nos 3 endpoints.

---

## Perguntas em aberto (para o dono responder)

**Bloqueiam o desenho do banco (precisam de resposta antes de escrever a SQL):**

1. **Fuso horário — hoje não existe nenhum.** Varredura no repo: nenhum `AT TIME ZONE`/`timezone` no
   SQL, e o front formata com `toLocaleString('pt-BR')` (fuso do navegador). Sem isso, "dia da semana"
   e "hora local" das regras `active_days`/`opens_at`/`closes_at` ficam indefinidos. Qual o fuso de
   referência do tenant (assumo `America/Sao_Paulo`) e ele é fixo ou vem de `tenants`/`businesses`?
2. **Janela da corrida / conflito.** A reserva ocupa `[scheduled_for, scheduled_for + N)` com `N`
   padrão 60 min. Confia? Alternativa: `N` por serviço (campo novo) — o que prefere, e 60 min é
   razoável para aeroporto↔centro? E a regra de sobreposição: **uma reserva por slot por serviço**
   (o que assumei) ou **várias até um limite de passageiros/veículos**?
3. **Teto de passageiros.** Adotei `1..20`. Quantos cabem num translado do tenant? E o número deve
   alimentar uma lotação por horário (vago → ocupado)?
4. **`business_delete_shuttle_service` com reservas vivas.** Adotei bloquear com
   `SHUTTLE_HAS_RESERVATIONS`. Alternativa: o painel passa a oferecer "desativar" em vez de apagar
   (recomendado, preserva histórico). E o efeito em cascata: como `shuttle_services.business_id` é
   `ON DELETE CASCADE`, excluir a **empresa** também falha se houver reserva — ok com isso?

**Definem produto, não banco:**

5. **Reagendamento.** Cliente que precisa mudar a data faz o quê hoje: cancela e cria outra (o slot
   volta ao ser reservável) ou existe `reschedule`? Se existir, entra nesta entrega?
6. **O motorista enxerga o cliente?** Por padrão entregue **não** (só horário, rota e nº de
   passageiros). Ele precisa do nome/telefone para buscar? Se sim, é dado pessoal do terceiro
   entrando numa tela nova — confirma?
7. **Quem pode concluir uma corrida?** Adotei o motorista. A empresa também pode (quando o motorista
   esquece de concluir)? E há prazo automático para `confirmed → completed` no fim do dia?
8. **Cancelamento pelo cliente:** livre a qualquer hora antes da corrida, ou com prazo (ex.: 2 h)?
   A empresa pode cancelar depois de confirmado — assumi que sim.
9. **Notificação.** Confirma que é **só** link de WhatsApp montado como em `claim-coupon` (nada
   enviado automaticamente)? E o texto: o mesmo contexto do banco (`businessName`, `serviceName`,
   data/hora) — quer incluir o preço?
10. **Idioma dos textos novos:** só PT com fallback (como hoje) ou PT/EN/ES completos já nesta entrega?
11. **Prazo de antecedência mínima** para reservar (ex.: não aceitar reserva para hoje em 5 min)?
    Hoje só bloqueio de horário no passado.

**Fora do escopo, para registrar e não decidir agora:**

12. Pagamento da reserva e cupom de desconto aplicado a ela (hoje o cupom é de oferta, não de serviço).
13. Multi-tenant real: `TENANT_ID` continua fixo em `/cliente` e `/motorista`, como hoje?
14. `duration_minutes` aparece no painel da empresa (aba Translado) como campo editável, ou fica em
    60 por padrão sem exposição?
