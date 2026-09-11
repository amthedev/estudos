// =====================================================================
// Foco Elite — Painel administrativo: configurações (/admin/configuracoes)
//
// Lê GET /api/admin/settings e GET /api/admin/settings/integrations e grava
// por seção em PUT /api/admin/settings (a API aceita envio parcial).
//
// Segredos (OpenAI, Stripe, SMTP) NÃO passam por aqui: vivem em variáveis de
// ambiente no servidor. A tela mostra apenas o status e a chave mascarada.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, qs, qsa, on,
  pageHeader, errorState, skeleton, badge, progressBar, alertBox,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtNumber, fmtDateTime, fmtRelative } from '../../core/format.js';
import { buildForm } from '../../components/form.js';

let state = null;

const STRIPE_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

const SECTIONS = [
  { id: 'brand', label: 'Marca', icon: 'sparkles' },
  { id: 'access', label: 'Acesso', icon: 'shield-check' },
  { id: 'openai', label: 'OpenAI', icon: 'bot' },
  { id: 'stripe', label: 'Stripe', icon: 'credit-card' },
  { id: 'smtp', label: 'E-mail', icon: 'mail' },
  { id: 'schedule', label: 'Cronograma', icon: 'calendar-days' },
  { id: 'tutor', label: 'Tutor', icon: 'message-square' },
  { id: 'quotes', label: 'Frases do dia', icon: 'quote' },
];

const num = (value) => fmtNumber(value ?? 0, { digits: 0 });

/** Salva um conjunto de chaves e mantém o estado local em dia. */
async function save(payload, message = 'Configurações salvas.') {
  const saved = await api.put('/api/admin/settings', payload);
  state.settings = { ...state.settings, ...saved };
  toast(message, { type: 'success' });
  return saved;
}

// ---------------------------------------------------------------------
// Seções
// ---------------------------------------------------------------------
function sectionCard({ id, title, subtitle, icon: iconName, body, aside = '' }) {
  return html`
    <section class="card aset-section" id="aset-${id}">
      <div class="card-header">
        <h2 class="card-title">${icon(iconName)}<span>${title}</span></h2>
        ${subtitle ? html`<span class="card-subtitle">${subtitle}</span>` : ''}
      </div>
      <div class="card-body">
        <div id="aset-aside-${id}">${aside}</div>
        <div id="aset-form-${id}">${body || ''}</div>
      </div>
    </section>`;
}

function brandAside() {
  const logo = state.settings.logo_url || '/assets/brand/foco-elite-logo.png';
  return html`
    <div class="aset-logo">
      <div class="aset-logo-preview"><img src="${logo}" alt="Prévia da logo" id="aset-logo-img" width="220" height="48"></div>
      <p class="hint">A logo aparece no painel, na área do aluno e nos e-mails. Use SVG ou PNG com fundo transparente.</p>
    </div>`;
}

function openaiAside() {
  const openai = (state.integrations && state.integrations.openai) || {};
  const used = Number(openai.month_tokens) || 0;
  const limit = Number(openai.limit) || 0;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const statusBadge = openai.mock
    ? badge('Modo de simulação', 'orange', { icon: 'wand-sparkles' })
    : openai.configured
      ? badge('Integração ativa', 'green', { icon: 'circle-check' })
      : badge('Não configurada', 'red', { icon: 'circle-alert' });
  return html`
    <div class="aset-integration">
      <div class="aset-integration-head">
        ${statusBadge}
        ${openai.key ? html`<span class="text-xs text-3">Chave ${openai.key}</span>` : ''}
      </div>
      <dl class="kv aset-kv">
        <dt>Consumo do mês</dt>
        <dd>${num(used)} tokens em ${num(openai.month_requests)} chamadas</dd>
        <dt>Limite mensal</dt>
        <dd>${limit > 0 ? `${num(limit)} tokens` : 'Sem limite definido'}</dd>
        ${openai.last_error
          ? html`<dt>Último erro</dt><dd class="text-danger" title="${fmtDateTime(openai.last_error.at)}">${openai.last_error.message} · ${fmtRelative(openai.last_error.at)}</dd>`
          : ''}
      </dl>
      ${limit > 0 ? progressBar(pct, { color: pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : '', label: 'Uso do limite mensal' }) : ''}
      ${openai.limit_reached ? alertBox({ type: 'warning', title: 'Limite mensal atingido', text: 'As funções de IA ficam indisponíveis para os alunos até a virada do mês ou o aumento do limite.' }) : ''}
      ${alertBox({
        type: 'info',
        title: 'A chave da OpenAI fica no servidor',
        text: 'Ela é lida da variável de ambiente OPENAI_API_KEY e nunca é exibida nem editada por aqui. Sem a chave, o tutor e a correção de redação respondem em modo de simulação.',
      })}
    </div>`;
}

