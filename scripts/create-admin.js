'use strict';

/**
 * Cria ou atualiza o administrador.
 *
 *   npm run create-admin                       usa ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME do .env
 *   node scripts/create-admin.js --email admin@exemplo.com --password 'senha-forte' --name 'Nome'
 *
 * Se o e-mail já existir, a senha e o nome são atualizados, o papel vira 'admin', a conta é
 * desbloqueada e todas as sessões anteriores são encerradas (token_version + 1).
 */
const bcrypt = require('bcryptjs');
const config = require('../server/config');
const db = require('../server/db/pool');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=');
    if (inlineValue !== undefined) args[key] = inlineValue;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i += 1;
    } else args[key] = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || config.admin.email || '').trim().toLowerCase();
  const password = String(args.password || config.admin.password || '');
  const name = String(args.name || config.admin.name || 'Administrador').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Informe um e-mail válido em ADMIN_EMAIL ou com --email.');
  }
  if (password.length < 8) {
    throw new Error('A senha precisa ter ao menos 8 caracteres (ADMIN_PASSWORD ou --password).');
  }
  if (password === 'troque-esta-senha') {
    if (config.isProd) throw new Error('Troque ADMIN_PASSWORD antes de criar o admin em produção.');
    console.warn('[create-admin] atenção: ADMIN_PASSWORD ainda é o valor padrão do .env.example.');
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const existing = await db.one('SELECT id, role FROM users WHERE lower(email) = lower($1)', [email]);

  let user;
  if (existing) {
    user = await db.one(
      `UPDATE users
          SET name = $1, password_hash = $2, role = 'admin', status = 'active', token_version = token_version + 1
        WHERE id = $3
        RETURNING id, name, email, role`,
      [name, passwordHash, existing.id]
    );
    console.log(`[create-admin] administrador atualizado: ${user.email} (${user.name})`);
  } else {
    user = await db.one(
      `INSERT INTO users (name, email, password_hash, role, status)
       VALUES ($1, $2, $3, 'admin', 'active')
       RETURNING id, name, email, role`,
      [name, email, passwordHash]
    );
    console.log(`[create-admin] administrador criado: ${user.email} (${user.name})`);
  }
  console.log(`[create-admin] acesse ${config.appUrl}/admin/login`);
}

main()
  .then(() => db.closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`[create-admin] erro: ${err.message}`);
    await db.closePool().catch(() => {});
    process.exit(1);
  });
