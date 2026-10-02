# API — Playas y Ventajas

Mapa de referência: rota pública → handler Netlify → RPC do Supabase → SQL.

## Arquitetura

- **Um dialeto só, em CommonJS** (`netlify/functions/*.js`, importa `./_supabaseAdmin`). É a fonte única: o `netlify.toml` publica essa pasta e o `scripts/bundle-worker.mjs` inlina os mesmos arquivos no bundle do Worker.
  - Até 2026-09-30 existia um espelho ESM em `functions/.netlify/functions/*.js` (importava `./_shared.js`), para uso em Cloudflare Pages Functions. Foi removido: não havia consumidor em runtime (não existe `wrangler.toml`; o único alvo de deploy é o `netlify.toml`) e o `tests/consistency.test.cjs` que o vigiava comparava só a *forma* dos arquivos, nunca o comportamento — a `_wa.js` do espelho ficou com a mensagem antiga por meses sem nenhum teste reclamar. Ver `SECURITY-DECISIONS.md`.
  - Contrato do diretório agora em `tests/function-contract.test.cjs`.
- **`worker/main.js`**: whitelist `ROUTES`. Tudo que não está em `ROUTES` retorna 404; a regex da rota só aceita `[a-z0-9-]`. Chamadas são convertidas para o formato de `event` da Netlify (httpMethod, queryStringParameters, headers, body).
- **Banco**: todas as RPCs são chamadas com a chave service_role (admin client). Autenticação de cliente usa token HMAC (`buildCustomerToken` / `verifyCustomerToken`); sessões de empresa/admin/motorista usam `auth_verify_session` / `driver_verify_session`.
- **`TENANT_ID` fixo**: `0dc57eeb-46c8-47ac-aad4-640d9d59e7b9` (hardcoded em `identify.js`, `affiliates.js` e testes; demais handlers trazem o tenant da sessão/query).

## Functions e endpoints

### `offers` — listagem pública
`GET /.netlify/functions/offers?tenantId=...` (+ parâmetros)
- Sem `mode` → `list_offers` (v3) com filtros por cidade/atividade/raio:
  `city`, `category`, `lat`, `lng`, `radiusKm`. Retorna array com `distanceKm` (quando há lat/lng) e `featured`/`featuredUntil`. Depois `withOfferImages` completa `imageUrl` de `coupon_templates` quando faltar.
- `mode=cities` → `list_cities` (text[]). | `mode=categories` → `list_categories` (text[], normalizadas via `norm_categoria`).
- `mode=my-coupons` → exige `customerId` + `customerToken` (HMAC, anti-IDOR) → `list_customer_coupons`.
- `businessLogoFor=<businessId>` → `business_logo_by_id`.

### `identify` — cadastro/identificação do cliente
`POST /.netlify/functions/identify` `{ phone, name?, email?, instagram?, ref? }`
- RPC `identify_customer` (produção). Devolve `{ customerId, customerToken, referral }`.
- Se `ref` presente → `referral_track` **best-effort fail-open**; `referral` fica `{ code }` ou `null`.

### `claim-coupon` — resgate de cupom
`POST /.netlify/functions/claim-coupon` `{ tenantId, templateId, phone, name?, instagram?, email?, ref? }`
- Caminho crítico: `claim_coupon` (produção, intocada). Depois `try_referral_convert` (convert do indicado) e `loadOfferContext` para montar o link wa.me (`buildWaLink` de `_wa.js`).
- Se `ref` presente e o vínculo não tiver ocorrido no identify → `referral_track` antes do convert. Tudo best-effort: o resgate nunca é bloqueado.
- Fase 2 (taxa por cupom): no sucesso, handler chama **`billing_record_coupon_tax`** (`p_tenant_id`, `p_template_id`, `p_coupon_id`) best-effort (try/catch — o 200 nunca cai; falha é logada e ignorada).
- Resposta: `{ ...claim, customerToken, whatsappUrl, referral, notes }`.

### `login` — sessão de empresa/admin
`POST /.netlify/functions/login` `{ tenantSlug, internalCode, pin }`
- `auth_login` (+ `auth_pin_reset_required` no caso de senha resetada). Retorna sessão com role/tenantId; admin valida role no frontend.

