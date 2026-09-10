'use strict';

/**
 * Painel administrativo — vestibulares e concursos (tabela exams).
 *
 *   GET    /api/admin/exams                  lista (q, track, status) com contagens
 *   GET    /api/admin/exams/:id              prova + matérias com peso e contagem de assuntos + resumo dos critérios
 *   GET    /api/admin/exams/:id/topics       assuntos de uma matéria com peso e marcação de "cai nesta prova"
 *   POST   /api/admin/exams                  cria (slug gerado do nome) + conjunto de critérios de redação vazio
 *   PUT    /api/admin/exams/:id              edita (parcial)
 *   DELETE /api/admin/exams/:id              409 quando há alunos ou redações vinculados
 *   PUT    /api/admin/exams/:id/subjects     [{ subject_id, weight }] — substitui as matérias da prova
 *   PUT    /api/admin/exams/:id/topics       [{ topic_id, weight }] — substitui o conteúdo programático
 *                                            (com `subject_id` no corpo, substitui só o daquela matéria)
 *   POST   /api/admin/exams/:id/topics/bulk  { subject_id, all } — inclui (all=true) ou remove (all=false)
 *                                            de uma vez todos os assuntos ativos de uma matéria
 *
 * Ao criar uma prova, um conjunto de critérios de redação vazio é criado junto (editável em
 * /api/admin/essays/criteria/:examId) — a prova nasce pronta para receber a matriz de correção.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { uniqueSlug } = require('../../utils/slug');
const { isISODate } = require('../../utils/dates');

const TRACKS = ['enem', 'barro_branco', 'vestibular'];

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const nullableText = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const isoDate = z.preprocess(emptyToNull, z.string().refine(isISODate, 'Data inválida (use AAAA-MM-DD).').nullable().optional());
const weight = z.coerce.number().min(0).max(999.99);

const createBody = z.object({
  slug: z.preprocess(emptyToUndefined, z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/, 'Use apenas letras minúsculas, números e hífens.').optional()),
  name: z.string().trim().min(2, 'Informe o nome da prova.').max(120),
  short_name: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(40).optional()),
  track: z.enum(TRACKS, { errorMap: () => ({ message: `Trilha inválida. Opções: ${TRACKS.join(', ')}.` }) }),
  board: nullableText(80),
  description: nullableText(2000),
  exam_date: isoDate,
  has_essay: z.boolean().optional(),
  essay_max_score: z.coerce.number().min(0).max(10000).optional(),
  score_max: z.preprocess(emptyToNull, z.coerce.number().min(0).max(10000).nullable().optional()),
  active: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
});
const updateBody = createBody.partial().refine((body) => Object.keys(body).length > 0, 'Nada para atualizar.');

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  track: z.preprocess(emptyToUndefined, z.enum(TRACKS).optional()),
  status: z.preprocess(emptyToUndefined, z.enum(['active', 'inactive']).optional()),
});

const subjectsBody = z.object({
  subjects: z
    .array(z.object({ subject_id: uuid, weight: weight.optional() }))
    .max(200)
    .optional(),
});

const topicsBody = z.object({
  subject_id: z.preprocess(emptyToUndefined, uuid.optional()),
  topics: z
    .array(z.object({ topic_id: uuid, weight: weight.optional() }))
    .max(3000)
    .optional(),
});

const bulkBody = z.object({
  subject_id: uuid,
  all: z.boolean().optional(),
  weight: weight.optional(),
});

const WRITABLE = ['slug', 'name', 'short_name', 'track', 'board', 'description', 'exam_date', 'has_essay',
  'essay_max_score', 'score_max', 'active', 'sort_order'];

const SELECT_EXAM = `
  SELECT e.id, e.slug, e.name, e.short_name, e.track, e.board, e.description, e.exam_date, e.has_essay,
         e.essay_max_score, e.score_max, e.active, e.sort_order, e.created_at, e.updated_at,
         (SELECT count(*)::int FROM exam_subjects es WHERE es.exam_id = e.id) AS subjects_count,
         (SELECT count(*)::int FROM exam_topics et WHERE et.exam_id = e.id) AS topics_count,
         (SELECT count(*)::int FROM past_exams pe WHERE pe.exam_id = e.id) AS past_exams_count,
         (SELECT count(*)::int FROM student_profiles sp WHERE sp.exam_id = e.id) AS students_count,
         (SELECT count(*)::int FROM essay_themes th WHERE th.exam_id = e.id) AS essay_themes_count
    FROM exams e`;

/** Conjunto de critérios de redação vazio, criado junto com a prova. */
async function createEmptyCriteriaSet(client, exam) {
  await client.query(
    `INSERT INTO essay_criteria_sets (exam_id, name, max_score, genre, criteria, active)
     VALUES ($1, $2, $3, 'Texto dissertativo-argumentativo', '[]'::jsonb, true)
     ON CONFLICT (exam_id) DO NOTHING`,
    [exam.id, `Critérios de redação — ${exam.name}`, exam.essay_max_score ?? 1000]
  );
}

