// =====================================================================
// Foco de Elite - landing institucional
// Navegacao fixa, planos reais e movimento suave dos blocos.
// =====================================================================
import { api } from './core/api.js';
import { html, render, qs, qsa, tabs } from './core/ui.js';
import { icon } from './core/icons.js';
import { fmtMoney, fmtNumber, fmtScore, intervalLabel } from './core/format.js';
import { tierLabel } from './core/coins.js';
import { captureTracking } from './core/tracking.js';
import { initMetaPixel, trackLead, trackWhatsApp } from './core/meta-pixel.js';

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
    // a seção atual é a que começou mais perto acima do marcador, e não a última
    // na ordem do menu: o menu lista Plataforma antes de Por dentro, e a página
    // mostra Por dentro primeiro.
    let current = '';
    let best = -Infinity;
    sections.forEach(({ section }) => {
      if (section.hidden) return;
      const top = section.getBoundingClientRect().top;
      if (top <= marker && top > best) {
        best = top;
        current = section.id;
      }
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

// Comentários de alunos no topo: os depoimentos só em texto cadastrados no
// painel (os que têm foto ou vídeo vão para a seção de resultados), com o nome
// e as palavras de quem escreveu. A faixa corre devagar e sem parar, passando
// por todos, e pausa com o mouse ou o foco em cima; para quem prefere menos
// movimento, fica parada e rola na mão.
// 60 px por segundo é 1 px por quadro a 60 Hz — 2 px de tela num retina, 3 num
// celular 3x. Com o passo inteiro o texto anda liso; a velocidade antiga (uns
// 40 px/s) dava 1,33 px de tela por quadro, e o passo desigual tremia.
const SOCIAL_SPEED_PX_PER_S = 60;

function socialProofCard(item) {
  return html`
    <article class="social-proof-card">
      <p><strong>${item.name}</strong>${item.exam_short_name ? html` <span>· ${item.exam_short_name}</span>` : ''}</p>
      <q>${item.content}</q>
    </article>`;
}

function initSocialProof(data) {
  const box = qs('#social-proof');
  if (!box) return;
  const comments = (data && Array.isArray(data.testimonials) ? data.testimonials : [])
    .filter((item) => item && item.name && item.content && !item.image_url && !item.video_url);
  if (!comments.length) {
    box.hidden = true;
    return;
  }

  // Cada visita começa num ponto diferente da lista, para quem volta à página
  // não ler sempre os mesmos primeiro.
  const offset = Math.floor(Math.random() * comments.length);
  const items = comments.slice(offset).concat(comments.slice(0, offset));
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  render(box, html`
    <div class="social-proof-head">
      <span>O que os alunos estão dizendo</span>
      <strong>${items.length} ${items.length === 1 ? 'comentário' : 'comentários'}</strong>
    </div>
    <div class="social-proof-viewport${reduce ? ' is-static' : ''}">
      <div class="social-proof-track">
        <div class="social-proof-group">${items.map(socialProofCard)}</div>
        ${reduce ? '' : html`<div class="social-proof-group" aria-hidden="true">${items.map(socialProofCard)}</div>`}
      </div>
    </div>`);
  box.hidden = false;

  if (!reduce) startSocialProofScroll(box);
}

// A faixa tem duas cópias lado a lado e anda exatamente a largura de uma
// cópia: quando a primeira some, a segunda está no mesmo lugar e o giro não
// dá salto. A animação roda no compositor (transform), fora da thread da
// página, e a duração sai da largura medida, para a velocidade ser sempre a
// mesma em qualquer tela; se a largura dos cartões muda (girar o celular,
// redimensionar a janela), a faixa recalcula sem pular de posição.
function startSocialProofScroll(box) {
  const track = qs('.social-proof-track', box);
  const group = qs('.social-proof-group', box);
  const viewport = qs('.social-proof-viewport', box);
  if (!track || !group || !viewport || typeof track.animate !== 'function') return;

  let animation = null;
  const setup = () => {
    const distance = Math.round(group.getBoundingClientRect().width);
    if (!distance) return;
    const duration = (distance / SOCIAL_SPEED_PX_PER_S) * 1000;
    const frames = [{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${-distance}px, 0, 0)` }];
    if (!animation) {
      animation = track.animate(frames, { duration, iterations: Infinity, easing: 'linear' });
      return;
    }
    const before = Number(animation.effect.getTiming().duration) || duration;
    const progress = ((Number(animation.currentTime) || 0) % before) / before;
    animation.effect.setKeyframes(frames);
    animation.effect.updateTiming({ duration });
    animation.currentTime = progress * duration;
  };
  setup();
  if ('ResizeObserver' in window) new ResizeObserver(setup).observe(group);

  // pausa para ler: mouse em cima ou foco dentro da faixa
  const pause = () => animation && animation.pause();
  const play = () => animation && animation.play();
  viewport.addEventListener('mouseenter', pause);
  viewport.addEventListener('mouseleave', play);
  viewport.addEventListener('focusin', pause);
  viewport.addEventListener('focusout', play);
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

// Quantas vezes uma ação cabe nas moedas do dia (daily_capacity da API):
// inteiro >= 0, ou null quando a ação é grátis ou o dado não veio.
function wholeCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// "2×", "3,3×": uma casa, com vírgula, e sem casa quando dá inteiro. Corta
// para baixo, para a razão nunca passar da real (1,97 sai 1,9×, e não 2×).
function fmtTimes(value) {
  return `${fmtScore(Math.floor(value * 10 + 1e-9) / 10)}×`;
}

// Meses de acesso que uma compra do plano dá (a API manda access_months; sem ele,
// a conta sai do ciclo de cobrança mais os meses de bônus).
function planAccessMonths(plan) {
  const count = Number(plan.interval_count) || 1;
  const billedMonths = plan.interval === 'year' ? 12 * count : count;
  return Number(plan.access_months) || billedMonths + (Number(plan.bonus_months) || 0);
}

// O que as moedas do dia pagam, na ordem em que aparecem no cartão e na tabela.
// São alternativas (até 5 redações OU 3 simulados), nunca uma soma.
const CAPACITY_LINES = [
  { key: 'essay_corrections', one: 'redação corrigida', many: 'redações corrigidas', row: 'Redações corrigidas' },
  { key: 'simulados_long', one: 'simulado completo', many: 'simulados completos', row: 'Simulados completos' },
  { key: 'simulados_short', one: 'simulado curto', many: 'simulados curtos', row: 'Simulados curtos' },
];

function planCapacity(plan) {
  const capacity = plan.daily_capacity && typeof plan.daily_capacity === 'object' ? plan.daily_capacity : null;
  if (!capacity) return '';
  // linha com 0 some; ação grátis (null) também, o cartão só fala do que as moedas limitam
  const lines = CAPACITY_LINES
    .map((line) => ({ ...line, n: wholeCount(capacity[line.key]) }))
    .filter((line) => line.n > 0);
  if (!lines.length) return '';
  return html`
    <div class="plan-capacity">
      <p>Por dia, dá para:</p>
      <ul>${lines.map((line, index) => html`<li>${index ? 'ou' : 'até'} <strong>${fmtNumber(line.n, { digits: 0 })}</strong> ${line.n === 1 ? line.one : line.many}</li>`)}</ul>
    </div>`;
}

function planCard(plan) {
  const count = Number(plan.interval_count) || 1;
  const billedMonths = plan.interval === 'year' ? 12 * count : count;
  const accessMonths = planAccessMonths(plan);
  const period = accessMonths > billedMonths ? `${accessMonths} meses` : intervalLabel(plan.interval, count);
  const monthlyFromApi = Number(plan.monthly_equivalent_cents);
  const monthly = monthlyFromApi > 0
    ? monthlyFromApi
    : accessMonths > 1
      ? Math.round(Number(plan.price_cents) / accessMonths)
      : null;
  // moedas por dia do nível: o número vem das configurações, pela API
  const dailyCoins = Number(plan.daily_coins) > 0 ? Number(plan.daily_coins) : 0;
  // com as moedas e o que elas rendem no cartão, item que só fala de moedas
  // ("Mais moedas por dia") repetiria o que está logo acima
  const features = Array.isArray(plan.features)
    ? plan.features
      .filter((feature) => typeof feature === 'string' && feature.trim())
      .filter((feature) => !(dailyCoins && /moedas/i.test(feature)))
      .slice(0, 3)
      .map(compactFeature)
    : [];
  const trial = Number(plan.trial_days) > 0 ? plan.trial_days : 0;
  // mês de bônus do plano (o de 12 meses dá 1: 13 meses de acesso), do cadastro do plano
  const bonus = Math.max(0, Number(plan.bonus_months) || 0);
  const slug = plan.slug || plan.id || '';
  const badge = String(plan.badge || '').trim() || (plan.highlight ? 'Melhor oferta' : '');
  // preço cheio riscado, só quando for maior que o preço cobrado
  const compare = Number(plan.compare_price_cents) || 0;
  const showCompare = compare > Number(plan.price_cents);
  // "Escolher Avançado 12 meses": a duração fica num trecho à parte, que o
  // tablet em pé esconde para o botão caber numa linha (landing.css)
  const tier = tierLabel(plan.tier);
  const nameTail = tier && String(plan.name).startsWith(tier) ? String(plan.name).slice(tier.length) : '';

  return html`
    <article class="plan ${plan.highlight ? 'highlight' : ''}" ${plan.tier ? html`id="plano-${plan.tier}"` : ''}>
      ${badge ? html`<span class="badge badge-blue plan-flag">${badge}</span>` : ''}
      <div class="plan-name">${plan.name}</div>
      ${showCompare ? html`<div class="plan-compare">de <s>${fmtMoney(compare)}</s> por</div>` : ''}
      <div class="plan-price">
        <span class="amount">${fmtMoney(plan.price_cents)}</span>
        <span class="period">por ${period}</span>
      </div>
      ${monthly ? html`<div class="plan-equiv">Equivale a ${fmtMoney(monthly)} por mês</div>` : ''}
      ${bonus ? html`<div class="plan-equiv">Inclui ${bonus} ${bonus === 1 ? 'mês' : 'meses'} de bônus</div>` : ''}
      ${trial ? html`<div class="plan-equiv">24h grátis com cartão</div>` : ''}
      ${dailyCoins ? html`
        <div class="plan-coins-row">
          <div class="plan-coins">${icon('coins')}<span>${dailyCoins} moedas por dia</span></div>
        </div>
        ${planCapacity(plan)}` : ''}
      ${features.length
        ? html`<ul class="plan-features">${features.map((feature) => html`<li>${icon('check')}<span>${feature}</span></li>`)}</ul>`
        : html`<div class="plan-features"></div>`}
      <a class="btn ${plan.highlight ? 'btn-primary' : 'btn-secondary'} btn-lg" href="/cadastro?plan=${encodeURIComponent(slug)}"><span>Escolher ${nameTail ? html`${tier}<span class="plan-btn-tail">${nameTail}</span>` : plan.name}</span></a>
    </article>`;
}

// Planos por nível: um cartão de cada nível para a duração escolhida no
// seletor. Plano sem nível (os antigos) não entra aqui; se a API só tiver
// planos sem nível, a grade volta a ser um cartão por plano, como antes.
const TIER_ORDER = ['basico', 'pro', 'avancado'];

function durationLabel(months) {
  return months === 1 ? 'Mensal' : `${months} meses`;
}

function tierCardsFor(plans, months) {
  return plans
    .filter((plan) => (Number(plan.duration_months) || 1) === months)
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
}

function renderTierCards(grid, plans, months, onRender) {
  const cards = tierCardsFor(plans, months);
  render(grid, cards.map((plan) => planCard(plan)));
  observeReveal(qsa('.plan', grid));
  onRender();
  window.dispatchEvent(new Event('landing:layout'));
}

// Celular: a grade de planos vira um trilho lateral (landing.css, max-width: 767px).
// Ele abre centrado no plano em destaque, com as pontas dos vizinhos à vista, e
// ganha um ponto por cartão embaixo, que acompanha a rolagem e leva ao cartão
// tocado. No desktop os pontos ficam ocultos pelo CSS e nada disso age.
// Devolve a função que refaz os pontos depois de cada troca de duração.
const PLANS_RAIL_QUERY = '(max-width: 767px)';

function centerPlan(grid, card, behavior = 'auto') {
  const box = grid.getBoundingClientRect();
  const rect = card.getBoundingClientRect();
  grid.scrollTo({ left: grid.scrollLeft + rect.left + rect.width / 2 - (box.left + box.width / 2), behavior });
}

function initPlansRail(grid) {
  const media = window.matchMedia ? window.matchMedia(PLANS_RAIL_QUERY) : null;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dots = document.createElement('div');
  dots.className = 'plans-dots';
  dots.setAttribute('role', 'group');
  dots.setAttribute('aria-label', 'Planos');
  dots.hidden = true;
  grid.after(dots);
  let frame = 0;
  let centered = false;

  // o cartão atual é o que tem o centro mais perto do centro do trilho
  const mark = () => {
    frame = 0;
    const box = grid.getBoundingClientRect();
    const middle = box.left + box.width / 2;
    let current = 0;
    let best = Infinity;
    qsa('.plan', grid).forEach((card, index) => {
      const rect = card.getBoundingClientRect();
      const distance = Math.abs(rect.left + rect.width / 2 - middle);
      if (distance < best) {
        best = distance;
        current = index;
      }
    });
    qsa('.plans-dot', dots).forEach((dot, index) => {
      dot.classList.toggle('active', index === current);
      if (index === current) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
  };

  const centerHighlight = () => {
    if (!media || !media.matches) return;
    const card = qs('.plan.highlight', grid) || qs('.plan', grid);
    if (card) centerPlan(grid, card);
    centered = true;
    mark();
  };

  grid.addEventListener('scroll', () => {
    if (!frame) frame = window.requestAnimationFrame(mark);
  }, { passive: true });
  dots.addEventListener('click', (event) => {
    const dot = event.target instanceof Element ? event.target.closest('.plans-dot') : null;
    const card = dot ? qsa('.plan', grid)[Number(dot.dataset.index)] : null;
    if (card) centerPlan(grid, card, reduce ? 'auto' : 'smooth');
  });
  // quem abre a página no desktop e estreita a janela também chega ao trilho centrado no destaque
  if (media && media.addEventListener) media.addEventListener('change', centerHighlight);

  return () => {
    const cards = qsa('.plan', grid);
    dots.replaceChildren(...cards.map((card, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'plans-dot';
      dot.dataset.index = String(index);
      const name = card.querySelector('.plan-name');
      dot.setAttribute('aria-label', `Ver ${name ? name.textContent.trim() : 'plano'}`);
      return dot;
    }));
    dots.hidden = cards.length < 2;
    // a troca de duração mantém a posição do trilho; só a primeira pintura centraliza
    if (!centered) centerHighlight();
    else mark();
  };
}

// Devolve a duração em tela e o registro de quem precisa refazer junto quando
// ela muda (contagem e comparativo usam os planos da duração escolhida).
function initTierPlans(grid, plans, onRender) {
  const months = [...new Set(plans.map((plan) => Number(plan.duration_months) || 1))].sort((a, b) => a - b);
  // 12 meses abre selecionado: é o de menor valor por mês
  const initial = months.includes(12) ? 12 : months[months.length - 1];
  let current = initial;
  const listeners = [];
  const show = (value) => {
    current = value;
    renderTierCards(grid, plans, value, onRender);
    listeners.forEach((fn) => fn(value));
  };
  const box = qs('#plans-durations');
  if (box && months.length > 1) {
    tabs(
      box,
      months.map((value) => ({ id: String(value), label: durationLabel(value) })),
      (id) => show(Number(id)),
      { active: String(initial), pills: true }
    );
    qs('.tabs', box)?.setAttribute('aria-label', 'Duração do plano');
    box.hidden = false;
  }
  show(initial);
  return {
    months: () => current,
    onChange: (fn) => listeners.push(fn),
  };
}

// Com o ENEM a menos de 90 dias, a contagem e o cartão do Avançado sugerem o
// Avançado. É conselho, não fato.
const SHORT_TIME_DAYS = 90;
const DAY_MS = 86400000;

// "o ENEM", "a FUVEST"; prova sem artigo conhecido sai sem artigo (EXAM_ARTICLES, mais abaixo).
function examWithArticle(shortName) {
  const article = EXAM_ARTICLES[String(shortName).trim().toUpperCase()];
  return article ? `${article} ${shortName}` : String(shortName);
}

// "2026-11-08" → meia-noite UTC desse dia (NaN quando não é data).
function isoDayTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
}

// Soma meses como o servidor soma o acesso (asaas.addMonths): 31/01 + 1 mês = 28/02.
function addMonthsUTC(time, months) {
  const date = new Date(time);
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}

// Uma compra do plano feita hoje ainda vale no dia da prova? "Hoje" é o do
// servidor: a data da prova menos os dias que faltam. Sem data, a resposta é não,
// e o total até a prova não aparece.
function accessCoversExam(plan, countdown) {
  const exam = isoDayTime(countdown && countdown.exam_date);
  const days = countdown ? Number(countdown.days_left) : 0;
  const months = planAccessMonths(plan);
  if (!Number.isFinite(exam) || !(days > 0) || !(months > 0)) return false;
  return addMonthsUTC(exam - days * DAY_MS, months) >= exam;
}

// Com a prova perto e o Avançado na vitrine da duração escolhida.
function recommendsTop(countdown, cards) {
  const days = countdown ? Number(countdown.days_left) : 0;
  return days > 0 && days <= SHORT_TIME_DAYS && cards.some((plan) => plan.tier === 'avancado');
}

// Contagem até o ENEM (data cadastrada no painel, em Provas): uma linha entre o
// título e o seletor. Na reta final, leva o conselho e o link para o Avançado.
function renderCountdown(box, countdown, cards) {
  const days = countdown ? Number(countdown.days_left) : 0;
  if (!(days > 0)) {
    box.hidden = true;
    return;
  }
  const exam = countdown.exam_short_name || 'ENEM';
  render(box, html`
    <p class="plans-countdown-days">${icon('hourglass')}<span>${days === 1 ? 'Falta' : 'Faltam'} <strong>${fmtNumber(days, { digits: 0 })}</strong> ${days === 1 ? 'dia' : 'dias'} para ${examWithArticle(exam)}</span></p>
    ${recommendsTop(countdown, cards)
      ? html`<p class="plans-countdown-text">Na reta final, vale treinar mais por dia. <a href="#plano-avancado">Ver o Avançado</a></p>`
      : ''}`);
  box.hidden = false;
}

// Conselho no próprio cartão do Avançado, ao lado das moedas, na reta final.
// Os cartões são refeitos a cada troca de duração; o conselho volta junto.
function renderTopAdvice(grid, countdown, cards) {
  const card = grid ? qs('#plano-avancado', grid) : null;
  if (!card) return;
  qsa('.plan-advice', card).forEach((el) => el.remove());
  const row = qs('.plan-coins-row', card);
  if (!row || !recommendsTop(countdown, cards)) return;
  const advice = document.createElement('p');
  advice.className = 'plan-advice';
  render(advice, html`${icon('flag')}<span>Recomendado para a reta final</span>`);
  row.appendChild(advice);
}

// Custos que aparecem em "Como funcionam as moedas", todos de coin_costs.
// Só entra a ação que custa alguma coisa.
const COST_CHIPS = [
  { key: 'essay_correction', label: () => 'Correção de redação' },
  {
    key: 'simulado_long',
    label: (costs) => {
      const max = wholeCount(costs.simulado_short_max_questions);
      return max > 0 ? `Simulado com mais de ${fmtNumber(max, { digits: 0 })} questões` : 'Simulado longo';
    },
  },
  {
    key: 'simulado_short',
    label: (costs) => {
      const max = wholeCount(costs.simulado_short_max_questions);
      return max > 0 ? `Simulado curto (até ${fmtNumber(max, { digits: 0 })} questões)` : 'Simulado curto';
    },
  },
  { key: 'questions', label: () => 'Lote de questões da IA' },
  { key: 'essay_theme', label: () => 'Tema de redação da IA' },
  { key: 'practice', label: () => 'Prática da aula com IA' },
];

// Três passos que explicam para que servem as moedas, entre os cartões e a
// tabela. Sem custos na API, o bloco não aparece (sem eles não há o que mostrar
// no passo do meio).
function renderCoinsHow(box, costs) {
  const chips = costs
    ? COST_CHIPS
      .map((chip) => ({ label: chip.label(costs), cost: wholeCount(costs[chip.key]) }))
      .filter((chip) => chip.cost > 0)
    : [];
  if (!chips.length) {
    box.hidden = true;
    return;
  }
  render(box, html`
    <h3 class="plans-how-title">Como funcionam as moedas</h3>
    <ol class="plans-how-steps">
      <li>
        <span class="plans-how-icon">${icon('coins')}</span>
        <div><strong>Moedas todo dia</strong><p>Cada plano recebe moedas por dia. Elas renovam à meia-noite e não acumulam.</p></div>
      </li>
      <li>
        <span class="plans-how-icon">${icon('sparkles')}</span>
        <div>
          <strong>Pagam correções, simulados e o que a IA cria</strong>
          <ul class="plans-how-costs">${chips.map((chip) => html`
            <li>${chip.label} · <b>${icon('coins')}${fmtNumber(chip.cost, { digits: 0 })}<span class="sr-only"> ${chip.cost === 1 ? 'moeda' : 'moedas'}</span></b></li>`)}
          </ul>
        </div>
      </li>
      <li>
        <span class="plans-how-icon">${icon('infinity')}</span>
        <div><strong>O resto é livre</strong><p>Videoaulas, banco de questões, provas anteriores e cronograma não gastam moedas, em nenhum plano.</p></div>
      </li>
    </ol>`);
  box.hidden = false;
}

// Exemplo de combinação para a nota da tabela: o primeiro par de ações pagas,
// nesta ordem, que cabe no dia de algum plano. Sem par que caiba, sem exemplo.
const COMBO_ACTIONS = [
  { key: 'essay_correction', label: '1 redação' },
  { key: 'simulado_long', label: '1 simulado completo' },
  { key: 'simulado_short', label: '1 simulado curto' },
  { key: 'questions', label: '1 lote de questões da IA' },
];

function comboExample(cols, costs) {
  const paid = costs
    ? COMBO_ACTIONS.map((action) => ({ ...action, cost: wholeCount(costs[action.key]) })).filter((action) => action.cost > 0)
    : [];
  for (let i = 0; i < paid.length; i += 1) {
    for (let j = i + 1; j < paid.length; j += 1) {
      const total = paid[i].cost + paid[j].cost;
      const fits = cols.filter((plan) => Number(plan.daily_coins) >= total).map((plan) => tierLabel(plan.tier));
      if (!fits.length) continue;
      const where = fits.length === cols.length
        ? 'de qualquer plano'
        : `do ${fits.length > 1 ? `${fits.slice(0, -1).join(', do ')} e do ${fits[fits.length - 1]}` : fits[0]}`;
      return `Dá para combinar: ${paid[i].label} + ${paid[j].label} = ${fmtNumber(total, { digits: 0 })} moedas, o que cabe no dia ${where}.`;
    }
  }
  return '';
}

function compareNote(cols, costs, { daily, tutor }) {
  return [
    daily ? 'Redações e simulados por dia: cada número é o máximo de uma ação só, com todas as moedas do dia nela.' : '',
    daily ? comboExample(cols, costs) : '',
    tutor ? 'O Tutor IA não gasta moedas: cada plano tem uma cota própria por mês.' : '',
  ].filter(Boolean).join(' ');
}

// Tabela Básico × Pro × Avançado da duração escolhida. Cada número vem dos planos
// (daily_capacity, moedas, cota do Tutor) e da contagem; linha sem dado some, e
// com menos de dois níveis a tabela não aparece. As linhas por dia de redações e
// simulados repetem a caixa dos cartões, então só aparecem no celular, onde o
// trilho mostra um cartão por vez (landing.css).
function renderCompare(box, cards, countdown, costs) {
  const cols = TIER_ORDER.map((tier) => cards.find((plan) => plan.tier === tier)).filter(Boolean);
  if (cols.length < 2) {
    box.hidden = true;
    return;
  }
  const count = (value) => (value === null ? null : fmtNumber(value, { digits: 0 }));
  const capacity = (plan, key) => wholeCount(plan.daily_capacity && plan.daily_capacity[key]);
  const rows = [
    { label: 'Moedas por dia', values: cols.map((plan) => count(Number(plan.daily_coins) > 0 ? Number(plan.daily_coins) : null)) },
    ...CAPACITY_LINES.map((line) => ({
      label: html`${line.row}<span class="sr-only"> por dia</span>`,
      daily: true,
      values: cols.map((plan) => count(capacity(plan, line.key))),
    })),
  ];
  const base = cols.find((plan) => plan.tier === 'basico');
  const baseTokens = base ? Number(base.tutor_monthly_tokens) : 0;
  if (baseTokens > 0) {
    rows.push({
      label: html`Tutor IA no mês <span>comparado ao ${tierLabel(base.tier)}</span>`,
      tutor: true,
      values: cols.map((plan) => {
        const tokens = Number(plan.tutor_monthly_tokens);
        if (!(tokens > 0)) return null;
        if (plan === base) return { text: 'base' };
        return tokens === baseTokens ? { text: 'igual' } : fmtTimes(tokens / baseTokens);
      }),
    });
  }
  // total até a prova só na duração cujo acesso chega ao dia da prova: o Mensal
  // dá um mês, e com a prova mais longe que isso o número dependeria de renovar
  const days = countdown ? Number(countdown.days_left) : 0;
  if (days > 0) {
    const exam = countdown.exam_short_name || 'ENEM';
    rows.push({
      label: html`Redações até ${examWithArticle(exam)} <span>${fmtNumber(days, { digits: 0 })} ${days === 1 ? 'dia' : 'dias'}</span>`,
      values: cols.map((plan) => {
        const n = capacity(plan, 'essay_corrections');
        return n === null || !accessCoversExam(plan, countdown) ? null : count(n * days);
      }),
      accent: true,
    });
  }
  const shown = rows.filter((row) => row.values.some((value) => value !== null));
  const note = compareNote(cols, costs, { daily: shown.some((row) => row.daily), tutor: shown.some((row) => row.tutor) });
  const rowClass = (row) => [row.accent ? 'is-accent' : '', row.daily ? 'is-daily' : ''].filter(Boolean).join(' ');

  render(box, html`
    <div class="plans-compare-frame">
      <table class="plans-compare-table">
        <caption><span>Quanto rende cada plano</span> ${cols.map((plan) => tierLabel(plan.tier)).join(' × ')}</caption>
        <thead>
          <tr>
            <td></td>
            ${cols.map((plan) => html`<th scope="col">${tierLabel(plan.tier)}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${shown.map((row, index) => html`
            ${row.daily && !(index && shown[index - 1].daily)
              ? html`<tr class="is-daily is-group" aria-hidden="true"><td colspan="${cols.length + 1}">Por dia, dá para</td></tr>`
              : ''}
            <tr class="${rowClass(row)}">
              <th scope="row">${row.label}</th>
              ${row.values.map((value) => (value && value.text
                ? html`<td class="is-text">${value.text}</td>`
                : html`<td>${value === null ? '—' : value}</td>`))}
            </tr>`)}
        </tbody>
      </table>
    </div>
    ${note ? html`<p class="plans-compare-note">${note}</p>` : ''}`);
  // no tablet e no desktop a tabela fica só com as linhas que os cartões não têm;
  // se não sobrar nenhuma, ela some ali (landing.css)
  box.classList.toggle('plans-compare-only-daily', shown.every((row) => row.daily));
  box.hidden = false;
}

// Blocos que dependem de /api/landing (contagem e custos das moedas): chegam
// depois dos cartões e acompanham a duração escolhida no seletor.
function initPlansExtras(data, plans, view) {
  const grid = qs('#plans-grid');
  const countdownBox = qs('#plans-countdown');
  const howBox = qs('#plans-how');
  const compareBox = qs('#plans-compare');
  const countdown = data && data.countdown && Number(data.countdown.days_left) > 0 ? data.countdown : null;
  const costs = data && data.coin_costs && typeof data.coin_costs === 'object' ? data.coin_costs : null;
  if (howBox) renderCoinsHow(howBox, costs);
  const paint = (months) => {
    const cards = tierCardsFor(plans, months);
    if (countdownBox) renderCountdown(countdownBox, countdown, cards);
    renderTopAdvice(grid, countdown, cards);
    if (compareBox) renderCompare(compareBox, cards, countdown, costs);
    window.dispatchEvent(new Event('landing:layout'));
  };
  paint(view.months());
  view.onChange(paint);
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
  const syncRail = initPlansRail(grid);
  if (tierPlans.length) {
    // os cartões saem já; contagem, moedas e comparativo completam quando /api/landing chegar
    const view = initTierPlans(grid, tierPlans, syncRail);
    loadLanding().then((data) => initPlansExtras(data, tierPlans, view));
    return;
  }

  plans.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  render(grid, plans.map((plan) => planCard(plan)));
  observeReveal(qsa('.plan', grid));
  syncRail();
  window.dispatchEvent(new Event('landing:layout'));
}

// As imagens curadas de Resultados (/assets/results/<bloco>/arquivo) têm uma
// miniatura em JPEG ao lado (<bloco>/thumbs/arquivo.jpg); o ampliar abre a cheia.
function resultThumb(url) {
  const source = String(url || '');
  const match = source.match(/^(\/assets\/results\/[a-z-]+\/)([^/]+)\.(png|jpe?g)$/i);
  return match ? `${match[1]}thumbs/${match[2]}.jpg` : source;
}

// Bloco da imagem: 'conversa' vai para Mensagens recebidas, o resto é foto de
// aprovado. Sem o campo (resposta antiga em cache), o caminho decide.
function isConversation(item) {
  if (item.kind) return item.kind === 'conversa';
  return /\/results\/(conversas|messages)\//.test(item.image_url);
}

function resultCard(item, type) {
  const name = item.name || 'Aluno Foco de Elite';
  const role = item.role || item.exam_short_name || 'Resultado real';
  const isPhoto = type === 'photo';
  return html`
    <button class="result-card result-card-${type}" type="button"
      data-media-src="${item.image_url}"
      data-media-alt="${isPhoto ? 'Aprovado' : 'Mensagem'}: ${name}, ${role}"
      aria-label="${isPhoto ? 'Ampliar foto' : 'Abrir mensagem'} de ${name}">
      <span class="result-card-media">
        <img src="${resultThumb(item.image_url)}" alt="" width="${isPhoto ? 480 : 340}" height="${isPhoto ? 600 : 604}" loading="lazy" decoding="async">
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
    qsa('[data-block-items="steps"]', section).forEach((list) => applySteps(list, block.items));
  });
}

// Passos do "Como funciona": vêm do painel (itens do bloco), com ícone, título
// e texto. O título do bloco fala em "seis passos" e a página mostrava três
// fixos no HTML; agora a lista é a do painel. Sem itens cadastrados, os passos
// do HTML ficam como estão.
function applySteps(list, items) {
  const steps = (Array.isArray(items) ? items : []).filter((item) => item && String(item.title || '').trim());
  if (!steps.length) return;
  render(list, steps.map((step, index) => html`
    <li class="reveal"><span>${String(index + 1).padStart(2, '0')}</span><div class="method-icon">${icon(step.icon || 'check')}</div><div><h3>${step.title}</h3>${step.text ? html`<p>${step.text}</p>` : ''}</div></li>`));
  list.classList.toggle('method-flow-grid', steps.length > 3);
  observeReveal(qsa('li', list));
  window.dispatchEvent(new Event('landing:layout'));
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
  // com as telas no ar, a seta da hero leva para elas, que vêm logo abaixo
  const cue = qs('.hero-scroll');
  if (cue) {
    cue.href = '#por-dentro';
    cue.setAttribute('aria-label', 'Ir para a seção Por dentro da plataforma');
  }
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

// Carrossel de Resultados: anda sozinho um cartão para a esquerda a cada
// RAIL_STEP_MS e, no fim, volta ao começo. Para enquanto a pessoa mexe nele
// (dedo, mouse, teclado), fora da tela e com a aba escondida; com movimento
// reduzido não anda sozinho. Arrastar e as setas continuam valendo sempre.
const RAIL_STEP_MS = 3200;
const RAIL_RESUME_MS = 6000;

function initResultsRail(rail) {
  const block = rail.closest('.results-block');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior = reduce ? 'auto' : 'smooth';

  const step = () => {
    const card = rail.firstElementChild;
    if (!card) return rail.clientWidth;
    const gap = parseFloat(getComputedStyle(rail).columnGap) || 0;
    return card.getBoundingClientRect().width + gap;
  };
  const atEnd = () => rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4;
  const atStart = () => rail.scrollLeft <= 4;
  const forward = () => {
    if (atEnd()) rail.scrollTo({ left: 0, behavior });
    else rail.scrollBy({ left: step(), behavior });
  };
  const back = () => {
    if (atStart()) rail.scrollTo({ left: rail.scrollWidth, behavior });
    else rail.scrollBy({ left: -step(), behavior });
  };

  let pausedUntil = 0;
  const hold = () => { pausedUntil = Date.now() + RAIL_RESUME_MS; };
  qs('[data-rail-prev]', block)?.addEventListener('click', () => { hold(); back(); });
  qs('[data-rail-next]', block)?.addEventListener('click', () => { hold(); forward(); });

  if (reduce) return;

  let hovering = false;
  let visible = false;
  rail.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse') hovering = true; });
  rail.addEventListener('pointerleave', () => { hovering = false; hold(); });
  ['pointerdown', 'touchstart', 'wheel', 'focusin', 'keydown'].forEach((type) => {
    rail.addEventListener(type, hold, { passive: true });
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
    }, { threshold: 0.35 }).observe(rail);
  } else {
    visible = true;
  }

  window.setInterval(() => {
    if (!visible || hovering || document.hidden || Date.now() < pausedUntil) return;
    if (rail.scrollWidth <= rail.clientWidth + 4) return;
    forward();
  }, RAIL_STEP_MS);
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
  const videos = testimonials.filter((item) => item && item.video_url && !item.image_url);
  const photos = withImage.filter((item) => !isConversation(item));
  const messages = withImage.filter((item) => isConversation(item));
  if (!photos.length && !messages.length && !videos.length) {
    section.hidden = true;
    qsa('a[href="#resultados"]').forEach((link) => { link.hidden = true; });
    return;
  }

  render(postsEl, photos.map((item) => resultCard(item, 'photo')));
  render(messagesEl, messages.map((item) => resultCard(item, 'message')));
  if (videosEl) render(videosEl, videos.map((item) => videoCard(item)));
  if (!photos.length) postsEl.closest('.results-block').hidden = true;
  if (!messages.length) messagesEl.closest('.results-block').hidden = true;
  const videosBlock = qs('#results-videos-block');
  if (videosBlock) videosBlock.hidden = !videos.length;

  qsa('[data-results-rail]', section).forEach((rail) => {
    if (!rail.closest('.results-block').hidden) initResultsRail(rail);
  });
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
    // o bloco aparece assim que o topo dele passa da faixa de baixo da tela
    // (threshold 0): com 10%, um bloco alto como o dos vídeos de Resultados
    // ficava invisível mesmo já na tela, deixando um vão morto embaixo dos cards
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0 }
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
captureTracking();
initNav();
initScrollMotion();
initHeroMotion();
initMediaViewer();
initYear();
observeReveal(qsa('.reveal'));
initPlans();
initResults();
loadLanding().then((data) => {
  initContent(data);
  initSocialProof(data);
  initTour(data);
  initFaqs(data);
  initActivity(data);
  initTracking(data);
});

/**
 * Liga o Pixel do Meta (quando configurado no painel) e os eventos da tela:
 * Lead ao clicar num CTA de plano/começar, Contact ao clicar no WhatsApp.
 */
function initTracking(data) {
  const pixelId = data && data.tracking && data.tracking.meta_pixel_id;
  if (!pixelId) return;
  initMetaPixel(pixelId);

  // Lead: intenção real de compra é seguir para o cadastro (não rolar até os
  // planos). Uma vez por sessão, para não inflar o evento a cada clique.
  let leadEnviado = false;
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const cta = event.target.closest('a[href*="/cadastro"], [data-cta-plan]');
    if (cta && !leadEnviado) {
      leadEnviado = true;
      trackLead();
    }
    const wa = event.target.closest('a[href*="wa.me"], a[href*="whatsapp"], [data-whatsapp]');
    if (wa) trackWhatsApp();
  });
}
