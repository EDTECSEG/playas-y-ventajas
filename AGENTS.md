# Regras Obrigatórias de Trabalho (PYV)

Estas regras são vinculantes e devem ser seguidas em TODA alteração no projeto.

## Regra 1 — Backup antes de tudo (OBRIGATÓRIO antes de QUALQUER alteração)
- **Sempre** efetuar backup COMPLETO do estado atual do projeto ANTES de iniciar qualquer
  alteração (código, configuração, banco/schema, UI, deploy). Nenhuma alteração começa sem o
  backup confirmado no disco.
- Nome do arquivo indica **projeto + build/versão (ou estágio) + data+índice**:
  `pyv-web-backup-<data>-<indice>.zip`, onde `<indice>` é um número de versão/sequência que
  identifica exatamente o estado salvo (ex.: `pyv-web-backup-2026-09-24-3.zip` = 3ª leva do dia).
- Backup vai para `C:\Users\REUNIAO\Desktop\pyv-backups\`, **mantendo TODOS os backups
  anteriores** (nunca sobrescrever; sempre incrementar o sufixo numérico).
- Backup deve conter: código-fonte (`app/`, `lib/`, `public/`), configs, migrations/SQL,
  `functions/` e `netlify/functions/`. NÃO incluir `.env`/`.dev.vars` (credenciais ficam no
  disco, não no zip).
- Excluir sempre do zip: `node_modules`, `.wrangler`, `.next`, `out`, `.git`.
- Após criar, VALIDAR no disco: tamanho > 0, arquivos-chave listados, ausência de credenciais.
- O objetivo é poder RESTAURAR qualquer versão anterior caso algo quebre.
- Só começar a alteração depois de o backup estar confirmado e validado no disco.

## Regra 2 — Testar sempre primeiro, deploy só após aprovação
- **Toda** mudança deve ser testada PRIMEIRO na máquina local
  (`npm run build`, testes, `wrangler pages dev out` para validar functions).
- Só após TODOS os testes passarem, PERGUNTAR ao dono: *"posso fazer o deploy?"*.
- Dependendo da resposta: efetuar ou não o deploy.
- Nunca executar `wrangler pages deploy` sem permissão explícita (plano Free = créditos/builods limitados).
- Não deplorar mais de uma vez por leva de alterações sem necessidade.

## Regra 3 — Segurança da Informação (obrigatório em toda mudança)
Antes de tutto deploy seguro, executar testes de segurança:
- **Acesso não autorizado / invasão**: endpoints com sessão (empresa, admin, validate-coupon,
  upload-image) devem exigir token válido; tentativas sem token -> 401/403, nunca 200.
- **IDOR**: verificar que usuário não acessa dados de outro business/tenant
  (sessionToken sempre resolvido no servidor; nunca confiar em userId/tenantId do cliente).
- **Vazamento de dados**: nenhuma resposta deve expor `SUPABASE_SERVICE_ROLE_KEY`,
  `RESEND_API_KEY`, senhas, pin_hash, tokens de terceiros.
- **Entrada inválida**: validation de payloads (types, tamanho, campos obrigatórios);
  sem debug/stack traces no body.
- **Erros**: esconder detalhes internos (`NEXT_PUBLIC_SUPABASE_URL`, mensagens de exceção
  cruas) nos logs/respostas voltadas ao cliente.
- **OTP/credenciais**: códigos OTP nunca retornados na resposta; rate-limit ativo.
- Rodar uma bateria de checagens de segurança (script ou manual) a cada leva de mudanças,
  antes de perguntar pelo deploy.

## Regra 4 — Fechar EXECUTE de funções ao fim de cada módulo (OBRIGATÓRIO)
- Toda função em `public` nasce com **EXECUTE para PUBLIC** — e `anon` e
  `authenticated` são membros de PUBLIC. Se uma função nova ficar executável
  pelo anon, isso é bypass de autenticação.
- `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` **não
  previne isso** (comprovado em 2026-09-25: o default é gravado em
  `pg_default_acl`, mas a função seguinte nasce com `=X`). Só o REVOKE
  explícito no objeto fecha.
- Consequência: `DROP FUNCTION` + `CREATE` (usado quando a assinatura muda)
  **zera o ACL** e reabre a função. Já aconteceu com
  `admin_driver_reset_pin`.
- **Obrigatório:** rodar `supabase/close-function-exec.sql` no SQL Editor ao
  final de TODO módulo que criar ou recriar funções. É idempotente.
- Verificar o resultado: `app_ainda_abertas` tem que ser **0**. Se voltar
  diferente, o módulo está expondo função.
- Não confiar só no "rodou sem erro": o comando de revogação é silencioso. O
  que vale é o número da verificação.
- As 721 funções do postgis não são fecháveis por este caminho (ACL de função
  membro de extensão é imutável) e o risco foi aceito — ver
  `SECURITY-DECISIONS.md`.

## Regra 5 — Ao medir ACL, usar aclexplode (não ILIKE em proacl::text)
- `proacl::text ILIKE '%=X/%'` dá **falso positivo**: casa com
  `postgres=X/postgres`, porque o nome do dono `postgres` termina em `=X/`.
  Reportou 66 de 66 funções abertas quando nenhuma estava.
- Filtrar `grantee IN (0, ...)` via `aclexplode` também erra se comparar
  `0::regrole` como texto: OID 0 é PUBLIC e não resolve para regrole, vira NULL
  e o filtro nunca casa.
- Forma correta: `aclexplode(coalesce(proacl,'{}'::aclitem[])) x` e comparar
  `x.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)`, com
  `EXISTS` (não JOIN, que multiplica linhas). Usar em toda verificação.

## Fluxo padrão a cada mudança
1. Backup do estado atual (Regra 1), com nome `pyv-web-backup-<data>-<indice>.zip`, validado no disco.
2. Implementar alteração.
3. Se o módulo cria/recria funções: rodar `close-function-exec.sql` e conferir `app_ainda_abertas = 0` (Regra 4).
4. Build local + testes de função (Regra 2).
5. Bateria de segurança (Regra 3).
6. Perguntar "posso fazer o deploy?".
7. Aguardar resposta; executar deploy somente com SIM explícito.

## Push de git (perguntar sempre antes)
A config `C:\Users\REUNIAO\.config\opencode\opencode.jsonc` tem
`"git push": "ask"` e `"git push *": "ask"`: o push passa, mas o opencode
pergunta antes de executar. Isso e intencional e nao deve ser mudado para
"allow" nem para "deny" sem o dono pedir. Autorizacao dada em conversa nao
vale como resposta ao prompt: responder o prompt e o que libera o push.
Ordem antes de qualquer push: backup (Regra 1), implementacao, testes
(Regra 2), bateria de seguranca (Regra 3), entao perguntar e so entao
executar. Nao contornar a regra reescrevendo o comando (`cmd /c`, `& git`,
script, Invoke-Expression).

## Custo de API do Cloudflare
Plano Free tem creditos/builds limitados. Para verificar deploy, preferir
`curl` na URL publica (`https://<deploy>.pages.dev`) e respostas HTTP, que
custam zero. Reservar a API do Cloudflare para o que o curl nao responde:
ler config do projeto, alterar settings, lista de env vars ou logs de build.
Agrupar em uma unica chamada o que for Consultar, em vez de uma por item.
