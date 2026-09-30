// =====================================================================
// Foco de Elite - landing institucional
// Navegacao fixa, planos reais e movimento suave dos blocos.
// =====================================================================
import { api } from './core/api.js';
import { html, render, qs, qsa, tabs } from './core/ui.js';
import { icon } from './core/icons.js';
import { fmtMoney, intervalLabel } from './core/format.js';

function initNav() {
  const nav = qs('#nav');
  const toggle = qs('#nav-toggle');
  const links = qs('#nav-links');
  if (!nav) return;

  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  if (!toggle || !links) return;
  const setOpen = (open) => {
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
    render(toggle, icon(open ? 'x' : 'menu'));
  };

  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
  links.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('open')) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (nav.classList.contains('open') && event.target instanceof Element && !nav.contains(event.target)) setOpen(false);
  });
}

function initScrollMotion() {
  const progress = qs('#scroll-progress');
  const links = qsa('.nav-links > a[href^="#"]');
  const sections = links
    .map((link) => ({ link, section: qs(link.getAttribute('href')) }))
    .filter((item) => item.section);
  let frame = 0;

  const update = () => {
    const max = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    const ratio = Math.min(Math.max(window.scrollY / max, 0), 1);
    if (progress) progress.style.transform = `scaleX(${ratio})`;

    const marker = Math.min(window.innerHeight * 0.3, 220);
    let current = '';
    sections.forEach(({ section }) => {
      if (!section.hidden && section.getBoundingClientRect().top <= marker) current = section.id;
    });
    sections.forEach(({ link, section }) => {
      const active = section.id === current;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    frame = 0;
  };

  const requestUpdate = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };
  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate);
  window.addEventListener('landing:layout', requestUpdate);
  update();
}

function initHeroMotion() {
  const hero = qs('.hero');
  const media = qs('.hero-media-wrap');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
  if (!hero || !media || reduce || !finePointer) return;

  let frame = 0;
  const move = (event) => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      const rect = hero.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width - 0.5) * -10;
      const y = ((event.clientY - rect.top) / rect.height - 0.5) * -8;
      media.style.setProperty('--hero-x', `${x}px`);
      media.style.setProperty('--hero-y', `${y}px`);
    });
  };
  const reset = () => {
    media.style.setProperty('--hero-x', '0px');
    media.style.setProperty('--hero-y', '0px');
  };
  hero.addEventListener('pointermove', move, { passive: true });
  hero.addEventListener('pointerleave', reset);
}

const SOCIAL_NAMES = [
  'Ana Clara', 'João Pedro', 'Mariana', 'Lucas', 'Beatriz', 'Rafael', 'Gabriela', 'Pedro Henrique', 'Camila', 'Gustavo',
  'Larissa', 'Matheus', 'Isabela', 'Felipe', 'Amanda', 'Bruno', 'Julia', 'Caio', 'Letícia', 'Vinícius',
  'Bianca', 'Thiago', 'Sofia', 'Eduardo', 'Manuela', 'Henrique', 'Carolina', 'Vitor', 'Lívia', 'Daniel',
  'Fernanda', 'Arthur', 'Nicole', 'Leonardo', 'Yasmin', 'Murilo', 'Helena', 'Davi', 'Luana', 'Samuel',
  'Clara', 'Miguel', 'Rebeca', 'Enzo', 'Laura', 'Diego', 'Maria Eduarda', 'André', 'Valentina', 'Cauã'
];

const SOCIAL_COMMENTS = [
  'Gostei muito da organização das aulas.',
  'O cronograma deixou tudo mais claro.',
  'Agora sei exatamente o que estudar.',
  'As questões ajudam demais na revisão.',
  'A plataforma é bem fácil de acompanhar.',
  'Curti os simulados e o acompanhamento.',
  'Meu estudo ficou mais constante.',
  'Os resumos são diretos e ajudam muito.',
  'A rotina ficou bem mais leve.',
  'Finalmente parei de estudar perdido.'
];

