'use strict';

/**
 * Limitadores de requisições.
 *   authLimiter: login/cadastro/recuperação — 10 por 15 min por IP
 *   aiLimiter:   tutor/redação — 30 por minuto por usuário (fallback: IP)
 *   apiLimiter:  API geral — 600 por 15 min por IP
 * Em NODE_ENV=test os limites de autenticação e IA são desativados para não interferir nos testes.
 */
const { rateLimit } = require('express-rate-limit');
const config = require('../config');

const MINUTE = 60 * 1000;

function handler(req, res, next, options) {
  const retryAfter = res.getHeader('Retry-After');
  res.status(options.statusCode).json({
    error: {
      code: 'rate_limited',
      message: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.',
      details: retryAfter ? { retry_after_sec: Number(retryAfter) } : undefined,
    },
  });
}

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
};

const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * MINUTE,
  limit: 10,
  skipSuccessfulRequests: true,
  skip: () => config.isTest,
});

const aiLimiter = rateLimit({
  ...base,
  windowMs: MINUTE,
  limit: 30,
  keyGenerator: (req) => (req.user && req.user.id) || (req.admin && req.admin.id) || req.ip,
  skip: () => config.isTest,
});

const apiLimiter = rateLimit({
  ...base,
  windowMs: 15 * MINUTE,
  limit: config.isTest ? 100_000 : 600,
  // As partes de um envio grande não contam: uma videoaula de 1 GB são 128
  // requisições, e um lote estouraria o limite no meio. A rota continua
  // exigindo sessão de admin.
  skip: (req) => req.path === '/health' || (req.method === 'PUT' && /^\/admin\/uploads\/sessions\/[^/]+\/parts\/\d+$/.test(req.path)),
});

module.exports = { authLimiter, aiLimiter, apiLimiter };
