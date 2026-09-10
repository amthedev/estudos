// -----------------------------------------------------------------------------
// Envio de arquivo acoplado a um campo de URL.
//
// A equipe recebe logo, print de depoimento e PDF de edital como arquivo, não
// como link. Este componente encosta em qualquer <input> de URL já existente e
// acrescenta o botão de enviar, arrastar-e-soltar, colar da área de transferência
// e a prévia do que foi enviado. O campo continua aceitando um link digitado:
// quem já tem o arquivo hospedado não é obrigado a subir de novo.
//
//   attachFileUpload(input, { folder: 'logos', accept: 'image' })
//
// Envia direto para POST /api/admin/uploads com o corpo bruto (sem multipart) e
// escreve a URL devolvida no campo, disparando 'input' e 'change' para que a
// tela que estiver ouvindo reaja igual à digitação.
// -----------------------------------------------------------------------------
import { icon } from '../core/icons.js';
import { toast } from '../core/ui.js';
import { fmtBytes } from '../core/format.js';

/** Extensões oferecidas no seletor por finalidade. */
const ACCEPT = {
  image: 'image/png,image/jpeg,image/webp,image/gif',
  document: 'application/pdf',
  any: 'image/png,image/jpeg,image/webp,image/gif,application/pdf',
};

const LIMIT_TEXT = {
  image: 'PNG, JPG, WEBP ou GIF até 5 MB',
  document: 'PDF até 20 MB',
  any: 'imagem até 5 MB ou PDF até 20 MB',
};

function isImageUrl(url) {
  return /\.(png|jpe?g|webp|gif)(\?|$)/i.test(String(url || ''));
}

function isPdfUrl(url) {
  return /\.pdf(\?|$)/i.test(String(url || ''));
}

/**
 * Sobe um arquivo e devolve os dados gravados.
 * @param {File|Blob} file
 * @param {{ folder?: string, onProgress?: (pct:number)=>void }} options
 * @returns {Promise<{url:string, bytes:number, content_type:string, kind:string}>}
 */
