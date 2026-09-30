'use strict';

/**
 * Moedas diárias por nível de plano e cota do Tutor por nível.
 *
 *   NODE_ENV=test node --test --test-concurrency=1 tests/moedas.test.js
 *
 * O que não pode quebrar: cada nível recebe as suas moedas do dia; a cobrança
 * desconta e nunca deixa o saldo negativo; dois cliques no mesmo objeto cobram
 * uma vez só; o estorno devolve (uma vez só); à meia-noite o saldo volta cheio
 * sem somar a sobra; o assinante antigo fica ilimitado até o fim do período que
 * já tinha pago e depois vira Básico; equipe, cortesia e acesso aberto não
 * gastam moeda; e a cota de tokens do nível só barra o Tutor.
 *
 * Aqui o serviço é testado direto; as rotas que cobram (redação, tema,
 * simulado, Pratique, questões) estão em tests/moedas-acoes.test.js.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const coins = require('../server/services/coins');
const ai = require('../server/services/ai');
const settings = require('../server/services/settings');
const dates = require('../server/utils/dates');
const { computeAccess } = require('../server/middleware/access');

/** Chaves mexidas pelos testes; voltam ao padrão depois de cada um. */
const CHAVES_MEXIDAS = [
  'require_subscription',
  'coins_daily_basico',
  'coins_daily_pro',
  'coin_cost_essay_correction',
  'tutor_tokens_basico',
  'ai_student_monthly_token_limit',
];

