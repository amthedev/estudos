// =====================================================================
// Foco Elite — Painel administrativo: Vendas & Marketing (/admin/analise)
//
// Tudo vem de GET /api/admin/analytics?period=N em uma chamada: cards com
// variação contra o período anterior, receita/vendas por dia, por plano, por
// método de pagamento, a origem dos alunos (de qual anúncio vieram) e as
// últimas vendas. O botão de exportar baixa um CSV de /export.
//
// Só dados do nosso banco — nada de custo de anúncio ou ROAS (isso vive na
// Utmify e no Meta, que têm os próprios painéis).
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, qs, on,
  pageHeader, errorState, skeleton, statCard, badge, emptyState,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtNumber, fmtMoney, fmtDateTime, fmtRelative } from '../../core/format.js';
import { lineChart, doughnutChart, destroyChart, palette, colors, withAlpha } from '../../core/charts.js';

let state = null;

const PERIODOS = [
  { dias: 7, label: '7 dias' },
  { dias: 30, label: '30 dias' },
  { dias: 90, label: '90 dias' },
];

const num = (v) => fmtNumber(v ?? 0, { digits: 0 });
const money = (cents) => fmtMoney(cents ?? 0);

/** Converte o delta do servidor no formato que o statCard entende. */
function deltaProp(card) {
  if (!card || card.delta === null || card.delta === undefined) return null;
  const v = Number(card.delta);
  return { value: v, direction: v > 0 ? 'up' : v < 0 ? 'down' : 'flat', suffix: '%' };
}

// ---------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------
function header() {
  const period = state.period;
  return pageHeader({
    title: 'Vendas e marketing',
    subtitle: 'Receita, vendas e de onde vêm os alunos — nos últimos ' + period + ' dias.',
    actions: html`
      <div class="aanl-periods" role="group" aria-label="Período">
        ${PERIODOS.map((p) => html`
          <button type="button" class="btn btn-sm ${p.dias === period ? 'btn-primary' : 'btn-ghost'}"
            data-period="${p.dias}">${p.label}</button>`)}
      </div>
      <button type="button" class="btn btn-secondary" data-action="reload">${icon('refresh-cw')}<span>Atualizar</span></button>`,
  });
}

function cardsGrid(data) {
  const c = data.cards;
  const cards = [
    { label: 'Receita no período', value: money(c.receita.value), icon: 'dollar-sign', tone: 'green', delta: deltaProp(c.receita) },
    { label: 'Vendas', value: num(c.vendas.value), icon: 'tag', delta: deltaProp(c.vendas), hint: 'Pagamentos confirmados' },
    { label: 'Novos cadastros', value: num(c.cadastros.value), icon: 'user-plus', delta: deltaProp(c.cadastros) },
    { label: 'Assinantes ativos', value: num(c.assinantes_ativos.value), icon: 'credit-card', tone: 'green', hint: 'Com acesso vigente agora' },
    { label: 'Ticket médio', value: money(c.ticket_medio.value), icon: 'receipt', delta: deltaProp(c.ticket_medio) },
    { label: 'Conversão cadastro→venda', value: `${num(c.conversao.value)}%`, icon: 'target', delta: deltaProp(c.conversao) },
  ];
  return html`<section class="grid grid-3 aanl-cards">${cards.map((card) => statCard(card))}</section>`;
}

function chartsSection() {
  return html`
    <section class="grid grid-2 aanl-charts">
      <article class="card">
        <div class="card-header">
          <h2 class="card-title">${icon('trending-up')}<span>Receita por dia</span></h2>
        </div>
        <div class="card-body"><div class="aanl-chart"><canvas id="aanl-revenue" aria-label="Receita por dia" role="img"></canvas></div></div>
      </article>
      <article class="card">
        <div class="card-header">
          <h2 class="card-title">${icon('credit-card')}<span>Pix × cartão</span></h2>
        </div>
        <div class="card-body"><div class="aanl-chart"><canvas id="aanl-method" aria-label="Vendas por método de pagamento" role="img"></canvas></div></div>
      </article>
    </section>`;
}

