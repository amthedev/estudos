// =====================================================================
// Foco Elite — Admin › Ler prova em PDF (ARCHITECTURE §6.5)
//
// Transforma o PDF de uma prova já aplicada em questões do banco, sem
// digitar uma a uma. Três passos na mesma tela:
//
//   1. Identificar a prova (nome, vestibular, ano) e, se quiser, colar o
//      gabarito — de uma prova cadastrada, o servidor lê o PDF do gabarito.
//   2. Ler: o PDF é lido NO SERVIDOR (POST /:id/ler), com posição — as
//      figuras são recortadas, cada questão sai com enunciado, cinco
//      alternativas e alertas. Questão sem alerta e com gabarito oficial vai
//      sozinha ao banco; a tela acompanha o progresso.
//   3. Conferir o que tem alerta: o enunciado inteiro renderizado, com as
//      figuras, editar texto, trocar ou tirar figura, aprovar ou descartar.
//
// Plano B: quando o leitor do servidor não está disponível (GET /leitor), a
// tela usa o caminho antigo — o texto é lido AQUI, no navegador, sobe em
// pedaços e é varrido em lotes. O arquivo nunca vai para a IA.
//
// APIs: /api/admin/exam-imports (criar, ler, enviar texto, varrer, conferir,
// importar) e /api/admin/uploads para guardar o PDF e as figuras. Remover as
// questões de uma prova para ler de novo fica em ../remove-exam-questions.js.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, qs, qsa, on, toast, confirm, sleep,
  pageHeader, skeleton, setLoading, badge, alertBox, emptyState, progressBar,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { md, mdInline } from '../../core/markdown.js';
import { fmtDateTime, fmtNumber, pluralize } from '../../core/format.js';
import { extractPdfText, splitForUpload, PdfSemTexto } from '../../components/pdf-text.js';
import { uploadFile } from '../../components/file-input.js';
import { openRemoveExamQuestions } from '../remove-exam-questions.js';

let cleanup = [];
let state = null;

const STATUS_BADGE = {
  lendo: ['Recebendo o texto', 'gray'],
  pronta: ['Pronta para varrer', 'blue'],
  extraindo: ['Varrendo', 'orange'],
  concluida: ['Varredura concluída', 'green'],
  falhou: ['Falhou', 'red'],
};

/** A mesma situação, dita para a leitura no servidor. */
const STATUS_BADGE_LEITOR = {
  lendo: ['Aguardando o PDF', 'gray'],
  pronta: ['Parou no meio', 'orange'],
  extraindo: ['Lendo no servidor', 'orange'],
  concluida: ['Leitura concluída', 'green'],
  falhou: ['Falhou', 'red'],
};

function statusBadge(job) {
  const tabela = job.engine === 'leitor' ? STATUS_BADGE_LEITOR : STATUS_BADGE;
  const [rotulo, tom] = tabela[job.status] || tabela.lendo;
  return badge(rotulo, tom);
}

const ITEM_BADGE = {
  pendente: ['Aguardando conferência', 'blue'],
  importada: ['No banco de questões', 'green'],
  recusada: ['Descartada', 'gray'],
  falhou: ['Não entrou', 'red'],
};

const LETRAS = ['A', 'B', 'C', 'D', 'E'];
const VARIANTE = { ingles: 'Inglês', espanhol: 'Espanhol' };

/** O que a leitura no servidor está fazendo agora. */
const ETAPA = {
  baixando: 'Baixando o PDF da prova…',
  gabarito: 'Lendo o gabarito oficial…',
  lendo: 'Lendo as páginas e recortando as figuras…',
  visao: 'Lendo pela imagem as questões com alerta…',
  classificando: 'Classificando as questões e guardando as figuras…',
};

/** Alertas do leitor, em português: [selo, o que conferir]. */
const ALERTAS = {
  texto_ilegivel: ['Texto pode estar ilegível', 'A fonte deste trecho do PDF veio embaralhada. Confira o enunciado e as alternativas com a prova.'],
  alternativas_incompletas: ['Faltam alternativas', 'Uma ou mais alternativas vieram vazias. Complete com o texto da prova ou envie a figura da alternativa.'],
  numero_fora_de_sequencia: ['Número fora de sequência', 'O número desta questão não segue o da anterior. Confira se ela não foi lida em dobro ou trocada.'],
  figura_incerta: ['Figura pode estar cortada', 'A figura encosta na borda, atravessa a coluna, deixou um rótulo de fora ou há desenho que não foi para recorte nenhum. Confira o recorte e troque se precisar.'],
  texto_incerto: ['Texto pode ter perdido algo', 'O enunciado cita algo que só a formatação mostra (sublinhado, destaque, lacuna) e a marca não veio, ou há palavra partida. Confira com a prova.'],
  regiao_quebrada: ['Questão partida', 'A questão continua em outra coluna ou página e a junção pode ter falhado. Confira o enunciado inteiro.'],
  enunciado_curto: ['Enunciado curto', 'O enunciado veio curto demais: pode faltar o texto de apoio.'],
  sem_gabarito: ['Sem gabarito oficial', 'A letra marcada foi deduzida pela IA. Confira antes de aprovar.'],
};

/** Imagem em markdown: ![alt](url). */
const IMAGEM_MD = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Filtros da conferência. */
const FILTROS = [
  ['conferir', 'A conferir', (item) => item.status === 'pendente' || item.status === 'falhou'],
  ['alerta', 'Com alerta', (item) => item.status === 'pendente' && alertasDe(item).length > 0],
  ['banco', 'No banco', (item) => item.status === 'importada'],
  ['descartadas', 'Descartadas', (item) => item.status === 'recusada'],
  ['todas', 'Todas', () => true],
];

function alertasDe(item) {
  const alerts = item && item.payload && item.payload.alerts;
  return Array.isArray(alerts) ? alerts : [];
}

/**
 * [selo, explicação] de um alerta. "Sem gabarito" numa prova que TEM gabarito
 * é a questão que a folha oficial não responde — quase sempre anulada.
 */
function textoDoAlerta(codigo) {
  if (codigo === 'sem_gabarito' && state && state.current && state.current.answer_key_count) {
    return [
      'Fora do gabarito oficial',
      'O gabarito oficial não traz a letra desta questão — ela pode ter sido anulada. A letra marcada foi deduzida pela IA: confira ou descarte.',
    ];
  }
  return ALERTAS[codigo] || [codigo, ''];
}

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
                    ${p.title}${p.leitura_concluida
                      ? ' · leitura concluída'
                      : p.ultima_leitura_id
                        ? ` · ${p.ultima_leitura_percent || 0}% lida`
                        : ''}
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
            Cole o gabarito da prova (no ENEM, com as colunas de inglês e espanhol). Sem ele, a IA tem que
            <strong>resolver</strong> cada questão para marcar a resposta — e erra com confiança; essas questões
            esperam a sua conferência. Prova cadastrada com gabarito em PDF dispensa colar: ele é lido sozinho.
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
// Passo 2 — ler o PDF (no servidor; no navegador como plano B)
// ---------------------------------------------------------------------
function readStep() {
  const job = state.current;
  if (job.engine === 'leitor') return serverReadStep(job);
  const lido = Number(job.chars_total) > 0;
  if (!lido && leitorDisponivel() && !state.modoAntigo) return chooseServerStep(job);
  if (!lido) return browserChooseStep(job);
  return sweepStep(job);
}

