// =====================================================================
// Foco Elite — Painel administrativo: perfil do aluno (/admin/alunos/:id)
//
// Reúne GET /api/admin/students/:id (dados, perfil, acesso, métricas,
// atividades e redações) e GET /api/admin/students/:id/progress (atividade
// diária e progresso por matéria).
//
// Escrita: PUT /api/admin/students/:id e as ações POST block | unblock |
// grant-access | reset-password, além de DELETE — todas com confirmação.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, modal, confirm, qs, on, dropdown,
  pageHeader, emptyState, errorState, skeleton, statCard, badge, progressBar,
} from '../../core/ui.js';
import { icon, activityIcon } from '../../core/icons.js';
import {
  fmtNumber, fmtPct, fmtDate, fmtDateTime, fmtRelative, fmtMinutes, fmtScore,
  activityLabel, toISODate, addDays, pluralize,
} from '../../core/format.js';
import { buildForm } from '../../components/form.js';
import { lineChart, destroyChart, palette, withAlpha } from '../../core/charts.js';

let state = null;

const LEVELS = [
  { value: 'iniciante', label: 'Iniciante' },
  { value: 'intermediario', label: 'Intermediário' },
  { value: 'avancado', label: 'Avançado' },
];

const WEEKDAY_OPTIONS = [
  { value: 0, label: 'Domingo' }, { value: 1, label: 'Segunda-feira' }, { value: 2, label: 'Terça-feira' },
  { value: 3, label: 'Quarta-feira' }, { value: 4, label: 'Quinta-feira' }, { value: 5, label: 'Sexta-feira' },
  { value: 6, label: 'Sábado' },
];

const ACCESS_REASONS = {
  override: 'Acesso liberado manualmente',
  subscription: 'Assinatura ativa',
  open: 'Plataforma aberta (assinatura não exigida)',
  no_subscription: 'Sem assinatura',
  expired: 'Assinatura vencida',
  past_due: 'Pagamento em atraso',
  canceled: 'Assinatura cancelada',
  unpaid: 'Assinatura não paga',
  paused: 'Assinatura pausada',
};

const essayStatusLabel = (status) => (
  status === 'corrected' ? { label: 'Corrigida', tone: 'green' }
    : status === 'submitted' ? { label: 'Em correção', tone: 'orange' }
      : status === 'failed' ? { label: 'Falhou', tone: 'red' }
        : { label: 'Rascunho', tone: 'gray' }
);

const num = (value) => fmtNumber(value ?? 0, { digits: 0 });
const emptyToNull = (value) => {
  const text = typeof value === 'string' ? value.trim() : value;
  return text === '' || text === undefined ? null : text;
};

// ---------------------------------------------------------------------
// Ações administrativas
// ---------------------------------------------------------------------
async function runAction(promise, successMessage) {
  try {
    const result = await promise;
    toast((result && result.message) || successMessage, { type: 'success' });
    await load();
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível concluir a ação.', { type: 'error' });
  }
}

async function toggleBlock() {
  const { user } = state.data;
  const blocked = user.status === 'blocked';
  const ok = await confirm({
    title: blocked ? 'Desbloquear aluno' : 'Bloquear aluno',
    message: blocked
      ? `${user.name} volta a acessar a plataforma normalmente.`
      : `${user.name} perde o acesso imediatamente e as sessões abertas são encerradas.`,
    danger: !blocked,
    confirmText: blocked ? 'Desbloquear' : 'Bloquear',
    icon: blocked ? 'unlock' : 'ban',
  });
  if (!ok) return;
  await runAction(api.post(`/api/admin/students/${state.id}/${blocked ? 'unblock' : 'block'}`), 'Situação atualizada.');
}