function socialWhen(index) {
  const hours = (index * 7) % 72 + 1;
  if (hours < 24) return hours === 1 ? 'há 1 hora' : `há ${hours} horas`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'ontem' : `há ${days} dias`;
}

function buildSocialProofItems() {
  const items = [];
  SOCIAL_NAMES.forEach((name, nameIndex) => {
    SOCIAL_COMMENTS.forEach((comment, commentIndex) => {
      const index = nameIndex * SOCIAL_COMMENTS.length + commentIndex;
      items.push({
        name,
        comment,
        when: socialWhen(index),
        exam: ['ENEM', 'Barro Branco', 'Vestibulares'][index % 3]
      });
    });
  });

  return items
    .map((item, index) => ({ item, sort: (index * 37 + 17) % items.length }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ item }) => item);
}

function socialProofCard(item) {
  return html`
    <article class="social-proof-card">
      <p><strong>${item.name}</strong> começou ${item.when} <span>· ${item.exam}</span></p>
      <q>${item.comment}</q>
    </article>`;
}

function initSocialProof() {
  const box = qs('#social-proof');
  if (!box) return;
  const items = buildSocialProofItems();
  const visible = 4;
  render(box, html`
    <div class="social-proof-head">
      <span>Movimento da comunidade</span>
      <strong>${items.length}+ comentários recentes</strong>
    </div>
    <div class="social-proof-viewport">
      <div class="social-proof-stack" aria-live="polite"></div>
    </div>`);

  const stack = qs('.social-proof-stack', box);
  if (!stack) return;

  let index = 0;
  let paused = false;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const show = () => {
    const next = Array.from({ length: visible }, (_, offset) => items[(index + offset) % items.length]);
    render(stack, next.map(socialProofCard));
  };

  show();
  if (reduce) return;

  const timer = window.setInterval(() => {
    if (paused) return;
    index = (index + 1) % items.length;
    stack.classList.add('swap');
    window.setTimeout(() => {
      show();
      stack.classList.remove('swap');
    }, 260);
  }, 5200);

  box.addEventListener('mouseenter', () => { paused = true; });
  box.addEventListener('mouseleave', () => { paused = false; });
  box.addEventListener('focusin', () => { paused = true; });
  box.addEventListener('focusout', () => { paused = false; });
  window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
}

function normalizePlans(data) {
  const list = Array.isArray(data)
    ? data
    : data && Array.isArray(data.items)
      ? data.items
      : data && Array.isArray(data.plans)
        ? data.plans
        : [];
  return list.filter((plan) => plan && plan.active !== false && Number(plan.price_cents) >= 0);
}

function compactFeature(value) {
  const feature = String(value).trim();
  const labels = [
    [/cronograma/i, 'Cronograma + revisões'],
    [/aulas.*resumos.*questões/i, 'Aulas, resumos e questões'],
    [/simulados/i, 'Simulados personalizados'],
    [/correção.*redação|redação.*ia/i, 'Redação com IA'],
    [/tudo.*mensal/i, 'Tudo do plano Mensal'],
    [/economia.*20%/i, '20% de economia'],
    [/acesso garantido|dia da prova/i, 'Acesso até a prova'],
    [/aulas particulares/i, 'Aulas particulares prioritárias'],
    [/pagamento único/i, 'Pagamento único']
  ];
  return labels.find(([pattern]) => pattern.test(feature))?.[1] || feature;
}

