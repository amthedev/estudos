'use strict';

/**
 * Aulas com vários assuntos: o modelo (lesson_topics), a identificação dos
 * assuntos pelo título e as rotas do painel que gravam os assuntos da aula.
 *
 *   NODE_ENV=test node --test tests/lesson-topics.test.js
 *
 * Regras que não podem quebrar: o título que só usa nomes do catálogo não
 * gasta IA; a IA só escolhe assunto que existe; assunto novo não duplica
 * ("Porcentagem" nunca vira "porcentagem-2"); lessons.topic_id é sempre o
 * primeiro assunto da aula; mudar os assuntos põe as questões da aula na fila.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestContext } = require('./helpers');
const ai = require('../server/services/ai');
const lessonTopics = require('../server/services/lesson-topics');

const MIGRATION = path.join(__dirname, '../server/db/migrations/223_assuntos_da_aula.sql');

describe('Assuntos da aula', () => {
  let ctx;
  let db;
  let admin;
  let student;
  let exam;
  let mat;
  let fis;
  const t = {};
  const st = {};
  let counter = 0;

  async function topic(subjectId, slug, name, subtopics = []) {
    counter += 1;
    const row = await db.one(
      'INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id, slug, name',
      [subjectId, slug, name, counter]
    );
    for (const [index, sub] of subtopics.entries()) {
      const subRow = await db.one(
        'INSERT INTO subtopics (topic_id, slug, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
        [row.id, sub.slug, sub.name, index + 1]
      );
      st[sub.slug] = subRow.id;
    }
    return row;
  }

  async function lessonRow({ title, topicId, subtopicId = null, slug }) {
    counter += 1;
    return db.one(
      `INSERT INTO lessons (subject_id, topic_id, subtopic_id, slug, title, duration_min)
       VALUES ($1, $2, $3, $4, $5, 20) RETURNING id`,
      [mat.id, topicId, subtopicId, slug || `aula-${counter}`, title]
    );
  }

  async function topicsOf(lessonId) {
    return db.many(
      'SELECT position, topic_id, subtopic_id, label, source FROM lesson_topics WHERE lesson_id = $1 ORDER BY position',
      [lessonId]
    );
  }

  async function aiCalls() {
    return (await db.one('SELECT count(*)::int AS n FROM ai_usage')).n;
  }

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, board) VALUES ('enem-lt', 'ENEM', 'ENEM', 'enem', 'INEP') RETURNING id`
    );
    mat = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica-lt', 'Matemática', 1) RETURNING id`);
    fis = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('fisica-lt', 'Física', 2) RETURNING id`);
    // os mesmos nomes do conteúdo programático real (seed/data/topics.js)
    t.razao = await topic(mat.id, 'razao-proporcao', 'Razão e proporção', [
      { slug: 'razao-entre-grandezas', name: 'Razão entre grandezas' },
    ]);
    t.porcentagem = await topic(mat.id, 'porcentagem', 'Porcentagem', [
      { slug: 'porcentagem-de-uma-quantidade', name: 'Porcentagem de uma quantidade' },
      { slug: 'fator-de-aumento-e-de-desconto', name: 'Fator de aumento e de desconto' },
    ]);
    t.regra = await topic(mat.id, 'regra-de-tres', 'Regra de três simples e composta', [
      { slug: 'regra-de-tres-simples-direta', name: 'Regra de três simples direta' },
      { slug: 'regra-de-tres-composta', name: 'Regra de três composta' },
    ]);
    t.afim = await topic(mat.id, 'funcao-afim', 'Função afim (1º grau)');
    t.quadratica = await topic(mat.id, 'funcao-quadratica', 'Função quadrática (2º grau)');
    t.cinematica = await topic(fis.id, 'cinematica', 'Cinemática');
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluna Assuntos' });
  });

  after(async () => {
    ai.setClientForTests(null);
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  // modelo
  // -------------------------------------------------------------------------
  describe('migração', () => {
    it('aula que já existia ganha o assunto dela como posição 1 (backfill) sem repetir', async () => {
      const lesson = await lessonRow({ title: 'Porcentagem antiga', topicId: t.porcentagem.id, subtopicId: st['fator-de-aumento-e-de-desconto'] });
      // simula a aula de antes da migration: sem nenhuma linha em lesson_topics
      await db.query('DELETE FROM lesson_topics WHERE lesson_id = $1', [lesson.id]);
      assert.equal((await topicsOf(lesson.id)).length, 0);

      const sql = fs.readFileSync(MIGRATION, 'utf8');
      await db.pool.query(sql);
      await db.pool.query(sql); // rodar de novo não duplica nem quebra

      const rows = await topicsOf(lesson.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].position, 1);
      assert.equal(rows[0].topic_id, t.porcentagem.id);
      assert.equal(rows[0].subtopic_id, st['fator-de-aumento-e-de-desconto']);
      assert.equal(rows[0].source, 'legado');

      const status = await db.one('SELECT questions_status, questions_error, questions_updated_at FROM lessons WHERE id = $1', [lesson.id]);
      assert.equal(status.questions_status, 'none', 'o acervo antigo não entra na fila de geração sozinho');
      assert.equal(status.questions_error, null);
      await assert.rejects(
        db.query(`UPDATE lessons SET questions_status = 'qualquer' WHERE id = $1`, [lesson.id]),
        /check/i
      );
    });

    it('aula gravada por qualquer caminho tem a posição 1 igual ao assunto principal', async () => {
      const lesson = await lessonRow({ title: 'Aula pelo seed', topicId: t.razao.id });
      let rows = await topicsOf(lesson.id);
      assert.deepEqual(rows.map((r) => [r.position, r.topic_id, r.source]), [[1, t.razao.id, 'legado']]);

      // o principal muda e a posição 1 acompanha; o novo principal sai das secundárias
      await db.query(`INSERT INTO lesson_topics (lesson_id, position, topic_id, source) VALUES ($1, 2, $2, 'manual')`, [
        lesson.id,
        t.regra.id,
      ]);
      await db.query('UPDATE lessons SET topic_id = $2 WHERE id = $1', [lesson.id, t.regra.id]);
      rows = await topicsOf(lesson.id);
      assert.deepEqual(rows.map((r) => [r.position, r.topic_id]), [[1, t.regra.id]]);
    });

    it('excluir um assunto secundário não apaga a aula', async () => {
      const temporario = await topic(mat.id, 'tema-temporario', 'Tema temporário');
      const lesson = await lessonRow({ title: 'Aula com dois assuntos', topicId: t.porcentagem.id });
      await db.query(`INSERT INTO lesson_topics (lesson_id, position, topic_id, source) VALUES ($1, 2, $2, 'manual')`, [
        lesson.id,
        temporario.id,
      ]);
      await db.query('DELETE FROM topics WHERE id = $1', [temporario.id]);
      assert.ok(await db.one('SELECT 1 FROM lessons WHERE id = $1', [lesson.id]), 'a aula continua');
      const rows = await topicsOf(lesson.id);
      assert.deepEqual(rows.map((r) => r.topic_id), [t.porcentagem.id]);
    });

    it('excluir um subassunto não esbarra no assunto repetido da mesma aula', async () => {
      const sub = await db.one(
        `INSERT INTO subtopics (topic_id, slug, name) VALUES ($1, 'sub-temporario', 'Subassunto temporário') RETURNING id`,
        [t.porcentagem.id]
      );
      const lesson = await lessonRow({ title: 'Porcentagem e um recorte dela', topicId: t.porcentagem.id });
      await db.query(
        `INSERT INTO lesson_topics (lesson_id, position, topic_id, subtopic_id, source) VALUES ($1, 2, $2, $3, 'manual')`,
        [lesson.id, t.porcentagem.id, sub.id]
      );
      await db.query('DELETE FROM subtopics WHERE id = $1', [sub.id]);
      const rows = await topicsOf(lesson.id);
      assert.deepEqual(rows.map((r) => [r.position, r.topic_id, r.subtopic_id]), [[1, t.porcentagem.id, null]]);
    });
  });

  // -------------------------------------------------------------------------
  // identificação
  // -------------------------------------------------------------------------
  describe('identify', () => {
    it('casa com o catálogo sem chamar a IA e ignora o prefixo do vídeo', async () => {
      const antes = await aiCalls();
      const [tres, afim, quadratica] = await lessonTopics.identify({
        subjectId: mat.id,
        titles: [
          'Aula 05 — Razão e Proporção, Regra de Três e Porcentagem',
          '01 - Funções de 1º grau',
          'Função Quadrática — parte 2',
        ],
      });
      assert.equal(await aiCalls(), antes, 'nenhuma chamada de IA');

      assert.equal(tres.via, 'catalogo');
      assert.deepEqual(tres.topics.map((x) => x.topic_id), [t.razao.id, t.regra.id, t.porcentagem.id]);
      assert.deepEqual(tres.topics.map((x) => x.label), ['Razão e Proporção', 'Regra de Três', 'Porcentagem']);
      assert.deepEqual(tres.topics.map((x) => x.topic_name), ['Razão e proporção', 'Regra de três simples e composta', 'Porcentagem']);
      assert.ok(tres.topics.every((x) => x.subtopic_id === null && x.new_topic_name === null));

      assert.deepEqual(afim.topics.map((x) => x.topic_id), [t.afim.id], '"1º grau" é a função afim');
      assert.deepEqual(quadratica.topics.map((x) => x.topic_id), [t.quadratica.id]);
    });

    it('o exemplo do cliente: "Funções de 1º grau, Funções de 2º grau e Gráficos" são três assuntos', async () => {
      const [aula] = await lessonTopics.identify({
        subjectId: mat.id,
        titles: ['Aula 05 — Funções de 1º grau, Funções de 2º grau e Gráficos'],
      });
      assert.deepEqual(aula.topics.map((x) => x.label), ['Funções de 1º grau', 'Funções de 2º grau', 'Gráficos']);
      assert.equal(aula.topics[0].topic_id, t.afim.id);
      assert.equal(aula.topics[1].topic_id, t.quadratica.id);
      // "Gráficos" não tem par no catálogo do teste: vai para a IA e volta como assunto (existente ou novo)
      assert.ok(aula.topics[2].topic_id || aula.topics[2].new_topic_name, 'o terceiro assunto não pode sumir');
    });

    it('subassunto só com o nome exato do trecho', async () => {
      const [exato] = await lessonTopics.identify({ subjectId: mat.id, titles: ['Fator de aumento e de desconto'] });
      assert.equal(exato.topics[0].topic_id, t.porcentagem.id);
      assert.equal(exato.topics[0].subtopic_id, st['fator-de-aumento-e-de-desconto']);
      assert.equal(exato.topics.length, 1, '" e " dentro de um nome do catálogo não separa');
    });

    it('título sem assunto fica vazio e não gasta IA', async () => {
      const antes = await aiCalls();
      const result = await lessonTopics.identify({ subjectId: mat.id, titles: ['Aula 08', '03 - Parte 2'] });
      assert.equal(await aiCalls(), antes);
      assert.deepEqual(result.map((r) => [r.via, r.topics.length]), [['nenhum', 0], ['nenhum', 0]]);
    });

    it('trecho sem par vai para a IA uma vez só e volta como assunto novo, sem gravar nada', async () => {
      const antes = await aiCalls();
      const topicos = (await db.one('SELECT count(*)::int AS n FROM topics')).n;
      const [misto, novo, repetido] = await lessonTopics.identify({
        subjectId: mat.id,
        titles: ['Aula 07 — Porcentagem e Juros compostos', 'Aula 08 — Juros compostos', 'Aula 09 — Juros compostos'],
      });
      assert.equal(await aiCalls(), antes + 1, 'uma chamada para todos os títulos (e título repetido vai uma vez)');
      assert.equal((await db.one('SELECT count(*)::int AS n FROM topics')).n, topicos, 'identificar não grava');

      assert.equal(misto.via, 'ia');
      assert.equal(misto.topics[0].topic_id, t.porcentagem.id);
      assert.equal(misto.topics[1].topic_id, null);
      assert.equal(misto.topics[1].new_topic_name, 'Juros compostos');
      assert.equal(novo.topics[0].new_topic_name, 'Juros compostos');
      assert.deepEqual(repetido.topics, novo.topics);
    });

    it('findOrCreateTopic cria uma vez e reaproveita por nome, sem "-2"', async () => {
      const criado = await lessonTopics.findOrCreateTopic(db, mat.id, 'Juros compostos', { examIds: [exam.id] });
      assert.equal(criado.created, true);
      assert.equal(criado.slug, 'juros-compostos');
      assert.ok(
        await db.one('SELECT 1 FROM exam_topics WHERE exam_id = $1 AND topic_id = $2', [exam.id, criado.id]),
        'o assunto novo entra nas provas da aula'
      );

      for (const nome of ['Juros compostos', '  juros   compostos ', 'Juro composto', 'JUROS COMPOSTOS.']) {
        const again = await lessonTopics.findOrCreateTopic(db, mat.id, nome);
        assert.equal(again.id, criado.id, nome);
        assert.equal(again.created, false);
      }
      const existente = await lessonTopics.findOrCreateTopic(db, mat.id, 'porcentagem');
      assert.equal(existente.id, t.porcentagem.id);

      const slugs = await db.many(`SELECT slug FROM topics WHERE subject_id = $1 AND (slug LIKE 'juros-compostos%' OR slug LIKE '%-2')`, [mat.id]);
      assert.deepEqual(slugs.map((r) => r.slug), ['juros-compostos']);

      const log = await db.one(`SELECT data FROM audit_logs WHERE action = 'content.topic.create' AND entity_id = $1`, [criado.id]);
      assert.equal(log.data.origem, 'ia');

      // agora existe: o mesmo título casa sem IA
      const antes = await aiCalls();
      const [depois] = await lessonTopics.identify({ subjectId: mat.id, titles: ['Aula 08 — Juros compostos'] });
      assert.equal(await aiCalls(), antes);
      assert.equal(depois.via, 'catalogo');
      assert.equal(depois.topics[0].topic_id, criado.id);
    });

    it('a IA só escolhe o que existe no catálogo', async () => {
      ai.setClientForTests({
        chat: {
          completions: {
            async create() {
              const data = {
                lessons: [
                  {
                    item: 1,
                    topics: [
                      { label: 'Inventado', topic_slug: 'assunto-que-nao-existe', subtopic_slug: null, new_topic: null },
                      { label: 'Regra', topic_slug: 'errado', subtopic_slug: 'regra-de-tres-composta', new_topic: null },
                      { label: 'Porcentagem', topic_slug: null, subtopic_slug: null, new_topic: 'porcentagem' },
                      { label: 'Cinemática', topic_slug: 'cinematica', subtopic_slug: null, new_topic: null },
                    ],
                  },
                ],
              };
              return { model: 'teste', choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }], usage: null };
            },
          },
        },
      });
      try {
        const [r] = await lessonTopics.identify({ subjectId: mat.id, titles: ['Tema misterioso'] });
        assert.equal(r.via, 'ia');
        assert.deepEqual(
          r.topics.map((x) => [x.topic_id, x.subtopic_id, x.new_topic_name]),
          [
            [t.regra.id, st['regra-de-tres-composta'], null],
            [t.porcentagem.id, null, null],
          ],
          'slug inventado cai, subassunto certo corrige o assunto, "novo" que já existe vira o existente, outra matéria não entra'
        );
      } finally {
        ai.setClientForTests(null);
      }
    });

    it('IA fora do ar: fica o que casou sem ela', async () => {
      ai.setClientForTests({
        chat: {
          completions: {
            async create() {
              const err = new Error('chave inválida');
              err.status = 401;
              throw err;
            },
          },
        },
      });
      try {
        const [r] = await lessonTopics.identify({ subjectId: mat.id, titles: ['Porcentagem e Matrizes'] });
        assert.equal(r.via, 'parcial');
        assert.deepEqual(r.topics.map((x) => x.topic_id), [t.porcentagem.id]);
        assert.ok(r.error);
      } finally {
        ai.setClientForTests(null);
      }
    });
  });

  // -------------------------------------------------------------------------
  // rotas do painel
  // -------------------------------------------------------------------------
  describe('rotas', () => {
    it('analyze-titles devolve a proposta sem gravar e é só da equipe', async () => {
      const negado = await student.agent.post('/api/admin/lessons/analyze-titles', { subject_id: mat.id, titles: ['Porcentagem'] });
      assert.ok([401, 403].includes(negado.status));

      const topicos = (await db.one('SELECT count(*)::int AS n FROM topics')).n;
      const res = await admin.agent.post('/api/admin/lessons/analyze-titles', {
        subject_id: mat.id,
        titles: ['Aula 05 — Razão e Proporção, Regra de Três e Porcentagem', 'Aula 06 — Porcentagem e Logaritmos', 'Aula 07'],
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 3);
      assert.equal(res.body.items[0].topics.length, 3);
      assert.equal(res.body.items[1].topics[1].new_topic_name, 'Logaritmos');
      assert.deepEqual(res.body.items[2].topics, []);
      assert.equal((await db.one('SELECT count(*)::int AS n FROM topics')).n, topicos, 'nada gravado');

      const semMateria = await admin.agent.post('/api/admin/lessons/analyze-titles', {
        subject_id: '00000000-0000-4000-8000-000000000000',
        titles: ['Porcentagem'],
      });
      assert.equal(semMateria.status, 400);
    });

    it('aula individual com dois assuntos: ordem, principal e fila das questões', async () => {
      const res = await admin.agent.post('/api/admin/lessons', {
        title: 'Razão, proporção e porcentagem no dia a dia',
        subject_id: mat.id,
        topics: [{ topic_id: t.razao.id, label: 'Razão' }, { topic_id: t.porcentagem.id, subtopic_id: st['porcentagem-de-uma-quantidade'] }],
        exam_ids: [exam.id],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.topic_id, t.razao.id, 'o principal é o primeiro');
      assert.equal(res.body.questions_status, 'pending');
      assert.deepEqual(
        res.body.topics.map((x) => [x.position, x.topic_id, x.subtopic_id, x.source]),
        [
          [1, t.razao.id, null, 'manual'],
          [2, t.porcentagem.id, st['porcentagem-de-uma-quantidade'], 'manual'],
        ]
      );
      assert.equal(res.body.topics[0].label, 'Razão');
      assert.equal(res.body.topics[1].topic_name, 'Porcentagem');
      const cobertos = await db.many('SELECT topic_id FROM exam_topics WHERE exam_id = $1', [exam.id]);
      for (const id of [t.razao.id, t.porcentagem.id]) assert.ok(cobertos.some((r) => r.topic_id === id));

      const detalhe = await admin.agent.get(`/api/admin/lessons/${res.body.id}`);
      assert.equal(detalhe.body.topics.length, 2);

      // a lista do painel acha a aula pelo assunto secundário
      const lista = await admin.agent.get(`/api/admin/lessons?topic_id=${t.porcentagem.id}`);
      assert.ok(lista.body.items.some((item) => item.id === res.body.id));
    });

    it('recusa assunto de outra matéria, quarto assunto e subassunto de outro assunto', async () => {
      const outraMateria = await admin.agent.post('/api/admin/lessons', {
        title: 'Aula misturada',
        subject_id: mat.id,
        topics: [{ topic_id: t.porcentagem.id }, { topic_id: t.cinematica.id }],
      });
      assert.equal(outraMateria.status, 400);

      const quatro = await admin.agent.post('/api/admin/lessons', {
        title: 'Aula com quatro',
        subject_id: mat.id,
        topics: [t.razao, t.porcentagem, t.regra, t.afim].map((x) => ({ topic_id: x.id })),
      });
      assert.equal(quatro.status, 400);

      const sub = await admin.agent.post('/api/admin/lessons', {
        title: 'Subassunto trocado',
        subject_id: mat.id,
        topics: [{ topic_id: t.razao.id, subtopic_id: st['regra-de-tres-composta'] }],
      });
      assert.equal(sub.status, 400);

      const novos = (await db.one(`SELECT count(*)::int AS n FROM topics WHERE name = 'Não deveria existir'`)).n;
      const meio = await admin.agent.post('/api/admin/lessons', {
        title: 'Validação antes de criar',
        subject_id: mat.id,
        topics: [{ new_topic_name: 'Não deveria existir' }, { topic_id: t.cinematica.id }],
      });
      assert.equal(meio.status, 400);
      assert.equal((await db.one(`SELECT count(*)::int AS n FROM topics WHERE name = 'Não deveria existir'`)).n, novos);
    });

    it('aula individual sem assunto: o servidor lê o título', async () => {
      const res = await admin.agent.post('/api/admin/lessons', {
        title: 'Aula 10 — Regra de Três e Porcentagem',
        subject_id: mat.id,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.deepEqual(res.body.topics.map((x) => [x.topic_id, x.source]), [[t.regra.id, 'ia'], [t.porcentagem.id, 'ia']]);
      assert.equal(res.body.topic_id, t.regra.id);

      const semAssunto = await admin.agent.post('/api/admin/lessons', { title: 'Aula 11', subject_id: mat.id });
      assert.equal(semAssunto.status, 400);
      assert.match(semAssunto.body.error.message, /assunto/i);
    });

    it('editar: mudar os assuntos volta a aula para a fila; o resto não', async () => {
      const criada = await admin.agent.post('/api/admin/lessons', {
        title: 'Aula para editar',
        subject_id: mat.id,
        topics: [{ topic_id: t.porcentagem.id }, { topic_id: t.razao.id }],
        exam_ids: [exam.id],
      });
      const id = criada.body.id;
      const pronta = async () => db.query(`UPDATE lessons SET questions_status = 'ready' WHERE id = $1`, [id]);
      const status = async () => (await db.one('SELECT questions_status FROM lessons WHERE id = $1', [id])).questions_status;

      await pronta();
      let res = await admin.agent.put(`/api/admin/lessons/${id}`, { title: 'Aula editada' });
      assert.equal(res.status, 200);
      assert.equal(await status(), 'ready', 'trocar o título não regenera nada');

      res = await admin.agent.put(`/api/admin/lessons/${id}`, { topics: [{ topic_id: t.porcentagem.id }, { topic_id: t.razao.id }] });
      assert.equal(res.status, 200);
      assert.equal(await status(), 'ready', 'os mesmos assuntos na mesma ordem não mudam nada');

      res = await admin.agent.put(`/api/admin/lessons/${id}`, { topics: [{ topic_id: t.razao.id }, { topic_id: t.porcentagem.id }] });
      assert.equal(res.status, 200);
      assert.equal(await status(), 'pending', 'outra ordem muda a distribuição das questões');
      assert.equal(res.body.topic_id, t.razao.id);

      // formato antigo: troca só o principal e mantém o secundário
      await pronta();
      res = await admin.agent.put(`/api/admin/lessons/${id}`, { topic_id: t.regra.id });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.topics.map((x) => x.topic_id), [t.regra.id, t.porcentagem.id]);
      assert.equal(res.body.topic_id, t.regra.id);
      assert.equal(await status(), 'pending');

      // assunto novo pela edição entra nas provas da aula
      res = await admin.agent.put(`/api/admin/lessons/${id}`, {
        topics: [{ topic_id: t.regra.id }, { new_topic_name: 'Escalas e mapas' }],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const novo = res.body.topics[1];
      assert.equal(novo.topic_name, 'Escalas e mapas');
      assert.ok(await db.one('SELECT 1 FROM exam_topics WHERE exam_id = $1 AND topic_id = $2', [exam.id, novo.topic_id]));
    });

    it('reidentificar pelo título grava os assuntos das aulas antigas', async () => {
      const antiga = await lessonRow({ title: 'Razão e Proporção e Porcentagem', topicId: t.porcentagem.id });
      const vaga = await lessonRow({ title: 'Aula 12', topicId: t.razao.id });

      const negado = await student.agent.post('/api/admin/lessons/reidentify', { ids: [antiga.id] });
      assert.ok([401, 403].includes(negado.status));

      const res = await admin.agent.post('/api/admin/lessons/reidentify', { ids: [antiga.id, vaga.id] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.updated, 1);
      assert.equal(res.body.unidentified, 1);
      const [primeira, segunda] = res.body.items;
      assert.equal(primeira.status, 'atualizada');
      assert.deepEqual(primeira.lesson.topics.map((x) => [x.topic_id, x.source]), [[t.razao.id, 'ia'], [t.porcentagem.id, 'ia']]);
      assert.equal(primeira.lesson.topic_id, t.razao.id);
      assert.equal(primeira.lesson.questions_status, 'pending');
      assert.equal(segunda.status, 'sem_assunto');
      assert.deepEqual((await topicsOf(vaga.id)).map((r) => r.topic_id), [t.razao.id], 'a aula sem assunto no título fica como estava');

      const denovo = await admin.agent.post(`/api/admin/lessons/${antiga.id}/reidentify`, {});
      assert.equal(denovo.status, 200);
      assert.equal(denovo.body.status, 'sem_mudanca');

      const inexistente = await admin.agent.post('/api/admin/lessons/00000000-0000-4000-8000-000000000000/reidentify', {});
      assert.equal(inexistente.status, 404);
    });
  });
});
