# Decisão de risco registrada — dependências (2026-09-01)

## Contexto
`npm audit` no projeto `pyv-web` (Next.js) reporta 2 vulnerabilidades "high"
remanescentes após a atualização para `next@14.2.35`:

- Diversos GHSA relacionados a DoS via Image Optimizer, XSS em scripts
  `beforeInteractive`, SSRF em Server Actions, cache poisoning em RSC,
  bypass de middleware com i18n no Pages Router, etc.
- A correção completa indicada pelo `npm audit fix --force` é `next@16.3.4`
  (mudança de major version, breaking change).

## Decisão
Prosseguir com deploy usando `next@14.2.35` (já corrige a vulnerabilidade
**crítica** de RCE do boletim de dez/2025) e **não** aplicar o upgrade para
Next 16 agora.

## Justificativa
Nenhuma das features afetadas pelos GHAs remanescentes está em uso neste
app: sem `next/image`, sem Server Actions, sem Middleware, sem i18n no
Pages Router (o app usa App Router puro, uma página e uma API route de
health-check). A superfície de exposição real destes CVEs específicos é
nula neste código, hoje.

## Condição de revisão obrigatória
Esta decisão **deve ser reavaliada antes de**:
- Adicionar `next/image`, Server Actions, Middleware ou i18n ao projeto.
- Este app passar a manipular dados reais de usuários/cupons (ou seja,
  antes de qualquer Production Gate da seção 39 do Prompt Master).

Responsável pela decisão: usuário do projeto (confirmado em conversa).

# Decisão de risco registrada — validação manual sem segredo (2026-09-05)

## Contexto
A validação de cupom por QR code exige o token secreto completo (seguro).
A validação **manual** (quando o atendente digita o código, sem câmera)
originalmente também exigia um segredo (token completo, depois um código
curto de 6 dígitos).

## Decisão
A pedido do usuário responsável pelo projeto, a validação manual passou a
aceitar **somente o código público do cupom** (ex: `PYV-XXXXXXXXXX`), sem
exigir nenhum segredo adicional.

## Risco explicado e aceito
Qualquer pessoa que veja o código público do cliente (por exemplo, olhando
a tela dele) poderia, em teoria, pedir para um atendente validar esse cupom
sem realmente ser o dono. A validação por QR code (câmera) continua exigindo
o token secreto completo, então esse risco só existe no fluxo manual.

## Mitigação que permanece ativa
- Exige login de staff/empresa autenticado (sessão verificada no servidor).
- Só valida cupons do próprio estabelecimento do staff.
- Cupom só pode ser validado uma vez (trava de concorrência já testada).

Responsável pela decisão: usuário do projeto (confirmado em conversa,
avisado explicitamente do risco antes de decidir).

# Decisão de risco registrada — funções do PostGIS expostas ao anon (2026-09-25)

## Contexto
Auditoria de 2026-09-25 encontrou que **todas** as funções do schema `public`
tinham EXECUTE para PUBLIC, `anon` e `authenticated`. Isso permitia chamar
`auth_login_by_email` direto via PostgREST e obter `sessionToken` sem passar
pelo OTP — bypass crítico. Foi fechado: `hardening-revoke-function-exec.sql`
revogou EXECUTE das 66 funções do app, e hoje `app_ainda_abertas = 0`.

Restou um vetor que o REVOKE não alcança: **721 funções da extensão postgis**,
instalada no schema `public`, seguem executáveis pelo anon via
`/rest/v1/rpc/`. O ACL de função membro de extensão é imutável no PostgreSQL:
`REVOKE` e `GRANT` retornam sucesso e o `proacl` fica idêntico, byte a byte.
Comprovado em `st_estimatedextent(text,text,text,boolean)` nas duas direções,
usando uma função do app como controle — que registrou a alteração
normalmente, provando que a mudança persiste e que a diferença é o postgis.
`ALTER EXTENSION postgis SET SCHEMA` é recusado com
`extension "postgis" does not support SET SCHEMA`.

## Decisão
Aceitar o risco das funções do PostGIS expostas ao anon, **sem remediação**,
por enquanto. As duas formas de fechar foram avaliadas e ambas descartadas agora:

- **Mover a extensão** (`DROP EXTENSION postgis CASCADE` + recriar em
  `extensions`): destruiria 4 colunas geográficas (`businesses.location`,
  `coupon_templates.proximity_point`, `shuttle_services.origin`,
  `shuttle_services.destination`) e 5 índices gist. 18 funções do app chamam
  `st_*` sem qualificar e 12 tocam essas colunas — entre elas
  `register_business`, `list_offers`, `list_offers_public`,
  `find_nearby_businesses`, `set_coupon_proximity`. Todas dependeriam de
  `extensions` entrar no `search_path` de funções `SECURITY DEFINER`: falha em
  runtime, em produção, no núcleo do produto.
- **Revogar `USAGE` do schema `public`**: reversível, mas o ACL atual dá USAGE
  a PUBLIC e a `anon`/`authenticated`, enquanto `authenticator` e `pgbouncer`
  não estão no ACL — herdam de PUBLIC. Revogar exigiria re-grant explícito
  para `authenticator`, `pgbouncer`, `service_role`, `postgres` e 6 papéis
  internos do Supabase (`supabase_admin`, `supabase_auth_admin`,
  `supabase_storage_admin`, `supabase_read_only_user`, `supabase_etl_admin`,
  `supabase_replication_admin`). Falhar um deles derruba PostgREST, Auth,
  Storage ou o dashboard — falha que não aparece em verificação SQL.

## Risco explicado e aceito
O anon pode chamar funções de geometria passando valores que ele mesmo escolhe.
**Não há leitura de dado**: as funções recebem geometria como argumento e não
acessam tabelas — e o anon já não lê nada das tabelas, porque RLS está ligado e
não há policy. O vetor real é consumo de CPU/memória (por exemplo `ST_Buffer`
com raio grande, ou `ST_ClusterDBSCAN`). As 3 funções `SECURITY DEFINER`
expostas são as sobrecargas de `st_estimatedextent`, que apenas estima extent de
raster. Este é o comportamento padrão do Supabase, que instala o postgis em
`public` com `anon` executável em todos os projetos da plataforma.

## Mitigação que permanece ativa
- 67 funções do app fechadas para `anon`/`authenticated`; só `service_role` e
  `postgres` executam.
