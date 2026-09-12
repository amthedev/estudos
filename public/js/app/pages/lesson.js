// =====================================================================
// Foco Elite — /app/aulas/:id
// Aula em duas colunas: à esquerda o player e as abas Resumo / Minhas
// Anotações; à direita a ficha da aula (caminho, dificuldade, duração,
// provas onde cai, professor) com concluir, praticar, tutor, favorito e
// navegação entre aulas.
//
// APIs: GET /api/lessons/:id, POST /api/lessons/:id/start,
// POST /api/lessons/:id/complete, PUT /api/lessons/:id/note.
// =====================================================================
import { api } from '../../core/api.js';
import { html, render, qs, on, tabs, toast, setLoading, pageHeader, errorState, skeleton, badge } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { md } from '../../core/markdown.js';
import { fmtMinutes, fmtDateTime, pluralize } from '../../core/format.js';
import { renderVideo } from '../../components/video-player.js';
import { mountNotesEditor } from '../../components/notes-editor.js';
import { accentStyle } from './subjects.js';
import { difficultyBadge, favoriteButton, bindFavorites } from './lessons.js';

let cleanup = [];
let notesEditor = null;

function pathLine(lesson) {
  return [lesson.subject_name, lesson.topic_name, lesson.subtopic_name].filter(Boolean).join(' › ');
}

function completeButton(lesson) {
  if (lesson.completed) {
    return html`
      <div class="lsn-done" role="status">
        ${icon('circle-check', { size: 18 })}
        <div>
          <strong>Aula concluída</strong>
          ${lesson.progress && lesson.progress.completed_at
            ? html`<span class="lsn-done-date">em ${fmtDateTime(lesson.progress.completed_at)}</span>`
            : ''}
        </div>
      </div>`;
  }
  return html`
    <button type="button" class="btn btn-primary btn-block btn-lg" data-action="complete">
      ${icon('circle-check')}<span>Marcar aula como concluída</span>
    </button>`;
}

function practiceButton(lesson) {
  // A prática existe mesmo com o banco vazio: quando não há questão do assunto
  // no nível escolhido, ela é elaborada na hora.
  const available = Number(lesson.questions_available) || 0;
  const highlight = Boolean(lesson.completed);
  return html`
    <a class="btn ${highlight ? 'btn-primary' : 'btn-secondary'} btn-block" href="/app/aulas/${lesson.id}/praticar">
      ${icon('target')}<span>Pratique agora</span>
    </a>
    <p class="lsn-side-hint">
      ${icon(available ? 'list-checks' : 'sparkles', { size: 14 })}
      <span>
        ${available
          ? 'Três questões dos assuntos da aula, no nível que você escolher.'
          : 'Três questões elaboradas na hora sobre os assuntos da aula, no nível que você escolher.'}
      </span>
    </p>`;
}