function stripeSection() {
  const stripe = (state.integrations && state.integrations.stripe) || {};
  const app = (state.integrations && state.integrations.app) || {};
  const webhookUrl = `${app.app_url || ''}/api/billing/webhook`;
  return html`
    <div class="aset-integration">
      <div class="aset-integration-head">
        ${stripe.configured ? badge('Integração ativa', 'green', { icon: 'circle-check' }) : badge('Não configurada', 'red', { icon: 'circle-alert' })}
        ${stripe.mode ? badge(stripe.mode === 'live' ? 'Produção' : 'Teste', stripe.mode === 'live' ? 'blue' : 'gray') : ''}
        ${stripe.webhook_configured ? badge('Webhook configurado', 'green') : badge('Webhook pendente', 'orange')}
      </div>
      <dl class="kv aset-kv">
        <dt>Chave secreta</dt>
        <dd>${stripe.secret_key_last4 ? `•••• ${stripe.secret_key_last4}` : 'Não definida'}</dd>
        <dt>Chave pública</dt>
        <dd>${stripe.publishable_key ? stripe.publishable_key : 'Não definida'}</dd>
        <dt>Segredo do webhook</dt>
        <dd>${stripe.webhook_secret_last4 ? `•••• ${stripe.webhook_secret_last4}` : 'Não definido'}</dd>
      </dl>
      <div class="field aset-webhook">
        <label class="label" for="aset-webhook-url">URL do webhook</label>
        <div class="aset-copy">
          <input class="input" id="aset-webhook-url" type="text" value="${webhookUrl}" readonly spellcheck="false">
          <button type="button" class="btn btn-secondary" data-action="copy-webhook">${icon('copy')}<span>Copiar</span></button>
        </div>
        <p class="hint">Cadastre esta URL no painel do Stripe (Developers → Webhooks) e guarde o segredo em STRIPE_WEBHOOK_SECRET.</p>
      </div>
      <div class="aset-events">
        <span class="label">Eventos necessários</span>
        <ul class="aset-event-list">${STRIPE_EVENTS.map((event) => html`<li><code>${event}</code></li>`)}</ul>
      </div>
      ${alertBox({
        type: 'info',
        title: 'As chaves do Stripe ficam no servidor',
        text: 'STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY e STRIPE_WEBHOOK_SECRET vêm das variáveis de ambiente. Os preços e planos são cadastrados em Planos.',
        actions: html`<a class="btn btn-secondary btn-sm" href="/admin/planos">${icon('credit-card')}<span>Ir para planos</span></a>`,
      })}
    </div>`;
}

function smtpSection() {
  const smtp = (state.integrations && state.integrations.smtp) || {};
  return html`
    <div class="aset-integration">
      <div class="aset-integration-head">
        ${smtp.configured ? badge('SMTP ativo', 'green', { icon: 'circle-check' }) : badge('SMTP não configurado', 'orange', { icon: 'triangle-alert' })}
      </div>
      <dl class="kv aset-kv">
        <dt>Servidor</dt>
        <dd>${smtp.host ? `${smtp.host}:${smtp.port || ''}` : 'Não definido'}</dd>
        <dt>Conexão segura</dt>
        <dd>${smtp.secure ? 'Sim (TLS)' : 'Não'}</dd>
        <dt>Usuário</dt>
        <dd>${smtp.user || 'Não definido'}</dd>
        <dt>Remetente</dt>
        <dd>${smtp.from || 'Não definido'}</dd>
      </dl>
      ${smtp.configured
        ? ''
        : alertBox({
          type: 'warning',
          title: 'Sem SMTP configurado',
          text: 'Os e-mails de recuperação de senha e de aulas particulares não são enviados; em desenvolvimento, o link aparece no console do servidor. Configure SMTP_HOST, SMTP_PORT, SMTP_USER e SMTP_PASS no servidor.',
        })}
    </div>`;
}