- RLS ligado em todas as tabelas do projeto, sem policy — anon não lê dado.
- Toda chamada passa por Netlify function com `service_role`. `app/` não tem
  nenhuma referência a Supabase, e o único cliente do repo (`lib/supabase.js`)
  é código morto — a anon key não é usada pelo browser.
- `close-function-exec.sql` roda ao fim de cada módulo (ver Regra 4 do
  `AGENTS.md`), porque `DROP`+`CREATE` reabre a função.

## Condição de revisão obrigatória
Reabrir esta decisão se:
- Aparecer consumo anômalo de CPU no projeto Supabase sem tráfego
  correspondente (sinal de abuso das funções de geometria).
- O app ganhar cliente mobile, ou qualquer consumidor com a anon key fazendo
  chamada direta ao PostgREST.
- For adicionada função que execute consulta espacial com o papel do
  solicitante, em vez de via `service_role`.

Responsável pela decisão: usuário do projeto (confirmado em conversa, avisado
explicitamente do risco e das duas opções descartadas antes de decidir).

---

# Risco aceito — cadastro de motorista sem verificação de posse do telefone (2026-09-25)

## Contexto
O fluxo de cadastro de motorista não tem SMS nem WhatsApp OTP (restrição de
serviços gratuitos). Só existe telefone + PIN. Duas APIs do módulo 4 eram
explotáveis assim que ganhassem endpoint com `service_role`:

1. `driver_set_pin(tenant, phone, pin)` — sem sessão, sem token, sem checar
   status. Quem soubesse `tenant_id` + telefone de um motorista **aprovado**
   sobrescrevia o PIN e entrava na conta.
2. `driver_add_document(..., p_session_token)` com sessão nula — pulava a
   autenticação inteira e anexava documento em qualquer `driver_id`. Ao
   reenviar, ainda rebaixava um motorista `approved` de volta para `pending`.

Até então o único motivo de não estarem em produção era o ACL fechado.

## Decisão
Aceitar que **sem SMS não é possível provar que o telefone pertence a quem
cadastrou** — quem registrar primeiro fica com o número. Em troca, garantir a
propriedade que de fato importa: **o token não pode servir para sequestrar um
motorista que já existe.** Implementado em `modulo4b-token-cadastro.sql`:

- O token de posse é emitido **apenas na criação** da linha do motorista, e
  gravado só como `sha256` de 256 bits (o valor cru volta uma vez na resposta
  de `driver_register`).
- O token só é válido enquanto o status é `pending`/`rejected`. Na aprovação
  ele morre junto: depois disso o `pinToken` original devolve `TOKEN_INVALID` e
  não redefine mais o PIN de um motorista ativo.
- As assinaturas antigas foram **droppadas**, não sobrescritas — a função de
  hijack deixa de existir como callable. O endpoint não pode ter fallback sem
  token.
- `driver_add_document` passou a exigir sessão **ou** `uploadToken`, nunca os
  dois nulos.
- Cadastro com **convite da empresa é opcional**; sem convite, o auto-cadastro
  continua existindo com rate limit de 20/hora/tenant.
- A aprovação humana da empresa continua sendo o portão de entrada real.

## Justificativa
A opção "convite da empresa + auto-cadastro com token" foi a escolhida entre as
duas apresentadas. "Somente convite" foi descartada porque conflita com a regra
de `admin_driver_reset_pin`, em que qualquer empresa do tenant gerencia o
motorista independente — sem auto-cadastro, esse motorista não existe.

## Mitigação que permanece
- Portador legítimo do número que teve o cadastro sequestrado **tem como
  reclamar à empresa** e ser removido, e a empresa pode redefinir o PIN.
- Rate limit de 20 cadastros/hora/tenant e `max_uses` por convite limitam
  volume de cadastro fraudulento.
- `business_invites.uses` é auditável: dá para ver quantos cadastros saíram de
  cada convite.

## Condição de revisão obrigatória
Reabrir esta decisão se:
- Surgir reclamação recorrente de telefone correto já cadastrado por outra
  pessoa, que indique que o risco está incomodando usuários reais.
- O negócio passar a pagar por SMS/OTP — nesse caso a verificação de posse
  deve ser adicionada **antes** do `driver_set_pin`, não depois.
- Surgir demanda por verificação de propriedade antes mesmo da aprovação
  empresarial (hoje a aprovação é o portão, e ela é humana).

Responsável pela decisão: usuário do projeto (escolheu "convite da empresa +
auto-cadastro com token" entre as opções apresentadas, ciente de que o token
não prova posse do telefone).

---

# Hardening de `search_path` das funções do app (2026-09-25)

## Contexto
O advisor de segurança acusava `function_search_path_mutable` (WARN) em **42
funções** de `public`. `search_path` mutável é sequestro de resolução de nome:
com o caminho padrão (`"$user", public`), um atacante que consiga criar um
objeto num schema anterior a `public` hijacka qualquer chamada não qualificada
dentro do corpo. Em função `SECURITY DEFINER` isso escala, porque o corpo roda
com privilégios do dono.

O usuário autorizou a troca, com a condição de que não gerasse problema, e
especificamente liberou `claim_coupon` — que até então era intocável — desde
que fosse seguro.

## Decisão
Aplicar `ALTER FUNCTION <sig> SET search_path = public, extensions` nas 42
funções, e **não** em mais nenhuma. Sem `DROP`/`CREATE`, sem tocar corpo, sem
alterar ACL.

`extensions` entra no caminho porque `pgcrypto` (`crypt`, `digest`,
`gen_salt`, `gen_random_bytes`) vive lá. Sem ele, qualquer função que use
pgcrypto sem qualificar passaria a quebrar. `public` fica **primeiro** de
propósito: se `extensions` viesse antes, uma função ou tabela de app chamada
`digest` seria sombreada.

## Justificativa de segurança
- `ALTER FUNCTION ... SET` escreve **somente** `pg_proc.proconfig`. É
  impossível ele alterar `prosrc` ou `prosecdef`. O corpo das 42 funções e suas
  flags `SECURITY DEFINER` ficaram bit a bit idênticos, medido por checksum
  antes e depois do lote.
- As 721 funções membro de extensão do PostGIS foram preservadas, conforme a
  decisão de 2026-09-25 acima.
- ACL não muda com esse comando: `app_ainda_abertas` continuou `0` antes e
  depois, então a Regra 4 não foi acionada.
- Advisor reconsultado: `function_search_path_mutable` saiu da lista (0
  findings).
- 47 funções distintas foram exercitadas dentro de transações com `ROLLBACK`,
  cobrindo PostGIS, cupons, auth e cadastro. Zero falha de resolução de nome.