### `empresa` — painel da empresa (sessão `Authorization: Bearer <token>`)
- `GET` (default) → `empresa_dashboard` (produção). `GET ?mode=stats` → `business_coupon_stats`. `GET ?mode=my-data` → `business_get_own`. `GET ?mode=shuttles` → `business_list_shuttle_services` (serviços de translado do próprio negócio, inclusive inativos). `GET ?mode=reservations` (`&status=&date=`) → **`business_list_shuttle_reservations`** (Módulo A; escopo por negócio do ator, `SUPER_ADMIN` vê tudo; lista ordenada por `scheduledFor`, `Cache-Control: no-store`, devolve `{ reservations, count }`). `GET ?mode=report` (`&days=`) → relatório de performance (dias: 7/30/90).
- `POST` `{ action }`:
  - `update_my_data` → `business_update_own` v10 (inclui `category`).
  - `create_template` / `update_template` / `toggle_template` / `delete_template` → `create_coupon_template` (produção) / `business_update_template` / `business_toggle_template` / `business_delete_template`.
  - `create_campaign` → `create_campaign` (produção).
  - `set_coupon_featured` `{ templateId, until }` → **`business_set_coupon_featured`** (self-service, novo).
  - `set_pin` → `business_set_pin`.
  - `save_shuttle_service` `{ name, description, serviceType, originLat/lng, destLat/lng, stops, priceCents, opensAt, closesAt, activeDays, serviceId? }` → **`business_save_shuttle_service`** (cria se sem `serviceId`, edita se com; `priceCents` convertido de reais pelo handler; `activeDays` CSV → array).
  - `toggle_shuttle_service` `{ serviceId, isActive }` → **`business_toggle_shuttle_service`**.
  - `delete_shuttle_service` `{ serviceId }` → **`business_delete_shuttle_service`**.
  - `review_reservation` `{ reservationId, action, reason? }` → **`business_review_shuttle_reservation`**; `action` ∈ `confirm|reject|cancel` (recusa exige `reason` — RPC devolve `REASON_REQUIRED`). 400 `ACTION_INVALID`/`RESERVATION_ID_REQUIRED` antes da RPC; devolve `{ reservationId, status }`.

### `admin` — painel admin (sessão; role ADMIN/SUPER_ADMIN)
- `GET` (default) → `admin_list_businesses` (produção). Modes:
  - `billing` → `admin_billing_panel` · `featured` → `admin_featured_ranks` · `customers` → `admin_list_customers` (produção).
  - `affiliates` → **`admin_affiliate_report`** · `affiliate-rewards` → **`admin_get_affiliate_rewards`** (`{ config }`).
- `POST` `{ action }`: `create_business`, `toggle_business`, `set_featured` (rank), `set_billing`, `update_business`, `request_password_reset`, `update_customer`, `delete_business`, `set_coupon_featured` (override/limpeza → `admin_set_coupon_featured`), `set_affiliate_rewards` (→ **`admin_set_affiliate_rewards`**, com `requireFirstClaim !== false`).
- Fase 2: `admin_list_businesses` devolve `billingFeeCents` (e `monthlyFeeCents`); `set_billing` aceita `p_plan='PER_COUPON'` → grava a taxa em `billing_fee_cents` (mensal zerada); demais planos → `monthly_fee_cents` (taxa por cupom zerada).

### `affiliates` — módulo afiliado (público, sem sessão)
- `POST` `{ name, phone, email?, kind? }` → `affiliate_register`. Devolve `{ affiliateId, referralCode, shareUrl }`.
- `GET ?affiliateId=&phone=` → `affiliate_dashboard` (valida telefone; `null` vira `{}`).

### `validate-coupon` — validação pelo estabelecimento
`POST` → `validate_and_redeem_coupon` (produção) — fluxo do dono, intocada.

### `billing` — assinatura mensal Mercado Pago (sessão; MERCHANT dono da empresa ou ADMIN/SUPER_ADMIN)
- `POST` (Bearer) `{ action, businessId }`:
  - `status` → `billing_mp_prepare` → `{ subscriptionId, subscriptionUrl }`.
  - `create` → `billing_mp_prepare` (valida plano/valor/ator) → `POST /preapproval` do MP (`status:"pending"`, `auto_recurring` 1x/mês, `notification_url` → `billing-webhook`) → `billing_mp_register` grava `billing_subscription_id/url`. Devolve `{ initPoint, subscriptionId, already }`; se já existe assinatura, reabre o mesmo `init_point` (não duplica). Rollback: cancela a preapproval no MP se o registro falhar.
  - `cancel` → cancela no MP (best-effort) → `billing_mp_cancel`.
