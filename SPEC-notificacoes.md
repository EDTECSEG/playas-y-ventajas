# Spec: Notificações

> Especificação de módulo (nada de código implementado aqui). Data: 29/09/2026.
> Padrões vigentes: handlers CJS em `netlify/functions` como fonte única (o espelho ESM `functions/.netlify/functions` foi removido em 2026-09-30, junto com o `tests/consistency.test.cjs`; o contrato do diretório está em `tests/function-contract.test.cjs`); handlers publicam rota pela whitelist `ROUTES` de `worker/main.js`; regras de negócio em RPC `SECURITY DEFINER` com `search_path` fixo e `EXECUTE` só para `service_role`.

## Objetivo

Avise o cliente (WhatsApp e/ou email) quando (a) ele resgatar um cupom e (b) uma reserva de translado for confirmada — sem que o aviso jeopardize o fluxo transacional que o originou.

Critérios de aceite mensuráveis:

1. `claim-coupon` mantém contrato idêntico com e sem notificação: mesmo status, mesmo corpo, mesmo `whatsappUrl`. Zero mudança em `claim_coupon` (caminho crítico intocado).
2. Falha de notificação (provedor ausente, 500 do provedor, timeout, timeout de rede, erro de RPC de auditoria) **nunca** altera o status HTTP do resgate nem da reserva: falha do aviso ⇒ resposta 200 e `notes`/`warnings` coerente.
3. Com env ausente (padrão de fábrica), 100% dos eventos geram exatamente uma linha em `outbound_messages` com `provider='none'` e `status='noop'`, mais uma linha de log em `console` no formato `notificacoes: noop <canal> <evento> <id>` — sem texto de mensagem nem PII do cliente além de identificadores já presentes no banco.
4. Latência adicionada ao `claim-coupon` ≤ 150 ms no caminho sem provedor (gravação best-effort já é padrão do handler) e ≤ 2 s com provedor configurado, sob timeout total de 3 s.
5. Nenhum segredo novo (`WA_*`, `SMTP_*`, `RESEND_*`) aparece em resposta HTTP, log de cliente ou bundle do navegador — apenas no servidor (mesma regra de `MP_ACCESS_TOKEN` do módulo `billing`).
6. `tests/function-contract.test.cjs` continua verde sem alteração manual: qualquer módulo novo importado por handler precisa entrar em `HELPERS` no teste.
7. Cobertura: novos testes unitários com adaptador fake, sem chamada de rede; `npm test` e `npm run build` verdes.

## Integrações existentes a tocar

| Ponto | Arquivo | O que muda |
| --- | --- | --- |
| Resgate de cupom | `netlify/functions/claim-coupon.js` | Após o bloco best-effort de `billing_record_coupon_tax` (já fora do caminho crítico), dispara `notifyOutbound(...)` em `try/catch`. `publicId`, `customerId`, `couponId` e o contexto do banco (`loadOfferContext`) são a entrada; nada vem do corpo do request além do que a RPC já validou. O `shortCode` deixou de ser enviado ao texto em 2026-09-30 (o balcão não tem campo para digitá-lo e o código longo já autoriza sozinho), mas a coluna e o `p_short_code` continuam existindo para material antigo. |
| Contexto do cliente | `netlify/functions/identify.js`, RPC `identify_customer` | Não muda. Fonte de verdade para `email`/`instagram`/`phone` do cliente é `users` (via `identify_customer`/tabela), com o telefone como identidade válida; `email` segue dado **não verificado** (decisão de segurança registrada) — email não é canal confiável por padrão. |
| Módulo de translado | `netlify/functions/empresa.js`, `shuttle.js`, `app/empresa`, `app/cliente` | Somente quando existir o evento "reserva confirmada". Hoje **não existe reserva/booking no repo** (nenhuma tabela `*_bookings*`/`reservas` e nenhuma RPC de reserva — só CRUD de serviço e leitura pública). Ver "Perguntas em aberto" P1. |
| Ponto de conferência de cupom | `netlify/functions/validate-coupon.js` | Fora do escopo desta fase (fluxo do dono, intocado). Fica listado como candidato futuro, não como alteração. |
| Worker | `worker/main.js` (ROUTES) | Nenhuma rota nova obrigatória: o módulo é helper + called-out pelos handlers. Se o módulo Choices receber um endpoint de consulta, a entrada precisa ser adicionada aqui. |
| Docs | `API.md`, `RELATORIO-FUNCIONALIDADES.md` | Seção nova descrevendo hooks, RPCs e defaults; Maintaining (testes) count atualizado. |

## Mudanças no banco (tabelas/RPCs, sem SQL)

Nenhum objeto é criado por este documento; abaixo está o conjunto previsto, para aplicar depois via migração versionada em `supabase/` + advisors (Regra 4 do `AGENTS.md`).

