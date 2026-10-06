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
- `businessCardFor=<businessId>` → `business_public_card` (`jsonb`: `name`, `logoUrl`, `phone`, `website`, `instagram`; ACL apenas `service_role`). Depende da p9: enquanto a RPC não existir, o handler responde 404 e a tela segue só com o que veio da lista.

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
  - `list_live_vehicles` → posições frescas dos veículos (`driverId`, `driverName`, `lat/lng`, `heading`, `speedKmh`, `accuracyM`, `recordedAt`, `distanceKm`), descartando posições mais velhas que `maxAgeS` (padrão 300 s). `accuracyM` é o raio de confiança do fix em metros (NULL = desconhecido; valores grandes indicam palpite por Wi‑Fi/IP).
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
Vínculo por telefone: `driver_register`, `driver_set_pin`, `driver_login`, `driver_logout`, `driver_verify_session`, `driver_list_for_business`, `driver_review_document`, `driver_add_document`, `driver_get_document_path`, `admin_driver_reset_pin` (+ `business_generate_invite`, `business_logo_by_id` usados pela classe). Frontend em `app/motorista` com lógica pura testada em `motorista/logic.js`.

#### `driver-reset-pin` — redefinição de PIN pela empresa (POST, sessão de empresa)
`POST /.netlify/functions/driver-reset-pin` com `Authorization: Bearer <sessionToken>` (sessão de **empresa/admin**, a mesma de `driver-review-document`) e corpo `{ driverId, newPin }`.
- Sem sessão → 401 antes de tocar o banco. `p_actor_user_id` e `p_tenant_id` vêm da sessão, nunca do corpo.
- `newPin` é validado no handler (4 a 8 dígitos, só número) → 400 `PIN_REQUIRED`/`PIN_INVALID` sem escrita. O PIN nunca volta na resposta nem é logado.
- Chama `admin_driver_reset_pin` (SECURITY DEFINER): exige papel `MERCHANT`/`ADMIN`/`STAFF`/`SUPER_ADMIN` e escopo `SUPER_ADMIN` = qualquer motorista do tenant, empresa = os próprios + os independentes (`business_id` NULL). `FORBIDDEN` 403, `DRIVER_NOT_FOUND` 404. Erro fora dessa lista não repassa a mensagem do Postgres.
- Resposta `{ ok, driverId, sessionsRevoked }` com `Cache-Control: no-store`. A RPC derruba as sessões abertas do motorista.
- É o único caminho de recuperação de PIN: `driver-set-pin` só funciona com o `pinToken` do cadastro, que morre no primeiro uso. SQL: `supabase/fix-admin-driver-reset-pin-role.sql` (papel) + `supabase/modulo4-motoristas.sql` §9.

#### `driver-position` — transmissão de posição do veículo (POST, sessão de motorista)
`POST /.netlify/functions/driver-position` com `Authorization: Bearer <sessionToken>` e corpo `{ lat, lng, heading?, speedKmh?, shuttleId?, accuracyM? }`.
- Chama `driver_report_position` (SECURITY DEFINER): valida a sessão (`driver_sessions` não expirada → `SESSION_EXPIRED` 401; `status != approved` → `NOT_APPROVED` 403), coordenadas/heading/speed, `accuracyM` (sanidade `0..100000` → `INVALID_ACCURACY` 400; o limite de política de 150 m fica no cliente) e `shuttleId` (ativo e do próprio tenant → `SHUTTLE_NOT_FOUND` 404).
- `driver_id` **nunca** vem do cliente — é derivado da sessão no banco (um motorista não grava posição em nome de outro).
- `accuracyM` é o `coords.accuracy` do aparelho (metros). O app do motorista só auto-envia quando `accuracyM` é conhecido e ≤ 150 m, para um computador sem GPS (palpite por Wi‑Fi/IP) não sobrescrever a posição do celular; envio manual continua permitido e a tela avisa.
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
| `driver_report_position` | idem | Upsert da posição do veículo a partir da sessão do motorista (só `approved`; `driver_id` derivado no banco; grava `accuracy_m`) |
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