function planCard(plan) {
  const count = Number(plan.interval_count) || 1;
  const billedMonths = plan.interval === 'year' ? 12 * count : count;
  const accessMonths = Number(plan.access_months) || billedMonths + (Number(plan.bonus_months) || 0);
  const period = accessMonths > billedMonths ? `${accessMonths} meses` : intervalLabel(plan.interval, count);
  const monthlyFromApi = Number(plan.monthly_equivalent_cents);
  const monthly = monthlyFromApi > 0
    ? monthlyFromApi
    : accessMonths > 1
      ? Math.round(Number(plan.price_cents) / accessMonths)
      : null;
  const features = Array.isArray(plan.features)
    ? plan.features.filter((feature) => typeof feature === 'string' && feature.trim()).slice(0, 3).map(compactFeature)
    : [];
  const trial = Number(plan.trial_days) > 0 ? plan.trial_days : 0;
  const slug = plan.slug || plan.id || '';
  const badge = String(plan.badge || '').trim() || (plan.highlight ? 'Melhor oferta' : '');
  // preço cheio riscado, só quando for maior que o preço cobrado
  const compare = Number(plan.compare_price_cents) || 0;
  const showCompare = compare > Number(plan.price_cents);
  // parcelamento: divide o preço pelo número de cobranças do ciclo (6x, 12x)
  const parcelas = plan.interval === 'year' ? 12 * count : count;
  const installment = parcelas > 1 ? Math.round(Number(plan.price_cents) / parcelas) : null;
  // moedas por dia do nível: o número vem das configurações, pela API
  const dailyCoins = Number(plan.daily_coins) > 0 ? Number(plan.daily_coins) : 0;

  return html`
    <article class="plan ${plan.highlight ? 'highlight' : ''}" ${plan.tier ? html`id="plano-${plan.tier}"` : ''}>
      ${badge ? html`<span class="badge badge-blue plan-flag">${badge}</span>` : ''}
      <div class="plan-name">${plan.name}</div>
      ${showCompare ? html`<div class="plan-compare">de <s>${fmtMoney(compare)}</s> por</div>` : ''}
      <div class="plan-price">
        <span class="amount">${fmtMoney(plan.price_cents)}</span>
        <span class="period">por ${period}</span>
      </div>
      ${installment ? html`<div class="plan-installment">ou ${parcelas}x de ${fmtMoney(installment)}</div>` : ''}
      ${monthly ? html`<div class="plan-equiv">Equivale a ${fmtMoney(monthly)} por mês</div>` : ''}
      ${trial ? html`<div class="plan-equiv">24h grátis com cartão</div>` : ''}
      ${dailyCoins ? html`<div class="plan-coins">${icon('coins')}<span>${dailyCoins} moedas por dia</span></div>` : ''}
      ${features.length
        ? html`<ul class="plan-features">${features.map((feature) => html`<li>${icon('check')}<span>${feature}</span></li>`)}</ul>`
        : html`<div class="plan-features"></div>`}
      <a class="btn ${plan.highlight ? 'btn-primary' : 'btn-secondary'} btn-lg" href="/cadastro?plan=${encodeURIComponent(slug)}">Escolher ${plan.name}</a>
    </article>`;
}

// Planos por nível: um cartão de cada nível para a duração escolhida no
// seletor. Plano sem nível (os antigos) não entra aqui; se a API só tiver
// planos sem nível, a grade volta a ser um cartão por plano, como antes.
const TIER_ORDER = ['basico', 'pro', 'avancado'];

function durationLabel(months) {
  return months === 1 ? 'Mensal' : `${months} meses`;
}

function renderTierCards(grid, plans, months) {
  const cards = plans
    .filter((plan) => (Number(plan.duration_months) || 1) === months)
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
  render(grid, cards.map(planCard));
  observeReveal(qsa('.plan', grid));
  window.dispatchEvent(new Event('landing:layout'));
}

function initTierPlans(grid, plans) {
  const months = [...new Set(plans.map((plan) => Number(plan.duration_months) || 1))].sort((a, b) => a - b);
  // 12 meses abre selecionado: é o de menor valor por mês
  const initial = months.includes(12) ? 12 : months[months.length - 1];
  const box = qs('#plans-durations');
  if (box && months.length > 1) {
    tabs(
      box,
      months.map((value) => ({ id: String(value), label: durationLabel(value) })),
      (id) => renderTierCards(grid, plans, Number(id)),
      { active: String(initial), pills: true }
    );
    qs('.tabs', box)?.setAttribute('aria-label', 'Duração do plano');
    box.hidden = false;
  }
  renderTierCards(grid, plans, initial);
}