// ---------------------------------------------------------------------
// Formulários por seção
// ---------------------------------------------------------------------
function mountForms() {
  const s = state.settings;
  const schedule = s.schedule_defaults || {};
  const intervals = Array.isArray(s.review_intervals) ? s.review_intervals : [1, 7, 30];

  state.forms.push(buildForm(qs('#aset-form-brand', state.el), [
    { key: 'brand_name', label: 'Nome da marca', type: 'text', required: true, maxLength: 80 },
    { key: 'support_email', label: 'E-mail de suporte', type: 'email', required: true, maxLength: 160 },
    { key: 'logo_url', label: 'Logo da marca', type: 'file', folder: 'logos', accept: 'image', required: true, maxLength: 500, width: 'full', hint: 'Envie a imagem ou informe um endereço. O padrão é /assets/brand/foco-elite-logo.png.' },
  ], {
    values: { brand_name: s.brand_name || '', support_email: s.support_email || '', logo_url: s.logo_url || '' },
    submitLabel: 'Salvar marca',
    onChange: (values) => {
      // atualiza a prévia só quando o endereço já está completo (evita requisições a cada tecla)
      const url = String(values.logo_url || '').trim();
      const img = qs('#aset-logo-img', state.el);
      if (img && (url.startsWith('/') || /^https?:\/\/\S+\.\S+/i.test(url))) img.src = url;
    },
    onSubmit: (values) => save({
      brand_name: values.brand_name,
      support_email: values.support_email,
      logo_url: values.logo_url,
    }, 'Marca atualizada.'),
  }));

  state.forms.push(buildForm(qs('#aset-form-access', state.el), [
    { key: 'require_subscription', label: 'Exigir assinatura ativa para estudar', type: 'switch', width: 'full', hint: 'Com a opção desligada, todo aluno cadastrado tem acesso completo. Liberações manuais continuam valendo nos dois casos.' },
    { key: 'private_lessons_enabled', label: 'Oferecer aulas particulares aos alunos', type: 'switch', width: 'full', hint: 'Desligue para esconder a tela de agendamento na área do aluno.' },
    {
      key: 'payment_provider',
      label: 'Meio de cobrança das assinaturas',
      type: 'select',
      width: 'full',
      options: [
        { value: 'auto', label: 'Automático (usa o que estiver configurado no servidor)' },
        { value: 'asaas', label: 'Asaas (cartão, pix e boleto)' },
        { value: 'stripe', label: 'Stripe (cartão internacional)' },
        { value: 'none', label: 'Nenhum (assinatura desligada)' },
      ],
      hint: 'As chaves de acesso ficam no servidor, nunca aqui. Esta opção só decide qual serviço será usado na hora de cobrar.',
    },
  ], {
    values: {
      require_subscription: Boolean(s.require_subscription),
      private_lessons_enabled: s.private_lessons_enabled !== false,
      payment_provider: s.payment_provider || 'auto',
    },
    submitLabel: 'Salvar acesso',
    onSubmit: (values) => save({
      require_subscription: Boolean(values.require_subscription),
      private_lessons_enabled: Boolean(values.private_lessons_enabled),
      payment_provider: values.payment_provider || 'auto',
    }, 'Regras de acesso atualizadas.'),
  }));

  state.forms.push(buildForm(qs('#aset-form-openai', state.el), [
    { key: 'openai_model', label: 'Modelo do tutor', type: 'text', required: true, maxLength: 80, placeholder: 'gpt-4o-mini' },
    { key: 'openai_essay_model', label: 'Modelo da correção de redação', type: 'text', required: true, maxLength: 80 },
    { key: 'openai_monthly_token_limit', label: 'Limite mensal de tokens', type: 'number', min: 0, integer: true, hint: 'Use 0 para não limitar. Ao atingir o limite, as funções de IA pausam até o mês seguinte.' },
  ], {
    values: {
      openai_model: s.openai_model || '',
      openai_essay_model: s.openai_essay_model || '',
      openai_monthly_token_limit: Number(s.openai_monthly_token_limit) || 0,
    },
    submitLabel: 'Salvar OpenAI',
    onSubmit: async (values) => {
      await save({
        openai_model: values.openai_model,
        openai_essay_model: values.openai_essay_model,
        openai_monthly_token_limit: Number(values.openai_monthly_token_limit) || 0,
      }, 'Configurações da OpenAI salvas.');
      await refreshIntegrations();
    },
  }));

  state.forms.push(buildForm(qs('#aset-form-schedule', state.el), [
    { type: 'section', label: 'Intervalos de revisão (dias)', hint: 'Ao concluir uma aula, o sistema agenda três revisões nesses intervalos.' },
    { key: 'review_1', label: 'Primeira revisão', type: 'number', required: true, min: 1, max: 3650, integer: true, width: 'third' },
    { key: 'review_2', label: 'Segunda revisão', type: 'number', required: true, min: 1, max: 3650, integer: true, width: 'third' },
    { key: 'review_3', label: 'Terceira revisão', type: 'number', required: true, min: 1, max: 3650, integer: true, width: 'third' },
    { type: 'section', label: 'Padrões do cronograma' },
    { key: 'questions_block_min', label: 'Bloco diário de questões (min)', type: 'number', required: true, min: 5, max: 180, integer: true },
    { key: 'review_block_min', label: 'Duração de cada revisão (min)', type: 'number', required: true, min: 5, max: 120, integer: true },
    { key: 'simulado_every_days', label: 'Simulado a cada (dias)', type: 'number', required: true, min: 1, max: 90, integer: true },
    { key: 'essay_weekly', label: 'Incluir uma redação por semana', type: 'switch' },
  ], {
    values: {
      review_1: Number(intervals[0]) || 1,
      review_2: Number(intervals[1]) || 7,
      review_3: Number(intervals[2]) || 30,
      questions_block_min: Number(schedule.questions_block_min) || 20,
      review_block_min: Number(schedule.review_block_min) || 15,
      simulado_every_days: Number(schedule.simulado_every_days) || 14,
      essay_weekly: schedule.essay_weekly !== false,
    },
    submitLabel: 'Salvar cronograma',
    onSubmit: (values) => {
      const list = [Number(values.review_1), Number(values.review_2), Number(values.review_3)];
      if (!(list[0] < list[1] && list[1] < list[2])) {
        throw new Error('Os intervalos de revisão precisam estar em ordem crescente.');
      }
      return save({
        review_intervals: list,
        schedule_defaults: {
          questions_block_min: Number(values.questions_block_min),
          review_block_min: Number(values.review_block_min),
          simulado_every_days: Number(values.simulado_every_days),
          essay_weekly: Boolean(values.essay_weekly),
        },
      }, 'Cronograma atualizado. Novos cronogramas já usam estes valores.');
    },
  }));

  state.forms.push(buildForm(qs('#aset-form-tutor', state.el), [
    {
      key: 'tutor_system_prompt',
      label: 'Prompt do sistema',
      type: 'textarea',
      required: true,
      rows: 16,
      minLength: 40,
      maxLength: 8000,
      width: 'full',
      hint: 'Define o comportamento do Tutor IA em todas as conversas. Escreva em português, diga o que ele deve e o que não deve fazer.',
    },
  ], {
    values: { tutor_system_prompt: s.tutor_system_prompt || '' },
    submitLabel: 'Salvar prompt',
    onSubmit: (values) => save({ tutor_system_prompt: values.tutor_system_prompt }, 'Prompt do tutor salvo.'),
  }));

  state.forms.push(buildForm(qs('#aset-form-quotes', state.el), [
    {
      key: 'daily_quotes',
      label: 'Frases do dia',
      type: 'tags',
      width: 'full',
      placeholder: 'Digite a frase e pressione Enter',
      hint: 'Uma delas aparece na tela inicial do aluno, escolhida pela data. Sem frases cadastradas, o espaço fica vazio.',
    },
  ], {
    values: { daily_quotes: Array.isArray(s.daily_quotes) ? s.daily_quotes : [] },
    submitLabel: 'Salvar frases',
    onSubmit: (values) => save({ daily_quotes: values.daily_quotes || [] }, 'Frases do dia salvas.'),
  }));
}

