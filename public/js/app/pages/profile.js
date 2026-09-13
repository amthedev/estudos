// =====================================================================
// /app/perfil — dados pessoais, prova e metas, rotina de estudos, troca de
// senha, situação da assinatura e saída da conta.
// Consome GET /api/auth/me, PUT /api/profile, PUT /api/profile/password,
// GET /api/exams, /api/exams/:id/subjects e /api/billing/status.
// =====================================================================
import { api } from '../../core/api.js';
import { store } from '../../core/store.js';
import {
  html, render as renderTo, toast, confirm, pageHeader, errorState, skeleton,
  badge, alertBox, qs, qsa, setLoading, applyApiErrors, clearFieldErrors, fieldError, on,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDate, fmtHours, initials, statusLabel, weekdayName, daysUntil, pluralize } from '../../core/format.js';

const LEVELS = [
  { value: 'iniciante', label: 'Iniciante — estou começando agora' },
  { value: 'intermediario', label: 'Intermediário — já estudei boa parte do conteúdo' },
  { value: 'avancado', label: 'Avançado — estou revisando para a prova' },
];

let page = null;
let me = null;
let exams = [];
let subjects = [];
let billing = null;
let offClick = null;

export default async function renderPage(ctx) {
  page = ctx;
  ctx.setTitle('Meu Perfil');
  renderTo(ctx.el, skeleton('page'));

  try {
    const [session, examList] = await Promise.all([
      api.get('/api/auth/me'),
      api.get('/api/exams').catch(() => []),
    ]);
    me = session;
    exams = Array.isArray(examList) ? examList : [];
    const examId = session && session.profile ? session.profile.exam_id : null;
    const subjectList = examId
      ? await api.get(`/api/exams/${encodeURIComponent(examId)}/subjects`).catch(() => [])
      : [];
    subjects = Array.isArray(subjectList) ? subjectList : [];
  } catch (err) {
    renderTo(
      ctx.el,
      html`${pageHeader({ title: 'Meu Perfil' })}
        ${errorState({
          title: 'Não foi possível carregar seu perfil',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
        })}`
    );
    const btn = qs('[data-action="retry"]', ctx.el);
    if (btn) btn.addEventListener('click', () => renderPage(ctx));
    return;
  }

  billing = await api.get('/api/billing/status').catch(() => null);

  if (ctx.query.checkout === 'success') {
    toast('Assinatura confirmada. Bons estudos!', { type: 'success', title: 'Tudo certo' });
  }

  paint();
}

export function unmount() {
  if (offClick) offClick();
  offClick = null;
  page = null;
  me = null;
  exams = [];
  subjects = [];
  billing = null;
}

// ---------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------
const profile = () => me.profile || {};

function selectedExam() {
  const id = profile().exam_id;
  return exams.find((e) => e.id === id) || (me.exam || null);
}

function personalCard() {
  const user = me.user || {};
  return html`
    <section class="card pr-card" id="pr-personal">
      <div class="card-header"><h2 class="card-title">Dados pessoais</h2></div>
      <form class="card-body" data-form="personal" novalidate>
        <div class="pr-identity">
          <span class="avatar avatar-lg">${initials(user.name)}</span>
          <div>
            <div class="font-semibold">${user.name}</div>
            <div class="text-3 text-sm">Na plataforma desde ${fmtDate(user.created_at)}</div>
          </div>
        </div>
        <div class="grid grid-2">
          <div class="field">
            <label class="label" for="pr-name">Nome completo</label>
            <input class="input" id="pr-name" name="name" value="${user.name || ''}" maxlength="120" autocomplete="name" required>
            <p class="error-text" data-error-for="name"></p>
          </div>
          <div class="field">
            <label class="label" for="pr-email">E-mail</label>
            <input class="input" id="pr-email" value="${user.email || ''}" readonly disabled autocomplete="email">
            <span class="hint">Para trocar o e-mail, fale com o suporte.</span>
          </div>
        </div>
        <div class="pr-actions">
          <button type="submit" class="btn btn-primary">${icon('save')}<span>Salvar dados</span></button>
        </div>
      </form>
    </section>`;
}

