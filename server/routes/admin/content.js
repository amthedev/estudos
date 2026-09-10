'use strict';

/**
 * Painel administrativo — biblioteca de conteúdo (áreas → matérias → assuntos → subassuntos).
 *
 *   GET    /api/admin/content/tree                       árvore completa com contagens de aulas/questões
 *   GET    /api/admin/content/subjects|topics|subtopics  listas simples (para selects encadeados)
 *   POST   /api/admin/content/<tipo>                     cria (slug gerado a partir do nome, único no escopo)
 *   PUT    /api/admin/content/<tipo>/:id                 edita (parcial; renomear mantém o slug)
 *   DELETE /api/admin/content/<tipo>/:id                 exclui — 409 quando há vínculos (com contagens)
 *   PATCH  /api/admin/content/<tipo>/reorder { ids[] }   define sort_order pela posição em ids
 *   PUT    /api/admin/content/topics/:id/exams { exam_ids[] }  provas em que o assunto cai (exam_topics)
 *
 * Também exporta `ensureExamCoverage`, usado por aulas e questões para garantir que, ao vincular
 * conteúdo a uma prova, o assunto (exam_topics) e a matéria (exam_subjects) passem a fazer parte
 * do conteúdo programático daquela prova.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { uniqueSlug } = require('../../utils/slug');

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const nameField = z.string().trim().min(2, 'Informe pelo menos 2 caracteres.').max(120);
const descriptionField = z.string().trim().max(2000).nullable().optional();
const sortField = z.coerce.number().int().min(0).max(100000).optional();
const activeField = z.boolean().optional();
const iconField = z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/, 'Nome de ícone inválido.').optional();
const colorField = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Cor no formato #RRGGBB.').optional();
const examIdsField = z.array(uuid).max(100).optional();

const reorderSchema = z.object({ ids: z.array(uuid).min(1).max(5000) });

const areaCreate = z.object({ name: nameField, sort_order: sortField });
const areaUpdate = z.object({ name: nameField.optional(), sort_order: sortField }).refine((v) => Object.keys(v).length > 0, 'Nada para atualizar.');

const subjectCreate = z.object({
  area_id: uuid.nullable().optional(),
  name: nameField,
  description: descriptionField,
  icon: iconField,
  color: colorField,
  sort_order: sortField,
  active: activeField,
});
const subjectUpdate = subjectCreate.partial().refine((v) => Object.keys(v).length > 0, 'Nada para atualizar.');

const topicCreate = z.object({
  subject_id: uuid,
  name: nameField,
  description: descriptionField,
  sort_order: sortField,
  active: activeField,
  exam_ids: examIdsField,
});
const topicUpdate = topicCreate.omit({ subject_id: true }).partial().refine((v) => Object.keys(v).length > 0, 'Nada para atualizar.');

const subtopicCreate = z.object({
  topic_id: uuid,
  name: nameField,
  description: descriptionField,
  sort_order: sortField,
  active: activeField,
});
const subtopicUpdate = subtopicCreate.omit({ topic_id: true }).partial().refine((v) => Object.keys(v).length > 0, 'Nada para atualizar.');

const listQuery = z.object({
  subject_id: uuid.optional(),
  topic_id: uuid.optional(),
  active: z.enum(['1', '0', 'true', 'false']).optional(),
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Garante que todas as provas informadas existem; devolve a lista sem repetição. */
async function assertExamsExist(client, examIds) {
  const ids = Array.from(new Set(examIds || []));
  if (!ids.length) return [];
  const rows = await client.many('SELECT id FROM exams WHERE id = ANY($1::uuid[])', [ids]);
  if (rows.length !== ids.length) {
    throw new AppError(400, 'validation_error', 'Uma ou mais provas informadas não existem.', [
      { path: 'exam_ids', message: 'Prova não encontrada.' },
    ]);
  }
  return ids;
}

/**
 * Garante que o assunto e a matéria façam parte do conteúdo programático das provas indicadas.
 * Não altera pesos já cadastrados (ON CONFLICT DO NOTHING).
 * @param {{ query: Function }} client  pool ou client de transação
 * @param {string[]} examIds
 * @param {{ topicId?: string, subjectId?: string }} target
 */
