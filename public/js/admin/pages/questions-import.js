// =====================================================================
// Foco Elite — Admin › Importar questões (ARCHITECTURE §6.5)
//
// Instruções do formato, download do modelo CSV, envio de arquivo ou colagem
// de texto, prévia das primeiras linhas e resultado da importação com os erros
// listados por linha.
//
// API: GET /api/admin/questions/template.csv e POST /api/admin/questions/import.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, qs, on,
  pageHeader, skeleton, setLoading, badge, alertBox,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtNumber, truncate, pluralize } from '../../core/format.js';

const MAX_ROWS = 2000;
const PREVIEW_ROWS = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Colunas aceitas pelo importador (a ordem do modelo). */
const COLUMNS = [
  { key: 'statement', label: 'statement', required: true, description: 'Enunciado da questão (mínimo de 10 caracteres).' },
  { key: 'A', label: 'A a E', required: true, description: 'Texto de cada alternativa. Deixe em branco as que não usar (mínimo de duas).' },
  { key: 'correct', label: 'correct', required: true, description: 'Letra do gabarito: A, B, C, D ou E.' },
  { key: 'resolution', label: 'resolution', required: false, description: 'Resolução passo a passo.' },
  { key: 'explanation', label: 'explanation', required: false, description: 'Explicação da resposta.' },
  { key: 'subject_slug', label: 'subject_slug', required: true, description: 'Identificador da matéria (ex.: matematica). Veja em Conteúdo.' },
  { key: 'topic_slug', label: 'topic_slug', required: true, description: 'Identificador do assunto dentro da matéria.' },
  { key: 'subtopic_slug', label: 'subtopic_slug', required: false, description: 'Identificador do subassunto, quando houver.' },
  { key: 'difficulty', label: 'difficulty', required: false, description: '1 (básico), 2 (intermediário) ou 3 (avançado). Padrão: 2.' },
  { key: 'year', label: 'year', required: false, description: 'Ano da prova de origem.' },
  { key: 'board', label: 'board', required: false, description: 'Banca (INEP, VUNESP, FUVEST…).' },
  { key: 'exams', label: 'exams', required: false, description: 'Provas em que a questão cai, separadas por vírgula (ex.: enem,barro-branco).' },
];

let state = null;

// ---------------------------------------------------------------------
// Leitura do CSV (apenas para a prévia; a validação é do servidor)
// ---------------------------------------------------------------------
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const char of firstLine) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && counts[char] !== undefined) counts[char] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ';';
}

function parseCsv(text, delimiter) {
  const rows = [];
  let cells = [];
  let value = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  const pushCell = () => {
    cells.push(value);
    value = '';
  };
  const pushRow = () => {
    pushCell();
    if (cells.some((cell) => cell.trim() !== '')) rows.push(cells);
    cells = [];
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          value += '"';
          i += 1;
        } else quoted = false;
      } else value += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) pushCell();
    else if (char === '\n') pushRow();
    else if (char !== '\r') value += char;
  }
  if (value !== '' || cells.length) pushRow();
  return rows;
}

function analyze(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const delimiter = detectDelimiter(trimmed);
  const rows = parseCsv(trimmed, delimiter);
  if (!rows.length) return null;
  const header = rows[0].map((cell) => cell.trim());
  return {
    delimiter,
    header,
    rows: rows.slice(1),
    hasStatement: header.some((cell) => /^\uFEFF?(statement|enunciado)$/i.test(cell.trim())),
  };
}

