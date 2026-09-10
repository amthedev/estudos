// =====================================================================
// Foco de Elite — página inicial (public/index.html)
//
// A página é montada inteiramente a partir de GET /api/landing: blocos de
// texto, provas em destaque, planos, depoimentos e perguntas frequentes.
// Nada de texto de venda, preço, percentual, depoimento ou estatística
// vive aqui: o que não estiver cadastrado no banco simplesmente não é
// exibido, e a seção correspondente some da página e do menu.
//
// Responsabilidades:
//   1. navegação fixa (rolagem, seção ativa, menu do celular);
//   2. carregar o conteúdo e preencher cada seção (com estados de
//      carregamento e erro);
//   3. entrada suave dos blocos e ano do rodapé.
// =====================================================================
import { api } from './core/api.js';
import { html, render, qs, qsa, raw, escapeHtml } from './core/ui.js';
import { icon } from './core/icons.js';
import { fmtMoney, pluralize } from './core/format.js';

// ---------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------
/** Texto limpo de um campo do banco ('' quando nulo ou só espaços). */
function str(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

/** Mostra ou esconde um elemento (tolerante a seletor inexistente). */
function show(el, visible) {
  if (el) el.hidden = !visible;
}

/**
 * Preenche um elemento com texto do banco. Devolve `false` (e esconde o
 * elemento) quando não há texto — nenhuma seção inventa conteúdo.
 */
function setText(el, value) {
  const text = str(value);
  if (!el) return Boolean(text);
  el.textContent = text;
  el.removeAttribute('data-state');
  el.hidden = !text;
  return Boolean(text);
}

/**
 * Texto de várias linhas → parágrafos. Linhas simples dentro do mesmo
 * parágrafo viram quebras (é assim que chega a lista de planos usada nas
 * respostas das perguntas frequentes).
 */
function paragraphs(value) {
  const text = str(value);
  if (!text) return null;
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean))
    .filter((lines) => lines.length);
  if (!blocks.length) return null;
  return raw(blocks.map((lines) => `<p>${lines.map(escapeHtml).join('<br>')}</p>`).join(''));
}

/** Preenche um elemento com parágrafos; esconde quando não há texto. */
function setParagraphs(el, value) {
  const content = paragraphs(value);
  if (!el) return Boolean(content);
  if (content) render(el, content);
  else render(el, '');
  el.hidden = !content;
  return Boolean(content);
}

/** Normaliza a lista de itens de um bloco (`items` jsonb). */
function itemsOf(block) {
  const list = block && Array.isArray(block.items) ? block.items : [];
  return list.filter((item) => item && (str(item.title) || str(item.text) || str(item.image_url)));
}

/** Link seguro para dentro da plataforma; vazio quando o banco não define. */
function ctaHref(value, fallback = '') {
  const href = str(value) || fallback;
  return /^(https?:\/\/|\/)/.test(href) ? href : fallback;
}

// ---------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------
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
    document.body.classList.toggle('lp-nav-open', open);
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
    if (!nav.classList.contains('open')) return;
    if (event.target instanceof Element && !nav.contains(event.target)) setOpen(false);
  });
}