async function ensureExamCoverage(client, examIds, { topicId, subjectId } = {}) {
  const ids = Array.from(new Set(examIds || []));
  if (!ids.length) return;
  if (subjectId) {
    await client.query(
      `INSERT INTO exam_subjects (exam_id, subject_id)
       SELECT e, $2 FROM unnest($1::uuid[]) AS e
       ON CONFLICT DO NOTHING`,
      [ids, subjectId]
    );
  }
  if (topicId) {
    await client.query(
      `INSERT INTO exam_topics (exam_id, topic_id)
       SELECT e, $2 FROM unnest($1::uuid[]) AS e
       ON CONFLICT DO NOTHING`,
      [ids, topicId]
    );
  }
}

/** Substitui o conjunto de provas de um assunto (mantém pesos das que já existiam). */
async function replaceTopicExams(client, topicId, subjectId, examIds) {
  const ids = Array.from(new Set(examIds || []));
  await client.query('DELETE FROM exam_topics WHERE topic_id = $1 AND NOT (exam_id = ANY($2::uuid[]))', [topicId, ids]);
  await ensureExamCoverage(client, ids, { topicId, subjectId });
}

async function nextSortOrder(table, whereSql = '', params = []) {
  const row = await db.one(`SELECT coalesce(max(sort_order), 0) + 1 AS next FROM ${table} ${whereSql}`, params);
  return Number(row.next) || 1;
}

/** Monta SET dinâmico a partir de um objeto de campos permitidos. */
function buildUpdate(fields, allowed) {
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    params.push(fields[key]);
    sets.push(`${key} = $${params.length}`);
  }
  return { sets, params };
}

function toBool(value) {
  if (value === undefined) return undefined;
  return value === '1' || value === 'true';
}

const pluralPt = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;

// ---------------------------------------------------------------------------
// árvore
// ---------------------------------------------------------------------------
router.get(
  '/tree',
  wrap(async (req, res) => {
    const [areas, subjects, topics, subtopics, exams] = await Promise.all([
      db.many('SELECT id, slug, name, sort_order FROM areas ORDER BY sort_order, name'),
      db.many(
        `SELECT s.id, s.area_id, s.slug, s.name, s.description, s.icon, s.color, s.sort_order, s.active,
                coalesce(l.c, 0)::int AS lessons_count,
                coalesce(q.c, 0)::int AS questions_count,
                coalesce(t.c, 0)::int AS topics_count
           FROM subjects s
           LEFT JOIN (SELECT subject_id, count(*) AS c FROM lessons GROUP BY subject_id) l ON l.subject_id = s.id
           LEFT JOIN (SELECT subject_id, count(*) AS c FROM questions GROUP BY subject_id) q ON q.subject_id = s.id
           LEFT JOIN (SELECT subject_id, count(*) AS c FROM topics GROUP BY subject_id) t ON t.subject_id = s.id
          ORDER BY s.sort_order, s.name`
      ),
      db.many(
        `SELECT t.id, t.subject_id, t.slug, t.name, t.description, t.sort_order, t.active,
                coalesce(l.c, 0)::int AS lessons_count,
                coalesce(q.c, 0)::int AS questions_count,
                coalesce(st.c, 0)::int AS subtopics_count,
                coalesce(ex.ids, '{}'::uuid[]) AS exam_ids
           FROM topics t
           LEFT JOIN (SELECT topic_id, count(*) AS c FROM lessons GROUP BY topic_id) l ON l.topic_id = t.id
           LEFT JOIN (SELECT topic_id, count(*) AS c FROM questions GROUP BY topic_id) q ON q.topic_id = t.id
           LEFT JOIN (SELECT topic_id, count(*) AS c FROM subtopics GROUP BY topic_id) st ON st.topic_id = t.id
           LEFT JOIN (SELECT topic_id, array_agg(exam_id) AS ids FROM exam_topics GROUP BY topic_id) ex ON ex.topic_id = t.id
          ORDER BY t.subject_id, t.sort_order, t.name`
      ),
      db.many(
        `SELECT st.id, st.topic_id, st.slug, st.name, st.description, st.sort_order, st.active,
                coalesce(l.c, 0)::int AS lessons_count,
                coalesce(q.c, 0)::int AS questions_count
           FROM subtopics st
           LEFT JOIN (SELECT subtopic_id, count(*) AS c FROM lessons WHERE subtopic_id IS NOT NULL GROUP BY subtopic_id) l ON l.subtopic_id = st.id
           LEFT JOIN (SELECT subtopic_id, count(*) AS c FROM questions WHERE subtopic_id IS NOT NULL GROUP BY subtopic_id) q ON q.subtopic_id = st.id
          ORDER BY st.topic_id, st.sort_order, st.name`
      ),
      db.many('SELECT id, slug, name, short_name, track, active FROM exams ORDER BY sort_order, name'),
    ]);

    const subtopicsByTopic = new Map();
    for (const st of subtopics) {
      if (!subtopicsByTopic.has(st.topic_id)) subtopicsByTopic.set(st.topic_id, []);
      subtopicsByTopic.get(st.topic_id).push(st);
    }
    const topicsBySubject = new Map();
    for (const t of topics) {
      t.subtopics = subtopicsByTopic.get(t.id) || [];
      if (!topicsBySubject.has(t.subject_id)) topicsBySubject.set(t.subject_id, []);
      topicsBySubject.get(t.subject_id).push(t);
    }
    const subjectsByArea = new Map();
    for (const s of subjects) {
      s.topics = topicsBySubject.get(s.id) || [];
      const key = s.area_id || null;
      if (!subjectsByArea.has(key)) subjectsByArea.set(key, []);
      subjectsByArea.get(key).push(s);
    }

    const tree = areas.map((a) => ({ ...a, subjects: subjectsByArea.get(a.id) || [] }));
    const orphan = subjectsByArea.get(null) || [];
    if (orphan.length) tree.push({ id: null, slug: null, name: 'Sem área', sort_order: 99999, subjects: orphan });

    res.json({
      areas: tree,
      exams,
      totals: {
        areas: areas.length,
        subjects: subjects.length,
        topics: topics.length,
        subtopics: subtopics.length,
        lessons: subjects.reduce((acc, s) => acc + s.lessons_count, 0),
        questions: subjects.reduce((acc, s) => acc + s.questions_count, 0),
      },
    });
  })
);