function planosSection(data) {
  const rows = data.por_plano || [];
  return html`
    <article class="card">
      <div class="card-header"><h2 class="card-title">${icon('layers')}<span>Vendas por plano</span></h2></div>
      <div class="card-body">
        ${rows.length
          ? html`<table class="table aanl-table">
              <thead><tr><th>Plano</th><th class="num">Vendas</th><th class="num">Receita</th></tr></thead>
              <tbody>${rows.map((r) => html`<tr><td>${r.name}</td><td class="num">${num(r.vendas)}</td><td class="num">${money(r.receita_cents)}</td></tr>`)}</tbody>
            </table>`
          : emptyState({ title: 'Sem vendas no período', icon: 'layers' })}
      </div>
    </article>`;
}

function funilSection(data) {
  const f = data.funil || {};
  const etapas = [
    { label: 'Cadastros', value: Number(f.cadastros) || 0, icon: 'user-plus' },
    { label: 'Checkouts iniciados', value: Number(f.checkouts) || 0, icon: 'tag' },
    { label: 'Vendas pagas', value: Number(f.vendas) || 0, icon: 'circle-check' },
  ];
  const base = etapas[0].value || 1;
  return html`
    <article class="card">
      <div class="card-header"><h2 class="card-title">${icon('filter')}<span>Funil</span></h2></div>
      <div class="card-body aanl-funil">
        ${etapas.map((e) => {
          const pct = Math.round((e.value / base) * 100);
          return html`
            <div class="aanl-funil-row">
              <span class="aanl-funil-label">${icon(e.icon)}<span>${e.label}</span></span>
              <span class="aanl-funil-bar"><span class="aanl-funil-fill" style="width:${Math.min(100, pct)}%"></span></span>
              <strong class="aanl-funil-value">${num(e.value)}</strong>
            </div>`;
        })}
      </div>
    </article>`;
}

function origemSection(data) {
  const rows = data.origem || [];
  return html`
    <article class="card aanl-origem">
      <div class="card-header">
        <h2 class="card-title">${icon('target')}<span>De onde vêm os alunos</span></h2>
        <button type="button" class="btn btn-ghost btn-sm" data-export="origem">${icon('download')}<span>Exportar CSV</span></button>
      </div>
      <div class="card-body">
        ${rows.length
          ? html`<div class="table-scroll"><table class="table aanl-table">
              <thead><tr><th>Fonte</th><th>Campanha</th><th class="num">Cadastros</th><th class="num">Vendas</th><th class="num">Receita</th><th class="num">Conv.</th></tr></thead>
              <tbody>${rows.map((r) => {
                const conv = r.cadastros > 0 ? Math.round((r.vendas / r.cadastros) * 100) : 0;
                return html`<tr>
                  <td>${r.fonte}</td>
                  <td class="text-2">${r.campanha || '—'}</td>
                  <td class="num">${num(r.cadastros)}</td>
                  <td class="num">${num(r.vendas)}</td>
                  <td class="num">${money(r.receita_cents)}</td>
                  <td class="num">${conv}%</td>
                </tr>`;
              })}</tbody>
            </table></div>`
          : emptyState({ title: 'Ainda sem dados de origem', text: 'Quando alunos chegarem por um anúncio com UTM, eles aparecem aqui.', icon: 'target' })}
      </div>
    </article>`;
}