describe('Moedas diárias', () => {
  let ctx;
  let db;
  let admin;
  const planos = {};
  let sequencia = 0;

  async function criarPlano(tier) {
    sequencia += 1;
    const row = await db.one(
      `INSERT INTO plans (slug, name, price_cents, currency, interval, interval_count, duration_months, tier, active, sort_order)
       VALUES ($1, $2, 4990, 'brl', 'month', 1, 1, $3, true, $4)
       RETURNING id`,
      [`plano-teste-${sequencia}`, `Plano ${tier || 'antigo'} ${sequencia}`, tier, sequencia]
    );
    return row.id;
  }

  async function assinar(userId, planId, { fim = "now() + interval '30 days'", legado = null, status = 'active' } = {}) {
    await db.query(
      `INSERT INTO subscriptions (user_id, plan_id, provider, provider_subscription_id, status, current_period_end, legacy_until)
       VALUES ($1, $2, 'asaas', $3, $4, ${fim}, ${legado || 'NULL'})`,
      [userId, planId, `sub_teste_${userId}`, status]
    );
  }

  /** Aluno registrado pela API com assinatura vigente do nível pedido. */
  async function alunoComNivel(tier) {
    const aluno = await ctx.registerStudent({ name: `Aluno ${tier}` });
    await assinar(aluno.user.id, planos[tier]);
    return { ...aluno, ref: { id: aluno.user.id, role: 'student' } };
  }

  async function cobrancasVivas(userId) {
    const row = await db.one(
      `SELECT count(*)::int AS total FROM coin_ledger WHERE user_id = $1 AND kind = 'debit' AND refunded_at IS NULL`,
      [userId]
    );
    return row.total;
  }

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    admin = await ctx.loginAdmin();
    for (const tier of coins.TIERS) planos[tier] = await criarPlano(tier);
    planos.antigo = await criarPlano(null);
  });

  afterEach(async () => {
    for (const chave of CHAVES_MEXIDAS) await settings.setSetting(chave, null);
    // Os testes abrem o acesso por padrão (ver helpers.js).
    await settings.setSetting('require_subscription', false);
  });

  after(async () => {
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  // Carteira
  // -------------------------------------------------------------------------
  it('cada nível recebe as moedas do dia da configuração', async () => {
    const esperado = { basico: 30, pro: 60, avancado: 100 };
    for (const tier of coins.TIERS) {
      const aluno = await alunoComNivel(tier);
      const res = await aluno.agent.get('/api/coins');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const carteira = res.body;
      assert.equal(carteira.unlimited, false);
      assert.equal(carteira.tier, tier);
      assert.equal(carteira.tier_label, coins.TIER_LABELS[tier]);
      assert.equal(carteira.reason, 'plan');
      assert.equal(carteira.daily, esperado[tier]);
      assert.equal(carteira.balance, esperado[tier]);
      assert.equal(carteira.spent, 0);
      assert.equal(carteira.granted, 0);
      assert.equal(carteira.day, dates.todayISO());
      assert.equal(carteira.resets_at, dates.midnightInSaoPaulo(dates.addDays(dates.todayISO(), 1)).toISOString());
      assert.deepEqual(carteira.costs, {
        essay_correction: 20,
        simulado_short: 10,
        simulado_long: 30,
        simulado_short_max_questions: 30,
        practice: 2,
        questions: 5,
        essay_theme: 5,
      });
    }
  });

  it('o /api/auth/me traz a carteira junto', async () => {
    const aluno = await alunoComNivel('pro');
    const me = await aluno.agent.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.coins.tier, 'pro');
    assert.equal(me.body.coins.balance, 60);
    // o nível chega também na assinatura do acesso
    assert.equal(me.body.access.subscription.plan_tier, 'pro');
    assert.equal(me.body.access.subscription.plan_duration_months, 1);
  });

  it('o valor das moedas por nível vem do painel', async () => {
    const res = await admin.agent.put('/api/admin/settings', { coins_daily_pro: 75, coin_cost_essay_correction: 0 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const negativo = await admin.agent.put('/api/admin/settings', { coins_daily_basico: -1 });
    assert.equal(negativo.status, 400);

    const aluno = await alunoComNivel('pro');
    const carteira = await coins.getWallet({ user: aluno.ref });
    assert.equal(carteira.daily, 75);
    assert.equal(carteira.costs.essay_correction, 0);
  });

  // -------------------------------------------------------------------------
  // Cobrança e estorno
  // -------------------------------------------------------------------------
  it('a cobrança desconta do saldo e o saldo insuficiente responde 402 com os detalhes', async () => {
    const aluno = await alunoComNivel('basico');
    const primeira = await coins.charge(db, {
      user: aluno.ref,
      action: 'essay_correction',
      cost: 20,
      refType: 'essay',
      refId: 'redacao-1',
    });
    assert.ok(primeira.chargeId);
    assert.equal(primeira.wallet.balance, 10);
    assert.equal(primeira.wallet.spent, 20);

    await assert.rejects(
      () => coins.charge(db, { user: aluno.ref, action: 'essay_correction', cost: 20, refType: 'essay', refId: 'redacao-2' }),
      (err) => {
        assert.equal(err.status, 402);
        assert.equal(err.code, 'insufficient_coins');
        assert.match(err.message, /moedas de hoje acabaram/);
        assert.equal(err.details.balance, 10);
        assert.equal(err.details.cost, 20);
        assert.equal(err.details.daily, 30);
        assert.equal(err.details.tier, 'basico');
        assert.equal(err.details.resets_at, primeira.wallet.resets_at);
        return true;
      }
    );
    assert.equal(await cobrancasVivas(aluno.user.id), 1);

    // custo zero é ação grátis: não grava nada
    const gratis = await coins.charge(db, { user: aluno.ref, action: 'practice', cost: 0, refType: 'lesson', refId: 'x' });
    assert.equal(gratis.chargeId, null);
    assert.equal(gratis.wallet.balance, 10);
  });

  it('dois pedidos simultâneos do mesmo objeto cobram uma vez só', async () => {
    const aluno = await alunoComNivel('avancado');
    const pedido = () =>
      coins.charge(db, { user: aluno.ref, action: 'essay_correction', cost: 20, refType: 'essay', refId: 'mesma-redacao' });
    const resultados = await Promise.allSettled([pedido(), pedido(), pedido()]);

    const aceitos = resultados.filter((r) => r.status === 'fulfilled');
    const recusados = resultados.filter((r) => r.status === 'rejected');
    assert.equal(aceitos.length, 1);
    assert.equal(recusados.length, 2);
    for (const recusa of recusados) {
      assert.equal(recusa.reason.status, 409);
      assert.equal(recusa.reason.code, 'already_charged');
    }
    assert.equal(await cobrancasVivas(aluno.user.id), 1);
    const carteira = await coins.getWallet({ user: aluno.ref });
    assert.equal(carteira.balance, 80);
  });

  it('duas ações simultâneas não passam juntas quando o saldo só dá para uma', async () => {
    const aluno = await alunoComNivel('basico'); // 30 moedas
    const pedido = (ref) =>
      coins.charge(db, { user: aluno.ref, action: 'simulado', cost: 20, refType: 'simulado_attempt', refId: ref });
    const resultados = await Promise.allSettled([pedido('a'), pedido('b')]);
    assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
    const recusa = resultados.find((r) => r.status === 'rejected');
    assert.equal(recusa.reason.code, 'insufficient_coins');
    assert.equal((await coins.getWallet({ user: aluno.ref })).balance, 10);
  });

  it('o estorno devolve a moeda uma vez só e libera cobrar o mesmo objeto de novo', async () => {
    const aluno = await alunoComNivel('basico');
    const { chargeId } = await coins.charge(db, {
      user: aluno.ref,
      action: 'essay_correction',
      cost: 20,
      refType: 'essay',
      refId: 'redacao-estorno',
    });
    assert.equal((await coins.getWallet({ user: aluno.ref })).balance, 10);

    assert.equal(await coins.refund(chargeId, 'falha na correção'), true);
    assert.equal(await coins.refund(chargeId, 'de novo'), false);
    assert.equal(await coins.refund(null), false);
    // id malformado não derruba quem chamou
    assert.equal(await coins.refund('isto-nao-e-um-uuid'), false);

    const depois = await coins.getWallet({ user: aluno.ref });
    assert.equal(depois.balance, 30);
    assert.equal(depois.spent, 0);
    const linha = await db.one('SELECT refunded_at, refund_reason FROM coin_ledger WHERE id = $1', [chargeId]);
    assert.ok(linha.refunded_at);
    assert.equal(linha.refund_reason, 'falha na correção');

    // o reenvio da mesma redação cobra de novo, e o refundByRef acha a cobrança viva
    await coins.charge(db, { user: aluno.ref, action: 'essay_correction', cost: 20, refType: 'essay', refId: 'redacao-estorno' });
    assert.equal(await coins.refundByRef(aluno.user.id, 'essay_correction', 'essay', 'redacao-estorno', 'boot'), true);
    assert.equal(await coins.refundByRef(aluno.user.id, 'essay_correction', 'essay', 'redacao-estorno', 'boot'), false);
    assert.equal((await coins.getWallet({ user: aluno.ref })).balance, 30);
  });

  it('cobrança dentro de uma transação desfeita não fica gravada', async () => {
    const aluno = await alunoComNivel('pro');
    await assert.rejects(
      () =>
        db.tx(async (client) => {
          const { chargeId } = await coins.charge(client, {
            user: aluno.ref,
            action: 'essay_correction',
            cost: 20,
            refType: 'essay',
            refId: 'redacao-tx',
          });
          assert.ok(chargeId);
          throw new Error('falhou depois de cobrar');
        }),
      /falhou depois de cobrar/
    );
    assert.equal(await cobrancasVivas(aluno.user.id), 0);
    assert.equal((await coins.getWallet({ user: aluno.ref })).balance, 60);
  });

  it('dentro de uma transação, cobrar e estornar não pedem outra conexão ao pool', async () => {
    // A redação e o simulado cobram numa transação aberta. Se a cobrança pede
    // uma segunda conexão ao pool, dez envios juntos prendem as dez conexões
    // esperando a décima primeira, e o app inteiro para até o tempo limite.
    const antigo = await ctx.registerStudent({ name: 'Antigo na Transação' });
    await assinar(antigo.user.id, planos.antigo, { legado: "now() + interval '30 days'" });
    const antigoRef = { id: antigo.user.id, role: 'student' };
    const comNivel = await alunoComNivel('basico');
    const [acessoAntigo, acessoNivel] = await Promise.all([computeAccess(antigo.user.id), computeAccess(comNivel.user.id)]);
    const cobrar = (client, user, access, refId, action = 'teste') =>
      coins.charge(client, { user, access, action, cost: 5, refType: 'teste', refId });
    const primeira = await cobrar(db, comNivel.ref, acessoNivel, 'tx-a');
    await cobrar(db, comNivel.ref, acessoNivel, 'tx-b');
    await coins.readCosts(); // configurações em cache, como nas rotas, que as leem antes da transação

    const consultaDoPool = db.pool.query;
    let pedidosAoPool = 0;
    db.pool.query = function contarPedidos(...args) {
      pedidosAoPool += 1;
      return consultaDoPool.apply(this, args);
    };
    try {
      await db.tx(async (client) => {
        const livre = await cobrar(client, antigoRef, acessoAntigo, 'tx-x', 'essay_correction');
        assert.equal(livre.chargeId, null);
        assert.equal(livre.wallet.unlimited, true);
        assert.equal(await coins.refund(primeira.chargeId, 'teste', client), true);
        assert.equal(await coins.refundByRef(comNivel.user.id, 'teste', 'teste', 'tx-b', 'teste', client), true);
        await cobrar(client, comNivel.ref, acessoNivel, 'tx-c');
      });
    } finally {
      db.pool.query = consultaDoPool;
    }
    assert.equal(pedidosAoPool, 0, 'tudo passa pela conexão da transação');
    assert.equal(await cobrancasVivas(comNivel.user.id), 1);
    assert.equal((await coins.getWallet({ user: comNivel.ref })).balance, 25);
  });

  // -------------------------------------------------------------------------
  // Virada do dia
  // -------------------------------------------------------------------------
  it('à meia-noite o saldo volta cheio e a sobra não acumula', async (t) => {
    const aluno = await alunoComNivel('basico');
    const hoje = dates.todayISO();
    const amanha = dates.addDays(hoje, 1);
    const meiaNoite = dates.midnightInSaoPaulo(amanha).getTime();

    t.mock.timers.enable({ apis: ['Date'], now: meiaNoite - 60_000 }); // 23:59 em São Paulo
    const { chargeId } = await coins.charge(db, {
      user: aluno.ref,
      action: 'essay_correction',
      cost: 20,
      refType: 'essay',
      refId: 'redacao-noite',
    });
    let carteira = await coins.getWallet({ user: aluno.ref });
    assert.equal(carteira.day, hoje);
    assert.equal(carteira.balance, 10);
    assert.equal(carteira.resets_at, new Date(meiaNoite).toISOString());

    t.mock.timers.tick(2 * 60_000); // 00:01
    carteira = await coins.getWallet({ user: aluno.ref });
    assert.equal(carteira.day, amanha);
    assert.equal(carteira.balance, 30, 'as 10 que sobraram ontem não passam para hoje');
    assert.equal(carteira.spent, 0);

    // o estorno de uma falha que atravessou a meia-noite volta para o dia da
    // cobrança: o saldo de hoje, que já veio cheio, não cresce
    assert.equal(await coins.refund(chargeId, 'falha depois da meia-noite'), true);
    carteira = await coins.getWallet({ user: aluno.ref });
    assert.equal(carteira.balance, 30);
    const linha = await db.one('SELECT day FROM coin_ledger WHERE id = $1', [chargeId]);
    assert.equal(linha.day, hoje);
  });

  it('cobrança de ontem não conta no saldo de hoje', async () => {
    const aluno = await alunoComNivel('pro');
    const ontem = new Date(dates.midnightInSaoPaulo(dates.todayISO()).getTime() - 3_600_000);
    await coins.charge(db, { user: aluno.ref, action: 'questions', cost: 50, refType: 'bank', refId: 'ontem', now: ontem });
    assert.equal((await coins.getWallet({ user: aluno.ref, now: ontem })).balance, 10);
    assert.equal((await coins.getWallet({ user: aluno.ref })).balance, 60);
  });

  // -------------------------------------------------------------------------
  // Quem não gasta moeda
  // -------------------------------------------------------------------------
  it('assinante de plano antigo é ilimitado até o fim do período que já tinha pago', async () => {
    const aluno = await ctx.registerStudent({ name: 'Assinante Antigo' });
    await assinar(aluno.user.id, planos.antigo, { legado: "now() + interval '30 days'" });
    const ref = { id: aluno.user.id, role: 'student' };

    const carteira = await coins.getWallet({ user: ref });
    assert.equal(carteira.unlimited, true);
    assert.equal(carteira.reason, 'legacy');
    assert.equal(carteira.balance, null);
    assert.equal(carteira.daily, null);

    const cobranca = await coins.charge(db, { user: ref, action: 'essay_correction', cost: 20, refType: 'essay', refId: 'x' });
    assert.equal(cobranca.chargeId, null);
    assert.equal(await cobrancasVivas(aluno.user.id), 0);

    // a mesma regra vale para assinatura cujo plano não foi reconhecido
    const semPlano = await ctx.registerStudent({ name: 'Assinante Sem Plano' });
    await assinar(semPlano.user.id, null, { legado: "now() + interval '10 days'" });
    const res = await semPlano.agent.get('/api/coins');
    assert.equal(res.status, 200);
    assert.equal(res.body.unlimited, true);
    assert.equal(res.body.reason, 'legacy');
  });

  it('depois do legado, a assinatura antiga renovada vale como Básico', async () => {
    const aluno = await ctx.registerStudent({ name: 'Antigo Renovado' });
    await assinar(aluno.user.id, planos.antigo, { legado: "now() - interval '1 day'" });
    const carteira = await coins.getWallet({ user: { id: aluno.user.id, role: 'student' } });
    assert.equal(carteira.unlimited, false);
    assert.equal(carteira.tier, 'basico');
    assert.equal(carteira.reason, 'plan_without_tier');
    assert.equal(carteira.balance, 30);

    // e quem nunca teve legado (assinou plano sem nível depois das moedas) também
    const novo = await ctx.registerStudent({ name: 'Plano Sem Nível' });
    await assinar(novo.user.id, planos.antigo);
    const dele = await coins.getWallet({ user: { id: novo.user.id, role: 'student' } });
    assert.equal(dele.reason, 'plan_without_tier');
    assert.equal(dele.tier, 'basico');
  });

  it('a equipe nunca gasta moeda', async () => {
    // só o id: o serviço busca o papel
    const carteira = await coins.getWallet({ user: { id: admin.user.id } });
    assert.equal(carteira.unlimited, true);
    assert.equal(carteira.reason, 'admin');
    const cobranca = await coins.charge(db, { user: { id: admin.user.id }, action: 'essay_theme', cost: 5 });
    assert.equal(cobranca.chargeId, null);
  });

  it('acesso aberto e cortesia são ilimitados; a cortesia não apaga o nível pago', async () => {
    const aberto = await ctx.registerStudent({ name: 'Acesso Aberto' });
    const res = await aberto.agent.get('/api/coins');
    assert.equal(res.status, 200);
    assert.equal(res.body.unlimited, true);
    assert.equal(res.body.reason, 'open');

    const cortesia = await ctx.registerStudent({ name: 'Cortesia' });
    await db.query(`UPDATE users SET access_override_until = now() + interval '30 days' WHERE id = $1`, [cortesia.user.id]);
    const daCortesia = await coins.getWallet({ user: { id: cortesia.user.id, role: 'student' } });
    assert.equal(daCortesia.unlimited, true);
    assert.equal(daCortesia.reason, 'override');

    const pagouPro = await alunoComNivel('pro');
    await db.query(`UPDATE users SET access_override_until = now() + interval '30 days' WHERE id = $1`, [pagouPro.user.id]);
    const doPro = await coins.getWallet({ user: pagouPro.ref });
    assert.equal(doPro.unlimited, false);
    assert.equal(doPro.tier, 'pro');
    assert.equal(doPro.reason, 'plan');
  });

  it('sem assinatura e com a cobrança ligada, não há moedas', async () => {
    await settings.setSetting('require_subscription', true);
    const aluno = await ctx.registerStudent({ name: 'Sem Assinatura' });
    const ref = { id: aluno.user.id, role: 'student' };

    const res = await aluno.agent.get('/api/coins');
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'payment_required');

    const carteira = await coins.getWallet({ user: ref });
    assert.equal(carteira.reason, 'none');
    assert.equal(carteira.unlimited, false);
    assert.equal(carteira.balance, 0);
    await assert.rejects(
      () => coins.charge(db, { user: ref, action: 'essay_theme', cost: 5 }),
      (err) => err.code === 'insufficient_coins' && err.details.daily === 0
    );
  });

  // -------------------------------------------------------------------------
  // Concessão e extrato
  // -------------------------------------------------------------------------
  it('as moedas dadas pelo suporte somam ao saldo de hoje e aparecem no extrato', async () => {
    const aluno = await alunoComNivel('basico');
    await coins.charge(db, { user: aluno.ref, action: 'essay_correction', cost: 20, refType: 'essay', refId: 'extrato' });
    const concessao = await coins.grant(db, { userId: aluno.user.id, amount: 15, adminId: admin.user.id, note: 'Compensação' });
    assert.equal(concessao.kind, 'grant');
    assert.equal(concessao.action, 'admin_grant');

    const carteira = await coins.getWallet({ user: aluno.ref });
    assert.equal(carteira.granted, 15);
    assert.equal(carteira.balance, 25); // 30 + 15 - 20

    // agora dá para uma cobrança que antes não caberia
    await coins.charge(db, { user: aluno.ref, action: 'essay_correction', cost: 20, refType: 'essay', refId: 'extrato-2' });
    assert.equal((await coins.getWallet({ user: aluno.ref })).balance, 5);

    await assert.rejects(() => coins.grant(db, { userId: aluno.user.id, amount: 0 }), (err) => err.status === 400);

    const extrato = await coins.ledger(aluno.user.id, { limit: 10 });
    assert.equal(extrato.length, 3);
    assert.equal(extrato[0].ref_id, 'extrato-2', 'o mais novo vem primeiro');
    const linhaConcessao = extrato.find((linha) => linha.kind === 'grant');
    assert.equal(linhaConcessao.amount, 15);
    assert.equal(linhaConcessao.created_by, admin.user.id);
    assert.equal(linhaConcessao.note, 'Compensação');
  });

  it('o custo do simulado depende do número de questões', async () => {
    assert.equal(await coins.simuladoCost(10), 10);
    assert.equal(await coins.simuladoCost(30), 10);
    assert.equal(await coins.simuladoCost(31), 30);
    assert.equal(await coins.simuladoCost(90), 30);
    assert.equal(coins.tierRank('basico'), 0);
    assert.equal(coins.tierRank('avancado'), 2);
    assert.equal(coins.tierRank(null), -1);
  });

  // -------------------------------------------------------------------------
  // Tutor: cota de tokens por nível
  // -------------------------------------------------------------------------
  describe('Cota do Tutor por nível', () => {
    async function gastar(userId, feature, tokens) {
      await ai.recordUsage({
        userId,
        feature,
        model: 'teste/modelo',
        usage: { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens },
      });
    }

    it('só o uso do Tutor conta, e esgotada a cota o Tutor responde 402', async () => {
      await settings.setSetting('tutor_tokens_basico', 1000);
      const aluno = await alunoComNivel('basico');
      const id = aluno.user.id;

      // redação e questões não entram na cota do Tutor: quem cobra é a moeda
      await gastar(id, 'essay', 5000);
      await gastar(id, 'questions', 5000);
      await ai.assertAvailable(id, 'tutor');

      await gastar(id, 'tutor', 1000);
      await assert.rejects(
        () => ai.assertAvailable(id, 'tutor'),
        (err) => {
          assert.equal(err.status, 402);
          assert.equal(err.code, 'tutor_quota_reached');
          assert.match(err.message, /cota do Tutor IA deste mês/);
          return true;
        }
      );
      await assert.rejects(
        () => ai.chat({ messages: [{ role: 'user', content: 'Oi' }], userId: id, feature: 'tutor' }),
        (err) => err.code === 'tutor_quota_reached'
      );
      // as outras ações seguem: o limite delas é a moeda
      await ai.assertAvailable(id, 'essay');

      const status = await ai.status(id);
      assert.equal(status.tier, 'basico');
      assert.equal(status.tutor_quota_reached, true);
      assert.equal(status.limit_reached, true);
      assert.equal(status.configured, true);

      const doFront = await aluno.agent.get('/api/tutor/status');
      assert.equal(doFront.status, 200);
      assert.equal(doFront.body.tutor_quota_reached, true);
      assert.equal(doFront.body.available, false);
      assert.equal(doFront.body.tier, 'basico');

      // o erro sai antes de abrir o stream, como resposta HTTP normal
      const conversa = await aluno.agent.post('/api/tutor/conversations', {});
      assert.equal(conversa.status, 201);
      const mensagem = await aluno.agent.post(`/api/tutor/conversations/${conversa.body.id}/messages`, { content: 'Me explica?' });
      assert.equal(mensagem.status, 402);
      assert.equal(mensagem.body.error.code, 'tutor_quota_reached');
    });

    it('a cota é a do nível: o mesmo gasto não barra o Pro', async () => {
      await settings.setSetting('tutor_tokens_basico', 1000);
      const pro = await alunoComNivel('pro'); // 3 milhões por padrão
      await gastar(pro.user.id, 'tutor', 1000);
      await ai.assertAvailable(pro.user.id, 'tutor');
      const status = await ai.status(pro.user.id);
      assert.equal(status.tier, 'pro');
      assert.equal(status.tutor_quota_reached, false);
      assert.equal(status.limit_reached, false);
    });

    it('o uso do mês passado não conta', async () => {
      await settings.setSetting('tutor_tokens_basico', 1000);
      const aluno = await alunoComNivel('basico');
      const inicioDoMes = dates.midnightInSaoPaulo(dates.startOfMonth(dates.todayISO()));
      await db.query(
        `INSERT INTO ai_usage (user_id, feature, model, total_tokens, created_at) VALUES ($1, 'tutor', 'teste', 5000, $2)`,
        [aluno.user.id, new Date(inicioDoMes.getTime() - 60_000)]
      );
      await ai.assertAvailable(aluno.user.id, 'tutor');
    });

    it('a cota geral por aluno não vale para quem tem nível', async () => {
      await settings.setSetting('ai_student_monthly_token_limit', 10);
      const aluno = await alunoComNivel('avancado');
      await gastar(aluno.user.id, 'essay', 5000);
      await ai.assertAvailable(aluno.user.id, 'essay');
      await ai.assertAvailable(aluno.user.id, 'tutor');
    });

    it('quem é ilimitado em moedas segue com a cota geral somando tudo', async () => {
      await settings.setSetting('ai_student_monthly_token_limit', 3000);
      const aberto = await ctx.registerStudent({ name: 'Aberto Gastador' });
      await gastar(aberto.user.id, 'essay', 5000);
      await assert.rejects(() => ai.assertAvailable(aberto.user.id, 'tutor'), /Limite mensal de uso da IA atingido/);
      await assert.rejects(() => ai.assertAvailable(aberto.user.id, 'essay'), /Limite mensal de uso da IA atingido/);
      const status = await ai.status(aberto.user.id);
      assert.equal(status.tier, null);
      assert.equal(status.tutor_quota_reached, false);
      assert.equal(status.limit_reached, true);
    });
  });
});
