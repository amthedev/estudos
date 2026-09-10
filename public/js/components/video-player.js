/**
 * Player de vídeo das aulas.
 *
 *   renderVideo(el, { video_url, video_provider, thumbnail_url, title })
 *
 *  - youtube  → iframe em youtube-nocookie.com (16:9, allowfullscreen), id derivado de qualquer formato de URL
 *  - vimeo    → iframe em player.vimeo.com
 *  - external → arquivo .mp4/.webm/.ogv vira <video controls>; outras URLs viram um card com a
 *               miniatura e o botão "Abrir vídeo" em nova aba
 *  - none     → placeholder sóbrio "Vídeo em breve" (com a miniatura, se houver)
 *
 * Quando `video_provider` não bate com a URL (ou está ausente), o provedor é detectado pela URL.
 * Devolve `{ provider, id, url }` com o que foi efetivamente renderizado.
 * Marcação com prefixo .vp- (estilos em pages/misc.css); o iframe/vídeo fica em .vp-frame (16:9).
 */
import { html, raw, render } from '../core/ui.js';
import { icon } from '../core/icons.js';

const h = html;
const ic = (name, size = 18) => icon(name, { size });

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;
const VIMEO_HOSTS = /(^|\.)vimeo\.com$/i;
const FILE_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
};

/** Faz o parse de uma URL de forma tolerante (aceita sem protocolo). Devolve null se inválida ou não http(s). */
function parseUrl(input) {
  const text = String(input ?? '').trim();
  if (!text || /\s/.test(text)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url;
  } catch {
    return null;
  }
}

/** Só aceita URLs http(s) para uso em src/href. */
function safeUrl(input) {
  const url = parseUrl(input);
  return url ? url.href : null;
}

/** Converte "1h2m3s", "90" ou "90s" (parâmetro t= do YouTube) em segundos. */
function parseStart(value) {
  if (!value) return 0;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
  if (match && (match[1] || match[2] || match[3])) {
    return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
  }
  return 0;
}

/**
 * Extrai o id de um vídeo do YouTube a partir de qualquer formato conhecido:
 * watch?v=ID, youtu.be/ID, shorts/ID, embed/ID, live/ID, v/ID, com ou sem protocolo, ou o próprio id.
 * Devolve `{ id, start }` ou null.
 */
