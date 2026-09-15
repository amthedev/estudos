// =====================================================================
// Foco Elite — Admin › Página inicial (/admin/pagina-inicial)
//
// Tudo o que o visitante lê em focoelite.com.br é editado aqui: os blocos
// de texto, os depoimentos, as perguntas frequentes e as provas em
// destaque. Nada é fixo no código — a página inicial lê GET /api/landing,
// que devolve exatamente o que estiver salvo nestas quatro abas.
//
// API: GET/PUT  /api/admin/landing/blocks[/:key]
//      GET/POST/PUT/DELETE/PATCH /api/admin/landing/faqs
//      GET/POST/PUT/DELETE/PATCH /api/admin/landing/testimonials
//      GET/PUT  /api/admin/landing/exams[/:id]
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render, toast, confirm, qs, qsa, on, escapeHtml,
  pageHeader, skeleton, errorState, emptyState, badge, alertBox, tabs,
  serializeForm, applyApiErrors, clearFieldErrors, setLoading,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { truncate } from '../../core/format.js';
import { attachUploadsIn } from '../../components/file-input.js';

let state = null;

const TABS = [
  { id: 'blocks', label: 'Blocos de texto', icon: 'align-left' },
  { id: 'testimonials', label: 'Depoimentos', icon: 'quote' },
  { id: 'faqs', label: 'Perguntas frequentes', icon: 'circle-help' },
  { id: 'exams', label: 'Provas em destaque', icon: 'graduation-cap' },
];

/** Nome e explicação de cada bloco da página inicial. */
const BLOCK_INFO = {
  hero: { label: 'Abertura', hint: 'Primeira dobra da página: é o primeiro texto que o visitante lê. Os itens viram a faixa de recursos.' },
  dores: { label: 'Reconhece isso?', hint: 'Seção em que o aluno se identifica com o problema. Cada item é uma dificuldade.' },
  objetivos: { label: 'Escolha seu objetivo', hint: 'Texto de apoio dos cards de prova. Os cards em si saem da aba Provas em destaque.' },
  como_funciona: { label: 'Como funciona', hint: 'Passo a passo da plataforma. Cada item é um passo, na ordem em que aparece aqui.' },
  planos: { label: 'Planos', hint: 'Título da seção de preços. Os planos e os valores vêm da tela Planos e assinaturas.' },
  tudo_em_um_lugar: { label: 'Tudo em um só lugar', hint: 'Lista de recursos da plataforma. Cada item vira um card com ícone.' },
  depoimentos: { label: 'Depoimentos', hint: 'Título da seção. Os depoimentos são cadastrados na aba Depoimentos.' },
  faq: { label: 'Perguntas frequentes', hint: 'Título da seção. As perguntas são cadastradas na aba Perguntas frequentes.' },
  fechamento: { label: 'Fechamento', hint: 'Última seção da página, com a chamada final para o cadastro.' },
};

const blockInfo = (key) => BLOCK_INFO[key] || { label: String(key).replace(/_/g, ' '), hint: 'Bloco de texto da página inicial.' };

const ICON_HINT = 'Nome do ícone (letras minúsculas e hífens), por exemplo: square-play, target, calendar-days.';

// ---------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------
let sequence = 0;

function field({ name, label, value = '', type = 'text', hint = '', placeholder = '', rows = 3, maxlength = 0, width = 'full', options = null, required = false, upload = '', uploadAccept = 'image' }) {
  sequence += 1;
  const id = `adl-${name}-${sequence}`;
  const attrs = raw(
    `id="${id}" name="${escapeHtml(name)}"${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''}${maxlength ? ` maxlength="${maxlength}"` : ''}${required ? ' required' : ''}`
  );
  let control;
  if (type === 'textarea') {
    control = html`<textarea class="textarea" rows="${rows}" ${attrs}>${value ?? ''}</textarea>`;
  } else if (type === 'select') {
    control = html`
      <select class="select" ${attrs}>
        ${(options || []).map((option) => html`
          <option value="${option.value}" ${String(option.value) === String(value ?? '') ? raw('selected') : ''}>${option.label}</option>`)}
      </select>`;
  } else {
    const uploadAttrs = upload
      ? raw(` data-upload="${escapeHtml(upload)}" data-upload-accept="${escapeHtml(uploadAccept)}"`)
      : '';
    control = html`<input class="input" type="${type}" value="${value ?? ''}" ${attrs}${uploadAttrs}>`;
  }
  return html`
    <div class="field adl-field adl-field-${width}">
      <label class="label" for="${id}">${label}${required ? html`<span class="req" aria-hidden="true">*</span>` : ''}</label>
      ${control}
      ${hint ? html`<p class="hint">${hint}</p>` : ''}
      <p class="error-text" data-error-for="${name}"></p>
    </div>`;
}

