// =====================================================================
// Foco Elite — moedas do aluno
//
//   loadCoins()              relê GET /api/coins e guarda em store.coins ('coins:updated')
//   coinCost(n)              chip "🪙 n" para os botões das ações que gastam moedas
//   costFor('practice')      custo de uma ação em moedas (0 = não paga)
//   simuladoCost(questões)   custo de um simulado pelo número de questões
//   handleCoinError(err)     abre o aviso de moedas (ou cota do Tutor) esgotadas → true
//   aiActionBlock(status)    o que impede corrigir/gerar tema com IA (null = nada)
//
// Cada nível de plano recebe moedas por dia e cada ação que chama a IA custa
// algumas. Os números vêm do servidor (configurações do painel), nunca daqui.
// Quem não gasta moeda — plano antigo, cortesia da equipe, acesso aberto —
// recebe unlimited: true, e para essa pessoa nenhum custo aparece na tela:
// mostrar "20 moedas" a quem não paga nada só confundiria.
//
// Depois de toda ação que cobra, dando certo ou não, a tela chama loadCoins()
// para o chip do topo nunca mostrar um saldo que já mudou (a moeda de uma
// correção que falhou volta no servidor, longe da requisição).
// =====================================================================
import { api } from './api.js';
import { store } from './store.js';
import { html, modal } from './ui.js';
import { icon } from './icons.js';

const TIER_LABELS = { basico: 'Básico', pro: 'Pro', avancado: 'Avançado' };
const TOP_TIER = 'avancado';

// O shell troca por router.navigate quando o roteador sobe. Até lá (ou fora do
// app), "Ver planos" faz uma navegação comum.
let navigateTo = (path) => location.assign(path);

// Duas releituras podem se cruzar (duas ações seguidas): a resposta mais antiga
// que chegar por último não pode sobrescrever o saldo mais novo.
let requested = 0;
let applied = 0;

/** O shell registra aqui o navegador do roteador, para "Ver planos" não recarregar a página. */
export function setCoinsNavigator(fn) {
  if (typeof fn === 'function') navigateTo = fn;
}

/** Nome do nível para o aluno ("Pro"); vazio para plano sem nível. */
export function tierLabel(tier) {
  return TIER_LABELS[tier] || '';
}

/** O aluno gasta moedas? Falso para quem é ilimitado e enquanto a carteira não chegou. */
export function hasCoinLimit(wallet = store.coins) {
  return Boolean(wallet && !wallet.unlimited && wallet.tier);
}

