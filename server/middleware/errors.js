'use strict';

/**
 * Erros padronizados da API.
 *
 * Formato de resposta: { error: { code, message, details? } }
 * Códigos: validation_error (400), unauthorized (401), payment_required (402), forbidden (403),
 *          not_found (404), conflict (409), rate_limited (429), internal (500), ai_unavailable (503).
 */
const config = require('../config');

class AppError extends Error {
  /**
   * @param {number} status  código HTTP
   * @param {string} code    código curto (ver lista acima)
   * @param {string} message mensagem em português, voltada ao usuário
   * @param {*} [details]    detalhes opcionais (ex.: lista de campos inválidos)
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }

  toJSON() {
    const error = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

/** Envolve handlers async para que rejeições cheguem ao errorHandler. */
const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** 404 para rotas de API não encontradas. */
function notFound(req, res, next) {
  next(new AppError(404, 'not_found', 'Rota não encontrada.'));
}

// Códigos de erro do PostgreSQL traduzidos em respostas úteis
const PG_ERRORS = {
  23505: [409, 'conflict', 'Já existe um registro com esses dados.'],
  23503: [409, 'conflict', 'Operação inválida: o registro está vinculado a outros dados.'],
  23502: [400, 'validation_error', 'Campo obrigatório ausente.'],
  23514: [400, 'validation_error', 'Valor inválido para um dos campos.'],
  '22P02': [400, 'validation_error', 'Identificador ou valor em formato inválido.'],
  22001: [400, 'validation_error', 'Texto excede o tamanho permitido.'],
  22003: [400, 'validation_error', 'Valor numérico fora do intervalo permitido.'],
  22007: [400, 'validation_error', 'Data em formato inválido.'],
  22008: [400, 'validation_error', 'Data em formato inválido.'],
};

/** Converte qualquer erro em { status, code, message, details, log }. */
function normalizeError(err) {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details, log: err.status >= 500 };
  }
  if (err && err.name === 'ZodError' && Array.isArray(err.issues)) {
    return {
      status: 400,
      code: 'validation_error',
      message: 'Dados inválidos.',
      details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      log: false,
    };
  }
  // body-parser
  if (err && err.type === 'entity.parse.failed') {
    return { status: 400, code: 'validation_error', message: 'Corpo da requisição não é um JSON válido.', log: false };
  }
  if (err && err.type === 'entity.too.large') {
    return { status: 413, code: 'validation_error', message: 'Conteúdo enviado é grande demais.', log: false };
  }
  if (err && err.type === 'encoding.unsupported') {
    return { status: 415, code: 'validation_error', message: 'Codificação não suportada.', log: false };
  }
  // PostgreSQL
  if (err && typeof err.code === 'string' && PG_ERRORS[err.code]) {
    const [status, code, message] = PG_ERRORS[err.code];
    return { status, code, message, log: false };
  }
  // http-errors (ex.: sendFile com ENOENT vira 404)
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 && err.expose) {
    return { status: err.status, code: err.status === 404 ? 'not_found' : 'validation_error', message: err.message, log: false };
  }
  if (err && err.code === 'ENOENT') {
    return { status: 404, code: 'not_found', message: 'Recurso não encontrado.', log: false };
  }
  return { status: 500, code: 'internal', message: 'Erro interno. Tente novamente em instantes.', log: true };
}

/**
 * Grava uma falha que não veio de uma requisição — queda do processo, por
 * exemplo. Sem isto, o motivo de um reinício só existe no console da
 * hospedagem, que nem sempre se alcança; e "a aplicação reiniciou e ninguém
 * sabe por quê" custou horas de investigação às cegas.
 */
async function persistProcessError(err, origem, level = 'fatal') {
  try {
    const db = require('../db/pool');
    await db.query(
      `INSERT INTO error_logs (level, message, stack, path, method)
       VALUES ($1, $2, $3, $4, 'PROCESSO')`,
      [
        level,
        `[${origem}] ${String(err && err.message ? err.message : err)}`.slice(0, 4000),
        err && err.stack ? String(err.stack).slice(0, 12000) : null,
        String(origem).slice(0, 1000),
      ]
    );
  } catch (dbErr) {
    console.error('[errors] não foi possível gravar a queda em error_logs:', dbErr.message);
  }
}

async function persistError(err, req) {
  try {
    // require tardio para não criar dependência circular na inicialização
    const db = require('../db/pool');
    await db.query(
      `INSERT INTO error_logs (level, message, stack, path, method, user_id)
       VALUES ('error', $1, $2, $3, $4, $5)`,
      [
        String(err && err.message ? err.message : err).slice(0, 4000),
        err && err.stack ? String(err.stack).slice(0, 12000) : null,
        req.originalUrl ? String(req.originalUrl).slice(0, 1000) : null,
        req.method || null,
        (req.user && req.user.id) || (req.admin && req.admin.id) || null,
      ]
    );
  } catch (dbErr) {
    // o banco pode ser justamente a causa do erro; nunca derrubar o handler por isso
    console.error('[errors] não foi possível gravar em error_logs:', dbErr.message);
  }
}

function notFoundPage(res) {
  res
    .status(404)
    .type('html')
    .send(
      `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Página não encontrada</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07111F;color:#F5F7FA;font-family:Inter,system-ui,sans-serif}
main{text-align:center;padding:32px}h1{font-size:28px;margin:0 0 8px}p{color:#94A3B8;margin:0 0 24px}a{color:#4DA3FF;text-decoration:none}</style></head>
<body><main><h1>Página não encontrada</h1><p>O endereço acessado não existe ou foi movido.</p><a href="/">Voltar ao início</a></main></body></html>`
    );
}

/** Middleware final de erros (registrar por último no app). */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const normalized = normalizeError(err);

  if (normalized.log) {
    console.error(`[erro] ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
    // não aguarda a gravação para responder
    persistError(err, req);
  }

  if (res.headersSent) {
    // resposta já iniciada (ex.: SSE): só encerra a conexão
    return res.end();
  }

  const isApi = req.originalUrl && req.originalUrl.startsWith('/api');
  if (!isApi && normalized.status === 404) return notFoundPage(res);

  const body = { error: { code: normalized.code, message: normalized.message } };
  if (normalized.details !== undefined) body.error.details = normalized.details;
  if (normalized.status >= 500 && !config.isProd && err && err.message) {
    // ajuda no desenvolvimento sem expor stack em produção
    body.error.details = { message: err.message };
  }
  res.status(normalized.status).json(body);
}

module.exports = { AppError, wrap, notFound, errorHandler, normalizeError, persistProcessError };
