'use strict';

/**
 * Painel e página inicial com moedas e níveis.
 *
 *   NODE_ENV=test node --test --test-concurrency=1 tests/moedas-painel.test.js
 *
 * O que não pode quebrar: o suporte dá moedas extras ao aluno pela ficha dele
 * (só de 1 a 500 por vez, com motivo, registrado na auditoria) e o saldo do
 * dia sobe na hora; a ficha mostra a carteira e o extrato; o painel de uso de
 * IA mostra a cota do Tutor de cada nível em vez de um limite único; e a
 * página inicial conta os dias até o ENEM só quando a prova ainda vai
 * acontecer — a data vem do cadastro de Provas e muda sem esperar o cache.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const settings = require('../server/services/settings');
const dates = require('../server/utils/dates');
const { invalidateLandingCache } = require('../server/routes/landing');

describe('Moedas no painel e contagem até o ENEM', () => {
  let ctx;
  let db;
  let admin;
  let basico;

  /** Aluno com assinatura vigente do Básico (30 moedas por dia no padrão). */
  async function alunoBasico() {
    const aluno = await ctx.registerStudent();
    await db.query(
      `INSERT INTO subscriptions (user_id, plan_id, provider, provider_subscription_id, status, current_period_end)
       VALUES ($1, $2, 'asaas', $3, 'active', now() + interval '30 days')`,
      [aluno.user.id, basico, `sub_painel_${aluno.user.id}`]
    );
    return aluno;
  }

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    admin = await ctx.loginAdmin();
    const plano = await db.one(
      `INSERT INTO plans (slug, name, price_cents, currency, interval, interval_count, duration_months, tier, active, sort_order)
       VALUES ('basico-mensal', 'Básico Mensal', 2990, 'brl', 'month', 1, 1, 'basico', true, 11)
       RETURNING id`
    );
    basico = plano.id;
  });

  afterEach(async () => {
    await settings.setSetting('tutor_tokens_pro', null);
    await settings.setSetting('ai_student_monthly_token_limit', null);
    invalidateLandingCache();
  });

  after(async () => {
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  // Dar moedas hoje
  // -------------------------------------------------------------------------
  describe('dar moedas pela ficha do aluno', () => {
    it('soma ao saldo de hoje, aparece no extrato e fica na auditoria', async () => {
      const aluno = await alunoBasico();
      const antes = await aluno.agent.get('/api/coins');
      assert.equal(antes.status, 200, JSON.stringify(antes.body));
      assert.equal(antes.body.balance, 30);

      const res = await admin.agent.post(`/api/admin/students/${aluno.user.id}/coins`, {
        amount: 15,
        note: 'Correção travou ontem',
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.grant.amount, 15);
      assert.equal(res.body.grant.kind, 'grant');
      assert.equal(res.body.grant.action, 'admin_grant');
      assert.equal(res.body.grant.day, dates.todayISO());
      assert.equal(res.body.coins.wallet.balance, 45);
      assert.equal(res.body.coins.wallet.granted, 15);
      assert.match(res.body.message, /15 moedas somadas ao saldo de hoje/);

      // o aluno vê o saldo novo na hora
      const depois = await aluno.agent.get('/api/coins');
      assert.equal(depois.body.balance, 45);
      assert.equal(depois.body.granted, 15);
      assert.equal(depois.body.daily, 30, 'as moedas do nível não mudam');

      // a ficha traz a carteira e o extrato com quem deu e o motivo
      const ficha = await admin.agent.get(`/api/admin/students/${aluno.user.id}`);
      assert.equal(ficha.status, 200, JSON.stringify(ficha.body));
      assert.equal(ficha.body.coins.wallet.tier, 'basico');
      assert.equal(ficha.body.coins.wallet.balance, 45);
      const [lancamento] = ficha.body.coins.ledger;
      assert.equal(lancamento.kind, 'grant');
      assert.equal(lancamento.amount, 15);
      assert.equal(lancamento.note, 'Correção travou ontem');
      assert.equal(lancamento.created_by, admin.user.id);
      assert.equal(lancamento.created_by_name, admin.user.name);

      const registro = await db.one(
        `SELECT admin_id, entity, entity_id, data FROM audit_logs
          WHERE action = 'student.coins_grant' AND entity_id = $1`,
        [aluno.user.id]
      );
      assert.ok(registro, 'a concessão fica na auditoria');
      assert.equal(registro.admin_id, admin.user.id);
      assert.equal(registro.entity, 'user');
      assert.equal(registro.data.amount, 15);
      assert.equal(registro.data.note, 'Correção travou ontem');
    });

    it('só aceita de 1 a 500 moedas inteiras, com motivo', async () => {
      const aluno = await alunoBasico();
      const url = `/api/admin/students/${aluno.user.id}/coins`;
      for (const body of [
        { amount: 0, note: 'teste' },
        { amount: -5, note: 'teste' },
        { amount: 501, note: 'teste' },
        { amount: 2.5, note: 'teste' },
        { amount: 10 },
        { amount: 10, note: '  ' },
        { amount: 10, note: 'teste', extra: true },
      ]) {
        const res = await admin.agent.post(url, body);
        assert.equal(res.status, 400, `${JSON.stringify(body)} → ${res.status} ${JSON.stringify(res.body)}`);
      }

      const limite = await admin.agent.post(url, { amount: 500, note: 'Limite máximo' });
      assert.equal(limite.status, 201, JSON.stringify(limite.body));
      const um = await admin.agent.post(url, { amount: 1, note: 'Limite mínimo' });
      assert.equal(um.status, 201, JSON.stringify(um.body));
      assert.match(um.body.message, /1 moeda somada/);

      const total = await db.one(
        `SELECT count(*)::int AS lancamentos, coalesce(sum(amount), 0)::int AS moedas
           FROM coin_ledger WHERE user_id = $1 AND kind = 'grant'`,
        [aluno.user.id]
      );
      assert.deepEqual(total, { lancamentos: 2, moedas: 501 }, 'as tentativas recusadas não gravam nada');
    });

    it('aluno que não gasta moedas recebe o registro com o aviso', async () => {
      // sem assinatura e com a plataforma aberta (padrão dos testes), o aluno é ilimitado
      const aluno = await ctx.registerStudent();
      const res = await admin.agent.post(`/api/admin/students/${aluno.user.id}/coins`, { amount: 20, note: 'Cortesia' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.coins.wallet.unlimited, true);
      assert.match(res.body.message, /não gasta moedas/);
    });

    it('não dá moedas para quem não é aluno, nem deixa aluno dar', async () => {
      const aluno = await alunoBasico();
      const outro = await alunoBasico();

      const inexistente = await admin.agent.post('/api/admin/students/00000000-0000-4000-8000-000000000000/coins', {
        amount: 10,
        note: 'teste',
      });
      assert.equal(inexistente.status, 404);

      const paraAdmin = await admin.agent.post(`/api/admin/students/${admin.user.id}/coins`, { amount: 10, note: 'teste' });
      assert.equal(paraAdmin.status, 404, 'a conta da equipe não é aluno');

      const peloAluno = await aluno.agent.post(`/api/admin/students/${outro.user.id}/coins`, { amount: 10, note: 'teste' });
      assert.ok([401, 403].includes(peloAluno.status), `status ${peloAluno.status}`);
      const saldo = await outro.agent.get('/api/coins');
      assert.equal(saldo.body.balance, 30);
    });
  });

  // -------------------------------------------------------------------------
  // Uso de IA no painel
  // -------------------------------------------------------------------------
  describe('uso de IA no painel', () => {
    it('mostra a cota do Tutor de cada nível e a cota do acesso completo', async () => {
      await settings.setSetting('tutor_tokens_pro', 0);
      await settings.setSetting('ai_student_monthly_token_limit', 2000000);
      const res = await admin.agent.get('/api/admin/ai/usage?days=7');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.tutor_limits, { basico: 1500000, pro: 0, avancado: 5000000 });
      assert.equal(res.body.limit, 2000000);
      assert.equal(res.body.limit_reached, false);
    });
  });

  // -------------------------------------------------------------------------
  // Contagem regressiva na página inicial
  // -------------------------------------------------------------------------
  describe('contagem até o ENEM em /api/landing', () => {
    let enem;

    before(async () => {
      const row = await db.one(
        `INSERT INTO exams (slug, name, short_name, track, sort_order)
         VALUES ('enem', 'Exame Nacional do Ensino Médio', 'ENEM', 'enem', 1)
         RETURNING id`
      );
      enem = row.id;
    });

    async function marcarProva(data) {
      const res = await admin.agent.put(`/api/admin/exams/${enem}`, { exam_date: data });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }

    it('sem data cadastrada não há contagem', async () => {
      invalidateLandingCache();
      const res = await ctx.request('GET', '/api/landing');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.countdown, null);
    });

    it('com a prova no futuro, diz quantos dias faltam', async () => {
      // antes, a página já foi lida (e guardada no cache) sem a data
      await ctx.request('GET', '/api/landing');
      const prova = dates.addDays(dates.todayISO(), 40);
      await marcarProva(prova);

      const res = await ctx.request('GET', '/api/landing');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.countdown, { exam_short_name: 'ENEM', exam_date: prova, days_left: 40 });
    });

    it('com a prova hoje ou já passada, a contagem some', async () => {
      await marcarProva(dates.todayISO());
      const hoje = await ctx.request('GET', '/api/landing');
      assert.equal(hoje.body.countdown, null, '"faltam 0 dias" não aparece');

      await marcarProva(dates.addDays(dates.todayISO(), -10));
      const passada = await ctx.request('GET', '/api/landing');
      assert.equal(passada.body.countdown, null);
    });

    it('a prova desativada no painel não conta', async () => {
      await marcarProva(dates.addDays(dates.todayISO(), 15));
      const ativa = await ctx.request('GET', '/api/landing');
      assert.equal(ativa.body.countdown.days_left, 15);

      const res = await admin.agent.put(`/api/admin/exams/${enem}`, { active: false });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const desativada = await ctx.request('GET', '/api/landing');
      assert.equal(desativada.body.countdown, null);
      await admin.agent.put(`/api/admin/exams/${enem}`, { active: true });
    });

    it('os dias são contados a cada resposta, não guardados no cache', async () => {
      const prova = dates.addDays(dates.todayISO(), 20);
      await marcarProva(prova);
      const agora = await ctx.request('GET', '/api/landing');
      assert.equal(agora.body.countdown.days_left, 20);

      // o cache guarda só a data; a conta roda na resposta, então amanhã (com
      // o mesmo cache ainda válido) já sai um dia a menos
      const { countdownFrom } = require('../server/routes/landing');
      const amanha = dates.addDays(dates.todayISO(), 1);
      assert.equal(countdownFrom({ exam_short_name: 'ENEM', exam_date: prova }, amanha).days_left, 19);
      assert.equal(countdownFrom({ exam_short_name: 'ENEM', exam_date: prova }, prova), null);
      assert.equal(countdownFrom(null), null);
    });
  });
});
