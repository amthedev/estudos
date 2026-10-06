// =====================================================================
// Foco Elite — Painel administrativo: configurações (/admin/configuracoes)
//
// Lê GET /api/admin/settings e GET /api/admin/settings/integrations e grava
// por seção em PUT /api/admin/settings (a API aceita envio parcial).
//
// Segredos (OpenRouter, Asaas, SMTP) NÃO passam por aqui: vivem em variáveis de
// ambiente no servidor. A tela mostra apenas o status e a chave mascarada.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, qs, qsa, on, setLoading,
  pageHeader, errorState, skeleton, badge, alertBox,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtNumber, fmtDateTime, fmtRelative } from '../../core/format.js';
import { buildForm } from '../../components/form.js';

let state = null;

const ASAAS_EVENTS = [
  'CHECKOUT_PAID',
  'CHECKOUT_CANCELED',
  'CHECKOUT_EXPIRED',
  'SUBSCRIPTION_CREATED',
  'SUBSCRIPTION_DELETED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
  'PAYMENT_REFUNDED',
  'PAYMENT_DELETED',
];

const SECTIONS = [
  { id: 'brand', label: 'Marca', icon: 'sparkles' },
  { id: 'access', label: 'Acesso', icon: 'shield-check' },
  { id: 'landing', label: 'Página inicial', icon: 'home' },
  { id: 'coins', label: 'Moedas', icon: 'coins' },
  { id: 'openrouter', label: 'OpenRouter', icon: 'bot' },
  { id: 'asaas', label: 'Asaas', icon: 'credit-card' },
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

function openrouterAside() {
  const openrouter = (state.integrations && state.integrations.openrouter) || {};
  const used = Number(openrouter.month_tokens) || 0;
  const limit = Number(openrouter.limit) || 0;
  const statusBadge = openrouter.mock
    ? badge('Modo de simulação', 'orange', { icon: 'wand-sparkles' })
    : openrouter.configured
      ? badge('Integração ativa', 'green', { icon: 'circle-check' })
      : badge('Não configurada', 'red', { icon: 'circle-alert' });
  return html`
    <div class="aset-integration">
      <div class="aset-integration-head">
        ${statusBadge}
        ${openrouter.key ? html`<span class="text-xs text-3">Chave ${openrouter.key}</span>` : ''}
      </div>
      <dl class="kv aset-kv">
        <dt>Consumo do mês</dt>
        <dd>${num(used)} tokens em ${num(openrouter.month_requests)} chamadas</dd>
        <dt>Cota do acesso completo</dt>
        <dd>${limit > 0 ? `${num(limit)} tokens por mês` : 'Sem cota definida'}</dd>
        ${openrouter.last_error
          ? html`<dt>Último erro</dt><dd class="text-danger" title="${fmtDateTime(openrouter.last_error.at)}">${openrouter.last_error.message} · ${fmtRelative(openrouter.last_error.at)}</dd>`
          : ''}
      </dl>
      ${alertBox({
        type: 'info',
        title: 'A chave do OpenRouter fica no servidor',
        text: 'Ela é lida da variável de ambiente OPENROUTER_API_KEY e nunca é exibida nem editada por aqui. Sem a chave, o tutor e a correção de redação ficam indisponíveis.',
      })}
    </div>`;
}

function coinsAside() {
  return html`
    <div class="aset-integration">
      ${alertBox({
        type: 'info',
        title: 'Como as moedas funcionam',
        text:
          'Cada nível de plano recebe um tanto de moedas por dia, e cada ação que usa a IA custa algumas. ' +
          'O saldo volta ao valor do nível à meia-noite (horário de Brasília) e a sobra não acumula. ' +
          'Se a IA falhar, a moeda volta sozinha. Custo 0 deixa a ação grátis. ' +
          'O Tutor IA não gasta moedas: ele tem uma cota de tokens por mês em cada nível. ' +
          'A equipe, os assinantes de planos antigos (até o fim do período pago) e as liberações manuais não gastam moedas.',
        actions: html`<a class="btn btn-secondary btn-sm" href="/admin/planos">${icon('layers')}<span>Nível de cada plano</span></a>`,
      })}
    </div>`;
}

function asaasSection() {
  const asaas = (state.integrations && state.integrations.asaas) || {};
  const app = (state.integrations && state.integrations.app) || {};
  const webhookUrl = `${app.app_url || ''}/api/billing/webhook`;
  return html`
    <div class="aset-integration">
      <div class="aset-integration-head">
        ${asaas.configured ? badge('Integração ativa', 'green', { icon: 'circle-check' }) : badge('Não configurada', 'red', { icon: 'circle-alert' })}
        ${asaas.environment ? badge(asaas.environment === 'production' ? 'Produção' : 'Teste', asaas.environment === 'production' ? 'blue' : 'gray') : ''}
        ${asaas.webhook_configured ? badge('Webhook configurado', 'green') : badge('Webhook pendente', 'orange')}
      </div>
      <dl class="kv aset-kv">
        <dt>Chave da API</dt>
        <dd>${asaas.key_last4 ? `•••• ${asaas.key_last4}` : 'Não definida'}</dd>
        <dt>Ambiente</dt>
        <dd>${asaas.environment === 'production' ? 'Produção' : asaas.environment === 'sandbox' ? 'Sandbox' : 'Não definido'}</dd>
        <dt>Token do webhook</dt>
        <dd>${asaas.webhook_configured ? 'Configurado' : 'Não definido'}</dd>
      </dl>
      <div class="field aset-webhook">
        <label class="label" for="aset-webhook-url">URL do webhook</label>
        <div class="aset-copy">
          <input class="input" id="aset-webhook-url" type="text" value="${webhookUrl}" readonly spellcheck="false">
          <button type="button" class="btn btn-secondary" data-action="copy-webhook">${icon('copy')}<span>Copiar</span></button>
        </div>
        <p class="hint">Cadastre esta URL em Integrações → Webhooks no Asaas e use o mesmo token definido em ASAAS_WEBHOOK_TOKEN.</p>
      </div>
      <div class="aset-events">
        <span class="label">Eventos necessários</span>
        <ul class="aset-event-list">${ASAAS_EVENTS.map((event) => html`<li><code>${event}</code></li>`)}</ul>
      </div>
      ${alertBox({
        type: 'info',
        title: 'As chaves do Asaas ficam no servidor',
        text: 'ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN vêm das variáveis de ambiente. Cartões são coletados somente no checkout seguro do Asaas.',
        actions: html`<a class="btn btn-secondary btn-sm" href="/admin/planos">${icon('credit-card')}<span>Ir para planos</span></a>`,
      })}
    </div>`;
}

/**
 * Dispara o e-mail de teste e mostra o resultado sem rodeios.
 *
 * A hospedagem não dá terminal, então era impossível saber se o SMTP
 * funcionava sem pedir uma recuperação de senha de verdade e torcer.
 */
async function enviarEmailDeTeste(button) {
  setLoading(button, true);
  try {
    const res = await api.post('/api/admin/settings/smtp-test', {});
    toast(res.message, { type: 'success', duration: 8000 });
  } catch (err) {
    toast(err.message || 'Não foi possível enviar o e-mail de teste.', { type: 'error', duration: 10000 });
  } finally {
    setLoading(button, false);
  }
}

function smtpSection() {
  const smtp = (state.integrations && state.integrations.smtp) || {};
  return html`
    <div class="aset-integration">
      <div class="aset-integration-head">
        ${smtp.configured
          ? badge(`${smtp.provider_label || 'E-mail'} ativo`, 'green', { icon: 'circle-check' })
          : badge('E-mail não configurado', 'orange', { icon: 'triangle-alert' })}
      </div>
      <dl class="kv aset-kv">
        ${smtp.provider === 'resend'
          ? html`<dt>Provedor</dt>
              <dd>Resend (API)</dd>
              <dt>Chave</dt>
              <dd>•••• ${smtp.key_last4 || '----'}</dd>`
          : html`<dt>Servidor</dt>
              <dd>${smtp.host ? `${smtp.host}:${smtp.port || ''}` : 'Não definido'}</dd>
              <dt>Conexão segura</dt>
              <dd>${smtp.secure ? 'Sim (TLS)' : 'Não'}</dd>
              <dt>Usuário</dt>
              <dd>${smtp.user || 'Não definido'}</dd>`}
        <dt>Remetente</dt>
        <dd>${smtp.from || 'Não definido'}</dd>
      </dl>
      ${smtp.configured
        ? html`<div class="aset-integration-actions">
            <button type="button" class="btn btn-secondary" data-action="smtp-test">
              ${icon('send')}<span>Enviar e-mail de teste</span>
            </button>
            <span class="hint">Vai para o seu e-mail de administrador. Confira também o spam.</span>
          </div>`
        : alertBox({
          type: 'warning',
          title: 'Sem provedor de e-mail',
          text:
            'Os e-mails de recuperação de senha e de aulas particulares não são enviados — quem esquecer a senha ' +
            'não consegue voltar sozinho. Cadastre as variáveis de SMTP na hospedagem e reinicie a aplicação. ' +
            'Enquanto não houver domínio próprio, serviços como o Brevo aceitam um e-mail comum como remetente.',
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
        { value: 'asaas', label: 'Asaas (cartão e Pix)' },
        { value: 'none', label: 'Nenhum (assinatura desligada)' },
      ],
      hint: 'As chaves de acesso ficam no servidor, nunca aqui. Esta opção só decide qual serviço será usado na hora de cobrar.',
    },
  ], {
    values: {
      require_subscription: Boolean(s.require_subscription),
      private_lessons_enabled: s.private_lessons_enabled !== false,
      payment_provider: s.payment_provider === 'none' ? 'none' : 'asaas',
    },
    submitLabel: 'Salvar acesso',
    onSubmit: (values) => save({
      require_subscription: Boolean(values.require_subscription),
      private_lessons_enabled: Boolean(values.private_lessons_enabled),
      payment_provider: values.payment_provider || 'asaas',
    }, 'Regras de acesso atualizadas.'),
  }));

  state.forms.push(buildForm(qs('#aset-form-openrouter', state.el), [
    { key: 'openrouter_model', label: 'Modelo do tutor', type: 'text', required: true, maxLength: 120, placeholder: 'qwen/qwen3.8-flash', hint: 'Use o identificador completo do catálogo do OpenRouter: provedor/modelo.' },
    { key: 'openrouter_essay_model', label: 'Modelo da correção de redação', type: 'text', required: true, maxLength: 120, placeholder: 'qwen/qwen3.8-flash' },
    {
      key: 'openrouter_extract_model',
      label: 'Modelo da leitura de prova em PDF',
      type: 'text',
      maxLength: 120,
      placeholder: 'deixe vazio para usar o modelo do tutor',
      hint: 'Ler prova é transcrição, não raciocínio: um modelo mais rápido termina cada trecho dentro do tempo da requisição.',
    },
    {
      key: 'exam_import_vision_enabled',
      label: 'Ler com IA de visão as questões com alerta — custa mais; meça antes',
      type: 'switch',
      width: 'full',
      hint: 'Só as questões que a leitura marcou com texto ilegível ou alternativas faltando: a imagem da questão vai para a IA, que transcreve o texto. Se a transcrição vier boa, o alerta sai; se não, a questão continua esperando a conferência. Cada questão lida assim custa bem mais que a classificação — antes de ligar, rode node scripts/medir-leitura-visao.js com uma prova para ver o custo.',
    },
    {
      key: 'openrouter_vision_model',
      label: 'Modelo de visão',
      type: 'text',
      maxLength: 120,
      placeholder: 'deixe vazio para usar o modelo da leitura de prova',
      hint: 'Precisa ser um modelo que lê imagem (no catálogo do OpenRouter, com "image" nas entradas).',
    },
    { key: 'ai_student_monthly_token_limit', label: 'Cota mensal de tokens para acesso completo (planos antigos e cortesias)', type: 'number', min: 0, integer: true, hint: 'Vale só para quem não gasta moedas: assinantes de planos antigos, liberações manuais e plataforma aberta. Soma todo o uso de IA do aluno no mês; quem passar dela fica sem IA até o mês seguinte, sem afetar os outros. Alunos com nível usam as moedas e a cota do Tutor definidas em Moedas. A equipe não tem cota. Use 0 para não limitar.' },
    {
      key: 'simulado_ai_questions_max',
      label: 'Questões por IA em um simulado',
      type: 'number',
      min: 0,
      max: 90,
      integer: true,
      hint: 'Quando o banco não tem questões suficientes, a IA completa até esta quantidade — e elas ficam guardadas para os próximos simulados. Use 0 para só usar o que está no banco.',
    },
  ], {
    values: {
      openrouter_model: s.openrouter_model || '',
      openrouter_essay_model: s.openrouter_essay_model || '',
      openrouter_extract_model: s.openrouter_extract_model || '',
      exam_import_vision_enabled: s.exam_import_vision_enabled === true,
      openrouter_vision_model: s.openrouter_vision_model || '',
      ai_student_monthly_token_limit: Number(s.ai_student_monthly_token_limit) || 0,
      simulado_ai_questions_max: Number(s.simulado_ai_questions_max) || 0,
    },
    submitLabel: 'Salvar OpenRouter',
    onSubmit: async (values) => {
      await save({
        openrouter_model: values.openrouter_model,
        openrouter_essay_model: values.openrouter_essay_model,
        openrouter_extract_model: values.openrouter_extract_model || '',
        exam_import_vision_enabled: Boolean(values.exam_import_vision_enabled),
        openrouter_vision_model: values.openrouter_vision_model || '',
        ai_student_monthly_token_limit: Number(values.ai_student_monthly_token_limit) || 0,
        simulado_ai_questions_max: Number(values.simulado_ai_questions_max) || 0,
      }, 'Configurações do OpenRouter salvas.');
      await refreshIntegrations();
    },
  }));

  // Avisos de atividade real na página inicial (compras pagas e upgrades).
  const inRange = (value, min, max, fallback) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  state.forms.push(buildForm(qs('#aset-form-landing', state.el), [
    {
      key: 'activity_feed_enabled',
      label: 'Mostrar avisos de novas assinaturas na página inicial',
      type: 'switch',
      width: 'full',
      hint: 'Um balão discreto no canto da página com compras pagas e upgrades de verdade, como "Ana, que estuda para o ENEM, assinou o Pro · há 2 horas". Sai só o primeiro nome, a prova e o nível. Cortesias, testes não pagos, a equipe e quem desligou no perfil nunca aparecem.',
    },
    {
      key: 'activity_feed_days',
      label: 'Mostrar o que aconteceu nos últimos (dias)',
      type: 'number',
      required: true,
      min: 1,
      max: 90,
      integer: true,
      hint: 'Compras e upgrades mais antigos que isso não aparecem.',
    },
    {
      key: 'activity_feed_min_events',
      label: 'Mínimo de avisos para o balão aparecer',
      type: 'number',
      required: true,
      min: 1,
      max: 20,
      integer: true,
      hint: 'Com menos avisos reais que isso no período, a página não mostra nada. Nenhum aviso é repetido ou inventado para completar.',
    },
  ], {
    values: {
      activity_feed_enabled: s.activity_feed_enabled !== false,
      activity_feed_days: inRange(s.activity_feed_days, 1, 90, 14),
      activity_feed_min_events: inRange(s.activity_feed_min_events, 1, 20, 3),
    },
    submitLabel: 'Salvar página inicial',
    onSubmit: (values) => save({
      activity_feed_enabled: Boolean(values.activity_feed_enabled),
      activity_feed_days: inRange(values.activity_feed_days, 1, 90, 14),
      activity_feed_min_events: inRange(values.activity_feed_min_events, 1, 20, 3),
    }, 'Avisos da página inicial atualizados.'),
  }));

  const whole = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  const coinField = (key, label, hint, width = 'third') => ({ key, label, type: 'number', required: true, min: 0, integer: true, width, hint });
  state.forms.push(buildForm(qs('#aset-form-coins', state.el), [
    { type: 'section', label: 'Moedas por dia', hint: 'Quanto cada nível recebe por dia. Use 0 para deixar o nível sem moedas.' },
    coinField('coins_daily_basico', 'Básico'),
    coinField('coins_daily_pro', 'Pro'),
    coinField('coins_daily_avancado', 'Avançado'),
    { type: 'section', label: 'Quanto custa cada ação', hint: 'Em moedas. Use 0 para deixar a ação grátis.' },
    coinField('coin_cost_essay_correction', 'Correção de redação', 'Cobrada ao enviar a redação para a IA corrigir.', 'half'),
    coinField('coin_cost_essay_theme', 'Tema de redação criado pela IA', 'Botão "Gerar tema com IA" da nova redação.', 'half'),
    coinField('coin_cost_simulado_short', 'Simulado curto', 'Simulado com até o número de questões definido ao lado.'),
    { ...coinField('coin_simulado_short_max_questions', 'Simulado curto vai até (questões)', 'Acima disso, o simulado conta como longo.'), max: 90 },
    coinField('coin_cost_simulado_long', 'Simulado longo', 'Simulado com mais questões que o limite do curto.'),
    coinField('coin_cost_practice', 'Pratique da aula', 'Só é cobrado quando a IA precisa criar questões novas; com o banco suficiente, é grátis.', 'half'),
    coinField('coin_cost_questions', 'Elaborar questões no banco', 'Botão "Elaborar questões deste assunto" do banco de questões.', 'half'),
    {
      type: 'section',
      label: 'Tutor IA (tokens por mês)',
      hint: 'O Tutor não gasta moedas: cada nível tem uma cota mensal de tokens, que renova no dia 1º. Atenção: aqui 0 BLOQUEIA o Tutor daquele nível — não quer dizer "sem limite", como na cota do acesso completo.',
    },
    coinField('tutor_tokens_basico', 'Básico (0 bloqueia o Tutor)', 'Tokens por mês de cada aluno do Básico.'),
    coinField('tutor_tokens_pro', 'Pro (0 bloqueia o Tutor)', 'Tokens por mês de cada aluno do Pro.'),
    coinField('tutor_tokens_avancado', 'Avançado (0 bloqueia o Tutor)', 'Tokens por mês de cada aluno do Avançado.'),
    { type: 'section', label: 'Upgrade de plano' },
    {
      key: 'upgrade_min',
      label: 'Cobrança mínima do upgrade (R$)',
      type: 'number',
      required: true,
      min: 0,
      step: '0.01',
      hint: 'O aluno paga só a diferença proporcional ao tempo que falta. Quando a conta dá menos que isto, cobra-se este valor — o Asaas recusa cobranças muito baixas.',
    },
  ], {
    values: {
      coins_daily_basico: whole(s.coins_daily_basico),
      coins_daily_pro: whole(s.coins_daily_pro),
      coins_daily_avancado: whole(s.coins_daily_avancado),
      coin_cost_essay_correction: whole(s.coin_cost_essay_correction),
      coin_cost_essay_theme: whole(s.coin_cost_essay_theme),
      coin_cost_simulado_short: whole(s.coin_cost_simulado_short),
      coin_simulado_short_max_questions: whole(s.coin_simulado_short_max_questions),
      coin_cost_simulado_long: whole(s.coin_cost_simulado_long),
      coin_cost_practice: whole(s.coin_cost_practice),
      coin_cost_questions: whole(s.coin_cost_questions),
      tutor_tokens_basico: whole(s.tutor_tokens_basico),
      tutor_tokens_pro: whole(s.tutor_tokens_pro),
      tutor_tokens_avancado: whole(s.tutor_tokens_avancado),
      upgrade_min: whole(s.upgrade_min_cents) / 100,
    },
    submitLabel: 'Salvar moedas',
    onSubmit: (values) => save({
      coins_daily_basico: whole(values.coins_daily_basico),
      coins_daily_pro: whole(values.coins_daily_pro),
      coins_daily_avancado: whole(values.coins_daily_avancado),
      coin_cost_essay_correction: whole(values.coin_cost_essay_correction),
      coin_cost_essay_theme: whole(values.coin_cost_essay_theme),
      coin_cost_simulado_short: whole(values.coin_cost_simulado_short),
      coin_simulado_short_max_questions: whole(values.coin_simulado_short_max_questions),
      coin_cost_simulado_long: whole(values.coin_cost_simulado_long),
      coin_cost_practice: whole(values.coin_cost_practice),
      coin_cost_questions: whole(values.coin_cost_questions),
      tutor_tokens_basico: whole(values.tutor_tokens_basico),
      tutor_tokens_pro: whole(values.tutor_tokens_pro),
      tutor_tokens_avancado: whole(values.tutor_tokens_avancado),
      upgrade_min_cents: Math.round((Number(values.upgrade_min) || 0) * 100),
    }, 'Moedas atualizadas. Valem para as próximas ações dos alunos.'),
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
    subtitle: 'Marca, regras de acesso, página inicial, integrações e padrões de estudo da plataforma.',
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
    ${sectionCard({ id: 'landing', title: 'Página inicial', subtitle: 'Avisos de novas assinaturas para quem visita o site.', icon: 'home' })}
    ${sectionCard({ id: 'coins', title: 'Moedas', subtitle: 'Moedas por dia de cada nível, custo das ações com IA e cota do Tutor.', icon: 'coins', aside: coinsAside() })}
    ${sectionCard({ id: 'openrouter', title: 'OpenRouter', subtitle: 'Tutor, correção de redação e geração de temas.', icon: 'bot', aside: openrouterAside() })}
    ${sectionCard({ id: 'asaas', title: 'Asaas', subtitle: 'Cartão, Pix e assinaturas.', icon: 'credit-card', body: asaasSection() })}
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
    const aside = qs('#aset-aside-openrouter', state.el);
    if (aside) render(aside, openrouterAside());
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
    else if (action === 'smtp-test') enviarEmailDeTeste(target);
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
