'use strict';

/**
 * Camada de armazenamento de arquivos.
 *
 * A plataforma não decide onde o arquivo mora: pergunta aqui. Em produção o
 * provedor é o Blob Storage da Square Cloud; em desenvolvimento, ou em uma
 * máquina própria, o disco do servidor resolve. Quem chama recebe sempre a
 * mesma coisa de volta: a URL pública e a chave para apagar depois.
 *
 * Escolha do provedor: configuração `storage_provider` → variável de ambiente
 * STORAGE_PROVIDER → detecção pela chave da Square Cloud → disco.
 */
const local = require('./local');
const squarecloud = require('./squarecloud');
const { getSetting } = require('../settings');

const DRIVERS = { local, squarecloud };
const NAMES = Object.keys(DRIVERS);

function normalize(value) {
  const name = String(value || '').trim().toLowerCase();
  return NAMES.includes(name) ? name : null;
}

/** Nome do provedor ativo. */
async function providerName() {
  const chosen = normalize(await getSetting('storage_provider', '')) || normalize(process.env.STORAGE_PROVIDER);
  if (chosen) return chosen;
  return squarecloud.isConfigured() ? 'squarecloud' : 'local';
}

/** Provedor ativo, já verificado. */
async function driver() {
  const name = await providerName();
  const chosen = DRIVERS[name] || local;
  if (!chosen.isConfigured()) {
    const error = new Error(
      'O armazenamento de arquivos não está configurado. Informe a chave da Square Cloud no servidor.'
    );
    error.code = 'storage_not_configured';
    throw error;
  }
  return chosen;
}

/** Grava lendo em fluxo. Ver os drivers para o contorno de cada provedor. */
async function putStream(source, options) {
  const chosen = await driver();
  const saved = await chosen.putStream(source, options);
  return { ...saved, provider: chosen.name };
}

/** Apaga pelo identificador devolvido na gravação. */
async function remove(key) {
  // caminho interno sempre pertence ao disco, mesmo com o Blob ativo:
  // é o que permite limpar o que ficou de uma configuração anterior
  if (String(key || '').startsWith('/uploads/')) return local.remove(key);
  const chosen = await driver();
  return chosen.remove(key);
}

/** Lista o que está guardado. */
async function list(options) {
  const chosen = await driver();
  return chosen.list(options);
}

/** Consumo da conta, quando o provedor souber informar. */
async function usage() {
  const name = await providerName();
  const chosen = DRIVERS[name] || local;
  if (typeof chosen.stats !== 'function' || !chosen.isConfigured()) return null;
  try {
    return await chosen.stats();
  } catch {
    // o consumo é informativo: falhar aqui não pode derrubar a tela
    return null;
  }
}

/** Situação para o painel, sem expor a chave. */
async function status() {
  const name = await providerName();
  const chosen = DRIVERS[name] || local;
  const key = String(process.env.SQUARECLOUD_API_KEY || '').trim();
  return {
    provider: chosen.name,
    label: chosen.label,
    configured: chosen.isConfigured(),
    key_masked: key ? `••••${key.slice(-4)}` : null,
    usage: await usage(),
    max_bytes: chosen.name === 'squarecloud' ? squarecloud.MAX_OBJECT : null,
  };
}

module.exports = { putStream, remove, list, status, usage, providerName, DRIVERS, NAMES };