function switchField({ name, label, hint = '', checked = false }) {
  sequence += 1;
  const id = `adl-${name}-${sequence}`;
  return html`
    <label class="switch-field adl-switch" for="${id}">
      <span class="adl-switch-text">
        <span class="switch-title">${label}</span>
        ${hint ? html`<span class="hint">${hint}</span>` : ''}
      </span>
      <input type="checkbox" role="switch" class="switch" id="${id}" name="${name}" ${checked ? raw('checked') : ''}>
    </label>`;
}

function saveBar(label = 'Salvar') {
  return html`
    <div class="adl-actions">
      <button type="submit" class="btn btn-primary">${icon('save')}<span>${label}</span></button>
    </div>`;
}

const openLandingButton = (extraClass = '') => html`
  <a class="btn btn-secondary ${extraClass}" href="/" target="_blank" rel="noopener">
    ${icon('external-link')}<span>Ver página inicial</span>
  </a>`;

// ---------------------------------------------------------------------
// Aba: blocos de texto
// ---------------------------------------------------------------------
function itemRow(item = {}) {
  const iconName = item.icon || '';
  return html`
    <div class="adl-item" data-item-row>
      <div class="adl-item-icon">
        <span class="adl-item-preview" data-item-preview>${iconName ? icon(iconName) : icon('shapes')}</span>
        <input class="input input-sm" data-item-field="icon" value="${iconName}" placeholder="ícone" aria-label="Ícone do item" maxlength="60">
      </div>
      <div class="adl-item-texts">
        <input class="input" data-item-field="title" value="${item.title || ''}" placeholder="Título do item" aria-label="Título do item" maxlength="200">
        <input class="input" data-item-field="text" value="${item.text || ''}" placeholder="Texto de apoio (opcional)" aria-label="Texto do item" maxlength="1000">
      </div>
      <div class="adl-item-tools">
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="item-up" aria-label="Mover item para cima">${icon('arrow-up')}</button>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="item-down" aria-label="Mover item para baixo">${icon('arrow-down')}</button>
        <button type="button" class="btn btn-ghost btn-icon btn-sm adl-danger" data-act="item-remove" aria-label="Remover item">${icon('trash-2')}</button>
      </div>
    </div>`;
}

function blockCard(block, index) {
  const info = blockInfo(block.key);
  const items = Array.isArray(block.items) ? block.items : [];
  return html`
    <details class="card adl-block" ${index === 0 ? raw('open') : ''}>
      <summary class="adl-block-summary">
        <span class="adl-block-title">
          ${icon('chevron-right', { className: 'adl-chevron' })}
          <span>${info.label}</span>
          <code class="adl-key">${block.key}</code>
        </span>
        <span class="adl-block-tags">
          ${items.length ? badge(`${items.length} ${items.length === 1 ? 'item' : 'itens'}`, 'gray') : ''}
          ${block.active ? badge('Na página', 'green') : badge('Oculto', 'gray')}
        </span>
      </summary>
      <div class="card-body">
        <p class="adl-block-hint">${info.hint}</p>
        <form data-form="block" data-key="${block.key}" novalidate autocomplete="off">
          <div class="adl-grid">
            ${field({ name: 'eyebrow', label: 'Chapéu', value: block.eyebrow, width: 'half', maxlength: 120, hint: 'Linha curta acima do título.' })}
            ${field({ name: 'sort_order', label: 'Ordem na página', value: block.sort_order ?? 0, type: 'number', width: 'half' })}
            ${field({ name: 'title', label: 'Título', value: block.title, maxlength: 300 })}
            ${field({ name: 'subtitle', label: 'Subtítulo', value: block.subtitle, type: 'textarea', rows: 2, maxlength: 600 })}
            ${field({ name: 'body', label: 'Texto', value: block.body, type: 'textarea', rows: 5, maxlength: 6000, hint: 'Use uma linha em branco para separar parágrafos.' })}
            ${field({ name: 'cta_label', label: 'Texto do botão', value: block.cta_label, width: 'half', maxlength: 80 })}
            ${field({ name: 'cta_href', label: 'Link do botão', value: block.cta_href, width: 'half', placeholder: '/cadastro', hint: 'Caminho interno (/cadastro), âncora (#planos) ou URL completa.' })}
            ${field({ name: 'image_url', label: 'Imagem', value: block.image_url, placeholder: 'https://… ou envie a imagem', hint: 'Deixe em branco para não exibir imagem neste bloco.', upload: 'geral' })}
          </div>

          <div class="adl-items-head">
            <span class="label">Itens do bloco</span>
            <button type="button" class="btn btn-secondary btn-sm" data-act="item-add">${icon('plus')}<span>Adicionar item</span></button>
          </div>
          <p class="hint adl-items-hint">${ICON_HINT}</p>
          <div class="adl-items" data-items>
            ${items.map((item) => itemRow(item))}
          </div>
          <p class="hint adl-items-empty" ${items.length ? raw('hidden') : ''}>Nenhum item neste bloco.</p>

          ${switchField({ name: 'active', label: 'Exibir na página inicial', checked: block.active !== false })}
          ${saveBar('Salvar bloco')}
        </form>
      </div>
    </details>`;
}

