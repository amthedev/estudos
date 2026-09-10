// =====================================================================
// Foco Elite — gráficos (ARCHITECTURE §6.2)
// Usa window.Chart (public/vendor/chart.umd.js) já configurado com o tema escuro.
//
//   lineChart(canvas, { labels, datasets, options })
//   barChart(canvas, { labels, datasets, options })
//   doughnutChart(canvas, { labels, datasets, options })
//   radarChart(canvas, { labels, datasets, options })
//   destroyChart(canvas) · palette · colors
//
// Cada função devolve a instância do Chart e destrói a anterior no mesmo canvas.
// =====================================================================

export const palette = Object.freeze({
  primary: '#2F80ED',
  primary2: '#4DA3FF',
  success: '#2ECC71',
  warning: '#F5A623',
  danger: '#FF6B6B',
  muted: '#64748B',
  text: '#F5F7FA',
  text2: '#94A3B8',
  grid: 'rgba(148,163,184,.12)',
  tooltipBg: '#13243A',
  tooltipBorder: 'rgba(148,163,184,.22)',
});

/** Sequência de cores para séries sem cor definida. */
export const colors = Object.freeze([
  palette.primary2,
  palette.success,
  palette.warning,
  palette.danger,
  '#A78BFA',
  '#22D3EE',
  '#F472B6',
  palette.muted,
]);

const FONT_FAMILY = "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const instances = new WeakMap();
let configured = false;

/** Converte #RRGGBB em rgba(r,g,b,a); devolve a cor original quando não for hexadecimal. */
export function withAlpha(color, alpha = 0.15) {
  if (typeof color !== 'string') return color;
  const hex = color.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return color;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function getChart() {
  const Chart = typeof window !== 'undefined' ? window.Chart : null;
  if (!Chart) {
    console.warn('[charts] window.Chart não encontrado. Inclua /vendor/chart.umd.js antes dos módulos.');
    return null;
  }
  if (!configured) configure(Chart);
  return Chart;
}

/** Aplica o tema escuro nos defaults globais do Chart.js (uma única vez). */
function configure(Chart) {
  configured = true;
  const d = Chart.defaults;
  d.color = palette.text2;
  d.borderColor = palette.grid;
  d.font.family = FONT_FAMILY;
  d.font.size = 12;
  d.responsive = true;
  d.maintainAspectRatio = false;
  d.animation.duration = 400;
  d.interaction.mode = 'index';
  d.interaction.intersect = false;

  d.plugins.legend.display = false;
  d.plugins.legend.position = 'bottom';
  d.plugins.legend.labels.usePointStyle = true;
  d.plugins.legend.labels.pointStyle = 'circle';
  d.plugins.legend.labels.boxWidth = 8;
  d.plugins.legend.labels.boxHeight = 8;
  d.plugins.legend.labels.padding = 16;
  d.plugins.legend.labels.color = palette.text2;

  d.plugins.title.display = false;

  const t = d.plugins.tooltip;
  t.backgroundColor = palette.tooltipBg;
  t.borderColor = palette.tooltipBorder;
  t.borderWidth = 1;
  t.titleColor = palette.text;
  t.bodyColor = palette.text2;
  t.footerColor = palette.text2;
  t.padding = 10;
  t.cornerRadius = 8;
  t.displayColors = true;
  t.boxPadding = 4;
  t.usePointStyle = true;
  t.titleFont = { family: FONT_FAMILY, size: 12, weight: '600' };
  t.bodyFont = { family: FONT_FAMILY, size: 12 };

  d.elements.line.tension = 0.35;
  d.elements.line.borderWidth = 2;
  d.elements.line.borderCapStyle = 'round';
  d.elements.point.radius = 3;
  d.elements.point.hoverRadius = 5;
  d.elements.point.hitRadius = 10;
  d.elements.point.borderWidth = 2;
  d.elements.bar.borderRadius = 6;
  d.elements.bar.borderSkipped = false;
  d.elements.arc.borderWidth = 0;

  d.scale.grid.color = palette.grid;
  d.scale.grid.tickColor = 'transparent';
  d.scale.ticks.color = palette.text2;
  d.scale.ticks.padding = 8;
}

/** Mescla objetos simples recursivamente (arrays e instâncias são substituídos). */
function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(extra)) {
    const isPlain = value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
    out[key] = isPlain ? deepMerge(out[key] && typeof out[key] === 'object' ? out[key] : {}, value) : value;
  }
  return out;
}

function resolveCanvas(canvas) {
  const el = typeof canvas === 'string' ? document.querySelector(canvas) : canvas;
  if (!el) return null;
  if (el instanceof HTMLCanvasElement) return el;
  return el.querySelector ? el.querySelector('canvas') : null;
}

