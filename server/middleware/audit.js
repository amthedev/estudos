'use strict';

/**
 * Auditoria de ações administrativas.
 *
 *   await audit(req, 'lesson.update', 'lesson', lesson.id, { diff });
 *
 * Nunca lança: uma falha na gravação é registrada no console e ignorada,
 * para que a ação principal não seja revertida por causa do log.
 */
const db = require('../db/pool');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ note: 'dados não serializáveis' });
  }
}

/**
 * @param {import('express').Request} req   requisição (usa req.admin ou req.user e o IP)
 * @param {string} action                   ex.: 'lesson.create', 'student.block'
 * @param {string} [entity]                 ex.: 'lesson'
 * @param {string} [entityId]               uuid da entidade (se não for uuid, vai para data.entity_ref)
 * @param {object} [data]                   dados extras (diff, payload resumido)
 */
async function audit(req, action, entity = null, entityId = null, data = null) {
  const adminId = (req && req.admin && req.admin.id) || (req && req.user && req.user.id) || null;
  const ip = req ? req.ip || null : null;

  let validEntityId = null;
  let payload = data;
  if (entityId !== null && entityId !== undefined) {
    if (UUID_RE.test(String(entityId))) validEntityId = String(entityId);
    else payload = { ...(data || {}), entity_ref: String(entityId) };
  }

  try {
    await db.query(
      `INSERT INTO audit_logs (admin_id, action, entity, entity_id, data, ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [adminId, action, entity, validEntityId, safeJson(payload), ip]
    );
  } catch (err) {
    console.error(`[audit] falha ao registrar "${action}":`, err.message);
  }
}

module.exports = { audit };