### Contrato das 14 RPCs acima (trava automática no call-site)

**São 14, não 6.** A contagem aqui é `CREATE [OR REPLACE] FUNCTION` de verdade, e
não qualquer menção do nome. Uma varredura por substring dava 6 e errava nos dois
sentidos:

- contava comentário como definição — `auth_login` aparece em
  `email-login-billing.sql:26` só num comentário que diz "espelha auth_login";
  a função definida no mesmo arquivo é `auth_login_by_email`;
- perdia as 8 que não têm menção nenhuma, invisíveis a busca por texto
  (`business_coupon_stats` só aparece em comentário, em
  `business-report-v3.sql:18`).

Sem o `.sql`, a assinatura (quais `p_*` cada uma aceita) não é verificável no
repo — só o PostgREST de produção sabe. O que dá para travar é o call-site.
`tests/rpc-contract-guard.test.cjs` fixa o conjunto exato de cada uma com
`deepStrictEqual` sobre `Object.keys`:

| RPC | `p_*` esperados |
|---|---|
| `admin_billing_panel` | `p_tenant_id`, `p_actor_user_id` |
| `admin_create_business` | `p_tenant_id`, `p_actor_user_id`, `p_name`, `p_category`, `p_city`, `p_phone`, `p_email`, `p_lat`, `p_lng`, `p_owner_internal_code`, `p_owner_pin`, `p_billing_plan`, `p_cnpj`, `p_website`, `p_logo_url` |
| `admin_list_customers` | `p_tenant_id`, `p_actor_user_id`, `p_search` |
| `admin_toggle_business` | `p_tenant_id`, `p_actor_user_id`, `p_business_id`, `p_is_active` |
| `admin_update_business` | `p_tenant_id`, `p_actor_user_id`, `p_business_id`, `p_name`, `p_phone`, `p_email`, `p_category`, `p_city`, `p_cnpj`, `p_website`, `p_logo_url` |
| `admin_update_customer` | `p_tenant_id`, `p_actor_user_id`, `p_customer_id`, `p_name`, `p_email`, `p_instagram`, `p_is_active` |
| `auth_login` | `p_tenant_slug`, `p_internal_code`, `p_pin` |
| `auth_verify_session` | `p_session_token` |
| `business_coupon_stats` | `p_tenant_id`, `p_business_id` |
| `create_campaign` | `p_tenant_id`, `p_business_id`, `p_actor_user_id`, `p_title` |
| `create_coupon_template` | `p_tenant_id`, `p_business_id`, `p_campaign_id`, `p_actor_user_id`, `p_title`, `p_benefit_type`, `p_benefit_value`, `p_total_stock`, `p_image_url` |
| `empresa_dashboard` | `p_tenant_id`, `p_business_id` |
| `identify_customer` | `p_tenant_id`, `p_phone`, `p_name`, `p_email`, `p_instagram` |
| `validate_and_redeem_coupon` | `p_tenant_id`, `p_business_id`, `p_public_id`, `p_raw_token`, `p_actor_user_id`, `p_idempotency_key`, `p_short_code` |

`auth_verify_session` merece atenção: não é chamada por um handler, e sim pelo
helper compartilhado `_supabaseAdmin.resolveSession` (`_supabaseAdmin.js:27`),
que roda em **toda** rota autenticada. Um `p_*` errado ali derruba o sistema
inteiro de uma vez.