function blocksPanel() {
  const blocks = state.data.blocks || [];
  return html`
    ${alertBox({
      type: 'info',
      title: 'Este texto aparece na página inicial',
      text: 'Tudo o que estiver salvo aqui é o que o visitante lê antes de se cadastrar. Confira no site depois de salvar.',
      actions: openLandingButton('btn-sm'),
    })}
    ${blocks.length
      ? html`<div class="adl-blocks">${blocks.map((block, index) => blockCard(block, index))}</div>`
      : emptyState({
        icon: 'align-left',
        title: 'Nenhum bloco cadastrado',
        text: 'Rode o seed da plataforma para criar os blocos da página inicial.',
      })}`;
}

/** Lê os itens digitados; linhas totalmente em branco são descartadas. */
function readItems(form) {
  return qsa('[data-item-row]', form)
    .map((row) => {
      const read = (name) => {
        const input = qs(`[data-item-field="${name}"]`, row);
        return input ? input.value.trim() : '';
      };
      return { icon: read('icon'), title: read('title'), text: read('text') };
    })
    .filter((item) => item.icon || item.title || item.text);
}

async function saveBlock(form) {
  const values = serializeForm(form);
  const payload = {
    eyebrow: values.eyebrow ?? '',
    title: values.title ?? '',
    subtitle: values.subtitle ?? '',
    body: values.body ?? '',
    cta_label: values.cta_label ?? '',
    cta_href: values.cta_href ?? '',
    image_url: values.image_url ?? '',
    active: Boolean(values.active),
    items: readItems(form),
  };
  if (String(values.sort_order ?? '').trim() !== '') payload.sort_order = Number(values.sort_order);
  await api.put(`/api/admin/landing/blocks/${encodeURIComponent(form.dataset.key)}`, payload);
  toast('Bloco salvo. A página inicial já mostra o novo texto.', { type: 'success' });
  await reload('blocks');
}

// ---------------------------------------------------------------------
// Aba: depoimentos
// ---------------------------------------------------------------------
function stars(rating) {
  const value = Number(rating) || 0;
  if (!value) return '';
  return html`<span class="adl-stars" aria-label="Nota ${value} de 5">
    ${[1, 2, 3, 4, 5].map((position) => html`<span class="adl-star ${position <= value ? 'is-on' : ''}">${icon('star', { size: 14 })}</span>`)}
  </span>`;
}

function testimonialPreview(values = {}) {
  const name = (values.name || '').trim();
  const role = (values.role || '').trim();
  const content = (values.content || '').trim();
  const image = (values.image_url || '').trim();
  const video = (values.video_url || '').trim();
  const photo = (values.photo_url || '').trim();
  const exam = (state.data.exams || []).find((item) => item.id === values.exam_id);
  return html`
    <figure class="adl-card-preview">
      <figcaption class="adl-card-head">
        ${photo
          ? html`<img class="avatar adl-card-photo" src="${photo}" alt="" loading="lazy">`
          : html`<span class="avatar adl-card-photo adl-card-photo-empty">${icon('user')}</span>`}
        <span class="adl-card-identity">
          <strong>${name || 'Nome do aluno'}</strong>
          ${role ? html`<span class="adl-card-role">${role}</span>` : ''}
        </span>
      </figcaption>
      ${stars(values.rating)}
      ${content ? html`<blockquote class="adl-card-quote">${content}</blockquote>` : ''}
      ${image ? html`<img class="adl-card-shot" src="${image}" alt="Print da conversa" loading="lazy">` : ''}
      ${video ? html`<video class="adl-card-shot" src="${video}" controls preload="metadata"></video>` : ''}
      ${!content && !image && !video ? html`<p class="hint">Escreva o depoimento, envie o vídeo ou informe a imagem do print para ver a prévia.</p>` : ''}
      ${exam ? html`<span class="adl-card-exam">${badge(exam.short_name || exam.name, 'blue')}</span>` : ''}
    </figure>`;
}