function sideCard(lesson) {
  const exams = Array.isArray(lesson.exams) ? lesson.exams : [];
  return html`
    <aside class="lsn-side" ${accentStyle(lesson.subject_color)}>
      <div class="card lsn-side-card">
        <div class="card-body">
          <div class="lsn-side-path">${icon(lesson.subject_icon || 'book-open', { size: 14 })}<span>${pathLine(lesson)}</span></div>
          <div class="lsn-side-badges">
            ${difficultyBadge(lesson.difficulty)}
            ${badge(fmtMinutes(lesson.duration_min), 'gray', { icon: 'clock' })}
          </div>
          ${lesson.teacher_name
            ? html`<p class="lsn-side-teacher">${icon('user', { size: 14 })}<span>${lesson.teacher_name}</span></p>`
            : ''}
          ${exams.length
            ? html`
              <div class="lsn-side-exams">
                <span class="lsn-side-label">Cai em</span>
                <div class="lsn-side-exams-list">${exams.map((exam) => badge(exam.short_name || exam.name, 'blue'))}</div>
              </div>`
            : ''}
          <div class="lsn-side-actions" data-actions>
            ${completeButton(lesson)}
            ${practiceButton(lesson)}
            <a class="btn btn-ghost btn-block" href="/app/tutor?lesson_id=${lesson.id}">${icon('bot')}<span>Perguntar ao Tutor</span></a>
          </div>
        </div>
      </div>
      ${lesson.prev_lesson || lesson.next_lesson
        ? html`
          <nav class="card lsn-nav" aria-label="Navegação entre aulas">
            <div class="card-body">
              ${lesson.prev_lesson
                ? html`
                  <a class="lsn-nav-item" href="/app/aulas/${lesson.prev_lesson.id}">
                    ${icon('arrow-left', { size: 16 })}
                    <span class="lsn-nav-body">
                      <span class="lsn-nav-label">Aula anterior</span>
                      <span class="lsn-nav-title">${lesson.prev_lesson.title}</span>
                    </span>
                  </a>`
                : ''}
              ${lesson.next_lesson
                ? html`
                  <a class="lsn-nav-item lsn-nav-next" href="/app/aulas/${lesson.next_lesson.id}">
                    <span class="lsn-nav-body">
                      <span class="lsn-nav-label">Próxima aula</span>
                      <span class="lsn-nav-title">${lesson.next_lesson.title}</span>
                    </span>
                    ${icon('arrow-right', { size: 16 })}
                  </a>`
                : ''}
            </div>
          </nav>`
        : ''}
    </aside>`;
}

