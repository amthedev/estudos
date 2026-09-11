'use strict';

/**
 * Seed idempotente da estrutura base da plataforma (npm run seed).
 *
 *   node server/db/seed/run.js                    settings, provas, áreas, matérias, assuntos e subassuntos,
 *                                                 pesos por prova, critérios e temas de redação, planos
 *   node server/db/seed/run.js --demo             + conteúdo de demonstração (data/demo.js): aulas, questões,
 *                                                 professor e modelos de simulado
 *   node server/db/seed/run.js --force            sobrescreve também o que o painel administra
 *                                                 (settings, planos, critérios de redação e data das provas)
 *   node server/db/seed/run.js --force-criteria   restaura só os critérios de redação
 *   node server/db/seed/run.js --force-plans      restaura só os planos
 *   node server/db/seed/run.js --force-landing    restaura os textos da página inicial
 *   node server/db/seed/run.js --force-settings   restaura só as configurações
 *   node server/db/seed/run.js --quiet            imprime apenas o resumo final
 *
 * Rodar N vezes não duplica nada. Chaves de idempotência:
 *   settings              key (INSERT ... ON CONFLICT DO NOTHING; o painel é o dono do valor)
 *   exams                 slug (exam_date só é preenchida quando estiver vazia: o admin ajusta a data real)
 *   areas, subjects       slug
 *   topics                (subject_id, slug) · subtopics (topic_id, slug) · exam_topics (exam_id, topic_id)
 *   exam_subjects         (exam_id, subject_id), atualizando o peso
 *   essay_criteria_sets   exam_id (ON CONFLICT DO NOTHING; --force-criteria sobrescreve)
 *   essay_themes          (exam_id, title)
 *   plans                 slug (cria só os que faltam: preço e descrição são editados no painel)
 *   demo                  aulas por slug · questões por source 'demo:<n> …' · professor por e-mail ·
 *                         simulados por config.seed_key
 *
 * Uso programático:
 *   const { runSeed } = require('./server/db/seed/run');
 *   await runSeed({ demo: true, quiet: true });
 */

const db = require('../pool');
const { slugify } = require('../../utils/slug');

const data = {
  settings: require('./data/settings'),
  exams: require('./data/exams'),
  areas: require('./data/areas'),
  subjects: require('./data/subjects'),
  topics: require('./data/topics'),
  examSubjects: require('./data/exam_subjects'),
  essayCriteria: require('./data/essay_criteria'),
  essayThemes: require('./data/essay_themes'),
  plans: require('./data/plans'),
  landing: require('./data/landing'),
  curatedAssets: require('./data/curated_assets'),
  studyPlans: require('./data/study_plans'),
};

// ---------------------------------------------------------------------
// utilitários
// ---------------------------------------------------------------------

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')).map((arg) => arg.slice(2)));
  const force = flags.has('force');
  return {
    demo: flags.has('demo'),
    force,
    forceCriteria: force || flags.has('force-criteria'),
    forcePlans: force || flags.has('force-plans'),
    forceLanding: force || flags.has('force-landing'),
    forcePlans2: force || flags.has('force-study-plans'),
    forceSettings: force || flags.has('force-settings'),
    quiet: flags.has('quiet'),
  };
}

/** Acumula contagens por tabela para o resumo final. */
class Summary {
  constructor() {
    this.rows = new Map();
  }

  bump(table, field, amount = 1) {
    if (!this.rows.has(table)) this.rows.set(table, { created: 0, synced: 0, kept: 0, total: null });
    this.rows.get(table)[field] += amount;
  }

  /** Registra o resultado de um upsert com RETURNING (xmax = 0) AS inserted. */
  upsert(table, result) {
    if (!result || result.rowCount === 0) this.bump(table, 'kept');
    else if (result.rows[0]?.inserted) this.bump(table, 'created');
    else this.bump(table, 'synced');
  }

  async fillTotals(client) {
    for (const [table, row] of this.rows) {
      const count = await client.one(`SELECT count(*)::int AS total FROM ${table}`);
      row.total = count.total;
    }
  }

  print(log) {
    const header = `${'tabela'.padEnd(22)} ${'criadas'.padStart(8)} ${'sincron.'.padStart(9)} ${'mantidas'.padStart(9)} ${'total'.padStart(7)}`;
    log(`[seed] ${header}`);
    log(`[seed] ${'-'.repeat(header.length)}`);
    for (const [table, row] of this.rows) {
      log(
        `[seed] ${table.padEnd(22)} ${String(row.created).padStart(8)} ${String(row.synced).padStart(9)} ` +
          `${String(row.kept).padStart(9)} ${String(row.total ?? '-').padStart(7)}`
      );
    }
  }
}

