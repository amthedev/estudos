'use strict';

/**
 * Tokens aleatórios e hashes (recuperação de senha, códigos de uso único).
 * O token em claro vai para o usuário; no banco fica apenas o hash sha256.
 */
const crypto = require('node:crypto');

/** Token aleatório em hexadecimal (padrão: 32 bytes → 64 caracteres). */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** sha256 em hexadecimal. */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Token de redefinição de senha.
 * @param {number} [ttlMinutes=60]
 * @returns {{ token: string, hash: string, expiresAt: Date }}
 */
function generateResetToken(ttlMinutes = 60) {
  const token = randomToken(32);
  return { token, hash: sha256(token), expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000) };
}

/** Comparação em tempo constante entre duas strings. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Código numérico aleatório (ex.: 6 dígitos). */
function randomCode(length = 6) {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}

module.exports = { randomToken, sha256, generateResetToken, safeEqual, randomCode };
