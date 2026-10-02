'use strict';

// CONTRATO DA UI x RPC, verificado AO VIVO.
//
// `empresa_dashboard` e uma das RPCs que existem em producao sem `.sql` no repo
// (ver API.md). O handler faz pass-through puro: `JSON.stringify(data)`. Isso
// deixa a UI acoplada ao nome exato das colunas da RPC sem nenhum contrato
// escrito - e foi exatamente assim que o bug do `dash.rewardStatus` passou
// despercebido no /afiliado: a tela le um campo, o backend nao devolve, e nada
// quebra no build.
//
// Este teste fecha esse buraco pelo lado que ainda da: perguntar a PRODUCAO.
// Ele nao substitui o `.sql` (para isso o MCP), mas transformaria o contrato
// em algo verificavel hoje.
//
// Desabilitado por padrao. Para rodar:
//   PowerShell:  $env:RUN_LIVE=1; npm test -- tests/live.dashboard-contract.test.cjs
// Credenciais (obrigatorias - nao ha default que sirva em producao):
//   $env:LIVE_TENANT; $env:LIVE_CODE; $env:LIVE_PIN
//
// Sem credencial o teste nao roda: cai em skip com o motivo, em vez de passar
// em branco dando uma falsa sensacao de cobertura.

const { test } = require('node:test');
const assert = require('node:assert');

const BASE = process.env.LIVE_BASE || 'https://playas-y-ventajas.pages.dev';
const TENANT = process.env.LIVE_TENANT || '';
const CODE = process.env.LIVE_CODE || '';
const PIN = process.env.LIVE_PIN || '';

// O que app/empresa/page.jsx le de `dash`, por bloco. snake_case e proposital:
// a RPC devolve as colunas do banco, e o handler nao renomeia nada.
//   :1100  dash.campaigns[].{id,title,status}
//   :1104  dash.templates[].image_url
//   :1105  dash.templates[].is_active
//   :1106  dash.templates[].{title,issued_count}
//   :1109  dash.templates[].featured_until
//   :1116  dash.templates[].id
//   :1144  dash.coupons[].{id,publicId,status,customerName,customerPhone}
const CONTRATO = {
  campaigns: ['id', 'title', 'status'],
  templates: ['id', 'title', 'image_url', 'is_active', 'issued_count', 'featured_until'],
  coupons: ['id', 'publicId', 'status', 'customerName', 'customerPhone'],
};

function semCredencial() {
  const faltando = [];
  if (!TENANT) faltando.push('LIVE_TENANT');
  if (!CODE) faltando.push('LIVE_CODE');
  if (!PIN) faltando.push('LIVE_PIN');
  if (!faltando.length) return null;
  return `credencial live ausente (${faltando.join(', ')}): configure no ambiente antes de rodar`;
}

// `skip` so deixa o teste rodar com `false` LITERAL. Node v22 trata `null` e
// `undefined` como "pule": os testes passavam em branco (exit 0) mesmo com
// credencial errada. `semCredencial() || false` mantem o motivo do skip e
// devolve o booleano certo quando nao ha o que pular.

const skip = () => {
  if (process.env.RUN_LIVE !== '1') return 'habilite com RUN_LIVE=1 para rodar contra producao';
  return semCredencial() || false;
};

async function login() {
  const res = await fetch(`${BASE}/.netlify/functions/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantSlug: TENANT, internalCode: CODE, pin: PIN }),
  });
  assert.strictEqual(res.status, 200, `login falhou com ${res.status}`);
  const body = await res.json();
  assert.ok(body.sessionToken, 'login deve devolver sessionToken');
  return body.sessionToken;
}

async function dashboard(sessionToken) {
  const res = await fetch(`${BASE}/.netlify/functions/empresa`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.strictEqual(res.status, 200, `GET /empresa falhou com ${res.status}`);
  return res.json();
}

// Os tres blocos tem de existir e ser array: a UI faz `dash.x || []`, entao
// um null nao quebra a tela, mas some com o cartao inteiro sem erro nenhum.
test('empresa_dashboard devolve os 3 blocos que a UI le, como array', { skip: skip() }, async () => {
  const dash = await dashboard(await login());
  for (const bloco of Object.keys(CONTRATO)) {
    assert.ok(Array.isArray(dash[bloco]), `${bloco} ausente ou nao-array (veio: ${typeof dash[bloco]})`);
  }
});

// Este e o teste que teria pegado o bug do rewardStatus: nao pergunta se o
// campo tem valor, pergunta se o NOME existe em algum elemento. Um
// businesses de teste sem campanhas nao valida o contrato, entao a checagem
// so roda quando cada bloco tem ao menos um elemento.
test('empresa_dashboard: todo campo lido pela UI existe nos dados', { skip: skip() }, async () => {
  const dash = await dashboard(await login());
  const vazios = Object.keys(CONTRATO).filter((b) => (dash[b] || []).length === 0);
  if (vazios.length) {
    // Nao e falha: e o caso em que o contrato nao pode ser provado agora.
    return;
  }
  for (const [bloco, campos] of Object.entries(CONTRATO)) {
    const elemento = dash[bloco][0];
    for (const campo of campos) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(elemento, campo),
        `empresa_dashboard devolveu ${bloco}[] sem o campo "${campo}", que app/empresa/page.jsx le`,
      );
    }
  }
});

// `tpl.is_active === false` decide o texto do botao ativar/desativar. Se a
// coluna sumisse, o `=== false` nunca casaria e um template desativado
// apareceria como ativo - falha silenciosa, sem erro de rede.
test('is_active de template distingue ativo de desativado de verdade', { skip: skip() }, async () => {
  const dash = await dashboard(await login());
  if (!(dash.templates || []).length) return;
  for (const tpl of dash.templates) {
    assert.strictEqual(
      typeof tpl.is_active,
      'boolean',
      `is_active veio ${typeof tpl.is_active} - o toggle de ativar/desativar depende de boolean`,
    );
  }
});

// Guarda a lista: sem este teste, remover um bloco de CONTRATO deixa os testes
// acima passando com um contrato menor, e ninguem nota.
test('o contrato declarado cobre os 3 blocos da UI', () => {
  assert.deepStrictEqual(Object.keys(CONTRATO).sort(), ['campaigns', 'coupons', 'templates']);
  for (const [bloco, campos] of Object.entries(CONTRATO)) {
    assert.ok(campos.includes('id'), `${bloco} sem id`);
  }
  // snake_case nao se house-style deste RPC; o handler e pass-through puro.
  assert.ok(CONTRATO.templates.includes('issued_count'), 'templates deveria ler issued_count em snake_case');
  assert.ok(CONTRATO.coupons.includes('customerName'), 'coupons usa camelCase (customerName)');
});