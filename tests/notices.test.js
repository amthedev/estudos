'use strict';

/**
 * Editais.
 *
 *   NODE_ENV=test node --test tests/notices.test.js
 *
 * Regras que não podem quebrar: rascunho nunca vaza para o aluno, cada prova tem
 * no máximo um edital por ano, publicar arquiva o anterior e sincroniza a data da
 * prova (o cronograma depende dela), e as rotas de cadastro são só do administrador.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

/** Data em AAAA-MM-DD deslocada em dias a partir de hoje. */
/**
 * Data em 'AAAA-MM-DD' deslocada em dias, no MESMO fuso que o servidor usa.
 *
 * toISOString() devolve a data em UTC: depois das 21h em Brasília o dia já
 * virou lá, e o teste pedia 7 dias mas gravava 8 — passava de manhã e falhava
 * à noite.
 */
function isoInDays(days) {
  const dates = require('../server/utils/dates');
  return dates.addDays(dates.todayISO(), days);
}

describe('Editais', () => {
  let ctx;
  let db;
  let admin;
  let student;
  let exam;
  let otherExam;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, board)
       VALUES ('enem-edital', 'ENEM', 'ENEM', 'enem', 'INEP') RETURNING id`
    );
    otherExam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, board)
       VALUES ('bb-edital', 'Academia do Barro Branco', 'Barro Branco', 'barro_branco', 'VUNESP') RETURNING id`
    );
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluno Edital' });
    await db.query('UPDATE student_profiles SET exam_id = $2 WHERE user_id = $1', [student.user.id, exam.id]);
  });

  after(async () => {
    await ctx.close();
  });

  it('só o administrador cadastra e lista editais', async () => {
    for (const path of ['/api/admin/exam-notices']) {
      const asStudent = await student.agent.get(path);
      assert.ok([401, 403].includes(asStudent.status), `${path} respondeu ${asStudent.status} a um aluno`);
      const anonymous = await ctx.request('GET', path);
      assert.ok([401, 403].includes(anonymous.status), `${path} respondeu ${anonymous.status} sem sessão`);
    }
    const write = await student.agent.post('/api/admin/exam-notices', { exam_id: exam.id, year: 2026, title: 'Invasão' });
    assert.ok([401, 403].includes(write.status));
  });

  it('cadastra um edital como rascunho e recusa ano repetido na mesma prova', async () => {
    const created = await admin.agent.post('/api/admin/exam-notices', {
      exam_id: exam.id,
      year: 2026,
      title: 'Edital ENEM 2026',
      board: 'INEP',
      pdf_url: 'https://exemplo.com/edital.pdf',
      registration_start: isoInDays(-5),
      registration_end: isoInDays(10),
      exam_date: isoInDays(60),
      highlights: [{ label: 'Taxa de inscrição', value: 'R$ 85,00' }],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'draft');
    assert.equal(created.body.exam_short_name, 'ENEM');
    assert.deepEqual(created.body.highlights, [{ label: 'Taxa de inscrição', value: 'R$ 85,00' }]);

    const duplicated = await admin.agent.post('/api/admin/exam-notices', {
      exam_id: exam.id,
      year: 2026,
      title: 'Outro edital do mesmo ano',
    });
    assert.equal(duplicated.status, 409);
    assert.equal(duplicated.body.error.code, 'conflict');

    // o mesmo ano em outra prova é permitido
    const otherOk = await admin.agent.post('/api/admin/exam-notices', {
      exam_id: otherExam.id,
      year: 2026,
      title: 'Edital Barro Branco 2026',
    });
    assert.equal(otherOk.status, 201);
  });

  it('rascunho não aparece para o aluno nem para visitante', async () => {
    const publicList = await ctx.request('GET', `/api/notices?exam_id=${exam.id}`);
    assert.equal(publicList.status, 200);
    assert.equal(publicList.body.current, null);
    assert.equal(publicList.body.items.length, 0);
  });

  it('publicar arquiva o edital anterior e sincroniza a data da prova', async () => {
    const list = await admin.agent.get(`/api/admin/exam-notices?exam_id=${exam.id}`);
    const notice = list.body.items.find((item) => item.year === 2026);

    const published = await admin.agent.post(`/api/admin/exam-notices/${notice.id}/publish`, {});
    assert.equal(published.status, 200);
    assert.equal(published.body.status, 'published');
    assert.equal(published.body.archived, 0);
    assert.ok(published.body.published_at, 'publicar deve carimbar a data de publicação');

    const examRow = await db.one('SELECT exam_date FROM exams WHERE id = $1', [exam.id]);
    assert.equal(examRow.exam_date, isoInDays(60), 'a data da prova deve seguir o edital publicado');

    // um segundo edital publicado arquiva o primeiro
    const next = await admin.agent.post('/api/admin/exam-notices', {
      exam_id: exam.id,
      year: 2027,
      title: 'Edital ENEM 2027',
      exam_date: isoInDays(400),
    });
    assert.equal(next.status, 201);
    const secondPublish = await admin.agent.post(`/api/admin/exam-notices/${next.body.id}/publish`, {});
    assert.equal(secondPublish.body.archived, 1);

    const older = await admin.agent.get(`/api/admin/exam-notices/${notice.id}`);
    assert.equal(older.body.status, 'archived');
  });

  it('o aluno vê o edital vigente da prova dele com a contagem regressiva', async () => {
    const mine = await student.agent.get('/api/notices');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.exam_id, exam.id);
    assert.equal(mine.body.current.year, 2027, 'o vigente é o último publicado');
    assert.equal(typeof mine.body.current.days_until_exam, 'number');
    assert.ok(mine.body.current.days_until_exam > 0);
    assert.equal(mine.body.previous.length, 1, 'o edital arquivado fica no histórico');
    assert.equal(mine.body.previous[0].year, 2026);

    // não devolve edital de outra prova
    assert.ok(mine.body.items.every((item) => item.exam_id === exam.id));
  });

  it('marca as inscrições abertas quando a janela do edital está corrente', async () => {
    const open = await admin.agent.post('/api/admin/exam-notices', {
      exam_id: otherExam.id,
      year: 2028,
      title: 'Edital com inscrições abertas',
      registration_start: isoInDays(-3),
      registration_end: isoInDays(7),
      status: 'published',
    });
    assert.equal(open.status, 201);
    assert.equal(open.body.status, 'published');

    const view = await ctx.request('GET', `/api/notices?exam_id=${otherExam.id}`);
    assert.equal(view.body.current.registration_open, true);
    assert.equal(view.body.current.days_until_registration_end, 7);
  });

  it('valida os campos e recusa vestibular inexistente', async () => {
    const badDate = await admin.agent.post('/api/admin/exam-notices', {
      exam_id: exam.id,
      year: 2029,
      title: 'Edital com data inválida',
      exam_date: '08/11/2026',
    });
    assert.equal(badDate.status, 400);
    assert.equal(badDate.body.error.code, 'validation_error');

    const noExam = await admin.agent.post('/api/admin/exam-notices', {
      exam_id: '00000000-0000-0000-0000-000000000000',
      year: 2029,
      title: 'Edital órfão',
    });
    assert.equal(noExam.status, 400);
  });

  it('arquiva e exclui', async () => {
    const created = await admin.agent.post('/api/admin/exam-notices', {
      exam_id: otherExam.id,
      year: 2030,
      title: 'Edital descartável',
    });
    const archived = await admin.agent.post(`/api/admin/exam-notices/${created.body.id}/archive`, {});
    assert.equal(archived.body.status, 'archived');

    const removed = await admin.agent.del(`/api/admin/exam-notices/${created.body.id}`);
    assert.equal(removed.status, 200);

    const gone = await admin.agent.get(`/api/admin/exam-notices/${created.body.id}`);
    assert.equal(gone.status, 404);
  });
});