// ---------------------------------------------------------------------------
// listas simples (selects encadeados)
// ---------------------------------------------------------------------------
router.get(
  '/areas',
  wrap(async (req, res) => {
    res.json(await db.many('SELECT id, slug, name, sort_order FROM areas ORDER BY sort_order, name'));
  })
);

router.get(
  '/subjects',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const active = toBool(req.valid.query.active);
    const params = [];
    let where = '';
    if (active !== undefined) {
      params.push(active);
      where = `WHERE s.active = $${params.length}`;
    }
    res.json(
      await db.many(
        `SELECT s.id, s.area_id, a.name AS area_name, s.slug, s.name, s.icon, s.color, s.sort_order, s.active
           FROM subjects s LEFT JOIN areas a ON a.id = s.area_id ${where}
          ORDER BY a.sort_order NULLS LAST, s.sort_order, s.name`,
        params
      )
    );
  })
);

router.get(
  '/topics',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const { subject_id } = req.valid.query;
    const active = toBool(req.valid.query.active);
    const clauses = [];
    const params = [];
    if (subject_id) {
      params.push(subject_id);
      clauses.push(`t.subject_id = $${params.length}`);
    }
    if (active !== undefined) {
      params.push(active);
      clauses.push(`t.active = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    res.json(
      await db.many(
        `SELECT t.id, t.subject_id, t.slug, t.name, t.sort_order, t.active,
                (SELECT count(*) FROM subtopics st WHERE st.topic_id = t.id)::int AS subtopics_count
           FROM topics t ${where}
          ORDER BY t.sort_order, t.name`,
        params
      )
    );
  })
);

router.get(
  '/subtopics',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const { topic_id } = req.valid.query;
    const active = toBool(req.valid.query.active);
    const clauses = [];
    const params = [];
    if (topic_id) {
      params.push(topic_id);
      clauses.push(`topic_id = $${params.length}`);
    }
    if (active !== undefined) {
      params.push(active);
      clauses.push(`active = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    res.json(
      await db.many(`SELECT id, topic_id, slug, name, sort_order, active FROM subtopics ${where} ORDER BY sort_order, name`, params)
    );
  })
);

// ---------------------------------------------------------------------------
// reordenação (uma rota por tipo, antes de /:id)
// ---------------------------------------------------------------------------
const REORDER_TABLES = { areas: 'areas', subjects: 'subjects', topics: 'topics', subtopics: 'subtopics' };