// ---------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------
function instructionsView() {
  return html`
    <section class="card">
      <div class="card-header"><h2 class="card-title">${icon('info')}<span>Como montar o arquivo</span></h2></div>
      <div class="card-body">
        <ol class="qi-steps">
          <li>Baixe o modelo abaixo — ele já vem com o cabeçalho correto e uma linha de exemplo.</li>
          <li>Preencha uma questão por linha. O separador é o ponto e vírgula (<code>;</code>); vírgula e tabulação também são aceitos.</li>
          <li>Textos com ponto e vírgula ou quebra de linha devem ficar entre aspas duplas.</li>
          <li>As colunas <code>subject_slug</code> e <code>topic_slug</code> usam o identificador que aparece em <a href="/admin/conteudo">Conteúdo</a>.</li>
          <li>Envie o arquivo (ou cole o texto) e confira a prévia antes de importar. São aceitas até ${fmtNumber(MAX_ROWS, { digits: 0 })} linhas por vez.</li>
        </ol>
        <div class="table-wrap qi-columns">
          <table class="table table-sm">
            <thead><tr><th scope="col">Coluna</th><th scope="col">Obrigatória</th><th scope="col">O que preencher</th></tr></thead>
            <tbody>
              ${COLUMNS.map((column) => html`
                <tr>
                  <td><code>${column.label}</code></td>
                  <td>${column.required ? badge('Sim', 'blue') : badge('Não', 'gray')}</td>
                  <td class="text-2">${column.description}</td>
                </tr>`)}
            </tbody>
          </table>
        </div>
        <p class="hint mt-3">As linhas válidas são gravadas mesmo que outras falhem: os problemas voltam listados por linha.</p>
      </div>
    </section>`;
}

function previewView() {
  const parsed = state.parsed;
  if (!parsed) {
    return html`<p class="hint">Envie um arquivo ou cole o conteúdo para ver a prévia das primeiras linhas.</p>`;
  }
  if (!parsed.hasStatement) {
    return alertBox({
      type: 'warning',
      title: 'Cabeçalho não reconhecido',
      text: 'A primeira linha precisa conter os nomes das colunas, começando por "statement". Baixe o modelo e use o cabeçalho dele.',
    });
  }
  if (!parsed.rows.length) {
    return alertBox({ type: 'warning', title: 'Nenhuma linha de dados', text: 'O arquivo tem apenas o cabeçalho.' });
  }
  const preview = parsed.rows.slice(0, PREVIEW_ROWS);
  const tooMany = parsed.rows.length > MAX_ROWS;
  return html`
    <div class="qi-preview-head">
      <span>${badge(`${fmtNumber(parsed.rows.length, { digits: 0 })} ${parsed.rows.length === 1 ? 'linha' : 'linhas'}`, tooMany ? 'orange' : 'green', { icon: 'list' })}</span>
      <span class="hint">Separador detectado: <code>${parsed.delimiter === '\t' ? 'tabulação' : parsed.delimiter}</code></span>
    </div>
    ${tooMany ? alertBox({ type: 'warning', title: 'Arquivo grande demais', text: `Envie no máximo ${fmtNumber(MAX_ROWS, { digits: 0 })} linhas por importação.` }) : ''}
    <div class="table-wrap qi-preview">
      <table class="table table-sm">
        <thead><tr><th scope="col">#</th>${parsed.header.map((cell) => html`<th scope="col">${cell || '—'}</th>`)}</tr></thead>
        <tbody>
          ${preview.map((row, index) => html`
            <tr>
              <td class="dt-muted">${index + 2}</td>
              ${parsed.header.map((_, column) => html`<td>${truncate(row[column] || '', 60)}</td>`)}
            </tr>`)}
        </tbody>
      </table>
    </div>
    ${parsed.rows.length > PREVIEW_ROWS ? html`<p class="hint">Mostrando as ${PREVIEW_ROWS} primeiras linhas de ${fmtNumber(parsed.rows.length, { digits: 0 })}.</p>` : ''}`;
}