function testimonialForm() {
  const editing = state.editing.testimonial;
  const current = editing || {};
  const examOptions = [{ value: '', label: 'Nenhuma' }].concat(
    (state.data.exams || []).map((exam) => ({ value: exam.id, label: exam.short_name || exam.name }))
  );
  const ratingOptions = [{ value: '', label: 'Sem nota' }].concat(
    [5, 4, 3, 2, 1].map((value) => ({ value: String(value), label: `${value} de 5` }))
  );
  return html`
    <section class="card adl-editor" id="adl-testimonial-form">
      <div class="card-header">
        <h2 class="card-title">${icon('quote')}<span>${editing ? 'Editar depoimento' : 'Novo depoimento'}</span></h2>
        ${editing ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="testimonial-cancel">${icon('x')}<span>Cancelar edição</span></button>` : ''}
      </div>
      <div class="card-body adl-editor-body">
        <form data-form="testimonial" novalidate autocomplete="off">
          <div class="adl-grid">
            ${field({ name: 'name', label: 'Nome do aluno', value: current.name, width: 'half', required: true, maxlength: 120 })}
            ${field({ name: 'role', label: 'Papel', value: current.role, width: 'half', placeholder: 'Aprovada em Medicina', maxlength: 120 })}
            ${field({ name: 'content', label: 'Depoimento em texto', value: current.content, type: 'textarea', rows: 5, maxlength: 4000, hint: 'Texto, print ou vídeo — pelo menos um dos três.' })}
            ${field({ name: 'image_url', label: 'Print da conversa', value: current.image_url, placeholder: 'https://… ou envie a imagem', hint: 'Use quando o depoimento for uma captura de tela.', upload: 'depoimentos' })}
            ${field({ name: 'video_url', label: 'Vídeo do depoimento', value: current.video_url, placeholder: 'https://… ou envie o vídeo', hint: 'Aluno falando em vídeo (MP4/MOV). Aparece separado dos prints na página inicial.', upload: 'depoimentos', uploadAccept: 'video' })}
            ${field({ name: 'photo_url', label: 'Foto do aluno', value: current.photo_url, placeholder: 'https://… ou envie a imagem', upload: 'depoimentos' })}
            ${field({ name: 'rating', label: 'Nota', value: current.rating ?? '', type: 'select', width: 'half', options: ratingOptions })}
            ${field({ name: 'exam_id', label: 'Prova relacionada', value: current.exam_id ?? '', type: 'select', width: 'half', options: examOptions })}
            ${field({ name: 'sort_order', label: 'Ordem', value: current.sort_order ?? '', type: 'number', width: 'half' })}
          </div>
          ${switchField({ name: 'active', label: 'Exibir na página inicial', checked: current.active !== false })}
          ${saveBar(editing ? 'Salvar depoimento' : 'Cadastrar depoimento')}
        </form>
        <aside class="adl-preview" aria-live="polite">
          <span class="label">Prévia do card</span>
          <div data-preview>${testimonialPreview(current)}</div>
        </aside>
      </div>
    </section>`;
}

function testimonialsPanel() {
  const list = state.data.testimonials || [];
  return html`
    ${alertBox({
      type: 'info',
      title: 'Depoimentos da página inicial',
      text: 'O depoimento pode ser um texto ou o print de uma conversa. A ordem desta lista é a ordem em que os cards aparecem no site.',
      actions: openLandingButton('btn-sm'),
    })}
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('users')}<span>Depoimentos</span></h2>
        <button type="button" class="btn btn-primary btn-sm" data-act="testimonial-new">${icon('plus')}<span>Novo depoimento</span></button>
      </div>
      <div class="card-body">
        ${list.length
          ? html`
            <div class="table-wrap">
              <table class="table adl-table">
                <thead>
                  <tr>
                    <th scope="col">Aluno</th>
                    <th scope="col">Depoimento</th>
                    <th scope="col">Nota</th>
                    <th scope="col">Prova</th>
                    <th scope="col">Situação</th>
                    <th scope="col"><span class="sr-only">Ações</span></th>
                  </tr>
                </thead>
                <tbody>
                  ${list.map((item, index) => html`
                    <tr data-id="${item.id}">
                      <td>
                        <div class="adl-person">
                          ${item.photo_url
                            ? html`<img class="avatar avatar-sm" src="${item.photo_url}" alt="" loading="lazy">`
                            : html`<span class="avatar avatar-sm adl-card-photo-empty">${icon('user', { size: 14 })}</span>`}
                          <span>
                            <strong>${item.name}</strong>
                            ${item.role ? html`<span class="adl-person-role">${item.role}</span>` : ''}
                          </span>
                        </div>
                      </td>
                      <td>
                        ${item.content
                          ? html`<span class="adl-quote-cell">${truncate(item.content, 120)}</span>`
                          : html`<span class="chip">${icon('image', { size: 14 })}<span>Print da conversa</span></span>`}
                      </td>
                      <td>${item.rating ? stars(item.rating) : html`<span class="text-3">—</span>`}</td>
                      <td>${item.exam_short_name ? badge(item.exam_short_name, 'blue') : html`<span class="text-3">—</span>`}</td>
                      <td>${item.active ? badge('Ativo', 'green') : badge('Oculto', 'gray')}</td>
                      <td class="adl-row-tools">
                        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="testimonial-up" data-id="${item.id}" aria-label="Subir depoimento" ${index === 0 ? raw('disabled') : ''}>${icon('arrow-up')}</button>
                        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="testimonial-down" data-id="${item.id}" aria-label="Descer depoimento" ${index === list.length - 1 ? raw('disabled') : ''}>${icon('arrow-down')}</button>
                        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="testimonial-edit" data-id="${item.id}" aria-label="Editar depoimento">${icon('square-pen')}</button>
                        <button type="button" class="btn btn-ghost btn-icon btn-sm adl-danger" data-act="testimonial-delete" data-id="${item.id}" aria-label="Excluir depoimento">${icon('trash-2')}</button>
                      </td>
                    </tr>`)}
                </tbody>
              </table>
            </div>`
          : emptyState({
            icon: 'quote',
            title: 'Nenhum depoimento cadastrado',
            text: 'Enquanto não houver depoimentos, a seção não aparece na página inicial.',
          })}
      </div>
    </section>
    ${testimonialForm()}`;
}

async function saveTestimonial(form) {
  const values = serializeForm(form);
  const payload = {
    name: (values.name || '').trim(),
    role: values.role ?? '',
    content: values.content ?? '',
    image_url: values.image_url ?? '',
    video_url: values.video_url ?? '',
    photo_url: values.photo_url ?? '',
    rating: values.rating ?? '',
    exam_id: values.exam_id ?? '',
    active: Boolean(values.active),
  };
  if (String(values.sort_order ?? '').trim() !== '') payload.sort_order = Number(values.sort_order);

  const editing = state.editing.testimonial;
  if (editing) await api.put(`/api/admin/landing/testimonials/${editing.id}`, payload);
  else await api.post('/api/admin/landing/testimonials', payload);

  toast(editing ? 'Depoimento salvo.' : 'Depoimento cadastrado.', { type: 'success' });
  state.editing.testimonial = null;
  await reload('testimonials');
}

// ---------------------------------------------------------------------
// Aba: perguntas frequentes
// ---------------------------------------------------------------------
function faqForm() {
  const editing = state.editing.faq;
  const current = editing || {};
  return html`
    <section class="card adl-editor" id="adl-faq-form">
      <div class="card-header">
        <h2 class="card-title">${icon('circle-help')}<span>${editing ? 'Editar pergunta' : 'Nova pergunta'}</span></h2>
        ${editing ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="faq-cancel">${icon('x')}<span>Cancelar edição</span></button>` : ''}
      </div>
      <div class="card-body">
        <form data-form="faq" novalidate autocomplete="off">
          <div class="adl-grid">
            ${field({ name: 'question', label: 'Pergunta', value: current.question, required: true, maxlength: 300 })}
            ${field({ name: 'answer', label: 'Resposta', value: current.answer, type: 'textarea', rows: 5, maxlength: 6000, required: true, hint: 'Escreva {{planos}} onde os preços atuais devem aparecer.' })}
            ${field({ name: 'sort_order', label: 'Ordem', value: current.sort_order ?? '', type: 'number', width: 'half' })}
          </div>
          ${switchField({ name: 'active', label: 'Exibir na página inicial', checked: current.active !== false })}
          ${saveBar(editing ? 'Salvar pergunta' : 'Cadastrar pergunta')}
        </form>
      </div>
    </section>`;
}