/** Gera slugs únicos dentro de uma lista de nomes (subassuntos de um assunto). */
function uniqueSlugs(names) {
  const seen = new Map();
  return names.map((name) => {
    const base = slugify(name) || 'item';
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

function requireId(map, key, what) {
  const id = map.get(key);
  if (!id) throw new Error(`${what} "${key}" não encontrado(a). Confira os slugs em server/db/seed/data.`);
  return id;
}

// ---------------------------------------------------------------------
// etapas da estrutura base
// ---------------------------------------------------------------------

async function seedSettings(client, ctx) {
  for (const [key, value] of Object.entries(data.settings)) {
    const sql = ctx.forceSettings
      ? `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
         RETURNING (xmax = 0) AS inserted`
      : `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO NOTHING
         RETURNING true AS inserted`;
    const result = await client.query(sql, [key, JSON.stringify(value)]);
    ctx.summary.upsert('settings', result);
  }
}

async function seedExams(client, ctx) {
  for (const exam of data.exams) {
    const result = await client.query(
      `INSERT INTO exams (slug, name, short_name, track, board, description, exam_date, has_essay,
                          essay_max_score, score_max, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         short_name = EXCLUDED.short_name,
         track = EXCLUDED.track,
         board = EXCLUDED.board,
         description = EXCLUDED.description,
         exam_date = CASE WHEN $12 THEN EXCLUDED.exam_date ELSE coalesce(exams.exam_date, EXCLUDED.exam_date) END,
         has_essay = EXCLUDED.has_essay,
         essay_max_score = EXCLUDED.essay_max_score,
         score_max = EXCLUDED.score_max,
         sort_order = EXCLUDED.sort_order
       RETURNING id, (xmax = 0) AS inserted`,
      [
        exam.slug, exam.name, exam.short_name, exam.track, exam.board ?? null, exam.description ?? null,
        exam.exam_date ?? null, exam.has_essay ?? true, exam.essay_max_score ?? 1000, exam.score_max ?? null,
        exam.sort_order ?? 0, ctx.force,
      ]
    );
    ctx.summary.upsert('exams', result);
    ctx.exams.set(exam.slug, result.rows[0].id);
  }
}

async function seedAreas(client, ctx) {
  for (const area of data.areas) {
    const result = await client.query(
      `INSERT INTO areas (slug, name, sort_order) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order
       RETURNING id, (xmax = 0) AS inserted`,
      [area.slug, area.name, area.sort_order ?? 0]
    );
    ctx.summary.upsert('areas', result);
    ctx.areas.set(area.slug, result.rows[0].id);
  }
}

async function seedSubjects(client, ctx) {
  for (const subject of data.subjects) {
    const areaId = requireId(ctx.areas, subject.area, 'Área');
    const result = await client.query(
      `INSERT INTO subjects (area_id, slug, name, description, icon, color, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET
         area_id = EXCLUDED.area_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         icon = EXCLUDED.icon,
         color = EXCLUDED.color,
         sort_order = EXCLUDED.sort_order
       RETURNING id, (xmax = 0) AS inserted`,
      [
        areaId, subject.slug, subject.name, subject.description ?? null, subject.icon ?? 'book-open',
        subject.color ?? '#2F80ED', subject.sort_order ?? 0,
      ]
    );
    ctx.summary.upsert('subjects', result);
    ctx.subjects.set(subject.slug, result.rows[0].id);
  }
}

async function seedTopics(client, ctx) {
  for (const [subjectSlug, topics] of Object.entries(data.topics)) {
    const subjectId = requireId(ctx.subjects, subjectSlug, 'Matéria');
    const seenSlugs = new Set();

    for (let index = 0; index < topics.length; index += 1) {
      const topic = topics[index];
      if (seenSlugs.has(topic.slug)) {
        throw new Error(`Assunto duplicado em topics.js: ${subjectSlug}/${topic.slug}`);
      }
      seenSlugs.add(topic.slug);

      const topicResult = await client.query(
        `INSERT INTO topics (subject_id, slug, name, description, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (subject_id, slug) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           sort_order = EXCLUDED.sort_order
         RETURNING id, (xmax = 0) AS inserted`,
        [subjectId, topic.slug, topic.name, topic.description ?? null, index + 1]
      );
      ctx.summary.upsert('topics', topicResult);
      const topicId = topicResult.rows[0].id;
      ctx.topics.set(`${subjectSlug}/${topic.slug}`, topicId);

      // subassuntos: slug derivado do nome, único dentro do assunto
      const subtopicNames = Array.isArray(topic.subtopics) ? topic.subtopics : [];
      const subtopicSlugs = uniqueSlugs(subtopicNames);
      for (let position = 0; position < subtopicNames.length; position += 1) {
        const subResult = await client.query(
          `INSERT INTO subtopics (topic_id, slug, name, sort_order)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (topic_id, slug) DO UPDATE SET
             name = EXCLUDED.name,
             sort_order = EXCLUDED.sort_order
           RETURNING id, (xmax = 0) AS inserted`,
          [topicId, subtopicSlugs[position], subtopicNames[position], position + 1]
        );
        ctx.summary.upsert('subtopics', subResult);
        ctx.subtopics.set(`${topicId}/${subtopicSlugs[position]}`, subResult.rows[0].id);
      }

      // em quais provas o assunto cai (e com qual peso)
      const weight = Number(topic.weight) > 0 ? Number(topic.weight) : 1.0;
      for (const examSlug of topic.exams || []) {
        const examId = requireId(ctx.exams, examSlug, 'Prova');
        const linkResult = await client.query(
          `INSERT INTO exam_topics (exam_id, topic_id, weight) VALUES ($1, $2, $3)
           ON CONFLICT (exam_id, topic_id) DO UPDATE SET weight = EXCLUDED.weight
           RETURNING (xmax = 0) AS inserted`,
          [examId, topicId, weight]
        );
        ctx.summary.upsert('exam_topics', linkResult);
      }
    }
  }
}

async function seedExamSubjects(client, ctx) {
  for (const [examSlug, subjects] of Object.entries(data.examSubjects)) {
    const examId = requireId(ctx.exams, examSlug, 'Prova');
    for (const [subjectSlug, weight] of Object.entries(subjects)) {
      const subjectId = requireId(ctx.subjects, subjectSlug, 'Matéria');
      const result = await client.query(
        `INSERT INTO exam_subjects (exam_id, subject_id, weight) VALUES ($1, $2, $3)
         ON CONFLICT (exam_id, subject_id) DO UPDATE SET weight = EXCLUDED.weight
         RETURNING (xmax = 0) AS inserted`,
        [examId, subjectId, Number(weight) > 0 ? Number(weight) : 1.0]
      );
      ctx.summary.upsert('exam_subjects', result);
    }
  }
}

async function seedEssayCriteria(client, ctx) {
  for (const [examSlug, set] of Object.entries(data.essayCriteria)) {
    const examId = requireId(ctx.exams, examSlug, 'Prova');
    const sum = (set.criteria || []).reduce((acc, item) => acc + Number(item.max || 0), 0);
    if (Math.abs(sum - Number(set.max_score)) > 0.001) {
      throw new Error(`Critérios de redação de "${examSlug}": soma dos máximos (${sum}) difere de max_score (${set.max_score}).`);
    }
    const params = [
      examId, set.name, set.max_score, set.genre, JSON.stringify(set.criteria || []),
      set.instructions ?? null, set.min_lines ?? null, set.max_lines ?? null,
    ];
    const sql = ctx.forceCriteria
      ? `INSERT INTO essay_criteria_sets (exam_id, name, max_score, genre, criteria, instructions, min_lines, max_lines)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (exam_id) DO UPDATE SET
           name = EXCLUDED.name, max_score = EXCLUDED.max_score, genre = EXCLUDED.genre,
           criteria = EXCLUDED.criteria, instructions = EXCLUDED.instructions,
           min_lines = EXCLUDED.min_lines, max_lines = EXCLUDED.max_lines
         RETURNING (xmax = 0) AS inserted`
      : `INSERT INTO essay_criteria_sets (exam_id, name, max_score, genre, criteria, instructions, min_lines, max_lines)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (exam_id) DO NOTHING
         RETURNING true AS inserted`;
    const result = await client.query(sql, params);
    ctx.summary.upsert('essay_criteria_sets', result);
  }
}

async function seedEssayThemes(client, ctx) {
  for (const theme of data.essayThemes) {
    const examId = theme.exam ? requireId(ctx.exams, theme.exam, 'Prova') : null;
    const existing = await client.one(
      `SELECT id FROM essay_themes WHERE exam_id IS NOT DISTINCT FROM $1 AND title = $2 ORDER BY created_at LIMIT 1`,
      [examId, theme.title]
    );
    if (existing) {
      await client.query(
        `UPDATE essay_themes SET prompt_text = $2, support_texts = $3, source = $4, year = $5 WHERE id = $1`,
        [existing.id, theme.prompt_text ?? null, theme.support_texts ?? null, theme.source ?? null, theme.year ?? null]
      );
      ctx.summary.bump('essay_themes', 'synced');
    } else {
      await client.query(
        `INSERT INTO essay_themes (exam_id, title, prompt_text, support_texts, source, year, generated_by_ai)
         VALUES ($1, $2, $3, $4, $5, $6, false)`,
        [examId, theme.title, theme.prompt_text ?? null, theme.support_texts ?? null, theme.source ?? null, theme.year ?? null]
      );
      ctx.summary.bump('essay_themes', 'created');
    }
  }
}

async function seedPlans(client, ctx) {
  for (const plan of data.plans) {
    const params = [
      plan.slug, plan.name, plan.description ?? null, plan.price_cents ?? 0, plan.currency ?? 'brl',
      plan.interval ?? 'month', plan.interval_count ?? 1, plan.trial_days ?? 0,
      JSON.stringify(plan.features || []), plan.highlight ?? false, plan.sort_order ?? 0,
      plan.duration_months ?? plan.interval_count ?? 1, plan.bonus_months ?? 0,
      plan.compare_price_cents ?? null, plan.badge ?? null,
    ];
    const sql = ctx.forcePlans
      ? `INSERT INTO plans (slug, name, description, price_cents, currency, interval, interval_count, trial_days,
                            features, highlight, sort_order, duration_months, bonus_months,
                            compare_price_cents, badge)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, price_cents = EXCLUDED.price_cents,
           currency = EXCLUDED.currency, interval = EXCLUDED.interval, interval_count = EXCLUDED.interval_count,
           trial_days = EXCLUDED.trial_days, features = EXCLUDED.features, highlight = EXCLUDED.highlight,
           sort_order = EXCLUDED.sort_order, duration_months = EXCLUDED.duration_months,
           bonus_months = EXCLUDED.bonus_months, compare_price_cents = EXCLUDED.compare_price_cents,
           badge = EXCLUDED.badge
         RETURNING (xmax = 0) AS inserted`
      : `INSERT INTO plans (slug, name, description, price_cents, currency, interval, interval_count, trial_days,
                            features, highlight, sort_order, duration_months, bonus_months,
                            compare_price_cents, badge)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (slug) DO NOTHING
         RETURNING true AS inserted`;
    const result = await client.query(sql, params);
    ctx.summary.upsert('plans', result);
  }
}


async function seedLanding(client, ctx) {
  const { blocks, faqs, examLanding } = data.landing;

  for (const block of blocks) {
    const params = [
      block.key, block.eyebrow ?? null, block.title ?? null, block.subtitle ?? null,
      block.body ?? null, JSON.stringify(block.items || []), block.cta_label ?? null,
      block.cta_href ?? null, block.image_url ?? null, block.sort_order ?? 0,
    ];
    const sql = ctx.forceLanding
      ? `INSERT INTO landing_blocks (key, eyebrow, title, subtitle, body, items, cta_label, cta_href, image_url, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
         ON CONFLICT (key) DO UPDATE SET
           eyebrow = EXCLUDED.eyebrow, title = EXCLUDED.title, subtitle = EXCLUDED.subtitle,
           body = EXCLUDED.body, items = EXCLUDED.items, cta_label = EXCLUDED.cta_label,
           cta_href = EXCLUDED.cta_href, image_url = EXCLUDED.image_url, sort_order = EXCLUDED.sort_order
         RETURNING (xmax = 0) AS inserted`
      : `INSERT INTO landing_blocks (key, eyebrow, title, subtitle, body, items, cta_label, cta_href, image_url, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
         ON CONFLICT (key) DO NOTHING
         RETURNING true AS inserted`;
    ctx.summary.upsert('landing_blocks', await client.query(sql, params));
  }

  // perguntas frequentes: chave de idempotência é o texto da pergunta
  for (const faq of faqs) {
    const existing = await client.query('SELECT id FROM faqs WHERE question = $1', [faq.question]);
    if (existing.rowCount) {
      if (ctx.forceLanding) {
        await client.query('UPDATE faqs SET answer = $2, sort_order = $3 WHERE id = $1',
          [existing.rows[0].id, faq.answer, faq.sort_order ?? 0]);
        ctx.summary.bump('faqs', 'synced');
      } else {
        ctx.summary.bump('faqs', 'kept');
      }
      continue;
    }
    await client.query(
      'INSERT INTO faqs (question, answer, category, sort_order) VALUES ($1, $2, $3, $4)',
      [faq.question, faq.answer, faq.category ?? null, faq.sort_order ?? 0]
    );
    ctx.summary.bump('faqs', 'created');
  }

  // textos e destaque das provas na página inicial (não sobrescreve edições do painel)
  for (const exam of examLanding) {
    const sql = ctx.forceLanding
      ? `UPDATE exams SET featured = $2, landing_headline = $3, landing_text = $4, landing_cta = $5 WHERE slug = $1`
      : `UPDATE exams SET featured = $2,
             landing_headline = COALESCE(landing_headline, $3),
             landing_text     = COALESCE(landing_text, $4),
             landing_cta      = COALESCE(landing_cta, $5)
           WHERE slug = $1`;
    const result = await client.query(sql, [
      exam.slug, exam.featured ?? false, exam.landing_headline ?? null,
      exam.landing_text ?? null, exam.landing_cta ?? null,
    ]);
    if (result.rowCount) ctx.summary.bump('exams', 'synced');
  }
}

async function seedCuratedAssets(client, ctx) {
  for (const testimonial of data.curatedAssets.testimonials) {
    const existing = await client.query('SELECT id FROM testimonials WHERE image_url = $1', [testimonial.image_url]);
    if (existing.rowCount) {
      ctx.summary.bump('testimonials', 'kept');
      continue;
    }

    await client.query(
      `INSERT INTO testimonials (name, role, image_url, rating, exam_id, sort_order, active)
       VALUES ($1, $2, $3, 5, $4, $5, true)`,
      [
        testimonial.name,
        testimonial.role,
        testimonial.image_url,
        requireId(ctx.exams, testimonial.exam, 'Prova'),
        testimonial.sort_order,
      ]
    );
    ctx.summary.bump('testimonials', 'created');
  }

  for (const pastExam of data.curatedAssets.pastExams) {
    const examId = requireId(ctx.exams, pastExam.exam, 'Prova');
    const existing = await client.query('SELECT id FROM past_exams WHERE pdf_url = $1', [pastExam.pdf_url]);
    if (existing.rowCount) {
      ctx.summary.bump('past_exams', 'kept');
      continue;
    }

    await client.query(
      `INSERT INTO past_exams (exam_id, year, day, title, board, pdf_url, answer_key_url,
                               notes, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
      [
        examId,
        pastExam.year,
        pastExam.day ?? null,
        pastExam.title,
        pastExam.board ?? null,
        pastExam.pdf_url,
        pastExam.answer_key_url ?? null,
        pastExam.notes ?? null,
        pastExam.sort_order ?? 0,
      ]
    );
    ctx.summary.bump('past_exams', 'created');
  }
}


/**
 * Planos de estudo: a sequência de aulas de cada prova. Recriar o plano apaga
 * os itens antigos, então só acontece com --force-study-plans; do contrário o
 * seed apenas cria o que ainda não existe, preservando o que o admin editou.
 */
async function seedStudyPlans(client, ctx) {
  for (const plano of data.studyPlans) {
    const exam = ctx.exams.get(plano.exam);
    if (!exam) {
      ctx.warnings.push(`plano ${plano.slug}: prova ${plano.exam} não encontrada`);
      continue;
    }

    const existente = await client.one('SELECT id FROM study_plans WHERE slug = $1', [plano.slug]);
    if (existente && !ctx.forceStudyPlans) {
      ctx.summary.bump('study_plans', 'kept');
      continue;
    }

    let planId;
    if (existente) {
      await client.query(
        `UPDATE study_plans SET exam_id = $2, name = $3, description = $4, weeks = $5,
                lessons_per_week = $6, exam_every_weeks = $7, training_weekdays = $8, training_label = $9
           WHERE id = $1`,
        [
          existente.id, exam, plano.name, plano.description ?? null, plano.weeks ?? 52,
          plano.lessons_per_week ?? 3, plano.exam_every_weeks ?? 4,
          plano.training_weekdays ?? [], plano.training_label ?? null,
        ]
      );
      planId = existente.id;
      await client.query('DELETE FROM study_plan_items WHERE plan_id = $1', [planId]);
      ctx.summary.bump('study_plans', 'synced');
    } else {
      const criado = await client.one(
        `INSERT INTO study_plans (exam_id, slug, name, description, weeks, lessons_per_week,
                                  exam_every_weeks, training_weekdays, training_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          exam, plano.slug, plano.name, plano.description ?? null, plano.weeks ?? 52,
          plano.lessons_per_week ?? 3, plano.exam_every_weeks ?? 4,
          plano.training_weekdays ?? [], plano.training_label ?? null,
        ]
      );
      planId = criado.id;
      ctx.summary.bump('study_plans', 'created');
    }

    let posicao = 0;
    for (const item of plano.items) {
      posicao += 1;
      const subjectId = ctx.subjects.get(item.subject) ?? null;
      if (!subjectId) ctx.warnings.push(`plano ${plano.slug}: matéria ${item.subject} não encontrada`);
      await client.query(
        `INSERT INTO study_plan_items (plan_id, position, week, subject_id, title, kind, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [planId, posicao, item.week ?? null, subjectId, item.title, item.kind ?? 'lesson', item.notes ?? null]
      );
      ctx.summary.bump('study_plan_items', 'created');
    }
  }
}

// ---------------------------------------------------------------------
// conteúdo de demonstração
// ---------------------------------------------------------------------

/** Resolve (subject, topic, subtopic por nome) para ids, a partir dos mapas do contexto. */
function resolveContent(ctx, ref, label) {
  const subjectId = requireId(ctx.subjects, ref.subject, `Matéria de ${label}`);
  const topicId = requireId(ctx.topics, `${ref.subject}/${ref.topic}`, `Assunto de ${label}`);
  let subtopicId = null;
  if (ref.subtopic) {
    subtopicId = ctx.subtopics.get(`${topicId}/${slugify(ref.subtopic)}`) ?? null;
    if (!subtopicId) ctx.warnings.push(`${label}: subassunto "${ref.subtopic}" não encontrado em ${ref.subject}/${ref.topic}; gravado sem subassunto.`);
  }
  return { subjectId, topicId, subtopicId };
}

async function seedDemoLessons(client, ctx, lessons, teacherName) {
  for (let index = 0; index < lessons.length; index += 1) {
    const lesson = lessons[index];
    const { subjectId, topicId, subtopicId } = resolveContent(ctx, lesson, `aula "${lesson.slug}"`);
    const result = await client.query(
      `INSERT INTO lessons (subject_id, topic_id, subtopic_id, slug, title, description, video_url, video_provider,
                            thumbnail_url, duration_min, teacher_name, difficulty, summary, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, 'none', NULL, $7, $8, $9, $10, $11)
       ON CONFLICT (slug) DO UPDATE SET
         subject_id = EXCLUDED.subject_id, topic_id = EXCLUDED.topic_id, subtopic_id = EXCLUDED.subtopic_id,
         title = EXCLUDED.title, description = EXCLUDED.description, duration_min = EXCLUDED.duration_min,
         teacher_name = EXCLUDED.teacher_name, difficulty = EXCLUDED.difficulty, summary = EXCLUDED.summary,
         sort_order = EXCLUDED.sort_order
       RETURNING id, (xmax = 0) AS inserted`,
      [
        subjectId, topicId, subtopicId, lesson.slug, lesson.title, lesson.description ?? null,
        lesson.duration_min ?? 30, lesson.teacher_name ?? teacherName, lesson.difficulty ?? 2,
        lesson.summary ?? null, lesson.sort_order ?? index + 1,
      ]
    );
    ctx.summary.upsert('lessons', result);
    const lessonId = result.rows[0].id;

    for (const examSlug of lesson.exams || []) {
      const examId = requireId(ctx.exams, examSlug, 'Prova');
      const link = await client.query(
        `INSERT INTO lesson_exams (lesson_id, exam_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING true AS inserted`,
        [lessonId, examId]
      );
      ctx.summary.upsert('lesson_exams', link);
    }
  }
}

async function seedDemoQuestions(client, ctx, questions) {
  for (const question of questions) {
    const correct = question.options.filter((option) => option.is_correct);
    if (question.options.length !== 5 || correct.length !== 1) {
      throw new Error(`Questão "${question.source}" precisa de 5 alternativas e exatamente 1 correta.`);
    }
    const { subjectId, topicId, subtopicId } = resolveContent(ctx, question, `questão "${question.source}"`);

    const existing = await client.one('SELECT id FROM questions WHERE source = $1 ORDER BY created_at LIMIT 1', [question.source]);
    let questionId;
    if (existing) {
      questionId = existing.id;
      await client.query(
        `UPDATE questions SET subject_id = $2, topic_id = $3, subtopic_id = $4, statement = $5, resolution = $6,
                              explanation = $7, difficulty = $8, year = $9, board = $10
         WHERE id = $1`,
        [
          questionId, subjectId, topicId, subtopicId, question.statement, question.resolution ?? null,
          question.explanation ?? null, question.difficulty ?? 2, question.year ?? null, question.board ?? null,
        ]
      );
      ctx.summary.bump('questions', 'synced');
    } else {
      const inserted = await client.one(
        `INSERT INTO questions (subject_id, topic_id, subtopic_id, statement, resolution, explanation, difficulty,
                                year, board, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          subjectId, topicId, subtopicId, question.statement, question.resolution ?? null,
          question.explanation ?? null, question.difficulty ?? 2, question.year ?? null, question.board ?? null,
          question.source,
        ]
      );
      questionId = inserted.id;
      ctx.summary.bump('questions', 'created');
    }

    for (const option of question.options) {
      const optionResult = await client.query(
        `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (question_id, letter) DO UPDATE SET
           text = EXCLUDED.text, is_correct = EXCLUDED.is_correct, sort_order = EXCLUDED.sort_order
         RETURNING (xmax = 0) AS inserted`,
        [questionId, option.letter, option.text, option.is_correct, option.sort_order]
      );
      ctx.summary.upsert('question_options', optionResult);
    }

    for (const examSlug of question.exams || []) {
      const examId = requireId(ctx.exams, examSlug, 'Prova');
      const link = await client.query(
        `INSERT INTO question_exams (question_id, exam_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING true AS inserted`,
        [questionId, examId]
      );
      ctx.summary.upsert('question_exams', link);
    }
  }
}

async function seedDemoTeachers(client, ctx, teachers) {
  for (const teacher of teachers) {
    const existing = await client.one('SELECT id FROM teachers WHERE lower(email) = lower($1) ORDER BY created_at LIMIT 1', [teacher.email]);
    const fields = [
      teacher.name, teacher.email, teacher.phone ?? null, teacher.bio ?? null, teacher.photo_url ?? null,
      teacher.hourly_price_cents ?? 0, teacher.slot_minutes ?? 60, teacher.meeting_link ?? null, teacher.sort_order ?? 0,
    ];
    let teacherId;
    if (existing) {
      teacherId = existing.id;
      await client.query(
        `UPDATE teachers SET name = $2, email = $3, phone = $4, bio = $5, photo_url = $6, hourly_price_cents = $7,
                             slot_minutes = $8, meeting_link = $9, sort_order = $10
         WHERE id = $1`,
        [teacherId, ...fields]
      );
      ctx.summary.bump('teachers', 'synced');
    } else {
      const inserted = await client.one(
        `INSERT INTO teachers (name, email, phone, bio, photo_url, hourly_price_cents, slot_minutes, meeting_link, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        fields
      );
      teacherId = inserted.id;
      ctx.summary.bump('teachers', 'created');
    }

    for (const subjectSlug of teacher.subjects || []) {
      const subjectId = requireId(ctx.subjects, subjectSlug, 'Matéria');
      const link = await client.query(
        `INSERT INTO teacher_subjects (teacher_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING true AS inserted`,
        [teacherId, subjectId]
      );
      ctx.summary.upsert('teacher_subjects', link);
    }

    for (const slot of teacher.availability || []) {
      const result = await client.query(
        `INSERT INTO teacher_availability (teacher_id, weekday, start_time, end_time)
         SELECT $1, $2, $3::time, $4::time
         WHERE NOT EXISTS (
           SELECT 1 FROM teacher_availability
            WHERE teacher_id = $1 AND weekday = $2 AND start_time = $3::time AND end_time = $4::time
         )
         RETURNING true AS inserted`,
        [teacherId, slot.weekday, slot.start_time, slot.end_time]
      );
      ctx.summary.upsert('teacher_availability', result);
    }
  }
}

async function seedDemoSimulados(client, ctx, simulados) {
  for (const simulado of simulados) {
    const examId = simulado.exam ? requireId(ctx.exams, simulado.exam, 'Prova') : null;
    const subjectId = simulado.subject ? requireId(ctx.subjects, simulado.subject, 'Matéria') : null;
    const topicId = simulado.topic ? requireId(ctx.topics, `${simulado.subject}/${simulado.topic}`, 'Assunto') : null;
    const config = JSON.stringify({ ...(simulado.config || {}), seed_key: simulado.key });

    const existing = await client.one(`SELECT id FROM simulados WHERE config->>'seed_key' = $1 ORDER BY created_at LIMIT 1`, [simulado.key]);
    if (existing) {
      await client.query(
        `UPDATE simulados SET name = $2, description = $3, type = $4, exam_id = $5, subject_id = $6, topic_id = $7,
                              duration_min = $8, question_count = $9, config = $10::jsonb
         WHERE id = $1`,
        [
          existing.id, simulado.name, simulado.description ?? null, simulado.type, examId, subjectId, topicId,
          simulado.duration_min ?? 60, simulado.question_count ?? 20, config,
        ]
      );
      ctx.summary.bump('simulados', 'synced');
    } else {
      await client.query(
        `INSERT INTO simulados (name, description, type, exam_id, subject_id, topic_id, duration_min, question_count,
                                question_ids, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}', $9::jsonb)`,
        [
          simulado.name, simulado.description ?? null, simulado.type, examId, subjectId, topicId,
          simulado.duration_min ?? 60, simulado.question_count ?? 20, config,
        ]
      );
      ctx.summary.bump('simulados', 'created');
    }
  }
}

async function seedDemo(client, ctx) {
  const demo = require('./data/demo');
  await seedDemoLessons(client, ctx, demo.lessons || [], demo.TEACHER_NAME);
  await seedDemoQuestions(client, ctx, demo.questions || []);
  await seedDemoTeachers(client, ctx, demo.teachers || []);
  await seedDemoSimulados(client, ctx, demo.simulados || []);
}

// ---------------------------------------------------------------------
// orquestração
// ---------------------------------------------------------------------

/**
 * Executa o seed. Devolve o resumo por tabela.
 * @param {{ demo?: boolean, force?: boolean, forceCriteria?: boolean, forcePlans?: boolean,
 *           forceSettings?: boolean, quiet?: boolean, log?: Function }} options
 */
async function runSeed(options = {}) {
  const force = Boolean(options.force);
  const ctx = {
    force,
    forceCriteria: Boolean(options.forceCriteria ?? force),
    forcePlans: Boolean(options.forcePlans ?? force),
    forceLanding: Boolean(options.forceLanding ?? force),
    forceStudyPlans: Boolean(options.forcePlans2 ?? force),
    forceSettings: Boolean(options.forceSettings ?? force),
    summary: new Summary(),
    warnings: [],
    exams: new Map(),
    areas: new Map(),
    subjects: new Map(),
    topics: new Map(),
    subtopics: new Map(),
  };
  const log = options.log || console.log;
  const say = options.quiet ? () => {} : log;
  const startedAt = Date.now();

  say('[seed] estrutura base');
  await db.tx(async (client) => {
    say('[seed]   settings');            await seedSettings(client, ctx);
    say('[seed]   provas');              await seedExams(client, ctx);
    say('[seed]   áreas');               await seedAreas(client, ctx);
    say('[seed]   matérias');            await seedSubjects(client, ctx);
    say('[seed]   assuntos, subassuntos e provas por assunto'); await seedTopics(client, ctx);
    say('[seed]   pesos das matérias por prova'); await seedExamSubjects(client, ctx);
    say('[seed]   critérios de redação'); await seedEssayCriteria(client, ctx);
    say('[seed]   temas de redação');    await seedEssayThemes(client, ctx);
    say('[seed]   planos');              await seedPlans(client, ctx);
    say('[seed]   página inicial');     await seedLanding(client, ctx);
    say('[seed]   acervo de provas e resultados'); await seedCuratedAssets(client, ctx);
    say('[seed]   planos de estudo');   await seedStudyPlans(client, ctx);
  });

  if (options.demo) {
    say('[seed] conteúdo de demonstração');
    await db.tx(async (client) => {
      await seedDemo(client, ctx);
    });
  }

  await ctx.summary.fillTotals(db);

  // configurações podem ter sido criadas: invalida o cache do serviço (quando usado no mesmo processo)
  try {
    require('../../services/settings').invalidateCache();
  } catch {
    // serviço indisponível neste contexto; nada a fazer
  }

  for (const warning of ctx.warnings) log(`[seed] aviso: ${warning}`);
  log('');
  ctx.summary.print(log);
  log('');
  log(`[seed] concluído em ${((Date.now() - startedAt) / 1000).toFixed(1)}s${options.demo ? ' (com conteúdo de demonstração)' : ''}.`);
  if (options.demo) log('[seed] para remover o conteúdo de demonstração, veja docs/CONTEUDO.md.');

  return ctx.summary;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  runSeed(args)
    .then(() => db.closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(`[seed] erro: ${err.message}`);
      if (process.env.SEED_DEBUG) console.error(err.stack);
      await db.closePool().catch(() => {});
      process.exit(1);
    });
}

module.exports = { runSeed, parseArgs };
