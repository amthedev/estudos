'use strict';

/**
 * Painel administrativo — banco de questões.
 *
 *   GET    /api/admin/questions                lista paginada (q, subject_id, topic_id, subtopic_id, exam_id,
 *                                              source_exam_id, difficulty, year, board, status, sort, dir)
 *   GET    /api/admin/questions/filters        anos, bancas, matérias e provas disponíveis (para os seletores)
 *   GET    /api/admin/questions/export         ?format=json|csv — exporta o resultado dos mesmos filtros
 *   GET    /api/admin/questions/template.csv   modelo de importação (cabeçalho + uma linha de exemplo)
 *   POST   /api/admin/questions/import         importa em lote, até 2000 linhas. Corpo aceito:
 *                                              um array JSON, { items: [...] } ou { csv: "<texto do arquivo>" }
 *   GET    /api/admin/questions/:id            questão completa COM gabarito
 *   POST   /api/admin/questions                cria
 *   PUT    /api/admin/questions/:id            edita (parcial)
 *   DELETE /api/admin/questions/:id
 *
 * Regra das alternativas: de 2 a 5 opções, letras A–E sem repetição e exatamente uma correta.
 * A importação valida linha a linha: as linhas válidas são gravadas e as inválidas voltam em
 * `errors: [{ line, message }]` sem serem gravadas.
 *
 * Colunas do CSV (separador ";", com cabeçalho):
 *   statement;A;B;C;D;E;correct;resolution;explanation;subject_slug;topic_slug;subtopic_slug;difficulty;year;board;exams
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');
const { ensureExamCoverage, assertExamsExist } = require('./content');

const LETTERS = ['A', 'B', 'C', 'D', 'E'];
const MAX_IMPORT_ROWS = 2000;
const MAX_EXPORT_ROWS = 5000;
const CSV_COLUMNS = [
  'statement', 'A', 'B', 'C', 'D', 'E', 'correct', 'resolution', 'explanation',
  'subject_slug', 'topic_slug', 'subtopic_slug', 'difficulty', 'year', 'board', 'exams',
];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const optionalUuid = z.preprocess(emptyToUndefined, uuid.optional());
const nullableUuid = z.preprocess(emptyToNull, uuid.nullable().optional());
const nullableText = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const nullableUrl = z.preprocess(emptyToNull, z.string().trim().url('URL inválida.').max(2000).nullable().optional());

const optionSchema = z.object({
  letter: z.preprocess(emptyToUndefined, z.string().trim().toUpperCase().regex(/^[A-E]$/, 'Use uma letra de A a E.').optional()),
  text: z.string().trim().min(1, 'Informe o texto da alternativa.').max(4000),
  is_correct: z.boolean().optional(),
});

const optionsSchema = z
  .array(optionSchema)
  .min(2, 'Cadastre pelo menos 2 alternativas.')
  .max(5, 'Cadastre no máximo 5 alternativas.')
  .superRefine((options, ctx) => {
    const correct = options.filter((option) => option.is_correct === true).length;
    if (correct !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: correct === 0 ? 'Marque a alternativa correta.' : 'Marque apenas uma alternativa como correta.',
      });
    }
    const letters = options.map((option) => option.letter).filter(Boolean);
    if (new Set(letters).size !== letters.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Há letras repetidas nas alternativas.' });
    }
  });

const questionBody = z.object({
  statement: z.string().trim().min(10, 'O enunciado precisa ter pelo menos 10 caracteres.').max(20000),
  image_url: nullableUrl,
  options: optionsSchema,
  resolution: nullableText(20000),
  explanation: nullableText(20000),
  subject_id: uuid,
  topic_id: uuid,
  subtopic_id: nullableUuid,
  difficulty: z.coerce.number().int().min(1).max(3).optional(),
  source_exam_id: nullableUuid,
  year: z.preprocess(emptyToNull, z.coerce.number().int().min(1950).max(2100).nullable().optional()),
  board: nullableText(80),
  source: nullableText(300),
  active: z.boolean().optional(),
  exam_ids: z.array(uuid).max(100).optional(),
});
const questionUpdate = questionBody.partial().refine((body) => Object.keys(body).length > 0, 'Nada para atualizar.');

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  subject_id: optionalUuid,
  topic_id: optionalUuid,
  subtopic_id: optionalUuid,
  exam_id: optionalUuid,
  source_exam_id: optionalUuid,
  difficulty: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(3).optional()),
  year: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1950).max(2100).optional()),
  board: z.string().trim().max(80).optional(),
  status: z.preprocess(emptyToUndefined, z.enum(['active', 'inactive']).optional()),
  // Fila de conferência: o que a IA escreveu, o que ninguém olhou ainda e o
  // que aluno reclamou. É a contrapartida de a questão gerada entrar ativa.
  origem: z.preprocess(emptyToUndefined, z.enum(['ia', 'humana']).optional()),
  conferencia: z.preprocess(emptyToUndefined, z.enum(['pendente', 'feita', 'reclamada']).optional()),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

// a exportação usa os mesmos filtros da listagem, mas ignora paginação (leva tudo o que casa)
const exportQuery = listQuery
  .omit({ page: true, limit: true, sort: true, dir: true })
  .extend({ format: z.preprocess(emptyToUndefined, z.enum(['json', 'csv']).default('json')) });

const importBody = z.union([
  z.array(z.object({}).passthrough()).max(MAX_IMPORT_ROWS + 1),
  z
    .object({
      csv: z.string().max(4_000_000).optional(),
      items: z.array(z.object({}).passthrough()).max(MAX_IMPORT_ROWS + 1).optional(),
    })
    .passthrough()
    .refine((body) => typeof body.csv === 'string' || Array.isArray(body.items), 'Envie "csv" (texto) ou "items" (lista).'),
]);

const SORTABLE = {
  created_at: 'q.created_at',
  updated_at: 'q.updated_at',
  year: 'q.year',
  difficulty: 'q.difficulty',
  subject_name: 's.name',
  topic_name: 't.name',
};

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
const QUESTION_BASE = `
    FROM questions q
    JOIN subjects s ON s.id = q.subject_id
    JOIN topics t ON t.id = q.topic_id
    LEFT JOIN subtopics st ON st.id = q.subtopic_id
    LEFT JOIN exams se ON se.id = q.source_exam_id`;

const OPTIONS_JOIN = `
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id', qo.id, 'letter', qo.letter, 'text', qo.text,
                                        'is_correct', qo.is_correct, 'sort_order', qo.sort_order)
                      ORDER BY qo.sort_order, qo.letter) AS options
        FROM question_options qo WHERE qo.question_id = q.id
    ) opt ON true`;

const EXAMS_JOIN = `
    LEFT JOIN LATERAL (
      SELECT array_agg(e.id ORDER BY e.sort_order, e.name) AS exam_ids,
             json_agg(json_build_object('id', e.id, 'slug', e.slug, 'short_name', e.short_name)
                      ORDER BY e.sort_order, e.name) AS exams
        FROM question_exams qe JOIN exams e ON e.id = qe.exam_id
       WHERE qe.question_id = q.id
    ) ex ON true`;

const COMMON_COLUMNS = `
    q.id, q.subject_id, s.name AS subject_name, s.color AS subject_color,
    q.topic_id, t.name AS topic_name, q.subtopic_id, st.name AS subtopic_name,
    q.statement, q.image_url, q.difficulty, q.source_exam_id, se.short_name AS source_exam_name,
    q.year, q.board, q.source, q.active, q.created_at, q.updated_at,
    coalesce(ex.exam_ids, '{}'::uuid[]) AS exam_ids,
    coalesce(ex.exams, '[]'::json) AS exams`;

const SELECT_LIST = `
  SELECT ${COMMON_COLUMNS},
         (SELECT count(*)::int FROM question_options qo WHERE qo.question_id = q.id) AS options_count,
         (SELECT qo.letter FROM question_options qo WHERE qo.question_id = q.id AND qo.is_correct LIMIT 1) AS correct_letter,
         q.generated_by_ai, q.reviewed_at, q.lesson_id,
         (SELECT count(*)::int FROM question_reports r WHERE r.question_id = q.id AND r.status = 'aberto') AS open_reports,
         -- Gabarito trocado tem assinatura estatística: muita gente respondendo
         -- e quase ninguém acertando. Isso aparece sem depender de alguém reclamar.
         (SELECT count(*)::int FROM question_attempts qa WHERE qa.question_id = q.id) AS attempts_count,
         (SELECT count(*) FILTER (WHERE qa.is_correct)::int FROM question_attempts qa WHERE qa.question_id = q.id) AS correct_count,
         left(q.statement, 240) AS excerpt
  ${QUESTION_BASE} ${EXAMS_JOIN}`;

const SELECT_FULL = `
  SELECT ${COMMON_COLUMNS}, q.resolution, q.explanation,
         coalesce(opt.options, '[]'::json) AS options
  ${QUESTION_BASE} ${OPTIONS_JOIN} ${EXAMS_JOIN}`;

const SELECT_EXPORT = `
  SELECT q.id, q.statement, q.resolution, q.explanation, q.image_url, q.difficulty, q.year, q.board, q.source, q.active,
         s.slug AS subject_slug, s.name AS subject_name, t.slug AS topic_slug, t.name AS topic_name,
         st.slug AS subtopic_slug, se.slug AS source_exam_slug,
         coalesce(opt.options, '[]'::json) AS options,
         coalesce((SELECT array_agg(e.slug ORDER BY e.slug) FROM question_exams qe JOIN exams e ON e.id = qe.exam_id
                    WHERE qe.question_id = q.id), '{}'::text[]) AS exam_slugs
  ${QUESTION_BASE} ${OPTIONS_JOIN}`;

/** Monta WHERE + params a partir dos filtros da listagem (usado também na exportação). */
function buildFilters(query) {
  const clauses = [];
  const params = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.q) {
    const like = push(`%${query.q}%`);
    const term = push(query.q);
    clauses.push(`(fe_unaccent(q.statement) ILIKE fe_unaccent(${like})
                   OR q.search_vector @@ plainto_tsquery('portuguese', fe_unaccent(${term})))`);
  }
  if (query.subject_id) clauses.push(`q.subject_id = ${push(query.subject_id)}`);
  if (query.topic_id) clauses.push(`q.topic_id = ${push(query.topic_id)}`);
  if (query.subtopic_id) clauses.push(`q.subtopic_id = ${push(query.subtopic_id)}`);
  if (query.difficulty) clauses.push(`q.difficulty = ${push(query.difficulty)}`);
  if (query.year) clauses.push(`q.year = ${push(query.year)}`);
  if (query.board) clauses.push(`fe_unaccent(q.board) ILIKE fe_unaccent(${push(`%${query.board}%`)})`);
  if (query.source_exam_id) clauses.push(`q.source_exam_id = ${push(query.source_exam_id)}`);
  if (query.exam_id) {
    clauses.push(`EXISTS (SELECT 1 FROM question_exams qe2 WHERE qe2.question_id = q.id AND qe2.exam_id = ${push(query.exam_id)})`);
  }
  if (query.status) clauses.push(`q.active = ${push(query.status === 'active')}`);
  if (query.origem) clauses.push(`q.generated_by_ai = ${push(query.origem === 'ia')}`);
  if (query.conferencia === 'pendente') clauses.push('q.reviewed_at IS NULL');
  if (query.conferencia === 'feita') clauses.push('q.reviewed_at IS NOT NULL');
  if (query.conferencia === 'reclamada') {
    clauses.push(`EXISTS (SELECT 1 FROM question_reports r WHERE r.question_id = q.id AND r.status = 'aberto')`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// ---------------------------------------------------------------------------
// Helpers de escrita
// ---------------------------------------------------------------------------

/** Confere a coerência matéria → assunto → subassunto. */
async function assertClassification({ subject_id: subjectId, topic_id: topicId, subtopic_id: subtopicId }) {
  const topic = await db.one('SELECT id, subject_id FROM topics WHERE id = $1', [topicId]);
  if (!topic) {
    throw new AppError(400, 'validation_error', 'Assunto não encontrado.', [{ path: 'topic_id', message: 'Assunto não encontrado.' }]);
  }
  if (topic.subject_id !== subjectId) {
    throw new AppError(400, 'validation_error', 'O assunto não pertence à matéria selecionada.', [
      { path: 'topic_id', message: 'Assunto de outra matéria.' },
    ]);
  }
  if (subtopicId) {
    const subtopic = await db.one('SELECT id, topic_id FROM subtopics WHERE id = $1', [subtopicId]);
    if (!subtopic) {
      throw new AppError(400, 'validation_error', 'Subassunto não encontrado.', [{ path: 'subtopic_id', message: 'Subassunto não encontrado.' }]);
    }
    if (subtopic.topic_id !== topicId) {
      throw new AppError(400, 'validation_error', 'O subassunto não pertence ao assunto selecionado.', [
        { path: 'subtopic_id', message: 'Subassunto de outro assunto.' },
      ]);
    }
  }
}

/** Completa as letras que faltam pela posição e devolve as alternativas prontas para gravar. */
function normalizeOptions(options) {
  const used = new Set(options.map((option) => option.letter).filter(Boolean));
  let next = 0;
  return options.map((option, index) => {
    let letter = option.letter;
    if (!letter) {
      while (next < LETTERS.length && used.has(LETTERS[next])) next += 1;
      letter = LETTERS[next] || LETTERS[index] || LETTERS[LETTERS.length - 1];
      used.add(letter);
    }
    return { letter, text: option.text, is_correct: option.is_correct === true, sort_order: index + 1 };
  });
}

/** Grava as alternativas de uma questão (substitui as existentes). */
async function replaceOptions(client, questionId, options) {
  await client.query('DELETE FROM question_options WHERE question_id = $1', [questionId]);
  for (const option of options) {
    await client.query(
      `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order) VALUES ($1, $2, $3, $4, $5)`,
      [questionId, option.letter, option.text, option.is_correct, option.sort_order]
    );
  }
}

/** Substitui as provas vinculadas à questão e garante o assunto no conteúdo programático delas. */
async function replaceQuestionExams(client, questionId, examIds, { topicId, subjectId }) {
  const ids = Array.from(new Set(examIds || []));
  await client.query('DELETE FROM question_exams WHERE question_id = $1 AND NOT (exam_id = ANY($2::uuid[]))', [questionId, ids]);
  if (!ids.length) return;
  await client.query(
    'INSERT INTO question_exams (question_id, exam_id) SELECT $1, e FROM unnest($2::uuid[]) AS e ON CONFLICT DO NOTHING',
    [questionId, ids]
  );
  await ensureExamCoverage(client, ids, { topicId, subjectId });
}

/** Insere a questão com alternativas e provas. Devolve o id. */
async function insertQuestion(client, data, createdBy) {
  const row = await client.one(
    `INSERT INTO questions (subject_id, topic_id, subtopic_id, statement, image_url, resolution, explanation,
                            difficulty, source_exam_id, year, board, source, active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [
      data.subject_id, data.topic_id, data.subtopic_id ?? null, data.statement, data.image_url ?? null,
      data.resolution ?? null, data.explanation ?? null, data.difficulty ?? 2, data.source_exam_id ?? null,
      data.year ?? null, data.board ?? null, data.source ?? null, data.active ?? true, createdBy ?? null,
    ]
  );
  await replaceOptions(client, row.id, data.options);
  await replaceQuestionExams(client, row.id, data.exam_ids, { topicId: data.topic_id, subjectId: data.subject_id });
  return row.id;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Separador mais provável do cabeçalho (";" por padrão). */
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const char of firstLine) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && counts[char] !== undefined) counts[char] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ';';
}

/** Interpreta um CSV com aspas e quebras de linha dentro do campo → [{ line, cells[] }]. */
function parseCsvRecords(text, delimiter) {
  const records = [];
  let cells = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let inQuotes = false;

  const closeRecord = () => {
    cells.push(field);
    if (cells.some((cell) => cell.trim() !== '')) records.push({ line: recordLine, cells });
    cells = [];
    field = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      closeRecord();
      line += 1;
      recordLine = line;
      continue;
    }
    field += char;
  }
  if (field !== '' || cells.length) closeRecord();
  return records;
}

const HEADER_ALIASES = {
  statement: 'statement', enunciado: 'statement', questao: 'statement', pergunta: 'statement',
  a: 'A', alternativaa: 'A', b: 'B', alternativab: 'B', c: 'C', alternativac: 'C',
  d: 'D', alternativad: 'D', e: 'E', alternativae: 'E',
  correct: 'correct', correta: 'correct', gabarito: 'correct',
  resolution: 'resolution', resolucao: 'resolution',
  explanation: 'explanation', explicacao: 'explanation',
  subjectslug: 'subject_slug', materia: 'subject_slug', disciplina: 'subject_slug',
  topicslug: 'topic_slug', assunto: 'topic_slug', tema: 'topic_slug',
  subtopicslug: 'subtopic_slug', subassunto: 'subtopic_slug',
  difficulty: 'difficulty', dificuldade: 'difficulty',
  year: 'year', ano: 'year',
  board: 'board', banca: 'board',
  exams: 'exams', provas: 'exams',
  imageurl: 'image_url', imagem: 'image_url',
  source: 'source', fonte: 'source',
  active: 'active', ativo: 'active',
};

/** Normaliza o nome de uma coluna do cabeçalho para a chave canônica. */
function headerKey(raw) {
  const normalized = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return HEADER_ALIASES[normalized] || null;
}

/** Escapa um valor para CSV. */
function csvCell(value, delimiter = ';') {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (text.includes('"') || text.includes(delimiter) || /[\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

const csvLine = (cells, delimiter = ';') => cells.map((cell) => csvCell(cell, delimiter)).join(delimiter);

// ---------------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------------

/** Índices de slugs usados na importação (evita uma consulta por linha). */
async function loadSlugMaps() {
  const [subjects, topics, subtopics, exams] = await Promise.all([
    db.many('SELECT id, slug FROM subjects'),
    db.many('SELECT id, slug, subject_id FROM topics'),
    db.many('SELECT id, slug, topic_id FROM subtopics'),
    db.many('SELECT id, slug, short_name FROM exams'),
  ]);
  return {
    subjects: new Map(subjects.map((row) => [row.slug, row])),
    topics: new Map(topics.map((row) => [`${row.subject_id}:${row.slug}`, row])),
    subtopics: new Map(subtopics.map((row) => [`${row.topic_id}:${row.slug}`, row])),
    exams: new Map(exams.map((row) => [row.slug, row])),
    examsById: new Map(exams.map((row) => [row.id, row])),
  };
}

class RowError extends Error {}

const text = (value) => (value === null || value === undefined ? '' : String(value).trim());

/** Converte uma linha (CSV ou JSON) em dados prontos para gravar. Lança RowError com a mensagem do problema. */
function buildImportRow(raw, maps) {
  const statement = text(raw.statement);
  if (statement.length < 10) throw new RowError('Enunciado ausente ou curto demais (mínimo de 10 caracteres).');

  // alternativas: colunas A–E ou lista options[]
  let options = [];
  if (Array.isArray(raw.options)) {
    options = raw.options
      .map((option, index) => ({
        letter: text(option && option.letter).toUpperCase() || LETTERS[index],
        text: text(option && option.text),
        is_correct: option ? option.is_correct === true || text(option.is_correct).toLowerCase() === 'true' : false,
      }))
      .filter((option) => option.text !== '');
  } else {
    const correct = text(raw.correct).toUpperCase();
    if (!correct) throw new RowError('Informe a letra do gabarito na coluna "correct".');
    if (!LETTERS.includes(correct)) throw new RowError(`Gabarito inválido ("${correct}"): use uma letra de A a E.`);
    for (const letter of LETTERS) {
      const value = text(raw[letter]);
      if (value === '') continue;
      options.push({ letter, text: value, is_correct: letter === correct });
    }
    if (!options.some((option) => option.is_correct)) {
      throw new RowError(`A alternativa "${correct}" indicada como gabarito está vazia.`);
    }
  }
  if (options.length < 2) throw new RowError('Cadastre pelo menos 2 alternativas.');
  if (options.length > 5) throw new RowError('Cadastre no máximo 5 alternativas.');
  const correctCount = options.filter((option) => option.is_correct).length;
  if (correctCount !== 1) {
    throw new RowError(correctCount === 0 ? 'Nenhuma alternativa foi marcada como correta.' : 'Mais de uma alternativa foi marcada como correta.');
  }
  const letters = options.map((option) => option.letter);
  if (new Set(letters).size !== letters.length) throw new RowError('Há letras repetidas nas alternativas.');
  for (const letter of letters) {
    if (!LETTERS.includes(letter)) throw new RowError(`Letra de alternativa inválida ("${letter}").`);
  }

  // classificação
  let subjectId = text(raw.subject_id);
  let topicId = text(raw.topic_id);
  if (!subjectId) {
    const slug = text(raw.subject_slug);
    if (!slug) throw new RowError('Informe a matéria (subject_slug).');
    const subject = maps.subjects.get(slug);
    if (!subject) throw new RowError(`Matéria "${slug}" não encontrada.`);
    subjectId = subject.id;
  }
  if (!topicId) {
    const slug = text(raw.topic_slug);
    if (!slug) throw new RowError('Informe o assunto (topic_slug).');
    const topic = maps.topics.get(`${subjectId}:${slug}`);
    if (!topic) throw new RowError(`Assunto "${slug}" não encontrado nessa matéria.`);
    topicId = topic.id;
  }
  let subtopicId = text(raw.subtopic_id) || null;
  const subtopicSlug = text(raw.subtopic_slug);
  if (!subtopicId && subtopicSlug) {
    const subtopic = maps.subtopics.get(`${topicId}:${subtopicSlug}`);
    if (!subtopic) throw new RowError(`Subassunto "${subtopicSlug}" não encontrado nesse assunto.`);
    subtopicId = subtopic.id;
  }

  // demais campos
  const difficultyRaw = text(raw.difficulty);
  let difficulty = 2;
  if (difficultyRaw) {
    difficulty = Number.parseInt(difficultyRaw, 10);
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 3) {
      throw new RowError('Dificuldade inválida: use 1 (básico), 2 (intermediário) ou 3 (avançado).');
    }
  }
  const yearRaw = text(raw.year);
  let year = null;
  if (yearRaw) {
    year = Number.parseInt(yearRaw, 10);
    if (!Number.isInteger(year) || year < 1950 || year > 2100) throw new RowError(`Ano inválido ("${yearRaw}").`);
  }

  const examIds = [];
  const examsRaw = Array.isArray(raw.exams) ? raw.exams.join(',') : text(raw.exams);
  if (examsRaw) {
    for (const part of examsRaw.split(/[,|]/)) {
      const slug = part.trim();
      if (!slug) continue;
      const exam = maps.exams.get(slug) || maps.examsById.get(slug);
      if (!exam) throw new RowError(`Prova "${slug}" não encontrada.`);
      if (!examIds.includes(exam.id)) examIds.push(exam.id);
    }
  }

  const activeRaw = text(raw.active).toLowerCase();
  const active = activeRaw === '' ? true : !['0', 'false', 'nao', 'não', 'no', 'inativo'].includes(activeRaw);

  return {
    statement,
    image_url: text(raw.image_url) || null,
    resolution: text(raw.resolution) || null,
    explanation: text(raw.explanation) || null,
    subject_id: subjectId,
    topic_id: topicId,
    subtopic_id: subtopicId,
    difficulty,
    year,
    board: text(raw.board) || null,
    source: text(raw.source) || null,
    active,
    options: normalizeOptions(options),
    exam_ids: examIds,
  };
}

/** Transforma o corpo recebido em [{ line, raw }] e diz o formato usado. */
function collectImportRows(body) {
  if (Array.isArray(body)) {
    return { format: 'json', rows: body.map((raw, index) => ({ line: index + 1, raw: raw || {} })) };
  }
  if (Array.isArray(body.items)) {
    return { format: 'json', rows: body.items.map((raw, index) => ({ line: index + 1, raw: raw || {} })) };
  }

  const csv = String(body.csv || '').replace(/^\uFEFF/, '');
  if (!csv.trim()) throw new AppError(400, 'validation_error', 'O arquivo CSV está vazio.');
  const delimiter = detectDelimiter(csv);
  const records = parseCsvRecords(csv, delimiter);
  if (!records.length) throw new AppError(400, 'validation_error', 'O arquivo CSV está vazio.');

  const header = records[0].cells.map(headerKey);
  if (!header.includes('statement')) {
    throw new AppError(400, 'validation_error', `Cabeçalho não reconhecido. Use as colunas: ${CSV_COLUMNS.join(delimiter)}`);
  }
  const rows = records.slice(1).map((record) => {
    const raw = {};
    header.forEach((key, index) => {
      if (key) raw[key] = record.cells[index] ?? '';
    });
    return { line: record.line, raw };
  });
  return { format: 'csv', rows };
}

// ---------------------------------------------------------------------------
// Rotas utilitárias (antes de /:id)
// ---------------------------------------------------------------------------
router.get(
  '/filters',
  wrap(async (req, res) => {
    const [years, boards, subjects, exams] = await Promise.all([
      db.many('SELECT DISTINCT year FROM questions WHERE year IS NOT NULL ORDER BY year DESC'),
      db.many("SELECT DISTINCT board FROM questions WHERE board IS NOT NULL AND board <> '' ORDER BY board"),
      db.many(
        `SELECT s.id, s.name, count(q.id)::int AS questions_count
           FROM subjects s LEFT JOIN questions q ON q.subject_id = s.id
          GROUP BY s.id, s.name, s.sort_order ORDER BY s.sort_order, s.name`
      ),
      db.many('SELECT id, slug, name, short_name FROM exams ORDER BY sort_order, name'),
    ]);
    res.json({
      years: years.map((row) => row.year),
      boards: boards.map((row) => row.board),
      subjects,
      exams,
      difficulties: [
        { value: 1, label: 'Básico' },
        { value: 2, label: 'Intermediário' },
        { value: 3, label: 'Avançado' },
      ],
    });
  })
);

router.get(
  '/template.csv',
  wrap(async (req, res) => {
    // a linha de exemplo usa uma matéria e um assunto reais do banco, quando houver
    const reference = await db.one(
      `SELECT s.slug AS subject_slug, t.slug AS topic_slug
         FROM topics t JOIN subjects s ON s.id = t.subject_id
        WHERE t.active AND s.active
        ORDER BY s.sort_order, t.sort_order LIMIT 1`
    );
    const exam = await db.one('SELECT slug FROM exams WHERE active ORDER BY sort_order, name LIMIT 1');
    const example = [
      'Um capital de R$ 1.000,00 é aplicado a juros simples de 2% ao mês. Qual é o montante após 6 meses?',
      'R$ 1.060,00', 'R$ 1.100,00', 'R$ 1.120,00', 'R$ 1.126,16', 'R$ 1.200,00',
      'C',
      'Juros simples: J = C · i · t = 1000 · 0,02 · 6 = 120. Montante = 1000 + 120 = 1120.',
      'Em juros simples a taxa incide sempre sobre o capital inicial, sem capitalização.',
      reference ? reference.subject_slug : 'matematica',
      reference ? reference.topic_slug : 'porcentagem-e-juros',
      '',
      '2',
      '2024',
      'INEP',
      exam ? exam.slug : '',
    ];
    const body = `${csvLine(CSV_COLUMNS)}\n${csvLine(example)}\n`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="modelo-questoes-foco-elite.csv"');
    res.send(`\uFEFF${body}`);
  })
);

router.get(
  '/export',
  validate({ query: exportQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const { where, params } = buildFilters(query);
    const rows = await db.many(`${SELECT_EXPORT} ${where} ORDER BY s.sort_order, t.sort_order, q.created_at LIMIT $${params.length + 1}`, [
      ...params,
      MAX_EXPORT_ROWS,
    ]);

    const items = rows.map((row) => {
      const options = Array.isArray(row.options) ? row.options : [];
      const correct = options.find((option) => option.is_correct);
      return {
        id: row.id,
        statement: row.statement,
        options: options.map((option) => ({ letter: option.letter, text: option.text, is_correct: option.is_correct === true })),
        correct: correct ? correct.letter : null,
        resolution: row.resolution,
        explanation: row.explanation,
        image_url: row.image_url,
        subject_slug: row.subject_slug,
        subject_name: row.subject_name,
        topic_slug: row.topic_slug,
        topic_name: row.topic_name,
        subtopic_slug: row.subtopic_slug,
        difficulty: row.difficulty,
        year: row.year,
        board: row.board,
        source: row.source,
        active: row.active,
        exams: row.exam_slugs || [],
      };
    });

    if (query.format === 'csv') {
      const lines = [csvLine(CSV_COLUMNS)];
      for (const item of items) {
        const byLetter = new Map(item.options.map((option) => [option.letter, option.text]));
        lines.push(
          csvLine([
            item.statement,
            byLetter.get('A') || '', byLetter.get('B') || '', byLetter.get('C') || '',
            byLetter.get('D') || '', byLetter.get('E') || '',
            item.correct || '',
            item.resolution || '', item.explanation || '',
            item.subject_slug || '', item.topic_slug || '', item.subtopic_slug || '',
            item.difficulty, item.year || '', item.board || '',
            (item.exams || []).join(','),
          ])
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="questoes-foco-elite.csv"');
      return res.send(`\uFEFF${lines.join('\n')}\n`);
    }

    res.json({ items, total: items.length, exported_at: new Date().toISOString(), truncated: items.length >= MAX_EXPORT_ROWS });
  })
);

router.post(
  '/import',
  validate({ body: importBody }),
  wrap(async (req, res) => {
    const { format, rows } = collectImportRows(req.valid.body);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new AppError(400, 'validation_error', `Envie no máximo ${MAX_IMPORT_ROWS} linhas por importação.`);
    }
    if (!rows.length) throw new AppError(400, 'validation_error', 'Nenhuma linha para importar.');

    const maps = await loadSlugMaps();
    const errors = [];
    const created = [];

    for (const { line, raw } of rows) {
      let data;
      try {
        data = buildImportRow(raw, maps);
      } catch (err) {
        if (err instanceof RowError) {
          errors.push({ line, message: err.message });
          continue;
        }
        throw err;
      }
      try {
        // cada linha em sua própria transação: uma falha não desfaz as anteriores
        const id = await db.tx(async (client) => insertQuestion(client, data, req.admin ? req.admin.id : null));
        created.push(id);
      } catch (err) {
        errors.push({ line, message: 'Não foi possível gravar esta linha. Revise os dados e tente novamente.' });
        console.error(`[admin/questions] falha ao importar a linha ${line}:`, err.message);
      }
    }

    await audit(req, 'question.import', 'question', null, { format, rows: rows.length, imported: created.length, errors: errors.length });
    res.status(errors.length && !created.length ? 400 : 200).json({
      imported: created.length,
      total: rows.length,
      failed: errors.length,
      format,
      errors,
      ids: created,
    });
  })
);

// ---------------------------------------------------------------------------
// Listagem e leitura
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 20, maxLimit: 100 });
    const sort = parseSort(query, SORTABLE, { defaultSort: 'created_at', defaultDir: 'desc' });
    const { where, params } = buildFilters(query);

    const totalRow = await db.one(`SELECT count(*)::int AS total FROM questions q ${where}`, params);
    const items = await db.many(
      `${SELECT_LIST} ${where} ORDER BY ${sort.sql}, q.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json(paginate(items, totalRow.total, { page, limit }));
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const question = await db.one(`${SELECT_FULL} WHERE q.id = $1`, [req.valid.params.id]);
    if (!question) throw new AppError(404, 'not_found', 'Questão não encontrada.');
    const stats = await db.one(
      `SELECT count(*)::int AS attempts,
              count(*) FILTER (WHERE is_correct)::int AS correct
         FROM question_attempts WHERE question_id = $1`,
      [question.id]
    );
    question.stats = {
      attempts: stats.attempts,
      correct: stats.correct,
      accuracy_pct: stats.attempts ? Math.round((100 * stats.correct) / stats.attempts) : null,
    };
    res.json(question);
  })
);

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------
router.post(
  '/',
  validate({ body: questionBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    await assertClassification(body);
    const examIds = await assertExamsExist(db, body.exam_ids);
    if (body.source_exam_id) {
      const exam = await db.one('SELECT id FROM exams WHERE id = $1', [body.source_exam_id]);
      if (!exam) {
        throw new AppError(400, 'validation_error', 'Prova de origem não encontrada.', [
          { path: 'source_exam_id', message: 'Prova não encontrada.' },
        ]);
      }
    }

    const data = { ...body, exam_ids: examIds, options: normalizeOptions(body.options) };
    const id = await db.tx(async (client) => insertQuestion(client, data, req.admin ? req.admin.id : null));
    const question = await db.one(`${SELECT_FULL} WHERE q.id = $1`, [id]);
    await audit(req, 'question.create', 'question', id, { subject_id: body.subject_id, topic_id: body.topic_id, exam_ids: examIds });
    res.status(201).json(question);
  })
);

router.put(
  '/:id',
  validate({ params: idParams, body: questionUpdate }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const current = await db.one('SELECT * FROM questions WHERE id = $1', [id]);
    if (!current) throw new AppError(404, 'not_found', 'Questão não encontrada.');

    const merged = {
      subject_id: body.subject_id ?? current.subject_id,
      topic_id: body.topic_id ?? current.topic_id,
      subtopic_id: body.subtopic_id === undefined ? current.subtopic_id : body.subtopic_id,
    };
    if (body.subject_id || body.topic_id || body.subtopic_id !== undefined) {
      // trocar de assunto sem informar o subassunto descarta a classificação antiga
      if (body.subtopic_id === undefined && body.topic_id && body.topic_id !== current.topic_id) merged.subtopic_id = null;
      await assertClassification(merged);
    }
    if (body.source_exam_id) {
      const exam = await db.one('SELECT id FROM exams WHERE id = $1', [body.source_exam_id]);
      if (!exam) {
        throw new AppError(400, 'validation_error', 'Prova de origem não encontrada.', [
          { path: 'source_exam_id', message: 'Prova não encontrada.' },
        ]);
      }
    }
    const examIds = body.exam_ids !== undefined ? await assertExamsExist(db, body.exam_ids) : null;
    const options = body.options !== undefined ? normalizeOptions(body.options) : null;
    const fields = { ...body, ...merged };
    delete fields.exam_ids;
    delete fields.options;

    await db.tx(async (client) => {
      const allowed = ['statement', 'image_url', 'resolution', 'explanation', 'subject_id', 'topic_id', 'subtopic_id',
        'difficulty', 'source_exam_id', 'year', 'board', 'source', 'active'];
      const sets = [];
      const params = [];
      for (const key of allowed) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
        params.push(fields[key]);
        sets.push(`${key} = $${params.length}`);
      }
      if (sets.length) {
        params.push(id);
        await client.query(`UPDATE questions SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      if (options) await replaceOptions(client, id, options);
      if (examIds) await replaceQuestionExams(client, id, examIds, { topicId: merged.topic_id, subjectId: merged.subject_id });
    });

    const question = await db.one(`${SELECT_FULL} WHERE q.id = $1`, [id]);
    await audit(req, 'question.update', 'question', id, { changes: Object.keys(body) });
    res.json(question);
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const question = await db.one('SELECT id, left(statement, 120) AS excerpt FROM questions WHERE id = $1', [id]);
    if (!question) throw new AppError(404, 'not_found', 'Questão não encontrada.');
    await db.query('DELETE FROM questions WHERE id = $1', [id]);
    await audit(req, 'question.delete', 'question', id, { excerpt: question.excerpt });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Conferência
// ---------------------------------------------------------------------------
const reviewBody = z
  .object({
    ids: z.array(uuid).min(1, 'Escolha ao menos uma questão.').max(200),
    reviewed: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();

/**
 * Marca questões como conferidas — e, de quebra, fecha os chamados que os
 * alunos abriram sobre elas. Sem isto, `questions.reviewed_at` e
 * `question_reports` seriam colunas que ninguém escreve.
 */
router.patch(
  '/revisao',
  validate({ body: reviewBody }),
  wrap(async (req, res) => {
    const { ids, reviewed = true, active } = req.valid.body;
    const atualizadas = await db.many(
      `UPDATE questions
          SET reviewed_at = CASE WHEN $2 THEN now() ELSE NULL END,
              active = coalesce($3, active)
        WHERE id = ANY($1::uuid[])
        RETURNING id`,
      [ids, reviewed, active === undefined ? null : active]
    );
    if (reviewed) {
      await db.query(
        `UPDATE question_reports SET status = 'resolvido', resolved_at = now()
          WHERE question_id = ANY($1::uuid[]) AND status = 'aberto'`,
        [ids]
      );
    }
    await audit(req, 'question.review', 'question', null, { count: atualizadas.length, reviewed, active });
    res.json({ updated: atualizadas.length, ids: atualizadas.map((row) => row.id) });
  })
);

/** Os chamados abertos de uma questão, para o painel mostrar o que o aluno disse. */
router.get(
  '/:id/reports',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const rows = await db.many(
      `SELECT r.id, r.reason, r.comment, r.status, r.created_at, u.name AS user_name
         FROM question_reports r
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.question_id = $1
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [req.valid.params.id]
    );
    res.json({ items: rows, total: rows.length });
  })
);

// A leitura de prova em PDF (routes/admin/exam-imports.js) grava questão pelo
// MESMO caminho da planilha: mesma validação de alternativa, mesma resolução de
// matéria e assunto por slug, mesma mensagem de erro em português. Duplicar
// isso lá seria duplicar as regras.
module.exports = { basePath: '/api/admin/questions', router, buildImportRow, loadSlugMaps, insertQuestion, RowError };