// Faixa de contagem regressiva até o ENEM (data cadastrada no painel, em
// Provas). Só aparece com data futura e com o Avançado na vitrine, porque o
// texto aponta para ele.
function initCountdown(data) {
  const box = qs('#plans-countdown');
  const countdown = data && data.countdown;
  const days = countdown ? Number(countdown.days_left) : 0;
  if (!box || !(days > 0)) return;
  const exam = countdown.exam_short_name || 'ENEM';
  render(box, html`
    <p class="plans-countdown-days">${icon('hourglass')}<span>${days === 1 ? 'Falta' : 'Faltam'} <strong>${days}</strong> ${days === 1 ? 'dia' : 'dias'} para o ${exam}</span></p>
    <p class="plans-countdown-text">
      Com pouco tempo, cada dia de treino conta: o Avançado te dá o máximo de moedas por dia.
      <a href="#plano-avancado">Ver o Avançado</a>
    </p>`);
  box.hidden = false;
  window.dispatchEvent(new Event('landing:layout'));
}

async function initPlans() {
  const section = qs('#planos');
  const grid = qs('#plans-grid');
  if (!section || !grid) return;

  let plans = [];
  try {
    const data = await api.get('/api/billing/plans', { noRedirect: true, timeout: 8000 });
    plans = normalizePlans(data);
  } catch (error) {
    console.info('[landing] planos indisponíveis no momento', error && error.message);
  }

  if (!plans.length) {
    section.hidden = true;
    qsa('[data-plans-link]').forEach((link) => { link.hidden = true; });
    return;
  }

  const tierPlans = plans.filter((plan) => TIER_ORDER.includes(plan.tier));
  section.hidden = false;
  qsa('[data-plans-link]').forEach((link) => { link.hidden = false; });
  if (tierPlans.length) {
    initTierPlans(grid, tierPlans);
    if (tierPlans.some((plan) => plan.tier === 'avancado')) loadLanding().then(initCountdown);
    return;
  }

  plans.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  render(grid, plans.map(planCard));
  observeReveal(qsa('.plan', grid));
  window.dispatchEvent(new Event('landing:layout'));
}

function resultThumb(url) {
  const source = String(url || '');
  if (!source.includes('/assets/results/posts/') && !source.includes('/assets/results/messages/')) {
    return source;
  }

  return source
    .replace('/results/posts/', '/results/posts/thumbs/')
    .replace('/results/messages/', '/results/messages/thumbs/')
    .replace(/\.png$/i, '.jpg');
}

function resultCard(item, type) {
  const name = item.name || 'Aluno Foco de Elite';
  const role = item.role || item.exam_short_name || 'Resultado real';
  const isPost = type === 'post';
  return html`
    <button class="result-card result-card-${type}" type="button"
      data-media-src="${item.image_url}"
      data-media-alt="Depoimento de ${name}: ${role}"
      aria-label="Abrir depoimento de ${name}">
      <span class="result-card-media">
        <img src="${resultThumb(item.image_url)}" alt="" width="${isPost ? 440 : 340}" height="${isPost ? 550 : 604}" loading="lazy" decoding="async">
        <span class="media-open" aria-hidden="true">${icon('maximize-2')}</span>
      </span>
      <span class="result-card-copy"><strong>${name}</strong><span>${role}</span></span>
    </button>`;
}