function resultView() {
  const result = state.result;
  if (!result) return '';
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const tone = result.imported && !result.failed ? 'success' : result.imported ? 'warning' : 'danger';
  return html`
    <section class="card qi-result">
      <div class="card-header"><h2 class="card-title">${icon(tone === 'success' ? 'circle-check' : 'triangle-alert')}<span>Resultado da importação</span></h2></div>
      <div class="card-body">
        ${alertBox({
          type: tone === 'success' ? 'success' : tone,
          title: `${fmtNumber(result.imported || 0, { digits: 0 })} de ${fmtNumber(result.total || 0, { digits: 0 })} ${pluralize(result.total || 0, 'linha', 'linhas', { withNumber: false })} importadas`,
          text: result.failed
            ? `${pluralize(result.failed, 'linha', 'linhas')} não ${result.failed === 1 ? 'foi gravada' : 'foram gravadas'}. Corrija os pontos abaixo e envie apenas essas linhas novamente.`
            : 'Todas as linhas foram gravadas no banco de questões.',
        })}
        ${errors.length ? html`
          <div class="table-wrap qi-errors">
            <table class="table table-sm">
              <thead><tr><th scope="col">Linha</th><th scope="col">Problema</th></tr></thead>
              <tbody>${errors.map((error) => html`<tr><td class="qi-error-line">${error.line}</td><td>${error.message}</td></tr>`)}</tbody>
            </table>
          </div>` : ''}
        <div class="qi-result-actions">
          <a class="btn btn-primary" href="/admin/questoes">${icon('list')}<span>Ver as questões</span></a>
          <button type="button" class="btn btn-secondary" data-act="reset">${icon('refresh-cw')}<span>Importar outro arquivo</span></button>
        </div>
      </div>
    </section>`;
}

function view() {
  return html`
    ${pageHeader({
      title: 'Importar questões',
      subtitle: 'Cadastre várias questões de uma vez a partir de uma planilha em CSV.',
      breadcrumb: [{ label: 'Questões', href: '/admin/questoes' }, { label: 'Importar' }],
      actions: html`
        <a class="btn btn-ghost" href="/admin/questoes">${icon('arrow-left')}<span>Voltar</span></a>
        <a class="btn btn-secondary" href="/api/admin/questions/template.csv">${icon('download')}<span>Baixar modelo CSV</span></a>`,
    })}
    ${instructionsView()}

    <section class="card">
      <div class="card-header"><h2 class="card-title">${icon('upload')}<span>Enviar o arquivo</span></h2></div>
      <div class="card-body">
        <label class="qi-drop" data-drop>
          <input type="file" accept=".csv,.txt,text/csv,text/plain" class="sr-only" data-file>
          <span class="qi-drop-icon">${icon('upload', { size: 26 })}</span>
          <span class="qi-drop-title">Escolher arquivo CSV</span>
          <span class="qi-drop-hint">ou arraste o arquivo até aqui — até 4 MB</span>
          <span class="qi-drop-file" data-file-name></span>
        </label>

        <div class="divider divider-text"><span>ou cole o conteúdo</span></div>

        <div class="field">
          <label class="label" for="qi-text">Conteúdo do CSV</label>
          <textarea class="textarea qi-textarea" id="qi-text" rows="8" spellcheck="false"
            placeholder="statement;A;B;C;D;E;correct;resolution;explanation;subject_slug;topic_slug;subtopic_slug;difficulty;year;board;exams"></textarea>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header"><h2 class="card-title">${icon('table-2')}<span>Prévia</span></h2></div>
      <div class="card-body">
        <div data-preview>${previewView()}</div>
        <div class="qi-actions">
          <button type="button" class="btn btn-ghost" data-act="clear">${icon('x')}<span>Limpar</span></button>
          <button type="button" class="btn btn-primary" data-act="import" disabled>${icon('upload')}<span>Importar questões</span></button>
        </div>
      </div>
    </section>

    <div data-result>${resultView()}</div>`;
}

function repaint() {
  const previewEl = qs('[data-preview]', state.ctx.el);
  const resultEl = qs('[data-result]', state.ctx.el);
  if (previewEl) render(previewEl, previewView());
  if (resultEl) render(resultEl, resultView());
  const importButton = qs('[data-act="import"]', state.ctx.el);
  if (importButton) {
    const ready = Boolean(state.parsed && state.parsed.hasStatement && state.parsed.rows.length && state.parsed.rows.length <= MAX_ROWS);
    importButton.disabled = !ready;
    const label = qs('span', importButton);
    if (label && state.parsed && state.parsed.rows.length) {
      label.textContent = `Importar ${fmtNumber(Math.min(state.parsed.rows.length, MAX_ROWS), { digits: 0 })} ${state.parsed.rows.length === 1 ? 'questão' : 'questões'}`;
    } else if (label) {
      label.textContent = 'Importar questões';
    }
  }
}