- Envs: `MP_ACCESS_TOKEN`, `MP_NOTIFICATION_URL` (ou `NEXT_PUBLIC_SITE_URL` + sufixo webhook), `MP_API_BASE` (teste).
- Segredos (`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`) ficam só no servidor; o browser só vê `initPoint`.
- Fase 2: plano `PER_COUPON` **não é assinatura** — `billing_mp_prepare` rejeita com `PLAN_NOT_SUBSCRIPTION`. A taxa por resgate é acumulada em `billing_charges` (`coupon_id` preenchido, dedupe por cupom) e cobrada manualmente pelo admin; o painel `billing` do `/admin` lista essas linhas.

### `billing-webhook` — webhook de Assinatura do MP (PÚBLICO, sem sessão)
- `POST /.netlify/functions/billing-webhook` (query `data.id`/`type` + headers `x-signature`, `ts`, `x-request-id`).
- Autenticação: manifest `id:...;request-id:...;ts:...;` → HMAC-SHA256(`MP_WEBHOOK_SECRET`) hex, comparação *timing-safe*, tolerância de relógio de 10 min. Falha → 403, sem detalhe.
- `subscription_authorized_payment` → `GET /authorized_payments/{data.id}` → `billing_mp_webhook_charge` (dedupe por `provider_payment_id`; `coupon_id` NULL).
- `subscription_preapproval` → `GET /preapproval/{data.id}` → `billing_mp_webhook_preapproval` (`authorized`→ACTIVE, `cancelled`→CANCELLED).
- Tipos desconhecidos → 200. RPCs de webhook são inalcançáveis ao cliente (EXECUTE só `service_role`).

### Mapas / infra
- `map-places` → Overpass (OSM, sem dado de cliente). · `radar` → `find_nearby_businesses`. · `upload-image` → storage (sem RPC).

### `shuttle` — translado/proximidade (público, sem sessão)
`GET /.netlify/functions/shuttle?tenantId=...` (+ parâmetros)
- Sempre devolve `{ services: [], vehicles: [] }` (duas RPCs STABLE do Módulo 1, via client de administração):
  - `list_shuttle_services` → serviços de translado ativos do tenant (`shuttleId`, `name`, `serviceType`, `businessName`, `priceCents`, `opensAt`, `closesAt`, `activeDays`, `origin/destination` `{lat,lng}`, `stops`, `distanceKm`).
  - `list_live_vehicles` → posições frescas dos veículos (`driverId`, `driverName`, `lat/lng`, `heading`, `speedKmh`, `recordedAt`, `distanceKm`), descartando posições mais velhas que `maxAgeS` (padrão 300 s).
- Parâmetros opcionais: `lat` + `lng` (juntos, numéricos), `radiusKm` (aplica o raio nos serviços em km e nos veículos em m = radiusKm×1000; exige lat/lng), `maxAgeS` (inteiro positivo).
- Sem `lat/lng`: lista tudo sem `distanceKm` (contrato explícito com o cliente — a UI mostra "sem distâncias"). Sem dados → `[]` (os dois campos sempre presentes).