function videoCard(item) {
  const name = item.name || 'Aluno Foco de Elite';
  const role = item.role || item.exam_short_name || 'Depoimento';
  return html`
    <button class="result-card result-card-video" type="button"
      data-media-video="${item.video_url}"
      data-media-alt="Depoimento de ${name}: ${role}"
      aria-label="Assistir ao depoimento de ${name}">
      <span class="result-card-media">
        <video src="${item.video_url}" preload="metadata" muted playsinline tabindex="-1"></video>
        <span class="media-open media-play" aria-hidden="true">${icon('play')}</span>
      </span>
      <span class="result-card-copy"><strong>${name}</strong><span>${role}</span></span>
    </button>`;
}

// Uma única leitura de /api/landing, compartilhada por resultados, textos e FAQ.
let landingPayload = null;
async function loadLanding() {
  if (landingPayload) return landingPayload;
  landingPayload = api.get('/api/landing', { noRedirect: true, timeout: 8000 })
    .catch((error) => {
      console.info('[landing] conteúdo indisponível no momento', error && error.message);
      return null;
    });
  return landingPayload;
}

// Aplica um texto do banco a um elemento, só quando o valor existe.
// Preserva o HTML estático (fallback) quando o campo vier vazio.
function applyText(el, value) {
  if (!el) return;
  const text = value == null ? '' : String(value).trim();
  if (text) el.textContent = text;
}

// Onde começa o destaque automático, seguindo o padrão do designer: a última
// frase do título (o que vem depois do último ponto final) e, quando o título é
// uma frase só, a última palavra. Devolve o índice onde o trecho realçado começa.
function highlightStart(text) {
  // última frase: procura um ". " seguido de mais texto
  const sentence = text.match(/\.\s+(?=\S)/g);
  if (sentence) {
    const idx = text.lastIndexOf('. ');
    if (idx >= 0 && idx + 2 < text.length) return idx + 2;
  }
  // frase única: última palavra
  const space = text.replace(/\s+$/, '').lastIndexOf(' ');
  return space >= 0 ? space + 1 : 0;
}

// Título com destaque: nos títulos das seções o designer pinta uma parte com a
// cor de acento (um <span>). O padrão é automático — o final do título ganha a
// cor da seção, como no modelo do designer. Para ajustar à mão, o painel pode
// marcar o trecho com *asteriscos* ("Tudo para *avançar.*"), que tem prioridade.
// Montado via DOM (sem HTML cru).
function applyTitle(el, value) {
  if (!el) return;
  const text = value == null ? '' : String(value).trim();
  if (!text) return;

  el.textContent = '';
  const addText = (t) => t && el.appendChild(document.createTextNode(t));
  const addSpan = (t) => {
    if (!t) return;
    const span = document.createElement('span');
    span.textContent = t;
    el.appendChild(span);
  };

  if (text.includes('*')) {
    // override manual: destaca só o que está entre asteriscos
    text.split(/\*([^*]+)\*/).forEach((seg, i) => (i % 2 === 1 ? addSpan(seg) : addText(seg)));
    return;
  }

  // padrão automático: realça o final do título
  const start = highlightStart(text);
  addText(text.slice(0, start));
  addSpan(text.slice(start));
}

// Textos editáveis dos blocos: só sobrescreve o que o Admin preencheu,
// mantendo estrutura, imagens e destaques do HTML quando o banco está vazio.
function initContent(data) {
  const blocks = data && data.blocks ? data.blocks : null;
  if (!blocks) return;
  qsa('[data-block]').forEach((section) => {
    const block = blocks[section.dataset.block];
    if (!block) return;
    qsa('[data-block-field]', section).forEach((el) => {
      const field = el.dataset.blockField;
      if (field === 'title') applyTitle(el, block.title);
      else applyText(el, block[field]);
    });
  });
}

