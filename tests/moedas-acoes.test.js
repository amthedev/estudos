'use strict';

/**
 * Moedas nas ações que chamam a IA: correção de redação, tema de redação,
 * simulado, Pratique da aula e "elaborar questões" do banco.
 *
 *   NODE_ENV=test node --test --test-concurrency=1 tests/moedas-acoes.test.js
 *
 * O que não pode quebrar: cada ação cobra o custo da configuração; sem saldo a
 * recusa sai ANTES de a IA ser chamada (conferido pelo registro de uso da IA);
 * a falha da IA devolve a moeda — inclusive a da redação que falha depois do
 * 202, longe da requisição; dois cliques no mesmo objeto cobram uma vez só; a
 * redação presa por reinício devolve a moeda no boot e no reenvio; e quem não
 * gasta moeda (acesso aberto, plano antigo) continua sem nenhum lançamento.
 */
process.env.OPENROUTER_MOCK = '1';

const crypto = require('node:crypto');
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const coins = require('../server/services/coins');
const ai = require('../server/services/ai');
const settings = require('../server/services/settings');
const essayService = require('../server/services/essay');
const questionAi = require('../server/services/question-ai');
const simuladosService = require('../server/services/simulados');
const { CSRF_HEADER_VALUE } = require('../server/app');

/** Chaves mexidas pelos testes; voltam ao padrão depois de cada um. */
const CHAVES_MEXIDAS = [
  'coin_cost_essay_correction',
  'coin_cost_essay_theme',
  'coin_cost_practice',
  'coin_cost_questions',
  'coin_cost_simulado_short',
  'coin_cost_simulado_long',
  'coin_simulado_short_max_questions',
  'simulado_ai_questions_max',
];

const TEXTO_REDACAO = [
  'A persistência da violência contra a mulher no Brasil revela uma contradição entre o avanço das leis e a realidade',
  'cotidiana. Embora a Lei Maria da Penha represente um marco, os dados de feminicídio mostram que a proteção prevista',
  'no papel ainda não alcança todas as vítimas, sobretudo nas cidades pequenas, onde faltam delegacias especializadas.',
  'Nesse contexto, a raiz do problema está na cultura patriarcal que naturaliza o controle sobre o corpo feminino e na',
  'omissão do Estado em garantir a rede de acolhimento. Assim, cabe ao Ministério da Mulher, em parceria com os',
  'municípios, ampliar as casas de abrigo e as campanhas nas escolas, a fim de romper o ciclo de violência.',
].join(' ');

/** Cliente de IA que falha como o provedor fora do ar, opcionalmente depois de um atraso. */
function clienteQueFalha({ atrasoMs = 0 } = {}) {
  return {
    chat: {
      completions: {
        async create() {
          if (atrasoMs) await new Promise((resolve) => setTimeout(resolve, atrasoMs));
          throw Object.assign(new Error('503 upstream'), { status: 503 });
        },
      },
    },
  };
}