export default async function renderPage(ctx) {
  const { el, params } = ctx;
  const lessonId = params.id;
  const state = { lesson: null, loading: true, error: null, tab: 'summary' };

  render(el, html`<div class="lsn-page" data-body></div>`);
  const body = qs('[data-body]', el);

  function paintTab() {
    const panel = qs('[data-tab-panel]', body);
    if (!panel) return;
    const lesson = state.lesson;
    if (state.tab === 'notes') {
      const holder = document.createElement('div');
      holder.className = 'lsn-notes';
      render(
        holder,
        html`
          <div class="lsn-notes-guide">
            <span class="lsn-notes-guide-icon" aria-hidden="true">${icon('notebook-pen', { size: 18 })}</span>
            <div>
              <strong>Registre o que você entendeu</strong>
              <p>Explique a aula com suas palavras. Este texto entra automaticamente em Meus Resumos.</p>
            </div>
            <a class="btn btn-ghost btn-sm" href="/app/resumos">${icon('library', { size: 15 })}<span>Meus Resumos</span></a>
          </div>
          <div data-summary-editor></div>`
      );
      render(panel, holder);
      notesEditor = mountNotesEditor(qs('[data-summary-editor]', holder), {
        value: (lesson.note && lesson.note.content) || '',
        label: 'Meu resumo desta aula',
        placeholder: 'Escreva com suas palavras o que você entendeu da aula inteira, os conceitos principais e o que não pode esquecer…',
        maxLength: 50000,
        minRows: 9,
        onSave: async (content) => {
          const note = await api.put(`/api/lessons/${encodeURIComponent(lesson.id)}/note`, { content });
          lesson.note = note;
        },
      });
      return;
    }
    render(
      panel,
      lesson.summary
        ? html`<div class="md lsn-summary">${md(lesson.summary)}</div>`
        : html`
          <div class="lsn-summary-empty">
            ${icon('file-text', { size: 20 })}
            <p>Esta aula ainda não tem um resumo preparado pela equipe. Registre o que você entendeu na aba <strong>Meu Resumo</strong>.</p>
          </div>`
    );
  }

  function paint() {
    if (state.loading) {
      render(body, html`${skeleton('header')}${skeleton('block', 320)}${skeleton('text')}`);
      return;
    }
    if (state.error) {
      render(body, errorState({ message: state.error }));
      return;
    }
    const lesson = state.lesson;
    render(
      body,
      html`
        ${pageHeader({
          title: lesson.title,
          subtitle: lesson.description || '',
          breadcrumb: [
            { label: 'Aulas', href: '/app/aulas' },
            { label: lesson.subject_name, href: `/app/materias/${lesson.subject_id}` },
            { label: lesson.topic_name, href: `/app/materias/${lesson.subject_id}/assuntos/${lesson.topic_id}` },
            { label: lesson.title },
          ],
          actions: favoriteButton('lesson', lesson.id, lesson.favorited),
        })}
        <div class="lsn-layout">
          <div class="lsn-main">
            <div class="lsn-player" data-player></div>
            <div class="lsn-tabs" data-tabs></div>
            <div class="lsn-tab-panel" data-tab-panel></div>
          </div>
          ${sideCard(lesson)}
        </div>`
    );

    renderVideo(qs('[data-player]', body), {
      video_url: lesson.video_url,
      video_provider: lesson.video_provider,
      thumbnail_url: lesson.thumbnail_url,
      title: lesson.title,
    });

    state.tabsApi = tabs(
      qs('[data-tabs]', body),
      [
        { id: 'summary', label: 'Resumo da aula', icon: 'file-text' },
        { id: 'notes', label: 'Meu Resumo', icon: 'notebook-pen' },
      ],
      (id) => {
        state.tab = id;
        destroyEditor();
        paintTab();
      },
      { active: state.tab }
    );
    paintTab();
    ctx.setTitle(lesson.title);
  }

  function destroyEditor() {
    if (notesEditor && typeof notesEditor.destroy === 'function') {
      try {
        notesEditor.flush();
      } catch {
        /* melhor esforço: não bloqueia a troca de aba */
      }
      notesEditor.destroy();
    }
    notesEditor = null;
  }

  /** Repinta apenas a coluna lateral (após concluir a aula). */
  function paintSide() {
    const side = qs('.lsn-side', body);
    if (!side || !state.lesson) return;
    const holder = document.createElement('div');
    render(holder, sideCard(state.lesson));
    const next = holder.firstElementChild;
    if (next) side.replaceWith(next);
  }

  async function complete(button) {
    if (!state.lesson || state.lesson.completed) return;
    setLoading(button, true);
    button.disabled = true;
    try {
      const result = await api.post(`/api/lessons/${encodeURIComponent(state.lesson.id)}/complete`, {});
      state.lesson.completed = true;
      state.lesson.progress = result.progress || state.lesson.progress;
      paintSide();
      const reviews = Number(result.reviews_created) || 0;
      toast(
        reviews > 0
          ? `Aula concluída. ${pluralize(reviews, 'revisão agendada', 'revisões agendadas')} no seu cronograma.`
          : 'Aula concluída. Continue no ritmo.',
        { type: 'success', title: 'Bom trabalho' }
      );
      const hasSummary = Boolean(String((state.lesson.note && state.lesson.note.content) || '').trim());
      if (!hasSummary) {
        if (state.tab !== 'notes' && state.tabsApi) state.tabsApi.set('notes');
        if (notesEditor) notesEditor.focus();
      }
    } catch (err) {
      toast((err && err.message) || 'Não foi possível marcar a aula como concluída.', { type: 'error' });
      setLoading(button, false);
      button.disabled = false;
    }
  }

  async function load() {
    state.loading = true;
    state.error = null;
    paint();
    try {
      const lesson = await api.get(`/api/lessons/${encodeURIComponent(lessonId)}`);
      lesson.completed = Boolean(lesson.progress && lesson.progress.status === 'completed');
      state.lesson = lesson;
      state.loading = false;
    } catch (err) {
      state.loading = false;
      state.error = (err && err.message) || 'Não foi possível carregar esta aula.';
    }
    paint();
    if (state.lesson) {
      // registra o início da aula sem travar a tela caso falhe
      api.post(`/api/lessons/${encodeURIComponent(lessonId)}/start`, {}).catch(() => {});
    }
  }

  cleanup.push(
    on(el, 'click', '[data-action="retry"]', () => load()),
    on(el, 'click', '[data-action="complete"]', (event, button) => complete(button)),
    bindFavorites(el, (type, id, favorited) => {
      if (type === 'lesson' && state.lesson && state.lesson.id === id) state.lesson.favorited = favorited;
    }),
    () => destroyEditor()
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