export function uploadFile(file, { folder = 'geral', onProgress } = {}) {
  const name = file.name || 'arquivo';
  const query = `?folder=${encodeURIComponent(folder)}&filename=${encodeURIComponent(name)}`;

  // XMLHttpRequest em vez de fetch: é o único jeito de ter progresso de envio,
  // que importa para PDF de edital em conexão lenta.
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/admin/uploads${query}`);
    request.setRequestHeader('X-Requested-With', 'FocoElite');
    if (file.type) request.setRequestHeader('Content-Type', file.type);
    request.withCredentials = true;

    if (onProgress && request.upload) {
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      });
    }

    request.addEventListener('load', () => {
      let payload = null;
      try {
        payload = JSON.parse(request.responseText || 'null');
      } catch {
        payload = null;
      }
      if (request.status >= 200 && request.status < 300 && payload?.url) {
        resolve(payload);
        return;
      }
      const message = payload?.error?.message || 'Não foi possível enviar o arquivo.';
      const error = new Error(message);
      error.status = request.status;
      error.code = payload?.error?.code;
      reject(error);
    });
    request.addEventListener('error', () => reject(new Error('Falha de conexão ao enviar o arquivo.')));
    request.addEventListener('abort', () => reject(new Error('Envio cancelado.')));
    request.send(file);
  });
}

/**
 * Acopla o envio de arquivo a um campo de URL já renderizado.
 *
 * @param {HTMLInputElement} input campo que guarda a URL
 * @param {object} options
 * @param {string} [options.folder] pasta de destino (logos, depoimentos, editais, provas, aulas, geral)
 * @param {'image'|'document'|'any'} [options.accept]
 * @param {boolean} [options.preview] mostra miniatura da imagem ou nome do PDF
 * @param {(file:object)=>void} [options.onUploaded]
 * @returns {{ destroy(): void, setValue(url: string): void }}
 */
export function attachFileUpload(input, options = {}) {
  if (!input || input.dataset.fileUpload === 'on') return { destroy() {}, setValue() {} };
  const { folder = 'geral', accept = 'image', preview = true, onUploaded } = options;
  input.dataset.fileUpload = 'on';

  const wrap = document.createElement('div');
  wrap.className = 'fu';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.classList.add('fu-url');

  const bar = document.createElement('div');
  bar.className = 'fu-bar';
  bar.innerHTML = `
    <button type="button" class="btn btn-secondary btn-sm fu-pick">${icon('upload')}<span>Enviar arquivo</span></button>
    <span class="fu-hint">ou arraste aqui · ${LIMIT_TEXT[accept] || LIMIT_TEXT.any}</span>
    <button type="button" class="btn btn-ghost btn-sm fu-clear" hidden>${icon('trash-2')}<span>Remover</span></button>`;
  wrap.appendChild(bar);

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = ACCEPT[accept] || ACCEPT.any;
  picker.hidden = true;
  wrap.appendChild(picker);

  const status = document.createElement('div');
  status.className = 'fu-status';
  status.hidden = true;
  wrap.appendChild(status);

  const figure = document.createElement('div');
  figure.className = 'fu-preview';
  figure.hidden = true;
  if (preview) wrap.appendChild(figure);

  const pickButton = bar.querySelector('.fu-pick');
  const clearButton = bar.querySelector('.fu-clear');

  function renderPreview() {
    const url = input.value.trim();
    clearButton.hidden = !url;
    if (!preview) return;
    if (!url) {
      figure.hidden = true;
      figure.innerHTML = '';
      return;
    }
    figure.hidden = false;
    if (isPdfUrl(url)) {
      figure.innerHTML = `<a class="fu-doc" href="${url}" target="_blank" rel="noopener">${icon('file-text')}<span>Abrir o PDF enviado</span></a>`;
    } else if (isImageUrl(url) || url.startsWith('/uploads/')) {
      figure.innerHTML = `<img class="fu-img" src="${url}" alt="Prévia do arquivo enviado" loading="lazy">`;
    } else {
      figure.innerHTML = `<a class="fu-doc" href="${url}" target="_blank" rel="noopener">${icon('external-link')}<span>Abrir o link</span></a>`;
    }
  }

  function setValue(url) {
    input.value = url || '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    renderPreview();
  }

  async function send(file) {
    if (!file) return;
    status.hidden = false;
    status.className = 'fu-status';
    status.textContent = 'Enviando…';
    pickButton.disabled = true;
    try {
      const saved = await uploadFile(file, {
        folder,
        onProgress: (pct) => {
          status.textContent = pct < 100 ? `Enviando… ${pct}%` : 'Processando…';
        },
      });
      setValue(saved.url);
      status.className = 'fu-status ok';
      status.textContent = saved.reused
        ? 'Este arquivo já estava no servidor e foi reaproveitado.'
        : `Enviado (${fmtBytes(saved.bytes)}).`;
      if (onUploaded) onUploaded(saved);
    } catch (err) {
      status.className = 'fu-status err';
      status.textContent = err.message;
      toast(err.message, { type: 'error' });
    } finally {
      pickButton.disabled = false;
    }
  }

  const onPick = () => picker.click();
  const onChange = () => {
    const [file] = picker.files || [];
    picker.value = '';
    send(file);
  };
  const onClear = () => {
    setValue('');
    status.hidden = true;
  };
  const onInput = () => renderPreview();

  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onDragOver = (event) => {
    stop(event);
    wrap.classList.add('is-drag');
  };
  const onDragLeave = (event) => {
    stop(event);
    wrap.classList.remove('is-drag');
  };
  const onDrop = (event) => {
    stop(event);
    wrap.classList.remove('is-drag');
    const [file] = event.dataTransfer?.files || [];
    send(file);
  };
  // colar um print direto da área de transferência
  const onPaste = (event) => {
    const item = [...(event.clipboardData?.items || [])].find((entry) => entry.kind === 'file');
    if (!item) return;
    event.preventDefault();
    send(item.getAsFile());
  };

  pickButton.addEventListener('click', onPick);
  picker.addEventListener('change', onChange);
  clearButton.addEventListener('click', onClear);
  input.addEventListener('input', onInput);
  input.addEventListener('paste', onPaste);
  wrap.addEventListener('dragover', onDragOver);
  wrap.addEventListener('dragleave', onDragLeave);
  wrap.addEventListener('drop', onDrop);

  renderPreview();

  return {
    setValue,
    destroy() {
      pickButton.removeEventListener('click', onPick);
      picker.removeEventListener('change', onChange);
      clearButton.removeEventListener('click', onClear);
      input.removeEventListener('input', onInput);
      input.removeEventListener('paste', onPaste);
      wrap.removeEventListener('dragover', onDragOver);
      wrap.removeEventListener('dragleave', onDragLeave);
      wrap.removeEventListener('drop', onDrop);
      delete input.dataset.fileUpload;
    },
  };
}

/**
 * Acopla o envio a todos os campos marcados com data-upload dentro de um trecho.
 *
 *   <input name="logo_url" data-upload="logos" data-upload-accept="image">
 *
 * @returns {{ destroy(): void }}
 */
export function attachUploadsIn(root) {
  const handles = [];
  for (const input of root.querySelectorAll('[data-upload]')) {
    handles.push(
      attachFileUpload(input, {
        folder: input.dataset.upload || 'geral',
        accept: input.dataset.uploadAccept || 'image',
        preview: input.dataset.uploadPreview !== 'off',
      })
    );
  }
  return {
    destroy() {
      for (const handle of handles) handle.destroy();
    },
  };
}
