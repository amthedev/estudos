'use strict';

/**
 * Tutor IA e Redação IA: conversa com contexto, resposta em SSE, correção síncrona com os
 * critérios da prova certa, registro de uso, limite mensal e isolamento entre alunos.
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/ai.test.js
 *
 * Usa o cliente de simulação de services/ai.js (OPENROUTER_MOCK=1): nenhuma chamada de rede.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const settings = require('../server/services/settings');
const essayService = require('../server/services/essay');

const ENEM_CRITERIA = [
  { key: 'c1', name: 'Competência 1 — Domínio da modalidade escrita formal', max: 200, description: 'Ortografia, concordância e registro formal.', guidance: '0 a 200 em faixas de 40.' },
  { key: 'c2', name: 'Competência 2 — Compreensão da proposta', max: 200, description: 'Tema e tipo dissertativo-argumentativo.', guidance: '0 a 200 em faixas de 40.' },
  { key: 'c3', name: 'Competência 3 — Seleção e organização de informações', max: 200, description: 'Projeto de texto e argumentação.', guidance: '0 a 200 em faixas de 40.' },
  { key: 'c4', name: 'Competência 4 — Mecanismos linguísticos de argumentação', max: 200, description: 'Coesão e conectivos.', guidance: '0 a 200 em faixas de 40.' },
  { key: 'c5', name: 'Competência 5 — Proposta de intervenção', max: 200, description: 'Proposta de intervenção com agente, ação, meio, finalidade e detalhamento.', guidance: '0 a 200 em faixas de 40.' },
];

const BARRO_CRITERIA = [
  { key: 'tema_genero', name: 'Adequação ao tema e ao gênero', max: 25, description: 'Trata do tema e mantém o gênero dissertativo-argumentativo.', guidance: '0 a 25.' },
  { key: 'argumentacao', name: 'Consistência da argumentação', max: 25, description: 'Argumentos sustentados e progressão lógica.', guidance: '0 a 25.' },
  { key: 'coesao', name: 'Coesão e coerência', max: 25, description: 'Articulação entre parágrafos e frases.', guidance: '0 a 25.' },
  { key: 'norma', name: 'Norma-padrão', max: 25, description: 'Ortografia, pontuação e concordância.', guidance: '0 a 25.' },
];

const ESSAY_TEXT = [
  'A ampliação do acesso à internet no Brasil transformou a maneira como os cidadãos se informam e participam',
  'do debate público. Se por um lado as plataformas digitais aproximaram pessoas e ampliaram vozes antes',
  'silenciadas, por outro criaram um ambiente em que a desinformação circula com velocidade maior do que a',
  'checagem responsável dos fatos. Trata-se, portanto, de um desafio que exige resposta coordenada do poder',
  'público, das empresas de tecnologia e da própria escola.',
  '',
  'Em primeiro lugar, a educação midiática ainda ocupa espaço reduzido no currículo escolar. Sem repertório',
  'para avaliar fontes, o estudante reproduz conteúdos falsos acreditando estar bem informado. Além disso, a',
  'lógica dos algoritmos privilegia mensagens de forte apelo emocional, o que aprofunda bolhas e reduz o',
  'contato com opiniões divergentes.',
  '',
  'Portanto, é necessário que o Ministério da Educação inclua a educação midiática como componente',
  'obrigatório do ensino médio, por meio de formação continuada de professores e de material didático',
  'próprio, a fim de formar leitores capazes de distinguir informação de manipulação.',
].join('\n');

/** Lê um corpo text/event-stream e devolve { deltas, text, done, error, events }. */
function parseSse(raw) {
  const blocks = String(raw || '').replace(/\r\n/g, '\n').split('\n\n');
  const events = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const sep = line.indexOf(':');
      const field = sep === -1 ? line : line.slice(0, sep);
      let value = sep === -1 ? '' : line.slice(sep + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (!dataLines.length) continue;
    let data = dataLines.join('\n');
    try {
      data = JSON.parse(data);
    } catch {
      /* mantém como texto */
    }
    events.push({ event, data });
  }
  const deltas = events.filter((e) => e.event === 'delta').map((e) => e.data.text);
  return {
    events,
    deltas,
    text: deltas.join(''),
    done: (events.find((e) => e.event === 'done') || {}).data || null,
    error: (events.find((e) => e.event === 'error') || {}).data || null,
  };
}