function leitorDisponivel() {
  return Boolean(state.leitor && state.leitor.available);
}

/** Escolher o PDF para o servidor ler. */
function chooseServerStep(job) {
  const enviando = state.uploadProgress != null;
  return html`
    <section class="card xim-step">
      <div class="card-body">
        <h2 class="xim-step-title">${icon('scan-text')}<span>Ler o PDF da prova</span></h2>
        <p class="xim-step-text">
          A plataforma lê a prova inteira: separa cada questão, recorta as figuras, gráficos e tabelas e
          tira capa, cabeçalho, rodapé e redação. Questão sem nenhum alerta e com gabarito oficial vai
          direto para o banco; as outras esperam você conferir logo abaixo.
        </p>
        ${job.past_exam_id || job.source_url
          ? html`
            <div class="xim-from-exam">
              <p class="xim-step-text">
                ${icon('file', { size: 14 })}
                <span>${job.past_exam_id
                  ? 'Esta leitura está ligada a uma prova já cadastrada. O arquivo já está na plataforma — não precisa enviar de novo.'
                  : 'O PDF desta leitura já está guardado na plataforma.'}</span>
              </p>
              <button type="button" class="btn btn-primary" data-action="server-read" ${state.busy ? 'disabled' : ''}>
                ${icon('scan-text')}<span>Ler o PDF desta prova</span>
              </button>
            </div>
            <div class="xim-or"><span>ou envie outro arquivo</span></div>`
          : ''}
        <input type="file" accept="application/pdf" id="xim-file" class="xim-file" data-modo="servidor" ${state.busy ? 'disabled' : ''}>
        ${enviando
          ? html`<div class="xim-progress">${progressBar(state.uploadProgress, { label: 'Enviando o PDF', showValue: true })}</div>`
          : ''}
        ${state.readError ? alertBox({ type: 'danger', title: 'Não deu para ler este PDF', text: state.readError }) : ''}
        <p class="xim-alt-path">
          <button type="button" class="btn btn-link btn-sm" data-action="modo-antigo" ${state.busy ? 'disabled' : ''}>
            Prova digitalizada, em Word ou colada da internet? Use a leitura pelo texto.
          </button>
        </p>
      </div>
    </section>`;
}

/** O resumo do que a leitura encontrou (questões, figuras, descarte). */
function reportLine(report) {
  if (!report) return '';
  const descartado = Object.values(report.discarded || {}).reduce((n, v) => n + v, 0);
  const partes = [
    pluralize(report.questions, 'questão na prova', 'questões na prova'),
    report.variants ? `${report.variants} de espanhol` : '',
    report.figures ? pluralize(report.figures, 'figura recortada', 'figuras recortadas') : '',
    descartado ? pluralize(descartado, 'trecho de capa, cabeçalho e redação descartado', 'trechos de capa, cabeçalho e redação descartados') : '',
    report.vision && report.vision.tried
      ? `${fmtNumber(report.vision.fixed)} de ${pluralize(report.vision.tried, 'questão com alerta lida', 'questões com alerta lidas')} pela imagem`
      : '',
  ].filter(Boolean);
  return html`<p class="xim-report">${partes.join(' · ')}</p>`;
}

/** Leitura no servidor: andamento, resultado e o que fazer quando parou. */
function serverReadStep(job) {
  const counts = job.counts || {};
  const lendo = job.status === 'extraindo';
  const done = job.status === 'concluida';
  const etapa = lendo ? ETAPA[job.stage] || 'Lendo…' : '';
  const total = Number(job.progress_total) || 0;
  return html`
    <section class="card xim-step">
      <div class="card-body">
        <h2 class="xim-step-title">${icon('scan-text')}<span>Leitura da prova</span></h2>
        <div class="xim-progress">
          ${progressBar(job.percent || 0, {
            label: lendo && job.stage === 'classificando' && total
              ? `${fmtNumber(job.progress_done)} de ${fmtNumber(total)} questões`
              : done ? 'Prova lida' : 'Questões lidas',
            showValue: true,
            color: done ? 'success' : '',
          })}
        </div>
        ${reportLine(job.read_report)}
        <dl class="xim-stats">
          <div><dt>Questões lidas</dt><dd>${fmtNumber(counts.total ?? job.found_count)}</dd></div>
          <div><dt>Já no banco</dt><dd>${fmtNumber(counts.importadas ?? job.imported_count)}</dd></div>
          <div><dt>A conferir</dt><dd>${fmtNumber(counts.pendentes || 0)}</dd></div>
          <div><dt>Com alerta</dt><dd>${fmtNumber(counts.com_alerta || 0)}</dd></div>
        </dl>
        ${job.status === 'pronta' && job.error_message
          ? alertBox({
              type: 'warning',
              title: 'A leitura parou no meio',
              text: `${job.error_message} Nada se perdeu: continuar retoma do mesmo ponto, sem ler de novo o que já foi lido.`,
            })
          : ''}
        ${job.status === 'falhou'
          ? alertBox({ type: 'danger', title: 'Não deu para ler este PDF', text: job.error_message || 'Erro desconhecido.' })
          : ''}
        ${!job.answer_key_count && !lendo
          ? alertBox({
              type: 'warning',
              title: 'Esta leitura está sem gabarito oficial',
              text: 'As respostas foram deduzidas pela IA, e por isso nenhuma questão foi sozinha para o banco. Cole o gabarito abaixo ou confira uma a uma.',
            })
          : ''}
        <div class="xim-step-actions">
          ${lendo
            ? html`<p class="xim-busy" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span>${etapa}</span></p>`
            : done
              ? html`<span class="xim-done">${icon('circle-check')}<span>Prova lida por inteiro</span></span>`
              : html`
                <button type="button" class="btn btn-primary" data-action="server-read" ${state.busy ? 'disabled' : ''}>
                  ${icon('play')}<span>${Number(job.progress_done) > 0 ? 'Continuar de onde parou' : 'Ler de novo'}</span>
                </button>`}
          ${job.status === 'falhou'
            ? html`
              <label class="btn btn-secondary ${state.busy ? 'is-disabled' : ''}">
                ${icon('upload')}<span>Enviar outro PDF</span>
                <input type="file" accept="application/pdf" id="xim-file" data-modo="servidor" hidden ${state.busy ? 'disabled' : ''}>
              </label>`
            : ''}
        </div>
        ${!job.answer_key_count && !lendo ? answerKeyForm() : ''}
      </div>
    </section>`;
}