// ---------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------
function header() {
  return pageHeader({
    title: 'Configurações',
    subtitle: 'Marca, regras de acesso, integrações e padrões de estudo da plataforma.',
    actions: html`<button type="button" class="btn btn-secondary" data-action="reload">${icon('refresh-cw')}<span>Atualizar</span></button>`,
  });
}

function navigation() {
  return html`
    <nav class="aset-nav" aria-label="Seções das configurações">
      ${SECTIONS.map((section) => html`<a class="chip aset-nav-item" href="#aset-${section.id}">${icon(section.icon)}<span>${section.label}</span></a>`)}
    </nav>`;
}

function paint() {
  render(state.el, html`
    <div class="aset-page">
      ${header()}
      ${navigation()}
    ${sectionCard({ id: 'brand', title: 'Marca', subtitle: 'Nome, logo e contato de suporte.', icon: 'sparkles', aside: brandAside() })}
    ${sectionCard({ id: 'access', title: 'Acesso', subtitle: 'Quem pode estudar na plataforma.', icon: 'shield-check' })}
    ${sectionCard({ id: 'openai', title: 'OpenAI', subtitle: 'Tutor, correção de redação e geração de temas.', icon: 'bot', aside: openaiAside() })}
    ${sectionCard({ id: 'stripe', title: 'Stripe', subtitle: 'Pagamentos e assinaturas.', icon: 'credit-card', body: stripeSection() })}
    ${sectionCard({ id: 'smtp', title: 'E-mail', subtitle: 'Envio de mensagens automáticas.', icon: 'mail', body: smtpSection() })}
    ${sectionCard({ id: 'schedule', title: 'Cronograma', subtitle: 'Revisões e blocos padrão do plano de estudos.', icon: 'calendar-days' })}
    ${sectionCard({ id: 'tutor', title: 'Tutor IA', subtitle: 'Como o tutor conversa com o aluno.', icon: 'message-square' })}
    ${sectionCard({ id: 'quotes', title: 'Frases do dia', subtitle: 'Mensagens curtas exibidas na tela inicial do aluno.', icon: 'quote' })}
    </div>`);
  mountForms();
}

