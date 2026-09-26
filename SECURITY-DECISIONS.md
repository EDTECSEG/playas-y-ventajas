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