### `shuttle-reservation` — reserva de translado do cliente (Módulo A)
`GET|POST /.netlify/functions/shuttle-reservation` — **não** é o catálogo público (`shuttle.js`): fluxo próprio, com credencial de cliente (HMAC) e `Cache-Control: no-store` em toda resposta (devolve nome/telefone da empresa e horário de terceiro).
- Credencial IDOR (Regra 3): `tenantId` + `customerId` + `customerToken` (corpo no POST, query no GET); o `customerToken` **bate com o `customerId`** antes de qualquer RPC — par de A com id de B → 401 `CUSTOMER_TOKEN_INVALID` e nenhuma RPC é chamada.
- `GET` (`&status=` opcional, filtro de tela) → `shuttle_list_customer_reservations` → `{ reservations, count }` (sem email/Instagram do cliente; sempre no-store).
- `POST` `action=create` (padrão) `{ shuttleId, scheduledFor, passengers, notes?, contactPhone? }` → `shuttle_create_reservation` → objeto da reserva (`status: 'pending'`). 400: `TENANT_ID_REQUIRED`, `SHUTTLE_ID_REQUIRED`, `SCHEDULED_FOR_REQUIRED`, `INVALID_PASSENGERS`.
- `POST` `action=cancel` `{ reservationId, reason? }` → `shuttle_cancel_reservation` (só `pending`/`confirmed`) → `{ reservationId, status: 'cancelled' }`. 400 `RESERVATION_ID_REQUIRED`; `ACTION_INVALID` para qualquer outra ação.
- Regras de negócio (dia ativo, janela `opensAt/closesAt`, sobreposição com `tstzrange`, escopo do serviço ativo da empresa) vivem **dentro das RPCs** (service_role), não no handler.

### `driver-shuttle-runs` — corridas do dia (Módulo A)
`GET|POST /.netlify/functions/driver-shuttle-runs` — sessão de motorista (`driver_sessions` + `status='approved'`, mesma credencial de `driver-position`; **não** usa `users.sessions`). `driver_id`/`tenant_id`/`business_id` derivados no banco; nada disso vem do corpo. `Cache-Control: no-store`.
- `GET` (`&date=YYYY-MM-DD` opcional; sem ele o dia corrente no fuso do banco) → `driver_list_shuttle_runs` → `{ date, runs, count }`. Não devolve nome nem telefone do cliente (agenda da rota, não folha de contato). Erros: `SESSION_EXPIRED` 401, `NOT_APPROVED` 403.
- `POST` `{ reservationId }` → `driver_complete_shuttle_reservation` (só `confirmed` → `completed`; escopo da frota do motorista) → `{ reservationId, status: 'completed', completedAt }`. 400 `RESERVATION_ID_REQUIRED`.

### Motorista (`driver-*`, Worker `routes/drivers`)
Vínculo por telefone: `driver_register`, `driver_set_pin`, `driver_login`, `driver_logout`, `driver_verify_session`, `driver_list_for_business`, `driver_review_document`, `driver_add_document`, `driver_get_document_path` (+ `business_generate_invite`, `business_logo_by_id` usados pela classe). Frontend em `app/motorista` com lógica pura testada em `motorista/logic.js`.

#### `driver-position` — transmissão de posição do veículo (POST, sessão de motorista)
`POST /.netlify/functions/driver-position` com `Authorization: Bearer <sessionToken>` e corpo `{ lat, lng, heading?, speedKmh?, shuttleId? }`.
- Chama `driver_report_position` (SECURITY DEFINER): valida a sessão (`driver_sessions` não expirada → `SESSION_EXPIRED` 401; `status != approved` → `NOT_APPROVED` 403), coordenadas/heading/speed e `shuttleId` (ativo e do próprio tenant → `SHUTTLE_NOT_FOUND` 404).
- `driver_id` **nunca** vem do cliente — é derivado da sessão no banco (um motorista não grava posição em nome de outro).
- Upsert em `vehicle_positions` (1 posição por motorista); resposta `{ driverId, recordedAt }` com `Cache-Control: no-store`.

## RPCs novas (neste pacote — aplicadas via MCP; pendem apenas deploy do front)

