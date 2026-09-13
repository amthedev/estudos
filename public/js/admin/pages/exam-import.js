// =====================================================================
// Foco Elite — Admin › Ler prova em PDF (ARCHITECTURE §6.5)
//
// Transforma o PDF de uma prova já aplicada em questões do banco, sem
// digitar uma a uma. Quatro passos na mesma tela:
//
//   1. Identificar a prova (nome, vestibular, ano) e colar o gabarito.
//   2. Escolher o PDF. O texto é lido AQUI, no navegador — o arquivo não
//      é enviado para a IA.
//   3. Varrer: a prova é percorrida em lotes, com barra de progresso. Dá
//      para parar e continuar depois de onde parou.
//   4. Conferir as questões encontradas e mandar para o banco.
//
// APIs: /api/admin/exam-imports (criar, enviar texto, varrer, conferir,
// importar) e /api/admin/uploads para guardar o PDF.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, qs, qsa, on, toast, confirm,
  pageHeader, skeleton, setLoading, badge, alertBox, emptyState, progressBar,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDateTime, fmtNumber, truncate, pluralize } from '../../core/format.js';
import { extractPdfText, splitForUpload, PdfSemTexto } from '../../components/pdf-text.js';
import { uploadFile } from '../../components/file-input.js';

let cleanup = [];
let state = null;

const STATUS_BADGE = {
  lendo: ['Recebendo o texto', 'gray'],
  pronta: ['Pronta para varrer', 'blue'],
  extraindo: ['Varrendo', 'orange'],
  concluida: ['Varredura concluída', 'green'],
  falhou: ['Falhou', 'red'],
};

const ITEM_BADGE = {
  pendente: ['Aguardando conferência', 'blue'],
  importada: ['No banco de questões', 'green'],
  recusada: ['Descartada', 'gray'],
  falhou: ['Não entrou', 'red'],
};

