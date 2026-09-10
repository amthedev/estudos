// =====================================================================
// Foco Elite — /app/materias/:subjectId
// Cabeçalho da matéria com anel de progresso e indicadores, seguido da
// lista de assuntos do syllabus (progresso, número de aulas, acurácia e
// botão Estudar). Dados de GET /api/subjects/:id.
// =====================================================================
import { api } from '../../core/api.js';
import { html, render, qs, on, pageHeader, emptyState, errorState, skeleton, progressBar, badge, ring } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMinutes, pluralize } from '../../core/format.js';
import { accentStyle, accuracyTone, accuracyText, progressColor, lessonsRatio } from './subjects.js';

let cleanup = [];

function headerCard(subject) {
  const pct = Number(subject.progress_pct) || 0;
  const accuracy = subject.accuracy_pct;
  const next = subject.next_lesson;
  return html`
    <section class="card subj-hero" ${accentStyle(subject.color)}>
      <div class="subj-hero-ring">
        ${ring(pct, { size: 'lg', color: pct >= 100 ? 'success' : '' })}
        <span class="subj-hero-ring-label">do conteúdo concluído</span>
      </div>
      <div class="subj-hero-main">
        <div class="subj-hero-title">
          <span class="icon-box subj-icon">${icon(subject.icon || 'book-open')}</span>
          <div>
            <h2 class="subj-hero-name">${subject.name}</h2>
            ${subject.area_name ? html`<span class="subj-card-area">${subject.area_name}</span>` : ''}
          </div>
        </div>
        ${subject.description ? html`<p class="subj-hero-desc">${subject.description}</p>` : ''}
        <dl class="subj-hero-stats">
          <div>
            <dt>Aulas</dt>
            <dd>${lessonsRatio(subject.lessons_done, subject.lessons_total, { empty: 'Nenhuma aula' })}</dd>
          </div>
          <div>
            <dt>Tempo concluído</dt>
            <dd>${fmtMinutes(subject.minutes_done)} de ${fmtMinutes(subject.minutes_total)}</dd>
          </div>
          <div>
            <dt>Acertos em questões</dt>
            <dd class="tone-${accuracyTone(accuracy)}">${accuracyText(accuracy, { empty: 'Sem dados' })}</dd>
          </div>
          <div>
            <dt>Questões respondidas</dt>
            <dd>${pluralize(subject.questions_answered || 0, 'questão', 'questões')}</dd>
          </div>
        </dl>
        <div class="subj-hero-actions">
          ${next
            ? html`
              <a class="btn btn-primary" href="/app/aulas/${next.id}">
                ${icon('play')}<span>${next.status === 'in_progress' ? 'Continuar aula' : 'Começar a estudar'}</span>
              </a>
              <span class="subj-hero-next">${next.title}</span>`
            : html`<a class="btn btn-secondary" href="/app/aulas?subject_id=${subject.id}">${icon('play')}<span>Ver aulas da matéria</span></a>`}
          <a class="btn btn-ghost" href="/app/questoes?subject_id=${subject.id}">${icon('file-text')}<span>Questões desta matéria</span></a>
        </div>
      </div>
    </section>`;
}

function topicRow(subject, topic) {
  const pct = Number(topic.progress_pct) || 0;
  const total = Number(topic.lessons_total) || 0;
  const accuracy = topic.accuracy_pct;
  const href = `/app/materias/${subject.id}/assuntos/${topic.id}`;
  return html`
    <li class="card subj-topic" ${accentStyle(subject.color)}>
      <div class="subj-topic-main">
        <div class="subj-topic-head">
          <h3 class="subj-topic-title"><a href="${href}">${topic.name}</a></h3>
          ${pct >= 100 && total > 0 ? badge('Concluído', 'green', { icon: 'circle-check' }) : ''}
        </div>
        ${topic.description ? html`<p class="subj-topic-desc clamp-2">${topic.description}</p>` : ''}
        <div class="subj-topic-meta">
          <span>${icon('play', { size: 14 })}${lessonsRatio(topic.lessons_done, topic.lessons_total, { empty: 'Sem aulas ainda' })}</span>
          ${Number(topic.subtopics_count) > 0
            ? html`<span>${icon('list', { size: 14 })}${pluralize(topic.subtopics_count, 'subassunto', 'subassuntos')}</span>`
            : ''}
          <span class="tone-${accuracyTone(accuracy)}">${icon('target', { size: 14 })}${accuracyText(accuracy, { empty: 'Sem dados de acerto' })}</span>
        </div>
        <div class="subj-topic-progress">${progressBar(pct, { color: progressColor(pct), size: 'sm' })}</div>
      </div>
      <div class="subj-topic-actions">
        <a class="btn btn-secondary" href="${href}">${icon('book-open')}<span>Estudar</span></a>
      </div>
    </li>`;
}

export default async function renderPage(ctx) {
  const { el, params } = ctx;
  const subjectId = params.subjectId;
  const state = { subject: null, loading: true, error: null };

  render(el, html`<div class="subj-detail" data-body></div>`);
  const body = qs('[data-body]', el);

  function paint() {
    if (state.loading) {
      render(body, html`${skeleton('header')}${skeleton('card')}${skeleton('list', 4)}`);
      return;
    }
    if (state.error) {
      render(body, errorState({ message: state.error }));
      return;
    }
    const subject = state.subject;
    const topics = Array.isArray(subject.topics) ? subject.topics : [];
    render(
      body,
      html`
        ${pageHeader({
          title: subject.name,
          subtitle: subject.in_exam
            ? 'Assuntos cobrados na sua prova, na ordem sugerida de estudo.'
            : 'Todos os assuntos desta matéria.',
          breadcrumb: [{ label: 'Matérias', href: '/app/materias' }, { label: subject.name }],
        })}
        ${headerCard(subject)}
        <h2 class="section-title">Assuntos</h2>
        ${topics.length
          ? html`<ul class="list-plain subj-topics">${topics.map((topic) => topicRow(subject, topic))}</ul>`
          : emptyState({
              icon: 'book-open',
              title: 'Nenhum assunto disponível',
              text: 'Esta matéria ainda não tem assuntos publicados para a sua prova.',
              action: { label: 'Voltar às matérias', href: '/app/materias', icon: 'arrow-left', variant: 'secondary' },
            })}`
    );
    ctx.setTitle(subject.name);
  }

  async function load() {
    state.loading = true;
    state.error = null;
    paint();
    try {
      state.subject = await api.get(`/api/subjects/${encodeURIComponent(subjectId)}`);
      state.loading = false;
    } catch (err) {
      state.loading = false;
      state.error = err && err.message ? err.message : 'Não foi possível carregar esta matéria.';
    }
    paint();
  }

  cleanup.push(on(el, 'click', '[data-action="retry"]', () => load()));

  await load();
}

export async function unmount() {
  for (const fn of cleanup) {
    try {
      fn();
    } catch {
      /* limpeza best-effort */
    }
  }
  cleanup = [];
}
