'use strict';

/**
 * Cadastro de aulas em massa a partir de vídeos enviados ao painel.
 *
 *   NODE_ENV=test node --test tests/lessons-upload.test.js
 *
 * Regras que não podem quebrar: só administrador cadastra, arquivo que não
 * existe no armazenamento é recusado, o mesmo vídeo não vira duas aulas, uma
 * linha com problema não derruba as boas, a duração sai do próprio vídeo e a
 * ordem continua de onde o assunto parou.
 *
 * O assunto do lote deixou de ser obrigatório: cada aula traz os seus (até
 * três, na ordem do título) ou o servidor lê do título. Assunto novo é
 * cadastrado uma vez só, e toda aula nova entra na fila das questões.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTestContext } = require('./helpers');
const uploads = require('../server/services/uploads');

/** MP4 mínimo reconhecido pela assinatura (caixa ftyp nos bytes 4 a 7). */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftypisom'),
  Buffer.from('   isomiso2avc1mp41'),
  Buffer.alloc(64, 7),
]);

describe('Aulas em massa', () => {
  let ctx;
  let db;
  let admin;
  let student;
  let subject;
  let topic;
  let razao;
  let exam;
  const files = [];

  /** Grava um vídeo no armazenamento como se tivesse vindo do painel. */
  async function putVideo(seed) {
    const buffer = Buffer.concat([MP4, Buffer.alloc(16, seed)]);
    const saved = await uploads.save(buffer, {
      contentType: 'video/mp4',
      filename: `aula-${seed}.mp4`,
      folder: 'videos',
    });
    files.push(saved.url);
    return saved.url;
  }

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, board)
       VALUES ('enem-up', 'ENEM', 'ENEM', 'enem', 'INEP') RETURNING id`
    );
    subject = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('mat-up', 'Matemática', 1) RETURNING id`);
    topic = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 1) RETURNING id`,
      [subject.id]
    );
    razao = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'razao-proporcao', 'Razão e proporção', 2) RETURNING id`,
      [subject.id]
    );
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluna Upload' });
  });

  after(async () => {
    for (const url of files) await uploads.remove(url).catch(() => {});
    await ctx.close();
  });

  const base = () => ({ subject_id: subject.id, topic_id: topic.id, teacher_name: 'Equipe', exam_ids: [exam.id] });

  it('aluno e visitante não cadastram', async () => {
    const url = await putVideo(1);
    const asStudent = await student.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [{ video_url: url, title: 'Invasão' }],
    });
    assert.ok([401, 403].includes(asStudent.status));

    const anonymous = await ctx.request('POST', '/api/admin/lessons/import', {
      body: { ...base(), items: [{ video_url: url, title: 'Invasão' }] },
    });
    assert.ok([401, 403].includes(anonymous.status));
  });

  it('cadastra os vídeos enviados e vincula a prova', async () => {
    const a = await putVideo(2);
    const b = await putVideo(3);

    const res = await admin.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [
        { video_url: a, title: 'Porcentagem — parte 1', video_seconds: 180, video_bytes: 1024, video_mime: 'video/mp4' },
        { video_url: b, title: 'Porcentagem — parte 2', video_seconds: 600 },
      ],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.imported, 2);
    assert.equal(res.body.failed, 0);

    const lessons = await db.many(
      `SELECT title, sort_order, video_provider, video_url, duration_min, video_seconds
         FROM lessons WHERE topic_id = $1 ORDER BY sort_order`,
      [topic.id]
    );
    assert.equal(lessons.length, 2);
    assert.equal(lessons[0].video_provider, 'upload', 'a aula fica marcada como vídeo da plataforma');
    assert.match(lessons[0].video_url, /^\/uploads\/videos\//);
    assert.equal(lessons[0].duration_min, 3, 'a duração vem dos segundos do próprio vídeo');
    assert.equal(lessons[1].duration_min, 10);
    assert.deepEqual(lessons.map((l) => l.sort_order), [1, 2]);

    const links = await db.one(
      `SELECT count(*)::int AS total FROM lesson_exams le JOIN lessons l ON l.id = le.lesson_id
        WHERE l.topic_id = $1 AND le.exam_id = $2`,
      [topic.id, exam.id]
    );
    assert.equal(links.total, 2);
  });

  it('recusa arquivo que não está no armazenamento', async () => {
    const res = await admin.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [{ video_url: '/uploads/videos/0000000000000000000000aa.mp4', title: 'Arquivo sumido' }],
    });
    assert.equal(res.body.imported, 0);
    assert.match(res.body.errors[0].message, /arquivo|envie/i);
  });

  it('recusa endereço que não é da plataforma', async () => {
    const res = await admin.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [{ video_url: 'https://www.youtube.com/watch?v=abc', title: 'Link externo' }],
    });
    assert.equal(res.body.imported, 0);
    assert.equal(res.body.failed, 1);
  });

  it('o mesmo vídeo não vira duas aulas', async () => {
    const url = await putVideo(4);
    const primeira = await admin.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [{ video_url: url, title: 'Única' }, { video_url: url, title: 'Repetida' }],
    });
    assert.equal(primeira.body.imported, 1);
    assert.match(primeira.body.errors[0].message, /duas vezes/i);

    const denovo = await admin.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [{ video_url: url, title: 'De novo' }],
    });
    assert.equal(denovo.body.imported, 0);
    assert.match(denovo.body.errors[0].message, /já existe/i);
  });

  it('uma linha com problema não derruba as boas', async () => {
    const bom = await putVideo(5);
    const res = await admin.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [
        { video_url: '/uploads/videos/1111111111111111111111bb.mp4', title: 'Some' },
        { video_url: bom, title: 'Entra assim mesmo' },
      ],
    });
    assert.equal(res.body.imported, 1);
    assert.equal(res.body.failed, 1);
    assert.equal(res.body.created[0].title, 'Entra assim mesmo');
  });

  it('a aula cadastrada uma a uma também aceita o arquivo enviado', async () => {
    const url = await putVideo(6);
    const res = await admin.agent.post('/api/admin/lessons', {
      title: 'Aula avulsa com arquivo',
      subject_id: subject.id,
      topic_id: topic.id,
      video_url: url,
      duration_min: 25,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.video_provider, 'upload');
    assert.equal(res.body.video_url, url);

    const semArquivo = await admin.agent.post('/api/admin/lessons', {
      title: 'Aula com arquivo inexistente',
      subject_id: subject.id,
      topic_id: topic.id,
      video_url: '/uploads/videos/2222222222222222222222cc.mp4',
    });
    assert.equal(semArquivo.status, 400);
  });

  it('a miniatura enviada pelo painel é aceita no cadastro', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 3)]);
    const thumb = await uploads.save(png, { contentType: 'image/png', filename: 'capa.png', folder: 'aulas' });
    files.push(thumb.url);

    const res = await admin.agent.post('/api/admin/lessons', {
      title: 'Aula com miniatura enviada',
      subject_id: subject.id,
      topic_id: topic.id,
      thumbnail_url: thumb.url,
    });
    assert.equal(res.status, 201, 'caminho interno de imagem não pode ser recusado pela validação');
    assert.equal(res.body.thumbnail_url, thumb.url);
  });

  /** Assuntos gravados da aula, na ordem. */
  async function assuntosDa(lessonId) {
    return db.many(
      `SELECT lt.position, lt.topic_id, lt.source, t.slug
         FROM lesson_topics lt JOIN topics t ON t.id = lt.topic_id
        WHERE lt.lesson_id = $1 ORDER BY lt.position`,
      [lessonId]
    );
  }

  it('lote sem assunto: cada aula com os seus, na ordem, sem duplicar assunto novo', async () => {
    const [a, b, c, d] = [await putVideo(11), await putVideo(12), await putVideo(13), await putVideo(14)];
    const res = await admin.agent.post('/api/admin/lessons/import', {
      subject_id: subject.id,
      exam_ids: [exam.id],
      items: [
        {
          video_url: a,
          title: 'Aula 01 — Razão e juros',
          topics: [{ topic_id: razao.id, label: 'Razão' }, { new_topic_name: 'Juros simples', source: 'ia' }],
        },
        { video_url: b, title: 'Aula 02 — Razão e Proporção e Porcentagem' },
        { video_url: c, title: 'Aula 03 — Porcentagem e Juros simples' },
        { video_url: d, title: 'Aula 04' },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.imported, 3);
    assert.equal(res.body.failed, 1);
    assert.equal(res.body.errors[0].line, 4);
    assert.match(res.body.errors[0].message, /identificar o assunto/i);

    const [la, lb, lc] = res.body.created;
    const juros = await db.many(`SELECT id, slug FROM topics WHERE subject_id = $1 AND slug LIKE 'juros-simples%'`, [subject.id]);
    assert.deepEqual(juros.map((row) => row.slug), ['juros-simples'], 'o assunto novo é cadastrado uma vez só');

    assert.deepEqual((await assuntosDa(la.id)).map((r) => [r.slug, r.source]), [['razao-proporcao', 'manual'], ['juros-simples', 'ia']]);
    assert.deepEqual((await assuntosDa(lb.id)).map((r) => [r.slug, r.source]), [['razao-proporcao', 'ia'], ['porcentagem', 'ia']]);
    assert.deepEqual((await assuntosDa(lc.id)).map((r) => r.slug), ['porcentagem', 'juros-simples']);
    assert.deepEqual(la.topics.map((x) => x.topic_name), ['Razão e proporção', 'Juros simples']);

    const aulas = await db.many(
      'SELECT id, topic_id, questions_status FROM lessons WHERE id = ANY($1::uuid[])',
      [[la.id, lb.id, lc.id]]
    );
    const porId = new Map(aulas.map((row) => [row.id, row]));
    assert.equal(porId.get(la.id).topic_id, razao.id, 'o principal é o primeiro assunto');
    assert.equal(porId.get(lc.id).topic_id, topic.id);
    assert.ok(aulas.every((row) => row.questions_status === 'pending'), 'toda aula nova entra na fila das questões');

    const cobertura = await db.one('SELECT 1 FROM exam_topics WHERE exam_id = $1 AND topic_id = $2', [exam.id, juros[0].id]);
    assert.ok(cobertura, 'o assunto novo entra no conteúdo da prova do lote');
  });

  it('o assunto do lote vale para quem chega sem assuntos, sem gastar IA', async () => {
    const [a, b] = [await putVideo(21), await putVideo(22)];
    const antes = (await db.one('SELECT count(*)::int AS n FROM ai_usage')).n;
    const res = await admin.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [
        { video_url: a, title: 'Exercícios resolvidos', topics: [{ topic_id: razao.id }] },
        { video_url: b, title: 'Exercícios resolvidos 2' },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await db.one('SELECT count(*)::int AS n FROM ai_usage')).n, antes);
    assert.deepEqual((await assuntosDa(res.body.created[0].id)).map((r) => r.slug), ['razao-proporcao']);
    assert.deepEqual((await assuntosDa(res.body.created[1].id)).map((r) => r.slug), ['porcentagem']);
  });

  it('assunto de outra matéria derruba só a linha dele', async () => {
    const outra = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('fis-up', 'Física', 2) RETURNING id`);
    const cinematica = await db.one(
      `INSERT INTO topics (subject_id, slug, name) VALUES ($1, 'cinematica', 'Cinemática') RETURNING id`,
      [outra.id]
    );
    const [a, b] = [await putVideo(31), await putVideo(32)];
    const res = await admin.agent.post('/api/admin/lessons/import', {
      subject_id: subject.id,
      items: [
        { video_url: a, title: 'Aula misturada', topics: [{ topic_id: cinematica.id }] },
        { video_url: b, title: 'Aula certa', topics: [{ topic_id: topic.id }] },
      ],
    });
    assert.equal(res.body.imported, 1);
    assert.equal(res.body.errors[0].line, 1);
    assert.match(res.body.errors[0].message, /matéria/i);
  });

  it('o fluxo da tela: a proposta de analyze-titles volta como chips e a resposta diz o que foi cadastrado agora', async () => {
    // A tela de envio em massa lê os títulos assim que os arquivos são
    // escolhidos e devolve os chips no /import (com label e source), sem
    // assunto de lote. Depois casa cada aula gravada pelo arquivo e mostra os
    // assuntos que nasceram nesse envio.
    const titulos = ['Aula 09 — Razão e Proporção e Porcentagem', 'Aula 10 — Porcentagem e Logaritmos'];
    const proposta = await admin.agent.post('/api/admin/lessons/analyze-titles', { subject_id: subject.id, titles: titulos });
    assert.equal(proposta.status, 200);
    assert.deepEqual(proposta.body.items[1].topics.map((t) => t.new_topic_name), [null, 'Logaritmos']);
    const chips = proposta.body.items.map((item) =>
      item.topics.map((t) => (t.topic_id
        ? { topic_id: t.topic_id, subtopic_id: t.subtopic_id || null, label: t.label || null, source: 'ia' }
        : { new_topic_name: t.new_topic_name, label: t.label || null, source: 'ia' }))
    );

    const [a, b] = [await putVideo(41), await putVideo(42)];
    const res = await admin.agent.post('/api/admin/lessons/import', {
      subject_id: subject.id,
      items: [
        { video_url: a, title: titulos[0], topics: chips[0] },
        { video_url: b, title: titulos[1], topics: chips[1] },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const [la, lb] = res.body.created;
    assert.equal(la.video_url, a, 'a tela casa a aula gravada pelo arquivo');
    assert.deepEqual(la.topics.map((t) => [t.topic_name, t.created]), [['Razão e proporção', false], ['Porcentagem', false]]);
    assert.deepEqual(lb.topics.map((t) => [t.topic_name, t.created]), [['Porcentagem', false], ['Logaritmos', true]]);
    assert.deepEqual((await assuntosDa(lb.id)).map((r) => [r.slug, r.source]), [['porcentagem', 'ia'], ['logaritmos', 'ia']]);
  });

  it('o arquivo do vídeo fica onde a aula aponta', async () => {
    const lesson = await db.one(`SELECT video_url FROM lessons WHERE video_provider = 'upload' LIMIT 1`);
    const full = path.join(uploads.UPLOADS_DIR, lesson.video_url.replace('/uploads/', ''));
    const stat = await fs.stat(full);
    assert.ok(stat.size > 0);
  });
});