async function requireExam(id) {
  const exam = await db.one('SELECT id, name, essay_max_score FROM exams WHERE id = $1', [id]);
  if (!exam) throw new AppError(404, 'not_found', 'Vestibular não encontrado.');
  return exam;
}

/** Matérias da prova com peso e contagem de assuntos. */
function loadExamSubjects(examId) {
  return db.many(
    `SELECT s.id AS subject_id, s.slug, s.name, s.color, s.icon, s.area_id, a.name AS area_name,
            es.weight, s.active,
            (SELECT count(*)::int FROM topics t WHERE t.subject_id = s.id AND t.active) AS topics_total,
            (SELECT count(*)::int FROM exam_topics et JOIN topics t ON t.id = et.topic_id
              WHERE et.exam_id = $1 AND t.subject_id = s.id) AS topics_in_exam,
            (SELECT count(*)::int FROM lessons l WHERE l.subject_id = s.id AND l.active) AS lessons_total
       FROM exam_subjects es
       JOIN subjects s ON s.id = es.subject_id
       LEFT JOIN areas a ON a.id = s.area_id
      WHERE es.exam_id = $1
      ORDER BY a.sort_order NULLS LAST, s.sort_order, s.name`,
    [examId]
  );
}

// ---------------------------------------------------------------------------
// Listagem e leitura
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const clauses = [];
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.q) {
      const like = push(`%${query.q}%`);
      clauses.push(`(fe_unaccent(e.name) ILIKE fe_unaccent(${like}) OR fe_unaccent(e.short_name) ILIKE fe_unaccent(${like}))`);
    }
    if (query.track) clauses.push(`e.track = ${push(query.track)}`);
    if (query.status) clauses.push(`e.active = ${push(query.status === 'active')}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const items = await db.many(`${SELECT_EXAM} ${where} ORDER BY e.sort_order, e.name`, params);
    res.json({ items, total: items.length });
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const exam = await db.one(`${SELECT_EXAM} WHERE e.id = $1`, [id]);
    if (!exam) throw new AppError(404, 'not_found', 'Vestibular não encontrado.');

    const [subjects, criteria] = await Promise.all([
      loadExamSubjects(id),
      db.one(
        `SELECT id, name, max_score, genre, min_lines, max_lines, active,
                jsonb_array_length(criteria) AS criteria_count
           FROM essay_criteria_sets WHERE exam_id = $1`,
        [id]
      ),
    ]);

    exam.subjects = subjects;
    exam.essay_criteria = criteria
      ? { ...criteria, criteria_count: Number(criteria.criteria_count) || 0 }
      : null;
    res.json(exam);
  })
);

router.get(
  '/:id/topics',
  validate({ params: idParams, query: z.object({ subject_id: z.preprocess(emptyToUndefined, uuid.optional()) }) }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    await requireExam(id);
    const { subject_id: subjectId } = req.valid.query;
    const params = [id];
    let filter = '';
    if (subjectId) {
      params.push(subjectId);
      filter = `AND t.subject_id = $${params.length}`;
    }
    const items = await db.many(
      `SELECT t.id, t.subject_id, s.name AS subject_name, t.slug, t.name, t.sort_order, t.active,
              (et.topic_id IS NOT NULL) AS in_exam, et.weight,
              (SELECT count(*)::int FROM lessons l WHERE l.topic_id = t.id AND l.active) AS lessons_total
         FROM topics t
         JOIN subjects s ON s.id = t.subject_id
         LEFT JOIN exam_topics et ON et.topic_id = t.id AND et.exam_id = $1
        WHERE t.active ${filter}
        ORDER BY s.sort_order, s.name, t.sort_order, t.name`,
      params
    );
    res.json({ items, total: items.length });
  })
);

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------
router.post(
  '/',
  validate({ body: createBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const slug = body.slug
      ? await uniqueSlug(body.slug, async (candidate) => Boolean(await db.one('SELECT 1 FROM exams WHERE slug = $1', [candidate])))
      : await uniqueSlug(body.name, async (candidate) => Boolean(await db.one('SELECT 1 FROM exams WHERE slug = $1', [candidate])));
    const order = body.sort_order ?? Number((await db.one('SELECT coalesce(max(sort_order), 0) + 1 AS next FROM exams')).next);

    const id = await db.tx(async (client) => {
      const row = await client.one(
        `INSERT INTO exams (slug, name, short_name, track, board, description, exam_date, has_essay,
                            essay_max_score, score_max, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, name, essay_max_score`,
        [
          slug, body.name, body.short_name || body.name.slice(0, 40), body.track, body.board ?? null,
          body.description ?? null, body.exam_date ?? null, body.has_essay ?? true, body.essay_max_score ?? 1000,
          body.score_max ?? null, body.active ?? true, order,
        ]
      );
      await createEmptyCriteriaSet(client, row);
      return row.id;
    });

    const exam = await db.one(`${SELECT_EXAM} WHERE e.id = $1`, [id]);
    exam.subjects = [];
    await audit(req, 'exam.create', 'exam', id, { name: body.name, track: body.track });
    res.status(201).json(exam);
  })
);

router.put(
  '/:id',
  validate({ params: idParams, body: updateBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    await requireExam(id);

    const sets = [];
    const params = [];
    for (const key of WRITABLE) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      params.push(body[key]);
      sets.push(`${key} = $${params.length}`);
    }
    if (sets.length) {
      params.push(id);
      await db.query(`UPDATE exams SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    const exam = await db.one(`${SELECT_EXAM} WHERE e.id = $1`, [id]);
    exam.subjects = await loadExamSubjects(id);
    await audit(req, 'exam.update', 'exam', id, { changes: Object.keys(body) });
    res.json(exam);
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const exam = await requireExam(id);
    const counts = await db.one(
      `SELECT (SELECT count(*) FROM student_profiles WHERE exam_id = $1)::int AS students,
              (SELECT count(*) FROM essays WHERE exam_id = $1)::int AS essays,
              (SELECT count(*) FROM past_exams WHERE exam_id = $1)::int AS past_exams`,
      [id]
    );
    if (counts.students > 0 || counts.essays > 0) {
      const parts = [];
      if (counts.students) parts.push(`${counts.students} aluno(s)`);
      if (counts.essays) parts.push(`${counts.essays} redação(ões)`);
      throw new AppError(409, 'conflict', `Esta prova tem ${parts.join(' e ')} vinculados. Desative-a em vez de excluir.`, counts);
    }
    await db.query('DELETE FROM exams WHERE id = $1', [id]);
    await audit(req, 'exam.delete', 'exam', id, { name: exam.name });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Matérias e conteúdo programático
// ---------------------------------------------------------------------------
router.put(
  '/:id/subjects',
  validate({ params: idParams, body: subjectsBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    await requireExam(id);
    const list = req.valid.body.subjects || [];
    const ids = Array.from(new Set(list.map((item) => item.subject_id)));
    if (ids.length) {
      const found = await db.many('SELECT id FROM subjects WHERE id = ANY($1::uuid[])', [ids]);
      if (found.length !== ids.length) {
        throw new AppError(400, 'validation_error', 'Uma ou mais matérias informadas não existem.', [
          { path: 'subjects', message: 'Matéria não encontrada.' },
        ]);
      }
    }

    await db.tx(async (client) => {
      await client.query('DELETE FROM exam_subjects WHERE exam_id = $1 AND NOT (subject_id = ANY($2::uuid[]))', [id, ids]);
      // o conteúdo programático acompanha as matérias: assuntos de matérias removidas saem do syllabus
      await client.query(
        `DELETE FROM exam_topics et USING topics t
          WHERE et.topic_id = t.id AND et.exam_id = $1 AND NOT (t.subject_id = ANY($2::uuid[]))`,
        [id, ids]
      );
      for (const item of list) {
        await client.query(
          `INSERT INTO exam_subjects (exam_id, subject_id, weight) VALUES ($1, $2, $3)
           ON CONFLICT (exam_id, subject_id) DO UPDATE SET weight = EXCLUDED.weight`,
          [id, item.subject_id, item.weight ?? 1]
        );
      }
    });

    const subjects = await loadExamSubjects(id);
    await audit(req, 'exam.subjects', 'exam', id, { count: subjects.length });
    res.json({ exam_id: id, subjects });
  })
);

router.put(
  '/:id/topics',
  validate({ params: idParams, body: topicsBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    await requireExam(id);
    const list = req.valid.body.topics || [];
    const scopeSubjectId = req.valid.body.subject_id || null;
    const ids = Array.from(new Set(list.map((item) => item.topic_id)));

    let topics = [];
    if (ids.length) {
      topics = await db.many('SELECT id, subject_id FROM topics WHERE id = ANY($1::uuid[])', [ids]);
      if (topics.length !== ids.length) {
        throw new AppError(400, 'validation_error', 'Um ou mais assuntos informados não existem.', [
          { path: 'topics', message: 'Assunto não encontrado.' },
        ]);
      }
      if (scopeSubjectId && topics.some((topic) => topic.subject_id !== scopeSubjectId)) {
        throw new AppError(400, 'validation_error', 'Há assuntos de outra matéria na lista enviada.', [
          { path: 'topics', message: 'Assunto de outra matéria.' },
        ]);
      }
    }

    await db.tx(async (client) => {
      if (scopeSubjectId) {
        await client.query(
          `DELETE FROM exam_topics et USING topics t
            WHERE et.topic_id = t.id AND et.exam_id = $1 AND t.subject_id = $2 AND NOT (et.topic_id = ANY($3::uuid[]))`,
          [id, scopeSubjectId, ids]
        );
      } else {
        await client.query('DELETE FROM exam_topics WHERE exam_id = $1 AND NOT (topic_id = ANY($2::uuid[]))', [id, ids]);
      }
      for (const item of list) {
        await client.query(
          `INSERT INTO exam_topics (exam_id, topic_id, weight) VALUES ($1, $2, $3)
           ON CONFLICT (exam_id, topic_id) DO UPDATE SET weight = EXCLUDED.weight`,
          [id, item.topic_id, item.weight ?? 1]
        );
      }
      // toda matéria com assunto no syllabus precisa constar em exam_subjects
      const subjectIds = Array.from(new Set(topics.map((topic) => topic.subject_id)));
      if (subjectIds.length) {
        await client.query(
          `INSERT INTO exam_subjects (exam_id, subject_id)
           SELECT $1, s FROM unnest($2::uuid[]) AS s ON CONFLICT DO NOTHING`,
          [id, subjectIds]
        );
      }
    });

    const total = await db.one('SELECT count(*)::int AS total FROM exam_topics WHERE exam_id = $1', [id]);
    await audit(req, 'exam.topics', 'exam', id, { count: list.length, subject_id: scopeSubjectId });
    res.json({ exam_id: id, subject_id: scopeSubjectId, saved: list.length, topics_total: total.total });
  })
);

router.post(
  '/:id/topics/bulk',
  validate({ params: idParams, body: bulkBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    await requireExam(id);
    const { subject_id: subjectId, weight: itemWeight } = req.valid.body;
    const include = req.valid.body.all !== false;

    const subject = await db.one('SELECT id, name FROM subjects WHERE id = $1', [subjectId]);
    if (!subject) {
      throw new AppError(400, 'validation_error', 'Matéria não encontrada.', [{ path: 'subject_id', message: 'Matéria não encontrada.' }]);
    }

    const affected = await db.tx(async (client) => {
      if (!include) {
        const result = await client.query(
          `DELETE FROM exam_topics et USING topics t
            WHERE et.topic_id = t.id AND et.exam_id = $1 AND t.subject_id = $2`,
          [id, subjectId]
        );
        return result.rowCount;
      }
      await client.query(
        `INSERT INTO exam_subjects (exam_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, subjectId]
      );
      const result = await client.query(
        `INSERT INTO exam_topics (exam_id, topic_id, weight)
         SELECT $1, t.id, $3 FROM topics t WHERE t.subject_id = $2 AND t.active
         ON CONFLICT (exam_id, topic_id) DO NOTHING`,
        [id, subjectId, itemWeight ?? 1]
      );
      return result.rowCount;
    });

    const total = await db.one(
      `SELECT count(*)::int AS total FROM exam_topics et JOIN topics t ON t.id = et.topic_id
        WHERE et.exam_id = $1 AND t.subject_id = $2`,
      [id, subjectId]
    );
    await audit(req, include ? 'exam.topics.bulk_add' : 'exam.topics.bulk_remove', 'exam', id, {
      subject_id: subjectId,
      affected,
    });
    res.json({ exam_id: id, subject_id: subjectId, included: include, affected, topics_in_exam: total.total });
  })
);

module.exports = { basePath: '/api/admin/exams', router };