for (const [type, table] of Object.entries(REORDER_TABLES)) {
  router.patch(
    `/${type}/reorder`,
    validate({ body: reorderSchema }),
    wrap(async (req, res) => {
      const ids = Array.from(new Set(req.valid.body.ids));
      const updated = await db.tx(async (client) => {
        const result = await client.query(
          `UPDATE ${table} AS t SET sort_order = o.position
             FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
            WHERE t.id = o.id`,
          [ids]
        );
        return result.rowCount;
      });
      await audit(req, `content.${type}.reorder`, type, null, { count: updated });
      res.json({ ok: true, updated });
    })
  );
}

// ---------------------------------------------------------------------------
// áreas
// ---------------------------------------------------------------------------
router.post(
  '/areas',
  validate({ body: areaCreate }),
  wrap(async (req, res) => {
    const { name, sort_order } = req.valid.body;
    const slug = await uniqueSlug(name, async (s) => Boolean(await db.one('SELECT 1 FROM areas WHERE slug = $1', [s])));
    const order = sort_order ?? (await nextSortOrder('areas'));
    const area = await db.one('INSERT INTO areas (slug, name, sort_order) VALUES ($1, $2, $3) RETURNING *', [slug, name, order]);
    await audit(req, 'content.area.create', 'area', area.id, { name });
    res.status(201).json(area);
  })
);

router.put(
  '/areas/:id',
  validate({ params: idParams, body: areaUpdate }),
  wrap(async (req, res) => {
    const { sets, params } = buildUpdate(req.valid.body, ['name', 'sort_order']);
    params.push(req.valid.params.id);
    const area = await db.one(`UPDATE areas SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!area) throw new AppError(404, 'not_found', 'Área não encontrada.');
    await audit(req, 'content.area.update', 'area', area.id, req.valid.body);
    res.json(area);
  })
);

router.delete(
  '/areas/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const area = await db.one('SELECT id, name FROM areas WHERE id = $1', [id]);
    if (!area) throw new AppError(404, 'not_found', 'Área não encontrada.');
    const count = await db.one('SELECT count(*)::int AS c FROM subjects WHERE area_id = $1', [id]);
    if (count.c > 0) {
      throw new AppError(409, 'conflict', `A área possui ${pluralPt(count.c, 'matéria', 'matérias')}. Mova as matérias antes de excluir.`, { subjects: count.c });
    }
    await db.query('DELETE FROM areas WHERE id = $1', [id]);
    await audit(req, 'content.area.delete', 'area', id, { name: area.name });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// matérias
// ---------------------------------------------------------------------------
router.post(
  '/subjects',
  validate({ body: subjectCreate }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    if (body.area_id) {
      const area = await db.one('SELECT id FROM areas WHERE id = $1', [body.area_id]);
      if (!area) throw new AppError(400, 'validation_error', 'Área não encontrada.', [{ path: 'area_id', message: 'Área não encontrada.' }]);
    }
    const slug = await uniqueSlug(body.name, async (s) => Boolean(await db.one('SELECT 1 FROM subjects WHERE slug = $1', [s])));
    const order = body.sort_order ?? (await nextSortOrder('subjects', 'WHERE area_id IS NOT DISTINCT FROM $1', [body.area_id ?? null]));
    const subject = await db.one(
      `INSERT INTO subjects (area_id, slug, name, description, icon, color, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [body.area_id ?? null, slug, body.name, body.description ?? null, body.icon ?? 'book-open', body.color ?? '#2F80ED', order, body.active ?? true]
    );
    await audit(req, 'content.subject.create', 'subject', subject.id, { name: body.name });
    res.status(201).json(subject);
  })
);

router.put(
  '/subjects/:id',
  validate({ params: idParams, body: subjectUpdate }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    if (body.area_id) {
      const area = await db.one('SELECT id FROM areas WHERE id = $1', [body.area_id]);
      if (!area) throw new AppError(400, 'validation_error', 'Área não encontrada.', [{ path: 'area_id', message: 'Área não encontrada.' }]);
    }
    const { sets, params } = buildUpdate(body, ['area_id', 'name', 'description', 'icon', 'color', 'sort_order', 'active']);
    params.push(req.valid.params.id);
    const subject = await db.one(`UPDATE subjects SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!subject) throw new AppError(404, 'not_found', 'Matéria não encontrada.');
    await audit(req, 'content.subject.update', 'subject', subject.id, body);
    res.json(subject);
  })
);

router.delete(
  '/subjects/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const subject = await db.one('SELECT id, name FROM subjects WHERE id = $1', [id]);
    if (!subject) throw new AppError(404, 'not_found', 'Matéria não encontrada.');
    const counts = await db.one(
      `SELECT (SELECT count(*) FROM topics WHERE subject_id = $1)::int AS topics,
              (SELECT count(*) FROM lessons WHERE subject_id = $1)::int AS lessons,
              (SELECT count(*) FROM questions WHERE subject_id = $1)::int AS questions`,
      [id]
    );
    if (counts.topics > 0 || counts.lessons > 0 || counts.questions > 0) {
      const parts = [];
      if (counts.topics) parts.push(pluralPt(counts.topics, 'assunto', 'assuntos'));
      if (counts.lessons) parts.push(pluralPt(counts.lessons, 'aula', 'aulas'));
      if (counts.questions) parts.push(pluralPt(counts.questions, 'questão', 'questões'));
      throw new AppError(409, 'conflict', `A matéria possui ${parts.join(', ')}. Remova ou mova esse conteúdo antes de excluir.`, counts);
    }
    await db.query('DELETE FROM subjects WHERE id = $1', [id]);
    await audit(req, 'content.subject.delete', 'subject', id, { name: subject.name });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// assuntos
// ---------------------------------------------------------------------------
router.post(
  '/topics',
  validate({ body: topicCreate }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const subject = await db.one('SELECT id FROM subjects WHERE id = $1', [body.subject_id]);
    if (!subject) throw new AppError(400, 'validation_error', 'Matéria não encontrada.', [{ path: 'subject_id', message: 'Matéria não encontrada.' }]);
    const examIds = await assertExamsExist(db, body.exam_ids);
    const slug = await uniqueSlug(body.name, async (s) => Boolean(await db.one('SELECT 1 FROM topics WHERE subject_id = $1 AND slug = $2', [body.subject_id, s])));
    const order = body.sort_order ?? (await nextSortOrder('topics', 'WHERE subject_id = $1', [body.subject_id]));

    const topic = await db.tx(async (client) => {
      const row = await client.one(
        `INSERT INTO topics (subject_id, slug, name, description, sort_order, active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [body.subject_id, slug, body.name, body.description ?? null, order, body.active ?? true]
      );
      await ensureExamCoverage(client, examIds, { topicId: row.id, subjectId: body.subject_id });
      return row;
    });
    topic.exam_ids = examIds;
    await audit(req, 'content.topic.create', 'topic', topic.id, { name: body.name, exam_ids: examIds });
    res.status(201).json(topic);
  })
);