/** Destrói a instância associada ao canvas (se houver). */
export function destroyChart(canvas) {
  const el = resolveCanvas(canvas);
  if (!el) return false;
  const chart = instances.get(el);
  if (chart) {
    try {
      chart.destroy();
    } catch (err) {
      console.warn('[charts] falha ao destruir gráfico', err);
    }
    instances.delete(el);
    return true;
  }
  return false;
}

/** Devolve a instância ativa do canvas (ou null). */
export function getChartInstance(canvas) {
  const el = resolveCanvas(canvas);
  return el ? instances.get(el) || null : null;
}

/** Aplica cores padrão nas séries que não definem cor. */
function colorize(type, datasets = []) {
  return datasets.map((ds, i) => {
    const base = colors[i % colors.length];
    const out = { ...ds };
    if (type === 'line') {
      const color = out.borderColor || out.color || base;
      out.borderColor = color;
      out.pointBackgroundColor = out.pointBackgroundColor || color;
      out.pointBorderColor = out.pointBorderColor || palette.tooltipBg;
      if (out.fill && !out.backgroundColor) out.backgroundColor = withAlpha(color, 0.14);
      if (!out.fill && !out.backgroundColor) out.backgroundColor = color;
    } else if (type === 'bar') {
      const color = out.backgroundColor || out.color || base;
      out.backgroundColor = color;
      out.borderColor = out.borderColor || 'transparent';
      out.hoverBackgroundColor = out.hoverBackgroundColor || (typeof color === 'string' ? withAlpha(color, 0.85) : color);
      if (out.maxBarThickness === undefined) out.maxBarThickness = 36;
    } else if (type === 'doughnut' || type === 'pie') {
      if (!out.backgroundColor) out.backgroundColor = (out.data || []).map((_, j) => colors[j % colors.length]);
      out.borderColor = out.borderColor || '#0D1B2A';
      out.borderWidth = out.borderWidth ?? 2;
      out.hoverOffset = out.hoverOffset ?? 6;
    } else if (type === 'radar') {
      const color = out.borderColor || out.color || base;
      out.borderColor = color;
      out.backgroundColor = out.backgroundColor || withAlpha(color, 0.18);
      out.pointBackgroundColor = out.pointBackgroundColor || color;
      out.pointBorderColor = out.pointBorderColor || palette.tooltipBg;
      out.borderWidth = out.borderWidth ?? 2;
    }
    delete out.color;
    return out;
  });
}

const BASE_OPTIONS = {
  line: {
    scales: {
      x: { grid: { display: false }, border: { display: false } },
      y: { beginAtZero: true, border: { display: false }, ticks: { maxTicksLimit: 6 } },
    },
  },
  bar: {
    scales: {
      x: { grid: { display: false }, border: { display: false } },
      y: { beginAtZero: true, border: { display: false }, ticks: { maxTicksLimit: 6 } },
    },
  },
  doughnut: {
    cutout: '72%',
    interaction: { mode: 'nearest', intersect: true },
    plugins: { tooltip: { displayColors: true } },
  },
  radar: {
    interaction: { mode: 'nearest', intersect: true },
    scales: {
      r: {
        beginAtZero: true,
        grid: { color: palette.grid, circular: true },
        angleLines: { color: palette.grid },
        pointLabels: { color: palette.text2, font: { family: FONT_FAMILY, size: 12 } },
        ticks: { display: false, backdropColor: 'transparent', stepSize: 20 },
      },
    },
  },
};

/** Cria (ou recria) um gráfico do tipo informado no canvas. */
export function makeChart(type, canvas, { labels = [], datasets = [], options = {}, plugins = [] } = {}) {
  const Chart = getChart();
  const el = resolveCanvas(canvas);
  if (!Chart || !el) return null;
  destroyChart(el);
  const config = {
    type,
    data: { labels, datasets: colorize(type, datasets) },
    options: deepMerge(BASE_OPTIONS[type] || {}, options),
    plugins,
  };
  const chart = new Chart(el, config);
  instances.set(el, chart);
  return chart;
}

/** Atualiza dados/opções de um gráfico existente (ou cria, se não houver). */
export function updateChart(canvas, { labels, datasets, options } = {}) {
  const el = resolveCanvas(canvas);
  const chart = el ? instances.get(el) : null;
  if (!chart) return null;
  if (labels) chart.data.labels = labels;
  if (datasets) chart.data.datasets = colorize(chart.config.type, datasets);
  if (options) chart.options = deepMerge(chart.options, options);
  chart.update();
  return chart;
}

export const lineChart = (canvas, data) => makeChart('line', canvas, data);
export const barChart = (canvas, data) => makeChart('bar', canvas, data);
export const doughnutChart = (canvas, data) => makeChart('doughnut', canvas, data);
export const radarChart = (canvas, data) => makeChart('radar', canvas, data);

export default { lineChart, barChart, doughnutChart, radarChart, destroyChart, updateChart, getChartInstance, palette, colors, withAlpha };