function grantAccess() {
  const { user } = state.data;
  const active = user.access_override_until && new Date(user.access_override_until).getTime() > Date.now();
  const current = active ? String(user.access_override_until).slice(0, 10) : toISODate(addDays(new Date(), 30));
  const dialog = modal({
    title: 'Liberar acesso',
    subtitle: user.name,
    size: 'sm',
    body: html`
      <p class="text-2 mb-4">A liberação manual dá acesso completo mesmo sem assinatura ativa.</p>
      <div class="field">
        <label class="label" for="astu-grant">Liberar até</label>
        <input class="input" type="date" id="astu-grant" value="${current}" min="${toISODate(addDays(new Date(), 1))}">
        <p class="hint">Depois dessa data o acesso volta a depender da assinatura.</p>
      </div>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      active
        ? {
          label: 'Remover liberação',
          variant: 'secondary',
          onClick: async () => {
            await runAction(api.post(`/api/admin/students/${state.id}/grant-access`, { until: null }), 'Liberação removida.');
          },
        }
        : null,
      {
        label: 'Liberar',
        variant: 'primary',
        icon: 'unlock',
        onClick: async () => {
          const input = qs('#astu-grant', dialog.body);
          if (!input || !input.value) {
            toast('Escolha a data limite.', { type: 'warning' });
            return false;
          }
          await runAction(api.post(`/api/admin/students/${state.id}/grant-access`, { until: input.value }), 'Acesso liberado.');
          return true;
        },
      },
    ].filter(Boolean),
  });
}

function resetPassword() {
  const dialog = modal({
    title: 'Redefinir senha',
    subtitle: state.data.user.name,
    size: 'sm',
    body: html`
      <p class="text-2 mb-4">
        Defina uma senha provisória e combine com o aluno a troca no primeiro acesso.
        As sessões abertas são encerradas.
      </p>
      <div class="field">
        <label class="label" for="astu-pass">Nova senha</label>
        <input class="input" type="text" id="astu-pass" minlength="8" autocomplete="off" spellcheck="false" placeholder="Mínimo de 8 caracteres">
      </div>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Redefinir',
        variant: 'primary',
        icon: 'key',
        onClick: async () => {
          const input = qs('#astu-pass', dialog.body);
          const password = input ? input.value : '';
          if (password.length < 8) {
            toast('A senha precisa ter pelo menos 8 caracteres.', { type: 'warning' });
            return false;
          }
          await runAction(api.post(`/api/admin/students/${state.id}/reset-password`, { password }), 'Senha redefinida.');
          return true;
        },
      },
    ],
  });
}