async function refreshIntegrations() {
  try {
    state.integrations = await api.get('/api/admin/settings/integrations');
    const aside = qs('#aset-aside-openai', state.el);
    if (aside) render(aside, openaiAside());
  } catch (err) {
    console.warn('[admin/configuracoes] não foi possível atualizar o status das integrações', err);
  }
}

async function load() {
  render(state.el, html`${header()}${skeleton('form', 5)}`);
  try {
    const [settings, integrations] = await Promise.all([
      api.get('/api/admin/settings'),
      api.get('/api/admin/settings/integrations').catch(() => null),
    ]);
    state.settings = settings || {};
    state.integrations = integrations;
  } catch (err) {
    render(state.el, html`${header()}${errorState({ title: 'Não foi possível carregar as configurações', message: err && err.message })}`);
    return;
  }
  destroyForms();
  paint();
}

function destroyForms() {
  if (!state || !state.forms) return;
  state.forms.forEach((form) => {
    if (form && typeof form.destroy === 'function') form.destroy();
  });
  state.forms = [];
}

async function copyWebhook() {
  const input = qs('#aset-webhook-url', state.el);
  if (!input) return;
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    toast('URL do webhook copiada.', { type: 'success' });
  } catch {
    toast('Copie a URL manualmente: o navegador bloqueou a cópia automática.', { type: 'warning' });
  }
}

export default async function renderSettings(ctx) {
  state = { el: ctx.el, settings: {}, integrations: null, forms: [] };
  ctx.setTitle('Configurações');
  on(ctx.el, 'click', '[data-action]', (event, target) => {
    const action = target.dataset.action;
    if (action === 'copy-webhook') copyWebhook();
    else if (action === 'reload' || action === 'retry') load();
  });
  on(ctx.el, 'click', '.aset-nav-item', (event, target) => {
    const id = String(target.getAttribute('href') || '').slice(1);
    const section = document.getElementById(id);
    if (!section) return;
    event.preventDefault();
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    qsa('.aset-nav-item', state.el).forEach((item) => item.classList.toggle('active', item === target));
  });
  await load();
}

export function unmount() {
  destroyForms();
  state = null;
}