/** Custo de uma ação (chave de wallet.costs) para este aluno; 0 quando não paga. */
export function costFor(action, wallet = store.coins) {
  if (!hasCoinLimit(wallet) || !wallet.costs) return 0;
  const value = Math.floor(Number(wallet.costs[action]));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Até quantas questões um simulado paga o preço do curto (0 sem carteira). */
export function simuladoShortLimit(wallet = store.coins) {
  if (!wallet || !wallet.costs) return 0;
  const value = Math.floor(Number(wallet.costs.simulado_short_max_questions));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Custo de um simulado. Segue a mesma régua do servidor: até o limite de
 * questões do simulado curto paga o curto, acima disso paga o longo — vale o
 * número de questões, não o formato escolhido.
 */
export function simuladoCost(questionCount, wallet = store.coins) {
  if (!hasCoinLimit(wallet) || !wallet.costs) return 0;
  return costFor(Number(questionCount) <= simuladoShortLimit(wallet) ? 'simulado_short' : 'simulado_long', wallet);
}

/** "1 moeda" / "20 moedas". */
export function coinsText(n) {
  const value = Math.max(0, Math.floor(Number(n) || 0));
  return `${value} ${value === 1 ? 'moeda' : 'moedas'}`;
}

/**
 * Chip de custo para pôr dentro de um botão: <span class="coin-cost">🪙 20</span>.
 * Custo zero (ação grátis ou aluno ilimitado) não desenha nada.
 */
export function coinCost(n) {
  const value = Math.floor(Number(n));
  if (!Number.isFinite(value) || value <= 0) return '';
  return html`<span class="coin-cost" title="Custa ${coinsText(value)}">${icon('coins')}<span aria-hidden="true">${value}</span><span class="sr-only">custa ${coinsText(value)}</span></span>`;
}

/**
 * Relê a carteira do dia. Nunca lança: sem acesso (402), sem rede ou com a
 * sessão caindo, fica valendo o que já estava no store.
 */
export async function loadCoins() {
  requested += 1;
  const mine = requested;
  try {
    const wallet = await api.get('/api/coins', { noRedirect: true });
    if (mine > applied) {
      applied = mine;
      store.setCoins(wallet);
    }
    return wallet;
  } catch {
    return store.coins;
  }
}

/** O erro é de moedas do dia ou da cota do Tutor esgotadas? */
export function isCoinError(err) {
  return Boolean(err && (err.code === 'insufficient_coins' || err.code === 'tutor_quota_reached'));
}

/**
 * O que impede as ações de IA pagas em moedas (corrigir redação, gerar tema),
 * lido do GET /api/tutor/status: 'not_configured', 'monthly_limit' ou null.
 *
 * A cota do Tutor do nível não impede nada aqui — essas ações são limitadas
 * pelas moedas, e é por isso que o `available` do status não serve. Já a cota
 * mensal geral, de quem não gasta moedas (plano antigo, cortesia), vale para
 * todas as ações: sem barrar antes, a redação saía do rascunho, a correção
 * falhava no servidor e o texto não podia mais ser editado até o mês virar.
 */
export function aiActionBlock(status) {
  if (!status || !status.configured) return 'not_configured';
  if (status.limit_reached && !status.tutor_quota_reached) return 'monthly_limit';
  return null;
}

function upgradeLine(tier) {
  if (tier === TOP_TIER) return 'Você já está no nível com mais moedas por dia.';
  return 'Nos planos acima do seu, você recebe mais moedas por dia e mais tempo de Tutor IA.';
}

function coinsBody(details) {
  const wallet = store.coins || {};
  const balance = Number.isFinite(Number(details.balance)) ? Math.max(0, Number(details.balance)) : Number(wallet.balance) || 0;
  const cost = Number(details.cost) > 0 ? Number(details.cost) : 0;
  const daily = Number(details.daily) > 0 ? Number(details.daily) : Number(wallet.daily) || 0;
  const tier = details.tier || wallet.tier || null;
  const label = tierLabel(tier);
  return html`
    <div class="coin-alert">
      ${cost
        ? html`
          <div class="coin-alert-figures">
            <div class="coin-alert-figure">
              <span>Seu saldo hoje</span>
              <strong>${icon('coins')}${balance}</strong>
            </div>
            <div class="coin-alert-figure">
              <span>Esta ação custa</span>
              <strong>${icon('coins')}${cost}</strong>
            </div>
          </div>`
        : ''}
      <p class="coin-alert-text">
        ${daily
          ? `As ${daily} moedas do seu plano${label ? ` ${label}` : ''} voltam à meia-noite.`
          : 'Suas moedas voltam à meia-noite.'}
      </p>
      <p class="coin-alert-text">${upgradeLine(tier)}</p>
    </div>`;
}

function tutorBody() {
  const tier = (store.coins && store.coins.tier) || null;
  return html`
    <div class="coin-alert">
      <p class="coin-alert-text">
        Você usou toda a cota do Tutor IA do seu plano neste mês. Ela renova no dia 1º do próximo mês.
        Suas conversas continuam salvas para consulta.
      </p>
      <p class="coin-alert-text">
        ${tier === TOP_TIER
          ? 'Você já está no nível com mais tempo de Tutor IA.'
          : 'Nos planos acima do seu, o Tutor IA tem mais tempo por mês.'}
      </p>
    </div>`;
}

/**
 * Trata o erro de moedas: abre o aviso com saldo, custo e quando renova, e o
 * caminho para os planos. Devolve false para qualquer outro erro — aí quem
 * chamou mostra o erro do jeito de sempre.
 */
export function handleCoinError(err) {
  if (!isCoinError(err)) return false;
  const tutor = err.code === 'tutor_quota_reached';
  const details = err.details && typeof err.details === 'object' ? err.details : {};
  modal({
    title: tutor ? 'A cota do Tutor IA deste mês acabou' : 'Suas moedas de hoje acabaram',
    body: tutor ? tutorBody() : coinsBody(details),
    size: 'sm',
    className: 'coin-modal',
    actions: [
      { label: 'Fechar', variant: 'ghost' },
      {
        label: 'Ver planos',
        variant: 'primary',
        icon: 'arrow-up-right',
        onClick: () => {
          navigateTo('/app/assinatura');
        },
      },
    ],
  });
  loadCoins();
  return true;
}