/** Marca no menu a seção visível no momento. */
function initSectionSpy() {
  const entries = qsa('.lp-nav-links > a[href^="#"]')
    .map((link) => ({ link, section: qs(link.getAttribute('href')) }))
    .filter((entry) => entry.section);
  if (!entries.length) return;

  let frame = 0;
  const update = () => {
    frame = 0;
    const marker = Math.min(window.innerHeight * 0.32, 220);
    let current = '';
    entries.forEach(({ section }) => {
      if (!section.hidden && section.getBoundingClientRect().top <= marker) current = section.id;
    });
    entries.forEach(({ link, section }) => {
      const active = section.id === current;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  const requestUpdate = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };

  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate);
  window.addEventListener('landing:layout', requestUpdate);
  update();
}

/** Liga/desliga os links (menu e rodapé) que apontam para uma seção. */
function toggleNavFor(id, visible) {
  qsa(`[data-nav-for="${id}"]`).forEach((link) => {
    const item = link.closest('li') || link;
    item.hidden = !visible;
    link.hidden = !visible;
  });
}

/** Publica uma seção só quando ela tem conteúdo vindo do banco. */
function publishSection(section, hasContent) {
  if (!section) return false;
  section.hidden = !hasContent;
  toggleNavFor(section.id, hasContent);
  return hasContent;
}

// ---------------------------------------------------------------------
// Cabeçalho das seções
// ---------------------------------------------------------------------
function fillHead(section, block) {
  const data = block || {};
  setText(qs('[data-slot="eyebrow"]', section), data.eyebrow);
  setText(qs('[data-slot="title"]', section), data.title);
  setText(qs('[data-slot="subtitle"]', section), data.subtitle);
}

// ---------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------
function fillHero(data) {
  const block = data.blocks.hero || {};
  const title = qs('#hero-title');
  const subtitle = qs('#hero-subtitle');

  setText(qs('#hero-eyebrow'), block.eyebrow);
  if (!setText(title, block.title)) show(title, false);
  if (!setText(subtitle, block.subtitle)) show(subtitle, false);

  // Botões: o principal vem do bloco; o secundário só existe se houver
  // uma seção para onde levar.
  const actions = qs('#hero-actions');
  const primaryLabel = str(block.cta_label) || 'Começar agora';
  const primaryHref = ctaHref(block.cta_href, '/cadastro');
  const secondary = data.plans.length
    ? { href: '#planos', label: 'Ver planos' }
    : data.blocks.como_funciona
      ? { href: '#como-funciona', label: 'Como funciona' }
      : null;

  render(
    actions,
    html`
      <a class="btn btn-primary btn-lg" href="${primaryHref}">
        ${primaryLabel}${icon('arrow-right')}
      </a>
      ${secondary ? html`<a class="btn btn-secondary btn-lg" href="${secondary.href}">${secondary.label}</a>` : ''}
    `
  );
  show(actions, true);

  // Faixa de recursos (hero.items)
  const items = itemsOf(block);
  const strip = qs('#hero-items');
  if (items.length) {
    render(
      strip,
      items.map(
        (item) => html`
          <li class="lp-hero-item">
            <span class="lp-hero-item-icon">${icon(str(item.icon) || 'circle-check')}</span>
            <span>${str(item.title) || str(item.text)}</span>
          </li>`
      )
    );
  }
  show(strip, items.length > 0);

  fillHeroVisual(data);
}

/**
 * Composição da área do aluno: só estrutura de interface e a rotina
 * cadastrada no bloco "como_funciona" (ou, na falta dele, os recursos do
 * hero). Nenhum número, percentual ou nome de conteúdo é exibido aqui.
 */
function fillHeroVisual(data) {
  const visual = qs('#hero-visual');
  const list = qs('#mock-routine');
  const brand = qs('#mock-brand');
  if (brand) brand.textContent = str(data.brand.name);

  const source = itemsOf(data.blocks.como_funciona);
  const fallback = itemsOf(data.blocks.hero);
  const routine = (source.length ? source : fallback).slice(0, 5);

  if (!routine.length) {
    show(visual, false);
    return;
  }

  render(
    list,
    routine.map(
      (item) => html`
        <li class="lp-mock-item">
          <span class="lp-mock-item-icon">${icon(str(item.icon) || 'circle-dot')}</span>
          <span class="lp-mock-item-text">${str(item.title) || str(item.text)}</span>
          <span class="lp-mock-item-dot"></span>
        </li>`
    )
  );
  show(visual, true);
}

// ---------------------------------------------------------------------
// Dores
// ---------------------------------------------------------------------
function fillPains(data) {
  const section = qs('#dores');
  const block = data.blocks.dores;
  const items = itemsOf(block);
  fillHead(section, block);

  render(
    qs('[data-slot="items"]', section),
    items.map(
      (item) => html`
        <li class="lp-pain card">
          <span class="lp-pain-icon">${icon(str(item.icon) || 'circle-help')}</span>
          <p class="lp-pain-title">${str(item.title)}</p>
          ${str(item.text) ? html`<p class="lp-pain-text">${str(item.text)}</p>` : ''}
        </li>`
    )
  );

  const hasBody = setParagraphs(qs('[data-slot="body"]', section), block && block.body);
  publishSection(section, Boolean(block && (str(block.title) || items.length || hasBody)));
}

// ---------------------------------------------------------------------
// Escolha seu objetivo (provas em destaque + cards extras do bloco)
// ---------------------------------------------------------------------
function goalCard(entry) {
  const media = entry.logo_url
    ? html`<img class="lp-goal-logo" src="${entry.logo_url}" alt="${entry.title}" loading="lazy">`
    : html`<span class="lp-goal-icon">${icon(entry.icon || 'graduation-cap')}</span>`;

  return html`
    <article class="lp-goal card card-hover">
      <div class="lp-goal-media">${media}</div>
      ${entry.title ? html`<h3 class="lp-goal-title">${entry.title}</h3>` : ''}
      ${entry.text ? html`<p class="lp-goal-text">${entry.text}</p>` : ''}
      ${entry.href
        ? html`<a class="btn btn-secondary lp-goal-cta" href="${entry.href}">${entry.cta}${icon('arrow-right')}</a>`
        : ''}
    </article>`;
}

function fillGoals(data) {
  const section = qs('#objetivos');
  const block = data.blocks.objetivos;
  fillHead(section, block);

  const fromExams = data.exams.map((exam) => {
    const title = str(exam.landing_headline) || str(exam.short_name) || str(exam.name);
    const slug = str(exam.slug);
    return {
      logo_url: str(exam.logo_url),
      icon: 'target',
      title,
      text: str(exam.landing_text),
      cta: str(exam.landing_cta) || 'Começar agora',
      href: slug ? `/cadastro?prova=${encodeURIComponent(slug)}` : '/cadastro',
    };
  });

  // Cards extras (por exemplo, "outros vestibulares"): saem dos itens do
  // bloco; na ausência deles, do texto de apoio do próprio bloco.
  const extras = itemsOf(block).map((item) => ({
    logo_url: str(item.image_url),
    icon: str(item.icon) || 'graduation-cap',
    title: str(item.title),
    text: str(item.text),
    cta: str(item.cta_label) || str(block && block.cta_label) || 'Começar agora',
    href: ctaHref(item.cta_href, ctaHref(block && block.cta_href, '/cadastro')),
  }));

  if (!extras.length && block && str(block.body)) {
    extras.push({
      logo_url: '',
      icon: 'graduation-cap',
      title: '',
      text: str(block.body),
      cta: str(block.cta_label) || 'Começar agora',
      href: ctaHref(block.cta_href, '/cadastro'),
    });
  }

  const cards = fromExams.concat(extras);
  render(qs('[data-slot="cards"]', section), cards.map(goalCard));
  publishSection(section, cards.length > 0);
}

// ---------------------------------------------------------------------
// Como funciona
// ---------------------------------------------------------------------
function fillSteps(data) {
  const section = qs('#como-funciona');
  const block = data.blocks.como_funciona;
  const items = itemsOf(block);
  fillHead(section, block);

  render(
    qs('[data-slot="items"]', section),
    items.map(
      (item) => html`
        <li class="lp-step">
          <span class="lp-step-num" aria-hidden="true"></span>
          <span class="lp-step-icon">${icon(str(item.icon) || 'circle-dot')}</span>
          <h3 class="lp-step-title">${str(item.title)}</h3>
          ${str(item.text) ? html`<p class="lp-step-text">${str(item.text)}</p>` : ''}
        </li>`
    )
  );
  publishSection(section, items.length > 0);
}

// ---------------------------------------------------------------------
// Planos
// ---------------------------------------------------------------------
/** Meses de acesso do plano (duração + bônus), ou 0 quando o banco não informa. */
function accessMonths(plan) {
  const duration = Number(plan.duration_months) > 0 ? Number(plan.duration_months) : 0;
  const bonus = Number(plan.bonus_months) > 0 ? Number(plan.bonus_months) : 0;
  return duration + bonus;
}

/** Período exibido no card: "por mês" ou "N meses de acesso" (N vem do banco). */
function accessLabel(plan) {
  const months = accessMonths(plan);
  if (months >= 2) return `${pluralize(months, 'mês', 'meses')} de acesso`;
  return 'por mês';
}

function planCard(plan) {
  const currency = str(plan.currency) || 'BRL';
  const money = (cents) => fmtMoney(cents, { currency: currency.toUpperCase() });
  const months = accessMonths(plan);
  const bonus = Number(plan.bonus_months) > 0 ? Number(plan.bonus_months) : 0;
  const compare = Number(plan.compare_price_cents) > Number(plan.price_cents) ? plan.compare_price_cents : null;
  const monthly = months >= 2 && Number(plan.monthly_equivalent_cents) > 0 ? plan.monthly_equivalent_cents : null;
  const savings = Number(plan.savings_cents) > 0 ? plan.savings_cents : null;
  const trial = Number(plan.trial_days) > 0 ? Number(plan.trial_days) : 0;
  const features = (Array.isArray(plan.features) ? plan.features : []).filter((item) => str(item));
  const badge = str(plan.badge);
  const slug = str(plan.slug) || str(plan.id);

  // Cada linha só existe quando o banco tem o dado correspondente.
  const tags = [];
  if (monthly) tags.push(html`<li>${icon('percent')}<span>Equivale a ${money(monthly)} por mês</span></li>`);
  if (savings) tags.push(html`<li class="is-positive">${icon('trending-down')}<span>Economia de ${money(savings)}</span></li>`);
  if (bonus) tags.push(html`<li class="is-positive">${icon('gift')}<span>${pluralize(bonus, 'mês', 'meses')} de bônus</span></li>`);
  if (trial) tags.push(html`<li>${icon('clock')}<span>${pluralize(trial, 'dia', 'dias')} para testar</span></li>`);

  return html`
    <article class="lp-plan card${plan.highlight ? ' is-highlight' : ''}">
      ${badge ? html`<span class="lp-plan-badge">${badge}</span>` : ''}
      <h3 class="lp-plan-name">${str(plan.name)}</h3>
      ${compare ? html`<p class="lp-plan-compare"><s>${money(compare)}</s></p>` : ''}
      <p class="lp-plan-price">
        <span class="lp-plan-amount">${money(plan.price_cents)}</span>
        <span class="lp-plan-period">${accessLabel(plan)}</span>
      </p>
      ${tags.length ? html`<ul class="lp-plan-tags">${tags}</ul>` : ''}
      ${str(plan.description) ? html`<p class="lp-plan-desc">${str(plan.description)}</p>` : ''}
      ${features.length
        ? html`<ul class="lp-plan-features">${features.map(
            (item) => html`<li>${icon('check')}<span>${str(item)}</span></li>`
          )}</ul>`
        : ''}
      <a class="btn ${plan.highlight ? 'btn-primary' : 'btn-secondary'} btn-lg lp-plan-cta"
         href="/cadastro?plano=${encodeURIComponent(slug)}">Assinar ${str(plan.name)}</a>
    </article>`;
}

/** Comparativo curto: só os campos que o banco preencheu. */
function plansTable(plans) {
  const money = (cents, plan) =>
    Number(cents) > 0 ? fmtMoney(cents, { currency: (str(plan.currency) || 'BRL').toUpperCase() }) : '—';
  const anyMonthly = plans.some((plan) => Number(plan.monthly_equivalent_cents) > 0);
  const anySavings = plans.some((plan) => Number(plan.savings_cents) > 0);

  return html`
    <table class="table lp-compare-table">
      <caption class="lp-compare-caption">Comparativo dos planos</caption>
      <thead>
        <tr>
          <th scope="col">Plano</th>
          <th scope="col">Acesso</th>
          <th scope="col">Valor</th>
          ${anyMonthly ? html`<th scope="col">Por mês</th>` : ''}
          ${anySavings ? html`<th scope="col">Economia</th>` : ''}
        </tr>
      </thead>
      <tbody>
        ${plans.map(
          (plan) => html`
            <tr class="${plan.highlight ? 'is-highlight' : ''}">
              <th scope="row">${str(plan.name)}</th>
              <td>${accessLabel(plan)}</td>
              <td>${money(plan.price_cents, plan)}</td>
              ${anyMonthly ? html`<td>${money(plan.monthly_equivalent_cents, plan)}</td>` : ''}
              ${anySavings ? html`<td>${money(plan.savings_cents, plan)}</td>` : ''}
            </tr>`
        )}
      </tbody>
    </table>`;
}

function fillPlans(data) {
  const section = qs('#planos');
  const block = data.blocks.planos;
  fillHead(section, block);

  const plans = data.plans;
  render(qs('[data-slot="cards"]', section), plans.map(planCard));

  const compare = qs('[data-slot="compare"]', section);
  if (plans.length > 1) render(compare, plansTable(plans));
  show(compare, plans.length > 1);

  setParagraphs(qs('[data-slot="body"]', section), block && block.body);
  publishSection(section, plans.length > 0);
}

// ---------------------------------------------------------------------
// Tudo em um só lugar
// ---------------------------------------------------------------------
function fillEverything(data) {
  const section = qs('#tudo-em-um-lugar');
  const block = data.blocks.tudo_em_um_lugar;
  const items = itemsOf(block);
  fillHead(section, block);

  render(
    qs('[data-slot="items"]', section),
    items.map(
      (item) => html`
        <li class="lp-feature">
          <span class="lp-feature-icon">${icon(str(item.icon) || 'circle-check')}</span>
          <span class="lp-feature-body">
            <span class="lp-feature-title">${str(item.title)}</span>
            ${str(item.text) ? html`<span class="lp-feature-text">${str(item.text)}</span>` : ''}
          </span>
        </li>`
    )
  );
  publishSection(section, items.length > 0);
}

// ---------------------------------------------------------------------
// Depoimentos (texto ou print, conforme cadastrado)
// ---------------------------------------------------------------------
function stars(rating) {
  const value = Number(rating);
  if (!Number.isFinite(value) || value < 1) return '';
  const total = Math.min(Math.round(value), 5);
  const list = [];
  for (let i = 0; i < total; i += 1) list.push(icon('star'));
  const label = `Avaliação: ${pluralize(total, 'estrela', 'estrelas')}`;
  return html`<span class="lp-testimonial-stars" role="img" aria-label="${label}">${list}</span>`;
}

function testimonialCard(item) {
  const name = str(item.name);
  const role = str(item.role) || str(item.exam_short_name);
  const content = str(item.content);
  const image = str(item.image_url);
  const photo = str(item.photo_url);
  const caption = [name, role].filter(Boolean).join(' · ');

  if (image) {
    return html`
      <li class="lp-testimonial lp-testimonial-image card">
        <figure>
          <img src="${image}" alt="${name ? `Depoimento de ${name}` : 'Depoimento de aluno'}" loading="lazy">
          ${caption ? html`<figcaption>${caption}</figcaption>` : ''}
        </figure>
      </li>`;
  }

  return html`
    <li class="lp-testimonial card">
      <span class="lp-testimonial-quote" aria-hidden="true">${icon('quote')}</span>
      ${stars(item.rating)}
      <blockquote class="lp-testimonial-text">${content}</blockquote>
      <footer class="lp-testimonial-author">
        ${photo
          ? html`<img class="lp-testimonial-photo" src="${photo}" alt="" loading="lazy">`
          : html`<span class="lp-testimonial-photo lp-testimonial-photo-empty">${icon('user')}</span>`}
        <span>
          ${name ? html`<span class="lp-testimonial-name">${name}</span>` : ''}
          ${role ? html`<span class="lp-testimonial-role">${role}</span>` : ''}
        </span>
      </footer>
    </li>`;
}

function fillTestimonials(data) {
  const section = qs('#depoimentos');
  const list = data.testimonials.filter((item) => str(item.content) || str(item.image_url));
  fillHead(section, data.blocks.depoimentos);
  render(qs('[data-slot="items"]', section), list.map(testimonialCard));
  publishSection(section, list.length > 0);
}

// ---------------------------------------------------------------------
// Perguntas frequentes
// ---------------------------------------------------------------------
function fillFaq(data) {
  const section = qs('#perguntas');
  const list = data.faqs.filter((item) => str(item.question) && str(item.answer));
  fillHead(section, data.blocks.faq);

  render(
    qs('[data-slot="items"]', section),
    list.map(
      (item) => html`
        <details class="lp-faq-item" name="faq">
          <summary>
            <span class="lp-faq-question">${str(item.question)}</span>
            <span class="lp-faq-chevron" aria-hidden="true">${icon('chevron-down')}</span>
          </summary>
          <div class="lp-faq-answer">${paragraphs(item.answer)}</div>
        </details>`
    )
  );
  publishSection(section, list.length > 0);
}

// ---------------------------------------------------------------------
// Fechamento
// ---------------------------------------------------------------------
function fillClosing(data) {
  const section = qs('#fechamento');
  const block = data.blocks.fechamento;
  fillHead(section, block);
  setText(qs('[data-slot="body"]', section), block && block.body);

  const actions = qs('[data-slot="actions"]', section);
  const label = str(block && block.cta_label);
  if (label) {
    render(
      actions,
      html`<a class="btn btn-primary btn-lg" href="${ctaHref(block.cta_href, '/cadastro')}">
        ${label}${icon('arrow-right')}
      </a>`
    );
  }
  show(actions, Boolean(label));
  publishSection(section, Boolean(block && (str(block.title) || label)));
}

// ---------------------------------------------------------------------
// Rodapé
// ---------------------------------------------------------------------
function fillFooter(data) {
  const brand = str(data.brand.name);
  const brandEl = qs('#footer-brand');
  if (brand && brandEl) brandEl.textContent = brand;

  const email = str(data.brand.support_email);
  const support = qs('#footer-support');
  if (support) {
    if (email) render(support, html`<a href="mailto:${email}">${email}</a>`);
    support.hidden = !email;
    const col = support.closest('.lp-footer-col');
    if (col) col.hidden = !email;
  }
}

// ---------------------------------------------------------------------
// Entrada suave dos blocos
// ---------------------------------------------------------------------
let observer = null;

function observeReveal(elements) {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !('IntersectionObserver' in window)) {
    elements.forEach((el) => el.classList.add('reveal', 'in'));
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
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
  }
  elements.forEach((el, index) => {
    if (el.classList.contains('reveal')) return;
    el.classList.add('reveal');
    el.style.transitionDelay = `${Math.min(index % 5, 4) * 60}ms`;
    observer.observe(el);
  });
}

