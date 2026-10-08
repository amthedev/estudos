'use strict';

/**
 * Rastreio de vendas na Utmify.
 *
 *   const utmify = require('./tracking/utmify');
 *   utmify.isConfigured();                 // UTMIFY_API_TOKEN presente?
 *   await utmify.sendOrder(pedido);        // manda a venda; nunca lança
 *   utmify.status();                       // { configured, enabled, token_last4 } para o painel
 *
 * A Utmify liga cada venda ao anúncio de origem (as UTMs capturadas na landing
 * e carregadas até o pagamento). O criativo que vende aparece lá.
 *
 * API (docs.utmify.com.br/send-orders):
 *   POST https://api.utmify.com.br/api-credentials/orders
 *   header x-api-token: <token da conta>
 *   corpo: orderId, platform, paymentMethod, status, createdAt (UTC),
 *          approvedDate, customer, products[], trackingParameters, commission.
 *   Valores em centavos; datas em "YYYY-MM-DD HH:MM:SS" UTC.
 *
 * Princípio: o envio NUNCA derruba o pagamento. Quem chama trata isto como
 * recado de ida; erro de rede, token recusado ou Utmify fora do ar são
 * registrados no log e a venda do aluno segue inalterada. Por isso sendOrder
 * resolve sempre, com { ok, skipped?, error? }, e nunca rejeita.
 */
const config = require('../../config');
const { getSetting } = require('../settings');

const API_URL = 'https://api.utmify.com.br/api-credentials/orders';
const REQUEST_TIMEOUT_MS = 10_000;

/** Formas de pagamento da Utmify. O que não casa vira 'pix' (cobrança avulsa). */
const PAYMENT_METHODS = { pix: 'pix', credit_card: 'credit_card', boleto: 'boleto' };
/** Status da Utmify que usamos. */
const STATUS = new Set(['waiting_payment', 'paid', 'refused', 'refunded', 'chargedback']);

function token() {
  return String(config.utmify.apiToken || '').trim();
}

/** O token está no servidor? Sem ele, nada é enviado. */
function isConfigured() {
  return Boolean(token());
}

/** O envio está ligado no painel? (setting utmify_enabled). */
async function isEnabled() {
  return (await getSetting('utmify_enabled')) === true;
}

/** Situação para o painel, sem expor o token. */
async function status() {
  const value = token();
  return {
    configured: Boolean(value),
    enabled: await isEnabled(),
    token_last4: value ? value.slice(-4) : null,
  };
}

/** Data no formato que a Utmify espera: "YYYY-MM-DD HH:MM:SS" em UTC. */
function utcDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Só os parâmetros de rastreio que a Utmify conhece; o resto é ignorado. */
function trackingParameters(tracking = {}) {
  const t = tracking && typeof tracking === 'object' ? tracking : {};
  const pick = (k) => {
    const v = t[k];
    return v === undefined || v === null || v === '' ? null : String(v).slice(0, 500);
  };
  return {
    src: pick('src'),
    sck: pick('sck'),
    utm_source: pick('utm_source'),
    utm_campaign: pick('utm_campaign'),
    utm_medium: pick('utm_medium'),
    utm_content: pick('utm_content'),
    utm_term: pick('utm_term'),
  };
}

/**
 * Monta o corpo da ordem. Separado do envio para o teste conferir o formato
 * sem rede.
 *
 * @param {{
 *   orderId: string, status: string, paymentMethod?: string,
 *   createdAt?: Date|string, approvedDate?: Date|string|null,
 *   customer: { name?, email?, phone?, document?, ip?, country? },
 *   product: { id, name, planId?, planName?, priceInCents },
 *   tracking?: object, gatewayFeeInCents?: number, isTest?: boolean
 * }} pedido
 */
function buildOrder(pedido) {
  const price = Math.max(0, Math.round(Number(pedido.product.priceInCents) || 0));
  const gatewayFee = Math.max(0, Math.round(Number(pedido.gatewayFeeInCents) || 0));
  const status = STATUS.has(pedido.status) ? pedido.status : 'waiting_payment';
  const createdAt = utcDateTime(pedido.createdAt || new Date());
  // "paid" sem data de aprovação não liga a venda ao anúncio na Utmify.
  const approvedDate = status === 'paid' ? utcDateTime(pedido.approvedDate || new Date()) : utcDateTime(pedido.approvedDate) || null;

  return {
    orderId: String(pedido.orderId),
    platform: config.brandName || 'Foco Elite',
    paymentMethod: PAYMENT_METHODS[pedido.paymentMethod] || 'pix',
    status,
    createdAt,
    approvedDate,
    refundedAt: null,
    customer: {
      name: pedido.customer.name || null,
      email: pedido.customer.email || null,
      phone: pedido.customer.phone || null,
      document: pedido.customer.document || null,
      country: pedido.customer.country || 'BR',
      ip: pedido.customer.ip || null,
    },
    products: [
      {
        id: String(pedido.product.id),
        name: pedido.product.name,
        planId: pedido.product.planId || null,
        planName: pedido.product.planName || null,
        quantity: 1,
        priceInCents: price,
      },
    ],
    trackingParameters: trackingParameters(pedido.tracking),
    commission: {
      totalPriceInCents: price,
      gatewayFeeInCents: gatewayFee,
      userCommissionInCents: Math.max(0, price - gatewayFee),
      currency: 'BRL',
    },
    isTest: Boolean(pedido.isTest),
  };
}

function httpClient() {
  return typeof fetch === 'function' ? fetch : null;
}

/**
 * Envia uma venda para a Utmify. NUNCA lança: devolve { ok } no sucesso,
 * { skipped } quando não há o que fazer, { error } quando a Utmify recusou ou
 * não respondeu. Quem chama só registra o desfecho.
 */
async function sendOrder(pedido) {
  if (!isConfigured()) return { skipped: 'token da Utmify ausente' };
  if (!(await isEnabled())) return { skipped: 'integração desligada' };
  if (!pedido || !pedido.orderId || !pedido.customer || !pedido.product) {
    return { skipped: 'pedido incompleto' };
  }

  const fetchImpl = httpClient();
  if (!fetchImpl) return { error: 'sem cliente HTTP para falar com a Utmify' };

  let body;
  try {
    body = buildOrder(pedido);
  } catch (err) {
    return { error: `pedido inválido: ${err.message}` };
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'x-api-token': token(),
        'content-type': 'application/json',
        accept: 'application/json',
        'User-Agent': `${config.brandName}/${config.version}`,
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    if (!res.ok) {
      const texto = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      return { error: `Utmify respondeu ${res.status}${texto ? `: ${texto.slice(0, 200)}` : ''}` };
    }
    return { ok: true, status: body.status, orderId: body.orderId };
  } catch (err) {
    const motivo = err && err.name === 'AbortError' ? 'tempo esgotado' : err && err.message;
    return { error: `não foi possível falar com a Utmify: ${motivo}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { isConfigured, isEnabled, status, buildOrder, sendOrder, utcDateTime, trackingParameters, API_URL };