## Mitigação que permanece ativa
- 3 funções ficaram com `search_path=public` apenas, por já terem o setting e
  não usarem pgcrypto nem PostGIS: `admin_featured_ranks`, `admin_set_featured`
  e `business_logo_by_id`.
- `seed_demo_tenant` continua sendo função de app com ACL fechado; se algum dia
  for exposta, revisar.

## Condição de revisão obrigatória
Reabrir se:
- Uma extensão for instalada em `public` e passar a ter função com nome que
  colida com objeto do app — nesse caso a ordem `public, extensions` deixa de
  proteger e o valor precisa ser revisto.
- O `search_path` global do banco mudar de forma que tornasse `public` não
  ser o primeiro schema confiável.

---

# Defeito pré-existente — `create_coupon_template` ambíguo (2026-09-25)

## Contexto
Descoberto durante a validação do hardening, e **não** causado por ele.

Existem dois overloads:

```
create_coupon_template(uuid,uuid,uuid,uuid,text,text,numeric,integer)
create_coupon_template(uuid,uuid,uuid,uuid,text,text,numeric,integer,text)
```

O 9º parâmetro (`p_image_url`) tem `DEFAULT NULL`. Por isso, uma chamada em
notação nomeada que omita `p_image_url` satisfaz os dois overloads e o
PostgreSQL responde com **SQLSTATE 42725**, `function ... is not unique`.

## Mitigação vigente
Passar `p_image_url` explicitamente, mesmo como `NULL`, ou usar os 9
posicionais. Validado: com `p_image_url` explícito a função executa e grava
normalmente.

## Condição de revisão obrigatória
Resolver antes de expor a criação de templates no endpoint, dropando o
overload de 8 argumentos (ou removendo o `DEFAULT` do 9º e criando um wrapper
com nome distinto). Enquanto isso, qualquer chamador que omita o parâmetro
quebra em runtime.

---

# Envio de email congelado até existir domínio verificado (2026-09-26)

## Contexto
O cadastro de empresa recebe OTP por email via Resend, e o envio está inoperante
para destinatários que não sejam o próprio dono da conta Resend.

Motivo: sem domínio verificado, o plano da Resend **só entrega para o e-mail da
conta**. Isso não é bug da integração, é regra do provedor. O agravante encontrado
no painel do Cloudflare Pages é que `RESEND_FROM` não está definido nem em produção
nem em preview, então `netlify/functions/_resend.js:19` cai no fallback
`PYV <onboarding@resend.dev>`. Variáveis de ambiente hoje no projeto:

- produção: `GEOAPIFY_API_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `NEXT_PUBLIC_SUPABASE_URL`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- preview: as mesmas, **sem `RESEND_API_KEY`**

Um segundo problema tornava isso invisível: **o E2E não testa email**. Ele forja
o OTP com o mesmo HMAC do servidor (`buildOtpCode` em
`tests/live.driver-approval.test.cjs`) e entrega o código direto no login, sem
passar por `send-otp`. Os 15 passos passam ao-green sem que um único email seja
enviado. A chave de Resend guardada no `.dev.vars` local também responde **401** em
`api.resend.com/domains` — está revogada e é diferente da que está em produção.

## Decisão
Congelar a parte que depende de domínio até o usuário ter o domínio (previsto
para terça-feira, 2026-09-29). Não tentar contornar o provedor. Verificar domínio
na Resend e então definir `RESEND_FROM` no painel do Cloudflare.

Foram avaliados e descartados: Cloudflare Email Routing (só recebe e encaminha,
não envia), Mailgun/SendGrid/SES (exigem verificação de domínio tanto quanto) e
SMTP do Gmail (funciona, mas colocaria senha pessoal em variável de ambiente, o
que é regressão num projeto que já tem rotação de chave pendente). Brevo ficou
como plano B caso o domínio demore, por validar o remetente por link em vez de
DNS — a política exata dela não foi confirmada.

## Mitigação que permanece ativa
- **Vazamento de detalhe interno corrigido.** `send-otp` devolvia `result.reason`
  e `err.message` no corpo da resposta, e o frontend imprime `data.error` direto
  na tela em ~12 pontos — um visitante podia ler "RESEND_API_KEY ausente —
  configure no painel do Cloudflare (Settings > Variables)", o que entrega a
  hospedagem e o estado de configuração. Agora `sendEmail` (camada interna)
  continua devolvendo a causa para o log, e `sendOtp` (fronteira com o cliente)
  devolve frase neutra. Coberto por teste.
- **`send-otp` ganhou cobertura de teste**, que não tinha nenhuma: ele nunca era
  exercitado, nem no unitário nem no E2E.
- A aprovação de documentos não depende de email: é sessão de empresa e
  `service_role`, sem OTP no caminho.
- O E2E continua válido como está, porque forja o OTP por HMAC — o que é
  exatamente o que o torna independente do provedor de email.

## Condição de revisão obrigatória
Reabrir assim que o domínio existir:
- Verificar o domínio na Resend (SPF + DKIM) e definir `RESEND_FROM` em
  produção **e** preview.
- Definir `RESEND_API_KEY` no ambiente de preview, que hoje não tem — lá o envio
  falha por ausência de chave, não por domínio.
- Substituir a chave do `.dev.vars`, que está revogada (401 na API).
- Conferir se o cadastro e a aprovação funcionam para empresa de terceiros, que é
  o público que hoje não recebe OTP.

Responsável pela decisão: usuário do projeto (adiou explicitamente até ter o
domínio, ciente de que o email segue inoperante para terceiros nesse intervalo).

---

# Envio de email e login por email removidos de vez (2026-09-28)

## Contexto
O fluxo de email + OTP (login/cadastro de empresa, identidade do cliente) nunca
entregou uma mensagem a um cliente real: dependia de domínio verificado e de
chave de API (Resend) que não existem em produção. O domínio foi adiado de novo,
e o usuário decidiu não manter código que depende de uma peça que não vai existir.

## Decisão
Remover de vez o email como mecanismo de autenticação, usando o que já opera:

- **Empresa — login:** única via `/login` → RPC `auth_login` (código interno +
  senha, PIN hasheado com lockout por tentativas). O modo "entrar com email"
  (login-by-email) saiu da UI e do servidor.
- **Empresa — cadastro:** única via `register_business` (código interno + senha,
  `pin_hash` já gravado). O modo "email + OTP" saiu da UI; a RPC
  `register_business_by_email` foi removida do banco.
- **Cliente:** identifica-se por telefone. Email virou campo opcional de cadastro,
  **sem verificação** (`identify_customer` guarda o endereço como dado, e o
  fluxo de OTP do cliente foi retirado do `identify.js` e da UI).
- **Banco:** `DROP FUNCTION public.auth_login_by_email(text, text)` e
  `DROP FUNCTION public.register_business_by_email(...)` aplicadas
  (migração `drop_email_auth`). Recriáveis pelos SQL versionados se um dia
  voltarem.
- Removidos handlers e espelhos ESM: `send-otp.js`, `login-by-email.js`,
  `register-business-by-email.js`, `_otp.js`, `_resend.js`, e o teste
  `otp-email.test.cjs`. Rotas correspondentes saíram da whitelist do
  `worker/main.js` e `RESEND_API_KEY`/`RESEND_FROM` saíram do diagnóstico.
- O teste E2E live de aprovação de motorista trocou o login por OTP pelo login
  por código + senha (`/login`), exigindo `LIVE_BUSINESS_CODE` + PIN por env.

## Risco explicado e aceito
- **Sem verificação de email no cliente:** qualquer pessoa pode cadastrar um
  telefone/email que não seja de um terceiro. Isso já era verdade para telefone
  e instagram; o email era o único campo verificado e agora deixou de ser.
- **Escopo menor de login de empresa:** quem só tinha acesso por email precisará
  do código interno + senha. É o segredo real da conta; o email nunca foi um
  segredo.

## Mitigação que permanece ativa
- PIN de empresa: hasheado, mínimo 6 caracteres, lockout no `auth_login` (teste
  de senha por tentativa + backoff em memória e no banco via `login_attempts`).
- `identify_customer` sem OTP, porém sem token de sessão durável diferente do
  já existente (`buildCustomerToken`, token de cliente por telefone).

## Condição de revisão obrigatória
Reabrir este fluxo **somente quando** existir domínio verificado E uma decisão
trackeada de qual provedor (Resend verificada, SMTP, etc.) — não reintroduzir
freela sem a peça de infraestrutura.

Responsável pela decisão: usuário do projeto ("remover o email de vez, usando o
que já funciona", confirmado em conversa).

# Decisão de risco registrada — erro interno nunca mais em resposta HTTP (2026-09-28)

## Contexto
Os handlers de função devolviam `{ error: err.message }` no catch (status 500) e
em alguns 409, vazando detalhes internos (RPC, SQL, storage, stack) para o
cliente — em `netlify/functions` (CJS, bundle do Worker) e nos espelhos ESM
(`functions/.netlify/functions`, Cloudflare Pages Functions).

## Decisão
Todo catch de 500 passou a:
- **logar a causa** via `console.error('<handler>: ' + message)` (detalhe interno
  fica onde interessa: nos logs);
- **responder `erro interno`** no corpo;
- **preservar o contrato de sessão**: `SESSION_REQUIRED`/`SESSION_EXPIRED`
  continuam `401` com a mensagem original (mencionados em `worker/main.js`).
- Em `validate-coupon` (409), o fallback `code || error.message` virou
  `code || 'COUPON_REJECTED'`, com a causa logada.

O padrão-mestre é `driver-add-document.js` (catch com `code`/`body`). Handler
de email órfão `_verify-email.js` (CJS + ESM) foi deletado.

## Justificativa
`err.message` em 500/409 expõe nomes de RPC, constraints, caminhos de storage e
fragmentos de SQL a qualquer visitante; nunca é informação acionável para o
cliente (a UI só exibe `data.error`). Logar a causa preserva o diagnóstico sem
publicar a superfície.

## Condição de revisão obrigatória
Se um novo endpoint precisar repassar uma mensagem interna ao cliente (ex.:
provedor externo com código de erro semantico), deve ser por mapeamento explícito
com código próprio — nunca `error.message` cru.

Responsável pela decisão: usuário do projeto (autorizou "corrigir" o vazamento
de erro interno nos handlers).

---

# Risco aceito — RLS em `spatial_ref_sys` inalcançável (2026-09-29)

## Contexto
A bateria de segurança da fase 2 (2026-09-29) deixou um único ERROR no advisor
`rls_disabled_in_public`: `public.spatial_ref_sys` com RLS desligada e SELECT
disponível para `anon`/`authenticated`/`service_role`. Tentativas de corrigir
falharam e a falta foi verificada por inspeção do banco:

- `postgres` (papel do MCP, da CLI e do SQL Editor do dashboard) tem
  `rolsuper=false`; `supabase_admin` é superuser, mas
  `pg_has_role(current_user, 'supabase_admin', 'MEMBER') = false` →
  `set role supabase_admin` também é negado.
- `spatial_ref_sys` é owned por `supabase_admin` (extensão postgis instalada
  em `public`), e **todos** os grants (inclusive SELECT) têm grantor
  `supabase_admin` → nem `REVOKE` é possível (quem revoga precisa ser owner ou
  o grantor).
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` exige ownership ou superuser:
  falha `42501: must be owner of table spatial_ref_sys` por igual no MCP e no
  SQL Editor do dashboard. Nenhum caminho SQL existe a partir de
  dashboard/MCP/CLI (todos conectam como `postgres`).

## Decisão
Aceitar o risco e documentá-lo. A remediação só é possível com intervenção do
Supabase (ticket para executar o `ALTER` como `supabase_admin`), o que é
desproporcional para uma tabela de catálogo de referência. Não há código que
leia `spatial_ref_sys`; o app usa postgis via `st_*`/`geometry` nas próprias
colunas (`businesses.location` etc. — ver decisão postgis de 2026-09-25).

## Risco explicado e aceito
`spatial_ref_sys` contém ~8.500 linhas de definição de SRID (EPSG): dados de
referência públicos e sem PII. A exposição real, mesmo com o ERROR no advisor,
é teórica — leitura de catálogo por `anon`/`authenticated`, dado não sensível.
Como a extensão instala o postgis em `public` com esses grants em **todos os
projetos Supabase**, este finding é inerente à plataforma, não ao app.

## Mitigação que permanece ativa
- Nenhuma rota do app consulta `spatial_ref_sys`; toda chamada passa por
  Netlify function com `service_role`.
- As 30 tabelas do app seguem com RLS ligada (sem policy), e as 67 funções do
  app estão fechadas para `anon`/`authenticated`.

## Condição de revisão obrigatória
Reabrir se:
- Surge dependência de consulta a `spatial_ref_sys` com papel de solicitante
  (hoje nenhuma usa), ou se o Supabase oferecer comando oficial para RLS em
  tabelas de extensão.