/** Provas, critérios, conteúdo e temas usados nos testes. */
async function seedContent(db) {
  const enem = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board, has_essay, essay_max_score)
     VALUES ('enem-ia', 'ENEM — Exame Nacional do Ensino Médio', 'ENEM', 'enem', 'INEP', true, 1000) RETURNING id`
  );
  const barro = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board, has_essay, essay_max_score)
     VALUES ('barro-branco-ia', 'Academia do Barro Branco / Cadete PM-SP', 'Barro Branco', 'barro_branco', 'VUNESP', true, 100) RETURNING id`
  );
  const semCriterios = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board, has_essay)
     VALUES ('mackenzie-ia', 'Universidade Presbiteriana Mackenzie', 'Mackenzie', 'vestibular', 'Mackenzie', true) RETURNING id`
  );

  await db.query(
    `INSERT INTO essay_criteria_sets (exam_id, name, max_score, genre, criteria, instructions, min_lines, max_lines)
     VALUES ($1, 'Matriz de referência do ENEM — 5 competências', 1000, 'Texto dissertativo-argumentativo em prosa',
             $2::jsonb, 'Cinco competências de 0 a 200, em faixas de 40. Proposta de intervenção obrigatória.', 8, 30)`,
    [enem.id, JSON.stringify(ENEM_CRITERIA)]
  );
  await db.query(
    `INSERT INTO essay_criteria_sets (exam_id, name, max_score, genre, criteria, instructions, min_lines, max_lines)
     VALUES ($1, 'Redação VUNESP — Aluno-Oficial PM-SP', 100, 'Texto dissertativo-argumentativo em norma-padrão',
             $2::jsonb, 'Escala de 0 a 100. Não se aplicam as competências do ENEM.', 20, 30)`,
    [barro.id, JSON.stringify(BARRO_CRITERIA)]
  );

  const subject = await db.one(
    `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica', 'Matemática', 1) RETURNING id`
  );
  const topic = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 1) RETURNING id`,
    [subject.id]
  );
  const lesson = await db.one(
    `INSERT INTO lessons (subject_id, topic_id, slug, title, summary, duration_min)
     VALUES ($1, $2, 'fator-de-aumento', 'Fator de aumento e de desconto',
             'O fator multiplicativo permite calcular acréscimos e descontos em uma única operação.', 18)
     RETURNING id, title`,
    [subject.id, topic.id]
  );
  const question = await db.one(
    `INSERT INTO questions (subject_id, topic_id, statement, resolution, explanation, difficulty, year, board)
     VALUES ($1, $2, 'Um tênis de R$ 250,00 recebe desconto de 12%. Qual o valor à vista?',
             'Multiplique 250 por 0,88.', 'O fator de desconto é 1 - 0,12 = 0,88.', 1, 2024, 'INEP')
     RETURNING id`,
    [subject.id, topic.id]
  );
  for (const [index, letter] of ['A', 'B', 'C', 'D', 'E'].entries()) {
    await db.query(
      `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order) VALUES ($1, $2, $3, $4, $5)`,
      [question.id, letter, `Alternativa ${letter}`, letter === 'B', index + 1]
    );
  }

  const theme = await db.one(
    `INSERT INTO essay_themes (exam_id, title, prompt_text, support_texts, source, year)
     VALUES ($1, 'Desinformação e educação midiática no Brasil',
             'Redija um texto dissertativo-argumentativo sobre o tema.',
             '**Texto I**\n\nA circulação de conteúdos falsos cresceu com as redes sociais.',
             'Equipe Foco Elite', 2026)
     RETURNING id, title`,
    [enem.id]
  );

  return { enem, barro, semCriterios, subject, topic, lesson, question, theme };
}

describe('IA: Tutor e Redação', () => {
  let ctx;
  let content;
  let alice;
  let bob;

  before(async () => {
    ctx = await createTestContext();
    content = await seedContent(ctx.db);
    alice = await ctx.registerStudent({ name: 'Alice Teste' });
    bob = await ctx.registerStudent({ name: 'Bob Teste' });
    await ctx.db.query(
      `UPDATE student_profiles SET exam_id = $1, level = 'intermediario', onboarding_completed = true WHERE user_id = $2`,
      [content.enem.id, alice.user.id]
    );
    await ctx.db.query(`UPDATE student_profiles SET exam_id = $1 WHERE user_id = $2`, [content.enem.id, bob.user.id]);
  });

  after(async () => {
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  describe('segurança', () => {
    it('sem login → 401 nas rotas de tutor e redação', async () => {
      for (const path of ['/api/tutor/status', '/api/tutor/conversations', '/api/essays', '/api/essays/stats']) {
        const res = await ctx.request('GET', path);
        assert.equal(res.status, 401, path);
        assert.equal(res.body.error.code, 'unauthorized');
      }
    });

    it('com assinatura obrigatória e sem assinatura → 402 nas conversas e nas redações', async () => {
      await settings.setSetting('require_subscription', true);
      try {
        const conversas = await alice.agent.get('/api/tutor/conversations');
        assert.equal(conversas.status, 402);
        assert.equal(conversas.body.error.code, 'payment_required');
        const redacoes = await alice.agent.get('/api/essays');
        assert.equal(redacoes.status, 402);
        // /status continua acessível: o front usa para saber se mostra o Tutor
        const status = await alice.agent.get('/api/tutor/status');
        assert.equal(status.status, 200);
      } finally {
        await settings.setSetting('require_subscription', null);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('Tutor IA', () => {
    let conversation;

    it('GET /api/tutor/status → disponível com a simulação ligada', async () => {
      const res = await alice.agent.get('/api/tutor/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.available, true);
    });

    it('cria conversa com contexto de aula (resolve matéria, assunto e título)', async () => {
      const res = await alice.agent.post('/api/tutor/conversations', { lesson_id: content.lesson.id });
      assert.equal(res.status, 201);
      conversation = res.body;
      assert.equal(conversation.lesson_id, content.lesson.id);
      assert.equal(conversation.subject_id, content.subject.id);
      assert.equal(conversation.topic_id, content.topic.id);
      assert.equal(conversation.exam_id, content.enem.id);
      assert.equal(conversation.title, `Dúvida sobre a aula "${content.lesson.title}"`);
      assert.equal(conversation.subject_name, 'Matemática');
      assert.deepEqual(conversation.messages, []);
    });

    it('cria conversa com contexto de questão e de assunto', async () => {
      const daQuestao = await alice.agent.post('/api/tutor/conversations', { question_id: content.question.id });
      assert.equal(daQuestao.status, 201);
      assert.equal(daQuestao.body.question_id, content.question.id);
      assert.equal(daQuestao.body.title, 'Dúvida sobre uma questão de Porcentagem');

      const doAssunto = await alice.agent.post('/api/tutor/conversations', { topic_id: content.topic.id });
      assert.equal(doAssunto.status, 201);
      assert.equal(doAssunto.body.title, 'Dúvida sobre Porcentagem');
      assert.equal(doAssunto.body.subject_id, content.subject.id);

      await alice.agent.del(`/api/tutor/conversations/${daQuestao.body.id}`);
      await alice.agent.del(`/api/tutor/conversations/${doAssunto.body.id}`);
    });

    it('referência inexistente → 404', async () => {
      const res = await alice.agent.post('/api/tutor/conversations', {
        lesson_id: '11111111-1111-4111-8111-111111111111',
      });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'not_found');
    });

    it('responde em SSE e persiste a mensagem do aluno e a do tutor', async () => {
      const res = await alice.agent.post(`/api/tutor/conversations/${conversation.id}/messages`, {
        content: 'Não entendi como usar o fator de desconto. Pode explicar passo a passo?',
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

      const sse = parseSse(res.text);
      assert.ok(sse.deltas.length > 1, 'a resposta deve chegar em vários eventos delta');
      assert.equal(sse.error, null);
      assert.ok(sse.done, 'deve haver um evento done');
      assert.ok(sse.done.message_id, 'o done deve trazer o id da mensagem gravada');
      assert.ok(sse.done.usage && sse.done.usage.total_tokens > 0);
      assert.ok(sse.text.length > 50);

      const detalhe = await alice.agent.get(`/api/tutor/conversations/${conversation.id}`);
      assert.equal(detalhe.status, 200);
      assert.equal(detalhe.body.messages.length, 2);
      assert.equal(detalhe.body.messages[0].role, 'user');
      assert.equal(detalhe.body.messages[1].role, 'assistant');
      assert.equal(detalhe.body.messages[1].content, sse.text.trim());
      // conversa com contexto mantém o título do contexto
      assert.equal(detalhe.body.title, `Dúvida sobre a aula "${content.lesson.title}"`);
    });

    it('conversa sem contexto ganha título a partir da primeira pergunta', async () => {
      const criada = await alice.agent.post('/api/tutor/conversations', {});
      assert.equal(criada.status, 201);
      assert.equal(criada.body.title, 'Nova conversa');

      const res = await alice.agent.post(`/api/tutor/conversations/${criada.body.id}/messages`, {
        content: 'Como calculo a área de um trapézio? Preciso para a prova.',
      });
      assert.equal(res.status, 200);
      const sse = parseSse(res.text);
      assert.equal(sse.done.title, 'Como calculo a área de um trapézio');

      const detalhe = await alice.agent.get(`/api/tutor/conversations/${criada.body.id}`);
      assert.equal(detalhe.body.title, 'Como calculo a área de um trapézio');
    });

    it('mensagem vazia → 400 validation_error', async () => {
      const res = await alice.agent.post(`/api/tutor/conversations/${conversation.id}/messages`, { content: '   ' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_error');
    });

    it('registra o uso da IA em ai_usage', async () => {
      const row = await ctx.db.one(
        `SELECT count(*)::int AS total, coalesce(sum(total_tokens), 0)::bigint AS tokens
           FROM ai_usage WHERE user_id = $1 AND feature = 'tutor' AND status = 'ok'`,
        [alice.user.id]
      );
      assert.ok(row.total >= 2, 'cada resposta do tutor gera uma linha em ai_usage');
      assert.ok(Number(row.tokens) > 0);
    });

    it('lista as conversas do aluno com prévia da última mensagem', async () => {
      const res = await alice.agent.get('/api/tutor/conversations');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      const atual = res.body.find((item) => item.id === conversation.id);
      assert.ok(atual);
      assert.equal(atual.message_count, 2);
      assert.ok(atual.last_message && atual.last_message.length > 0);
    });

    it('limite mensal de tokens atingido → 503 ai_unavailable', async () => {
      await settings.setSetting('openrouter_monthly_token_limit', 1);
      try {
        const res = await alice.agent.post(`/api/tutor/conversations/${conversation.id}/messages`, {
          content: 'Consegue revisar comigo o conteúdo de porcentagem?',
        });
        assert.equal(res.status, 503);
        assert.equal(res.body.error.code, 'ai_unavailable');
      } finally {
        await settings.setSetting('openrouter_monthly_token_limit', null);
      }
    });

    it('aluno não lê, não escreve nem apaga a conversa de outro aluno', async () => {
      const leitura = await bob.agent.get(`/api/tutor/conversations/${conversation.id}`);
      assert.equal(leitura.status, 404);

      const escrita = await bob.agent.post(`/api/tutor/conversations/${conversation.id}/messages`, {
        content: 'Deixa eu ver essa conversa.',
      });
      assert.equal(escrita.status, 404);

      const remocao = await bob.agent.del(`/api/tutor/conversations/${conversation.id}`);
      assert.equal(remocao.status, 404);

      const lista = await bob.agent.get('/api/tutor/conversations');
      assert.equal(lista.body.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  describe('Redação IA', () => {
    let enemEssayId;

    it('GET /api/essays/criteria devolve os critérios da prova pedida', async () => {
      const doEnem = await alice.agent.get('/api/essays/criteria');
      assert.equal(doEnem.status, 200);
      assert.equal(doEnem.body.generic, false);
      assert.equal(doEnem.body.max_score, 1000);
      assert.deepEqual(doEnem.body.criteria.map((c) => c.key), ['c1', 'c2', 'c3', 'c4', 'c5']);
      assert.equal(doEnem.body.requires_intervention, true);

      const doBarro = await alice.agent.get(`/api/essays/criteria?exam_id=${content.barro.id}`);
      assert.equal(doBarro.status, 200);
      assert.equal(doBarro.body.max_score, 100);
      assert.deepEqual(doBarro.body.criteria.map((c) => c.key), ['tema_genero', 'argumentacao', 'coesao', 'norma']);
      assert.equal(doBarro.body.requires_intervention, false);

      const semCriterios = await alice.agent.get(`/api/essays/criteria?exam_id=${content.semCriterios.id}`);
      assert.equal(semCriterios.status, 200);
      assert.equal(semCriterios.body.generic, true, 'prova sem critérios cadastrados usa o conjunto genérico');
      assert.equal(semCriterios.body.max_score, essayService.GENERIC_MAX_SCORE);
    });

    it('lista os temas da prova e gera um tema novo com IA', async () => {
      const lista = await alice.agent.get('/api/essays/themes');
      assert.equal(lista.status, 200);
      assert.ok(lista.body.some((theme) => theme.id === content.theme.id));

      const gerado = await alice.agent.post('/api/essays/themes/generate', { exam_id: content.enem.id });
      assert.equal(gerado.status, 201);
      assert.equal(gerado.body.generated_by_ai, true);
      assert.equal(gerado.body.exam_id, content.enem.id);
      assert.ok(gerado.body.title && gerado.body.title.length > 10);
      assert.ok(gerado.body.prompt_text && gerado.body.support_texts);

      const usage = await ctx.db.one(
        `SELECT count(*)::int AS total FROM ai_usage WHERE feature = 'essay_theme' AND user_id = $1`,
        [alice.user.id]
      );
      assert.equal(usage.total, 1);
    });

    it('cria rascunho com contagem de palavras e o atualiza', async () => {
      const res = await alice.agent.post('/api/essays', {
        exam_id: content.enem.id,
        theme_id: content.theme.id,
        content: 'Primeiro parágrafo do rascunho.',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.status, 'draft');
      assert.equal(res.body.theme_title, content.theme.title);
      assert.equal(res.body.word_count, 4);
      enemEssayId = res.body.id;

      const atualizado = await alice.agent.put(`/api/essays/${enemEssayId}`, { content: ESSAY_TEXT });
      assert.equal(atualizado.status, 200);
      assert.equal(atualizado.body.word_count, essayService.countWords(ESSAY_TEXT));
      assert.ok(atualizado.body.word_count > 100);
    });

    it('recusa redação acima do limite de caracteres', async () => {
      const res = await alice.agent.post('/api/essays', {
        exam_id: content.enem.id,
        theme_title: 'Tema livre para teste',
        content: 'a'.repeat(6001),
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_error');
    });

    it('sem tema informado → 400', async () => {
      const res = await alice.agent.post('/api/essays', { exam_id: content.enem.id, content: 'Texto sem tema.' });
      assert.equal(res.status, 400);
    });

    it('corrige a redação do ENEM com as 5 competências e nota dentro do máximo', async () => {
      const res = await alice.agent.post(`/api/essays/${enemEssayId}/submit`, {});
      assert.equal(res.status, 200);
      const essay = res.body;

      assert.equal(essay.status, 'corrected');
      assert.equal(essay.correcting, false, 'correção rápida volta pronta, sem ficar "em correção"');
      assert.equal(essay.max_score, 1000);
      assert.ok(essay.corrected_at, 'corrected_at deve ser gravado');
      assert.ok(essay.model, 'o modelo usado deve ser gravado');
      assert.ok(essay.score > 0 && essay.score <= essay.max_score, `nota ${essay.score} fora do intervalo`);

      const correction = essay.correction;
      assert.deepEqual(correction.criteria.map((c) => c.key), ['c1', 'c2', 'c3', 'c4', 'c5']);
      let soma = 0;
      for (const criterio of correction.criteria) {
        assert.equal(criterio.max, 200);
        assert.ok(criterio.score >= 0 && criterio.score <= criterio.max, `${criterio.key}: ${criterio.score} > ${criterio.max}`);
        assert.ok(criterio.comment && criterio.comment.length > 0);
        soma += criterio.score;
      }
      assert.equal(Math.round(soma * 100) / 100, essay.score, 'a nota final é a soma dos critérios');
      assert.equal(correction.generic_criteria, false);
      assert.ok(correction.summary && correction.summary.length > 0);
      assert.ok(Array.isArray(correction.strengths) && correction.strengths.length > 0);
      assert.ok(Array.isArray(correction.grammar_errors));
      assert.ok(correction.intervention_proposal, 'o ENEM exige análise da proposta de intervenção');
      assert.equal(essay.criteria_set.max_score, 1000);

      const usage = await ctx.db.one(
        `SELECT count(*)::int AS total FROM ai_usage WHERE feature = 'essay' AND user_id = $1 AND status = 'ok'`,
        [alice.user.id]
      );
      assert.equal(usage.total, 1);
    });

    it('a mesma redação no Barro Branco usa os critérios da VUNESP, não os do ENEM', async () => {
      const criada = await alice.agent.post('/api/essays', {
        exam_id: content.barro.id,
        theme_title: 'Segurança pública e confiança nas instituições',
        content: ESSAY_TEXT,
      });
      assert.equal(criada.status, 201);
      assert.equal(criada.body.exam_id, content.barro.id);

      const res = await alice.agent.post(`/api/essays/${criada.body.id}/submit`, {});
      assert.equal(res.status, 200);
      const essay = res.body;

      assert.equal(essay.status, 'corrected');
      assert.equal(essay.max_score, 100);
      assert.ok(essay.score <= 100, `nota ${essay.score} acima do máximo da prova`);

      const keys = essay.correction.criteria.map((c) => c.key);
      assert.deepEqual(keys, ['tema_genero', 'argumentacao', 'coesao', 'norma']);
      assert.ok(!keys.includes('c1'), 'as competências do ENEM não podem aparecer em outra prova');
      for (const criterio of essay.correction.criteria) {
        assert.equal(criterio.max, 25);
        assert.ok(criterio.score <= 25);
      }
      assert.equal(essay.correction.intervention_proposal, null, 'Barro Branco não exige proposta de intervenção');
    });

    it('prova sem critérios cadastrados corrige na escala genérica de 0 a 10 e sinaliza', async () => {
      const criada = await alice.agent.post('/api/essays', {
        exam_id: content.semCriterios.id,
        theme_title: 'Mobilidade urbana nas grandes cidades',
        content: ESSAY_TEXT,
      });
      assert.equal(criada.status, 201);

      const res = await alice.agent.post(`/api/essays/${criada.body.id}/submit`, {});
      assert.equal(res.status, 200);
      assert.equal(res.body.max_score, essayService.GENERIC_MAX_SCORE);
      assert.ok(res.body.score <= essayService.GENERIC_MAX_SCORE);
      assert.equal(res.body.correction.generic_criteria, true);
      assert.equal(res.body.criteria_set.generic, true);
    });

    it('redação corrigida não pode ser editada, reenviada nem apagada', async () => {
      const edicao = await alice.agent.put(`/api/essays/${enemEssayId}`, { content: 'Outro texto.' });
      assert.equal(edicao.status, 409);
      assert.equal(edicao.body.error.code, 'conflict');

      const reenvio = await alice.agent.post(`/api/essays/${enemEssayId}/submit`, {});
      assert.equal(reenvio.status, 409);

      const remocao = await alice.agent.del(`/api/essays/${enemEssayId}`);
      assert.equal(remocao.status, 409);
    });

    it('apaga rascunho', async () => {
      const criada = await alice.agent.post('/api/essays', {
        exam_id: content.enem.id,
        theme_title: 'Rascunho descartável',
        content: 'Texto curto.',
      });
      const remocao = await alice.agent.del(`/api/essays/${criada.body.id}`);
      assert.equal(remocao.status, 204);
      const busca = await alice.agent.get(`/api/essays/${criada.body.id}`);
      assert.equal(busca.status, 404);
    });

    it('GET /api/essays/stats devolve contagem, média, melhor nota e evolução', async () => {
      const res = await alice.agent.get('/api/essays/stats');
      assert.equal(res.status, 200);
      assert.equal(res.body.count, 3);
      assert.ok(res.body.avg > 0);
      assert.ok(res.body.best >= res.body.avg);
      assert.equal(res.body.evolution.length, 3);
      for (const ponto of res.body.evolution) {
        assert.match(ponto.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(ponto.max > 0);
        assert.ok(ponto.pct >= 0 && ponto.pct <= 100);
      }

      const vazio = await bob.agent.get('/api/essays/stats');
      assert.equal(vazio.body.count, 0);
      assert.equal(vazio.body.avg, null);
      assert.deepEqual(vazio.body.evolution, []);
    });

    it('falha da IA marca a redação como failed e responde 503', async () => {
      const criada = await alice.agent.post('/api/essays', {
        exam_id: content.enem.id,
        theme_title: 'Tema para testar indisponibilidade',
        content: ESSAY_TEXT,
      });
      await settings.setSetting('openrouter_monthly_token_limit', 1);
      try {
        const res = await alice.agent.post(`/api/essays/${criada.body.id}/submit`, {});
        assert.equal(res.status, 503);
        assert.equal(res.body.error.code, 'ai_unavailable');
      } finally {
        await settings.setSetting('openrouter_monthly_token_limit', null);
      }

      const depois = await alice.agent.get(`/api/essays/${criada.body.id}`);
      assert.equal(depois.body.status, 'failed');
      assert.ok(depois.body.error_message);

      // depois que a IA volta, o aluno consegue reenviar a mesma redação
      const reenvio = await alice.agent.post(`/api/essays/${criada.body.id}/submit`, {});
      assert.equal(reenvio.status, 200);
      assert.equal(reenvio.body.status, 'corrected');
    });

    it('aluno não lê nem altera a redação de outro aluno', async () => {
      const leitura = await bob.agent.get(`/api/essays/${enemEssayId}`);
      assert.equal(leitura.status, 404);

      const envio = await bob.agent.post(`/api/essays/${enemEssayId}/submit`, {});
      assert.equal(envio.status, 404);

      const edicao = await bob.agent.put(`/api/essays/${enemEssayId}`, { content: 'Trocando o texto.' });
      assert.equal(edicao.status, 404);

      const remocao = await bob.agent.del(`/api/essays/${enemEssayId}`);
      assert.equal(remocao.status, 404);

      const lista = await bob.agent.get('/api/essays');
      assert.deepEqual(lista.body, []);
    });

    it('conversa do tutor sobre uma redação de outro aluno → 404', async () => {
      const res = await bob.agent.post('/api/tutor/conversations', { essay_id: enemEssayId });
      assert.equal(res.status, 404);

      const propria = await alice.agent.post('/api/tutor/conversations', { essay_id: enemEssayId });
      assert.equal(propria.status, 201);
      assert.equal(propria.body.essay_id, enemEssayId);
      assert.match(propria.body.title, /^Dúvida sobre a redação "/);
    });
  });
});