export function youtubeInfo(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (YT_ID.test(text)) return { id: text, start: 0 };

  const url = parseUrl(text);
  if (!url || !YT_HOSTS.test(url.hostname)) return null;
  const start = parseStart(url.searchParams.get('t') || url.searchParams.get('start'));
  const segments = url.pathname.split('/').filter(Boolean);

  let id = null;
  if (/youtu\.be$/i.test(url.hostname)) {
    id = segments[0] || null;
  } else if (url.searchParams.get('v')) {
    id = url.searchParams.get('v');
  } else if (url.searchParams.get('vi')) {
    id = url.searchParams.get('vi');
  } else {
    // /embed/ID, /shorts/ID, /live/ID, /v/ID, /e/ID, /watch/ID e o formato antigo /attribution_link?u=/watch?v=ID
    const idx = segments.findIndex((s) => ['embed', 'shorts', 'live', 'v', 'e', 'watch', 'vi'].includes(s.toLowerCase()));
    if (idx >= 0) id = segments[idx + 1] || null;
    if (!id && url.searchParams.get('u')) {
      const nested = youtubeInfo(`https://www.youtube.com${url.searchParams.get('u')}`);
      if (nested) return nested;
    }
  }
  if (!id) return null;
  id = id.split(/[?&#]/)[0];
  return YT_ID.test(id) ? { id, start } : null;
}

/** Atalho: apenas o id do YouTube (ou null). */
export function youtubeId(input) {
  return youtubeInfo(input)?.id ?? null;
}

/**
 * Extrai id (e hash de vídeo não listado) do Vimeo:
 * vimeo.com/123, vimeo.com/channels/x/123, player.vimeo.com/video/123, vimeo.com/123/abcdef.
 */
export function vimeoInfo(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (/^\d{6,}$/.test(text)) return { id: text, hash: null };
  const url = parseUrl(text);
  if (!url || !VIMEO_HOSTS.test(url.hostname)) return null;
  const match = url.pathname.match(/\/(\d+)(?:\/([a-z0-9]+))?\/?$/i);
  if (!match) return null;
  const hash = match[2] || url.searchParams.get('h') || null;
  return { id: match[1], hash };
}

export function vimeoId(input) {
  return vimeoInfo(input)?.id ?? null;
}

/** Extensão do arquivo (sem query string), em minúsculas. */
function fileExtension(url) {
  const parsed = parseUrl(url);
  if (!parsed) return '';
  const match = parsed.pathname.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

/** Detecta o provedor pela URL: 'youtube' | 'vimeo' | 'external' | 'none'. */
export function detectProvider(url) {
  if (!url) return 'none';
  if (youtubeInfo(url)) return 'youtube';
  if (vimeoInfo(url)) return 'vimeo';
  return parseUrl(url) ? 'external' : 'none';
}

/** Resolve o provedor efetivo, corrigindo cadastros inconsistentes. */
export function resolveProvider(provider, url) {
  const declared = String(provider || '').toLowerCase();
  if (declared === 'none' || !url) return 'none';
  const detected = detectProvider(url);
  if (declared === 'youtube' && detected === 'youtube') return 'youtube';
  if (declared === 'vimeo' && detected === 'vimeo') return 'vimeo';
  return detected;
}

function thumbView(thumbnailUrl, title) {
  const src = safeUrl(thumbnailUrl);
  if (!src) return h`<div class="vp-thumb vp-thumb-empty" aria-hidden="true">${ic('film', 40)}</div>`;
  return h`<img class="vp-thumb" src="${src}" alt="${title ? `Miniatura: ${title}` : 'Miniatura do vídeo'}" loading="lazy">`;
}

/** URL de embed do YouTube (nocookie) ou do Vimeo para a URL informada; null se não for reconhecida. */
export function embedUrl(input) {
  const yt = youtubeInfo(input);
  if (yt) {
    const params = new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1' });
    if (yt.start > 0) params.set('start', String(yt.start));
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt.id)}?${params.toString()}`;
  }
  const vimeo = vimeoInfo(input);
  if (vimeo) {
    const params = new URLSearchParams({ dnt: '1', title: '0', byline: '0', portrait: '0' });
    if (vimeo.hash) params.set('h', vimeo.hash);
    return `https://player.vimeo.com/video/${encodeURIComponent(vimeo.id)}?${params.toString()}`;
  }
  return null;
}

export function renderVideo(el, video = {}) {
  if (!el) throw new Error('renderVideo: elemento de destino obrigatório');
  const title = String(video.title || '').trim();
  const url = String(video.video_url || '').trim();
  const provider = resolveProvider(video.video_provider, url);
  let id = null;
  let resolvedUrl = null;
  let markup;

  if (provider === 'youtube') {
    const info = youtubeInfo(url);
    id = info.id;
    resolvedUrl = embedUrl(url);
    markup = html`
      <div class="vp vp-youtube">
        <div class="vp-frame">
          <iframe class="vp-iframe" src="${resolvedUrl}" title="${title || 'Vídeo da aula'}"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            referrerpolicy="strict-origin-when-cross-origin" loading="lazy"></iframe>
        </div>
      </div>`;
  } else if (provider === 'vimeo') {
    const info = vimeoInfo(url);
    id = info.id;
    resolvedUrl = embedUrl(url);
    markup = html`
      <div class="vp vp-vimeo">
        <div class="vp-frame">
          <iframe class="vp-iframe" src="${resolvedUrl}" title="${title || 'Vídeo da aula'}"
            allow="autoplay; fullscreen; picture-in-picture" loading="lazy"></iframe>
        </div>
      </div>`;
  } else if (provider === 'external') {
    const src = safeUrl(url);
    resolvedUrl = src;
    const mime = FILE_TYPES[fileExtension(src)];
    if (mime) {
      const poster = safeUrl(video.thumbnail_url);
      markup = html`
        <div class="vp vp-file">
          <div class="vp-frame">
            <video class="vp-video" controls preload="metadata" playsinline
              ${poster ? h`poster="${poster}"` : ''} ${title ? h`aria-label="${title}"` : ''}>
              <source src="${src}" type="${mime}">
              Seu navegador não conseguiu reproduzir este vídeo.
              <a href="${src}" target="_blank" rel="noopener noreferrer">Abrir vídeo em nova aba</a>.
            </video>
          </div>
        </div>`;
    } else {
      markup = html`
        <div class="vp vp-external">
          <div class="vp-frame vp-poster">
            ${thumbView(video.thumbnail_url, title)}
            <div class="vp-overlay">
              <span class="vp-overlay-icon" aria-hidden="true">${ic('video', 32)}</span>
              ${title ? h`<p class="vp-overlay-title">${title}</p>` : ''}
              <p class="vp-overlay-hint">Este vídeo é reproduzido em outra página.</p>
              <a class="btn btn-primary" href="${src}" target="_blank" rel="noopener noreferrer">
                ${ic('external-link', 18)} Abrir vídeo
              </a>
            </div>
          </div>
        </div>`;
    }
  } else {
    markup = html`
      <div class="vp vp-none">
        <div class="vp-frame vp-poster vp-placeholder">
          ${thumbView(video.thumbnail_url, title)}
          <div class="vp-overlay">
            <span class="vp-overlay-icon" aria-hidden="true">${ic('film', 32)}</span>
            <p class="vp-overlay-title">Vídeo em breve</p>
            <p class="vp-overlay-hint">O vídeo desta aula ainda está sendo produzido. Enquanto isso, aproveite o resumo e as questões.</p>
          </div>
        </div>
      </div>`;
  }

  render(el, markup);
  return { provider, id, url: resolvedUrl };
}

export default renderVideo;