// ---------------------------------------------------------------------
// Passo 1 — identificar a prova
// ---------------------------------------------------------------------
function newImportForm() {
  return html`
    <section class="card xim-form">
      <div class="card-header">
        <h2 class="card-title">Nova leitura de prova</h2>
        <p class="card-subtitle">Um PDF por vez. Para o ENEM, uma leitura por dia de prova.</p>
      </div>
      <div class="card-body">
        <div class="grid grid-2">
          <div class="field">
            <label class="label" for="xim-title">Nome desta leitura</label>
            <input class="input" id="xim-title" name="title" maxlength="200" placeholder="ENEM 2024 — segundo dia">
            <span class="hint">É só para você se achar depois.</span>
          </div>
          <div class="field">
            <label class="label" for="xim-prova">Aproveitar uma prova já cadastrada</label>
            <select class="select" id="xim-prova" name="past_exam_id">
              <option value="">Não — vou escolher o arquivo</option>
              ${(state.provas || []).map(
                (p) => html`<option value="${p.id}" ${p.id === state.provaEscolhida ? 'selected' : ''}>
                    ${p.title}${p.leituras ? ` · já lida ${p.leituras}x` : ''}
                  </option>`
              )}
            </select>
            <span class="hint">
              As provas de <strong>Provas anteriores</strong> que já têm PDF aparecem aqui. Escolher uma
              preenche os campos e dispensa enviar o arquivo de novo.
            </span>
          </div>
          <div class="field">
            <label class="label" for="xim-exam">Vestibular</label>
            <select class="select" id="xim-exam" name="exam_id">
              <option value="">Nenhum (só para o banco)</option>
              ${(state.exams || []).map((e) => html`<option value="${e.id}">${e.name}</option>`)}
            </select>
            <span class="hint">As questões passam a cair neste vestibular.</span>
          </div>
          <div class="field">
            <label class="label" for="xim-year">Ano da prova</label>
            <input class="input" id="xim-year" name="year" type="number" min="1950" max="2100" inputmode="numeric" placeholder="2024">
          </div>
          <div class="field">
            <label class="label" for="xim-board">Banca</label>
            <input class="input" id="xim-board" name="board" maxlength="80" placeholder="INEP">
          </div>
        </div>
        <div class="field">
          <label class="label" for="xim-key">Gabarito oficial</label>
          <textarea class="textarea" id="xim-key" name="answer_key" rows="4"
                    placeholder="1-A 2-B 3-C 4-D 5-E…"></textarea>
          <span class="hint">
            ${icon('triangle-alert', { size: 14 })}
            Cole o gabarito da prova. Sem ele, a IA tem que <strong>resolver</strong> cada questão para marcar a
            resposta — e erra com confiança. Com o gabarito, ela só transcreve.
          </span>
        </div>
        <div class="xim-form-actions">
          <button type="button" class="btn btn-primary" data-action="create">
            ${icon('plus')}<span>Criar leitura</span>
          </button>
        </div>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------
// Passo 2 e 3 — o PDF e a varredura
// ---------------------------------------------------------------------
function readStep() {
  const job = state.current;
  const lido = Number(job.chars_total) > 0;

  if (!lido) {
    return html`
      <section class="card xim-step">
        <div class="card-body">
          <h2 class="xim-step-title">${icon('file-up')}<span>Escolha o PDF da prova</span></h2>
          <p class="xim-step-text">
            O texto é lido aqui no seu navegador e só o texto sobe para a plataforma.
            Um PDF de prova inteira leva alguns segundos.
          </p>
          ${job.past_exam_id
            ? html`
              <div class="xim-from-exam">
                <p class="xim-step-text">
                  ${icon('file', { size: 14 })}
                  <span>Esta leitura está ligada a uma prova já cadastrada. O arquivo já está na
                  plataforma — não precisa enviar de novo.</span>
                </p>
                <button type="button" class="btn btn-primary" data-action="read-exam" ${state.busy ? 'disabled' : ''}>
                  ${icon('scan-text')}<span>Ler o PDF desta prova</span>
                </button>
              </div>
              <div class="xim-or"><span>ou envie outro arquivo</span></div>`
            : ''}
          <input type="file" accept="application/pdf" id="xim-file" class="xim-file" ${state.busy ? 'disabled' : ''}>
          ${state.readProgress
            ? html`<div class="xim-progress">
                ${progressBar(state.readProgress.percent, { label: `Lendo página ${state.readProgress.page} de ${state.readProgress.total}`, showValue: true })}
              </div>`
            : ''}
          ${state.readError
            ? alertBox({
                type: 'danger',
                title: 'Não deu para ler este PDF',
                text: state.readError,
              })
            : ''}

          <div class="xim-or"><span>ou</span></div>

          <div class="field">
            <label class="label" for="xim-paste">Cole o texto da prova</label>
            <textarea class="textarea" id="xim-paste" name="paste" rows="6"
                      placeholder="QUESTÃO 1&#10;Enunciado…&#10;A) …&#10;B) …"
                      ${state.busy ? 'disabled' : ''}></textarea>
            <span class="hint">
              Serve para prova em Word, em página da internet ou digitalizada que você já passou por um
              leitor. Cole tudo de uma vez, na ordem das questões.
            </span>
          </div>
          <button type="button" class="btn btn-secondary" data-action="use-text" ${state.busy ? 'disabled' : ''}>
            ${icon('clipboard-list')}<span>Usar este texto</span>
          </button>
        </div>
      </section>`;
  }

  const done = job.status === 'concluida';
  return html`
    <section class="card xim-step">
      <div class="card-body">
        <h2 class="xim-step-title">${icon('scan-text')}<span>Varredura da prova</span></h2>
        <div class="xim-progress">
          ${progressBar(job.percent || 0, { label: 'Texto varrido', showValue: true, color: done ? 'success' : '' })}
        </div>
        <dl class="xim-stats">
          <div><dt>Texto</dt><dd>${fmtNumber(job.chars_total)} caracteres</dd></div>
          <div><dt>Questões encontradas</dt><dd>${fmtNumber(job.found_count)}</dd></div>
          <div><dt>Já no banco</dt><dd>${fmtNumber(job.imported_count)}</dd></div>
          ${job.last_number ? html`<div><dt>Última questão lida</dt><dd>nº ${job.last_number}</dd></div>` : ''}
        </dl>
        ${job.error_message
          ? alertBox({
              type: 'warning',
              title: 'A última varredura parou',
              text: `${job.error_message} Nada se perdeu: continuar retoma do mesmo ponto.`,
            })
          : ''}
        ${!job.answer_key_count
          ? alertBox({
              type: 'warning',
              title: 'Esta leitura está sem gabarito oficial',
              text: 'As respostas foram deduzidas pela IA. Confira uma a uma antes de mandar para o banco.',
            })
          : ''}
        <div class="xim-step-actions">
          ${done
            ? html`<span class="xim-done">${icon('circle-check')}<span>Prova varrida por inteiro</span></span>`
            : html`
              <button type="button" class="btn btn-primary" data-action="sweep" ${state.busy ? 'disabled' : ''}>
                ${icon('play')}<span>${job.chars_read > 0 ? 'Continuar de onde parou' : 'Começar a varrer'}</span>
              </button>
              <button type="button" class="btn btn-secondary" data-action="sweep-all" ${state.busy ? 'disabled' : ''}>
                ${icon('fast-forward')}<span>Varrer a prova inteira</span>
              </button>`}
        </div>
        ${state.busy
          ? html`<p class="xim-busy" role="status" aria-live="polite">
              <span class="spinner" aria-hidden="true"></span>
              <span>${state.busyText || 'Trabalhando…'}</span>
            </p>`
          : ''}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------
// Passo 4 — conferência
// ---------------------------------------------------------------------
/** Assuntos da matéria escolhida, para o segundo seletor. */
function assuntosDe(subjectSlug) {
  const materia = (state.taxonomia || []).find((m) => m.slug === subjectSlug);
  return materia ? materia.topics : [];
}

/**
 * Como a classificação da questão aparece.
 *
 * O nome vem da taxonomia quando o identificador existe. Quando não existe, é
 * porque a IA classificou num assunto que não está cadastrado — e aí o selo
 * precisa gritar, porque é isso que impede a questão de entrar no banco.
 */
function classificacaoBadge(payload) {
  const materia = (state.taxonomia || []).find((m) => m.slug === payload.subject_slug);
  const assunto = materia ? materia.topics.find((t) => t.slug === payload.topic_slug) : null;
  if (materia && assunto) return badge(`${materia.name} › ${assunto.name}`, 'gray');
  if (!payload.subject_slug && !payload.topic_slug) return badge('Sem classificação', 'red', { icon: 'triangle-alert' });
  return badge('Assunto não cadastrado — escolha abaixo', 'red', { icon: 'triangle-alert' });
}

function itemRow(item) {
  const payload = item.payload || {};
  const letras = ['A', 'B', 'C', 'D', 'E'].filter((letra) => payload[letra]);
  const pendente = item.status === 'pendente';
  const semGabarito = pendente && !payload.answer_from_key;
  const [rotulo, tom] = ITEM_BADGE[item.status] || ITEM_BADGE.pendente;

  return html`
    <article class="xim-item${semGabarito ? ' is-unsure' : ''}" data-item="${item.id}">
      <header class="xim-item-head">
        <label class="check">
          <input type="checkbox" data-pick="${item.id}" ${pendente ? '' : 'disabled'}>
          <span>Questão ${item.number || '—'}</span>
        </label>
        <div class="xim-item-tags">
          ${badge(rotulo, tom)}
          ${classificacaoBadge(payload)}
          ${semGabarito ? badge('Gabarito deduzido pela IA', 'orange', { icon: 'triangle-alert' }) : ''}
        </div>
      </header>
      <p class="xim-item-statement">${truncate(payload.statement || '', 400)}</p>
      <ol class="xim-item-options">
        ${letras.map(
          (letra) => html`
            <li class="${payload.correct === letra ? 'is-correct' : ''}">
              <strong>${letra}</strong><span>${truncate(payload[letra], 200)}</span>
            </li>`
        )}
      </ol>
      ${item.error_message ? html`<p class="xim-item-error">${icon('circle-x', { size: 14 })}<span>${item.error_message}</span></p>` : ''}
      ${pendente || item.status === 'falhou'
        ? html`
          <footer class="xim-item-actions">
            <label class="xim-inline">
              <span>Matéria</span>
              <select class="select select-sm" data-action="fix-subject" data-item="${item.id}">
                <option value="">Escolha</option>
                ${(state.taxonomia || []).map(
                  (m) => html`<option value="${m.slug}" ${payload.subject_slug === m.slug ? 'selected' : ''}>${m.name}</option>`
                )}
              </select>
            </label>
            <label class="xim-inline">
              <span>Assunto</span>
              <select class="select select-sm" data-action="fix-topic" data-item="${item.id}">
                <option value="">Escolha</option>
                ${assuntosDe(payload.subject_slug).map(
                  (t) => html`<option value="${t.slug}" ${payload.topic_slug === t.slug ? 'selected' : ''}>${t.name}</option>`
                )}
              </select>
            </label>
            <label class="xim-inline">
              <span>Gabarito</span>
              <select class="select select-sm" data-action="fix-correct" data-item="${item.id}">
                ${letras.map((letra) => html`<option value="${letra}" ${payload.correct === letra ? 'selected' : ''}>${letra}</option>`)}
              </select>
            </label>
            <button type="button" class="btn btn-ghost btn-sm" data-action="reject" data-item="${item.id}">
              ${icon('trash-2')}<span>Descartar</span>
            </button>
          </footer>`
        : ''}
    </article>`;
}

function reviewStep() {
  const items = state.current.items || [];
  if (!items.length) {
    return html`
      <section class="card">
        <div class="card-body">
          ${emptyState({
            icon: 'file-search',
            title: 'Nenhuma questão encontrada ainda',
            text: 'Varra a prova para as questões aparecerem aqui.',
          })}
        </div>
      </section>`;
  }

  const counts = state.current.counts || {};
  const pendentes = items.filter((item) => item.status === 'pendente');
  const prontas = pendentes.filter((item) => item.payload && item.payload.answer_from_key);

  return html`
    <section class="card xim-review">
      <div class="card-header">
        <div>
          <h2 class="card-title">Conferência</h2>
          <p class="card-subtitle">
            ${pluralize(counts.pendentes || 0, 'questão aguardando', 'questões aguardando')} ·
            ${fmtNumber(counts.importadas || 0)} já no banco
          </p>
          ${pendentes.length
            ? html`<p class="xim-review-note">
                Questão lida ainda não é questão no banco: o aluno só vê depois que ela é
                mandada para lá.
              </p>`
            : ''}
        </div>
        <div class="xim-review-actions">
          ${prontas.length
            ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="pick-safe">
                ${icon('check-check')}<span>Marcar as ${prontas.length} com gabarito</span>
              </button>`
            : ''}
          ${pendentes.length && pendentes.length !== prontas.length
            ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="pick-all">
                ${icon('list-checks')}<span>Marcar as ${pendentes.length} pendentes</span>
              </button>`
            : ''}
          <button type="button" class="btn btn-primary" data-action="import" ${state.busy ? 'disabled' : ''}>
            ${icon('database')}<span>Mandar as marcadas para o banco</span>
          </button>
        </div>
      </div>
      <div class="card-body xim-items">
        ${items.map(itemRow)}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------
// Carga de todas as provas
// ---------------------------------------------------------------------

/** Provas cadastradas que ainda não passaram pelo leitor. */
function pendentesDeLeitura() {
  return (state.provas || []).filter((p) => !p.leituras);
}

function loteView() {
  const lote = state.lote;
  if (!lote) return '';
  const pct = lote.total ? Math.round((lote.feitas / lote.total) * 100) : 0;
  return html`
    <section class="card xim-lote" role="status" aria-live="polite">
      <div class="card-body">
        <h2 class="xim-step-title">
          ${lote.parar ? icon('circle-x') : icon('fast-forward')}
          <span>${lote.parar ? 'Parando após esta prova…' : 'Lendo as provas cadastradas'}</span>
        </h2>
        <div class="xim-progress">
          ${progressBar(pct, { label: `${lote.feitas} de ${lote.total} provas`, showValue: true })}
        </div>
        <p class="xim-step-text">${lote.atual || '—'}</p>
        <dl class="xim-stats">
          <div><dt>Questões encontradas</dt><dd>${fmtNumber(lote.encontradas)}</dd></div>
          <div><dt>Provas com problema</dt><dd>${fmtNumber(lote.falhas)}</dd></div>
        </dl>
        ${lote.terminou
          ? html`<p class="xim-done">${icon('circle-check')}<span>Carga concluída. Confira as questões em cada leitura.</span></p>`
          : html`<button type="button" class="btn btn-ghost" data-action="parar-lote">${icon('circle-x')}<span>Parar</span></button>`}
      </div>
    </section>`;
}

/**
 * Lê todas as provas cadastradas que ainda não foram lidas.
 *
 * O leitor já existia, mas exigia repetir o mesmo caminho uma vez por prova —
 * e ninguém faz isso vinte e cinco vezes. Aqui é uma operação só: para cada
 * prova, lê o gabarito oficial, lê o PDF, varre até o fim e deixa tudo na fila
 * de conferência.
 */
async function lerTodasAsProvas() {
  const pendentes = pendentesDeLeitura();
  if (!pendentes.length || state.busy) return;

  const semGabarito = pendentes.filter((p) => !p.tem_gabarito).length;
  const ok = await confirm({
    title: `Ler ${pendentes.length} provas de uma vez?`,
    message:
      `Cada prova é lida e varrida inteira, o que consome a inteligência artificial da plataforma. ` +
      (semGabarito
        ? `${semGabarito} delas não têm gabarito oficial cadastrado — nessas, as questões ficam esperando você conferir antes de irem para o banco. `
        : 'Todas têm gabarito oficial cadastrado. ') +
      'As questões conferidas pelo gabarito entram no banco sozinhas. ' +
      'Dá para parar a qualquer momento; o que já entrou fica.',
    confirmText: 'Ler todas',
  });
  if (!ok) return;

  state.lote = { total: pendentes.length, feitas: 0, encontradas: 0, noBanco: 0, aConferir: 0, falhas: 0, atual: '', parar: false, terminou: false };
  state.busy = true;
  paint();

  for (const prova of pendentes) {
    if (state.lote.parar) break;
    state.lote.atual = `Lendo ${prova.title}…`;
    paint();
    try {
      await lerProvaInteira(prova);
    } catch (err) {
      state.lote.falhas += 1;
      console.error(`[ler prova] ${prova.title}: ${err.message}`);
    }
    state.lote.feitas += 1;
    paint();
  }

  state.lote.terminou = true;
  state.lote.atual = '';
  state.busy = false;
  await loadList();
  toast(
    `${pluralize(state.lote.feitas, 'prova lida', 'provas lidas')}, ` +
      `${pluralize(state.lote.noBanco, 'questão no banco', 'questões no banco')}` +
      (state.lote.aConferir ? `, ${pluralize(state.lote.aConferir, 'esperando conferência', 'esperando conferência')}.` : '.'),
    { type: state.lote.noBanco ? 'success' : 'warning' }
  );
}

/** Uma prova, do gabarito à varredura completa. */
async function lerProvaInteira(prova) {
  const gabarito = prova.tem_gabarito ? await lerGabarito(prova.id) : null;

  const criada = await api.post('/api/admin/exam-imports', {
    title: prova.title,
    past_exam_id: prova.id,
    exam_id: prova.exam_id || undefined,
    year: prova.year || undefined,
    board: prova.board || undefined,
    answer_key: gabarito || undefined,
  });

  const { text } = await extractPdfText(`/api/admin/exam-imports/provas/${prova.id}/arquivo/prova`);
  const partes = splitForUpload(text);
  for (const [index, chunk] of partes.entries()) {
    await api.post(`/api/admin/exam-imports/${criada.id}/text`, { chunk, done: index === partes.length - 1 });
  }

  let continua = true;
  let voltas = 0;
  while (continua && voltas < 60 && !state.lote.parar) {
    voltas += 1;
    continua = await sweepOnce(criada.id);
    const atual = await api.get(`/api/admin/exam-imports/${criada.id}`);
    state.lote.atual = `${prova.title} — ${atual.percent}% · ${atual.found_count} questões`;
    paint();
  }
  const final = await api.get(`/api/admin/exam-imports/${criada.id}`);
  state.lote.encontradas += Number(final.found_count) || 0;

  // A própria varredura já manda ao banco tudo que o gabarito oficial
  // confirmou. Aqui só acumulamos o resultado para o resumo do lote.
  const pendentes = (final.items || []).filter((item) => item.status === 'pendente');
  state.lote.aConferir += pendentes.length;
  state.lote.noBanco += Number(final.imported_count) || 0;
}

// ---------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------
function listView() {
  const items = state.list || [];
  return html`
    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Leituras recentes</h2>
          ${pendentesDeLeitura().length
            ? html`<p class="card-subtitle">
                ${pluralize(pendentesDeLeitura().length, 'prova cadastrada ainda não foi lida', 'provas cadastradas ainda não foram lidas')}.
              </p>`
            : ''}
        </div>
        ${pendentesDeLeitura().length
          ? html`<button type="button" class="btn btn-secondary" data-action="ler-todas" ${state.busy ? 'disabled' : ''}>
              ${icon('fast-forward')}<span>Ler todas de uma vez</span>
            </button>`
          : ''}
      </div>
      <div class="card-body">
        ${!items.length
          ? emptyState({ icon: 'file-search', title: 'Nenhuma prova lida ainda', text: 'Crie a primeira leitura acima.' })
          : html`
            <table class="table">
              <thead>
                <tr><th>Prova</th><th>Situação</th><th class="nowrap">Encontradas</th><th class="nowrap">No banco</th><th></th></tr>
              </thead>
              <tbody>
                ${items.map((job) => {
                  const [rotulo, tom] = STATUS_BADGE[job.status] || STATUS_BADGE.lendo;
                  return html`
                    <tr>
                      <td>
                        <strong>${job.title}</strong>
                        <span class="xim-row-sub">${job.exam_short_name || '—'} · ${fmtDateTime(job.created_at)}</span>
                      </td>
                      <td>${badge(rotulo, tom)} <span class="xim-row-sub">${job.percent}%</span></td>
                      <td class="nowrap">${fmtNumber(job.found_count)}</td>
                      <td class="nowrap">
                        ${fmtNumber(job.imported_count)}
                        ${job.pending_count > 0
                          ? html`<span class="xim-row-sub xim-row-warn"
                              >${fmtNumber(job.pending_count)} fora do banco</span
                            >`
                          : ''}
                      </td>
                      <td class="nowrap">
                        <button type="button" class="btn btn-ghost btn-sm" data-action="open" data-id="${job.id}">
                          ${icon('arrow-right')}<span>Abrir</span>
                        </button>
                        <button type="button" class="btn btn-ghost btn-sm" data-action="delete" data-id="${job.id}">
                          ${icon('trash-2')}<span class="sr-only">Excluir</span>
                        </button>
                      </td>
                    </tr>`;
                })}
              </tbody>
            </table>`}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------
// Pintura
// ---------------------------------------------------------------------
function paint() {
  const el = state.ctx.el;
  if (state.loading) {
    render(el, html`${skeleton('header')}${skeleton('card')}`);
    return;
  }

  const header = pageHeader({
    title: 'Ler prova em PDF',
    subtitle: 'Transforma a prova já aplicada em questões do banco, separadas por assunto.',
    actions: state.current
      ? html`<button type="button" class="btn btn-ghost" data-action="back">${icon('arrow-left')}<span>Todas as leituras</span></button>`
      : '',
  });

  if (!state.current) {
    render(el, html`${header}${loteView()}${newImportForm()}${listView()}`);
    return;
  }

  render(
    el,
    html`
      ${header}
      <div class="xim-current">
        <div class="xim-current-head">
          <h2 class="xim-current-title">${state.current.title}</h2>
          <span class="xim-row-sub">
            ${state.current.exam_short_name || 'Sem vestibular'}${state.current.year ? ` · ${state.current.year}` : ''}
            ${state.current.answer_key_count ? ` · gabarito com ${state.current.answer_key_count} respostas` : ' · sem gabarito'}
          </span>
        </div>
        ${readStep()}
        ${reviewStep()}
      </div>`
  );

  const file = qs('#xim-file', el);
  if (file) file.addEventListener('change', () => readPdf(file.files && file.files[0]));

  const prova = qs('#xim-prova', el);
  if (prova) prova.addEventListener('change', () => preencherPelaProva(prova.value));
}

/** Escolher uma prova cadastrada preenche o resto do formulário. */
function preencherPelaProva(id) {
  state.provaEscolhida = id || null;
  const escolhida = (state.provas || []).find((p) => p.id === id);
  if (!escolhida) return;
  const el = state.ctx.el;
  const set = (name, valor) => {
    const campo = qs(`[name="${name}"]`, el);
    if (campo && !campo.value) campo.value = valor == null ? '' : String(valor);
  };
  set('title', escolhida.title);
  set('year', escolhida.year);
  set('board', escolhida.board || escolhida.exam_board);
  const exam = qs('[name="exam_id"]', el);
  if (exam && !exam.value && escolhida.exam_id) exam.value = escolhida.exam_id;
}

// ---------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------
async function loadList() {
  try {
    const [lista, exams, provas, taxonomia] = await Promise.all([
      api.get('/api/admin/exam-imports'),
      state.exams ? Promise.resolve({ items: state.exams }) : api.get('/api/admin/exams', { query: { limit: 100 } }),
      api.get('/api/admin/exam-imports/provas').catch(() => ({ items: [] })),
      state.taxonomia && state.taxonomia.length
        ? Promise.resolve({ items: state.taxonomia })
        : api.get('/api/admin/exam-imports/taxonomia').catch(() => ({ items: [] })),
    ]);
    state.list = lista.items || [];
    state.exams = Array.isArray(exams) ? exams : exams.items || [];
    state.provas = provas.items || [];
    state.taxonomia = taxonomia.items || [];
    if (state.provaEscolhida && !state.provas.some((p) => p.id === state.provaEscolhida)) {
      state.provaEscolhida = null;
    }
  } catch (err) {
    toast(err.message || 'Não foi possível carregar as leituras.', { type: 'error' });
  }
  state.loading = false;
  paint();
  if (state.provaEscolhida) preencherPelaProva(state.provaEscolhida);
}

async function openJob(id) {
  state.loading = true;
  paint();
  try {
    state.current = await api.get(`/api/admin/exam-imports/${encodeURIComponent(id)}`);
  } catch (err) {
    toast(err.message || 'Não foi possível abrir esta leitura.', { type: 'error' });
    state.current = null;
  }
  state.loading = false;
  paint();
}

async function createJob(trigger) {
  const el = state.ctx.el;
  const value = (name) => (qs(`[name="${name}"]`, el)?.value || '').trim();
  const title = value('title');
  if (title.length < 3) {
    toast('Dê um nome para esta leitura.', { type: 'warning' });
    return;
  }
  setLoading(trigger, true);
  try {
    const provaId = value('past_exam_id');
    const prova = (state.provas || []).find((p) => p.id === provaId);
    let gabarito = value('answer_key');
    // Prova cadastrada com gabarito em PDF: lê dali em vez de exigir digitação.
    if (!gabarito && prova && prova.tem_gabarito) {
      state.busy = true;
      state.busyText = 'Lendo o gabarito oficial…';
      paint();
      gabarito = (await lerGabarito(provaId)) || '';
      state.busy = false;
    }

    const criada = await api.post('/api/admin/exam-imports', {
      title,
      past_exam_id: provaId || undefined,
      exam_id: value('exam_id') || undefined,
      year: value('year') || undefined,
      board: value('board') || undefined,
      answer_key: gabarito || undefined,
    });
    state.current = { ...criada, items: [] };
    if (criada.answer_key_count) {
      toast(`Gabarito oficial lido: ${criada.answer_key_count} respostas.`, { type: 'success' });
    }
    await loadList();
  } catch (err) {
    toast(err.message || 'Não foi possível criar a leitura.', { type: 'error' });
  } finally {
    setLoading(trigger, false);
    paint();
  }
}

/**
 * Lê o PDF de uma prova já cadastrada, servido pelo próprio domínio.
 *
 * O arquivo mora no armazenamento da plataforma; buscá-lo direto de lá seria
 * barrado pela política de segurança da página, então o servidor entrega.
 */
async function readFromPastExam() {
  if (state.busy || !state.current || !state.current.past_exam_id) return;
  await lerTexto(`/api/admin/exam-imports/provas/${state.current.past_exam_id}/arquivo/prova`, {
    aoFalhar: 'Não foi possível abrir o PDF desta prova. Confira o arquivo em Provas anteriores.',
  });
}

/**
 * Lê o gabarito oficial da prova, quando ela tem um PDF de gabarito cadastrado.
 *
 * É o que dispensa digitar o gabarito à mão — e sem gabarito a IA precisa
 * RESOLVER cada questão para marcar a resposta, que é o passo em que ela erra.
 * O texto vai cru para o servidor, que já sabe interpretá-lo.
 *
 * @returns {Promise<string|null>} o texto do gabarito, ou null quando não há
 */
async function lerGabarito(provaId) {
  try {
    const { text } = await extractPdfText(`/api/admin/exam-imports/provas/${provaId}/arquivo/gabarito`);
    return text;
  } catch (err) {
    console.warn('[ler prova] gabarito não pôde ser lido:', err.message);
    return null;
  }
}

/** Lê o PDF no navegador, guarda o arquivo e sobe o texto em pedaços. */
async function readPdf(file) {
  if (!file || state.busy) return;
  // O arquivo escolhido também fica guardado, para quem quiser conferir depois.
  await lerTexto(file, { guardar: file });
}

/**
 * Caminho único de leitura: extrai o texto (de um arquivo escolhido ou de um
 * endereço servido pela plataforma), guarda o arquivo quando faz sentido e sobe
 * o texto em pedaços.
 */
async function lerTexto(origem, { guardar = null, aoFalhar = null } = {}) {
  state.busy = true;
  state.readError = null;
  state.busyText = 'Lendo o PDF…';
  paint();

  try {
    const { text, pages } = await extractPdfText(origem, (page, total) => {
      state.readProgress = { page, total, percent: Math.round((page / total) * 100) };
      const bar = qs('.xim-progress', state.ctx.el);
      if (bar) render(bar, progressBar(state.readProgress.percent, { label: `Lendo página ${page} de ${total}`, showValue: true }));
    });

    // Guardar o arquivo é conveniência, não requisito: falhar aqui não pode
    // derrubar uma leitura que já deu certo.
    let url = null;
    if (guardar) {
      try {
        const saved = await uploadFile(guardar, { folder: 'provas' });
        url = saved && saved.url;
      } catch (err) {
        console.warn('[ler prova] o PDF não pôde ser guardado:', err.message);
      }
    }

    state.busyText = `Enviando o texto (${pages} páginas)…`;
    paint();

    const partes = splitForUpload(text);
    let atualizado = null;
    for (const [index, chunk] of partes.entries()) {
      atualizado = await api.post(`/api/admin/exam-imports/${state.current.id}/text`, {
        chunk,
        done: index === partes.length - 1,
      });
    }
    if (url) atualizado.source_url = url;
    state.current = { ...state.current, ...atualizado };
    state.readProgress = null;
    toast(`Texto lido: ${fmtNumber(text.length)} caracteres em ${pages} páginas.`, { type: 'success' });
  } catch (err) {
    state.readProgress = null;
    state.readError =
      err instanceof PdfSemTexto
        ? 'Este PDF não tem texto — é uma digitalização (foto de cada página). Procure a versão original do arquivo, ou cole o texto no campo abaixo.'
        : aoFalhar || err.message || 'Não foi possível ler este arquivo.';
  } finally {
    state.busy = false;
    paint();
  }
}

/**
 * Sobe um texto colado à mão, sem PDF.
 *
 * O combinado com o cliente foi "adicionar em PDF ou em qualquer formato". O
 * PDF cobre a prova oficial; isto cobre o resto — Word, página da internet,
 * prova digitalizada que ele já passou por um leitor de texto.
 */
async function useTypedText(trigger) {
  const campo = qs('#xim-paste', state.ctx.el);
  const texto = campo ? campo.value.trim() : '';
  if (texto.length < 200) {
    toast('Cole o texto da prova — pelo menos algumas questões.', { type: 'warning' });
    return;
  }
  state.busy = true;
  state.readError = null;
  state.busyText = 'Enviando o texto…';
  setLoading(trigger, true);
  paint();
  try {
    const partes = splitForUpload(texto);
    let atualizado = null;
    for (const [index, chunk] of partes.entries()) {
      atualizado = await api.post(`/api/admin/exam-imports/${state.current.id}/text`, {
        chunk,
        done: index === partes.length - 1,
      });
    }
    state.current = { ...state.current, ...atualizado };
    toast(`Texto recebido: ${fmtNumber(texto.length)} caracteres.`, { type: 'success' });
  } catch (err) {
    state.readError = (err && err.message) || 'Não foi possível enviar este texto.';
  } finally {
    state.busy = false;
    paint();
  }
}

/**
 * Uma passada: dispara a varredura e acompanha até ela terminar.
 *
 * O servidor responde na hora e faz o trabalho solto — um trecho leva de 60 a
 * 90 segundos, mais do que a borda da hospedagem deixa uma requisição durar.
 * Segurar a requisição aberta fazia o processo ser derrubado no meio, perdendo
 * o que já tinha sido pago à IA.
 *
 * @returns {Promise<boolean>} true quando ainda há texto pela frente
 */
async function sweepOnce(importId = null) {
  const id = importId || state.current.id;
  const disparo = await api.post(`/api/admin/exam-imports/${id}/sweep`, {});
  if (disparo.done) {
    if (!importId) state.current = { ...state.current, ...disparo };
    return false;
  }

  // Acompanha pelo estado da leitura: enquanto estiver "extraindo", alguém está
  // trabalhando nela.
  for (let tentativa = 0; tentativa < 90; tentativa += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    let atual;
    try {
      atual = await api.get(`/api/admin/exam-imports/${id}`);
    } catch (err) {
      // A aplicação pode ter reiniciado; a próxima volta reencontra o estado.
      continue;
    }
    if (!importId) {
      state.current = { ...state.current, ...atual };
      paint();
    }
    if (atual.status !== 'extraindo') {
      if (atual.error_message) throw new Error(atual.error_message);
      return atual.status !== 'concluida';
    }
  }
  throw new Error('A varredura deste trecho demorou mais que o esperado. Tente continuar de onde parou.');
}

async function sweep({ all = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  state.busyText = 'Lendo as questões deste trecho…';
  paint();
  try {
    let continua = true;
    let voltas = 0;
    do {
      continua = await sweepOnce();
      voltas += 1;
      state.busyText = `Varrido ${state.current.percent}% da prova · ${state.current.found_count} questões encontradas`;
      paint();
    } while (all && continua && voltas < 60);
    if (!continua) {
      const atual = await api.get(`/api/admin/exam-imports/${state.current.id}`);
      state.current = atual;
      const importadas = Number(atual.imported_count) || 0;
      const pendentes = atual.counts ? Number(atual.counts.pendentes) || 0 : 0;
      toast(
        importadas
          ? `${pluralize(importadas, 'questão entrou', 'questões entraram')} automaticamente no banco${pendentes ? `; ${pendentes} aguardam conferência.` : '.'}`
          : 'Prova varrida por inteiro. Revise as questões antes de mandar para o banco.',
        { type: importadas ? 'success' : 'warning' }
      );
    }
  } catch (err) {
    toast(err.message || 'A varredura parou. Nada se perdeu: continue de onde parou.', { type: 'error' });
    await openJob(state.current.id);
  } finally {
    state.busy = false;
    paint();
  }
}

async function importPicked(trigger) {
  const ids = qsa('[data-pick]:checked', state.ctx.el).map((box) => box.dataset.pick);
  if (!ids.length) {
    toast('Marque as questões que devem ir para o banco.', { type: 'warning' });
    return;
  }
  setLoading(trigger, true);
  state.busy = true;
  try {
    const res = await api.post(`/api/admin/exam-imports/${state.current.id}/import`, { item_ids: ids });
    state.current = { ...state.current, ...res };
    await openJob(state.current.id);
    if (res.failed) {
      toast(`${res.imported} no banco, ${res.failed} não entraram. Veja o motivo em cada questão.`, { type: 'warning' });
    } else {
      // pluralize já traz o número na frente.
      toast(`${pluralize(res.imported, 'questão foi', 'questões foram')} para o banco.`, { type: 'success' });
    }
  } catch (err) {
    toast(err.message || 'Não foi possível gravar as questões.', { type: 'error' });
  } finally {
    setLoading(trigger, false);
    state.busy = false;
    paint();
  }
}

async function patchItem(itemId, body) {
  try {
    const atualizado = await api.patch(`/api/admin/exam-imports/${state.current.id}/items/${itemId}`, body);
    state.current.items = (state.current.items || []).map((item) => (item.id === itemId ? atualizado : item));
    paint();
  } catch (err) {
    toast(err.message || 'Não foi possível alterar esta questão.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
export default async function renderPage(ctx) {
  state = {
    ctx,
    loading: true,
    list: [],
    exams: null,
    provas: [],
    taxonomia: [],
    // Prova anterior vinda de "/admin/ler-prova?prova=<id>", quando o professor
    // chega pelo atalho da tela de Provas anteriores.
    provaEscolhida: (ctx.query && ctx.query.prova) || null,
    current: null,
    busy: false,
    busyText: '',
    readProgress: null,
    readError: null,
    lote: null,
  };
  paint();

  cleanup.push(
    on(ctx.el, 'click', '[data-action="create"]', (event, trigger) => createJob(trigger)),
    on(ctx.el, 'click', '[data-action="open"]', (event, trigger) => openJob(trigger.dataset.id)),
    on(ctx.el, 'click', '[data-action="back"]', () => {
      state.current = null;
      state.readError = null;
      paint();
    }),
    on(ctx.el, 'click', '[data-action="ler-todas"]', () => lerTodasAsProvas()),
    on(ctx.el, 'click', '[data-action="parar-lote"]', () => {
      if (state.lote) state.lote.parar = true;
      paint();
    }),
    on(ctx.el, 'click', '[data-action="read-exam"]', () => readFromPastExam()),
    on(ctx.el, 'click', '[data-action="use-text"]', (event, trigger) => useTypedText(trigger)),
    on(ctx.el, 'click', '[data-action="sweep"]', () => sweep()),
    on(ctx.el, 'click', '[data-action="sweep-all"]', () => sweep({ all: true })),
    on(ctx.el, 'click', '[data-action="import"]', (event, trigger) => importPicked(trigger)),
    on(ctx.el, 'click', '[data-action="pick-all"]', () => {
      // Prova sem gabarito oficial cadastrado — as cinco do Barro Branco são
      // assim — não tem nenhuma questão "conferida", e o atalho de cima marca
      // zero. Sem esta opção, a única saída é marcar 90 caixinhas à mão, que é
      // o mesmo que não haver saída.
      for (const box of qsa('[data-pick]', ctx.el)) {
        const item = (state.current.items || []).find((row) => row.id === box.dataset.pick);
        box.checked = Boolean(item && item.status === 'pendente');
      }
    }),
    on(ctx.el, 'click', '[data-action="pick-safe"]', () => {
      for (const box of qsa('[data-pick]', ctx.el)) {
        const item = (state.current.items || []).find((row) => row.id === box.dataset.pick);
        box.checked = Boolean(item && item.status === 'pendente' && item.payload && item.payload.answer_from_key);
      }
    }),
    on(ctx.el, 'click', '[data-action="reject"]', (event, trigger) =>
      patchItem(trigger.dataset.item, { status: 'recusada' })
    ),
    on(ctx.el, 'change', '[data-action="fix-correct"]', (event, trigger) =>
      patchItem(trigger.dataset.item, { correct: trigger.value })
    ),
    on(ctx.el, 'change', '[data-action="fix-subject"]', (event, trigger) =>
      patchItem(trigger.dataset.item, { subject_slug: trigger.value })
    ),
    on(ctx.el, 'change', '[data-action="fix-topic"]', (event, trigger) =>
      patchItem(trigger.dataset.item, { topic_slug: trigger.value })
    ),
    on(ctx.el, 'click', '[data-action="delete"]', async (event, trigger) => {
      const ok = await confirm({
        title: 'Excluir esta leitura?',
        message: 'As questões que já foram para o banco continuam lá. O que ainda não foi conferido se perde.',
        danger: true,
        confirmText: 'Excluir',
      });
      if (!ok) return;
      try {
        await api.del(`/api/admin/exam-imports/${trigger.dataset.id}`);
        if (state.current && state.current.id === trigger.dataset.id) state.current = null;
        await loadList();
      } catch (err) {
        toast(err.message || 'Não foi possível excluir.', { type: 'error' });
      }
    })
  );

  await loadList();
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
  state = null;
}