| RPC | Arquivo SQL | O que faz |
| --- | --- | --- |
| `list_categories(p_tenant_id)` | `supabase/offers-v3-filters-and-coupon-featured.sql` | Categorias ativas e normalizadas |
| `norm_categoria(text)` | idem | Normaliza categoria (lower + sem acento) |
| `list_offers(v3, 6 args)` | idem | Ordena: destaque ativo → rank → distância → nome; retorna `featured`, `featuredUntil`, `distanceKm` |
| `business_set_coupon_featured` | idem | Self-service da empresa (zera o anterior) |
| `admin_set_coupon_featured` | idem | Override/limpeza pelo admin |
| `business_update_own` v10 | idem | Adiciona `category` |
| `affiliate_dashboard` | `supabase/affiliates-wiring.sql` | Perfil + números + lista de indicações (validado por telefone) |
| `admin_affiliate_report` | idem | Relatório geral (plpgsql, checa role) |
| `admin_get/set_affiliate_rewards` | idem | Config de cupons-prêmio (fail-open sem config) |
| `billing_mp_prepare` | `supabase/billing-mercadopago-subscriptions.sql` | Valida ator/empresa/plano; devolve payload da preapproval (ou o url já existente) |
| `billing_mp_register` | idem | Grava `billing_subscription_id/url` após criar no MP |
| `billing_mp_cancel` | idem | Limpa assinatura locaç e marca `CANCELLED` |
| `billing_mp_webhook_preapproval` | idem | Evento `subscription_preapproval` → status do negócio |
| `billing_mp_webhook_charge` | idem | `subscription_authorized_payment` → insere `billing_charges` (dedupe) + ACTIVE |
| `billing_record_coupon_tax` | `supabase/p2-taxa-por-cupom.sql` | Fase 2: grava taxa por resgate (plano `PER_COUPON`) em `billing_charges` com `coupon_id`; dedupe por cupom; devolve `true/false` (via em conflito). Excludente com `billing_mp_*` |
| `business_save_shuttle_service` | `supabase/translado-write-flow.sql` | **Módulo 1 escrita** — cria/edita serviço de translado do próprio negócio (valida nome, tipo, coords, stops, preço, horários, dias) |
| `business_toggle_shuttle_service` | idem | Ativa/desativa serviço próprio do negócio |
| `business_delete_shuttle_service` | idem | Apaga serviço próprio (posições ficam com `shuttle_id` NULL) |
| `business_list_shuttle_services` | idem | Lista serviços do próprio negócio (com inativos, para o painel) |
| `driver_report_position` | idem | Upsert da posição do veículo a partir da sessão do motorista (só `approved`; `driver_id` derivado no banco) |
| `shuttle_create_reservation` | `supabase/agendamento.sql` | **Módulo 3 (A) — agendamento** — cria reserva `pending` (lock do serviço ativo por `FOR UPDATE`; `INVALID_PASSENGERS`, `SHUTTLE_NOT_FOUND`, `INVALID_SCHEDULE`, `DAY_NOT_ACTIVE`, `OUTSIDE_HOURS`, `SLOT_CONFLICT` por `tstzrange`) |
| `shuttle_cancel_reservation` | idem | Cliente cancela `pending`/`confirmed` → `cancelled` (com `reason`) |
| `shuttle_list_customer_reservations` | idem | Reservas do cliente (filtro `p_status`) |
| `business_list_shuttle_reservations` | idem | Reservas da empresa (filtráveis por `p_status`/`p_date` no fuso `America/Sao_Paulo`) |
| `business_review_shuttle_reservation` | idem | Empresa decide `confirm`/`reject`/`cancel` (transições validas; `REASON_REQUIRED` para recusa; `decided_by`/`decided_at`) |
| `driver_list_shuttle_runs` | idem | Corridas do dia do motorista (sessão `driver_sessions`; sem nome/telefone do cliente) |
| `driver_complete_shuttle_reservation` | idem | `confirmed` → `completed` (escopo da frota do motorista) |
| `business_save_shuttle_service` (nova assinatura) | idem | + `p_duration_minutes` (15..720, DEFAULT NULL mantém atual); DROP+CREATE (assinatura mudou) — por isso ACL re-fechado no `close-function-exec` |
| `business_delete_shuttle_service` (recriada) | idem | Volta a recusar com `SHUTTLE_HAS_RESERVATIONS` quando há `pending`/`confirmed` |
| `outbound_enqueue` | `supabase/notificacoes.sql` | **Módulo B — notificações (fase 1: fila/auditoria)** — grava 1 linha por (evento, canal); dedupe por `coupon_id`/`booking_ref`; default `provider='none'`/`status='noop'` (no-op observável) |
| `outbound_mark_sent` / `outbound_mark_failed` | idem | Idempotentes; `error_code` passa por filtro de caracteres (nunca a mensagem crua do provedor) |
| `outbound_list` | idem | Auditoria para `ADMIN`/`SUPER_ADMIN` (nunca devolve `body`/`destination`) |
| `business_report_v3` | `supabase/business-report-v3.sql` | **Módulo C — relatório v3** — `totals`/`daily`/`byCampaign`/`byTemplate` (mesmas agregações da v2) + `drivers` (memo escopo), `billing` (`chargedCents`), `shuttle`, `rides: null`; nasce fechada e aditiva (a v2 `business_report` segue intacta; handler degrada com fallback)