- A adoção iniciada neste projeto reabrir a decisão postgis geral.

Responsável pela decisão: usuário do projeto (escolheu "aceitar e documentar"
após o bloqueio `42501` ser verificado no MCP e no dashboard).


# Decisão registrada — espelho ESM de functions removido, fonte única em CJS (2026-09-30)

## Contexto
`netlify/functions/` (CJS) tinha um espelho byte-a-byte em
`functions/.netlify/functions/` (ESM, `onRequestGet`/`onRequestPost`), criado para
Cloudflare Pages Functions. O padrão era declarado obrigatório em 6 documentos
(`API.md`, `RELATORIO-FUNCIONALIDADES.md`, `SPEC-relatorio.md`,
`SPEC-notificacoes.md`, `SPEC-agendamento.md`, este arquivo) e vigiado por
`tests/consistency.test.cjs`.

O espelho nao tinha mais consumidor em runtime:
- o unico alvo de deploy e `netlify.toml`, com `[functions] directory =
  "netlify/functions"`;
- `scripts/bundle-worker.mjs` inlina os handlers **CJS** no bundle do Worker;
- nao existe `wrangler.toml` nem script de deploy para Pages Functions.

E a garantia de sincronia era ilusoria. `consistency.test.cjs` comparava a FORMA
dos dois lados — mesmo conjunto de nomes de arquivo, `exports.handler` de um lado,
`onRequestGet`/`onRequestPost` do outro, `HELPERS` coerente, nenhum segredo no
fonte — e nunca o comportamento. O resultado foi silencioso: a
`functions/.netlify/functions/_wa.js` continuava com a saudacao "Ola! Vim pelo
...", o "Codigo curto" e a pergunta "Podem me informar como utilizo?", e sem o
site/link de indicacao, meses depois de o CJS canonico ter mudado, sem um unico
teste reclamar.

Risco adicional do espelho: 30 arquivos com regras de negocio duplicadas, em
`SECURITY DEFINER` e com acesso `service_role`, que um dia alguem editaria
achando que era o arquivo que sobe. Como os dois lados nao eram executados no
CI, a edicao errada nao falhava no build.

## Decisão
Apagar `functions/.netlify/` inteiro e passar a ter uma fonte unica: `netlify/functions`
(CJS). O `tests/consistency.test.cjs` foi substituido por
`tests/function-contract.test.cjs`, que mantem as verificacoes que nao dependiam
do espelho (todo handler exporta `exports.handler`; helper nao exporta handler;
`HELPERS` bate com o grafo de imports; `_supabaseAdmin` expoe os nomes canonicos;
nenhum segredo no fonte) e ganha duas novas: o `netlify.toml` precisa apontar
para `netlify/functions`, e a pasta `functions/` nao pode reaparecer.

O que NAO foi removido: o backend continua aceitando `p_short_code` em
`validate_and_redeem_coupon`. Tirar o codigo curto das telas e da mensagem e uma
decisao de produto; quebrar material antigo do balcao seria outra coisa.

## Consequencia aceita
Perde-se a portabilidade para Cloudflare Pages Functions. Se essa plataforma
voltar a ser alvo, os handlers precisam ser convertidos para ESM de novo (ou
bundleados), e nao reaproveitados do espelho apagado.