function vendasSection(data) {
  const rows = data.ultimas_vendas || [];
  return html`
    <article class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('list')}<span>Últimas vendas</span></h2>
        <button type="button" class="btn btn-ghost btn-sm" data-export="vendas">${icon('download')}<span>Exportar CSV</span></button>
      </div>
      <div class="card-body">
        ${rows.length
          ? html`<div class="table-scroll"><table class="table aanl-table">
              <thead><tr><th>Aluno</th><th>Plano</th><th class="num">Valor</th><th>Método</th><th>Origem</th><th>Quando</th></tr></thead>
              <tbody>${rows.map((v) => html`<tr>
                <td><span class="aanl-cell-main">${v.nome}</span><span class="aanl-cell-sub">${v.email}</span></td>
                <td>${v.plano}</td>
                <td class="num">${money(v.valor_cents)}</td>
                <td>${badge(v.metodo === 'pix' ? 'Pix' : v.metodo === 'credit_card' ? 'Cartão' : v.metodo, 'gray')}</td>
                <td class="text-2">${v.fonte}</td>
                <td class="text-3" title="${v.pago_em ? fmtDateTime(v.pago_em) : ''}">${v.pago_em ? fmtRelative(v.pago_em) : '—'}</td>
              </tr>`)}</tbody>
            </table></div>`
          : emptyState({ title: 'Sem vendas no período', icon: 'list' })}
      </div>
    </article>`;
}

// ---------------------------------------------------------------------
// Gráficos
// ---------------------------------------------------------------------
function drawCharts(data) {
  const serie = (data.series && data.series.por_dia) || [];
  const labels = serie.map((p) => p.date.slice(5)); // MM-DD
  const receita = serie.map((p) => (Number(p.receita_cents) || 0) / 100);
  lineChart(qs('#aanl-revenue', state.el), {
    labels,
    datasets: [{
      label: 'Receita (R$)',
      data: receita,
      borderColor: palette.primary,
      backgroundColor: withAlpha(palette.primary, 0.12),
      fill: true,
      tension: 0.3,
    }],
  });

  const metodos = data.por_metodo || [];
  if (metodos.length) {
    doughnutChart(qs('#aanl-method', state.el), {
      labels: metodos.map((m) => (m.metodo === 'pix' ? 'Pix' : m.metodo === 'credit_card' ? 'Cartão' : m.metodo)),
      datasets: [{ data: metodos.map((m) => m.vendas), backgroundColor: colors.slice(0, metodos.length) }],
    });
  }
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------
function paint() {
  const { el, status, data, error } = state;
  if (status === 'loading') {
    render(el, html`${header()}${skeleton('stats', 3)}<div class="mt-6">${skeleton('chart')}</div>`);
    return;
  }
  if (status === 'error') {
    render(el, html`${header()}${errorState({ title: 'Não foi possível carregar o painel', message: error || 'Tente novamente.' })}`);
    return;
  }
  render(el, html`
    <div class="aanl-page">
      ${header()}
      ${cardsGrid(data)}
      ${chartsSection()}
      <section class="grid grid-2">
        ${planosSection(data)}
        ${funilSection(data)}
      </section>
      ${origemSection(data)}
      ${vendasSection(data)}
    </div>`);
  drawCharts(data);
}

function destroyCharts() {
  if (!state || !state.el) return;
  destroyChart(qs('#aanl-revenue', state.el));
  destroyChart(qs('#aanl-method', state.el));
}

async function load() {
  destroyCharts();
  state.status = 'loading';
  paint();
  try {
    state.data = await api.get(`/api/admin/analytics?period=${state.period}`);
    state.status = 'ready';
  } catch (err) {
    state.error = err && err.message ? err.message : 'Erro inesperado.';
    state.status = 'error';
  }
  paint();
}

export default async function renderAnalytics(ctx) {
  state = { el: ctx.el, status: 'loading', data: null, error: null, period: 30 };
  ctx.setTitle('Vendas e marketing');
  on(ctx.el, 'click', '[data-action="reload"], [data-action="retry"]', () => load());
  on(ctx.el, 'click', '[data-period]', (event, target) => {
    const dias = Number(target.getAttribute('data-period'));
    if (PERIODOS.some((p) => p.dias === dias) && dias !== state.period) {
      state.period = dias;
      load();
    }
  });
  // Exportar: abre o CSV numa nova aba (o navegador baixa pelo Content-Disposition).
  on(ctx.el, 'click', '[data-export]', (event, target) => {
    const type = target.getAttribute('data-export');
    window.open(`/api/admin/analytics/export?period=${state.period}&type=${type}`, '_blank');
  });
  await load();
}

export function unmount() {
  destroyCharts();
  state = null;
}