### Tabela `outbound_messages` (auditoria / fila)

- `id uuid` PK · `created_at timestamptz default now()`
- `tenant_id uuid not null`
- `customer_id uuid` (nulo quando o canal não é endereçável a um cliente conhecido)
- `event text not null` — domínio do evento (`coupon_claimed`, `shuttle_booking_confirmed`)
- `channel text not null` - `WHATSAPP` (o canal `EMAIL` foi REMOVIDO em 2026-10-01; ver decisao 2)
- `provider text not null` - `none | whatsapp_cloud_api`. O `smtp` continua aceito pelo CHECK no banco porque estreitar esse CHECK exige confirmar antes que nao existe linha com ele (2026-10-01: sem MCP do Supabase conectado, entao a verificacao ficou pendente) -- mas nenhum codigo o produz mais. E a unica protecao que o CHECK daria e a de recusar valor invalido, nao de impedir envio: quem decide o que sai e o codigo.
- `destination text` - telefone normalizado (somente dígitos, com DDI). O e-mail como destino saiu com o canal em 2026-10-01.
- `subject text`, `body text` — conteúdo renderizado; **body nunca inclui** token, segredo ou código interno de negócio
- `status text not null` — `noop | queued | sent | failed`
- `provider_message_id text`, `error_code text` (código, nunca mensagem crua de terceiro)
- `attempts int not null default 0`, `last_attempt_at timestamptz`
- Índice único parcial de dedupe: `(tenant_id, event, customer_id, channel, coupon_id/booking_ref)` — **no máximo 1 linha por evento e canal**, para que retry do handler não gere spam. Índice em `(status, created_at)` para a fila e em `(tenant_id, created_at desc)` para auditoria.
- RLS ativa e **sem política para `anon`/`authenticated`**: leitura/escrita só pela chave `service_role`. `close-function-exec.sql` fecha qualquer função nova ao fim do módulo (verificação por `aclexplode`, `app_ainda_abertas = 0`).

### RPCs previstas (todas `SECURITY DEFINER`, `search_path = public, extensions`, `EXECUTE` apenas `service_role`)

1. `outbound_enqueue(p_tenant_id, p_event, p_channel, p_destination, p_subject, p_body, p_customer_id, p_coupon_id, p_booking_ref)` → `boolean` (`false` quando o dedupe já existe). É a única escrita do módulo; grava e devolve, não envia.
2. `outbound_mark_sent(p_message_id, p_provider_message_id)` → `boolean`.
3. `outbound_mark_failed(p_message_id, p_error_code)` → `boolean` (incrementa `attempts`).
4. `outbound_list(p_tenant_id, p_status, p_limit)` → `setof` para conferência no painel admin/empresa (sessão verificada no handler, autorização no banco — padrão de `business_*`).
5. `outbound_dispatch_pending(p_limit)` → contagem processada. **Agendada e opcional** (fase 2): só existe se houver provedor real; não é necessária para os critérios de aceite desta fase.

Erros (contrato `CODIGO: detalhe`, sanitizado com `rpcErrorCode()` antes de sair ao cliente): `OUTBOUND_DUPLICATE`, `OUTBOUND_NOT_FOUND`, `OUTBOUND_FORBIDDEN`.

## API

Nenhum endpoint público novo nesta fase. A notificação é efeito colateral best-effort de endpoints existentes. Se o dono quiser um painel de conferência, o contrato é:

- `GET /.netlify/functions/admin?mode=outbound&status=&limit=` — sessão ADMIN/SUPER_ADMIN (papel validado no banco, nunca pelo `role` do frontend), `Cache-Control: no-store`.
  - Sucesso `200`: `{ messages: [{ id, event, channel, provider, status, createdAt, attempts, errorCode }] }`. Sem `body`, `destination` nem PII do cliente na listagem.
  - Erros: `401 SESSION_REQUIRED` / `SESSION_EXPIRED` · `403 FORBIDDEN` (papel) · `400 CHANNEL_INVALID` · `500 erro interno` (sem detalhe).

Ainda sem endpoint, mas previsto: `POST /.netlify/functions/outbound-dispatch` protegido por segredo de agendador — **Ask first** (fase do provedor real).

## Transporte (adaptador WhatsApp/email, env vars, fallback no-op)

**Integração com provedor real: 1) depende de credenciais do dono, 2) é fase separada deste módulo, 3) o padrão é no-op logado.**

Interface única em `netlify/functions/_notify.js`, registrada em `HELPERS` no `tests/function-contract.test.cjs`:

- `notifyOutbound(supabase, { event, channel, customerId, couponId, bookingRef, vars })` → `{ status, id, provider }`, **nunca lança**.
- Seletor de provedor por env, avaliado na chamada:
  - WhatsApp: `WHATSAPP_PROVIDER` (`none` | `cloud`) + `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`. Ausente qualquer um ⇒ `none`.
  - Email: **removido em 2026-10-01.** `EMAIL_PROVIDER`, `SMTP_*` e `MAIL_FROM` nao sao lidos por codigo nenhum; `resolveProvider` ignora esses nomes mesmo que ainda existam no ambiente.