describe('Moedas nas ações de IA', () => {
  let ctx;
  let db;
  const planos = {};
  let sequencia = 0;
  let exam;
  let subject;
  let topicoVazio;

  // -------------------------------------------------------------------------
  // Cenário
  // -------------------------------------------------------------------------
  async function criarPlano(tier) {
    sequencia += 1;
    const row = await db.one(
      `INSERT INTO plans (slug, name, price_cents, currency, interval, interval_count, duration_months, tier, active, sort_order)
       VALUES ($1, $2, 4990, 'brl', 'month', 1, 1, $3, true, $4)
       RETURNING id`,
      [`plano-acoes-${sequencia}`, `Plano ${tier || 'antigo'} ${sequencia}`, tier, sequencia]
    );
    return row.id;
  }

  /** Aluno registrado pela API com assinatura vigente do plano pedido. */
  async function aluno(tier, { legado = null } = {}) {
    const registrado = await ctx.registerStudent({ name: `Aluno ${tier || 'antigo'}` });
    await db.query(
      `INSERT INTO subscriptions (user_id, plan_id, provider, provider_subscription_id, status, current_period_end, legacy_until)
       VALUES ($1, $2, 'asaas', $3, 'active', now() + interval '30 days', ${legado || 'NULL'})`,
      [registrado.user.id, planos[tier || 'antigo'], `sub_acoes_${registrado.user.id}`]
    );
    return { ...registrado, ref: { id: registrado.user.id, role: 'student' } };
  }

  async function saldo(estudante) {
    return (await coins.getWallet({ user: estudante.ref || { id: estudante.user.id, role: 'student' } })).balance;
  }

  /** Gasta o saldo inteiro do dia numa ação qualquer, para testar a recusa. */
  async function gastarTudo(estudante) {
    const tudo = await saldo(estudante);
    await coins.charge(db, {
      user: estudante.ref,
      action: 'teste',
      cost: tudo,
      refType: 'teste',
      refId: crypto.randomUUID(),
    });
    assert.equal(await saldo(estudante), 0);
  }

  async function lancamentos(userId, action) {
    return db.many(
      `SELECT id, amount, ref_type, ref_id, refunded_at, refund_reason
         FROM coin_ledger
        WHERE user_id = $1 AND action = $2 AND kind = 'debit'
        ORDER BY created_at, id`,
      [userId, action]
    );
  }

  async function usoDaIa(userId, feature) {
    const row = await db.one(`SELECT count(*)::int AS total FROM ai_usage WHERE user_id = $1 AND feature = $2`, [
      userId,
      feature,
    ]);
    return row.total;
  }

  async function novaRedacao(estudante) {
    const res = await estudante.agent.post('/api/essays', {
      exam_id: exam.id,
      theme_title: 'Os desafios para combater a violência contra a mulher no Brasil',
      content: TEXTO_REDACAO,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  async function esperar(condicao, { tentativas = 80, intervaloMs = 50 } = {}) {
    for (let i = 0; i < tentativas; i += 1) {
      if (await condicao()) return true;
      await new Promise((resolve) => setTimeout(resolve, intervaloMs));
    }
    return false;
  }

  async function questaoDoBanco({ topicId, difficulty, texto }) {
    const q = await db.one(
      `INSERT INTO questions (subject_id, topic_id, statement, difficulty, active)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [subject.id, topicId, texto, difficulty]
    );
    for (const [ordem, letra] of ['A', 'B', 'C', 'D', 'E'].entries()) {
      await db.query(
        `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [q.id, letra, `Alternativa ${letra}`, ordem === 0, ordem]
      );
    }
    return q.id;
  }

  /** Assunto novo com um subassunto e uma aula. */
  async function novaAula(nome) {
    sequencia += 1;
    const topic = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
      [subject.id, `assunto-aula-${sequencia}`, nome, 100 + sequencia]
    );
    await db.query(`INSERT INTO subtopics (topic_id, slug, name, sort_order) VALUES ($1, $2, $3, 0)`, [
      topic.id,
      `sub-aula-${sequencia}`,
      `Subassunto de ${nome}`,
    ]);
    const lesson = await db.one(
      `INSERT INTO lessons (subject_id, topic_id, slug, title, duration_min)
       VALUES ($1, $2, $3, $4, 15) RETURNING id`,
      [subject.id, topic.id, `aula-${sequencia}`, `Aula de ${nome}`]
    );
    return { topic, lesson };
  }

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    for (const tier of coins.TIERS) planos[tier] = await criarPlano(tier);
    planos.antigo = await criarPlano(null);

    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, sort_order)
       VALUES ('enem-moedas', 'Exame Nacional do Ensino Médio', 'ENEM', 'enem', 1) RETURNING id`
    );
    subject = await db.one(
      `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica-moedas', 'Matemática', 1) RETURNING id`
    );
    await db.query('INSERT INTO exam_subjects (exam_id, subject_id) VALUES ($1, $2)', [exam.id, subject.id]);
    // Três assuntos da prova com quatro questões cada: 12 no banco.
    for (const [index, nome] of ['Porcentagem', 'Funções', 'Geometria'].entries()) {
      const topic = await db.one(
        `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
        [subject.id, `assunto-prova-${index}`, nome, index]
      );
      await db.query('INSERT INTO exam_topics (exam_id, topic_id) VALUES ($1, $2)', [exam.id, topic.id]);
      await db.query(`INSERT INTO subtopics (topic_id, slug, name, sort_order) VALUES ($1, $2, $3, 0)`, [
        topic.id,
        `sub-prova-${index}`,
        `Subassunto de ${nome}`,
      ]);
      for (let i = 0; i < 4; i += 1) {
        await questaoDoBanco({ topicId: topic.id, difficulty: 2, texto: `Questão ${i + 1} de ${nome}, cadastrada pelo professor.` });
      }
    }
    // Assunto sem nenhuma questão, fora da prova.
    topicoVazio = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'assunto-vazio', 'Assunto vazio', 50) RETURNING id`,
      [subject.id]
    );
    await db.query(
      `INSERT INTO subtopics (topic_id, slug, name, sort_order) VALUES ($1, 'sub-vazio', 'Subassunto vazio', 0)`,
      [topicoVazio.id]
    );
  });

  afterEach(async () => {
    ai.setClientForTests(null);
    delete process.env.ESSAY_CORRECTION_GRACE_MS;
    for (const chave of CHAVES_MEXIDAS) await settings.setSetting(chave, null);
  });

  after(async () => {
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  // Correção de redação
  // -------------------------------------------------------------------------
  describe('Correção de redação', () => {
    it('cobra o custo da configuração, e a correção que dá certo mantém a cobrança', async () => {
      await settings.setSetting('coin_cost_essay_correction', 12);
      const estudante = await aluno('basico');
      const redacao = await novaRedacao(estudante);

      const res = await estudante.agent.post(`/api/essays/${redacao.id}/submit`, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, 'corrected');

      const cobrancas = await lancamentos(estudante.user.id, 'essay_correction');
      assert.equal(cobrancas.length, 1);
      assert.equal(cobrancas[0].amount, 12, 'o custo vem do painel, não do código');
      assert.equal(cobrancas[0].ref_type, 'essay');
      assert.equal(cobrancas[0].ref_id, redacao.id);
      assert.equal(cobrancas[0].refunded_at, null);
      assert.equal(await saldo(estudante), 18);
    });

    it('sem saldo responde 402 antes de chamar a IA, e a redação continua rascunho', async () => {
      const estudante = await aluno('basico');
      const redacao = await novaRedacao(estudante);
      await gastarTudo(estudante);

      const res = await estudante.agent.post(`/api/essays/${redacao.id}/submit`, {});
      assert.equal(res.status, 402, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'insufficient_coins');
      assert.match(res.body.error.message, /moedas de hoje acabaram/);
      assert.equal(res.body.error.details.cost, 20);
      assert.equal(res.body.error.details.balance, 0);
      assert.equal(res.body.error.details.daily, 30);
      assert.ok(res.body.error.details.resets_at);

      assert.equal(await usoDaIa(estudante.user.id, 'essay'), 0, 'a IA não pode ter sido chamada');
      const depois = await estudante.agent.get(`/api/essays/${redacao.id}`);
      assert.equal(depois.body.status, 'draft', 'sem cobrança, sem mudança de estado');
      assert.equal((await lancamentos(estudante.user.id, 'essay_correction')).length, 0);
    });

    it('IA fora do ar: 503, redação "failed" e a moeda volta; o reenvio cobra uma vez só', async () => {
      const estudante = await aluno('basico');
      const redacao = await novaRedacao(estudante);

      ai.setClientForTests(clienteQueFalha());
      const falha = await estudante.agent.post(`/api/essays/${redacao.id}/submit`, {});
      assert.equal(falha.status, 503, JSON.stringify(falha.body));
      assert.equal((await estudante.agent.get(`/api/essays/${redacao.id}`)).body.status, 'failed');

      let cobrancas = await lancamentos(estudante.user.id, 'essay_correction');
      assert.equal(cobrancas.length, 1);
      assert.ok(cobrancas[0].refunded_at, 'a falha devolve a moeda');
      assert.equal(cobrancas[0].refund_reason, 'falha na correção');
      assert.equal(await saldo(estudante), 30);

      ai.setClientForTests(null);
      const reenvio = await estudante.agent.post(`/api/essays/${redacao.id}/submit`, {});
      assert.equal(reenvio.status, 200, JSON.stringify(reenvio.body));
      assert.equal(reenvio.body.status, 'corrected');

      cobrancas = await lancamentos(estudante.user.id, 'essay_correction');
      assert.equal(cobrancas.length, 2);
      assert.equal(cobrancas.filter((linha) => !linha.refunded_at).length, 1);
      assert.equal(await saldo(estudante), 10);
    });

    it('cliques simultâneos na mesma redação cobram e corrigem uma vez só', async () => {
      const estudante = await aluno('avancado');
      const redacao = await novaRedacao(estudante);

      const envio = () => estudante.agent.post(`/api/essays/${redacao.id}/submit`, {});
      const respostas = await Promise.all([envio(), envio(), envio()]);
      const aceitas = respostas.filter((res) => res.status === 200 || res.status === 202);
      const recusadas = respostas.filter((res) => res.status === 409);
      assert.equal(aceitas.length, 1, JSON.stringify(respostas.map((res) => [res.status, res.body])));
      assert.equal(recusadas.length, 2);

      await esperar(async () => (await estudante.agent.get(`/api/essays/${redacao.id}`)).body.status === 'corrected');
      const cobrancas = await lancamentos(estudante.user.id, 'essay_correction');
      assert.equal(cobrancas.length, 1);
      assert.equal(await usoDaIa(estudante.user.id, 'essay'), 1);
      assert.equal(await saldo(estudante), 80);
    });

    it('a falha que chega depois do 202 também devolve a moeda', async () => {
      process.env.ESSAY_CORRECTION_GRACE_MS = '20';
      const estudante = await aluno('basico');
      const redacao = await novaRedacao(estudante);

      ai.setClientForTests(clienteQueFalha({ atrasoMs: 250 }));
      const res = await estudante.agent.post(`/api/essays/${redacao.id}/submit`, {});
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.correcting, true);
      assert.equal(await saldo(estudante), 10, 'enquanto corrige, a moeda está cobrada');

      // reenviar com a correção ainda rodando não cobra de novo
      const duplicado = await estudante.agent.post(`/api/essays/${redacao.id}/submit`, {});
      assert.equal(duplicado.status, 409);
      assert.equal((await lancamentos(estudante.user.id, 'essay_correction')).length, 1);

      const devolvida = await esperar(async () => {
        const [linha] = await lancamentos(estudante.user.id, 'essay_correction');
        return Boolean(linha.refunded_at);
      });
      assert.ok(devolvida, 'a moeda precisa voltar mesmo com a requisição já respondida');
      assert.equal((await estudante.agent.get(`/api/essays/${redacao.id}`)).body.status, 'failed');
      assert.equal(await saldo(estudante), 30);
    });

    it('erro fora da chamada à IA (ao gravar a nota) também marca "failed" e devolve a moeda', async () => {
      // Critérios com nota máxima acima do que a coluna comporta: a IA responde,
      // mas gravar a correção estoura — um erro que correctEssay lança fora do
      // próprio try, sem passar pelo UPDATE para 'failed' de lá.
      const outraProva = await db.one(
        `INSERT INTO exams (slug, name, short_name, track, sort_order)
         VALUES ('prova-nota-gigante', 'Prova com nota gigante', 'PNG', 'vestibular', 9) RETURNING id`
      );
      await db.query(
        `INSERT INTO essay_criteria_sets (exam_id, name, max_score, criteria)
         VALUES ($1, 'Critérios exagerados', 9999, $2::jsonb)`,
        [outraProva.id, JSON.stringify([{ key: 'tudo', name: 'Tudo', max: 50000 }])]
      );
      const estudante = await aluno('basico');
      const criada = await estudante.agent.post('/api/essays', {
        exam_id: outraProva.id,
        theme_title: 'Tema qualquer para a prova exagerada',
        content: TEXTO_REDACAO,
      });
      assert.equal(criada.status, 201, JSON.stringify(criada.body));

      const res = await estudante.agent.post(`/api/essays/${criada.body.id}/submit`, {});
      assert.equal(res.status, 503, JSON.stringify(res.body));
      const depois = await estudante.agent.get(`/api/essays/${criada.body.id}`);
      assert.equal(depois.body.status, 'failed', 'não pode ficar "em correção" para sempre');
      assert.ok(depois.body.error_message);
      const [cobranca] = await lancamentos(estudante.user.id, 'essay_correction');
      assert.ok(cobranca.refunded_at);
      assert.equal(await saldo(estudante), 30);
    });

    it('redação presa por reinício: o reenvio devolve a cobrança antiga e cobra uma vez', async () => {
      const estudante = await aluno('basico');
      const redacao = await novaRedacao(estudante);
      // o envio que o reinício interrompeu: cobrado e parado em "submitted"
      await coins.charge(db, {
        user: estudante.ref,
        action: 'essay_correction',
        cost: 20,
        refType: 'essay',
        refId: redacao.id,
      });
      await db.query(`UPDATE essays SET status = 'submitted', submitted_at = now() WHERE id = $1`, [redacao.id]);

      // dentro da janela da correção, ainda pode estar corrigindo: recusa sem cobrar
      const cedo = await estudante.agent.post(`/api/essays/${redacao.id}/submit`, {});
      assert.equal(cedo.status, 409);
      assert.equal((await lancamentos(estudante.user.id, 'essay_correction')).length, 1);

      await db.query(`UPDATE essays SET submitted_at = now() - interval '10 minutes' WHERE id = $1`, [redacao.id]);
      const res = await estudante.agent.post(`/api/essays/${redacao.id}/submit`, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, 'corrected');

      const cobrancas = await lancamentos(estudante.user.id, 'essay_correction');
      assert.equal(cobrancas.length, 2);
      assert.ok(cobrancas[0].refunded_at, 'a cobrança do envio interrompido volta');
      assert.equal(cobrancas[0].refund_reason, 'correção interrompida');
      assert.equal(cobrancas[1].refunded_at, null);
      assert.equal(await saldo(estudante), 10, 'no fim, uma correção, uma cobrança');
    });

    it('o boot destrava as redações presas e devolve a moeda de cada uma', async () => {
      const estudante = await aluno('pro');
      const redacao = await novaRedacao(estudante);
      await coins.charge(db, {
        user: estudante.ref,
        action: 'essay_correction',
        cost: 20,
        refType: 'essay',
        refId: redacao.id,
      });
      await db.query(`UPDATE essays SET status = 'submitted', submitted_at = now() WHERE id = $1`, [redacao.id]);
      assert.equal(await saldo(estudante), 40);

      const destravadas = await essayService.releaseInterruptedCorrections();
      assert.ok(destravadas >= 1);

      const depois = await estudante.agent.get(`/api/essays/${redacao.id}`);
      assert.equal(depois.body.status, 'failed');
      assert.match(depois.body.error_message, /reiniciou/);
      const [cobranca] = await lancamentos(estudante.user.id, 'essay_correction');
      assert.ok(cobranca.refunded_at);
      assert.equal(await saldo(estudante), 60);
    });

    it('acesso aberto e plano antigo corrigem sem nenhum lançamento', async () => {
      const aberto = await ctx.registerStudent({ name: 'Aluno Aberto da Redação' });
      const antigo = await aluno(null, { legado: "now() + interval '30 days'" });
      for (const estudante of [aberto, antigo]) {
        const redacao = await novaRedacao(estudante);
        const res = await estudante.agent.post(`/api/essays/${redacao.id}/submit`, {});
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const linhas = await db.many('SELECT id FROM coin_ledger WHERE user_id = $1', [estudante.user.id]);
        assert.equal(linhas.length, 0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Tema de redação por IA
  // -------------------------------------------------------------------------
  describe('Tema de redação gerado por IA', () => {
    it('cobra o custo, e a falha da IA devolve a moeda', async () => {
      const estudante = await aluno('basico');
      const res = await estudante.agent.post('/api/essays/themes/generate', { exam_id: exam.id });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.ok(res.body.title);

      let cobrancas = await lancamentos(estudante.user.id, 'essay_theme');
      assert.equal(cobrancas.length, 1);
      assert.equal(cobrancas[0].amount, 5);
      assert.equal(cobrancas[0].ref_type, 'essay_theme');
      assert.equal(await saldo(estudante), 25);

      ai.setClientForTests(clienteQueFalha());
      const falha = await estudante.agent.post('/api/essays/themes/generate', { exam_id: exam.id });
      assert.equal(falha.status, 503, JSON.stringify(falha.body));
      cobrancas = await lancamentos(estudante.user.id, 'essay_theme');
      assert.equal(cobrancas.length, 2);
      assert.ok(cobrancas[1].refunded_at);
      assert.equal(await saldo(estudante), 25);
    });

    it('sem saldo responde 402 sem chamar a IA', async () => {
      const estudante = await aluno('basico');
      await gastarTudo(estudante);
      const res = await estudante.agent.post('/api/essays/themes/generate', { exam_id: exam.id });
      assert.equal(res.status, 402, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'insufficient_coins');
      assert.equal(await usoDaIa(estudante.user.id, 'essay_theme'), 0);
    });
  });

  // -------------------------------------------------------------------------
  // Simulado
  // -------------------------------------------------------------------------
  describe('Simulado', () => {
    async function tentativasDe(userId) {
      return db.many('SELECT id FROM simulado_attempts WHERE user_id = $1', [userId]);
    }

    it('o custo sai do número de questões: curto até o limite, longo acima', async () => {
      await settings.setSetting('simulado_ai_questions_max', 0);
      const estudante = await aluno('avancado'); // 100 moedas

      const curto = await estudante.agent.post('/api/simulados/attempts', {
        type: 'topic',
        topic_id: (await db.one(`SELECT id FROM topics WHERE slug = 'assunto-prova-0'`)).id,
        question_count: 4,
      });
      assert.equal(curto.status, 201, JSON.stringify(curto.body));
      let cobrancas = await lancamentos(estudante.user.id, 'simulado');
      assert.equal(cobrancas.length, 1);
      assert.equal(cobrancas[0].amount, 10);
      assert.equal(cobrancas[0].ref_type, 'simulado_attempt');
      assert.equal(cobrancas[0].ref_id, curto.body.id, 'a cobrança aponta para a tentativa');

      // "mini" pedido com 60 questões é um simulado longo e paga como longo
      const miniGrande = await estudante.agent.post('/api/simulados/attempts', {
        type: 'exam',
        mode: 'mini',
        exam_id: exam.id,
        question_count: 60,
      });
      assert.equal(miniGrande.status, 201, JSON.stringify(miniGrande.body));
      assert.equal(miniGrande.body.config.requested_count, 60);

      const completo = await estudante.agent.post('/api/simulados/attempts', {
        type: 'exam',
        mode: 'completo',
        exam_id: exam.id,
      });
      assert.equal(completo.status, 201, JSON.stringify(completo.body));

      cobrancas = await lancamentos(estudante.user.id, 'simulado');
      assert.deepEqual(
        cobrancas.map((linha) => linha.amount),
        [10, 30, 30]
      );
      assert.equal(await saldo(estudante), 30);
    });

    it('o limite do curto e os preços vêm do painel', async () => {
      await settings.setSetting('simulado_ai_questions_max', 0);
      await settings.setSetting('coin_simulado_short_max_questions', 3);
      await settings.setSetting('coin_cost_simulado_long', 7);
      const estudante = await aluno('basico');
      const res = await estudante.agent.post('/api/simulados/attempts', {
        type: 'topic',
        topic_id: (await db.one(`SELECT id FROM topics WHERE slug = 'assunto-prova-1'`)).id,
        question_count: 4,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const [cobranca] = await lancamentos(estudante.user.id, 'simulado');
      assert.equal(cobranca.amount, 7);
    });

    it('sem saldo: 402, nenhuma tentativa criada e a IA não é chamada', async () => {
      await settings.setSetting('simulado_ai_questions_max', 10);
      const estudante = await aluno('basico');
      await gastarTudo(estudante);
      const res = await estudante.agent.post('/api/simulados/attempts', {
        type: 'topic',
        topic_id: topicoVazio.id,
        question_count: 5,
      });
      assert.equal(res.status, 402, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'insufficient_coins');
      assert.equal((await tentativasDe(estudante.user.id)).length, 0);
      assert.equal(await usoDaIa(estudante.user.id, 'questions'), 0);
    });

    it('a tentativa que não chega a ser criada devolve a moeda', async () => {
      const estudante = await aluno('basico');

      // banco vazio e complemento desligado: 409 sem questões
      await settings.setSetting('simulado_ai_questions_max', 0);
      const semQuestoes = await estudante.agent.post('/api/simulados/attempts', {
        type: 'topic',
        topic_id: topicoVazio.id,
        question_count: 5,
      });
      assert.equal(semQuestoes.status, 409, JSON.stringify(semQuestoes.body));

      // banco vazio e a IA fora do ar: nada criado de novo
      await settings.setSetting('simulado_ai_questions_max', 5);
      ai.setClientForTests(clienteQueFalha());
      const iaFora = await estudante.agent.post('/api/simulados/attempts', {
        type: 'topic',
        topic_id: topicoVazio.id,
        question_count: 5,
      });
      assert.equal(iaFora.status, 409, JSON.stringify(iaFora.body));

      const cobrancas = await lancamentos(estudante.user.id, 'simulado');
      assert.equal(cobrancas.length, 2);
      for (const linha of cobrancas) {
        assert.ok(linha.refunded_at, 'toda cobrança sem tentativa volta');
        assert.equal(linha.refund_reason, 'simulado não foi criado');
      }
      assert.equal((await tentativasDe(estudante.user.id)).length, 0);
      assert.equal(await saldo(estudante), 30);
    });

    it('novo pedido com o anterior ainda montando é recusado sem cobrar; montagem interrompida devolve', async () => {
      await settings.setSetting('simulado_ai_questions_max', 0);
      const estudante = await aluno('pro');
      // montagem em curso: cobrada, sem tentativa gravada ainda
      const { chargeId } = await coins.charge(db, {
        user: estudante.ref,
        action: 'simulado',
        cost: 30,
        refType: 'simulado_attempt',
        refId: crypto.randomUUID(),
      });
      const topico = await db.one(`SELECT id FROM topics WHERE slug = 'assunto-prova-2'`);
      const pedido = () =>
        estudante.agent.post('/api/simulados/attempts', { type: 'topic', topic_id: topico.id, question_count: 4 });

      const recusado = await pedido();
      assert.equal(recusado.status, 409, JSON.stringify(recusado.body));
      assert.equal(recusado.body.error.code, 'already_charged');
      assert.match(recusado.body.error.message, /sendo montado/);
      assert.equal((await lancamentos(estudante.user.id, 'simulado')).length, 1);

      // o reinício matou aquela montagem: passado o prazo, a moeda volta e o novo pedido segue
      await db.query(`UPDATE coin_ledger SET created_at = now() - interval '15 minutes' WHERE id = $1`, [chargeId]);
      const aceito = await pedido();
      assert.equal(aceito.status, 201, JSON.stringify(aceito.body));

      const cobrancas = await lancamentos(estudante.user.id, 'simulado');
      assert.equal(cobrancas.length, 2);
      const antiga = cobrancas.find((linha) => linha.id === chargeId);
      assert.ok(antiga.refunded_at);
      assert.equal(antiga.refund_reason, 'montagem interrompida');
      assert.equal(await saldo(estudante), 50, '60 do Pro menos o simulado curto');
    });

    it('a moeda da montagem interrompida volta mesmo quando o saldo não dá para o pedido novo', async () => {
      await settings.setSetting('simulado_ai_questions_max', 0);
      const estudante = await aluno('basico'); // 30 moedas
      const { chargeId } = await coins.charge(db, {
        user: estudante.ref,
        action: 'simulado',
        cost: 10,
        refType: 'simulado_attempt',
        refId: crypto.randomUUID(),
      });
      await db.query(`UPDATE coin_ledger SET created_at = now() - interval '15 minutes' WHERE id = $1`, [chargeId]);
      await coins.charge(db, { user: estudante.ref, action: 'teste', cost: 20, refType: 'teste', refId: crypto.randomUUID() });
      assert.equal(await saldo(estudante), 0);

      // o completo custa 30: nem com a moeda devolvida dá
      const res = await estudante.agent.post('/api/simulados/attempts', { type: 'exam', mode: 'completo', exam_id: exam.id });
      assert.equal(res.status, 402, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'insufficient_coins');

      const [interrompida] = await lancamentos(estudante.user.id, 'simulado');
      assert.equal(interrompida.id, chargeId);
      assert.ok(interrompida.refunded_at, 'a recusa não desfaz o estorno');
      assert.equal(await saldo(estudante), 10);
    });

    it('o boot devolve a moeda da montagem que o reinício interrompeu', async () => {
      // Sem isto, por dez minutos o aluno ouvia que o simulado "ainda está
      // sendo montado" — e ele nunca apareceria — e ficava sem as moedas do dia.
      await settings.setSetting('simulado_ai_questions_max', 0);
      const estudante = await aluno('basico'); // 30 moedas
      const topico = await db.one(`SELECT id FROM topics WHERE slug = 'assunto-prova-0'`);
      const pedido = () =>
        estudante.agent.post('/api/simulados/attempts', { type: 'topic', topic_id: topico.id, question_count: 4 });

      const montado = await pedido(); // curto: 10
      assert.equal(montado.status, 201, JSON.stringify(montado.body));
      // a montagem seguinte foi cobrada e o processo morreu antes de gravá-la
      const { chargeId } = await coins.charge(db, {
        user: estudante.ref,
        action: 'simulado',
        cost: 20,
        refType: 'simulado_attempt',
        refId: crypto.randomUUID(),
      });
      assert.equal(await saldo(estudante), 0);

      const devolvidas = await simuladosService.releaseInterruptedBuilds();
      assert.ok(devolvidas >= 1);

      const cobrancas = await lancamentos(estudante.user.id, 'simulado');
      const interrompida = cobrancas.find((linha) => linha.id === chargeId);
      const concluida = cobrancas.find((linha) => linha.ref_id === montado.body.id);
      assert.ok(interrompida.refunded_at);
      assert.equal(interrompida.refund_reason, 'montagem interrompida por reinício');
      assert.equal(concluida.refunded_at, null, 'simulado montado mantém a cobrança');
      assert.equal(await saldo(estudante), 20);

      // e o pedido seguinte não ouve mais que o anterior "ainda está sendo montado"
      const depois = await pedido();
      assert.equal(depois.status, 201, JSON.stringify(depois.body));
    });

    it('acesso aberto monta simulado sem nenhum lançamento', async () => {
      await settings.setSetting('simulado_ai_questions_max', 0);
      const aberto = await ctx.registerStudent({ name: 'Aluno Aberto do Simulado' });
      const res = await aberto.agent.post('/api/simulados/attempts', { type: 'exam', mode: 'completo', exam_id: exam.id });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const linhas = await db.many('SELECT id FROM coin_ledger WHERE user_id = $1', [aberto.user.id]);
      assert.equal(linhas.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Pratique da aula
  // -------------------------------------------------------------------------
  describe('Pratique da aula', () => {
    it('prática que sai inteira do banco não cobra; a que chama a IA cobra', async () => {
      const { topic, lesson } = await novaAula('Razão e proporção');
      for (let i = 0; i < 3; i += 1) {
        await questaoDoBanco({ topicId: topic.id, difficulty: 1, texto: `Questão fácil ${i + 1} de razão e proporção, do banco.` });
      }
      const estudante = await aluno('basico');

      const doBanco = await estudante.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 1 });
      assert.equal(doBanco.status, 200, JSON.stringify(doBanco.body));
      assert.equal(doBanco.body.from_bank, 3);
      assert.equal((await lancamentos(estudante.user.id, 'practice')).length, 0, 'sem IA, sem moeda');
      assert.equal(await usoDaIa(estudante.user.id, 'questions'), 0);

      const comIa = await estudante.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 3 });
      assert.equal(comIa.status, 200, JSON.stringify(comIa.body));
      assert.equal(comIa.body.generated, 3);
      const cobrancas = await lancamentos(estudante.user.id, 'practice');
      assert.equal(cobrancas.length, 1);
      assert.equal(cobrancas[0].amount, 2);
      assert.equal(cobrancas[0].refunded_at, null);
      assert.equal(await saldo(estudante), 28);
    });

    it('a IA falhando entrega o banco e devolve a moeda', async () => {
      const { topic, lesson } = await novaAula('Juros compostos');
      await questaoDoBanco({ topicId: topic.id, difficulty: 2, texto: 'Única questão média de juros compostos, do banco.' });
      const estudante = await aluno('basico');

      ai.setClientForTests(clienteQueFalha());
      const res = await estudante.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 2 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.questions.length, 1);
      assert.equal(res.body.generated, 0);

      const [cobranca] = await lancamentos(estudante.user.id, 'practice');
      assert.ok(cobranca.refunded_at, 'nada novo, nada cobrado');
      assert.equal(await saldo(estudante), 30);
    });

    it('a IA do Pratique tem o prazo de quem espera na tela e para quando a aba fecha', async () => {
      // A borda corta perto dos 100 segundos. Com o prazo longo, a IA
      // respondia depois do corte: a moeda ficava cobrada e a prática não
      // chegava a ninguém.
      const { lesson } = await novaAula('Logaritmos');
      const estudante = await aluno('basico');
      let opcoes = null;
      let cancelada = false;
      ai.setClientForTests({
        chat: {
          completions: {
            async create(params, options = {}) {
              opcoes = options;
              await new Promise((resolve, reject) => {
                const desistir = () => {
                  cancelada = true;
                  reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }));
                };
                if (options.signal) options.signal.addEventListener('abort', desistir, { once: true });
                // sem o cancelamento, a chamada ficaria pendurada: aqui ela desiste sozinha
                setTimeout(() => reject(Object.assign(new Error('504 upstream'), { status: 504 })), 3000);
              });
            },
          },
        },
      });

      const aba = new AbortController();
      const pedido = fetch(`${ctx.baseUrl}/api/lessons/${lesson.id}/practice`, {
        method: 'POST',
        signal: aba.signal,
        headers: {
          cookie: estudante.cookie,
          'content-type': 'application/json',
          'x-requested-with': CSRF_HEADER_VALUE,
        },
        body: JSON.stringify({ difficulty: 2 }),
      }).catch(() => null);

      assert.ok(await esperar(() => opcoes !== null), 'a IA foi chamada');
      assert.equal(opcoes.timeout, questionAi.TIMEOUT_INTERATIVO_MS, 'prazo de tela, que cabe antes do corte da borda');
      aba.abort();
      await pedido;

      assert.ok(await esperar(() => cancelada, { tentativas: 40 }), 'fechar a aba cancela a chamada à IA');
      assert.ok(
        await esperar(async () => {
          const [cobranca] = await lancamentos(estudante.user.id, 'practice');
          return Boolean(cobranca && cobranca.refunded_at);
        }),
        'sem nada entregue, a moeda volta'
      );
    });

    it('sem saldo entrega só o que o banco tem, com aviso, sem chamar a IA', async () => {
      const { topic, lesson } = await novaAula('Estatística');
      await questaoDoBanco({ topicId: topic.id, difficulty: 2, texto: 'Única questão média de estatística, do banco.' });
      const estudante = await aluno('basico');
      await gastarTudo(estudante);

      const res = await estudante.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 2 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.questions.length, 1);
      assert.equal(res.body.generated, 0);
      assert.match(res.body.notice, /moedas de hoje acabaram/);
      assert.equal(res.body.notice_code, 'insufficient_coins');
      assert.equal(await usoDaIa(estudante.user.id, 'questions'), 0);
      assert.equal((await lancamentos(estudante.user.id, 'practice')).length, 0);
    });

    it('sem saldo e sem nada no banco, a recusa é a das moedas', async () => {
      const { lesson } = await novaAula('Probabilidade');
      const estudante = await aluno('basico');
      await gastarTudo(estudante);

      const res = await estudante.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 2 });
      assert.equal(res.status, 402, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'insufficient_coins');
      assert.equal(await usoDaIa(estudante.user.id, 'questions'), 0);
    });

    it('com a cota diária de questões cheia, nem cobra', async () => {
      const { lesson } = await novaAula('Análise combinatória');
      const estudante = await aluno('basico');
      for (let i = 0; i < questionAi.GERACOES_POR_DIA; i += 1) {
        await db.query(`INSERT INTO ai_usage (user_id, feature, status, total_tokens) VALUES ($1, 'questions', 'ok', 100)`, [
          estudante.user.id,
        ]);
      }
      const res = await estudante.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 2 });
      assert.equal(res.status, 503, JSON.stringify(res.body));
      assert.match(res.body.error.message, /hoje/);
      assert.equal((await lancamentos(estudante.user.id, 'practice')).length, 0);
    });

    it('plano antigo pratica com IA sem gastar moeda', async () => {
      const { lesson } = await novaAula('Geometria espacial');
      const antigo = await aluno(null, { legado: "now() + interval '30 days'" });
      const res = await antigo.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 2 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.generated, 3);
      const linhas = await db.many('SELECT id FROM coin_ledger WHERE user_id = $1', [antigo.user.id]);
      assert.equal(linhas.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Elaborar questões no banco
  // -------------------------------------------------------------------------
  describe('Elaborar questões no banco', () => {
    it('cobra o custo da configuração e entrega as questões', async () => {
      await settings.setSetting('coin_cost_questions', 4);
      const estudante = await aluno('basico');
      const res = await estudante.agent.post('/api/questions/generate', { topic_id: topicoVazio.id, difficulty: 3 });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.ok(res.body.generated >= 1);
      const cobrancas = await lancamentos(estudante.user.id, 'questions');
      assert.equal(cobrancas.length, 1);
      assert.equal(cobrancas[0].amount, 4);
      assert.equal(cobrancas[0].refunded_at, null);
      assert.equal(await saldo(estudante), 26);
    });

    it('com a cota diária antiga cheia, responde 429 sem cobrar', async () => {
      const estudante = await aluno('basico');
      for (let i = 0; i < questionAi.GERACOES_POR_DIA; i += 1) {
        await db.query(`INSERT INTO ai_usage (user_id, feature, status, total_tokens) VALUES ($1, 'questions', 'ok', 100)`, [
          estudante.user.id,
        ]);
      }
      const res = await estudante.agent.post('/api/questions/generate', { topic_id: topicoVazio.id });
      assert.equal(res.status, 429, JSON.stringify(res.body));
      assert.equal((await lancamentos(estudante.user.id, 'questions')).length, 0);
      assert.equal(await saldo(estudante), 30);
    });

    it('a IA não entregando nada devolve a moeda', async () => {
      const estudante = await aluno('basico');
      ai.setClientForTests(clienteQueFalha());
      const res = await estudante.agent.post('/api/questions/generate', { topic_id: topicoVazio.id });
      assert.equal(res.status, 503, JSON.stringify(res.body));
      const [cobranca] = await lancamentos(estudante.user.id, 'questions');
      assert.ok(cobranca.refunded_at);
      assert.equal(await saldo(estudante), 30);
    });

    it('sem saldo responde 402 sem chamar a IA', async () => {
      const estudante = await aluno('basico');
      await gastarTudo(estudante);
      const res = await estudante.agent.post('/api/questions/generate', { topic_id: topicoVazio.id });
      assert.equal(res.status, 402, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'insufficient_coins');
      assert.equal(await usoDaIa(estudante.user.id, 'questions'), 0);
    });
  });
});