**Nota**: as funções de produção (linha "produção" acima) não têm arquivo `.sql` no repo — vivem apenas no Supabase remoto. Não edite produção sem passar pelo `supabase` (migração versionada + advisors).

## RPCs existentes apenas em produção (sem `.sql` no repo)

`admin_billing_panel`, `admin_create_business`, `admin_list_businesses`, `admin_list_customers`, `admin_request_password_reset`, `admin_set_billing`, `admin_toggle_business`, `admin_update_business`, `admin_update_customer`, `auth_login`, `auth_pin_reset_required`, `auth_verify_session`, `business_coupon_stats`, `business_delete_template`, `business_set_pin`, `business_toggle_template`, `business_update_template`, `create_campaign`, `create_coupon_template`, `empresa_dashboard`, `identify_customer`, `list_customer_coupons`, `validate_and_redeem_coupon`, `list_shuttle_services`, `list_live_vehicles` (as duas últimas do Módulo 1 têm `.sql` versionado em `supabase/modulo1-motoristas-translado-proximity.sql`, já aplicado).

### Contrato das 6 RPCs acima (trava automática no call-site)

A lista acima é maior que 6: só estas **não** têm `.sql` versionado de forma
confiável e são chamadaas pelos handlers. Sem o SQL, a assinatura (quais `p_*`
cada uma aceita) não é verificável no repo — só o PostgREST de produção sabe.
O que dá para travar é o lado do call-site:

`tests/rpc-contract-guard.test.cjs` fixa o conjunto exato de parâmetros de cada
uma com `deepStrictEqual` sobre `Object.keys`:

| RPC | `p_*` esperados |
|---|---|
| `admin_list_customers` | `p_tenant_id`, `p_actor_user_id`, `p_search` |
| `admin_toggle_business` | `p_tenant_id`, `p_actor_user_id`, `p_business_id`, `p_is_active` |
| `admin_update_customer` | `p_tenant_id`, `p_actor_user_id`, `p_customer_id`, `p_name`, `p_email`, `p_instagram`, `p_is_active` |
| `admin_update_business` | `p_tenant_id`, `p_actor_user_id`, `p_business_id`, `p_name`, `p_phone`, `p_email`, `p_category`, `p_city`, `p_cnpj`, `p_website`, `p_logo_url` |
| `create_campaign` | `p_tenant_id`, `p_business_id`, `p_actor_user_id`, `p_title` |
| `empresa_dashboard` | `p_tenant_id`, `p_business_id` |

Quando o `.sql` de uma delas for versionado, a linha sai daqui: o teste passa de
call-site para fonte da verdade.

**Consequência prática**: renomear um `p_*` no handler quebra o teste local, em
vez de virar um `function ... does not exist` para o usuário em produção.

### O contrato de `empresa_dashboard` é snake_case e pass-through

O modo default de `empresa` (`empresa.js:139`) faz `JSON.stringify(data)` sem
remodelar nada. Portanto `app/empresa/page.jsx` lê as colunas da RPC como são, e a
convenção é **snake_case** — diferente das RPCs novas (`admin_get_affiliate_rewards`,
`list_customer_coupons`, que devolvem camelCase). Confirmado no JSX:

| Bloco | Campos lidos |
|---|---|
| `campaigns[]` | `id`, `title`, `status` |
| `templates[]` | `id`, `title`, `image_url`, `is_active`, `issued_count`, `featured_until` |
| `coupons[]` | `id`, `publicId`, `status`, `customerName`, `customerPhone` |

(`startEditTemplate`, `page.jsx:750`, traduz snake→camel para o formulário de
edição — é a única fronteira da tela.)

`is_active` é o caso perigoso: `page.jsx:1105` compara `=== false` para riscar o
item e trocar o rótulo do botão. Se a coluna sumir ou virar string, nenhum erro
aparece — um template desativado simplesmente passa a parecer ativo.

