'use strict';

/**
 * GET /api/health → { ok, version, db: 'ok'|'error', uptime }
 * Usado por monitoramento e pelo painel (plataforma). Responde 503 quando o banco não responde.
 */
const router = require('express').Router();
const config = require('../config');
const db = require('../db/pool');
const { wrap } = require('../middleware/errors');

router.get(
  '/',
  wrap(async (req, res) => {
    let dbStatus = 'ok';
    try {
      await db.query('SELECT 1');
    } catch {
      dbStatus = 'error';
    }
    const ok = dbStatus === 'ok';
    res.status(ok ? 200 : 503).json({
      ok,
      version: config.version,
      db: dbStatus,
      uptime: Math.round(process.uptime()),
      env: config.env,
      time: new Date().toISOString(),
    });
  })
);

module.exports = { basePath: '/api/health', router };