function examSpecificFields(exam) {
  const p = profile();
  const track = exam ? exam.track : null;

  if (track === 'barro_branco') {
    return html`
      <div class="grid grid-2">
        <div class="field">
          <label class="label" for="pr-score">Nota que você quer alcançar</label>
          <input class="input" id="pr-score" name="target_score" value="${p.target_score || ''}" maxlength="60" placeholder="Ex.: 80 pontos no exame intelectual">
        </div>
        <div class="field">
          <label class="label" for="pr-goal">Objetivo na carreira</label>
          <input class="input" id="pr-goal" name="performance_goal" value="${p.performance_goal || ''}" maxlength="500" placeholder="Ex.: ingressar como cadete em 2027">
        </div>
      </div>`;
  }

  return html`
    <div class="grid grid-3">
      <div class="field">
        <label class="label" for="pr-course">Curso pretendido</label>
        <input class="input" id="pr-course" name="target_course" value="${p.target_course || ''}" maxlength="120" placeholder="Ex.: Medicina">
      </div>
      <div class="field">
        <label class="label" for="pr-university">Instituição</label>
        <input class="input" id="pr-university" name="target_university" value="${p.target_university || ''}" maxlength="120" placeholder="Ex.: USP">
      </div>
      <div class="field">
        <label class="label" for="pr-score">Nota alvo</label>
        <input class="input" id="pr-score" name="target_score" value="${p.target_score || ''}" maxlength="60" placeholder="Ex.: 800">
      </div>
    </div>`;
}

function examCard() {
  const p = profile();
  const exam = selectedExam();
  const days = p.exam_date ? daysUntil(p.exam_date) : null;
  return html`
    <section class="card pr-card" id="pr-exam">
      <div class="card-header">
        <h2 class="card-title">Minha prova</h2>
        ${days !== null && days >= 0 ? badge(days === 0 ? 'É hoje' : `Faltam ${pluralize(days, 'dia', 'dias')}`, days <= 30 ? 'orange' : 'blue', { icon: 'calendar-days' }) : ''}
      </div>
      <form class="card-body" data-form="exam" novalidate>
        <div class="grid grid-2">
          <div class="field">
            <label class="label" for="pr-exam-id">Prova principal</label>
            <select class="select" id="pr-exam-id" name="exam_id">
              <option value="">Outro vestibular</option>
              ${exams.map((e) => html`<option value="${e.id}" ${e.id === p.exam_id ? 'selected' : ''}>${e.name}</option>`)}
            </select>
            <span class="hint">Ao trocar de prova, o cronograma é recalculado automaticamente.</span>
          </div>
          <div class="field" data-other-exam ${p.exam_id ? 'hidden' : ''}>
            <label class="label" for="pr-other">Qual vestibular?</label>
            <input class="input" id="pr-other" name="other_exam_name" value="${p.other_exam_name || ''}" maxlength="120" placeholder="Ex.: UFPR">
          </div>
        </div>
        <div class="field">
          <label class="label" for="pr-exam-date">Data da prova</label>
          <input class="input" type="date" id="pr-exam-date" name="exam_date" value="${p.exam_date || ''}">
          ${exam && exam.exam_date ? html`<span class="hint">Data prevista para ${exam.short_name}: ${fmtDate(exam.exam_date)}.</span>` : ''}
        </div>
        <div id="pr-exam-specific">${examSpecificFields(exam)}</div>
        <div class="pr-actions">
          <button type="submit" class="btn btn-primary">${icon('save')}<span>Salvar prova e metas</span></button>
        </div>
      </form>
    </section>`;
}

