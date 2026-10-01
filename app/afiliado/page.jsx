'use client';

// Modulo do afiliado (Modelo A - recompensa em cupom). Publico, sem sessao:
// o vinculo e por telefone, igual ao fluxo do cliente.
//
// Os textos desta tela ainda ficam em portugues literal. A nota antiga dizia
// que era por causa de uma alteracao em lib/i18n.js que ja terminou: as
// strings migram para t.* (pt/en/es) em um lote proprio. A folha impressa de
// divulgacao entrou em portugues junto com o resto da tela, para nao deixar
// metade dela em outro idioma.

import { useEffect, useRef, useState } from 'react';
import Header from '../components/Header';
import { theme } from '../../lib/theme';
import { QR_SYSTEM_LOGO, renderQrWithLogo } from '../../lib/qr-logo';

const wrap = { maxWidth: 720, margin: '0 auto', padding: '20px 20px 80px', color: theme.text };
const card = { background: theme.card, color: theme.text, borderRadius: 14, padding: 20, marginBottom: 16, border: `1px solid ${theme.border}`, boxShadow: '0 2px 8px rgba(11,110,79,0.06)' };
const input = { padding: 9, borderRadius: 8, border: `1px solid ${theme.border}`, marginRight: 8, marginBottom: 8, width: '100%', boxSizing: 'border-box' };
const btn = { padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', background: theme.gold, color: theme.greenDark, fontWeight: 700, marginRight: 8 };
const smallBtn = { ...btn, padding: '5px 12px', fontSize: 12 };

// O value das opcoes PRECISA ser o valor aceito pelo CHECK do banco
// (affiliates_kind_check: 'customer' | 'driver' | 'business'). Antes eram
// 'customer' | 'empresa' | 'motorista', e escolher empresa ou motorista
// rebentava o INSERT com violacao de check - o cadastro do afiliado simply
// nao acontecia. O texto da opcao continua em portugues para o usuario.
const KIND_LABEL = { customer: 'Cliente', driver: 'Motorista', business: 'Empresa' };

// O extrato mostra DUAS datas e nao as junta numa so, porque nao sao o
// mesmo evento:
//   - converted_at e quando a indicacao converteu, que dispara no CLAIM (a
//     pessoa pegou o cupom). E quando o afiliado ganha a recompensa.
//   - resgatadoEm vem de coupons.validated_at, que e quando o cupom foi
//     validado no caixa, e pode ser muito depois ou nunca acontecer.
// Chamar o cupom de "resgatado" quando ele so foi pego faz o afiliado contar
// uma recompensa que ainda nao existe, que e exatamente o numero que ele usa
// para decidir se vale continuar divulgando.
function dataCurta(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('pt-BR');
}

// benefit_type vem do banco como texto livre ('percent' e o caso usual, mas o
// CHECK nao obliga). Traduzir por igualdade seria chutar: qualquer valor
// desconhecido e repassado como veio, em vez de virar "undefined%" na tela.
function beneficioLabel(tipo, valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  // A variavel nao se chama "t" de proposito: em app/ esse prefixo de uma
  // letra identifica a funcao de traducao, e o teste de i18n le qualquer
  // chamada com esse prefixo como chave usada. Com o nome "t", o
  // String.prototype.includes desta funcao entrava na lista de chaves
  // faltando e quebrava a suite sem ter nada a ver com traducao.
  const tipoNorm = String(tipo || '').toLowerCase();
  if (tipoNorm.includes('percent')) return `${valor}%`;
  if (tipoNorm.includes('fixed') || tipoNorm.includes('money') || tipoNorm.includes('cash')) {
    return `R$ ${Number(valor).toFixed(2).replace('.', ',')}`;
  }
  return `${tipo ? tipo + ' ' : ''}${valor}`;
}

// O rotulo precisa dizer qual dos dois eventos aconteceu, senao o afiliado
// le "12/09" e nao sabe se e a data em que o premio caiu ou a data em que o
// cliente usou o cupom.
function statusResgate(r) {
  if (r.status !== 'converted') return { rotulo: 'Aguardando a pessoa pegar um cupom', cor: theme.textMuted };
  if (r.resgatadoEm) return { rotulo: 'Resgatado no caixa', cor: theme.greenDark };
  if (r.cupomCodigo) return { rotulo: 'Cupom em mãos, ainda não usado', cor: theme.textMuted };
  return { rotulo: 'Convertida, cupom não localizado', cor: theme.textMuted };
}

function quandoResgate(r) {
  if (r.resgatadoEm) return { data: dataCurta(r.resgatadoEm), de: 'usou o cupom' };
  if (r.cupomEm) return { data: dataCurta(r.cupomEm), de: 'pegou o cupom' };
  if (r.indicadoEm) return { data: dataCurta(r.indicadoEm), de: 'entrou pelo link' };
  return { data: '—', de: '' };
}

export default function AfiliadoPage() {
  const [affiliate, setAffiliate] = useState(null); // { affiliateId, referralCode, name, phone, kind }
  const [form, setForm] = useState({ name: '', phone: '', email: '', kind: 'customer' });
  const [busy, setBusy] = useState(false);
  const [dash, setDash] = useState(null);
  const [msg, setMsg] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const qrRef = useRef(null);
  const qrSheetRef = useRef(null);

  useEffect(() => {
    setShareUrl(`${window.location.origin}/?ref=${encodeURIComponent((affiliate && affiliate.referralCode) || '')}`);
  }, [affiliate]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('pyv_affiliate');
      if (saved) {
        const a = JSON.parse(saved);
        setAffiliate(a);
        loadDash(a);
      }
    } catch (e) { /* sem afiliado salvo */ }
  }, []);

  // O mesmo QR e desenhado em dois pontos: o card de compartilhamento e a
  // folha de divulgacao. Nao da para reaproveitar o canvas da tela, porque a
  // folha precisa dele em tamanho de leitura (o de tela e pequeno demais
  // para quem recebe o papel) e impressora precisa de um no proprio ponto.
  useEffect(() => {
    if (!shareUrl) return;
    let cancelled = false;
    (async () => {
      try {
        // Este QR e o link de cadastro/indicacao do sistema, nao um cupom de
        // empresa: quem leve o papel para outra pessoa deve ver o logo do
        // PYV, e nao o de um lojista. QR_SYSTEM_LOGO deixa isso explicito,
        // ainda que o helper cairia nele de qualquer jeito.
        for (const ref of [qrRef, qrSheetRef]) {
          if (cancelled || !ref.current) continue;
          await renderQrWithLogo(ref.current, { text: shareUrl, size: 200, logoUrl: QR_SYSTEM_LOGO });
        }
      } catch (e) { /* QR opcional */ }
    })();
    return () => { cancelled = true; };
  }, [shareUrl]);

  async function register() {
    if (!form.name.trim()) { setMsg('Informe seu nome.'); return; }
    if (!form.phone.trim()) { setMsg('Informe seu telefone.'); return; }
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/.netlify/functions/affiliates', {
        method: 'POST',
        body: JSON.stringify({ name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim() || undefined, kind: form.kind }),
      });
      const data = await res.json();
      if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
      const a = { affiliateId: data.affiliateId, referralCode: data.referralCode, name: form.name.trim(), phone: form.phone.trim(), kind: form.kind };
      setAffiliate(a);
      try { localStorage.setItem('pyv_affiliate', JSON.stringify(a)); } catch (e) { /* sem storage */ }
      setMsg('💚 Cadastro criado! Compartilhe seu link abaixo.');
      loadDash(a);
    } catch (err) {
      setMsg(`Erro: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadDash(a) {
    const aff = a || affiliate;
    if (!aff) return;
    try {
      const res = await fetch(`/.netlify/functions/affiliates?affiliateId=${encodeURIComponent(aff.affiliateId)}&phone=${encodeURIComponent(aff.phone)}`);
      const data = await res.json();
      if (res.ok && data && data.affiliateId) setDash(data);
    } catch (e) { /* dashboard opcional: nao derruba a tela */ }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setMsg('Link copiado!');
    } catch (e) {
      setMsg('Não foi possível copiar. Selecione e copie o link abaixo.');
    }
  }

  function shareWhatsApp() {
    const text = encodeURIComponent(`Ganhe desconto e aproveite Cabo Frio: ${shareUrl}`);
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  }

  function shareInstagram() {
    const text = encodeURIComponent(`Aproveite a sua próxima visita ♥ ${shareUrl}`);
    window.open(`https://www.instagram.com/?caption=${text}`, '_blank');
  }

  return (
    <main style={{ background: theme.bg, minHeight: '100vh' }}>
      <style>{`
        /* Folha de divulgacao: escondida na tela, e a unica coisa que sai na
           impressora. O padrao e o mesmo do bloco de estilo escopado que o
           /cliente usa. Nao escrever tags com chevron aqui dentro: o servidor
           escapa o texto do style e o React acusa hydration mismatch. */
        .pyv-sheet { display: none; }
        @media print {
          .pyv-screen { display: none !important; }
          /* O InstallPrompt vem do layout e e renderizado antes do main, fora
             do .pyv-screen: a faixa amarela de instalar o app sairia no topo
             do cartaz. Esconder por classe e nao por seletor de filho
             porque o chevron de combinador precisa virar &gt; no HTML
             exportado, e o texto de um bloco de estilo nao e decodificado: o
             seletor chegaria invalido e a regra seria descartada. */
          .app-install-prompt { display: none !important; }
          .pyv-sheet {
            display: block !important;
            background: #fff;
            color: #14321F;
            /* padding/max-width sao inline na folha, e inline ganha de regra
               de classe: sem !important o papel sairia com a margem da tela. */
            padding: 0 !important;
          }
          /* @page e respeitado pelo Chrome/Safari/Edge ao imprimir. O topo
             grande existe por causa do cabecalho automatico do navegador, que
             some quando a margem e 0. */
          @page { size: A4 portrait; margin: 12mm; }
          /* O main tem min-height: 100vh para cobrir a tela. Na impressao 100vh
             e a altura da folha: o main ocuparia uma pagina inteira e, somado
             a margem do @page, empurraria uma segunda folha em branco para
             tras do cartaz. */
          main { min-height: 0 !important; background: #fff !important; }
          /* Sem isso o Chrome descarta o fundo do box e o cartaz sai sem a
             moldura verde. Vale para a folha e para tudo dentro dela. */
          .pyv-sheet, .pyv-sheet * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .pyv-sheet-box {
            border: 2px solid #0B6E4F;
            border-radius: 10px;
            padding: 10mm 8mm;
            page-break-inside: avoid;
          }
.pyv-sheet-qr { width: 46mm; height: 46mm; }
        /* O quadro e a imagem sao esticados para a caixa de 46mm. Sem isto a
           <img> do qrcodejs sai nos 200px naturais (52,9mm) e transborda a
           folha em 6,9mm -- e o % do chip passaria a medir contra 200px em
           vez de 46mm. Medido em 2026-10-01 antes desta regra: chip com 10,0%
           do QR e 13,1px fora do centro. */
        .pyv-sheet-qr [data-qr-frame] { width: 46mm; height: 46mm; }
        .pyv-sheet-qr [data-qr-frame] img { width: 100%; height: 100%; display: block; }
        .pyv-sheet-step { page-break-inside: avoid; }
        }
      `}</style>
      <div className="pyv-screen">
      <Header title="🤝 Afiliados — Playas y Ventajas" />

      <div style={wrap}>

        {!affiliate ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Quero ganhar com indicações</h3>
            <p style={{ fontSize: 13, marginTop: 0 }}>
              Cadastre-se, ganhe seu link exclusivo e compartilhe. A cada amigo que se cadastrar e resgatar um cupom,
              você recebe uma recompensa em cupom de cortesia — sem precisar de login.
            </p>
            <input style={input} placeholder="seu nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input style={input} placeholder="(00) 00000-0000" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input style={input} placeholder="seu e-mail (opcional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <select style={input} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="customer">Sou cliente do programa</option>
              <option value="business">Represento uma empresa parceira</option>
              <option value="driver">Sou motorista parceiro</option>
            </select>
            <button style={btn} onClick={register} disabled={busy}>{busy ? 'Cadastrando…' : 'Criar meu link de indicação'}</button>
          </div>
        ) : (
          <>
          <div style={{ ...card, border: `2px solid ${theme.gold}` }}>
            <h3 style={{ marginTop: 0 }}>Olá, {affiliate.name} 👋</h3>
            <p style={{ fontSize: 13, marginTop: 0 }}>
              Seu código: <strong style={{ fontFamily: 'monospace', letterSpacing: 1 }}>{affiliate.referralCode}</strong>
              <button style={smallBtn} onClick={() => navigator.clipboard?.writeText(affiliate.referralCode) && setMsg('Código copiado.')}>Copiar</button>
            </p>
            <p style={{ fontSize: 13 }}>Compartilhe seu link:</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <input readOnly style={{ ...input, flex: 1, minWidth: 220, background: theme.bg }} value={shareUrl} onFocus={(e) => e.target.select()} />
              <button style={btn} onClick={copyLink}>Copiar link</button>
              <button style={{ ...btn, background: '#128C4A', color: '#fff' }} onClick={shareWhatsApp}>WhatsApp</button>
              <button style={{ ...btn, background: '#E4405F', color: '#fff' }} onClick={shareInstagram}>Instagram</button>
            </div>
            <div ref={qrRef} style={{ display: 'flex', justifyContent: 'center', margin: '6px 0' }} />
            <p style={{ fontSize: 12, color: theme.textMuted, margin: '6px 0 0' }}>
              Quer entregar em papel? A folha sai pelo próprio navegador — em "Imprimir" escolha "Salvar em PDF" para mandar por WhatsApp.
            </p>
            <button
              style={{ ...smallBtn, marginTop: 8 }}
              onClick={() => {
                // A folha vive no DOM o tempo todo, so invisivel na tela: assim
                // nao ha estado de "abriu a folha?" para sincronizar, e o que
                // sai na impressora e sempre a versao atual do link.
                window.print();
              }}
            >
              🖨 Imprimir minha folha
            </button>
            <button style={{ ...smallBtn, background: theme.border, color: theme.text }} onClick={() => { setAffiliate(null); setDash(null); try { localStorage.removeItem('pyv_affiliate'); } catch (e) { /* sem storage */ } setForm({ name: '', phone: '', email: '', kind: 'customer' }); }}>
              Sair deste perfil
            </button>
          </div>

          {dash && (
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>Painel de indicações</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                {[
                  ['Linkadas', dash.totalReferrals ?? 0],
                  ['Convertidas', dash.converted ?? 0],
                  ['Pendentes', dash.pending ?? 0],
                  ['Premiadas', dash.rewardCoupons ?? 0],
                  ['Cupons na mão', dash.cuponsPegos ?? 0],
                  ['Cupons no caixa', dash.cuponsResgatados ?? 0],
                ].map(([label, value]) => (
                  <div key={label} style={{ flex: '1 1 90px', background: theme.bg, borderRadius: 10, padding: 10, textAlign: 'center', border: `1px solid ${theme.border}` }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: theme.greenDark }}>{value}</div>
                    <div style={{ fontSize: 12, color: theme.textMuted }}>{label}</div>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 12, color: theme.textMuted, marginTop: 0 }}>
                Recompensa: {dash.rewardStatus === 'active' ? 'ativa' : dash.rewardStatus || '—'} · Afiliado desde {new Date(dash.createdAt).toLocaleDateString('pt-BR')}
              </p>

              {/* Extrato. A lista antiga mostrava so nome + status e nao dizia
                  qual cupom a pessoa pegou nem se chegou a usar, que e o
                  numero que o afiliado precisa para calcular ganho. */}
              <h4 style={{ margin: '18px 0 8px' }}>Extrato de resgates</h4>
              {(dash.resgates || []).length === 0 ? (
                <p style={{ fontSize: 13 }}>
                  Nenhum resgate ainda. Assim que alguém entrar pelo seu link e
                  pegar um cupom, ele aparece aqui.
                </p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {(dash.resgates || []).map((r) => {
                    const st = statusResgate(r);
                    const quando = quandoResgate(r);
                    const beneficio = beneficioLabel(r.beneficioTipo, r.beneficioValor);
                    return (
                      <li
                        key={r.id}
                        style={{ borderTop: `1px solid ${theme.border}`, padding: '10px 0', fontSize: 13 }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                          <strong>{r.indicado || r.telefone || 'Anônimo'}</strong>
                          <span style={{ color: st.cor, fontWeight: 700 }}>{st.rotulo}</span>
                        </div>
                        <div style={{ color: theme.textMuted, marginTop: 2 }}>
                          {quando.de ? `${quando.data} · ${quando.de}` : quando.data}
                        </div>
                        {r.cupomCodigo && (
                          <div style={{ marginTop: 4 }}>
                            {r.cupom || 'Cupom'}
                            {beneficio ? ` · ${beneficio}` : ''}
                            {r.estabelecimento ? ` · ${r.estabelecimento}` : ''}
                            {' · '}
                            <code style={{ fontSize: 12 }}>{r.cupomCodigo}</code>
                          </div>
                        )}
                        {r.premioCodigo && (
                          <div style={{ color: theme.textMuted, marginTop: 2, fontSize: 12 }}>
                            Sua recompensa: <code>{r.premioCodigo}</code>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          </>
        )}

        {msg && <p style={{ fontSize: 13, color: theme.greenDark, fontWeight: 600 }}>{msg}</p>}
      </div>
      </div>

      {/* Folha de divulgacao em papel. O PDF sai daqui pelo proprio
          navegador (Imprimir > Salvar em PDF), sem passar por servidor: nao ha
          pagina, template ou fonta carregando, e o proprio afiliado pode
          reimprimir quantas vezes quiser. */}
      {affiliate && (
        <div className="pyv-sheet" style={{ padding: '24px 20px 40px', maxWidth: 720, margin: '0 auto' }}>
          <div className="pyv-sheet-box">
            <p style={{ margin: 0, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', color: '#0B6E4F' }}>
              Playas y Ventajas · Cabo Frio
            </p>
            <h1 style={{ margin: '4px 0 2px', fontSize: 26, lineHeight: 1.2 }}>
              Ganhe desconto em cada indicação
            </h1>
            <p style={{ margin: '0 0 6mm', fontSize: 14 }}>
              Indique um amigo, ele resgata um cupom e os dois ganham bônus. Sem cadastro e sem senha.
            </p>

            <div style={{ display: 'flex', gap: '8mm', alignItems: 'center' }}>
              <div>
                <div ref={qrSheetRef} className="pyv-sheet-qr" />
                <p style={{ margin: '3mm 0 0', fontSize: 10, color: '#4A6B5B' }}>
                  Aponte a câmera
                </p>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#4A6B5B' }}>
                  Seu link pessoal
                </p>
                <p style={{ margin: '1mm 0 4mm', fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
                  {shareUrl}
                </p>
                <p style={{ margin: 0, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#4A6B5B' }}>
                  Ou digite o código
                </p>
                <p style={{ margin: '1mm 0 4mm', fontSize: 22, fontWeight: 800, letterSpacing: 2, fontFamily: 'monospace' }}>
                  {affiliate.referralCode}
                </p>
                <p style={{ margin: 0, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#4A6B5B' }}>
                  Fale com quem indicou
                </p>
                <p style={{ margin: '1mm 0 0', fontSize: 13, fontFamily: 'monospace' }}>
                  {affiliate.phone}
                </p>
              </div>
            </div>

            <hr style={{ border: 0, borderTop: '1px solid #C9DED3', margin: '7mm 0 5mm' }} />

            <div className="pyv-sheet-step" style={{ display: 'flex', gap: '5mm' }}>
              {[
                ['1', 'A pessoa entra pelo QR ou pelo link e se cadastra com o telefone.'],
                ['2', 'Ela pega um cupom e mostra no caixa do estabelecimento.'],
                ['3', 'O cupom é validado na hora e os dois recebem o bônus.'],
              ].map(([n, texto]) => (
                <div key={n} style={{ flex: 1, fontSize: 11.5, lineHeight: 1.5 }}>
                  <span style={{
                    display: 'inline-block', width: 17, height: 17, lineHeight: '17px', textAlign: 'center',
                    borderRadius: '50%', background: '#0B6E4F', color: '#fff', fontWeight: 800, fontSize: 11, marginRight: 5,
                  }}>{n}</span>
                  {texto}
                </div>
              ))}
            </div>

            <p style={{ margin: '6mm 0 0', fontSize: 10, color: '#4A6B5B', lineHeight: 1.5 }}>
              {dash && dash.rewardStatus === 'active'
                ? 'Bônus de boas-vindas ativo para quem é indicado e para quem indicou.'
                : 'Peça confirmação ao estabelecimento sobre o bônus de boas-vindas antes de distribuir.'}
              {' '}Indicação feita por {affiliate.name}. O cupom é validado uma única vez, na data da visita.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
