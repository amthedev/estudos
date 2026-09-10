// =====================================================================
// Foco Elite — /app/materias/:subjectId/assuntos/:topicId
// Assunto: cabeçalho com progresso, provas onde cai e favorito; aulas
// agrupadas por subassunto; atalhos para questões e para o Tutor IA.
// Dados de GET /api/topics/:id.
// =====================================================================
import { api } from '../../core/api.js';
import { html, render, qs, on, pageHeader, emptyState, errorState, skeleton, progressBar, badge } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { pluralize } from '../../core/format.js';
import { accentStyle, accuracyTone, accuracyText, progressColor, lessonsRatio } from './subjects.js';
import { lessonCard, favoriteButton, bindFavorites } from './lessons.js';

const NO_SUBTOPIC = '__geral__';

let cleanup = [];

/** Agrupa as aulas por subassunto, mantendo a ordem dos subassuntos do assunto. */
function groupLessons(topic) {
  const lessons = Array.isArray(topic.lessons) ? topic.lessons : [];
  const subtopics = Array.isArray(topic.subtopics) ? topic.subtopics : [];
  const groups = subtopics.map((subtopic) => ({
    id: subtopic.id,
    name: subtopic.name,
    description: subtopic.description,
    lessons: lessons.filter((lesson) => lesson.subtopic_id === subtopic.id),
  }));
  const loose = lessons.filter((lesson) => !lesson.subtopic_id || !subtopics.some((s) => s.id === lesson.subtopic_id));
  if (loose.length) {
    groups.unshift({ id: NO_SUBTOPIC, name: 'Visão geral do assunto', description: '', lessons: loose });
  }
  return groups;
}

function headerCard(topic, subjectColor) {
  const pct = Number(topic.progress_pct) || 0;
  const exams = Array.isArray(topic.exams) ? topic.exams : [];
  return html`
    <section class="card subj-hero topic-hero" ${accentStyle(subjectColor)}>
      <div class="subj-hero-main">
        ${topic.description ? html`<p class="subj-hero-desc">${topic.description}</p>` : ''}
        ${exams.length
          ? html`
            <div class="topic-exams">
              <span class="topic-exams-label">Cai em</span>
              <div class="topic-exams-list">${exams.map((exam) => badge(exam.short_name || exam.name, 'blue'))}</div>
            </div>`
          : ''}
        <dl class="subj-hero-stats">
          <div>
            <dt>Aulas</dt>
            <dd>${lessonsRatio(topic.lessons_done, topic.lessons_total, { empty: 'Nenhuma aula' })}</dd>
          </div>
          <div>
            <dt>Questões disponíveis</dt>
            <dd>${pluralize(topic.questions_total || 0, 'questão', 'questões')}</dd>
          </div>
          <div>
            <dt>Seu aproveitamento</dt>
            <dd class="tone-${accuracyTone(topic.accuracy_pct)}">${accuracyText(topic.accuracy_pct, { empty: 'Sem dados' })}</dd>
          </div>
        </dl>
        <div class="topic-progress">${progressBar(pct, { label: 'Progresso no assunto', color: progressColor(pct) })}</div>
        <div class="subj-hero-actions">
          <a class="btn btn-primary" href="/app/tutor?topic_id=${topic.id}">${icon('bot')}<span>Perguntar ao Tutor sobre este assunto</span></a>
          ${Number(topic.questions_total) > 0
            ? html`<a class="btn btn-secondary" href="/app/questoes?subject_id=${topic.subject_id}&topic_id=${topic.id}">${icon('file-text')}<span>Praticar questões</span></a>`
            : ''}
          ${favoriteButton('topic', topic.id, topic.favorited, { label: 'assunto' })}
        </div>
      </div>
    </section>`;
}

function groupSection(group, subjectColor) {
  return html`
    <section class="topic-group">
      <header class="topic-group-head">
        <h2 class="topic-group-title">${group.name}</h2>
        <span class="topic-group-count">${group.lessons.length ? pluralize(group.lessons.length, 'aula', 'aulas') : 'Sem aulas'}</span>
      </header>
      ${group.description ? html`<p class="topic-group-desc">${group.description}</p>` : ''}
      ${group.lessons.length
        ? html`<div class="lsn-list">${group.lessons.map((lesson) =>
            lessonCard({ ...lesson, subject_color: lesson.subject_color || subjectColor }, { showSubject: false })
          )}</div>`
        : html`<p class="topic-group-empty">${icon('circle-dashed', { size: 14 })}<span>Nenhuma aula publicada neste subassunto ainda.</span></p>`}
    </section>`;
}

export default async function renderPage(ctx) {
  const { el, params } = ctx;
  const topicId = params.topicId;
  const subjectId = params.subjectId;
  const state = { topic: null, loading: true, error: null };

  render(el, html`<div class="topic-page" data-body></div>`);
  const body = qs('[data-body]', el);

  function paint() {
    if (state.loading) {
      render(body, html`${skeleton('header')}${skeleton('card')}${skeleton('list', 3)}`);
      return;
    }
    if (state.error) {
      render(body, errorState({ message: state.error }));
      return;
    }
    const topic = state.topic;
    const subject = topic.subject || {};
    const groups = groupLessons(topic);
    const hasLessons = groups.some((group) => group.lessons.length > 0);
    render(
      body,
      html`
        ${pageHeader({
          title: topic.name,
          subtitle: subject.name ? `${subject.name}${subject.area_name ? ` · ${subject.area_name}` : ''}` : '',
          breadcrumb: [
            { label: 'Matérias', href: '/app/materias' },
            { label: subject.name || 'Matéria', href: `/app/materias/${subjectId || topic.subject_id}` },
            { label: topic.name },
          ],
        })}
        ${headerCard(topic, subject.color)}
        ${hasLessons
          ? html`<div class="topic-groups">${groups.map((group) => groupSection(group, subject.color))}</div>`
          : emptyState({
              icon: 'play',
              title: 'Nenhuma aula publicada neste assunto',
              text: Number(topic.questions_total) > 0
                ? 'Você ainda pode praticar as questões deste assunto ou tirar dúvidas com o Tutor IA.'
                : 'Assim que as aulas deste assunto forem publicadas, elas aparecem aqui.',
              action: Number(topic.questions_total) > 0
                ? { label: 'Praticar questões', href: `/app/questoes?subject_id=${topic.subject_id}&topic_id=${topic.id}`, icon: 'file-text' }
                : { label: 'Voltar à matéria', href: `/app/materias/${subjectId || topic.subject_id}`, icon: 'arrow-left', variant: 'secondary' },
            })}`
    );
    ctx.setTitle(topic.name);
  }

  async function load() {
    state.loading = true;
    state.error = null;
    paint();
    try {
      state.topic = await api.get(`/api/topics/${encodeURIComponent(topicId)}`);
      state.loading = false;
    } catch (err) {
      state.loading = false;
      state.error = (err && err.message) || 'Não foi possível carregar este assunto.';
    }
    paint();
  }

  cleanup.push(
    on(el, 'click', '[data-action="retry"]', () => load()),
    bindFavorites(el, (type, id, favorited) => {
      if (!state.topic) return;
      if (type === 'topic' && id === state.topic.id) state.topic.favorited = favorited;
      if (type === 'lesson') {
        const lesson = (state.topic.lessons || []).find((item) => item.id === id);
        if (lesson) lesson.favorited = favorited;
      }
    })
  );

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