Responsável pela decisão: usuario do projeto (escolheu "apagar de vez, com teste
e docs" apos saber que o espelho era so de forma, e nao de conteudo).

## 2026-10-01 - Envio por e-mail cortado por decisão do dono; chave da Resend exposta nesta sessão

### Decisão
Comunicação com o cliente é **por WhatsApp, sem alternativa**. O envio por e-mail foi
removido do código, não adiado:

- `_notify.js`: canal `EMAIL` removido (`CHANNEL_EMAIL`, ramo em `normalizeChannel`,
  ramo em `resolveProvider`, `CAN_DELIVER.smtp`). `resolveProvider` agora só conhece
  `whatsapp_cloud_api`. `EMAIL_PROVIDER`, `SMTP_*` e `MAIL_FROM` não são lidos por
  código nenhum.
- `resolveDestination` perdeu o parâmetro `channel` e o ramo de e-mail; a leitura de
  `users.email` saiu. O campo continua no banco — é dado de contato, não envio.
- `health.js`: integração `resend` removida das DEPENDENCIAS.
- `RESEND_API_KEY` apagada do Cloudflare Pages em **production** e **preview**.
- `check-pages-env.ps1`: a variável saiu de `$Esperadas` e entrou em `$Proibidas`.
  Reaparecer agora é falha do script, não esquecimento.
- Comentários em `claim-coupon.js` e `health.js` que citavam o Resend como
  dependência viva foram corrigidos.

O campo `email` como **dado** permanece em todo o sistema (cadastro de motorista
exige e-mail, cadastro de cliente, painel). O que morreu foi o envio.

### Por que não foi preciso mexer no CHECK do banco
`provider` ainda aceita `none | whatsapp_cloud_api | smtp` em
`public.outbound_messages`. Estreitar exigiria confirmar antes que não existe linha
com `smtp` — e o MCP do Supabase não estava conectado na sessão. Alterar constraint
sem essa verificação seria às cegas. **Pendência: quando o MCP voltar,
`SELECT provider, count(*) FROM outbound_messages GROUP BY provider` e, se não houver
`smtp`, `ALTER TABLE ... DROP CONSTRAINT` + recriar o CHECK.**

E o valor do check que sobrou é pequeno: o CHECK recusa valor inválido, não impede
envio. Quem decide o que sai é o código, e o código já não produz `smtp`.

### Incidente: chave da Resend exposta nesta sessão
Um `Select-String` amplo procurou `RESEND_API_KEY` no repositório e imprimiu
**`.dev.vars` com o valor da chave** no output do terminal e na conversa. Causa:
busca de identificação de código sem restringir os diretórios.

Verificado depois:

- `.dev.vars` está no `.gitignore` (linha 12) e **nunca foi commitado**;
- `git grep` da chave sobre todos os revs de `main`: vazio;
- `do-backup.ps1` exclui `.dev.vars`, então os 57 backups estão limpos.

**Ações**: (a) revogar a chave no painel da Resend — a remoção do valor no Pages
**não** revoga a chave na Resend; (b) se algum dia o e-mail voltar, recriar com valor
novo; (c) toda busca futura por nome de variável tem de ser restrita a
`netlify/functions`, `lib`, `app`, `worker`, `tests`, `supabase`, `scripts` — nunca
varredura a partir da raiz, que inclui `.dev.vars`.

### O que este corte NÃO resolve — e a consequência aceita
O alerta automático de `/.netlify/functions/health` continua **sem entrega**, e agora
isso é decisão, não pendência. Trocar e-mail por WhatsApp **não é atalho**: mensagem
initiada pelo negócio na Cloud API exige template aprovado e conta verificada da Meta.
O `wa.me` exige que um humano toque no link — serve para a ação do cliente, não para
notificar o dono.

**Decisão do dono em 2026-10-01: ficar só no `wa.me`.** Sem conta verificada, sem
template, sem custo por conversa. O sistema **não avisa a operação sozinho**: não há
alerta de 5xx, nem aviso de resgate, nem lembrete de pagamento pendente. O gancho de
envio automatizado continua no `_notify.js`, inerte e desligado.

Um efeito colateral que vale registrar: com o Resend fora e sem canal automático, uma
falha de runtime em produção só aparece quando alguém olha. O `health` continua
público ereporta o estado, mas **ninguém está olhando**. Se isso incomodar, a saída não
é e-mail — é checagem manual periódica ou um provedor de uptime.

Responsável pela decisão: usuário do projeto ("cortar de vez o envio por email e
efetuar todos os envios pelo whatsapp").

# Decisão de risco registrada — cifragem em repouso do `rawToken` com chave no mesmo banco (2026-10-03)

## Contexto
`idempotency_keys` guarda o resultado de cada operação idempotente. Em
`operation='coupon.claim'` esse resultado carrega o `rawToken` do cupom — o mesmo
valor que vai no QR e dá direito ao desconto. Verificado em 2026-10-03: o papel
`service_role` tem `SELECT` na tabela.

Ou seja, **uma leitura parcial expurrava todos os tokens ativos de uma vez**. Não
precisa ser um comprometimento: basta uma chave de serviço vazada, um job de BI,
um `SELECT` acidental em um dump parcial, ou uma linha de query em log.

Até 2026-09-29, `coupon.validate` também guardava nome e telefone do cliente em
`result`, sem prazo de expiração. A p3 (2026-10-03) passou a gravar uma linha por
resgate, o que passou a reter segredo indefinidamente.

## Decisão
Cifrar em repouso **apenas** `coupon.claim`, com chave simétrica de 256 bits
(`pgcrypto`, AES-256) em tabela separada:

- `idempotency_keys.result_enc bytea` recebe o resultado cifrado; `result` fica
  nullable; CHECK XOR exige exatamente um dos dois preenchido.
- `public.idempotency_keys_secret` guarda a chave, com `REVOKE ALL` de
  `public, anon, authenticated, service_role`. `service_role` continua lendo
  `idempotency_keys` e por isso **não** consegue ler a chave.
- `coupon.validate` **não** foi tocada: ali o que há é nome e telefone, não
  segredo.

A restrição que fixou essa separação é técnica: `claim_coupon` é `SECURITY
DEFINER` (roda como `postgres`, dono da chave), mas `validate_and_redeem_coupon` é
`SECURITY INVOKER` e executa como `service_role`, que não leria uma chave restrita.
Cifrar as duas exigiria dar a chave ao `service_role` — o que anula o ganho — ou
promover a função a `DEFINER`, mudando a postura de RLS numa rota de dinheiro.
Fora de escopo, por escolha.

## Risco explicado e aceito
A chave está **no mesmo banco** dos dados. Portanto **isto não protege**:

- **dump completo do banco**: leva a tabela e a chave juntas, e um `pg_dump`
  restaurado em outro lugar lê os tokens;
- **acesso de superusuário** ou comprometimento do próprio Postgres;
- **quem chamar `claim_coupon` com a chave de idempotência certa**: o replay
  decifra e devolve o token por design. É um modelo de *capacidade*, não de
  autenticação. A chave tem 128 bits de `crypto.getRandomValues` no navegador, o
  que torna o palpite inviável — mas quem a tem, tem o token.

O que **de fato** fecha: réplica somente-leitura, export de tabela, job de BI,
log de query, ferramenta que lê `idempotency_keys` sem saber da tabela de chaves.
É o cenário comum, e o `rawToken` em claro some de todos eles.

A proteção real contra dump exigiria chave fora do banco (KMS externo, ou
`vault` do Supabase com segredo que não viaje no dump). Isso foi avaliado e
descartado agora: `vault` no Supabase guarda o segredo em um schema do **mesmo**
banco, então não resolve o caso do dump, e trazer um KMS externo para um projeto
de um dono só não se justifica no custo de operação.

## Mitigação que permanece ativa
- Retenção de **7 dias** para as duas operações (`p4`), por decisão do dono:
  tokens e PII somem juntos, com o cron `purge-idempotency-keys`.
- `claim_coupon` responde `IDEMPOTENCY_UNAVAILABLE` se a chave faltar, e o erro do
  `pgcrypto` é capturado para **não** vazar byte de cifra em mensagem.
- Se a chave for trocada, os replays antigos falham até as linhas saírem pela
  janela de 7 dias — o cliente tenta de novo sem chave e ganha um cupom novo,
  limitado por `per_customer_limit`.
- `tests/idempotency-encryption-guard.test.cjs` trava 26 invariantes do arquivo
  versionado, com prova por mutação.

## Condição de revisão obrigatória
Reabrir esta decisão se:
- O `rawToken` passar a ter validade de longo prazo (o que faria a retenção de
  7 dias passar a ser o elo fraco, e não a cifragem).
- Surgir requisito de dump/restauração que não possa carregar a chave junto.
- O projeto passar a rodar com um KMS externo já disponível.
- `per_customer_limit` deixar de estar em 3, o que tornaria o custo de perder um
  replay (cupom duplicado) mais alto.

Responsável pela decisão: usuário do projeto (autorizou "cifrar o `rawToken`"
depois de comprovada a exposição).

---

# Decisão registrada - o RLS é redinte de segurança, não a fronteira do app (2026-10-04)

## Contexto
A auditoria de 2026-10-04 procurou endurecer o RLS e encontrou um desenho que
convida ao erro. Estado verificado no banco:

- **24 tabelas de app** com `relrowsecurity = true`, todas `owner = postgres`,
  todas com `relforcerowsecurity = false`.
- **8 delas têm policy** `PERMISSIVE ... TO public`:
  `audit_logs`, `businesses`, `campaigns`, `coupon_templates`, `coupons`,
  `idempotency_keys`, `tenants` (só SELECT, `self_tenant_only`) e `users`.
- O `USING` de todas elas é `current_setting('app.current_tenant_id', true)`.
- **`app.current_tenant_id` não é definido em lugar nenhum do código.** A
  variável resolve para `NULL`, o qual não casa com nenhuma linha, e o RLS nega
  tudo. As outras 17 tabelas não têm policy nenhuma, e negam por definition.

Medido de verdade com `SET ROLE anon` e `SET ROLE authenticated`:
`coupons`, `users` e `businesses` devolvem **0 linhas** para os dois papéis.
`anon` e `authenticated` têm `rolbypassrls = false` e `row_security = on`.

Ou seja: **a barreira é real, mas é acidental.** Ela existe porque uma variável
de sessão nunca é setada, não porque o isolamento de tenant esteja implementado.

`public.spatial_ref_sys` (RLS desligada) **não** é tratada aqui: já está
registrada e aceita em 2026-09-29, com o bloqueio `42501` comprovado.

## Decisão
**Não** aplicar `FORCE ROW LEVEL SECURITY` e **não** revogar grants de `anon`.
Documentar o desenho e instalar um teste de regressão
(`supabase/verify-rls-anon.sql`) que falha se a barreira acidental cair.

Isso contraria a recomendação inicial da própria auditoria, que propunha os dois
`ALTER`. A evidência mensurada mostrou que as duas mudanças seriam inúteis:

- **`FORCE RLS` é no-op.** Ele só alcança o *owner* da tabela, e não alcança
  papel com `BYPASSRLS`. O owner de todas as 24 tabelas é `postgres`
  (`rolbypassrls = true`), e os owners das funções `SECURITY DEFINER` são
  `postgres` e `supabase_admin`, ambos com `BYPASSRLS`. Não existe caminho
  alcançável onde a mudança produza efeito.
- **`REVOKE` de `anon` é redundante.** O `anon` já lê 0 linhas. Revogaria uma
  negação que já existe, trocando risco real por ganho zero. O único caso em que
  o grant faz diferença é `idempotency_keys_secret`, que **já** não tem
  `SELECT` para `anon` nem para `authenticated` — fechada em duas camadas
  (GRANT e RLS).

## Justificativa
A fronteira de segurança real deste app é a **validação dentro das Netlify
functions**, não o RLS. Todo acesso a dados passa por
`netlify/functions/_supabaseAdmin.js`, que usa `SUPABASE_SERVICE_ROLE_KEY`;
`service_role` tem `rolbypassrls = true` e **ignora RLS por completo**. Não
existe chamada `.rpc()` ou `.from()` no código do navegador.

Por isso RLS aqui é **redinte**, não fronteira: existe para conter uma
exploração direta pela chave `anon` — que é pública por design e já esteve
embutida no bundle do cliente —, e não para autorizar acesso legítimo.

O risco real desta configuração não é a ausência de `FORCE RLS`. É que as 8
policies parecem implementarem isolamento de tenant e não implementam. Um
engenheiro que leia `tenant_isolation_all` e conclua que o isolamento está
pronto pode, num dia de_debug_, rodar
`set_config('app.current_tenant_id', ...)` ou criar uma policy permissiva nova
e abrir as 8 tabelas sem nenhum teste falhar. Por isso o teste de regressão
importa mais do que o `ALTER`.

## Mitigação que permanece ativa
- `tests/rls-anon-exposure.test.cjs`: gate externo, roda por HTTP contra o
  PostgREST de produção com a **chave `anon`** — que é pública por design, então
  não expõe segredo e não precisou de `pg` nem de migration. Faz o ataque real
  em vez de emular papel no SQL: se uma policy permissiva nova for criada ou um
  GRANT aberto, ele falha mesmo que o SQL interno continue verde. Desabilitado
  por padrão (`RUN_RLS_CHECK=1`), como os demais live tests.
  - O gate **reprova** e tem prova de que não é verde vazio: o próprio arquivo
    tem um teste que exige que `anon` **leia** `spatial_ref_sys`, a única tabela
    sem RLS. Se esse teste passar, o detector está cego. Em 2026-10-04, com a
    lista de tabelas adulterada para incluir `spatial_ref_sys`, o gate falhou com
    `VAZAMENTO: a chave anon leu estas tabelas: spatial_ref_sys`.
  - **Ligado ao CI em 2026-10-04**, como job **paralelo** (`security-rls`) e
    **não** como gatilho do deploy: não tem `needs:`, então roda junto com
    `build-and-deploy` e não bloqueia a publicação. Não usa `npm ci` — o
    arquivo só precisa de `node:test` e do `fetch` global, então uma etapa
    de instalação que pode falhar por motivo alheio à segurança ficou de fora.
    Sem `SUPABASE_URL` e `SUPABASE_ANON_KEY` em *Variables*, os dois testes
    são **skipped** e o job emite `::warning::`. Ver a armadilha registrada
    em 2026-10-04 abaixo: esse estado verde **não significa que o banco foi
    verificado**.
- `supabase/verify-rls-anon.sql`: só leitura, idempotente, percorre as 24
  tabelas × os 2 papéis e levanta `EXCEPTION` se qualquer uma devolver linha.
  É a camada interna; o teste HTTP acima é a externa.
- O detector é verificado contra `service_role`: substituindo `'anon'` por
  `'service_role'` no `set_config`, ele **tem de** acusar vazamento em 19
  tabelas. Se não acusar, o próprio teste está quebrado. Esse contra-teste foi
  executado em 2026-10-04 e disparou.
- `idempotency_keys_secret` sem `SELECT` para `anon`/`authenticated`, e com RLS
  ligado por cima.
- As 58 funções `SECURITY DEFINER` do `public` sem `EXECUTE` para
  `anon`/`authenticated` (ver `hardening-revoke-function-exec.sql`).

## Armadilha de medição registrada
Vale deixar isto escrito, porque produziu um falso alarme durante a auditoria:

O Postgres fixa o contexto de RLS e de permissão **no plano** da query, no
momento em que ela é planejada. Um probe que troca de papel com
`set_config('role','anon', ...)` dentro de uma CTE e conta linhas em
subqueries **estáticas** no mesmo comando devolve as linhas reais, contadas
como `postgres` — 48 coupons e 37 users, num banco onde o `anon` correto vê 0.

Por isso o script usa `EXECUTE` dinâmico dentro de plpgsql, que re-planeja em
tempo de execução com o papel já trocado. **Trocar esse `EXECUTE` por um
`SELECT` comum torna o teste inútil: ele passa a contar como `postgres` e
acusa um vazamento que não existe.** O aviso está no próprio arquivo, junto da
instrução de contra-teste.

## Condição de revisão obrigatória
Reabrir esta decisão se:
- Qualquer chamada a `.from()` ou `.rpc()` passar a existir no código do
  navegador (o RLS deixaria de ser redinte e viraria fronteira, e então
  precisaria de `FORCE RLS`, policies `TO authenticated` e `app.current_tenant_id`
 -populado por request).
- Uma policy nova `PERMISSIVE` for criada em qualquer das 8 tabelas listadas.
- `service_role` parar de ser o papel do backend.
- Alguém passar a definir `app.current_tenant_id` em qualquer lugar.

Responsável pela decisão: usuário do projeto (autorizou o hardening depois de
apresentada a evidência de que `FORCE RLS` e `REVOKE` seriam no-op ou
redundantes).

---

# Defeito pré-existente — horário da corrida dependia do fuso da máquina (2026-10-04)

## Contexto
Descoberto ao investigar por que o job novo de RLS ficava vermelho. **Não era
o RLS**: o job `Build e publica` estava vermelho desde 2026-10-03, e por um
motivo que ninguém notava porque o workflow já falhava por outros motivos.

`formatRunWhen` (`app/motorista/logic.js`) formatava o horário da corrida com
`toLocaleString` **sem `timeZone`**. A saída passa a seguir o fuso de quem
executa. O teste em `tests/motorista-logic.test.cjs` exige `14:00` para a
entrada `2026-10-02T14:00:00-03:00`:

```
fuso -03:00 (dev, esta máquina)  ->  02/10/2026, 14:00   passa
fuso UTC    (runner do GitHub)   ->  02/10/2026, 17:00   falha
```

Verde em dev, vermelho no CI, sem ninguém ter mudado nada. Falhou em três runs
seguidas — `37129163027`, `37131579181` e `37215487667` — a primeira de
2026-10-03, antes de qualquer alteração desta série de commits.

## Decisão
Fixar `timeZone: 'America/Sao_Paulo'` em `formatRunWhen`, em vez de deixar o
horário seguir a máquina. Verificado num worktree limpo com o conteúdo exato do
commit, sob `TZ=UTC` (a condição do CI): `633 tests, 611 pass, 0 fail,
22 skipped` — contra `610 pass, 1 fail` antes da correção.

A alternativa era tornar o assert timezone-agnóstico. Descartada porque deixa a
produção exibindo um horário que muda conforme a máquina de quem vê, e é
justamente isso que a tela do motorista não deve fazer.

## Risco resolvido que não era de segurança
O defeito é de exibição, não de exposição. Mas o efeito prático era grave:
**produção não recebia deploy há dias**, porque o job de build falhava antes de
publicar. A barreira real do RLS (Netlify functions com `service_role`, decisão
de 2026-10-04 acima) continuava de pé; o que estava parado era a entrega.

## Condição de revisão obrigatória
Reabrir se:
- O app passar a operar em mais de um fuso, ou a aceitar horário de reserva em
  UTC como entrada canônica — aí `America/Sao_Paulo` deixa de ser a única
  resposta certa e a decisão vira parâmetro.
- Algum outro `toLocaleString`/`toLocaleDateString` entrar no código sem
  `timeZone`. Vale procurar por `toLocale` ao revisar, não só por `formatRunWhen`.

Responsável pela correção: identificado e corrigido durante a auditoria de
segurança de 2026-10-04, com o gate de RLS já publicado.

---

# Armadilha de CI — gate de segurança verde sem verificar nada (2026-10-04)

## Contexto
O `security-rls` depende de `SUPABASE_URL` e `SUPABASE_ANON_KEY` em *Variables*
do repositório. Sem elas o job **fica verde**: os dois testes são `skip` e o
passo emite um `::warning::`.

Isso é intencional — o gate não pode bloquear o deploy por falha de rede ou de
configuração. Mas significa que **verde é o estado normal de um gate que não
verificou absolutamente nada**, e é um estado silencioso: quem olha a lista de
runs vê verde.

Pior: na primeira execução real, o job ficou **vermelho** por um motivo que não
era segurança. As variáveis tinham sido criadas com
`gh variable set SUPABASE_URL --body -`, e o `-` não significa "ler do stdin" —
foi gravado como valor literal. As duas variáveis existiam com **1 caractere**,
`-`, e toda URL montada ficou `-/rest/v1/<tabela>`, que nem é URL válida. Erro
de `TypeError` no `fetch`, não uma leitura indevida.

Vale registrar porque a sequência é instrutiva: o gate só pode falhar de forma
honesta depois de ter credenciais corretas, e credencial errada se apresenta
como falha de rede, não como erro de configuração.

## Como foi corrigido
- `SUPABASE_URL` e `SUPABASE_ANON_KEY` gravadas com o valor no `--body`, e
  reconferidas lendo de volta (`len=208`, prefixo `eyJhbGciOi`) antes de
  reexecutar o job.
- Rodado o gate **localmente** com os mesmos valores antes de tocar no CI, para
  não queimar outra run.
- `gh run rerun --failed` reexecutou **só** o `security-rls`; o
  `build-and-deploy` não foi republicado.

Resultado: run `37218619388` com os dois jobs em `success`, e o passo
`Verifica exposicao da chave anon` agora executa de verdade contra produção.

## Lição que fica
Um gate que **pula** em silêncio é pior que um gate que não existe, porque cria
a ilusão de verificação. Se o `::warning::` algum dia for ignorado, o projeto
passa a achar que tem proteção que não tem.

A mitigação é exigir, de tempos em tempos, a prova de que o gate detectaria um
vazamento real — o mesmo caminho do contra-teste com `service_role`, que prova
que o detector não é cego. E conferir o log do job, não só a cor.

## Condição de revisão obrigatória
- Se as *Variables* forem apagadas, renomeadas, ou se o job passar a ficar
  amarelo demais tempo sem que ninguém olhe, considerar tornar a ausência de
  configuração um **alarme explícito** — ou exigir as variáveis como `secrets`,
  para que o CI nem tenha como passar em branco.
- Se o gate passar a bloquear o deploy, revisar esta decisão: hoje ele é
  informativo por escolha, e essa escolha tem este custo.

Responsável pela decisão: usuário do projeto (mandou registrar o incidente e a
armadilha depois de o gate falhar por configuração errada).