function faqsPanel() {
  const list = state.data.faqs || [];
  return html`
    ${alertBox({
      type: 'info',
      title: 'O marcador {{planos}} vira a lista de preços',
      text: 'Onde a resposta tiver {{planos}}, a página inicial mostra os planos ativos com os valores atuais, um por linha. Assim o preço nunca fica desatualizado no texto.',
      actions: openLandingButton('btn-sm'),
    })}
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('list')}<span>Perguntas</span></h2>
        <button type="button" class="btn btn-primary btn-sm" data-act="faq-new">${icon('plus')}<span>Nova pergunta</span></button>
      </div>
      <div class="card-body">
        ${list.length
          ? html`<ol class="adl-faq-list">
              ${list.map((item, index) => html`
                <li class="adl-faq-item" data-id="${item.id}">
                  <div class="adl-faq-main">
                    <div class="adl-faq-question">
                      <span>${item.question}</span>
                      ${item.active ? '' : badge('Oculta', 'gray')}
                      ${String(item.answer || '').includes('{{planos}}') ? badge('Mostra os preços', 'blue') : ''}
                    </div>
                    <p class="adl-faq-answer">${truncate(String(item.answer || '').replace(/\s+/g, ' '), 160)}</p>
                  </div>
                  <div class="adl-row-tools">
                    <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="faq-up" data-id="${item.id}" aria-label="Subir pergunta" ${index === 0 ? raw('disabled') : ''}>${icon('arrow-up')}</button>
                    <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="faq-down" data-id="${item.id}" aria-label="Descer pergunta" ${index === list.length - 1 ? raw('disabled') : ''}>${icon('arrow-down')}</button>
                    <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="faq-edit" data-id="${item.id}" aria-label="Editar pergunta">${icon('square-pen')}</button>
                    <button type="button" class="btn btn-ghost btn-icon btn-sm adl-danger" data-act="faq-delete" data-id="${item.id}" aria-label="Excluir pergunta">${icon('trash-2')}</button>
                  </div>
                </li>`)}
            </ol>`
          : emptyState({
            icon: 'circle-help',
            title: 'Nenhuma pergunta cadastrada',
            text: 'Sem perguntas, a seção de dúvidas não aparece na página inicial.',
          })}
      </div>
    </section>
    ${faqForm()}`;
}