- Com `none`: grava `outbound_enqueue` com `provider='none'`, `status='noop'`, e escreve **um** `console.info('notificacoes: noop ...')` sem PII. Isso mantém o gancho visível em log e em auditoria, que é o comportamento observável do default.
- Com provedor: renderiza a mensagem a partir do **contexto do banco** (título do cupom, nome da empresa, código público do cupom, dados da reserva), envia, e marca `sent`/`failed` via `outbound_mark_*`. Erro do provedor é capturado, resumido em `error_code`, e **não** propaga.
- Dependencias: transporte por `fetch` nativo (ja disponivel no runtime). O envio por e-mail foi cortado em 2026-10-01 e nao ha dependencia a adicionar: `nodemailer` deixou de ser hipotese. Qualquer lib de WhatsApp continua **Ask first**. Nada disso entra no `package.json` nesta fase.
- Env vars vivem só no servidor: `.dev.vars` (existe no repo, não lido aqui) para dev; settings do projeto Cloudflare Pages para produção. Segredo de `.dev.vars` nunca é lido por este documento e nunca é versionado.

Limites obrigatórios do adaptador: timeout por tentativa (2 s), máximo de 2 tentativas, corpo com limite de tamanho, telefone normalizado só com dígitos (reaproveitando `normalizePhone` de `_wa.js`), e nenhuma variável `NEXT_PUBLIC_*` para credencial.

## Comandos (build/test verdes)

1. `npm test` — `node --test "tests/*.test.cjs"` (padrão do repo; inclui `function-contract.test.cjs`, que barra helper/rota fora de lugar).
2. `npm run build` — `next build` + `postbuild` (`scripts/bundle-worker.mjs`), o que prova que o Worker continua autocontido com o novo módulo.
3. Aplicação da migração via MCP/SQL versionada e, ao fim do módulo, `supabase/close-function-exec.sql` com verificação `app_ainda_abertas = 0` por `aclexplode` (Regra 4/5 do `AGENTS.md`).
4. Bateria de segurança da `AGENTS.md` Regra 3 antes de qualquer deploy; deploy só com "SIM" explícito do dono.
5. `npm run test:live` permanece opcional e **não** deve ser estendido para enviar mensagem a cliente real.

## Estratégia de teste

Unitário, com adaptador fake (mesmo padrão de `tests/claim-coupon-tax.test.cjs` + `tests/helpers.cjs`: `makeFakeSupabase`, `makeEvent`, `loadFunction`, `parseBody`):

- `tests/notificacoes.test.cjs` (novo, roda no CI padrão):
  - enfileira com env ausente: uma chamada a `outbound_enqueue`, `status='noop'`, resposta do `claim-coupon` idêntica à linha de base.
  - falha da RPC de auditoria (`throw` e `error`) não altera o 200 nem o corpo do resgate — espelha o teste existente de `billing_record_coupon_tax`.
  - envio com provedor fake (`WHATSAPP_TOKEN` presente no `process.env` do teste + `fetch` injetado) marca `sent` e carrega `provider_message_id`; erro do provedor marca `failed` com `error_code`, sem mensagem crua.
  - dedupe: dois enfileiramentos do mesmo evento/canal → uma linha; `outbound_enqueue` devolvendo `false` não gera envio.
  - sanitização: resposta de `claim-coupon` nunca contém token/senha/segredo novo (complementa o teste de segredos do `function-contract.test.cjs`).
  - normalização de telefone: entrada com `+`, espaços e zeros à esquerda → dígitos com DDI; telefone ausente ⇒ canal `EMAIL` ou `noop`, sem exceção.
- `tests/function-contract.test.cjs`: PASS **sem edição** para este conjunto; se o nome do helper mudar, o conjunto `HELPERS` precisa ser atualizado junto (decisão consciente, não efeito colateral).
- Live opcional: `tests/live.outbound.test.cjs` sob `RUN_LIVE=1`, apenas leitura (`outbound_list`) e apenas para conferir `noop`/`queued` — **sem envio a cliente real**, sem provedor configurado, sem `test:live` no caminho obrigatório. Estender o `package.json` é Ask first.

## Fronteiras

**Always**
- Manter `claim_coupon`/`validate_and_redeem_coupon` intocadas e antes de qualquer hook.
- Envolver todo hook em `try/catch`; nenhuma promessa rejeitada sai do handler.
- Contexto da mensagem sempre do banco; o corpo do request não escreve conteúdo em nome do estabelecimento.
- Helper registrado em `HELPERS` (não há mais espelho a manter em sincronia).
- Env ausente = no-op logado em `console` + `outbound_messages`; não é erro.
- Mensagens de erro de terceiros reduzidas a `error_code`.

