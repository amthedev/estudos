'use strict';

/**
 * Configuração inicial do administrador.
 *
 *   NODE_ENV=test node --test tests/admin-setup.test.js
 *
 * Enquanto nenhum administrador existe, a primeira pessoa a abrir o painel
 * cria a própria conta ali (POST /api/admin/auth/setup) — sem depender de
 * variável de ambiente nem de terminal. Depois de criado, a rota trava.
 *
 * Um único contexto de teste é usado no arquivo inteiro: `ctx.close()`
 * encerra o pool de conexões do processo, então um segundo
 * `createTestContext()` depois dele quebraria com "pool já encerrado".
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

describe('Configuração inicial do administrador', () => {
  let ctx;
  let winnerEmail;
  let winnerPassword;

  before(async () => {
    ctx = await createTestContext(); // schema recriado: banco sem nenhum usuário
  });

  after(async () => {
    await ctx.close();
  });

  it('diz que a configuração é necessária quando não há administrador', async () => {
    const res = await ctx.request('GET', '/api/admin/auth/setup-status');
    assert.equal(res.status, 200);
    assert.equal(res.body.needed, true);
  });

  it('recusa dados inválidos antes de criar qualquer coisa', async () => {
    const semNome = await ctx.request('POST', '/api/admin/auth/setup', {
      body: { name: '', email: 'invalido1@focoelite.com.br', password: 'senhaForte123' },
    });
    assert.equal(semNome.status, 400);

    const senhaCurta = await ctx.request('POST', '/api/admin/auth/setup', {
      body: { name: 'Guilherme', email: 'invalido2@focoelite.com.br', password: '123' },
    });
    assert.equal(senhaCurta.status, 400);

    const emailInvalido = await ctx.request('POST', '/api/admin/auth/setup', {
      body: { name: 'Guilherme', email: 'nao-e-email', password: 'senhaForte123' },
    });
    assert.equal(emailInvalido.status, 400);

    const total = await ctx.db.one("SELECT count(*)::int AS total FROM users WHERE role = 'admin'");
    assert.equal(total.total, 0, 'nada disso pode ter criado um administrador');
  });

  it('recusa quando o e-mail já pertence a outro usuário (mesmo não-admin)', async () => {
    await ctx.registerStudent({ email: 'ocupado@focoelite.com.br' });
    const res = await ctx.request('POST', '/api/admin/auth/setup', {
      body: { name: 'Guilherme', email: 'ocupado@focoelite.com.br', password: 'senhaForte123' },
    });
    assert.equal(res.status, 409);
    assert.ok(res.body.error.details?.some((d) => d.path === 'email'));

    const total = await ctx.db.one("SELECT count(*)::int AS total FROM users WHERE role = 'admin'");
    assert.equal(total.total, 0);
  });

  it('quando duas pessoas tentam ao mesmo tempo, só uma vira administrador', async () => {
    const candidatos = [
      { name: 'Primeira Pessoa', email: 'primeira@focoelite.com.br', password: 'senhaForte123' },
      { name: 'Segunda Pessoa', email: 'segunda@focoelite.com.br', password: 'outraSenhaForte' },
    ];
    const [a, b] = await Promise.all(candidatos.map((body) => ctx.request('POST', '/api/admin/auth/setup', { body })));

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], 'uma cria (201), a outra chega tarde (409)');

    const total = await ctx.db.one("SELECT count(*)::int AS total FROM users WHERE role = 'admin'");
    assert.equal(total.total, 1, 'a corrida não pode resultar em dois administradores');

    const vencedora = a.status === 201 ? a : b;
    assert.equal(vencedora.body.user.role, 'admin');
    assert.equal(vencedora.body.user.password_hash, undefined, 'a senha não pode voltar na resposta');
    assert.ok(vencedora.cookie, 'quem cria já sai logada, com o cookie de sessão');

    const candidato = candidatos.find((c) => c.email === vencedora.body.user.email);
    winnerEmail = candidato.email;
    winnerPassword = candidato.password;

    const me = await ctx.request('GET', '/api/admin/auth/me', { cookie: vencedora.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, winnerEmail);
  });

  it('a senha ficou de verdade no banco, com hash — não em texto puro', async () => {
    const row = await ctx.db.one('SELECT password_hash FROM users WHERE email = $1', [winnerEmail]);
    assert.ok(row.password_hash);
    assert.notEqual(row.password_hash, winnerPassword);
    assert.match(row.password_hash, /^\$2[aby]\$/, 'precisa ser um hash bcrypt');
  });

  it('agora diz que a configuração não é mais necessária', async () => {
    const res = await ctx.request('GET', '/api/admin/auth/setup-status');
    assert.equal(res.body.needed, false);
  });

  it('a rota de configuração trava depois de criado o primeiro administrador', async () => {
    const res = await ctx.request('POST', '/api/admin/auth/setup', {
      body: { name: 'Outra Pessoa', email: 'outra@focoelite.com.br', password: 'outraSenhaForte' },
    });
    assert.equal(res.status, 409);

    const total = await ctx.db.one("SELECT count(*)::int AS total FROM users WHERE role = 'admin'");
    assert.equal(total.total, 1, 'continua existindo só um administrador');
  });

  it('o login normal funciona com a conta criada na configuração', async () => {
    const res = await ctx.request('POST', '/api/admin/auth/login', {
      body: { email: winnerEmail, password: winnerPassword },
    });
    assert.equal(res.status, 200);
  });

  it('um aluno não acessa o /me de admin, mesmo com o próprio cookie válido', async () => {
    const student = await ctx.registerStudent();
    const res = await ctx.request('GET', '/api/admin/auth/me', { cookie: student.cookie });
    assert.equal(res.status, 401);
  });
});
