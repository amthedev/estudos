'use strict';

/**
 * Identificação de vídeos a partir da URL informada pelo admin.
 *
 *   parseVideoUrl('https://youtu.be/dQw4w9WgXcQ')
 *   → { provider: 'youtube', video_id: 'dQw4w9WgXcQ',
 *       embed_url: 'https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0',
 *       thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', url }
 *
 * provider: 'youtube' | 'vimeo' | 'external' (qualquer outra URL http/https) | 'none' (vazio/inválido)
 */

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be', 'www.youtu.be',
]);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const NONE = Object.freeze({ provider: 'none', video_id: null, embed_url: null, thumbnail_url: null, url: null });

function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // exige um host plausível (com ponto) ou localhost; evita tratar "texto solto" como URL
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url;
  } catch {
    return null;
  }
}

/** Converte "1m30s", "90" ou "90s" em segundos (parâmetros t/start do YouTube). */
function parseStartSeconds(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function parseYouTube(url) {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  let id = null;

  if (host.endsWith('youtu.be')) {
    id = segments[0] || null;
  } else if (segments[0] === 'watch') {
    id = url.searchParams.get('v');
  } else if (['embed', 'shorts', 'live', 'v', 'e'].includes(segments[0])) {
    id = segments[1] || null;
  } else if (segments.length === 0 && url.searchParams.get('v')) {
    id = url.searchParams.get('v');
  }

  if (!id || !YOUTUBE_ID_RE.test(id)) return null;

  const start = parseStartSeconds(url.searchParams.get('start') || url.searchParams.get('t'));
  const embed = new URL(`https://www.youtube.com/embed/${id}`);
  embed.searchParams.set('rel', '0');
  if (start) embed.searchParams.set('start', String(start));

  return {
    provider: 'youtube',
    video_id: id,
    embed_url: embed.toString(),
    thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    url: url.toString(),
  };
}

function parseVimeo(url) {
  const segments = url.pathname.split('/').filter(Boolean);
  let id = null;
  let hash = url.searchParams.get('h');

  // vimeo.com/123, vimeo.com/123/abcdef, player.vimeo.com/video/123, vimeo.com/channels/x/123,
  // vimeo.com/groups/x/videos/123, vimeo.com/manage/videos/123
  for (let i = 0; i < segments.length; i += 1) {
    if (/^\d{5,}$/.test(segments[i])) {
      id = segments[i];
      const next = segments[i + 1];
      if (!hash && next && /^[a-f0-9]{6,16}$/i.test(next)) hash = next;
      break;
    }
  }
  if (!id) return null;

  const embed = new URL(`https://player.vimeo.com/video/${id}`);
  if (hash) embed.searchParams.set('h', hash);

  return {
    provider: 'vimeo',
    video_id: id,
    embed_url: embed.toString(),
    thumbnail_url: null, // exige consulta ao oEmbed do Vimeo (feita na rota admin, quando disponível)
    url: url.toString(),
  };
}

/**
 * @param {string} input URL informada
 * @returns {{ provider: 'youtube'|'vimeo'|'external'|'none', video_id: string|null, embed_url: string|null, thumbnail_url: string|null, url: string|null }}
 */
function parseVideoUrl(input) {
  const url = normalizeUrl(input);
  if (!url) return { ...NONE };

  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) {
    const result = parseYouTube(url);
    if (result) return result;
  }
  if (VIMEO_HOSTS.has(host)) {
    const result = parseVimeo(url);
    if (result) return result;
  }

  return {
    provider: 'external',
    video_id: null,
    embed_url: url.toString(),
    thumbnail_url: null,
    url: url.toString(),
  };
}

/** Verdadeiro quando a URL aponta para um arquivo de vídeo reproduzível em <video>. */
function isDirectVideoFile(input) {
  const url = normalizeUrl(input);
  return Boolean(url && /\.(mp4|webm|ogv|m3u8|mov)$/i.test(url.pathname));
}

const PROVIDER_LABELS = { youtube: 'YouTube', vimeo: 'Vimeo', external: 'Link externo', none: 'Sem vídeo' };

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || PROVIDER_LABELS.none;
}

module.exports = { parseVideoUrl, isDirectVideoFile, providerLabel, parseStartSeconds };
