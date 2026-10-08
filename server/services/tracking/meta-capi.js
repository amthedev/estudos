'use strict';

/**
 * Conversions API do Meta (Pixel do Facebook/Instagram), lado servidor.
 *
 *   const meta = require('./tracking/meta-capi');
 *   meta.isConfigured();                       // PIXEL_ID + token da CAPI presentes?
 *   await meta.sendPurchase(venda);            // manda a compra; nunca lança
 *   await meta.status();                       // para o painel
 *
 * Por que no servidor, e não só no navegador: a maioria das vendas é por Pix,
 * pago no app do banco, FORA do site — o aluno não volta para uma tela de
 * sucesso, então o Pixel do navegador não veria a compra. A Conversions API
 * manda o evento "Purchase" direto do servidor quando o Asaas confirma, do
 * mesmo ponto que avisa a Utmify. O Pixel do navegador cuida dos eventos que
 * acontecem na tela (Lead, cadastro, clique no WhatsApp).
 *
 * Deduplicação: o evento de compra leva um event_id estável (a assinatura).
 * Se algum dia a compra também disparar no navegador, o Meta junta os dois
 * pelo mesmo event_id em vez de contar duas.
 *
 * Privacidade: o Meta EXIGE que e-mail e telefone cheguem com hash SHA-256
 * (nunca em texto puro). É o que normalizeAndHash faz.
 *
 * API: POST https://graph.facebook.com/v21.0/<PIXEL_ID>/events?access_token=…
 * Princípio, como na Utmify: nunca propaga erro — a compra do aluno já foi
 * creditada antes daqui.
 */
const crypto = require('node:crypto');
const config = require('../../config');
const { getSetting } = require('../settings');

const GRAPH_VERSION = 'v21.0';
const REQUEST_TIMEOUT_MS = 10_000;

function capiToken() {
  return String(config.meta.capiToken || '').trim();
}

/** O Pixel ID vem do painel (público) e cai para o ambiente quando vazio. */
async function pixelId() {
  const doPainel = String((await getSetting('meta_pixel_id')) || '').trim();
  return doPainel || String(config.meta.pixelId || '').trim();
}

/** Precisa do Pixel ID e do token da CAPI para o envio pelo servidor. */
async function isConfigured() {
  // Sem token nada é enviado — e isto é síncrono (do ambiente), então evita ir
  // ao banco buscar o Pixel ID à toa quando a CAPI nem está configurada.
  if (!capiToken()) return false;
  return Boolean(await pixelId());
}

/** O rastreio está ligado no painel? (setting meta_pixel_enabled). */
async function isEnabled() {
  return (await getSetting('meta_pixel_enabled')) === true;
}

/** Situação para o painel, sem expor o token da CAPI. */
async function status() {
  const token = capiToken();
  const painel = String((await getSetting('meta_pixel_id')) || '').trim();
  const id = painel || String(config.meta.pixelId || '').trim();
  return {
    pixel_id: id || null,
    pixel_id_source: painel ? 'painel' : id ? 'ambiente' : null,
    capi_configured: Boolean(token),
    capi_token_last4: token ? token.slice(-4) : null,
    enabled: await isEnabled(),
  };
}

/** Normaliza (minúsculas, sem espaços) e aplica SHA-256, como o Meta pede. */
function normalizeAndHash(value, { phone = false } = {}) {
  let v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  // Telefone: só dígitos (o Meta espera E.164 sem símbolos).
  if (phone) v = v.replace(/[^0-9]/g, '');
  if (!v) return null;
  return crypto.createHash('sha256').update(v).digest('hex');
}

/** Só os parâmetros de clique do anúncio que o Meta usa (fbc/fbp). */
function clickIds(tracking = {}) {
  const t = tracking && typeof tracking === 'object' ? tracking : {};
  const out = {};
  if (t.fbc) out.fbc = String(t.fbc).slice(0, 255);
  if (t.fbp) out.fbp = String(t.fbp).slice(0, 255);
  return out;
}

/**
 * Monta o corpo do evento Purchase. Separado para o teste conferir o formato
 * sem rede (e sem precisar do token).
 *
 * @param {{
 *   eventId: string, value: number (centavos), currency?: string,
 *   email?: string, phone?: string, clientIp?: string, userAgent?: string,
 *   tracking?: object, eventTime?: number (epoch s), eventSourceUrl?: string
 * }} venda
 */
function buildPurchase(venda) {
  const userData = {};
  const email = normalizeAndHash(venda.email);
  const phone = normalizeAndHash(venda.phone, { phone: true });
  if (email) userData.em = [email];
  if (phone) userData.ph = [phone];
  if (venda.clientIp) userData.client_ip_address = venda.clientIp;
  if (venda.userAgent) userData.client_user_agent = venda.userAgent;
  Object.assign(userData, clickIds(venda.tracking));

  return {
    data: [
      {
        event_name: 'Purchase',
        event_time: Number(venda.eventTime) || Math.floor(Date.now() / 1000),
        event_id: String(venda.eventId),
        action_source: 'website',
        event_source_url: venda.eventSourceUrl || undefined,
        user_data: userData,
        custom_data: {
          currency: venda.currency || 'BRL',
          value: Number(((Math.max(0, Number(venda.value) || 0)) / 100).toFixed(2)),
        },
      },
    ],
  };
}

function httpClient() {
  return typeof fetch === 'function' ? fetch : null;
}

/**
 * Manda o evento Purchase ao Meta pela Conversions API. NUNCA lança: devolve
 * { ok } no sucesso, { skipped } quando não há o que fazer, { error } quando o
 * Meta recusou ou não respondeu.
 */
async function sendPurchase(venda) {
  if (!(await isConfigured())) return { skipped: 'pixel/token do Meta ausente' };
  if (!(await isEnabled())) return { skipped: 'rastreio desligado' };
  if (!venda || !venda.eventId) return { skipped: 'evento incompleto' };

  const fetchImpl = httpClient();
  if (!fetchImpl) return { error: 'sem cliente HTTP para falar com o Meta' };

  const id = await pixelId();
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(id)}/events?access_token=${encodeURIComponent(capiToken())}`;

  let body;
  try {
    body = buildPurchase(venda);
  } catch (err) {
    return { error: `evento inválido: ${err.message}` };
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    if (!res.ok) {
      const texto = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      return { error: `Meta respondeu ${res.status}${texto ? `: ${texto.slice(0, 200)}` : ''}` };
    }
    return { ok: true, eventId: body.data[0].event_id };
  } catch (err) {
    const motivo = err && err.name === 'AbortError' ? 'tempo esgotado' : err && err.message;
    return { error: `não foi possível falar com o Meta: ${motivo}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  isConfigured,
  isEnabled,
  status,
  pixelId,
  buildPurchase,
  sendPurchase,
  normalizeAndHash,
  GRAPH_VERSION,
};