**Ask first**
- Qualquer dependência nova (`nodemailer`, cliente de WhatsApp, fila).
- Endpoint público novo, `outbound-dispatch` protegido ou scheduler no banco.
- Campo novo em tabela de produção (`users`, `coupons`) ou RPC de produção tocada.
- Trocar o default de WhatsApp (`wa.me`) por envio automático em nome do negócio.
- Alterar o corpo/resposta de `claim-coupon` (ex.: expor `notificationStatus`).

**Never**
- Nunca enviar credencial, chave, `service_role`, `MP_ACCESS_TOKEN` ou conteúdo de `.dev.vars` para resposta HTTP, log de cliente ou bundle do browser.
- Nunca fazer o hook falhar o resgate, a confirmação de reserva ou a cobrança (`billing_record_coupon_tax`).
- Nunca enviar mensagem para telefone/email que veio do cliente sem validar no banco; nunca enviar para número do estabelecimento por acidente de variável.
- Nunca criar objeto no banco (tabela, função, política) sem migração versionada em `supabase/` + `close-function-exec.sql`.
- Nunca criar tabela/RPC com `EXECUTE` para `PUBLIC`/`anon`/`authenticated`.

## Critérios de sucesso

- `npm test` e `npm run build` verdes; `function-contract.test.cjs` sem alteração manual.
- `claim-coupon` com e sem notificação devolve byte a byte o mesmo contrato (exceto o campo opcional de status da notificação, se o dono aprovar).
- 100% dos eventos de resgate-hook deixam rastro em `outbound_messages`, mesmo sem provedor.
- Env ausente ⇒ zero chamadas de rede, zero exceções, zero impacto em latência mensurável (< 150 ms).
- Advisors do Supabase sem novos avisos de segurança/performance após a migração; `app_ainda_abertas = 0`.

## Perguntas em aberto

1. **Reserva de translado não existe ainda.** Não há tabela/RPC de booking no repo — só CRUD de serviço e leitura pública (`list_shuttle_services`, `list_live_vehicles`) e posição do motorista. Onde nasce a "reserva confirmada"? Sem resposta, a spec entrega só o gancho e o `event` fica reservado (`shuttle_booking_confirmed`) sem emissor.
2. **Qual provedor e quando? RESPOSTA DO DONO (2026-10-01): WhatsApp, sem alternativa.** O envio por e-mail foi cortado por completo -- canal `EMAIL` removido de `_notify.js`, `RESEND_API_KEY` apagada de Production e Preview, e a variavel entrou na lista `$Proibidas` do `check-pages-env.ps1`. Nao e mais "email enquanto o Resend nao resolve": e decisao definitiva. `wa.me` segue como o canal do dia a dia; a Cloud API automatizada continua condicionada a decisao 3.
3. **Meta/WhatsApp Cloud API: NÃO.** Decisão do dono em 2026-10-01: ficar só no `wa.me`. Sem conta verificada, sem template aprovado pela Meta, sem custo por conversa, sem automação. **Consequência aceita: o sistema não avisa o dono sozinho.** Não existe alerta automático de 5xx, nem aviso de resgate, nem lembrete de pagamento pendente. O `wa.me` exige toque humano e serve para o cliente agir, não para notificar a operação. O gancho de envio automatizado continua no `_notify.js`, inerte e desligado por falta de credenciais; se um dia for ativado, é decisão nova, com leitura de segurança nova — não é retomada natural.
4. **`wa.me` continua sendo o canal padrão?** Hoje o resgate devolve um link para o próprio cliente tocar em enviar. A notificação automática substitui isso, complementa (mantém o link na resposta) ou só cobre a reserva de translado?
5. **Granularidade e quiet hours:** notificar todo resgate ou só quando o cliente tem email/telefone válido? Há janela de silêncio (ex.: 22h–8h, fuso do cliente)? Isso é política de produto, não técnica.
6. **Retry:** sem provedor configurado, `status` fica `noop` para sempre, ou uma routine agenda promotion de `noop → queued` ao detectar que as env apareceram? Com que cadência e onde (cron do Supabase ou Worker scheduled)?
7. **Visibilidade:** a listagem de `outbound_messages` entra no painel `/admin` (todas as empresas) ou em `/empresa` (só a própria)? Isso define se `outbound_list` autoriza por `SUPER_ADMIN` ou por `businessId` da sessão.
8. **Retenção:** quanto tempo `outbound_messages` guarda `body`/`destination` (PII)? Precisa de job de expurgo e de hash/mascaramento no painel?
9. **Migração:** aplicar `outbound_messages` e as RPCs agora (via MCP, como o módulo 1) ou esperar até existir o emissor da reserva?