async function saveFaq(form) {
  const values = serializeForm(form);
  const payload = {
    question: (values.question || '').trim(),
    answer: (values.answer || '').trim(),
    active: Boolean(values.active),
  };
  if (String(values.sort_order ?? '').trim() !== '') payload.sort_order = Number(values.sort_order);

  const editing = state.editing.faq;
  if (editing) await api.put(`/api/admin/landing/faqs/${editing.id}`, payload);
  else await api.post('/api/admin/landing/faqs', payload);

  toast(editing ? 'Pergunta salva.' : 'Pergunta cadastrada.', { type: 'success' });
  state.editing.faq = null;
  await reload('faqs');
}

// ---------------------------------------------------------------------
// Aba: provas em destaque
// ---------------------------------------------------------------------
function examCard(exam) {
  return html`
    <section class="card adl-exam ${exam.featured ? 'is-featured' : ''}">
      <div class="card-header">
        <h2 class="card-title">
          ${icon('graduation-cap')}<span>${exam.short_name || exam.name}</span>
        </h2>
        <span class="adl-block-tags">
          ${exam.featured ? badge('Em destaque', 'green') : badge('Fora da página', 'gray')}
          ${exam.active ? '' : badge('Prova inativa', 'orange')}
        </span>
      </div>
      <div class="card-body">
        <form data-form="exam" data-id="${exam.id}" novalidate autocomplete="off">
          <div class="adl-exam-body">
            <div class="adl-logo">
              <span class="label">Logo</span>
              <div class="adl-logo-preview" data-logo-preview>
                ${exam.logo_url
                  ? html`<img src="${exam.logo_url}" alt="Logo de ${exam.short_name || exam.name}" loading="lazy">`
                  : html`<span class="hint">Sem logo</span>`}
              </div>
            </div>
            <div class="adl-grid adl-exam-fields">
              ${field({ name: 'logo_url', label: 'Logo da prova', value: exam.logo_url, placeholder: 'https://… ou envie a imagem', hint: 'Aparece no card desta prova na página inicial.', upload: 'logos' })}
              ${field({ name: 'landing_headline', label: 'Chamada', value: exam.landing_headline, maxlength: 120, placeholder: exam.short_name || exam.name })}
              ${field({ name: 'landing_text', label: 'Texto do card', value: exam.landing_text, type: 'textarea', rows: 4, maxlength: 2000 })}
              ${field({ name: 'landing_cta', label: 'Texto do botão', value: exam.landing_cta, maxlength: 80, placeholder: 'Quero estudar para o ENEM' })}
            </div>
          </div>
          ${switchField({
            name: 'featured',
            label: 'Mostrar na página inicial',
            hint: exam.active ? '' : 'Esta prova está inativa e não aparece no site, mesmo em destaque.',
            checked: Boolean(exam.featured),
          })}
          ${saveBar('Salvar prova')}
        </form>
      </div>
    </section>`;
}

function examsPanel() {
  const list = state.data.exams || [];
  return html`
    ${alertBox({
      type: 'info',
      title: 'Provas em destaque na página inicial',
      text: 'Só as provas marcadas como destaque (e ativas) viram cards na seção "Escolha seu objetivo".',
      actions: openLandingButton('btn-sm'),
    })}
    ${list.length
      ? html`<div class="adl-exams">${list.map((exam) => examCard(exam))}</div>`
      : emptyState({ icon: 'graduation-cap', title: 'Nenhuma prova cadastrada', text: 'Cadastre as provas em Vestibulares para poder destacá-las aqui.' })}`;
}

