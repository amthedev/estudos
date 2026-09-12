'use strict';

/**
 * Cliente da API do Resend (envio de e-mail transacional).
 *
 *   const resend = require('./resend');
 *   await resend.send({ from, to, subject, text, html });
 *
 * É uma única chamada HTTP — POST https://api.resend.com/emails com a chave no
 * cabeçalho Authorization. Não há SDK: a dependência não se paga por um
 * endpoint só, e um `fetch` deixa o erro do provedor visível, que é o que
 * interessa quando o envio falha.
 *
 * O Resend exige domínio verificado no painel dele: o endereço do `from`
 * precisa ser de um domínio que você comprovou ser seu. Sem isso ele recusa a
 * mensagem, e é o erro mais comum de quem está configurando pela primeira vez.
 */
const config = require('../config');

const API_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15_000;

// Injetáveis nos testes: o cliente HTTP, para não depender de rede, e a
// chave, porque o objeto de configuração é congelado e não aceita sobrescrita.
let httpClient = null;
let apiKeyDeTeste = null;

/** Substitui o cliente HTTP (só usado nos testes). Passe null para restaurar. */
function setHttpClient(client) {
  httpClient = client;
}

/** Substitui a chave (só usado nos testes). Passe null para restaurar. */
function setApiKeyForTests(key) {
  apiKeyDeTeste = key;
}

function apiKey() {
  return apiKeyDeTeste || config.resend.apiKey;
}

function isConfigured() {
  return Boolean(apiKey());
}

/** Só os últimos caracteres da chave, para o painel mostrar sem expor o segredo. */
function status() {
  const key = apiKey();
  return {
    configured: isConfigured(),
    key_last4: key ? key.slice(-4) : null,
  };
}

/**
 * Envia um e-mail pela API do Resend.
 * @returns {Promise<{ id: string }>}
 * @throws {Error} com a mensagem que o próprio Resend devolveu
 */
async function send({ from, to, subject, text, html }) {
  if (!isConfigured()) throw new Error('RESEND_API_KEY não configurada.');

  const fetchImpl = httpClient || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
      }),
      signal: controller.signal,
    });

    const corpo = await response.text();
    let dados = null;
    try {
      dados = corpo ? JSON.parse(corpo) : null;
    } catch {
      // resposta que não é JSON: o texto cru vira a mensagem de erro
    }

    if (!response.ok) {
      // O Resend devolve { message } ou { error: { message } }. A mensagem
      // dele é a parte útil — costuma dizer exatamente o que falta, como
      // "The domain is not verified".
      const motivo =
        (dados && (dados.message || (dados.error && dados.error.message))) ||
        corpo.slice(0, 200) ||
        `HTTP ${response.status}`;
      throw new Error(motivo);
    }

    return { id: (dados && dados.id) || null };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('O Resend não respondeu a tempo.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confere se a chave é aceita, sem enviar mensagem.
 *
 * O Resend não tem endpoint de verificação, então a checagem possível é a
 * própria chamada de envio recusando por credencial — o que só aparece quando
 * se tenta enviar. Aqui só se confirma que a chave existe; o resto vem do
 * envio de teste.
 */
async function verify() {
  if (!isConfigured()) return { ok: false, error: 'RESEND_API_KEY não configurada.' };
  return { ok: true };
}

module.exports = { send, verify, status, isConfigured, setHttpClient, setApiKeyForTests, API_URL };