Quando o `.sql` de uma delas for versionado, a linha sai daqui: o teste passa de
call-site para fonte da verdade. `tests/rpc-contract-guard.inventory.test.cjs`
refaz a varredura e falha se a lista divergir do repo, para a contagem não
envelhecer em silêncio.

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
9. `supabase/p3-idempotencia-claim-coupon.sql` — APLICADA em 2026-10-03 (`p3_idempotencia_claim_coupon`): `claim_coupon` ganha o 7º parâmetro `p_idempotency_key text DEFAULT NULL`. A chamada antiga de 6 argumentos continua funcionando; sem chave o comportamento é o de sempre. Mesma chave devolve o mesmo cupom com `idempotent: true`; chave diferente pode emitir outro resgate, limitado por `per_customer_limit`. A função foi `DROP`+`CREATE` (não `CREATE OR REPLACE`) porque dois overloads com `DEFAULT` fariam a chamada do PostgREST ser ambígua. Roda `SELECT ... FOR UPDATE` no template para serializar concorrência. **Rollback:** `p3-idempotencia-claim-coupon.rollback.sql`.
10. `supabase/p4-purge-idempotency-keys.sql` — APLICADA em 2026-10-03 (`p4_purge_idempotency_keys`): expurgo do `idempotency_keys` com TTL de **7 dias** (decisão do dono), `pg_cron` instalado e job `purge-idempotency-keys` agendado para `23 4 * * *` UTC. Índice em `created_at` (a PK é `(tenant_id, operation, idempotency_key)` e não ajuda num filtro por data). A migration **não** apaga nada sozinha — a limpeza é do cron. **Rollback:** `p4-purge-idempotency-keys.rollback.sql`, que não recupera as linhas já vencidas.
11. `supabase/p5-cifrar-idempotency-keys.sql` — APLICADA em 2026-10-03 (`p5_cifrar_idempotency_keys`, corrigida por `p5b_chave_texto_pgcrypto`, com a chave regenerada em `p5c_chave_base64_limpa`): o resultado de `coupon.claim` passa a ser gravado em `idempotency_keys.result_enc`, cifrado com AES-256 (`pgcrypto`), em vez de `rawToken` em texto claro. `result` fica nullable e um CHECK XOR exige exatamente um dos dois. A chave de 256 bits vive em `public.idempotency_keys_secret`, com ACL apenas para `postgres` — `service_role` mantém SELECT em `idempotency_keys` e por isso não consegue ler a chave. `coupon.validate` **não** é tocada (ali há PII, não segredo). **Rollback:** `p5-cifrar-idempotency-keys.rollback.sql`, que apaga as linhas cifradas em vez de tentar converter, e avisa que volta a um estado menos seguro.
12. `supabase/p6-cpf-cnpj-motorista.sql` — **APLICADA em 2026-10-05** (`p6_cpf_cnpj_motorista`), depois do backup `pyv-web-backup-71`; advisors de segurança pós-registro sem achado novo e `app_ainda_abertas = 0`: `drivers.cpf`, `drivers.cnpj`, `drivers.legal_name` (nullable, com o dado em dígitos), validadores `IMMUTABLE` de DV com `search_path` fixo, dois índices únicos parciais por tenant, e `driver_register` passando a 9 parâmetros. O truque operacional está no `DROP` da assinatura de 6 seguido de **uma** função de 9 com `DEFAULT NULL` nos três novos: o worker antigo em produção continua resolvendo pela chamada de 6 argumentos e só volta a errar na p7, de forma explícita. Manter as duas sobrecargas de pé não funcionaria — com `DEFAULT`, uma chamada de 6 argumentos casaria com as duas e o Postgres responderia `function ... is not unique` sem erro no código que chama. Também expõe `driver_list_for_business` para a empresa enxergar os três campos na aba Motoristas. **Rollback:** `p6-cpf-cnpj-motorista.rollback.sql` (volta a 6 parâmetros; **não** apaga colunas nem índices). Verificação após aplicar: 1 sobrecarga só (`driver_register(uuid,text,text,text,uuid,text,text,text,text)`), ACL `postgres` + `service_role`, 3 colunas e 2 índices criados, 2 motoristas intactos, e uma chamada de 6 argumentos resolvendo (falha em `PHONE_INVALID`, antes de qualquer `INSERT`) — prova de que o worker antigo em produção não foi quebrado. Os corpos de `driver_register` e `driver_list_for_business` em produção foram lidos antes de aplicar e conferidos linha a linha: a p6 é um **superset** deles (mesmas validações, rate limit, checagens de duplicidade, tratamento de convite, insert e retorno; a p6 só acrescenta as 3 colunas), então nada foi perdido.
13. `supabase/p7-cpf-obrigatorio-motorista.sql` — **APLICADA em 2026-10-05** (`p7_cpf_obrigatorio_motorista`), depois que o commit `73770d3` foi confirmado no ar (chunk `_next/static/chunks/622-e0498ebc9e03a913.js` respondendo 200 com as strings novas, e o formulário de `/motorista` mostrando os campos CPF e CNPJ): exige CPF válido no `driver_register` (erro `CPF_REQUIRED`), mantendo CNPJ e razão social opcionais. **A ordem é obrigatória: p6 → publicar o código novo → p7.** Aplicar a p7 antes do deploy faz o worker antigo parar de funcionar (a tela nova exige CPF e ainda não está no ar); o arquivo avisa isso no cabeçalho. `supabase/modulo4b-token-cadastro.sql` também derruba a assinatura de 9 agora, porque reaplicá-lo depois da p7 recriaria a de 6 ao lado da de 9 e reproduziria a ambiguidade acima. Verificação: `CPF_REQUIRED` sem CPF, e com CPF válido o fluxo segue até a checagem de telefone; `drivers` segue com 2 linhas e `cpf` nulo nas antigas. **Rollback:** `p7-cpf-obrigatorio-motorista.rollback.sql` (troca o corpo da função via `CREATE OR REPLACE`, voltando ao estado da p6 com CPF opcional; não recria a sobrecarga de 6 e não apaga coluna).
14. `supabase/p8-cota-free-cupons.sql` — **APLICADA em 2026-10-05** (`p8_cota_free_cupons`): `businesses.free_coupon_allowance` (default 10) e `businesses.free_coupons_used` (default 0), ambas `NOT NULL` com CHECK não-negativo; backfill/grandfather que preserva quem já tem mais de 10 (`allowance = used`); `claim_coupon` com **a mesma assinatura de 7 argumentos**, que passa a Incrementar o contador e a devolver `FREE_COUPON_QUOTA_EXCEEDED` quando a empresa FREE estoura a cota vitalícia. O replay idempotente é conferido **antes** da cota, e a RPC nova `business_coupon_allowance(uuid, uuid)` devolve `jsonb` (`available`, `limited`, `allowance`, `used`, `remaining`) com ACL apenas para `service_role`. `billing_plan IS NULL` conta como FREE; planos pagos não têm limite. `allowance = 0` significa bloqueio total (kill switch do admin), não "sem limite". Leitura pelo painel em `empresa?mode=allowance`, que degrada para `{available:false}` enquanto a RPC não existir — por isso a UI pode subir antes da migration. Antes de aplicar, os dois `UPDATE` foram simulados em `SELECT`: o resultado real depois de aplicar bateu exatamente com o previsto (soma de `allowance` FREE = 192, 17 empresas ainda com saldo, 1 empresa no grandfather com 12 cupons, 0 empresas fora da regra). `claim_coupon` em empresa zerada devolveu `FREE_COUPON_QUOTA_EXCEEDED` sem gravar nada — nem cupom, nem o `INSERT` de usuário que roda antes da cota (rollback da transação), e a soma de `used` continuou 48. `business_coupon_allowance` devolveu `limited/allowance/used/remaining` batendo com as colunas, e `FORBIDDEN` para ator `CUSTOMER`. Cupons (48), templates (17) e campanhas (16) intactos. **Rollback:** `p8-cota-free-cupons.rollback.sql` (restaura a `claim_coupon` cifrada da p5 e remove as colunas; **não** apaga cupons nem campanhas, e os contadores perdidos são reconstituíveis por `COUNT`).
15. `supabase/p9-contato-publico-empresa.sql` — **APLICADA em 2026-10-06** (`p9_contato_publico_empresa`): `businesses.instagram` (nullable, sem default) e o helper `public.normalize_instagram(text)` (`IMMUTABLE`, `search_path = pg_temp`, `STRICT`) que deixa só o handle canônico — sem `@`, sem `https://`, sem barra final e em minúsculas, para o mesmo perfil nunca virar dois cadastros. `business_get_own` e `list_offers` passam a devolver `website`/`instagram`; `list_customer_coupons` ganha `businessId`, `businessLogoUrl`, `businessWebsite` e `businessInstagram`, o que tira a dependência de `localStorage` para identificar a empresa de um cupom resgatado em outro aparelho. Nova `business_public_card(uuid)` (`jsonb`, `security definer`, ACL só `service_role`) devolve a ficha pública da empresa em uma chamada. As 4 funções de escrita (`register_business`, `business_update_own`, `admin_create_business`, `admin_update_business`) ganham `p_instagram` como **último** parâmetro com `DEFAULT NULL`, e `business_update_own` também `p_website`; como no `DROP`+`CREATE` do padrão p3/p6, `DEFAULT` no meio da lista seria erro de sintaxe e manter a sobrecarga antiga criaria ambiguidade de resolução no PostgREST. Semântica no update: `NULL` mantém o valor salvo, string vazia limpa o campo — por isso o worker mapeia `undefined → null` e `'' → ''`, nunca `|| null` nos dois casos. `admin_list_businesses` passa a devolver `instagram`. **Ordem:** o worker novo funciona antes da p9 (o parâmetro novo é o último e tem default) e o worker antigo continua funcionando depois dela; ainda assim, publicar o código antes deixa o rollout reversível sem janela quebrada. **Rollback:** `p9-contato-publico-empresa.rollback.sql` (remove as funções novas, devolve as 4 assinaturas antigas e **não** apaga a coluna, para não perder dado já cadastrado).
16. `supabase/fix-normalize-instagram.sql` — **APLICADA em 2026-10-06** (`fix_normalize_instagram`): recria `public.normalize_instagram` com a mesma assinatura `(text)`, portanto só `CREATE OR REPLACE` — o ACL (só `service_role` + `postgres`) fica de pe. Saiu da validação da p9 em produção, que mediu tres defeitos de contrato: (a) o prefixo exigia esquema (`'^https?://(www\.)?instagram\.com/'`), então `instagram.com/playas` passava inteiro e o app montava `https://instagram.com/instagram.com/playas` (404) — corrigido para `'^((https?://)?(www\.)?instagram\.com/?)'`, que também cobre a colagem de `https://instagram.com` sem barra (vira `NULL`); (b) `'^@+'` é ancorado e rodava antes do `btrim`, então `  @playas  ` gravava `@playas` no banco — corrigido com `btrim(coalesce(p_handle,''))` como **argumento** da primeira troca; (c) faltava `lower()`, que o próprio `API.md` documentava — sem ele, `@Playas` e `@playas` seriam duas linhas do mesmo perfil, contra o propósito declarado da p9 ("um jeito só de gravar o mesmo perfil"). `businesses.instagram` tinha **0** linhas preenchidas na data da correção, então não há dado no formato antigo a reprocessar e não há rollback. Verificado em produção: `@playas`, `instagram.com/playas`, `https://www.instagram.com/playas/`, `playas`, `PLAYAS` e `  @novo_perfil  ` todos normalizam certo, `https://instagram.com`/`''`/`NULL` viram `NULL`, `provolatile = 'i'` e ACL inalterado. No front, `instagramHandle()` em `app/cliente/page.jsx` passa a ser a **única** fonte do link e do texto exibidos, para os dois nunca discordarem. O teste da p9 (`tests/p9-contato-empresa-guard.test.cjs`) deixou de procurar o texto `instagram\.com` no corpo do SQL e agora extrai os padrões de `regexp_replace` e os **executa** contra os formatos documentados — o assert antigo passava com a função errada.