Nada disso é verificável sem o `.sql`. `tests/live.dashboard-contract.test.cjs`
pergunta à produção (`npm run test:live:contract`, com `RUN_LIVE=1` +
`LIVE_TENANT`/`LIVE_CODE`/`LIVE_PIN`) e falha se algum campo lido pela UI não
existir no retorno. Ele só prova o contrato quando cada bloco tem ao menos um
elemento; negócio sem dados deixa o teste sem poder de prova, por desenho.

## Frontend (roteamento do app)

`/` (captura `?ref=` → `localStorage.pyv_ref`), `/cliente` (filtros cidade/atividade/raio + "Perto de mim" + badge ⭐ + repasse de `ref` no identify/claim, mapa Leaflet, **Translado e proximidade**: serviços de translado + veículos ao vivo com geolocalização e empty state honesto + **Reservar translado / Minhas reservas**: agenda por serviço, cancelamento com motivo e link wa.me para a empresa), `/empresa` (categoria em Meus dados + destaque por período + aba Instagram com gerador de card 1080×1080 em canvas + **aba Translado** com CRUD de serviços + **aba Reservas** com filtros por status e confirmar/recusar/cancelar + **Relatório** com períodos 7/30/90), `/admin` (seção Afiliados: relatório + config de rewards), `/afiliado` (cadastro, link com QR, WhatsApp/Instagram, painel), `/motorista` (cadastro/documentos + **Transmissão de posição** + **Minhas corridas de hoje** com concluir corrida).

## Migrações versionadas (estado)

Todas aplicadas via MCP (`apply_migration`) após aprovação do dono; advisors security+performance pós-cada com `app_ainda_abertas = 0` (96 funções de app, 0 abertas ao cliente). Ordem de aplicação e nomes:

1. `supabase/offers-v3-filters-and-coupon-featured.sql` — coluna `featured_until`, `norm_categoria`, `list_categories`, `list_offers` v3, `business_set_coupon_featured`, `admin_set_coupon_featured`, `business_update_own` v10, e DROPs das assinaturas antigas (`list_offers(uuid)`, `business_update_own` 9-arg).
2. `supabase/affiliates-wiring.sql` — `affiliate_dashboard`, `admin_affiliate_report`, `admin_get/set_affiliate_rewards` (dependem do Módulo 3/3b já aplicado).
3. `supabase/p2-taxa-por-cupom.sql` — fase 2 (aplicada em 3 migrations via MCP: `p2_taxa_por_cupom`, `p2_billing_plan_check_per_coupon`, `p2_fix_billing_record_coupon_tax_null`): coluna `businesses.billing_fee_cents`, índice parcial `idx_billing_charges_coupon_id`, plano `PER_COUPON` no check, RPC `billing_record_coupon_tax` e ajustes de `admin_set_billing`/`admin_list_businesses`/`billing_mp_prepare`.
4. `supabase/translado-write-flow.sql` — APLICADA em 2026-09-29 via MCP (`translado_write_flow`): 5 RPCs de escrita do Módulo 1; advisors pós-registro sem achados novos.
5. `supabase/agendamento.sql` — APLICADA em 2026-09-29 via MCP (`agendamento_translado`): tabela `shuttle_reservations`, coluna `shuttle_services.duration_minutes`, 7 RPCs do Módulo A + redefinição de `business_save_shuttle_service`/`business_delete_shuttle_service` (DROP antes de CREATE porque a assinatura muda — evita sobrecarga e ACL antigo aberto).
6. `supabase/notificacoes.sql` — APLICADA em 2026-09-29 (`notificacoes_outbound_messages`): `outbound_messages` + 4 RPCs de fila/auditoria (fase 1; o despacho agendado fica para quando houver provedor real).
7. `supabase/business-report-v3.sql` — APLICADA em 2026-09-29 (`relatorio_empresa_v3`): `business_report_v3` + índice `billing_charges_business_created_idx`.
8. `supabase/close-function-exec.sql` + índices de FK — APLICADAS em 2026-09-29 (`close_function_exec_acls` e `indexes_fk_reservas_avisos`): re-fecha EXECUTE de todo `public` (as DROP+CREATE da seção 10 do agendamento reabrem ACL) e cobre `business_id`/`decided_by` de `shuttle_reservations` + `customer_id` de `outbound_messages` (delta de `unindexed_foreign_keys` zerado).