router.put(
  '/topics/:id',
  validate({ params: idParams, body: topicUpdate }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const { id } = req.valid.params;
    const current = await db.one('SELECT id, subject_id FROM topics WHERE id = $1', [id]);
    if (!current) throw new AppError(404, 'not_found', 'Assunto não encontrado.');
    const examIds = body.exam_ids !== undefined ? await assertExamsExist(db, body.exam_ids) : null;

    const topic = await db.tx(async (client) => {
      const { sets, params } = buildUpdate(body, ['name', 'description', 'sort_order', 'active']);
      let row = current;
      if (sets.length) {
        params.push(id);
        row = await client.one(`UPDATE topics SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      } else {
        row = await client.one('SELECT * FROM topics WHERE id = $1', [id]);
      }
      if (examIds) await replaceTopicExams(client, id, current.subject_id, examIds);
      const links = await client.many('SELECT exam_id FROM exam_topics WHERE topic_id = $1', [id]);
      row.exam_ids = links.map((l) => l.exam_id);
      return row;
    });
    await audit(req, 'content.topic.update', 'topic', id, body);
    res.json(topic);
  })
);

router.put(
  '/topics/:id/exams',
  validate({ params: idParams, body: z.object({ exam_ids: z.array(uuid).max(100) }) }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const topic = await db.one('SELECT id, subject_id FROM topics WHERE id = $1', [id]);
    if (!topic) throw new AppError(404, 'not_found', 'Assunto não encontrado.');
    const examIds = await assertExamsExist(db, req.valid.body.exam_ids);
    await db.tx(async (client) => replaceTopicExams(client, id, topic.subject_id, examIds));
    await audit(req, 'content.topic.exams', 'topic', id, { exam_ids: examIds });
    res.json({ topic_id: id, exam_ids: examIds });
  })
);

router.delete(
  '/topics/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const topic = await db.one('SELECT id, name FROM topics WHERE id = $1', [id]);
    if (!topic) throw new AppError(404, 'not_found', 'Assunto não encontrado.');
    const counts = await db.one(
      `SELECT (SELECT count(*) FROM lessons WHERE topic_id = $1)::int AS lessons,
              (SELECT count(*) FROM questions WHERE topic_id = $1)::int AS questions`,
      [id]
    );
    if (counts.lessons > 0 || counts.questions > 0) {
      const parts = [];
      if (counts.lessons) parts.push(pluralPt(counts.lessons, 'aula', 'aulas'));
      if (counts.questions) parts.push(pluralPt(counts.questions, 'questão', 'questões'));
      throw new AppError(409, 'conflict', `O assunto possui ${parts.join(' e ')}. Mova ou exclua esse conteúdo antes.`, counts);
    }
    await db.query('DELETE FROM topics WHERE id = $1', [id]);
    await audit(req, 'content.topic.delete', 'topic', id, { name: topic.name });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// subassuntos
// ---------------------------------------------------------------------------
router.post(
  '/subtopics',
  validate({ body: subtopicCreate }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const topic = await db.one('SELECT id FROM topics WHERE id = $1', [body.topic_id]);
    if (!topic) throw new AppError(400, 'validation_error', 'Assunto não encontrado.', [{ path: 'topic_id', message: 'Assunto não encontrado.' }]);
    const slug = await uniqueSlug(body.name, async (s) => Boolean(await db.one('SELECT 1 FROM subtopics WHERE topic_id = $1 AND slug = $2', [body.topic_id, s])));
    const order = body.sort_order ?? (await nextSortOrder('subtopics', 'WHERE topic_id = $1', [body.topic_id]));
    const subtopic = await db.one(
      `INSERT INTO subtopics (topic_id, slug, name, description, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [body.topic_id, slug, body.name, body.description ?? null, order, body.active ?? true]
    );
    await audit(req, 'content.subtopic.create', 'subtopic', subtopic.id, { name: body.name });
    res.status(201).json(subtopic);
  })
);

router.put(
  '/subtopics/:id',
  validate({ params: idParams, body: subtopicUpdate }),
  wrap(async (req, res) => {
    const { sets, params } = buildUpdate(req.valid.body, ['name', 'description', 'sort_order', 'active']);
    params.push(req.valid.params.id);
    const subtopic = await db.one(`UPDATE subtopics SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!subtopic) throw new AppError(404, 'not_found', 'Subassunto não encontrado.');
    await audit(req, 'content.subtopic.update', 'subtopic', subtopic.id, req.valid.body);
    res.json(subtopic);
  })
);

router.delete(
  '/subtopics/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const subtopic = await db.one('SELECT id, name FROM subtopics WHERE id = $1', [id]);
    if (!subtopic) throw new AppError(404, 'not_found', 'Subassunto não encontrado.');
    const counts = await db.one(
      `SELECT (SELECT count(*) FROM lessons WHERE subtopic_id = $1)::int AS lessons,
              (SELECT count(*) FROM questions WHERE subtopic_id = $1)::int AS questions`,
      [id]
    );
    if (counts.lessons > 0 || counts.questions > 0) {
      const parts = [];
      if (counts.lessons) parts.push(pluralPt(counts.lessons, 'aula', 'aulas'));
      if (counts.questions) parts.push(pluralPt(counts.questions, 'questão', 'questões'));
      throw new AppError(409, 'conflict', `O subassunto possui ${parts.join(' e ')}. Reclassifique esse conteúdo antes de excluir.`, counts);
    }
    await db.query('DELETE FROM subtopics WHERE id = $1', [id]);
    await audit(req, 'content.subtopic.delete', 'subtopic', id, { name: subtopic.name });
    res.json({ ok: true });
  })
);

module.exports = { basePath: '/api/admin/content', router, ensureExamCoverage, assertExamsExist };
