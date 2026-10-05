'use strict';

/**
 * Aula com vários assuntos vista de fora da aula: página do assunto, progresso,
 * cronograma, busca, favoritos e o painel de conteúdo (contagens e exclusão).
 *
 *   NODE_ENV=test node --test tests/aula-em-varios-assuntos.test.js
 *
 * Regras que não podem quebrar: a aula aparece em cada um dos assuntos dela;
 * por assunto ela conta em todos, por matéria conta uma vez só; o cronograma
 * agenda a aula uma vez (pelo principal) e não manda "estudar" um assunto que
 * a aula já cobre; excluir um assunto secundário avisa antes e não apaga a aula.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

const onboarding = (examId) => ({
  exam_id: examId,
  study_days: [0, 1, 2, 3, 4, 5, 6],
  hours_per_day: 2,
  level: 'intermediario',
  target_course: 'Engenharia',
  target_university: 'UFPR',
  target_score: '750',
});

describe('Aula com vários assuntos fora da aula', () => {
  let ctx;
  let db;
  let admin;
  let aluna; // prova com os quatro assuntos no conteúdo programático
  let aluno; // prova que cobra Regra de Três mas não Razão e Proporção
  let mat;
  const t = {};
  let porcentagemSub;
  let aula; // Razão (principal), Regra de Três e Porcentagem/subassunto
  let aulaPorcentagem; // aula só de Porcentagem

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;

    mat = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica-va', 'Matemática', 1) RETURNING id`);
    const topic = (slug, name, order) =>
      db.one('INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id, name', [
        mat.id,
        slug,
        name,
        order,
      ]);
    t.razao = await topic('razao-proporcao', 'Razão e proporção', 1);
    t.regra = await topic('regra-de-tres', 'Regra de três simples e composta', 2);
    t.porcentagem = await topic('porcentagem', 'Porcentagem', 3);
    t.funcao = await topic('funcao-afim', 'Função afim (1º grau)', 4);
    porcentagemSub = (
      await db.one(
        `INSERT INTO subtopics (topic_id, slug, name, sort_order)
         VALUES ($1, 'fator-de-aumento', 'Fator de aumento e de desconto', 1) RETURNING id`,
        [t.porcentagem.id]
      )
    ).id;

    // o título não cita os assuntos secundários: a busca só acha a aula por eles
    aula = await db.one(
      `INSERT INTO lessons (subject_id, topic_id, slug, title, duration_min, sort_order)
       VALUES ($1, $2, 'aula-05', 'Aula 05 — Proporções no dia a dia', 30, 1) RETURNING id`,
      [mat.id, t.razao.id]
    );
    await db.query(
      `INSERT INTO lesson_topics (lesson_id, position, topic_id, subtopic_id, label, source)
       VALUES ($1, 2, $2, NULL, 'Regra de Três', 'ia'), ($1, 3, $3, $4, 'Porcentagem', 'ia')`,
      [aula.id, t.regra.id, t.porcentagem.id, porcentagemSub]
    );
    aulaPorcentagem = await db.one(
      `INSERT INTO lessons (subject_id, topic_id, slug, title, duration_min, sort_order)
       VALUES ($1, $2, 'aula-porcentagem', 'Descontos sucessivos', 25, 1) RETURNING id`,
      [mat.id, t.porcentagem.id]
    );

    // sem lesson_exams: o escopo das provas vem dos assuntos (exam_topics)
    const exam = async (slug, topicIds) => {
      const row = await db.one(
        `INSERT INTO exams (slug, name, short_name, track, board) VALUES ($1, $1, $1, 'enem', 'INEP') RETURNING id`,
        [slug]
      );
      await db.query('INSERT INTO exam_subjects (exam_id, subject_id, weight) VALUES ($1, $2, 1)', [row.id, mat.id]);
      for (const id of topicIds) {
        await db.query('INSERT INTO exam_topics (exam_id, topic_id, weight) VALUES ($1, $2, 1)', [row.id, id]);
      }
      return row;
    };
    const completa = await exam('prova-completa', [t.razao.id, t.regra.id, t.porcentagem.id, t.funcao.id]);
    const parcial = await exam('prova-parcial', [t.regra.id, t.funcao.id]);

    admin = await ctx.loginAdmin();
    aluna = await ctx.registerStudent({ name: 'Aluna Vários Assuntos' });
    let res = await aluna.agent.post('/api/onboarding', onboarding(completa.id));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    aluno = await ctx.registerStudent({ name: 'Aluno Prova Parcial' });
    res = await aluno.agent.post('/api/onboarding', onboarding(parcial.id));
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  after(async () => {
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  describe('página do assunto', () => {
    it('mostra a aula também nos assuntos secundários, com o subassunto de cada um', async () => {
      const regra = await aluna.agent.get(`/api/topics/${t.regra.id}`);
      assert.equal(regra.status, 200, JSON.stringify(regra.body));
      assert.deepEqual(regra.body.lessons.map((l) => l.id), [aula.id]);
      assert.equal(regra.body.lessons[0].main_topic, false);
      assert.equal(regra.body.lessons[0].topic_id, t.razao.id, 'topic_id continua sendo o principal');
      assert.equal(regra.body.lessons_total, 1);

      const porcentagem = await aluna.agent.get(`/api/topics/${t.porcentagem.id}`);
      assert.deepEqual(
        porcentagem.body.lessons.map((l) => l.id),
        [aulaPorcentagem.id, aula.id],
        'as aulas do próprio assunto vêm antes das que só passam por ele'
      );
      const daAula = porcentagem.body.lessons.find((l) => l.id === aula.id);
      assert.equal(daAula.subtopic_id, porcentagemSub, 'a tela agrupa pelo subassunto dentro deste assunto');
      assert.equal(porcentagem.body.lessons_total, 2);

      const razao = await aluna.agent.get(`/api/topics/${t.razao.id}`);
      assert.deepEqual(razao.body.lessons.map((l) => [l.id, l.main_topic]), [[aula.id, true]]);
    });

    it('a prova que só cobra o assunto secundário também vê a aula', async () => {
      // a prova parcial não tem Razão e Proporção (o principal da aula) no conteúdo
      const regra = await aluno.agent.get(`/api/topics/${t.regra.id}`);
      assert.equal(regra.status, 200);
      assert.deepEqual(regra.body.lessons.map((l) => l.id), [aula.id]);
    });

    it('o filtro e a busca da lista de aulas acham a aula pelo assunto secundário', async () => {
      const filtro = await aluna.agent.get(`/api/lessons?topic_id=${t.regra.id}&all=1`);
      assert.equal(filtro.status, 200);
      assert.deepEqual(filtro.body.items.map((l) => l.id), [aula.id]);

      const sub = await aluna.agent.get(`/api/lessons?subtopic_id=${porcentagemSub}&all=1`);
      assert.deepEqual(sub.body.items.map((l) => l.id), [aula.id]);

      const busca = await aluna.agent.get(`/api/lessons?q=${encodeURIComponent('regra de três')}&all=1`);
      assert.deepEqual(busca.body.items.map((l) => l.id), [aula.id]);
    });
  });

  // -------------------------------------------------------------------------
  describe('progresso', () => {
    it('conta a aula em cada assunto dela sem inflar a matéria', async () => {
      await db.query(
        `INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at) VALUES ($1, $2, 'completed', now())`,
        [aluna.user.id, aula.id]
      );

      const materia = await aluna.agent.get(`/api/subjects/${mat.id}`);
      assert.equal(materia.status, 200, JSON.stringify(materia.body));
      const porAssunto = Object.fromEntries(
        materia.body.topics.map((topic) => [topic.id, [Number(topic.lessons_total), Number(topic.lessons_done)]])
      );
      assert.deepEqual(porAssunto[t.razao.id], [1, 1]);
      assert.deepEqual(porAssunto[t.regra.id], [1, 1], 'a aula conta no assunto secundário');
      assert.deepEqual(porAssunto[t.porcentagem.id], [2, 1]);
      assert.deepEqual(porAssunto[t.funcao.id], [0, 0]);

      // duas aulas na matéria, não 1 + 1 + 2
      assert.equal(Number(materia.body.lessons_total), 2);
      assert.equal(Number(materia.body.lessons_done), 1);

      const lista = await aluna.agent.get('/api/subjects');
      const linha = lista.body.find((s) => s.id === mat.id);
      assert.equal(Number(linha.lessons_total), 2);
      assert.equal(Number(linha.lessons_done), 1);
    });
  });

  // -------------------------------------------------------------------------
  describe('cronograma', () => {
    async function itens(userId) {
      return db.many('SELECT type, topic_id, lesson_id FROM schedule_items WHERE user_id = $1', [userId]);
    }

    it('agenda a aula uma vez e não manda estudar o assunto que ela já cobre', async () => {
      const lista = await itens(aluna.user.id);
      const daAula = lista.filter((item) => item.lesson_id === aula.id);
      // a aluna já concluiu a aula no teste anterior, mas o cronograma foi gerado no onboarding
      assert.equal(daAula.length, 1, 'uma vez só, não uma por assunto');
      assert.equal(daAula[0].topic_id, t.razao.id);

      const blocos = lista.filter((item) => item.type === 'topic').map((item) => item.topic_id);
      assert.ok(blocos.includes(t.funcao.id), 'assunto sem aula nenhuma ganha bloco de estudo');
      assert.ok(!blocos.includes(t.regra.id), 'Regra de Três já está coberta pela aula');
      assert.ok(!blocos.includes(t.porcentagem.id));
    });

    it('quando o principal da aula está fora da prova, o assunto secundário não fica sem estudo', async () => {
      const lista = await itens(aluno.user.id);
      assert.equal(lista.some((item) => item.lesson_id === aula.id), false, 'a aula não é da prova parcial pelo principal');
      const blocos = lista.filter((item) => item.type === 'topic').map((item) => item.topic_id);
      assert.ok(blocos.includes(t.regra.id), 'sem a aula no plano, Regra de Três vira bloco de estudo');
    });
  });

  // -------------------------------------------------------------------------
  describe('busca, favoritos e provas', () => {
    it('as contagens de aulas por assunto incluem as aulas em que ele é secundário', async () => {
      const busca = await aluna.agent.get(`/api/search?q=${encodeURIComponent('Regra de três')}`);
      assert.equal(busca.status, 200);
      const assunto = busca.body.topics.find((row) => row.id === t.regra.id);
      assert.equal(Number(assunto.lessons_total), 1);

      const favorito = await aluna.agent.post('/api/favorites', { item_type: 'topic', item_id: t.regra.id });
      assert.equal(favorito.status, 201);
      assert.equal(favorito.body.lessons_total, 1);

      const exam = await db.one(`SELECT id FROM exams WHERE slug = 'prova-completa'`);
      const provas = await admin.agent.get(`/api/admin/exams/${exam.id}/topics?subject_id=${mat.id}`);
      assert.equal(provas.status, 200);
      const linhas = Object.fromEntries(provas.body.items.map((row) => [row.id, row.lessons_total]));
      assert.equal(linhas[t.regra.id], 1);
      assert.equal(linhas[t.porcentagem.id], 2);
    });
  });

  // -------------------------------------------------------------------------
  describe('painel de conteúdo', () => {
    it('a árvore conta a aula em cada assunto e uma vez na matéria', async () => {
      const res = await admin.agent.get('/api/admin/content/tree');
      assert.equal(res.status, 200);
      const materia = res.body.areas.flatMap((area) => area.subjects).find((s) => s.id === mat.id);
      assert.equal(materia.lessons_count, 2);
      const assuntos = Object.fromEntries(materia.topics.map((topic) => [topic.id, topic]));
      assert.equal(assuntos[t.razao.id].lessons_count, 1);
      assert.equal(assuntos[t.regra.id].lessons_count, 1);
      assert.equal(assuntos[t.porcentagem.id].lessons_count, 2);
      assert.equal(assuntos[t.porcentagem.id].subtopics[0].lessons_count, 1);
    });

    it('o aviso de exclusão conta as aulas em que o assunto é secundário', async () => {
      // principal de uma aula e secundário de outra: continua bloqueado, e o aviso diz as duas coisas
      const porcentagem = await admin.agent.del(`/api/admin/content/topics/${t.porcentagem.id}`);
      assert.equal(porcentagem.status, 409);
      assert.equal(porcentagem.body.error.details.lessons, 1);
      assert.equal(porcentagem.body.error.details.secondary_lessons, 1);
      assert.match(porcentagem.body.error.message, /assunto secundário de 1 aula/);

      // nem a confirmação passa por cima da aula que sairia junto
      const forcado = await admin.agent.del(`/api/admin/content/topics/${t.porcentagem.id}`, { confirm: true });
      assert.equal(forcado.status, 409);
      assert.ok(await db.one('SELECT 1 FROM topics WHERE id = $1', [t.porcentagem.id]));

      const sub = await admin.agent.del(`/api/admin/content/subtopics/${porcentagemSub}`);
      assert.equal(sub.status, 409);
      assert.equal(sub.body.error.details.secondary_lessons, 1);
      assert.match(sub.body.error.message, /1 aula/);
    });

    it('excluir um assunto só secundário pede confirmação e não apaga a aula', async () => {
      await db.query(`UPDATE lessons SET questions_status = 'ready' WHERE id = $1`, [aula.id]);

      const aviso = await admin.agent.del(`/api/admin/content/topics/${t.regra.id}`);
      assert.equal(aviso.status, 409);
      assert.equal(aviso.body.error.details.secondary_only, true);
      assert.equal(aviso.body.error.details.secondary_lessons, 1);
      assert.equal(aviso.body.error.details.lessons, 0);
      assert.match(aviso.body.error.message, /assunto secundário em 1 aula/);
      assert.ok(await db.one('SELECT 1 FROM topics WHERE id = $1', [t.regra.id]), 'sem confirmação nada muda');

      const aluno403 = await aluna.agent.del(`/api/admin/content/topics/${t.regra.id}`, { confirm: true });
      assert.ok([401, 403].includes(aluno403.status));

      const ok = await admin.agent.del(`/api/admin/content/topics/${t.regra.id}`, { confirm: true });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.lessons_updated, 1);
      assert.equal(await db.one('SELECT 1 FROM topics WHERE id = $1', [t.regra.id]), null);

      const continua = await db.one('SELECT active, topic_id, questions_status FROM lessons WHERE id = $1', [aula.id]);
      assert.ok(continua, 'a aula continua');
      assert.equal(continua.active, true);
      assert.equal(continua.topic_id, t.razao.id);
      assert.equal(continua.questions_status, 'pending', 'as três questões são redistribuídas entre os assuntos que ficaram');

      const restantes = await db.many(
        'SELECT position, topic_id FROM lesson_topics WHERE lesson_id = $1 ORDER BY position',
        [aula.id]
      );
      assert.deepEqual(
        restantes.map((row) => [row.position, row.topic_id]),
        [
          [1, t.razao.id],
          [2, t.porcentagem.id],
        ],
        'a ordem dos assuntos fecha o buraco'
      );

      const log = await db.one(
        `SELECT data FROM audit_logs WHERE action = 'content.topic.delete' AND entity_id = $1`,
        [t.regra.id]
      );
      assert.deepEqual(log.data.removed_from_lessons, [aula.id]);
    });

    describe('assunto criado errado pela IA, com a questão que a fila já preparou nele', () => {
      let sequencia = 0;
      const assuntoNovo = async (name) => {
        sequencia += 1;
        return db.one(
          'INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id, name',
          [mat.id, `errado-${sequencia}`, name, 100 + sequencia]
        );
      };
      /** Aula com o assunto errado em 2º lugar, como a reidentificação deixaria. */
      const aulaCom = async (topicId) => {
        sequencia += 1;
        const lesson = await db.one(
          `INSERT INTO lessons (subject_id, topic_id, slug, title, duration_min, questions_status)
           VALUES ($1, $2, $3, 'Aula com assunto errado', 20, 'ready') RETURNING id`,
          [mat.id, t.razao.id, `aula-errada-${sequencia}`]
        );
        await db.query(`INSERT INTO lesson_topics (lesson_id, position, topic_id, source) VALUES ($1, 2, $2, 'ia')`, [
          lesson.id,
          topicId,
        ]);
        return lesson;
      };
      /** A questão que services/lesson-questions grava: da IA, da aula, no assunto do alvo. */
      const preparada = async (topicId, lessonId) => {
        const q = await db.one(
          `INSERT INTO questions (subject_id, topic_id, statement, difficulty, source, generated_by_ai, lesson_id)
           VALUES ($1, $2, 'Questão elaborada pela fila para a vaga do assunto errado.', 2, 'IA', true, $3) RETURNING id`,
          [mat.id, topicId, lessonId]
        );
        await db.query(
          `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
           VALUES ($1, 'A', 'Certa', true, 0), ($1, 'B', 'Errada', false, 1)`,
          [q.id]
        );
        return q.id;
      };

      it('a questão sem uso não bloqueia: sai junto, na exclusão confirmada', async () => {
        const errado = await assuntoNovo('Assunto que a IA inventou');
        const lesson = await aulaCom(errado.id);
        const questao = await preparada(errado.id, lesson.id);

        const aviso = await admin.agent.del(`/api/admin/content/topics/${errado.id}`);
        assert.equal(aviso.status, 409);
        assert.equal(aviso.body.error.details.secondary_only, true, 'antes, era o 409 de "mova ou exclua" sem saída');
        assert.equal(aviso.body.error.details.questions, 0);
        assert.equal(aviso.body.error.details.lesson_questions, 1);
        assert.match(aviso.body.error.message, /preparou automaticamente/);

        const ok = await admin.agent.del(`/api/admin/content/topics/${errado.id}`, { confirm: true });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.lesson_questions_removed, 1);
        assert.equal(await db.one('SELECT 1 FROM questions WHERE id = $1', [questao]), null);
        const depois = await db.one('SELECT topic_id, questions_status FROM lessons WHERE id = $1', [lesson.id]);
        assert.equal(depois.topic_id, t.razao.id, 'a aula continua');
        assert.equal(depois.questions_status, 'pending', 'e a vaga volta para a fila, nos assuntos que ficaram');

        const log = await db.one(
          `SELECT data FROM audit_logs WHERE action = 'content.topic.delete' AND entity_id = $1`,
          [errado.id]
        );
        assert.deepEqual(log.data.removed_lesson_questions, [questao]);
      });

      it('aula já corrigida: a questão que sobrou no assunto errado também sai com a confirmação', async () => {
        const errado = await assuntoNovo('Outro assunto inventado');
        const lesson = await aulaCom(errado.id);
        const questao = await preparada(errado.id, lesson.id);
        // o administrador trocou os assuntos da aula; a questão ficou no assunto errado
        await db.query('DELETE FROM lesson_topics WHERE lesson_id = $1 AND topic_id = $2', [lesson.id, errado.id]);

        const aviso = await admin.agent.del(`/api/admin/content/topics/${errado.id}`);
        assert.equal(aviso.status, 409);
        assert.equal(aviso.body.error.details.secondary_only, true);
        assert.equal(aviso.body.error.details.secondary_lessons, 0);
        assert.equal(aviso.body.error.details.lesson_questions, 1);

        const ok = await admin.agent.del(`/api/admin/content/topics/${errado.id}`, { confirm: true });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(await db.one('SELECT 1 FROM questions WHERE id = $1', [questao]), null);
      });

      it('questão que um aluno já respondeu continua bloqueando, mesmo confirmando', async () => {
        const errado = await assuntoNovo('Assunto inventado e já praticado');
        const lesson = await aulaCom(errado.id);
        const questao = await preparada(errado.id, lesson.id);
        const certa = await db.one('SELECT id FROM question_options WHERE question_id = $1 AND is_correct', [questao]);
        await db.query(
          `INSERT INTO question_attempts (user_id, question_id, subject_id, topic_id, selected_option_id, is_correct, context)
           VALUES ($1, $2, $3, $4, $5, true, 'practice')`,
          [aluna.user.id, questao, mat.id, errado.id, certa.id]
        );

        const forcado = await admin.agent.del(`/api/admin/content/topics/${errado.id}`, { confirm: true });
        assert.equal(forcado.status, 409, JSON.stringify(forcado.body));
        assert.notEqual(forcado.body.error.details.secondary_only, true);
        assert.equal(forcado.body.error.details.questions, 1);
        assert.match(forcado.body.error.message, /1 questão/);
        assert.ok(await db.one('SELECT 1 FROM questions WHERE id = $1', [questao]), 'o histórico da aluna fica');
        assert.ok(await db.one('SELECT 1 FROM topics WHERE id = $1', [errado.id]));
      });
    });
  });
});