function routineCard() {
  const p = profile();
  const studyDays = Array.isArray(p.study_days) ? p.study_days.map(Number) : [];
  return html`
    <section class="card pr-card" id="pr-routine">
      <div class="card-header"><h2 class="card-title">Rotina de estudos</h2></div>
      <form class="card-body" data-form="routine" novalidate>
        <div class="field">
          <span class="label">Dias de estudo</span>
          <div class="check-group inline pr-days" role="group" aria-label="Dias da semana em que você estuda">
            ${[1, 2, 3, 4, 5, 6, 0].map(
              (day) => html`
                <label class="check">
                  <input type="checkbox" name="study_days" value="${day}" ${studyDays.includes(day) ? 'checked' : ''}>
                  <span>${weekdayName(day, { short: true, capitalize: true })}</span>
                </label>`
            )}
          </div>
          <p class="error-text" data-error-for="study_days"></p>
        </div>
        <div class="grid grid-3">
          <div class="field">
            <label class="label" for="pr-hours">Horas por dia</label>
            <input class="input" type="number" id="pr-hours" name="hours_per_day" min="0.5" max="16" step="0.5" value="${p.hours_per_day ?? 2}">
            <span class="hint">Hoje: ${fmtHours(p.hours_per_day || 0)} por dia de estudo.</span>
          </div>
          <div class="field">
            <label class="label" for="pr-weekly">Meta semanal (horas)</label>
            <input class="input" type="number" id="pr-weekly" name="weekly_goal_hours" min="0" max="120" step="1" value="${p.weekly_goal_hours ?? ''}">
          </div>
          <div class="field">
            <label class="label" for="pr-level">Seu nível</label>
            <select class="select" id="pr-level" name="level">
              ${LEVELS.map((l) => html`<option value="${l.value}" ${l.value === p.level ? 'selected' : ''}>${l.label}</option>`)}
            </select>
          </div>
        </div>
        <div class="grid grid-2">
          <div class="field">
            <label class="label" for="pr-weakest">Matéria com mais dificuldade</label>
            <select class="select" id="pr-weakest" name="weakest_subject_id">
              <option value="">Nenhuma em especial</option>
              ${subjects.map((s) => html`<option value="${s.id}" ${s.id === p.weakest_subject_id ? 'selected' : ''}>${s.name}</option>`)}
            </select>
            <span class="hint">Ela ganha prioridade no cronograma.</span>
          </div>
          <div class="field">
            <label class="label" for="pr-difficulty">O que mais te trava hoje?</label>
            <textarea class="textarea" id="pr-difficulty" name="main_difficulty" rows="3" maxlength="500" placeholder="Ex.: interpretação de texto em provas longas">${p.main_difficulty || ''}</textarea>
          </div>
        </div>
        <div class="pr-actions">
          <button type="submit" class="btn btn-primary">${icon('save')}<span>Salvar rotina</span></button>
        </div>
      </form>
    </section>`;
}

function passwordCard() {
  const user = me.user || {};
  return html`
    <section class="card pr-card" id="pr-password">
      <div class="card-header"><h2 class="card-title">Segurança</h2></div>
      <form class="card-body" data-form="password" novalidate>
        <input type="email" name="username" value="${user.email || ''}" autocomplete="username" hidden tabindex="-1">
        <div class="grid grid-3">
          <div class="field">
            <label class="label" for="pr-current">Senha atual</label>
            <input class="input" type="password" id="pr-current" name="current_password" autocomplete="current-password">
            <p class="error-text" data-error-for="current_password"></p>
          </div>
          <div class="field">
            <label class="label" for="pr-new">Nova senha</label>
            <input class="input" type="password" id="pr-new" name="new_password" autocomplete="new-password" minlength="8">
            <span class="hint">Mínimo de 8 caracteres.</span>
            <p class="error-text" data-error-for="new_password"></p>
          </div>
          <div class="field">
            <label class="label" for="pr-repeat">Repita a nova senha</label>
            <input class="input" type="password" id="pr-repeat" name="repeat_password" autocomplete="new-password">
            <p class="error-text" data-error-for="repeat_password"></p>
          </div>
        </div>
        <div class="pr-actions">
          <button type="submit" class="btn btn-secondary">${icon('lock')}<span>Alterar senha</span></button>
        </div>
      </form>
    </section>`;
}