/** Colar o gabarito depois: as questões já lidas são conferidas por ele. */
function answerKeyForm() {
  return html`
    <div class="xim-key-later">
      <label class="label" for="xim-key-later">Gabarito oficial</label>
      <textarea class="textarea" id="xim-key-later" rows="3" placeholder="1 B A&#10;2 C&#10;…"></textarea>
      <button type="button" class="btn btn-secondary btn-sm" data-action="answer-key" ${state.busy ? 'disabled' : ''}>
        ${icon('check-check')}<span>Aplicar o gabarito</span>
      </button>
    </div>`;
}

/** Plano B: o texto do PDF é lido aqui, no navegador. */
function browserChooseStep(job) {
  return html`
      <section class="card xim-step">
        <div class="card-body">
          <h2 class="xim-step-title">${icon('file-up')}<span>Escolha o PDF da prova</span></h2>
          ${!leitorDisponivel() && state.leitor
            ? alertBox({
                type: 'info',
                title: 'Leitura pelo texto',
                text: state.leitor.message || 'A leitura no servidor não está disponível agora; o texto do PDF é lido aqui no navegador.',
              })
            : ''}
          <p class="xim-step-text">
            O texto é lido aqui no seu navegador e só o texto sobe para a plataforma.
            Um PDF de prova inteira leva alguns segundos. Neste caminho as figuras não são recortadas.
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
          <input type="file" accept="application/pdf" id="xim-file" class="xim-file" data-modo="navegador" ${state.busy ? 'disabled' : ''}>
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
          ${leitorDisponivel()
            ? html`<p class="xim-alt-path">
                <button type="button" class="btn btn-link btn-sm" data-action="modo-servidor" ${state.busy ? 'disabled' : ''}>
                  Voltar para a leitura completa, com figuras
                </button>
              </p>`
            : ''}
        </div>
      </section>`;
}