// "Por dentro da plataforma": grade de telas reais. Clique abre a imagem grande
// no visualizador (o mesmo media-viewer dos depoimentos). Sem imagens, a seção
// e o link do menu ficam ocultos.
function tourCard(shot) {
  const title = shot.title || 'Tela da plataforma';
  const caption = shot.caption || '';
  return html`
    <button class="tour-card reveal" type="button"
      data-media-src="${shot.image_url}"
      data-media-alt="${title}${caption ? ` — ${caption}` : ''}"
      aria-label="Ampliar tela: ${title}">
      <span class="tour-card-media">
        <img src="${shot.image_url}" alt="Tela de ${title} da plataforma" loading="lazy" decoding="async">
        <span class="media-open" aria-hidden="true">${icon('maximize-2')}</span>
      </span>
      <span class="tour-card-copy"><strong>${title}</strong>${caption ? html`<span>${caption}</span>` : ''}</span>
    </button>`;
}

function initTour(data) {
  const section = qs('#por-dentro');
  const grid = qs('#tour-grid');
  const shots = data && Array.isArray(data.platform_tour) ? data.platform_tour : [];
  if (!section || !grid) return;
  if (!shots.length) {
    section.hidden = true;
    qsa('[data-tour-link]').forEach((link) => { link.hidden = true; });
    return;
  }
  render(grid, shots.map(tourCard));
  section.hidden = false;
  qsa('[data-tour-link]').forEach((link) => { link.hidden = false; });
  observeReveal(qsa('.tour-card', grid));
  window.dispatchEvent(new Event('landing:layout'));
}

// Perguntas frequentes: quando o banco traz ao menos uma, a lista inteira
// passa a vir dele; sem nenhuma, o HTML estático permanece.
function initFaqs(data) {
  const list = qs('#faq-list');
  const faqs = data && Array.isArray(data.faqs) ? data.faqs : [];
  if (!list || !faqs.length) return;
  render(list, faqs.map((faq) => html`
    <details class="faq-item">
      <summary><span>${faq.question}</span>${icon('plus')}</summary>
      <div class="faq-answer">${String(faq.answer || '').split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}</div>
    </details>`));
}

// Avisos de atividade real (compras pagas e upgrades aplicados), vindos de
// /api/landing: um por vez num balão no canto, no máximo 8 por visita, cada
// um uma vez só. Sem avisos, ou fechado nesta sessão, nada entra na página.
const ACTIVITY_CLOSED_KEY = 'fe-activity-closed';
const ACTIVITY_FIRST_MS = 8000;
const ACTIVITY_STEP_MS = 9000;
const ACTIVITY_MAX = 8;