function subscriptionCard() {
  const subscription = billing && billing.subscription;
  const access = (billing && billing.access) || me.access || {};
  const active = subscription && subscription.is_active;
  return html`
    <section class="card pr-card" id="pr-subscription">
      <div class="card-header"><h2 class="card-title">Assinatura</h2></div>
      <div class="card-body">
        ${active
          ? html`
              <div class="pr-sub">
                <div>
                  <div class="font-semibold">${subscription.plan_name || 'Plano ativo'}</div>
                  <div class="text-2 text-sm">
                    ${badge(statusLabel(subscription.status), subscription.status === 'trialing' ? 'blue' : 'green')}
                    ${subscription.current_period_end
                      ? html` ${subscription.cancel_at_period_end ? 'Acesso até' : 'Renova em'} ${fmtDate(subscription.current_period_end)}`
                      : ''}
                  </div>
                </div>
                <div class="pr-sub-actions">
                  <button type="button" class="btn btn-secondary" data-action="portal">${icon('credit-card')}<span>Gerenciar assinatura</span></button>
                </div>
              </div>`
          : html`
              <div class="pr-sub">
                <div>
                  <div class="font-semibold">${access.allowed ? 'Acesso liberado' : 'Sem assinatura ativa'}</div>
                  <div class="text-2 text-sm">
                    ${access.allowed && access.reason === 'override'
                      ? html`Acesso concedido pela equipe${access.access_override_until ? html` até ${fmtDate(access.access_override_until)}` : ''}.`
                      : access.allowed
                        ? 'Nenhum plano é exigido no momento.'
                        : 'Escolha um plano para liberar aulas, simulados e correção de redação.'}
                  </div>
                </div>
                <div class="pr-sub-actions">
                  <a class="btn btn-primary" href="/app/assinatura">${icon('credit-card')}<span>Ver planos</span></a>
                </div>
              </div>`}
      </div>
    </section>`;
}

function sessionCard() {
  return html`
    <section class="card pr-card pr-logout">
      <div class="card-body pr-sub">
        <div>
          <div class="font-semibold">Encerrar sessão</div>
          <div class="text-2 text-sm">Você sairá deste dispositivo. Seu progresso continua salvo.</div>
        </div>
        <button type="button" class="btn btn-ghost" data-action="logout">${icon('log-out')}<span>Sair da conta</span></button>
      </div>
    </section>`;
}

function paint() {
  const exam = selectedExam();
  renderTo(
    page.el,
    html`
      ${pageHeader({
        title: 'Meu Perfil',
        subtitle: exam ? `Preparação para ${exam.name}` : 'Configure sua prova, sua rotina e sua conta.',
      })}
      ${me.access && me.access.allowed === false
        ? alertBox({
            type: 'warning',
            title: 'Acesso bloqueado',
            text: 'Regularize sua assinatura para voltar a estudar. O perfil continua editável.',
            actions: html`<a class="btn btn-primary btn-sm" href="/app/assinatura">Ver planos</a>`,
          })
        : ''}
      <div class="pr-stack">
        ${personalCard()}
        ${examCard()}
        ${routineCard()}
        ${passwordCard()}
        ${subscriptionCard()}
        ${sessionCard()}
      </div>`
  );
  bind();
}

// ---------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------
function bind() {
  qsa('form[data-form]', page.el).forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const kind = form.dataset.form;
      if (kind === 'password') savePassword(form);
      else saveProfile(form, kind);
    });
  });

  const examSelect = qs('[name="exam_id"]', page.el);
  if (examSelect) {
    examSelect.addEventListener('change', () => {
      const other = qs('[data-other-exam]', page.el);
      if (other) other.hidden = Boolean(examSelect.value);
      const exam = exams.find((e) => e.id === examSelect.value) || null;
      const holder = qs('#pr-exam-specific', page.el);
      if (holder) renderTo(holder, examSpecificFields(exam));
    });
  }

  if (offClick) offClick();
  offClick = on(page.el, 'click', '[data-action]', (event, trigger) => {
    if (trigger.dataset.action === 'logout') logout();
    else if (trigger.dataset.action === 'portal') openPortal(trigger);
  });
}

