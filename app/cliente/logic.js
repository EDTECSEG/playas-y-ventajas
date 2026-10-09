// Logica pura do cliente, para o que o mapa do Leaflet desenha.
//
// Mesmo contrato de app/motorista/logic.js: funcao sem efeito colateral, sem
// React, sem DOM e sem import, para poder ser testada com node --test direto nos
// .cjs. O componente so orquestra estado e render.
//
// O que mora aqui e o HTML que vai para dentro do Leaflet. Isso e decisao de
// seguranca, nao de estetica: `L.divIcon({ html })` e `bindPopup()` interpreted
// HTML do navegador, e `driver_name` foi digitado por qualquer pessoa no
// cadastro, sem validacao. Um motorista chamado
// `<img src=x onerror=...>` executaria script na pagina de todo mundo que abre
// o mapa. Por isso o nome sai daqui sempre escapado, e o mesmo vale para os
// rotulos, que vem do i18n — traduzido, ainda nao confiavel.

export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Numero finito dentro da faixa, ou null. `lat`/`lng` chegam do Postgres como
// numero, mas o filtro tambem existe para estado que veio de outro caminho (e
// para o Leaflet nunca receber string, que ele aceitaria eTrataria errado).
function coord(v, min, max) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// O que o mapa e capaz de desenhar. Descarta quem nao tem coordenada: um
// L.marker com lat undefined coloca o mapa inteiro num estado invalido.
export function visibleVehicles(vehicles) {
  if (!Array.isArray(vehicles)) return [];
  const out = [];
  for (const v of vehicles) {
    if (!v || typeof v !== 'object') continue;
    const lat = coord(v.lat, -90, 90);
    const lng = coord(v.lng, -180, 180);
    if (lat === null || lng === null) continue;
    out.push({ ...v, lat, lng });
  }
  return out;
}

// Janela de auto-atualizacao do translado no mapa do cliente.
//
// O mapa so buscava a lista quando o usuario tocava em "Ver perto de mim". Uma
// posicao enviada DEPOIS disso nunca aparecia ate tocar de novo — era o que
// fazia o carro "sumir" de quem ja estava com a tela aberta. 30s e o mesmo passo
// do envio automatico do motorista (AUTO_POSITION_MS), entao cada re-busca
// quase sempre encontra uma posicao nova sem martelar o endpoint.
export const SHUTTLE_REFRESH_MS = 30000;

// A re-busca so roda depois que a primeira busca terminou e com a aba visivel.
// Com a aba em segundo plano, pausar evita gastar rede a toa (ninguem esta
// vendo o mapa). `hidden` indefinido conta como visivel, para a decisao nao
// depender de a pagina ter lido document.visibilityState.
export function shouldRefreshShuttle({ status, hidden } = {}) {
  if (status !== 'done') return false;
  if (hidden === true) return false;
  return true;
}

// "Em movimento" so quando a velocidade diz isso. speed_kmh e null quando o
// navegador nao devolveu heading/speed: dizer "Parado" ali seria afirmar algo
// que o banco nao sabe. Number(null) e 0 (finito), entao o null sai antes.
function motionLabel(v, t) {
  const raw = v.speedKmh;
  if (raw === null || raw === undefined || raw === '') return '';
  const kmh = Number(raw);
  if (!Number.isFinite(kmh)) return '';
  return kmh > 1 ? (t.vehicleMoving ?? 'Em movimento') : (t.vehicleStopped ?? 'Parado');
}

// Pin do motorista. `html` do divIcon e o que o Leaflet injeta no DOM.
export function vehicleMarkerHtml(v, t = {}) {
  const label = motionLabel(v, t);
  const nome = escHtml(v.driverName || '—');
  const badge = label ? `<span style="display:block;font-size:9px;line-height:1.1;margin-top:1px">${escHtml(label)}</span>` : '';
  return `<div style="display:flex;flex-direction:column;align-items:center">`
    + `<span style="font-size:20px;line-height:1">&#128663;</span>`
    + `<span style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 10px/1.2 sans-serif;background:#083b2a;color:#fff;border-radius:6px;padding:1px 5px;margin-top:2px">${nome}</span>`
    + `${badge}</div>`;
}

// Popup do marcador. `agoText` ja vem pronto do timeAgo da pagina: repetir o
// calculo aqui criaria duas copias do mesmo texto para divergirem com o tempo.
export function vehiclePopupHtml(v, t = {}, agoText = '') {
  const linhas = [];
  if (v.speedKmh !== null && v.speedKmh !== undefined && Number.isFinite(Number(v.speedKmh))) {
    linhas.push(escHtml(`${Number(v.speedKmh)} km/h`));
  }
  if (v.distanceKm !== null && v.distanceKm !== undefined && Number.isFinite(Number(v.distanceKm))) {
    linhas.push(escHtml(`${Number(v.distanceKm).toFixed(1)} km`));
  }
  if (v.shuttleId) linhas.push(escHtml(t.vehicleShuttle ?? 'no serviço'));
  const quando = (t.vehicleUpdated ?? 'atualizado {time}').replace('{time}', escHtml(agoText || ''));
  return `<div><strong>${escHtml(v.driverName || '—')}</strong>`
    + `<div style="font-size:12px">${linhas.join(' · ')}</div>`
    + `<div style="font-size:11px;color:#64748b">${escHtml(quando)}</div></div>`;
}