function activityClosed() {
  try {
    return window.sessionStorage.getItem(ACTIVITY_CLOSED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberActivityClosed() {
  try {
    window.sessionStorage.setItem(ACTIVITY_CLOSED_KEY, '1');
  } catch {
    /* sem armazenamento, o balão fecha só nesta página */
  }
}

// A API manda a hora cheia; aqui vira "há 2 horas", "ontem", "há 3 dias".
// Passadas 24 horas, conta o dia do calendário de quem está vendo: compra na
// segunda às 20h vista na quarta de manhã foi anteontem, não "ontem".
function activityWhen(iso, now = Date.now()) {
  const at = new Date(iso);
  const hours = Math.floor((now - at.getTime()) / 3600000);
  if (hours < 1) return 'há menos de 1 hora';
  if (hours < 24) return hours === 1 ? 'há 1 hora' : `há ${hours} horas`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  at.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - at.getTime()) / 86400000);
  return days <= 1 ? 'ontem' : `há ${days} dias`;
}

// Artigo de cada prova na frase: "para o ENEM", "para a FUVEST". Prova que não
// está aqui (cadastrada depois pelo painel) sai sem artigo, como no resto da
// plataforma ("Data prevista para UFRJ"): seco, mas nunca no gênero errado.
const EXAM_ARTICLES = {
  ENEM: 'o',
  'BARRO BRANCO': 'o',
  MACKENZIE: 'o',
  FUVEST: 'a',
  UNICAMP: 'a',
  UNESP: 'a',
  FGV: 'a',
  'PUC-SP': 'a',
};

function activityExam(shortName) {
  if (!shortName) return '';
  const article = EXAM_ARTICLES[String(shortName).trim().toUpperCase()];
  return `, que estuda para ${article ? `${article} ` : ''}${shortName},`;
}

function activityLine(item, brand) {
  const exam = activityExam(item.exam_short_name);
  const action = item.kind === 'upgraded'
    ? `subiu para o ${item.tier_label}`
    : item.tier_label ? `assinou o ${item.tier_label}` : `assinou a ${brand}`;
  return html`<strong>${item.first_name}</strong>${exam} ${action} <span class="activity-toast-when">· ${activityWhen(item.at)}</span>`;
}

function initActivity(data) {
  const brand = (data && data.brand && data.brand.name) || 'plataforma';
  const items = (data && Array.isArray(data.activity) ? data.activity : [])
    .filter((item) => item && item.first_name && Number.isFinite(new Date(item.at).getTime()))
    .filter((item) => item.kind !== 'upgraded' || item.tier_label)
    .slice(0, ACTIVITY_MAX);
  if (!items.length || activityClosed()) return;

  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let box = null;
  let text = null;
  let index = 0;
  let timer = 0;
  let remaining = ACTIVITY_STEP_MS;
  let startedAt = 0;
  const pauses = new Set();

  const schedule = (ms) => {
    window.clearTimeout(timer);
    remaining = ms;
    startedAt = Date.now();
    if (!pauses.size) timer = window.setTimeout(next, ms);
  };
  const pause = (reason) => {
    if (!pauses.size) {
      window.clearTimeout(timer);
      remaining = Math.max(1000, remaining - (Date.now() - startedAt));
    }
    pauses.add(reason);
  };
  const resume = (reason) => {
    if (!pauses.delete(reason) || pauses.size) return;
    schedule(remaining);
  };
  const onVisibility = () => (document.hidden ? pause('hidden') : resume('hidden'));

  const close = () => {
    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    if (!box) return;
    const el = box;
    box = null;
    el.classList.remove('in');
    window.setTimeout(() => el.remove(), reduce ? 0 : 300);
  };

  const show = (item) => {
    if (reduce || !text.childNodes.length) {
      render(text, activityLine(item, brand));
      return;
    }
    text.classList.add('swap');
    window.setTimeout(() => {
      if (!box) return;
      render(text, activityLine(item, brand));
      text.classList.remove('swap');
    }, 200);
  };

  function next() {
    if (!box) return;
    if (index >= items.length) {
      close();
      return;
    }
    show(items[index]);
    index += 1;
    schedule(ACTIVITY_STEP_MS);
  }

  const start = () => {
    if (activityClosed()) return;
    box = document.createElement('div');
    box.className = 'activity-toast';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    render(box, html`
      <span class="activity-toast-icon" aria-hidden="true">${icon('badge-check')}</span>
      <p class="activity-toast-text"></p>
      <button class="activity-toast-close" type="button" aria-label="Fechar avisos" title="Fechar">${icon('x')}</button>`);
    text = qs('.activity-toast-text', box);
    qs('.activity-toast-close', box).addEventListener('click', () => {
      rememberActivityClosed();
      close();
    });
    box.addEventListener('mouseenter', () => pause('hover'));
    box.addEventListener('mouseleave', () => resume('hover'));
    box.addEventListener('focusin', () => pause('focus'));
    box.addEventListener('focusout', (event) => {
      if (!(event.relatedTarget instanceof Node) || !box || !box.contains(event.relatedTarget)) resume('focus');
    });
    document.addEventListener('visibilitychange', onVisibility);
    document.body.appendChild(box);
    // o texto entra depois do balão, para o leitor de tela anunciar o aviso
    window.requestAnimationFrame(() => {
      if (!box) return;
      box.classList.add('in');
      next();
    });
  };

  // ~8s depois de a página abrir, contando o tempo que a API levou
  const elapsed = window.performance && typeof window.performance.now === 'function' ? window.performance.now() : 0;
  window.setTimeout(start, Math.max(0, ACTIVITY_FIRST_MS - elapsed));
}

async function initResults() {
  const section = qs('#resultados');
  const postsEl = qs('#results-posts');
  const messagesEl = qs('#results-messages');
  const videosEl = qs('#results-videos');
  if (!section || !postsEl || !messagesEl) return;

  const data = await loadLanding();
  const testimonials = Array.isArray(data && data.testimonials) ? data.testimonials : [];

  const withImage = testimonials.filter((item) => item && item.image_url);
  const videos = testimonials.filter((item) => item && item.video_url);
  const posts = withImage.filter((item) => item.image_url.includes('/results/posts/'));
  const messages = withImage.filter((item) => !item.image_url.includes('/results/posts/'));
  if (!posts.length && !messages.length && !videos.length) {
    section.hidden = true;
    qsa('a[href="#resultados"]').forEach((link) => { link.hidden = true; });
    return;
  }

  render(postsEl, posts.map((item) => resultCard(item, 'post')));
  render(messagesEl, messages.map((item) => resultCard(item, 'message')));
  if (videosEl) render(videosEl, videos.map((item) => videoCard(item)));
  if (!posts.length) postsEl.closest('.results-block').hidden = true;
  if (!messages.length) messagesEl.closest('.results-block').hidden = true;
  const videosBlock = qs('#results-videos-block');
  if (videosBlock) videosBlock.hidden = !videos.length;

  const step = () => Math.min(messagesEl.clientWidth * 0.78, 760);
  qs('[data-results-prev]')?.addEventListener('click', () => messagesEl.scrollBy({ left: -step(), behavior: 'smooth' }));
  qs('[data-results-next]')?.addEventListener('click', () => messagesEl.scrollBy({ left: step(), behavior: 'smooth' }));
  window.dispatchEvent(new Event('landing:layout'));
}

function initMediaViewer() {
  const dialog = qs('#media-viewer');
  const image = qs('#media-viewer-image');
  const video = qs('#media-viewer-video');
  const caption = qs('#media-viewer-caption');
  if (!dialog || !image || !caption) return;

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest('[data-media-src], [data-media-video]');
    if (!trigger) return;
    const alt = trigger.dataset.mediaAlt || 'Depoimento Foco de Elite';
    const videoSrc = trigger.dataset.mediaVideo;

    if (videoSrc && video) {
      image.hidden = true;
      image.removeAttribute('src');
      video.hidden = false;
      video.src = videoSrc;
      video.currentTime = 0;
    } else {
      if (video) { video.hidden = true; video.removeAttribute('src'); }
      image.hidden = false;
      image.src = trigger.dataset.mediaSrc;
      image.alt = alt;
    }
    caption.textContent = alt;
    dialog.showModal();
    if (videoSrc && video) video.play().catch(() => {});
  });

  qs('[data-media-close]', dialog)?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    image.removeAttribute('src');
    image.alt = '';
    if (video) { video.pause(); video.removeAttribute('src'); video.hidden = true; }
    image.hidden = false;
    caption.textContent = '';
  });
}

let observer = null;

function observeReveal(elements) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) {
    elements.forEach((element) => element.classList.add('in'));
    return;
  }

  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.1 }
    );
  }

  elements.forEach((element, index) => {
    element.classList.add('reveal');
    element.style.transitionDelay = `${Math.min(index % 6, 5) * 50}ms`;
    observer.observe(element);
  });
}

function initYear() {
  qsa('[data-year]').forEach((element) => {
    element.textContent = String(new Date().getFullYear());
  });
}

document.documentElement.classList.add('js');
initNav();
initScrollMotion();
initHeroMotion();
initSocialProof();
initMediaViewer();
initYear();
observeReveal(qsa('.reveal'));
initPlans();
initResults();
loadLanding().then((data) => {
  initContent(data);
  initTour(data);
  initFaqs(data);
  initActivity(data);
});