function collect(form, kind) {
  const value = (name) => {
    const el = qs(`[name="${name}"]`, form);
    return el ? el.value.trim() : '';
  };
  const optional = (name) => {
    const el = qs(`[name="${name}"]`, form);
    if (!el) return undefined;
    const raw = el.value.trim();
    return raw === '' ? null : raw;
  };

  if (kind === 'personal') {
    const name = value('name');
    if (!name) {
      fieldError(form, 'name', 'Informe seu nome.');
      return null;
    }
    return { name };
  }

  if (kind === 'exam') {
    const payload = {};
    const examId = value('exam_id');
    payload.exam_id = examId || null;
    payload.other_exam_name = examId ? null : (optional('other_exam_name') ?? null);
    payload.exam_date = optional('exam_date');
    ['target_course', 'target_university', 'target_score', 'performance_goal'].forEach((name) => {
      const found = optional(name);
      if (found !== undefined) payload[name] = found;
    });
    return payload;
  }

  const days = qsa('[name="study_days"]:checked', form).map((el) => Number(el.value));
  if (!days.length) {
    fieldError(form, 'study_days', 'Escolha pelo menos um dia de estudo.');
    return null;
  }
  const hours = Number(value('hours_per_day'));
  if (!Number.isFinite(hours) || hours < 0.5) {
    fieldError(form, 'hours_per_day', 'Informe quantas horas por dia você consegue estudar.');
    return null;
  }
  const weekly = optional('weekly_goal_hours');
  return {
    study_days: days,
    hours_per_day: hours,
    weekly_goal_hours: weekly === null ? null : Number(weekly),
    level: value('level'),
    weakest_subject_id: optional('weakest_subject_id'),
    main_difficulty: optional('main_difficulty'),
  };
}

async function saveProfile(form, kind) {
  clearFieldErrors(form);
  const payload = collect(form, kind);
  if (!payload) return;
  const button = qs('button[type="submit"]', form);
  setLoading(button, true);
  try {
    const result = await api.put('/api/profile', payload);
    me = { ...me, user: result.user, profile: result.profile, exam: result.profile ? result.profile.exam || null : me.exam };
    store.setSession({ user: me.user, profile: me.profile, exam: me.exam });
    toast(result.schedule_regenerated ? 'Perfil salvo e cronograma recalculado.' : 'Perfil salvo.', { type: 'success' });
    if (result.schedule_regenerated) store.emit('schedule:updated');
    setLoading(button, false);
    paint();
  } catch (err) {
    setLoading(button, false);
    if (!applyApiErrors(form, err)) toast(err.message || 'Não foi possível salvar o perfil.', { type: 'error' });
  }
}

async function savePassword(form) {
  clearFieldErrors(form);
  const current = qs('[name="current_password"]', form).value;
  const next = qs('[name="new_password"]', form).value;
  const repeat = qs('[name="repeat_password"]', form).value;

  if (!current) {
    fieldError(form, 'current_password', 'Informe a senha atual.');
    return;
  }
  if (!next || next.length < 8) {
    fieldError(form, 'new_password', 'A nova senha precisa de pelo menos 8 caracteres.');
    return;
  }
  if (next !== repeat) {
    fieldError(form, 'repeat_password', 'As senhas não conferem.');
    return;
  }

  const button = qs('button[type="submit"]', form);
  setLoading(button, true);
  try {
    await api.put('/api/profile/password', { current_password: current, new_password: next });
    form.reset();
    toast('Senha alterada com sucesso.', { type: 'success' });
  } catch (err) {
    if (!applyApiErrors(form, err)) toast(err.message || 'Não foi possível alterar a senha.', { type: 'error' });
  }
  setLoading(button, false);
}

async function openPortal(button) {
  setLoading(button, true);
  try {
    const session = await api.post('/api/billing/portal', {});
    if (session && session.url) {
      window.location.assign(session.url);
      return;
    }
    toast('Não foi possível abrir o portal de assinatura.', { type: 'error' });
  } catch (err) {
    toast(err.message || 'Não foi possível abrir o portal de assinatura.', { type: 'error' });
  }
  setLoading(button, false);
}

async function logout() {
  const ok = await confirm({
    title: 'Sair da conta',
    message: 'Você precisará entrar novamente para continuar estudando.',
    confirmText: 'Sair',
    icon: 'log-out',
  });
  if (!ok) return;
  try {
    await api.post('/api/auth/logout', {}, { noRedirect: true });
  } catch {
    /* mesmo com falha, encerra a sessão local */
  }
  store.clear();
  window.location.replace('/login');
}