function setContent(text, fileName) {
  state.csv = String(text || '');
  state.parsed = analyze(state.csv);
  state.result = null;
  const nameEl = qs('[data-file-name]', state.ctx.el);
  if (nameEl) nameEl.textContent = fileName || '';
  repaint();
}

function readFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    toast('O arquivo passa de 4 MB. Divida a planilha em partes menores.', { type: 'error' });
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    if (!state) return;
    const text = String(reader.result || '');
    const textarea = qs('#qi-text', state.ctx.el);
    if (textarea) textarea.value = text.length > 200000 ? '' : text;
    setContent(text, `${file.name} · ${(file.size / 1024).toFixed(0)} KB`);
    toast('Arquivo carregado. Confira a prévia antes de importar.', { type: 'info' });
  };
  reader.onerror = () => toast('Não foi possível ler o arquivo.', { type: 'error' });
  reader.readAsText(file, 'utf-8');
}

async function runImport() {
  const button = qs('[data-act="import"]', state.ctx.el);
  setLoading(button, true);
  try {
    // resposta parcial (algumas linhas com erro) volta com status 400 e o mesmo corpo do sucesso
    const response = await api.request('POST', '/api/admin/questions/import', { body: { csv: state.csv }, raw: true, timeout: 120000 });
    const body = await response.json().catch(() => null);
    if (body && Array.isArray(body.errors)) {
      state.result = body;
      const failed = Number(body.failed) || 0;
      toast(
        `${fmtNumber(Number(body.imported) || 0, { digits: 0 })} ${Number(body.imported) === 1 ? 'questão importada' : 'questões importadas'}.`,
        { type: failed ? 'warning' : 'success' }
      );
    } else {
      const message = (body && body.error && body.error.message) || 'Não foi possível importar o arquivo.';
      state.result = { imported: 0, total: state.parsed ? state.parsed.rows.length : 0, failed: 0, errors: [{ line: '—', message }] };
      toast(message, { type: 'error' });
    }
  } catch (err) {
    const message = (err && err.message) || 'Não foi possível importar o arquivo.';
    state.result = { imported: 0, total: state.parsed ? state.parsed.rows.length : 0, failed: 0, errors: [{ line: '—', message }] };
    toast(message, { type: 'error' });
  }
  setLoading(button, false);
  repaint();
  const resultEl = qs('[data-result]', state.ctx.el);
  if (resultEl) resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bind(ctx) {
  state.off.push(
    on(ctx.el, 'change', '[data-file]', (event, input) => {
      readFile(input.files && input.files[0]);
    })
  );
  state.off.push(
    on(ctx.el, 'input', '#qi-text', (event, textarea) => {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => setContent(textarea.value, ''), 350);
    })
  );
  state.off.push(
    on(ctx.el, 'click', '[data-act]', (event, button) => {
      const act = button.dataset.act;
      if (act === 'import') {
        event.preventDefault();
        runImport();
      } else if (act === 'clear' || act === 'reset') {
        event.preventDefault();
        const textarea = qs('#qi-text', ctx.el);
        if (textarea) textarea.value = '';
        const input = qs('[data-file]', ctx.el);
        if (input) input.value = '';
        setContent('', '');
      }
    })
  );

  const drop = qs('[data-drop]', ctx.el);
  if (drop) {
    const over = (event) => {
      event.preventDefault();
      drop.classList.add('is-over');
    };
    const leave = () => drop.classList.remove('is-over');
    const dropped = (event) => {
      event.preventDefault();
      leave();
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      readFile(file);
    };
    drop.addEventListener('dragover', over);
    drop.addEventListener('dragleave', leave);
    drop.addEventListener('drop', dropped);
    state.off.push(() => {
      drop.removeEventListener('dragover', over);
      drop.removeEventListener('dragleave', leave);
      drop.removeEventListener('drop', dropped);
    });
  }
}

function renderImportPage(ctx) {
  ctx.setTitle('Importar questões');
  render(ctx.el, skeleton('form', 3));

  state = { ctx, csv: '', parsed: null, result: null, timer: null, off: [] };
  render(ctx.el, view());
  bind(ctx);
  repaint();
}

export default renderImportPage;

export function unmount() {
  if (!state) return;
  clearTimeout(state.timer);
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}