async function saveExam(form) {
  const values = serializeForm(form);
  await api.put(`/api/admin/landing/exams/${form.dataset.id}`, {
    featured: Boolean(values.featured),
    logo_url: values.logo_url ?? '',
    landing_headline: values.landing_headline ?? '',
    landing_text: values.landing_text ?? '',
    landing_cta: values.landing_cta ?? '',
  });
  toast('Prova atualizada.', { type: 'success' });
  await reload('exams');
}

// ---------------------------------------------------------------------
// Reordenação e exclusão
// ---------------------------------------------------------------------
async function move(kind, id, direction) {
  const list = state.data[kind] || [];
  const ids = list.map((item) => item.id);
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  try {
    await api.patch(`/api/admin/landing/${kind}/reorder`, { ids });
    await reload(kind);
  } catch (err) {
    toast((err && err.message) || 'Não foi possível reordenar.', { type: 'error' });
  }
}

async function remove(kind, id, { title, message }) {
  const ok = await confirm({ title, message, danger: true, confirmText: 'Excluir' });
  if (!ok) return;
  try {
    await api.del(`/api/admin/landing/${kind}/${id}`);
    if (state.editing.faq && state.editing.faq.id === id) state.editing.faq = null;
    if (state.editing.testimonial && state.editing.testimonial.id === id) state.editing.testimonial = null;
    toast('Registro excluído.', { type: 'success' });
    await reload(kind);
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Carregamento e renderização
// ---------------------------------------------------------------------
const ENDPOINTS = {
  blocks: '/api/admin/landing/blocks',
  testimonials: '/api/admin/landing/testimonials',
  faqs: '/api/admin/landing/faqs',
  exams: '/api/admin/landing/exams',
};

async function reload(kind) {
  const keys = kind ? [kind] : Object.keys(ENDPOINTS);
  const results = await Promise.all(keys.map((key) => api.get(ENDPOINTS[key])));
  keys.forEach((key, index) => {
    state.data[key] = results[index] || [];
  });
  paintPanel();
}

function header() {
  return pageHeader({
    title: 'Página inicial',
    subtitle: 'Textos de venda, depoimentos, perguntas frequentes e provas em destaque do site.',
    actions: html`
      ${openLandingButton()}
      <button type="button" class="btn btn-ghost" data-act="reload">${icon('refresh-cw')}<span>Atualizar</span></button>`,
  });
}

function paintPanel() {
  const panel = qs('#adl-panel', state.ctx.el);
  if (!panel) return;
  const views = { blocks: blocksPanel, testimonials: testimonialsPanel, faqs: faqsPanel, exams: examsPanel };
  render(panel, (views[state.tab] || blocksPanel)());
  // os campos de arquivo são recriados a cada troca de aba
  if (state.uploads) state.uploads.destroy();
  state.uploads = attachUploadsIn(panel);
  if (state.tabsApi) {
    TABS.forEach((tab) => state.tabsApi.setCount(tab.id, (state.data[tab.id] || []).length));
  }
}

function paint() {
  render(state.ctx.el, html`
    <div class="adl-page">
      ${header()}
      <div id="adl-tabs"></div>
      <div id="adl-panel"></div>
    </div>`);

  state.tabsApi = tabs(qs('#adl-tabs', state.ctx.el), TABS, (id) => {
    state.tab = id;
    paintPanel();
  }, { active: state.tab });

  paintPanel();
}

async function load() {
  render(state.ctx.el, html`${header()}${skeleton('form', 5)}`);
  try {
    const keys = Object.keys(ENDPOINTS);
    const results = await Promise.all(keys.map((key) => api.get(ENDPOINTS[key])));
    keys.forEach((key, index) => {
      state.data[key] = results[index] || [];
    });
  } catch (err) {
    render(state.ctx.el, html`
      ${header()}
      ${errorState({
        title: 'Não foi possível carregar a página inicial',
        message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
      })}`);
    return;
  }
  paint();
}

// ---------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------
const SAVERS = { block: saveBlock, testimonial: saveTestimonial, faq: saveFaq, exam: saveExam };

async function submitForm(form) {
  const saver = SAVERS[form.dataset.form];
  if (!saver) return;
  const button = qs('button[type="submit"]', form);
  clearFieldErrors(form);
  setLoading(button, true);
  try {
    await saver(form);
  } catch (err) {
    const applied = applyApiErrors(form, err);
    toast(
      (err && err.message) || 'Não foi possível salvar.',
      { type: 'error', title: applied ? 'Verifique os campos destacados' : '' }
    );
  } finally {
    setLoading(button, false);
  }
}

function handleClick(event, target) {
  const act = target.dataset.act;
  const id = target.dataset.id;

  if (act === 'reload') return load();

  if (act === 'item-add') {
    const form = target.closest('form');
    const list = qs('[data-items]', form);
    list.insertAdjacentHTML('beforeend', String(itemRow()));
    const empty = qs('.adl-items-empty', form);
    if (empty) empty.hidden = true;
    const added = list.lastElementChild;
    const input = added && qs('[data-item-field="icon"]', added);
    if (input) input.focus();
    return undefined;
  }
  if (act === 'item-remove') {
    const row = target.closest('[data-item-row]');
    const form = target.closest('form');
    if (row) row.remove();
    const empty = qs('.adl-items-empty', form);
    if (empty) empty.hidden = qsa('[data-item-row]', form).length > 0;
    return undefined;
  }
  if (act === 'item-up' || act === 'item-down') {
    const row = target.closest('[data-item-row]');
    if (!row) return undefined;
    const sibling = act === 'item-up' ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return undefined;
    if (act === 'item-up') row.parentNode.insertBefore(row, sibling);
    else row.parentNode.insertBefore(sibling, row);
    return undefined;
  }

  if (act === 'testimonial-new') {
    state.editing.testimonial = null;
    paintPanel();
    const form = qs('#adl-testimonial-form', state.ctx.el);
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return undefined;
  }
  if (act === 'testimonial-edit') {
    state.editing.testimonial = (state.data.testimonials || []).find((item) => item.id === id) || null;
    paintPanel();
    const form = qs('#adl-testimonial-form', state.ctx.el);
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return undefined;
  }
  if (act === 'testimonial-cancel') {
    state.editing.testimonial = null;
    paintPanel();
    return undefined;
  }
  if (act === 'testimonial-up') return move('testimonials', id, -1);
  if (act === 'testimonial-down') return move('testimonials', id, 1);
  if (act === 'testimonial-delete') {
    const item = (state.data.testimonials || []).find((entry) => entry.id === id);
    return remove('testimonials', id, {
      title: 'Excluir depoimento',
      message: `O depoimento de ${item ? item.name : 'este aluno'} sai da página inicial. Esta ação não pode ser desfeita.`,
    });
  }

  if (act === 'faq-new') {
    state.editing.faq = null;
    paintPanel();
    const form = qs('#adl-faq-form', state.ctx.el);
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return undefined;
  }
  if (act === 'faq-edit') {
    state.editing.faq = (state.data.faqs || []).find((item) => item.id === id) || null;
    paintPanel();
    const form = qs('#adl-faq-form', state.ctx.el);
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return undefined;
  }
  if (act === 'faq-cancel') {
    state.editing.faq = null;
    paintPanel();
    return undefined;
  }
  if (act === 'faq-up') return move('faqs', id, -1);
  if (act === 'faq-down') return move('faqs', id, 1);
  if (act === 'faq-delete') {
    const item = (state.data.faqs || []).find((entry) => entry.id === id);
    return remove('faqs', id, {
      title: 'Excluir pergunta',
      message: `"${item ? truncate(item.question, 80) : 'Esta pergunta'}" sai da página inicial. Esta ação não pode ser desfeita.`,
    });
  }

  return undefined;
}

/** Prévias que acompanham a digitação: ícone dos itens, card do depoimento e logo da prova. */
function handleInput(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (target.dataset.itemField === 'icon') {
    const preview = qs('[data-item-preview]', target.closest('[data-item-row]'));
    if (preview) render(preview, target.value.trim() ? icon(target.value.trim()) : icon('shapes'));
    return;
  }

  const form = target.closest('form[data-form]');
  if (!form) return;

  if (form.dataset.form === 'testimonial') {
    const preview = qs('[data-preview]', form.parentElement);
    if (preview) render(preview, testimonialPreview(serializeForm(form)));
    return;
  }

  if (form.dataset.form === 'exam' && target.name === 'logo_url') {
    const box = qs('[data-logo-preview]', form);
    const value = target.value.trim();
    if (box) {
      render(box, value ? html`<img src="${value}" alt="Prévia da logo" loading="lazy">` : html`<span class="hint">Sem logo</span>`);
    }
  }
}

export default async function renderLandingPage(ctx) {
  ctx.setTitle('Página inicial');
  state = { ctx, tab: 'blocks', tabsApi: null, data: { blocks: [], testimonials: [], faqs: [], exams: [] }, editing: { faq: null, testimonial: null }, off: [] };

  state.off.push(on(ctx.el, 'click', '[data-act]', handleClick));
  state.off.push(on(ctx.el, 'click', '[data-action="retry"]', () => load()));
  state.off.push(on(ctx.el, 'submit', 'form[data-form]', (event, target) => {
    event.preventDefault();
    submitForm(target);
  }));
  ctx.el.addEventListener('input', handleInput);
  state.off.push(() => ctx.el.removeEventListener('input', handleInput));

  await load();
}

export function unmount() {
  if (!state) return;
  if (state.uploads) state.uploads.destroy();
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}