/** Plano B, depois do texto enviado: a varredura em lotes. */
function sweepStep(job) {
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

/** Figuras de um trecho de markdown, na ordem: [{ alt, url }]. */
function figurasDe(texto) {
  return [...String(texto || '').matchAll(IMAGEM_MD)].map((m) => ({ alt: m[1], url: m[2] }));
}

/** Troca (ou tira, com `novaUrl` null) a figura de índice `indice` do markdown. */
function trocarFigura(texto, indice, novaUrl) {
  let n = -1;
  return String(texto || '')
    .replace(IMAGEM_MD, (inteira, alt, url) => {
      n += 1;
      if (n !== indice) return inteira;
      return novaUrl === null ? '' : `![${alt || 'Figura'}](${novaUrl})`;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function alertasView(item) {
  const alerts = alertasDe(item);
  if (!alerts.length || item.status === 'importada') return '';
  return html`
    <ul class="xim-alerts">
      ${alerts.map((codigo) => {
        const [titulo, texto] = textoDoAlerta(codigo);
        return html`<li>${icon('triangle-alert', { size: 14 })}<span><strong>${titulo}.</strong> ${texto}</span></li>`;
      })}
    </ul>`;
}

/** A questão como o aluno vai ver: enunciado inteiro e alternativas, com as figuras. */
function itemView(item) {
  const payload = item.payload || {};
  const letras = LETRAS.filter((letra) => payload[letra] !== undefined);
  return html`
    <div class="xim-item-statement md">${md(payload.statement || '')}</div>
    <ol class="xim-item-options">
      ${letras.map(
        (letra) => html`
          <li class="${payload.correct === letra ? 'is-correct' : ''}${payload[letra] ? '' : ' is-empty'}">
            <strong>${letra}</strong>
            <span class="md">${payload[letra] ? mdInline(payload[letra]) : html`<em>(vazia)</em>`}</span>
          </li>`
      )}
    </ol>`;
}

/** Lista das figuras do formulário de edição, com trocar e remover. */
function figurasDoFormulario(valores) {
  const campos = [['statement', 'Enunciado'], ...LETRAS.map((l) => [l, `Alternativa ${l}`])];
  const linhas = [];
  for (const [campo, rotulo] of campos) {
    figurasDe(valores[campo]).forEach((fig, indice) => {
      linhas.push(html`
        <li class="xim-fig">
          <img src="${fig.url}" alt="" loading="lazy">
          <span class="xim-fig-label">${rotulo}${campo === 'statement' ? ` — figura ${indice + 1}` : ''}</span>
          <label class="btn btn-ghost btn-sm">
            ${icon('upload')}<span>Trocar</span>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
                   data-fig-swap data-field="${campo}" data-index="${indice}">
          </label>
          <button type="button" class="btn btn-ghost btn-sm" data-action="fig-remove" data-field="${campo}" data-index="${indice}">
            ${icon('trash-2')}<span>Tirar</span>
          </button>
        </li>`);
    });
  }
  return linhas.length
    ? html`<ul class="xim-figs-list">${linhas}</ul>`
    : html`<p class="xim-row-sub">Nenhuma figura nesta questão.</p>`;
}

/** Edição do enunciado e das alternativas (markdown, com as figuras no lugar). */
function itemEditForm(item) {
  const payload = item.payload || {};
  return html`
    <div class="xim-edit" data-edit="${item.id}">
      <div class="field">
        <label class="label" for="xim-st-${item.id}">Enunciado</label>
        <textarea class="textarea xim-edit-statement" id="xim-st-${item.id}" name="statement" rows="10">${payload.statement || ''}</textarea>
        <span class="hint">Linha em branco separa parágrafos. Figura: <code>![Figura](endereço)</code> — use os botões abaixo.</span>
      </div>
      <div class="xim-edit-alts">
        ${LETRAS.map(
          (letra) => html`
            <label class="xim-edit-alt">
              <strong>${letra}</strong>
              <textarea class="textarea" name="${letra}" rows="2">${payload[letra] || ''}</textarea>
            </label>`
        )}
      </div>
      <div class="xim-figs">
        <h4 class="xim-figs-title">${icon('image', { size: 14 })}<span>Figuras</span></h4>
        <div data-figs>${figurasDoFormulario(payload)}</div>
        <label class="btn btn-secondary btn-sm">
          ${icon('upload')}<span>Pôr uma figura no fim do enunciado</span>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-fig-add>
        </label>
      </div>
      <div class="xim-edit-actions">
        <button type="button" class="btn btn-primary btn-sm" data-action="save-edit" data-item="${item.id}">
          ${icon('save')}<span>Salvar</span>
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-edit">Cancelar</button>
      </div>
    </div>`;
}

function itemRow(item) {
  const payload = item.payload || {};
  const letras = LETRAS.filter((letra) => payload[letra]);
  const pendente = item.status === 'pendente';
  const semGabarito = pendente && !payload.answer_from_key;
  const comAlerta = pendente && alertasDe(item).length > 0;
  const [rotulo, tom] = ITEM_BADGE[item.status] || ITEM_BADGE.pendente;
  const variante = item.variant || payload.variant;
  const editando = state.editando === item.id;
  const podeMexer = pendente || item.status === 'falhou';

  return html`
    <article class="xim-item${semGabarito || comAlerta ? ' is-unsure' : ''}" data-item="${item.id}" data-item-card="${item.id}">
      <header class="xim-item-head">
        <label class="check">
          <input type="checkbox" data-pick="${item.id}" ${pendente ? '' : 'disabled'}>
          <span>Questão ${item.number || '—'}${variante ? ` · ${VARIANTE[variante] || variante}` : ''}</span>
        </label>
        <div class="xim-item-tags">
          ${badge(rotulo, tom)}
          ${variante ? badge(VARIANTE[variante] || variante, 'blue', { icon: 'languages' }) : ''}
          ${classificacaoBadge(payload)}
          ${payload.vision ? badge('Texto lido pela imagem', 'blue', { icon: 'eye' }) : ''}
          ${semGabarito && !alertasDe(item).includes('sem_gabarito') ? badge('Gabarito deduzido pela IA', 'orange', { icon: 'triangle-alert' }) : ''}
          ${pendente ? alertasDe(item).map((codigo) => badge(textoDoAlerta(codigo)[0], 'orange', { icon: 'triangle-alert' })) : ''}
        </div>
      </header>
      ${editando ? itemEditForm(item) : html`${alertasView(item)}${itemView(item)}`}
      ${item.error_message ? html`<p class="xim-item-error">${icon('circle-x', { size: 14 })}<span>${item.error_message}</span></p>` : ''}
      ${podeMexer && !editando
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
                ${!payload.correct ? html`<option value="" selected>Escolha</option>` : ''}
                ${letras.map((letra) => html`<option value="${letra}" ${payload.correct === letra ? 'selected' : ''}>${letra}</option>`)}
              </select>
            </label>
            <span class="xim-item-buttons">
              <button type="button" class="btn btn-ghost btn-sm" data-action="edit" data-item="${item.id}">
                ${icon('pencil')}<span>Editar</span>
              </button>
              <button type="button" class="btn btn-ghost btn-sm" data-action="reject" data-item="${item.id}">
                ${icon('trash-2')}<span>Descartar</span>
              </button>
              <button type="button" class="btn btn-primary btn-sm" data-action="approve" data-item="${item.id}" ${state.busy ? 'disabled' : ''}>
                ${icon('check')}<span>Aprovar</span>
              </button>
            </span>
          </footer>`
        : ''}
      ${item.status === 'recusada'
        ? html`
          <footer class="xim-item-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="restore" data-item="${item.id}">
              ${icon('rotate-ccw')}<span>Voltar para a conferência</span>
            </button>
          </footer>`
        : ''}
    </article>`;
}

function reviewStep() {
  const items = state.current.items || [];
  if (!items.length) {
    const lendo = state.current.status === 'extraindo';
    return html`
      <section class="card">
        <div class="card-body">
          ${emptyState({
            icon: 'file-search',
            title: lendo ? 'Lendo a prova…' : 'Nenhuma questão encontrada ainda',
            text: lendo ? 'As questões aparecem aqui conforme a leitura avança.' : 'Leia a prova para as questões aparecerem aqui.',
          })}
        </div>
      </section>`;
  }

  const counts = state.current.counts || {};
  const pendentes = items.filter((item) => item.status === 'pendente');
  const prontas = pendentes.filter((item) => item.payload && item.payload.answer_from_key);
  const filtro = FILTROS.find(([chave]) => chave === state.filtro) || FILTROS[0];
  const visiveis = items.filter(filtro[2]);

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
                aprovada aqui (ou entra sozinha, quando não tem alerta e tem gabarito oficial).
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
      <div class="xim-filters" role="tablist">
        ${FILTROS.map(([chave, rotulo, teste]) => {
          const n = items.filter(teste).length;
          return html`<button type="button" role="tab" class="xim-filter${chave === filtro[0] ? ' is-active' : ''}"
                              aria-selected="${chave === filtro[0] ? 'true' : 'false'}" data-action="filter" data-filter="${chave}">
              ${rotulo} <span class="xim-filter-n">${fmtNumber(n)}</span>
            </button>`;
        })}
      </div>
      <div class="card-body xim-items">
        ${visiveis.length
          ? visiveis.map(itemRow)
          : html`<p class="xim-row-sub">Nenhuma questão neste filtro.</p>`}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------
// Carga de todas as provas
// ---------------------------------------------------------------------

/** Provas sem uma varredura completa, inclusive as interrompidas no caminho. */
function pendentesDeLeitura() {
  return (state.provas || []).filter((p) => !p.leitura_concluida);
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
        ${(lote.erros || []).length
          ? html`
            <div class="xim-lote-erros">
              <h3 class="xim-step-title">${icon('triangle-alert')}<span>Provas que não foram lidas</span></h3>
              <ul class="xim-lote-erros-lista">
                ${lote.erros.map((erro) => html`<li><strong>${erro.prova}</strong><span class="xim-row-sub">${erro.motivo}</span></li>`)}
              </ul>
            </div>`
          : ''}
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
      `Cada prova é lida inteira, e a inteligência artificial da plataforma classifica as questões. ` +
      (semGabarito
        ? `${semGabarito} delas não têm gabarito oficial cadastrado — nessas, as questões ficam esperando você conferir antes de irem para o banco. `
        : 'Todas têm gabarito oficial cadastrado. ') +
      'As questões sem alerta e com gabarito oficial entram no banco sozinhas; as outras esperam a sua conferência. ' +
      'Dá para parar a qualquer momento; o que já entrou fica.',
    confirmText: 'Ler todas',
  });
  if (!ok) return;

  state.lote = { total: pendentes.length, feitas: 0, encontradas: 0, noBanco: 0, aConferir: 0, falhas: 0, erros: [], atual: '', parar: false, terminou: false };
  state.busy = true;
  paint();

  for (const prova of pendentes) {
    if (state.lote.parar) break;
    state.lote.atual = `Lendo ${prova.title}…`;
    paint();
    try {
      await lerProvaInteira(prova);
    } catch (err) {
      // O motivo tem que sobrar na tela. Antes ele ficava só no console do
      // navegador: quem rodou a carga via "Provas com problema: 3" e não tinha
      // como saber quais nem por quê.
      state.lote.falhas += 1;
      state.lote.erros.push({ prova: prova.title, motivo: (err && err.message) || 'erro desconhecido' });
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

/**
 * Uma prova, lida no servidor do começo ao fim. Retoma a leitura no servidor
 * que parou no meio; a que começou pelo texto do navegador continua por lá.
 */
async function lerProvaInteira(prova) {
  const anteriorPeloTexto = prova.ultima_leitura_id && !prova.leitura_concluida && prova.ultima_leitura_engine !== 'leitor';
  if (!leitorDisponivel() || anteriorPeloTexto) return lerProvaInteiraPeloTexto(prova);

  let leitura = null;
  if (prova.ultima_leitura_id && !prova.leitura_concluida) {
    leitura = await api.get(`/api/admin/exam-imports/${prova.ultima_leitura_id}`);
  } else {
    leitura = await api.post('/api/admin/exam-imports', {
      title: prova.title,
      past_exam_id: prova.id,
      exam_id: prova.exam_id || undefined,
      year: prova.year || undefined,
      board: prova.board || undefined,
    });
  }
  const final = await lerNoServidor(leitura.id, {
    disparar: leitura.status !== 'extraindo',
    aoAndar: (atual) => {
      if (!state || !state.lote) return;
      state.lote.atual = `${prova.title} — ${atual.percent || 0}% · ${fmtNumber((atual.counts && atual.counts.total) || atual.found_count || 0)} questões`;
      paint();
    },
    parar: () => !state || !state.lote || state.lote.parar,
  });
  if (!state || !state.lote) return;
  state.lote.encontradas += Number(final.found_count) || 0;
  state.lote.aConferir += Number(final.counts && final.counts.pendentes) || 0;
  state.lote.noBanco += Number(final.counts && final.counts.importadas) || Number(final.imported_count) || 0;
}

/** Plano B: uma prova, do gabarito à varredura completa, retomando do último cursor. */
async function lerProvaInteiraPeloTexto(prova) {
  let leitura = null;
  if (prova.ultima_leitura_id && !prova.leitura_concluida) {
    leitura = await api.get(`/api/admin/exam-imports/${prova.ultima_leitura_id}`);
  }

  let gabarito = null;
  if (!leitura) {
    gabarito = prova.tem_gabarito ? await lerGabarito(prova.id) : null;
    leitura = await api.post('/api/admin/exam-imports', {
      title: prova.title,
      past_exam_id: prova.id,
      exam_id: prova.exam_id || undefined,
      year: prova.year || undefined,
      board: prova.board || undefined,
      answer_key: gabarito || undefined,
    });
  } else if (prova.tem_gabarito && !leitura.answer_key_count) {
    gabarito = await lerGabarito(prova.id);
    if (gabarito) {
      leitura = await api.put(`/api/admin/exam-imports/${leitura.id}/answer-key`, { answer_key: gabarito });
    }
  }

  // Status "lendo" significa que o navegador fechou no meio do upload. Recomeça
  // o texto do zero; concatenar novamente duplicaria o começo inteiro da prova.
  if (!leitura.has_text || leitura.status === 'lendo' || leitura.status === 'falhou') {
    const { text } = await extractPdfText(`/api/admin/exam-imports/provas/${prova.id}/arquivo/prova`);
    const partes = splitForUpload(text);
    for (const [index, chunk] of partes.entries()) {
      leitura = await api.post(`/api/admin/exam-imports/${leitura.id}/text`, {
        chunk,
        done: index === partes.length - 1,
        reset: index === 0,
      });
    }
  }

  let continua = true;
  let voltas = 0;
  while (continua && voltas < 60 && !state.lote.parar) {
    voltas += 1;
    continua = await sweepOnce(leitura.id);
    const atual = await api.get(`/api/admin/exam-imports/${leitura.id}`);
    state.lote.atual = `${prova.title} — ${atual.percent}% · ${atual.found_count} questões`;
    paint();
  }
  const final = await api.get(`/api/admin/exam-imports/${leitura.id}`);
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
                <tr>
                  <th>Prova</th>
                  <th>Situação</th>
                  <th class="nowrap">Lidas da prova</th>
                  <th class="nowrap">No banco de questões</th>
                  <th class="nowrap">A conferir</th>
                  <th class="nowrap">Não entraram</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${items.map((job) => {
                  return html`
                    <tr>
                      <td>
                        <strong>${job.title}</strong>
                        <span class="xim-row-sub">${job.exam_short_name || '—'} · ${fmtDateTime(job.created_at)}</span>
                      </td>
                      <td>${statusBadge(job)} <span class="xim-row-sub">${job.percent}%</span></td>
                      <td class="nowrap">${fmtNumber(job.read_count ?? job.found_count)}</td>
                      <td class="nowrap">${fmtNumber(job.in_bank_count ?? job.imported_count)}</td>
                      <td class="nowrap">
                        ${job.pending_count > 0
                          ? html`<span class="xim-row-warn">${fmtNumber(job.pending_count)}</span>`
                          : '—'}
                      </td>
                      <td class="nowrap">
                        ${job.rejected_count > 0
                          ? html`<span class="xim-row-warn">${fmtNumber(job.rejected_count)}</span>`
                          : '—'}
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
  const rascunho = guardarRascunho();
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
          <div>
            <h2 class="xim-current-title">${state.current.title}</h2>
            <span class="xim-row-sub">
              ${state.current.exam_short_name || 'Sem vestibular'}${state.current.year ? ` · ${state.current.year}` : ''}
              ${state.current.answer_key_count ? ` · gabarito com ${state.current.answer_key_count} respostas` : ' · sem gabarito'}
            </span>
          </div>
          ${state.current.past_exam_id
            ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="remove-exam-questions" ${state.busy ? 'disabled' : ''}>
                ${icon('rotate-ccw')}<span>Remover questões desta prova</span>
              </button>`
            : ''}
        </div>
        <div id="xim-read">${readStep()}</div>
        <div id="xim-review">${reviewStep()}</div>
      </div>`
  );
  restaurarRascunho(rascunho);
}

/** Só o passo da leitura (a tela acompanha a leitura sem mexer na conferência). */
function paintRead() {
  const alvo = state && state.current ? qs('#xim-read', state.ctx.el) : null;
  if (alvo) render(alvo, readStep());
}

/** Só a conferência, guardando o que estiver sendo editado. */
function paintReview() {
  const alvo = state && state.current ? qs('#xim-review', state.ctx.el) : null;
  if (!alvo) return;
  const rascunho = guardarRascunho();
  render(alvo, reviewStep());
  restaurarRascunho(rascunho);
}

/** O texto da questão em edição, para uma repintura não apagar o que foi digitado. */
function guardarRascunho() {
  if (!state || !state.editando) return null;
  const form = qs(`[data-edit="${state.editando}"]`, state.ctx.el);
  if (!form) return null;
  const valores = {};
  for (const campo of qsa('textarea[name]', form)) valores[campo.name] = campo.value;
  return { id: state.editando, valores };
}

function restaurarRascunho(rascunho) {
  if (!rascunho || !state || state.editando !== rascunho.id) return;
  const form = qs(`[data-edit="${rascunho.id}"]`, state.ctx.el);
  if (!form) return;
  for (const [nome, valor] of Object.entries(rascunho.valores)) {
    const campo = qs(`textarea[name="${nome}"]`, form);
    if (campo) campo.value = valor;
  }
  atualizarFigurasDoFormulario(form);
}

/** Os valores atuais do formulário de edição de uma questão. */
function valoresDoFormulario(form) {
  const valores = {};
  for (const campo of qsa('textarea[name]', form)) valores[campo.name] = campo.value;
  return valores;
}

function atualizarFigurasDoFormulario(form) {
  const lista = qs('[data-figs]', form);
  if (lista) render(lista, figurasDoFormulario(valoresDoFormulario(form)));
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
    const [lista, exams, provas, taxonomia, leitor] = await Promise.all([
      api.get('/api/admin/exam-imports'),
      state.exams ? Promise.resolve({ items: state.exams }) : api.get('/api/admin/exams', { query: { limit: 100 } }),
      api.get('/api/admin/exam-imports/provas').catch(() => ({ items: [] })),
      state.taxonomia && state.taxonomia.length
        ? Promise.resolve({ items: state.taxonomia })
        : api.get('/api/admin/exam-imports/taxonomia').catch(() => ({ items: [] })),
      // Sem resposta, o painel fica no caminho antigo, que funciona em qualquer servidor.
      state.leitor ? Promise.resolve(state.leitor) : api.get('/api/admin/exam-imports/leitor').catch(() => ({ available: false, message: null })),
    ]);
    state.leitor = leitor;
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
  state.editando = null;
  paint();
  try {
    state.current = await api.get(`/api/admin/exam-imports/${encodeURIComponent(id)}`);
    state.filtro = filtroInicial(state.current);
  } catch (err) {
    toast(err.message || 'Não foi possível abrir esta leitura.', { type: 'error' });
    state.current = null;
  }
  state.loading = false;
  paint();
  // Leitura no servidor em andamento (a tela foi reaberta no meio): acompanha.
  if (state.current && state.current.engine === 'leitor' && state.current.status === 'extraindo') {
    acompanharLeitura({ disparar: false });
  }
}

/** Abre na aba que tem trabalho: o que espera conferência, ou tudo. */
function filtroInicial(job) {
  const items = (job && job.items) || [];
  return items.some((item) => item.status === 'pendente' || item.status === 'falhou') ? 'conferir' : 'todas';
}

/** Recarrega a leitura aberta sem perder a aba nem o que está sendo editado. */
async function refreshJob() {
  if (!state || !state.current) return;
  const atual = await api.get(`/api/admin/exam-imports/${encodeURIComponent(state.current.id)}`);
  if (!state || !state.current || state.current.id !== atual.id) return;
  state.current = atual;
  paintRead();
  paintReview();
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
    // Com o leitor do servidor, quem lê o PDF do gabarito é o servidor.
    if (!gabarito && prova && prova.tem_gabarito && !leitorDisponivel()) {
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
    state.filtro = 'conferir';
    state.modoAntigo = false;
    if (criada.answer_key_count) {
      toast(`Gabarito oficial lido: ${criada.answer_key_count} respostas.`, { type: 'success' });
    }
    await loadList();
    // Prova cadastrada: o arquivo já está na plataforma, então a leitura
    // começa sem outro clique.
    if (provaId && leitorDisponivel()) {
      setLoading(trigger, false);
      paint();
      await acompanharLeitura({ disparar: true });
      return;
    }
  } catch (err) {
    toast(err.message || 'Não foi possível criar a leitura.', { type: 'error' });
  } finally {
    setLoading(trigger, false);
    paint();
  }
}

// ---------------------------------------------------------------------
// Leitura no servidor
// ---------------------------------------------------------------------
/**
 * Dispara a leitura no servidor (ou só acompanha a que já está andando) e
 * espera ela sair de "lendo". O servidor responde na hora e trabalha solto;
 * aqui a tela pergunta a cada dois segundos.
 *
 * Se a leitura parar no meio (a aplicação reiniciou, a IA ou o armazenamento
 * recusaram), tenta continuar mais duas vezes antes de desistir: continuar
 * relê o PDF sem IA e pula o que já foi lido.
 *
 * @returns {Promise<object>} a leitura no estado final
 */
async function lerNoServidor(id, { body = {}, disparar = true, aoAndar = null, parar = () => false } = {}) {
  if (disparar) {
    const disparo = await api.post(`/api/admin/exam-imports/${id}/ler`, body);
    if (disparo.done) return api.get(`/api/admin/exam-imports/${id}`);
    if (aoAndar) aoAndar(disparo);
  }
  let retomadas = 0;
  for (let volta = 0; volta < 1800; volta += 1) {
    await sleep(2000);
    if (parar()) return api.get(`/api/admin/exam-imports/${id}`);
    let atual;
    try {
      atual = await api.get(`/api/admin/exam-imports/${id}`);
    } catch (err) {
      // A aplicação pode estar reiniciando; a próxima volta reencontra o estado.
      continue;
    }
    if (aoAndar) aoAndar(atual);
    if (atual.status === 'extraindo') continue;
    if (atual.status === 'concluida') return atual;
    if (atual.status === 'pronta' && retomadas < 2) {
      retomadas += 1;
      await sleep(3000);
      try {
        await api.post(`/api/admin/exam-imports/${id}/ler`, {});
      } catch (err) {
        throw new Error(atual.error_message || err.message);
      }
      continue;
    }
    throw new Error(atual.error_message || 'A leitura parou. Abra a prova e continue de onde parou.');
  }
  throw new Error('A leitura demorou mais que o esperado. Abra a prova e continue de onde parou.');
}

/** Lê a prova aberta no servidor, acompanhando na tela. */
async function acompanharLeitura({ disparar = true, body = {} } = {}) {
  if (!state || !state.current || state.acompanhando) return;
  const id = state.current.id;
  state.acompanhando = true;
  state.readError = null;
  let vistos = (state.current.items || []).length;
  try {
    const final = await lerNoServidor(id, {
      body,
      disparar,
      parar: () => !state || !state.current || state.current.id !== id,
      aoAndar: (atual) => {
        if (!state || !state.current || state.current.id !== id) return;
        const antes = state.current;
        // A resposta do disparo não traz os itens: fica com os que já estão na tela.
        state.current = { ...atual, items: atual.items || antes.items || [] };
        // Primeira resposta depois do disparo: a leitura começou a andar.
        if (antes.engine !== atual.engine || antes.status !== atual.status) paint();
        else paintRead();
        const agora = (state.current.items || []).length;
        if (agora !== vistos && !state.editando) paintReview();
        vistos = agora;
      },
    });
    if (!state || !state.current || state.current.id !== id) return;
    state.current = final;
    if (final.status === 'concluida') {
      const c = final.counts || {};
      toast(
        c.importadas
          ? `${pluralize(c.importadas, 'questão entrou sozinha', 'questões entraram sozinhas')} no banco${c.pendentes ? `; ${c.pendentes} esperam a sua conferência.` : '.'}`
          : 'Prova lida. Confira as questões antes de mandar para o banco.',
        { type: c.importadas ? 'success' : 'warning' }
      );
      state.filtro = filtroInicial(final);
    }
  } catch (err) {
    if (!state) return;
    if (err && err.code === 'leitor_indisponivel') {
      // O servidor não tem o leitor: a tela passa para a leitura pelo navegador.
      state.leitor = { available: false, message: err.message };
      state.modoAntigo = true;
    } else {
      toast(err.message || 'A leitura parou. Nada se perdeu: continue de onde parou.', { type: 'error' });
    }
    try {
      state.current = await api.get(`/api/admin/exam-imports/${id}`);
    } catch {
      /* a tela mostra o último estado conhecido */
    }
  } finally {
    if (state) {
      state.acompanhando = false;
      paint();
    }
  }
}

/** Envia o PDF escolhido para a plataforma e manda o servidor ler. */
async function lerArquivoNoServidor(file) {
  if (!file || !state || !state.current || state.acompanhando) return;
  if (file.type && file.type !== 'application/pdf') {
    toast('Escolha o arquivo da prova em PDF.', { type: 'warning' });
    return;
  }
  state.busy = true;
  state.readError = null;
  state.uploadProgress = 0;
  paintRead();
  let url = null;
  try {
    const saved = await uploadFile(file, {
      folder: 'provas',
      onProgress: (pct) => {
        if (!state) return;
        state.uploadProgress = pct;
        paintRead();
      },
    });
    url = saved && saved.url;
  } catch (err) {
    if (!state) return;
    state.readError = `O PDF não pôde ser enviado: ${(err && err.message) || 'motivo desconhecido'}`;
  } finally {
    if (state) {
      state.busy = false;
      state.uploadProgress = null;
      paintRead();
    }
  }
  if (url && state) await acompanharLeitura({ disparar: true, body: { source_url: url } });
}

/** Cola o gabarito oficial numa leitura já feita: as questões são conferidas por ele. */
async function aplicarGabarito(trigger) {
  const campo = qs('#xim-key-later', state.ctx.el);
  const texto = campo ? campo.value.trim() : '';
  if (!texto) {
    toast('Cole o gabarito oficial da prova.', { type: 'warning' });
    return;
  }
  setLoading(trigger, true);
  try {
    const res = await api.put(`/api/admin/exam-imports/${state.current.id}/answer-key`, { answer_key: texto });
    toast(
      `Gabarito aplicado em ${pluralize(res.reconciled || 0, 'questão', 'questões')}` +
        (res.imported_now ? `; ${res.imported_now} foram para o banco.` : '.'),
      { type: 'success' }
    );
    await refreshJob();
  } catch (err) {
    toast(err.message || 'Não foi possível aplicar o gabarito.', { type: 'error' });
  } finally {
    setLoading(trigger, false);
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
    let avisoArquivo = null;
    if (guardar) {
      try {
        const saved = await uploadFile(guardar, { folder: 'provas' });
        url = saved && saved.url;
      } catch (err) {
        // Não derruba a leitura, mas também não pode passar em silêncio: o
        // painel dizia "texto lido" e o arquivo não estava guardado em canto
        // nenhum, o que de fora parece "o PDF não subiu".
        avisoArquivo = (err && err.message) || 'motivo desconhecido';
        console.warn('[ler prova] o PDF não pôde ser guardado:', avisoArquivo);
      }
    }

    state.busyText = `Enviando o texto (${pages} páginas)…`;
    paint();

    const partes = splitForUpload(text);
    let atualizado = null;
    for (const [index, chunk] of partes.entries()) {
      const ultimo = index === partes.length - 1;
      atualizado = await api.post(`/api/admin/exam-imports/${state.current.id}/text`, {
        chunk,
        done: ultimo,
        reset: index === 0,
        // Vai junto do último pedaço para o endereço do arquivo ficar gravado
        // na leitura, e não apenas neste objeto em memória.
        ...(ultimo && url ? { source_url: url } : {}),
      });
    }
    state.current = { ...state.current, ...atualizado };
    state.readProgress = null;
    if (avisoArquivo) {
      toast(`Texto lido, mas o PDF não pôde ser guardado: ${avisoArquivo}`, { type: 'warning' });
    } else {
      toast(`Texto lido: ${fmtNumber(text.length)} caracteres em ${pages} páginas.`, { type: 'success' });
    }
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
        reset: index === 0,
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
    await refreshJob();
    // "Já estavam no banco" é releitura da mesma prova: a questão foi reaproveitada
    // em vez de gravada de novo, e dizer isso evita a impressão de que sumiu.
    const repetidas = Number(res.reused) || 0;
    const jaEstavam = repetidas ? `, ${repetidas} já ${repetidas === 1 ? 'estava' : 'estavam'} no banco` : '';
    if (res.failed) {
      toast(`${res.imported} no banco${jaEstavam}, ${res.failed} não entraram. Veja o motivo em cada questão.`, {
        type: 'warning',
      });
    } else if (repetidas) {
      toast(`${pluralize(res.imported, 'questão nova', 'questões novas')} no banco${jaEstavam}.`, { type: 'success' });
    } else {
      // pluralize já traz o número na frente.
      toast(`${pluralize(res.imported, 'questão foi', 'questões foram')} para o banco.`, { type: 'success' });
    }
  } catch (err) {
    toast(err.message || 'Não foi possível gravar as questões.', { type: 'error' });
  } finally {
    setLoading(trigger, false);
    state.busy = false;
    paintReview();
  }
}

async function patchItem(itemId, body) {
  try {
    const atualizado = await api.patch(`/api/admin/exam-imports/${state.current.id}/items/${itemId}`, body);
    state.current.items = (state.current.items || []).map((item) => (item.id === itemId ? atualizado : item));
    paintReview();
    return atualizado;
  } catch (err) {
    toast(err.message || 'Não foi possível alterar esta questão.', { type: 'error' });
    return null;
  }
}

// ---------------------------------------------------------------------
// Conferência de uma questão
// ---------------------------------------------------------------------
function abrirEdicao(itemId) {
  if (state.editando && state.editando !== itemId) {
    // Uma de cada vez: a outra volta ao que estava salvo.
    state.editando = null;
  }
  state.editando = itemId;
  paintReview();
  const form = qs(`[data-edit="${itemId}"]`, state.ctx.el);
  const campo = form && qs('textarea[name="statement"]', form);
  if (campo) campo.focus();
}

async function salvarEdicao(itemId, trigger) {
  const form = qs(`[data-edit="${itemId}"]`, state.ctx.el);
  const item = (state.current.items || []).find((row) => row.id === itemId);
  if (!form || !item) return;
  const valores = valoresDoFormulario(form);
  const mudou = {};
  for (const [campo, valor] of Object.entries(valores)) {
    if (String(valor).trim() !== String((item.payload || {})[campo] || '').trim()) mudou[campo] = valor;
  }
  if (!Object.keys(mudou).length) {
    state.editando = null;
    paintReview();
    return;
  }
  setLoading(trigger, true);
  try {
    const atualizado = await api.patch(`/api/admin/exam-imports/${state.current.id}/items/${itemId}`, mudou);
    state.current.items = (state.current.items || []).map((row) => (row.id === itemId ? atualizado : row));
    state.editando = null;
    paintReview();
    toast(`Questão ${atualizado.number || ''} salva.`, { type: 'success' });
  } catch (err) {
    setLoading(trigger, false);
    toast(err.message || 'Não foi possível salvar esta questão.', { type: 'error' });
  }
}

/** Manda UMA questão conferida para o banco. */
async function aprovarItem(itemId, trigger) {
  setLoading(trigger, true);
  state.busy = true;
  try {
    const res = await api.post(`/api/admin/exam-imports/${state.current.id}/import`, { item_ids: [itemId] });
    if (res.failed) {
      const motivo = res.errors && res.errors[0] ? res.errors[0].message : 'veja o motivo na questão';
      toast(`A questão não entrou: ${motivo}`, { type: 'warning' });
    } else {
      toast(res.reused ? 'Esta questão já estava no banco: a leitura foi ligada a ela.' : 'Questão aprovada: já está no banco.', { type: 'success' });
    }
    await refreshJob();
  } catch (err) {
    toast(err.message || 'Não foi possível aprovar esta questão.', { type: 'error' });
  } finally {
    state.busy = false;
    paintReview();
  }
}

/** Sobe uma figura nova para a pasta das questões e devolve o endereço. */
async function enviarFigura(file) {
  if (!file) return null;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type || '')) {
    toast('Envie a figura em PNG, JPG, WEBP ou GIF.', { type: 'warning' });
    return null;
  }
  try {
    const saved = await uploadFile(file, { folder: 'questoes' });
    return saved && saved.url;
  } catch (err) {
    toast(`A figura não pôde ser enviada: ${(err && err.message) || 'motivo desconhecido'}`, { type: 'error' });
    return null;
  }
}

/** Troca, tira ou acrescenta figura no formulário (salva com "Salvar"). */
async function mexerNaFigura(form, { campo, indice, arquivo, tirar = false, acrescentar = false }) {
  const area = qs(`textarea[name="${campo}"]`, form);
  if (!area) return;
  if (tirar) {
    area.value = trocarFigura(area.value, indice, null);
    atualizarFigurasDoFormulario(form);
    return;
  }
  const url = await enviarFigura(arquivo);
  if (!url || !form.isConnected) return;
  if (acrescentar) {
    area.value = `${area.value.trim()}\n\n![Figura](${url})`.trim();
  } else {
    area.value = trocarFigura(area.value, indice, url);
  }
  atualizarFigurasDoFormulario(form);
  toast('Figura enviada. Salve a questão para valer.', { type: 'success' });
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
    // Leitura no servidor: disponibilidade (GET /leitor), envio do PDF,
    // acompanhamento, conferência.
    leitor: null,
    modoAntigo: false,
    uploadProgress: null,
    acompanhando: false,
    filtro: 'conferir',
    editando: null,
  };
  paint();

  cleanup.push(
    on(ctx.el, 'click', '[data-action="create"]', (event, trigger) => createJob(trigger)),
    on(ctx.el, 'click', '[data-action="open"]', (event, trigger) => openJob(trigger.dataset.id)),
    on(ctx.el, 'click', '[data-action="back"]', () => {
      state.current = null;
      state.readError = null;
      state.editando = null;
      state.modoAntigo = false;
      paint();
      loadList();
    }),
    // Campos que antes ganhavam listener a cada pintura: agora por delegação,
    // porque a tela repinta só um pedaço enquanto acompanha a leitura.
    on(ctx.el, 'change', '#xim-file', (event, input) => {
      const file = input.files && input.files[0];
      if (input.dataset.modo === 'servidor') lerArquivoNoServidor(file);
      else readPdf(file);
    }),
    on(ctx.el, 'change', '#xim-prova', (event, select) => preencherPelaProva(select.value)),
    on(ctx.el, 'click', '[data-action="server-read"]', () => acompanharLeitura({ disparar: true })),
    on(ctx.el, 'click', '[data-action="modo-antigo"]', () => {
      state.modoAntigo = true;
      state.readError = null;
      paintRead();
    }),
    on(ctx.el, 'click', '[data-action="modo-servidor"]', () => {
      state.modoAntigo = false;
      state.readError = null;
      paintRead();
    }),
    on(ctx.el, 'click', '[data-action="answer-key"]', (event, trigger) => aplicarGabarito(trigger)),
    on(ctx.el, 'click', '[data-action="filter"]', (event, trigger) => {
      state.filtro = trigger.dataset.filter;
      paintReview();
    }),
    on(ctx.el, 'click', '[data-action="edit"]', (event, trigger) => abrirEdicao(trigger.dataset.item)),
    on(ctx.el, 'click', '[data-action="cancel-edit"]', () => {
      state.editando = null;
      paintReview();
    }),
    on(ctx.el, 'click', '[data-action="save-edit"]', (event, trigger) => salvarEdicao(trigger.dataset.item, trigger)),
    on(ctx.el, 'click', '[data-action="approve"]', (event, trigger) => aprovarItem(trigger.dataset.item, trigger)),
    on(ctx.el, 'click', '[data-action="restore"]', (event, trigger) =>
      patchItem(trigger.dataset.item, { status: 'pendente' })
    ),
    on(ctx.el, 'click', '[data-action="fig-remove"]', (event, trigger) =>
      mexerNaFigura(trigger.closest('[data-edit]'), {
        campo: trigger.dataset.field,
        indice: Number(trigger.dataset.index),
        tirar: true,
      })
    ),
    on(ctx.el, 'change', '[data-fig-swap]', (event, input) => {
      const arquivo = input.files && input.files[0];
      mexerNaFigura(input.closest('[data-edit]'), {
        campo: input.dataset.field,
        indice: Number(input.dataset.index),
        arquivo,
      });
    }),
    on(ctx.el, 'change', '[data-fig-add]', (event, input) => {
      const arquivo = input.files && input.files[0];
      mexerNaFigura(input.closest('[data-edit]'), { campo: 'statement', arquivo, acrescentar: true });
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
    on(ctx.el, 'click', '[data-action="remove-exam-questions"]', async () => {
      // A prova inteira, não só esta leitura: as leituras da mesma prova
      // reaproveitam as questões umas das outras, e ler de novo só funciona
      // com o banco limpo de todas elas.
      const job = state.current;
      if (!job || !job.past_exam_id) return;
      const prova = (state.provas || []).find((p) => p.id === job.past_exam_id);
      const resultado = await openRemoveExamQuestions({ id: job.past_exam_id, title: prova ? prova.title : job.title });
      if (!resultado || !state) return;
      // A leitura aberta foi apagada junto: volta para a lista, onde a prova
      // aparece de novo como não lida.
      state.current = null;
      state.provaEscolhida = job.past_exam_id;
      await loadList();
    }),
    on(ctx.el, 'click', '[data-action="delete"]', async (event, trigger) => {
      const ok = await confirm({
        title: 'Excluir esta leitura?',
        message:
          'As questões que já foram para o banco continuam lá. O que ainda não foi conferido se perde. ' +
          'Para tirar as questões também e ler a prova de novo, abra a leitura e use "Remover questões desta prova".',
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
