'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const mailer = require('../server/services/mailer');
const settings = require('../server/services/settings');

describe('Fundação: saúde, autenticação, CSRF e recuperação de senha', () => {
  let ctx;

  before(async () => {
    ctx = await createTestContext();
  });

  after(async () => {
    await ctx.close();
  });

  it('GET /api/health responde ok com banco conectado', async () => {
    const res = await ctx.request('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.db, 'ok');
    assert.equal(typeof res.body.version, 'string');
    assert.equal(typeof res.body.uptime, 'number');
  });

  it('GET /api/billing/plans lista apenas planos ativos sem expor identificadores legados', async () => {
    await ctx.db.query(
      `INSERT INTO plans (
         slug, name, description, price_cents, currency, interval,
         stripe_product_id, stripe_price_id, features, highlight, active, sort_order
       ) VALUES
         ('visivel', 'Plano visível', 'Publicado', 4990, 'brl', 'month', 'prod_secret', 'price_secret', '["Recurso"]', true, true, 2),
         ('oculto', 'Plano oculto', 'Desativado', 9990, 'brl', 'month', 'prod_hidden', 'price_hidden', '[]', false, false, 1)`
    );

    const res = await ctx.request('GET', '/api/billing/plans');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].slug, 'visivel');
    assert.equal(res.body[0].highlight, true);
    assert.deepEqual(res.body[0].features, ['Recurso']);
    assert.equal(res.body[0].stripe_product_id, undefined);
    assert.equal(res.body[0].stripe_price_id, undefined);
    assert.match(res.headers.get('cache-control'), /no-store/);
  });

  it('rota de API inexistente devolve 404 no formato padrão', async () => {
    const res = await ctx.request('GET', '/api/nao-existe');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });

  describe('cadastro e login', () => {
    it('registra um aluno, cria perfil vazio e devolve cookie fe_session', async () => {
      const email = `maria-${Date.now()}@teste.focoelite.com.br`;
      const res = await ctx.request('POST', '/api/auth/register', {
        body: { name: 'Maria Silva', email: email.toUpperCase(), password: 'Senha@12345' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.user.email, email);
      assert.equal(res.body.user.role, 'student');
      assert.equal(res.body.user.password_hash, undefined);
      assert.equal(res.body.user.token_version, undefined);
      assert.ok(res.cookies.fe_session, 'cookie fe_session deve ser emitido');
      assert.equal(res.cookies.fe_admin, undefined);
      assert.ok(res.body.user.last_login_at, 'last_login_at deve ser preenchido');
      assert.equal(res.body.access.allowed, true);
      assert.equal(res.body.next, '/app/onboarding');

      const profile = await ctx.db.one('SELECT * FROM student_profiles WHERE user_id = $1', [res.body.user.id]);
      assert.ok(profile, 'perfil do aluno deve existir');
      assert.equal(profile.onboarding_completed, false);
    });

    it('permite criar a conta, mas encaminha para o pagamento quando a assinatura é obrigatória', async () => {
      await settings.setSetting('require_subscription', true);
      try {
        const email = `pagamento-${Date.now()}@teste.focoelite.com.br`;
        const res = await ctx.request('POST', '/api/auth/register', {
          body: { name: 'Aluno sem Plano', email, password: 'Senha@12345' },
        });
        assert.equal(res.status, 201);
        assert.equal(res.body.access.allowed, false);
        assert.equal(res.body.access.reason, 'no_subscription');
        assert.equal(res.body.next, '/app/assinatura');

        const content = await ctx.agent(res.cookie).get('/api/dashboard');
        assert.equal(content.status, 402);
        assert.equal(content.body.error.code, 'payment_required');

        const billing = await ctx.agent(res.cookie).get('/api/billing/status');
        assert.equal(billing.status, 200);
        assert.equal(billing.body.access.allowed, false);
      } finally {
        await settings.setSetting('require_subscription', false);
      }
    });

    it('rejeita cadastro com dados inválidos (400 validation_error com details em português)', async () => {
      const res = await ctx.request('POST', '/api/auth/register', {
        body: { name: 'A', email: 'nao-e-email', password: '123' },
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_error');
      const paths = res.body.error.details.map((d) => d.path);
      assert.ok(paths.includes('name'));
      assert.ok(paths.includes('email'));
      assert.ok(paths.includes('password'));
      const emailDetail = res.body.error.details.find((d) => d.path === 'email');
      assert.equal(emailDetail.message, 'E-mail inválido.');
    });

    it('rejeita e-mail duplicado com 409', async () => {
      const { email } = await ctx.registerStudent();
      const res = await ctx.request('POST', '/api/auth/register', {
        body: { name: 'Outro Nome', email, password: 'Senha@12345' },
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'conflict');
    });

    it('login com senha errada devolve 401; login correto devolve usuário e cookie', async () => {
      const { email, password } = await ctx.registerStudent();

      const wrong = await ctx.request('POST', '/api/auth/login', { body: { email, password: 'errada-123' } });
      assert.equal(wrong.status, 401);
      assert.equal(wrong.body.error.code, 'unauthorized');

      const ok = await ctx.request('POST', '/api/auth/login', { body: { email, password } });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.user.email, email);
      assert.ok(ok.cookies.fe_session);
    });

    it('GET /api/auth/me devolve user, profile, exam e access', async () => {
      const { cookie, user } = await ctx.registerStudent();
      const res = await ctx.request('GET', '/api/auth/me', { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, user.id);
      assert.equal(res.body.user.password_hash, undefined);
      assert.ok(res.body.profile);
      assert.equal(res.body.profile.onboarding_completed, false);
      assert.deepEqual(res.body.profile.study_days, []);
      assert.equal(res.body.exam, null);
      assert.equal(res.body.access.allowed, true);
      assert.equal(res.body.access.reason, 'open');
      assert.equal(res.body.access.subscription, null);
    });

    it('GET /api/auth/me sem cookie devolve 401', async () => {
      const res = await ctx.request('GET', '/api/auth/me');
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'unauthorized');
    });

    it('logout limpa o cookie', async () => {
      const { cookie } = await ctx.registerStudent();
      const res = await ctx.request('POST', '/api/auth/logout', { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.cookies.fe_session, '');
    });

    it('aluno bloqueado perde o acesso', async () => {
      const { cookie, user } = await ctx.registerStudent();
      await ctx.db.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [user.id]);
      const res = await ctx.request('GET', '/api/auth/me', { cookie });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'forbidden');
    });
  });

  describe('proteção CSRF', () => {
    it('POST em /api sem o header X-Requested-With é bloqueado com 403', async () => {
      const res = await ctx.request('POST', '/api/auth/login', {
        body: { email: 'x@y.com', password: 'qualquer' },
        csrf: false,
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'forbidden');
    });

    it('GET em /api não exige o header', async () => {
      const res = await ctx.request('GET', '/api/health', { csrf: false });
      assert.equal(res.status, 200);
    });
  });

  describe('separação aluno / admin', () => {
    it('aluno não acessa /api/admin/dashboard nem /api/admin/auth/me', async () => {
      const { cookie } = await ctx.registerStudent();
      const dashboard = await ctx.request('GET', '/api/admin/dashboard', { cookie });
      assert.ok([401, 403].includes(dashboard.status), `esperado 401/403, recebido ${dashboard.status}`);
      const me = await ctx.request('GET', '/api/admin/auth/me', { cookie });
      assert.equal(me.status, 401);
    });

    it('aluno não obtém cookie de admin pelo login administrativo', async () => {
      const { email, password } = await ctx.registerStudent();
      const res = await ctx.request('POST', '/api/admin/auth/login', { body: { email, password } });
      assert.equal(res.status, 401);
      assert.equal(res.cookies.fe_admin, undefined);
    });

    it('admin faz login, consulta /me e sai', async () => {
      const admin = await ctx.loginAdmin();
      assert.ok(admin.cookie.includes('fe_admin='));
      assert.equal(admin.user.role, 'admin');

      const me = await ctx.request('GET', '/api/admin/auth/me', { cookie: admin.cookie });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.email, admin.email);

      // cookie de admin não vale como sessão de aluno
      const studentMe = await ctx.request('GET', '/api/auth/me', { cookie: admin.cookie });
      assert.equal(studentMe.status, 401);

      const logout = await ctx.request('POST', '/api/admin/auth/logout', { cookie: admin.cookie });
      assert.equal(logout.status, 200);
      assert.equal(logout.cookies.fe_admin, '');
    });
  });

  describe('recuperação de senha', () => {
    it('forgot-password sempre responde 200 e não revela e-mails', async () => {
      const res = await ctx.request('POST', '/api/auth/forgot-password', {
        body: { email: 'ninguem@teste.focoelite.com.br' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('fluxo completo: pedido → e-mail com link → redefinição → sessões antigas encerradas', async () => {
      const { email, cookie: oldCookie } = await ctx.registerStudent();
      mailer.outbox.length = 0;

      const forgot = await ctx.request('POST', '/api/auth/forgot-password', { body: { email } });
      assert.equal(forgot.status, 200);
      assert.equal(mailer.outbox.length, 1, 'um e-mail deve ter sido gerado');
      const mail = mailer.outbox[0];
      assert.equal(mail.to, email);
      assert.ok(mail.link.includes('/redefinir-senha?token='), 'link deve apontar para a página de redefinição');
      const token = new URL(mail.link).searchParams.get('token');
      assert.ok(token && token.length >= 40);

      const stored = await ctx.db.one('SELECT token_hash FROM password_resets WHERE used_at IS NULL');
      assert.notEqual(stored.token_hash, token, 'o banco guarda apenas o hash do token');

      const invalid = await ctx.request('POST', '/api/auth/reset-password', {
        body: { token: 'token-invalido-token-invalido', password: 'NovaSenha@123' },
      });
      assert.equal(invalid.status, 400);

      const reset = await ctx.request('POST', '/api/auth/reset-password', {
        body: { token, password: 'NovaSenha@123' },
      });
      assert.equal(reset.status, 200);

      const reuse = await ctx.request('POST', '/api/auth/reset-password', {
        body: { token, password: 'OutraSenha@123' },
      });
      assert.equal(reuse.status, 400, 'token não pode ser reutilizado');

      const oldSession = await ctx.request('GET', '/api/auth/me', { cookie: oldCookie });
      assert.equal(oldSession.status, 401, 'sessão anterior deve ser invalidada');

      const oldLogin = await ctx.request('POST', '/api/auth/login', { body: { email, password: 'Senha@12345' } });
      assert.equal(oldLogin.status, 401);

      const newLogin = await ctx.request('POST', '/api/auth/login', { body: { email, password: 'NovaSenha@123' } });
      assert.equal(newLogin.status, 200);
    });
  });

  describe('perfil', () => {
    it('PUT /api/profile atualiza nome e dados do perfil', async () => {
      const { cookie } = await ctx.registerStudent();
      const res = await ctx.request('PUT', '/api/profile', {
        cookie,
        body: { name: 'Nome Atualizado', study_days: [1, 3, 5, 3], hours_per_day: 3, level: 'intermediario' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.name, 'Nome Atualizado');
      assert.deepEqual(res.body.profile.study_days, [1, 3, 5]);
      assert.equal(res.body.profile.hours_per_day, 3);
      assert.equal(res.body.profile.level, 'intermediario');

      const invalid = await ctx.request('PUT', '/api/profile', { cookie, body: { level: 'mestre' } });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, 'validation_error');
    });

    it('PUT /api/profile/password troca a senha e mantém a sessão atual', async () => {
      const { cookie, email, password } = await ctx.registerStudent();

      const wrong = await ctx.request('PUT', '/api/profile/password', {
        cookie,
        body: { current_password: 'errada-123', new_password: 'NovaSenha@123' },
      });
      assert.equal(wrong.status, 400);

      const ok = await ctx.request('PUT', '/api/profile/password', {
        cookie,
        body: { current_password: password, new_password: 'NovaSenha@123' },
      });
      assert.equal(ok.status, 200);
      assert.ok(ok.cookies.fe_session, 'novo cookie deve ser emitido');

      const oldSession = await ctx.request('GET', '/api/auth/me', { cookie });
      assert.equal(oldSession.status, 401, 'cookie antigo deve ser invalidado');

      const newSession = await ctx.request('GET', '/api/auth/me', { cookie: ok.cookie });
      assert.equal(newSession.status, 200);

      const login = await ctx.request('POST', '/api/auth/login', { body: { email, password: 'NovaSenha@123' } });
      assert.equal(login.status, 200);
    });
  });
});