function initReveal() {
  observeReveal(
    qsa(
      '.lp-head, .lp-pain, .lp-goal, .lp-step, .lp-plan, .lp-compare, .lp-feature, .lp-testimonial, .lp-faq-item, .lp-cta-inner, .lp-hero-visual'
    )
  );
}

function initYear() {
  const year = String(new Date().getFullYear());
  qsa('[data-year]').forEach((el) => {
    el.textContent = year;
  });
}

// ---------------------------------------------------------------------
// Carregamento
// ---------------------------------------------------------------------
/** Normaliza o payload da API para que cada seção possa confiar na forma. */
function normalize(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  return {
    blocks: data.blocks && typeof data.blocks === 'object' ? data.blocks : {},
    exams: Array.isArray(data.exams) ? data.exams : [],
    plans: Array.isArray(data.plans) ? data.plans : [],
    testimonials: Array.isArray(data.testimonials) ? data.testimonials : [],
    faqs: Array.isArray(data.faqs) ? data.faqs : [],
    brand: data.brand && typeof data.brand === 'object' ? data.brand : {},
  };
}

function setError(visible) {
  const box = qs('#landing-error');
  show(box, visible);
  if (!visible) return;
  // sem conteúdo não faz sentido manter os esqueletos girando
  const title = qs('#hero-title');
  const subtitle = qs('#hero-subtitle');
  if (title && title.dataset.state === 'loading') show(title, false);
  if (subtitle && subtitle.dataset.state === 'loading') show(subtitle, false);
}

async function load() {
  setError(false);
  let data;
  try {
    data = normalize(await api.get('/api/landing', { noRedirect: true, timeout: 10000 }));
  } catch (err) {
    console.info('[landing] conteúdo indisponível:', err && err.message);
    setError(true);
    return;
  }

  fillHero(data);
  fillPains(data);
  fillGoals(data);
  fillSteps(data);
  fillPlans(data);
  fillEverything(data);
  fillTestimonials(data);
  fillFaq(data);
  fillClosing(data);
  fillFooter(data);

  initReveal();
  window.dispatchEvent(new Event('landing:layout'));
}

// ---------------------------------------------------------------------
document.documentElement.classList.add('js');
initNav();
initSectionSpy();
initYear();

const retry = qs('#landing-retry');
if (retry) retry.addEventListener('click', () => load());

load();