async function removeStudent() {
  const { user } = state.data;
  const ok = await confirm({
    title: 'Excluir aluno',
    message: html`
      <p>Isto apaga <strong>${user.name}</strong> e todo o histórico de estudos, respostas, redações e anotações.</p>
      <p class="mt-2">A ação não pode ser desfeita.</p>`,
    danger: true,
    confirmText: 'Excluir definitivamente',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/students/${state.id}`);
    toast('Aluno excluído.', { type: 'success' });
    state.navigate('/admin/alunos');
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível excluir o aluno.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Formulário de dados e preferências
// ---------------------------------------------------------------------
function formFields() {
  const exams = state.exams.map((exam) => ({ value: exam.id, label: exam.short_name || exam.name }));
  const subjects = state.subjects.map((subject) => ({ value: subject.id, label: subject.name }));
  return [
    { type: 'section', label: 'Dados da conta' },
    { key: 'name', label: 'Nome completo', type: 'text', required: true, minLength: 2, maxLength: 120 },
    { key: 'email', label: 'E-mail', type: 'email', required: true, maxLength: 160 },
    { key: 'avatar_url', label: 'Foto (URL)', type: 'url', placeholder: 'https://…', hint: 'Opcional. Deixe em branco para usar as iniciais.' },
    { type: 'section', label: 'Preferências de estudo', hint: 'Alterar a prova ou a disponibilidade faz o cronograma ser recalculado no próximo acesso do aluno.' },
    { key: 'exam_id', label: 'Prova', type: 'select', options: exams, placeholder: 'Sem prova escolhida' },
    { key: 'other_exam_name', label: 'Outra prova', type: 'text', maxLength: 120, hint: 'Usado quando a prova não está na lista.' },
    { key: 'exam_date', label: 'Data da prova', type: 'date' },
    { key: 'level', label: 'Nível', type: 'select', options: LEVELS, placeholder: 'Não informado' },
    { key: 'hours_per_day', label: 'Horas por dia', type: 'number', min: 0.5, max: 16, step: '0.5' },
    { key: 'weekly_goal_hours', label: 'Meta semanal (horas)', type: 'number', min: 0, max: 120, step: '1' },
    { key: 'weakest_subject_id', label: 'Matéria mais difícil', type: 'select', options: subjects, placeholder: 'Não informada' },
    { key: 'study_days', label: 'Dias de estudo', type: 'multiselect', options: WEEKDAY_OPTIONS, placeholder: 'Adicionar dia…' },
    { key: 'target_course', label: 'Curso pretendido', type: 'text', maxLength: 120 },
    { key: 'target_university', label: 'Instituição', type: 'text', maxLength: 120 },
    { key: 'target_score', label: 'Nota alvo', type: 'text', maxLength: 60 },
    { key: 'main_difficulty', label: 'Maior dificuldade', type: 'textarea', rows: 3, maxLength: 500 },
    { key: 'performance_goal', label: 'Objetivo', type: 'textarea', rows: 3, maxLength: 500 },
    { key: 'onboarding_completed', label: 'Onboarding concluído', type: 'switch', hint: 'Desligue para o aluno refazer as perguntas iniciais.' },
  ];
}

function formValues() {
  const { user, profile } = state.data;
  const p = profile || {};
  return {
    name: user.name || '',
    email: user.email || '',
    avatar_url: user.avatar_url || '',
    exam_id: p.exam_id || null,
    other_exam_name: p.other_exam_name || '',
    exam_date: p.exam_date || '',
    level: p.level || null,
    hours_per_day: p.hours_per_day ?? null,
    weekly_goal_hours: p.weekly_goal_hours ?? null,
    weakest_subject_id: p.weakest_subject_id || null,
    study_days: Array.isArray(p.study_days) ? p.study_days.map(Number) : [],
    target_course: p.target_course || '',
    target_university: p.target_university || '',
    target_score: p.target_score || '',
    main_difficulty: p.main_difficulty || '',
    performance_goal: p.performance_goal || '',
    onboarding_completed: Boolean(p.onboarding_completed),
  };
}

async function submitProfile(values) {
  const payload = {
    name: values.name,
    email: values.email,
    avatar_url: emptyToNull(values.avatar_url),
    profile: {
      exam_id: values.exam_id || null,
      other_exam_name: emptyToNull(values.other_exam_name),
      exam_date: emptyToNull(values.exam_date),
      weakest_subject_id: values.weakest_subject_id || null,
      study_days: (values.study_days || []).map(Number),
      target_course: emptyToNull(values.target_course),
      target_university: emptyToNull(values.target_university),
      target_score: emptyToNull(values.target_score),
      main_difficulty: emptyToNull(values.main_difficulty),
      performance_goal: emptyToNull(values.performance_goal),
      weekly_goal_hours: values.weekly_goal_hours ?? null,
      onboarding_completed: Boolean(values.onboarding_completed),
    },
  };
  if (values.level) payload.profile.level = values.level;
  if (values.hours_per_day) payload.profile.hours_per_day = Number(values.hours_per_day);

  state.data = await api.put(`/api/admin/students/${state.id}`, payload);
  toast('Dados do aluno salvos.', { type: 'success' });
  paintHeader();
}

// ---------------------------------------------------------------------
// Blocos da tela
// ---------------------------------------------------------------------
function headerActions() {
  const blocked = state.data.user.status === 'blocked';
  return html`
    <button type="button" class="btn btn-secondary" data-action="${blocked ? 'unblock' : 'block'}">
      ${icon(blocked ? 'unlock' : 'ban')}<span>${blocked ? 'Desbloquear' : 'Bloquear'}</span>
    </button>
    <button type="button" class="btn btn-primary" data-action="grant">${icon('unlock')}<span>Liberar acesso</span></button>
    <button type="button" class="btn btn-secondary btn-icon" id="astu-more" aria-label="Mais ações">${icon('ellipsis')}</button>`;
}

function statusBadges() {
  const { user, access, subscription } = state.data;
  const items = [];
  items.push(user.status === 'blocked' ? badge('Bloqueado', 'red', { icon: 'ban' }) : badge('Ativo', 'green'));
  if (access && access.allowed) items.push(badge(ACCESS_REASONS[access.reason] || 'Acesso liberado', 'blue'));
  else items.push(badge(ACCESS_REASONS[(access && access.reason) || 'no_subscription'] || 'Sem acesso', 'orange'));
  if (subscription && subscription.status) items.push(badge(`Assinatura: ${subscription.status}`, 'gray'));
  return html`<div class="astu-badges">${items}</div>`;
}

function metricsRow() {
  const m = state.data.metrics || {};
  return html`
    <section class="grid grid-4 astu-metrics">
      ${statCard({ label: 'Aulas concluídas', value: num(m.lessons_done), hint: `de ${num(m.lessons_total)} no conteúdo da prova`, icon: 'play' })}
      ${statCard({ label: 'Questões resolvidas', value: num(m.questions_answered), hint: `${num(m.questions_correct)} corretas`, icon: 'file-text' })}
      ${statCard({ label: 'Acurácia', value: fmtPct(m.accuracy_pct), icon: 'target', tone: (m.accuracy_pct ?? 0) >= 60 ? 'green' : 'orange' })}
      ${statCard({ label: 'Horas de estudo', value: fmtMinutes(m.study_minutes || 0), icon: 'clock' })}
      ${statCard({ label: 'Sequência', value: `${num(m.streak)} ${pluralize(Number(m.streak) || 0, 'dia', 'dias', { withNumber: false })}`, icon: 'flame', tone: 'orange' })}
      ${statCard({ label: 'Simulados', value: num(m.simulados_finished), hint: m.simulados_avg_score ? `média ${fmtScore(m.simulados_avg_score)}` : 'sem tentativas', icon: 'target' })}
      ${statCard({ label: 'Redações', value: num(m.essays_corrected), hint: m.essays_avg_score ? `média ${fmtScore(m.essays_avg_score)}` : 'nenhuma corrigida', icon: 'pen-line' })}
      ${statCard({ label: 'Caderno de erros', value: num(m.errors_open), hint: `${num(m.reviews_due)} ${pluralize(Number(m.reviews_due) || 0, 'revisão', 'revisões', { withNumber: false })} em aberto`, icon: 'circle-x', tone: 'red' })}
    </section>`;
}

function accessCard() {
  const { user, access, subscription } = state.data;
  const override = user.access_override_until;
  const rows = [
    { label: 'Cadastro', value: fmtDateTime(user.created_at) },
    { label: 'Último acesso', value: user.last_seen_at ? `${fmtRelative(user.last_seen_at)} · ${fmtDateTime(user.last_seen_at)}` : 'Nunca entrou' },
    { label: 'Último login', value: user.last_login_at ? fmtDateTime(user.last_login_at) : '—' },
    { label: 'Situação do acesso', value: ACCESS_REASONS[(access && access.reason)] || (access && access.allowed ? 'Liberado' : 'Bloqueado') },
    { label: 'Liberação manual', value: override ? `até ${fmtDate(override)}` : 'Não' },
    { label: 'Plano', value: subscription && subscription.plan_name ? subscription.plan_name : 'Sem assinatura' },
    {
      label: 'Vigência da assinatura',
      value: subscription && subscription.current_period_end ? `até ${fmtDate(subscription.current_period_end)}` : '—',
    },
  ];
  return html`
    <article class="card astu-access">
      <div class="card-header"><h2 class="card-title">${icon('shield-check')}<span>Acesso e assinatura</span></h2></div>
      <div class="card-body">
        <dl class="kv">${rows.map((row) => html`<dt>${row.label}</dt><dd>${row.value}</dd>`)}</dl>
        <div class="astu-access-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="grant">${icon('unlock')}<span>Liberar acesso</span></button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="reset-password">${icon('key')}<span>Redefinir senha</span></button>
        </div>
      </div>
    </article>`;
}

function activityCard() {
  return html`
    <article class="card astu-chart-card">
      <div class="card-header">
        <h2 class="card-title">${icon('activity')}<span>Atividade dos últimos 30 dias</span></h2>
      </div>
      <div class="card-body">
        <div class="astu-chart"><canvas id="astu-activity" role="img" aria-label="Minutos de estudo e questões por dia"></canvas></div>
      </div>
    </article>`;
}

function subjectsCard() {
  const list = (state.progress && state.progress.by_subject) || [];
  return html`
    <article class="card">
      <div class="card-header"><h2 class="card-title">${icon('layers')}<span>Progresso por matéria</span></h2></div>
      <div class="card-body">
        ${list.length
          ? html`<div class="astu-subjects">${list.map((subject) => html`
              <div class="astu-subject">
                <div class="astu-subject-head">
                  <span class="astu-subject-name">${subject.name}</span>
                  <span class="text-xs text-3">${num(subject.lessons_done)}/${num(subject.lessons_total)} · ${fmtPct(subject.accuracy_pct)} de acerto</span>
                </div>
                ${progressBar(Number(subject.progress_pct) || 0, { size: 'sm' })}
              </div>`)}</div>`
          : emptyState({ icon: 'layers', title: 'Sem progresso registrado', text: 'O aluno ainda não concluiu aulas.', size: 'sm' })}
      </div>
    </article>`;
}

function activityListCard() {
  const list = state.data.recent_activity || [];
  return html`
    <article class="card">
      <div class="card-header"><h2 class="card-title">${icon('history')}<span>Últimas atividades</span></h2></div>
      <div class="card-body">
        ${list.length
          ? html`<div class="list list-plain">${list.map((item) => html`
              <div class="list-item">
                <span class="list-item-icon" aria-hidden="true">${icon(activityIcon(item.activity_type))}</span>
                <span class="list-item-main">
                  <span class="list-item-title">${activityLabel(item.activity_type)}</span>
                  <span class="list-item-meta">
                    ${item.subject_name ? html`<span>${item.subject_name}</span>` : ''}
                    <span>${fmtMinutes(item.minutes || 0)}</span>
                  </span>
                </span>
                <span class="list-item-end text-xs text-3" title="${fmtDateTime(item.created_at)}">${fmtRelative(item.study_date)}</span>
              </div>`)}</div>`
          : emptyState({ icon: 'history', title: 'Nenhuma atividade registrada', text: 'Os estudos aparecem aqui assim que o aluno começar.', size: 'sm' })}
      </div>
    </article>`;
}

function essaysCard() {
  const list = state.data.essays || [];
  return html`
    <article class="card">
      <div class="card-header"><h2 class="card-title">${icon('pen-line')}<span>Redações</span></h2></div>
      <div class="card-body">
        ${list.length
          ? html`<div class="list list-plain">${list.map((essay) => {
            const status = essayStatusLabel(essay.status);
            const when = essay.corrected_at || essay.submitted_at || essay.created_at;
            return html`
              <div class="list-item">
                <span class="list-item-main">
                  <span class="list-item-title">${essay.theme_title || 'Tema livre'}</span>
                  <span class="list-item-meta">
                    ${essay.exam_short_name ? html`<span>${essay.exam_short_name}</span>` : ''}
                    ${essay.word_count ? html`<span>${num(essay.word_count)} palavras</span>` : ''}
                    <span title="${fmtDateTime(when)}">${fmtRelative(when)}</span>
                  </span>
                </span>
                <span class="list-item-end astu-essay-end">
                  ${badge(status.label, status.tone)}
                  ${essay.status === 'corrected' && essay.score !== null && essay.score !== undefined
                    ? html`<strong class="astu-score">${fmtScore(essay.score)}${essay.max_score ? html`<small> / ${fmtScore(essay.max_score)}</small>` : ''}</strong>`
                    : ''}
                </span>
              </div>`;
          })}</div>`
          : emptyState({ icon: 'pen-line', title: 'Nenhuma redação enviada', text: 'As redações corrigidas pela IA aparecem aqui.', size: 'sm' })}
      </div>
    </article>`;
}

// ---------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------
function drawChart() {
  const days = (state.progress && state.progress.activity_by_day) || [];
  if (!days.length) return;
  lineChart(qs('#astu-activity', state.el), {
    labels: days.map((row) => fmtDate(row.date).slice(0, 5)),
    datasets: [
      {
        label: 'Minutos de estudo',
        data: days.map((row) => Number(row.minutes) || 0),
        borderColor: palette.primary2,
        backgroundColor: withAlpha(palette.primary2, 0.16),
        fill: true,
        tension: 0.32,
        pointRadius: 0,
        pointHoverRadius: 4,
      },
      {
        label: 'Questões resolvidas',
        data: days.map((row) => Number(row.questions) || 0),
        borderColor: palette.success,
        tension: 0.32,
        pointRadius: 0,
        pointHoverRadius: 4,
        yAxisID: 'y1',
      },
    ],
    options: {
      plugins: { legend: { display: true } },
      scales: {
        y: { ticks: { precision: 0 } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { precision: 0, maxTicksLimit: 5 } },
      },
    },
  });
}

function paintHeader() {
  const el = qs('#astu-head', state.el);
  if (!el) return;
  const { user } = state.data;
  render(el, html`
    ${pageHeader({
      breadcrumb: [{ label: 'Alunos', href: '/admin/alunos' }, { label: user.name }],
      title: user.name,
      subtitle: user.email,
      actions: headerActions(),
    })}
    ${statusBadges()}`);
  if (state.menu && typeof state.menu.destroy === 'function') state.menu.destroy();
  const more = qs('#astu-more', el);
  if (more) {
    state.menu = dropdown(more, [
      { label: 'Liberar acesso', icon: 'unlock', onClick: () => grantAccess() },
      { label: 'Redefinir senha', icon: 'key', onClick: () => resetPassword() },
      { divider: true },
      { label: 'Excluir aluno', icon: 'trash-2', danger: true, onClick: () => removeStudent() },
    ]);
  }
}

function paint() {
  render(state.el, html`
    <div class="astu-page">
    <div id="astu-head"></div>
    ${metricsRow()}
    <div class="grid grid-2 astu-grid">
      ${activityCard()}
      ${accessCard()}
    </div>
    <section class="card astu-form-card">
      <div class="card-header">
        <h2 class="card-title">${icon('user')}<span>Dados e preferências de estudo</span></h2>
      </div>
      <div class="card-body" id="astu-form"></div>
    </section>
    <div class="grid grid-2 astu-grid">
      ${activityListCard()}
      ${essaysCard()}
    </div>
    ${subjectsCard()}
    </div>`);

  paintHeader();
  drawChart();
  if (state.form) state.form.destroy();
  state.form = buildForm(qs('#astu-form', state.el), formFields(), {
    values: formValues(),
    submitLabel: 'Salvar alterações',
    submitIcon: 'save',
    onSubmit: submitProfile,
  });
}

async function load() {
  render(state.el, skeleton('page'));
  try {
    const [detail, progress] = await Promise.all([
      api.get(`/api/admin/students/${state.id}`),
      api.get(`/api/admin/students/${state.id}/progress`).catch(() => ({ by_subject: [], activity_by_day: [] })),
    ]);
    state.data = detail;
    state.progress = progress;
  } catch (err) {
    render(state.el, html`
      ${pageHeader({ breadcrumb: [{ label: 'Alunos', href: '/admin/alunos' }, { label: 'Aluno' }], title: 'Aluno' })}
      ${errorState({
        title: err && err.status === 404 ? 'Aluno não encontrado' : 'Não foi possível carregar o aluno',
        message: err && err.message ? err.message : 'Verifique sua conexão e tente novamente.',
      })}`);
    return;
  }
  paint();
}

export default async function renderStudent(ctx) {
  state = {
    el: ctx.el,
    id: ctx.params.id,
    navigate: ctx.navigate,
    data: null,
    progress: null,
    exams: [],
    subjects: [],
    form: null,
    menu: null,
  };
  ctx.setTitle('Aluno');

  on(ctx.el, 'click', '[data-action]', (event, target) => {
    const action = target.dataset.action;
    if (action === 'block' || action === 'unblock') toggleBlock();
    else if (action === 'grant') grantAccess();
    else if (action === 'reset-password') resetPassword();
    else if (action === 'retry') load();
  });

  const [exams, subjects] = await Promise.all([
    api.get('/api/admin/exams').then((r) => (Array.isArray(r) ? r : r.items || [])).catch(() => []),
    api.get('/api/admin/content/subjects', { query: { active: 'true' } }).then((r) => (Array.isArray(r) ? r : r.items || [])).catch(() => []),
  ]);
  state.exams = exams;
  state.subjects = subjects;
  await load();
  if (state && state.data) ctx.setTitle(state.data.user.name);
}

export function unmount() {
  if (state) {
    if (state.form) state.form.destroy();
    if (state.menu && typeof state.menu.destroy === 'function') state.menu.destroy();
    if (state.el) destroyChart(qs('#astu-activity', state.el));
  }
  state = null;
}
