'use strict';

/**
 * Preparação da aplicação antes de subir, em hospedagem sem terminal.
 *
 *   node scripts/bootstrap.js
 *
 * É o que o comando de início executa na Square Cloud. Faz, nesta ordem:
 *
 *   1. aplica as migrations pendentes;
 *   2. garante o conteúdo base (provas, matérias, assuntos, critérios de
 *      redação, planos de estudo, textos da página inicial);
 *   3. cria o administrador, mas só se ainda não existir nenhum.
 *
 * Tudo é idempotente: publicar uma versão nova roda isto de novo sem
 * duplicar nada e sem desfazer o que a equipe editou pelo painel.
 *
 * O administrador só é criado na primeira vez de propósito. Se fosse
 * recriado a cada reinício, uma troca de senha feita no painel voltaria
 * sozinha para o valor da variável de ambiente.
 */
const db = require('../server/db/pool');
const { runMigrations } = require('../server/db/migrate');
const { runSeed } = require('../server/db/seed/run');
const bcrypt = require('bcryptjs');

function log(mensagem) {
  console.log(`[bootstrap] ${mensagem}`);
}

async function garantirAdministrador() {
  const existente = await db.one(`SELECT count(*)::int AS total FROM users WHERE role = 'admin'`);
  if (existente.total > 0) {
    log(`administrador já existe (${existente.total}); nada a fazer`);
    return;
  }

  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const senha = String(process.env.ADMIN_PASSWORD || '');
  const nome = String(process.env.ADMIN_NAME || 'Administrador').trim();

  if (!email || !senha) {
    log('nenhum administrador cadastrado e ADMIN_EMAIL/ADMIN_PASSWORD não foram definidos');
    log('defina as duas variáveis e reinicie, ou rode: node scripts/create-admin.js');
    return;
  }
  if (senha.length < 8) {
    log('ADMIN_PASSWORD precisa ter pelo menos 8 caracteres; administrador não criado');
    return;
  }

  const hash = await bcrypt.hash(senha, 12);
  await db.query(
    `INSERT INTO users (name, email, password_hash, role, status)
     VALUES ($1, $2, $3, 'admin', 'active')
     ON CONFLICT DO NOTHING`,
    [nome, email, hash]
  );
  log(`administrador criado: ${email}`);
  log('troque a senha no painel depois do primeiro acesso');
}

async function main() {
  log('aplicando migrations…');
  await runMigrations({ quiet: true });

  log('garantindo o conteúdo base…');
  await runSeed({ quiet: true });

  log('conferindo o administrador…');
  await garantirAdministrador();

  log('pronto.');
}

main()
  .then(() => db.closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`[bootstrap] falhou: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    await db.closePool().catch(() => {});
    process.exit(1);
  });
