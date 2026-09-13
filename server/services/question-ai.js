'use strict';

/**
 * Questões elaboradas por IA.
 *
 *   const questionAi = require('./question-ai');
 *   const set  = await questionAi.afterLesson(lessonId, { userId, difficulty: 2 });
 *   const novas = await questionAi.fillPool({ topicId, difficulty, count, userId });
 *
 * Duas situações pedem questão que ainda não existe: logo depois da aula, quando
 * o aluno quer praticar o que acabou de ver e o banco não tem nada daquele
 * assunto na dificuldade escolhida; e no simulado, quando o aluno pede 80
 * questões e o banco tem 12.
 *
 * A questão gerada é GRAVADA em `questions`, como qualquer outra. Não é
 * capricho: tentativa, caderno de erros, revisão e simulado guardam
 * `question_id`, e o caderno de erros só lista questão ativa (routes/errors.js)
 * — questão efêmera, ou escondida esperando aprovação, faria o erro do aluno
 * desaparecer da lista dele sem explicação.
 *
 * Fica marcada com `generated_by_ai = true` para o painel separar o que veio de
 * prova do que a IA escreveu, e é reaproveitada: quem terminar a mesma aula
 * depois recebe a questão já pronta, sem nova chamada à IA.
 */
const db = require('../db/pool');
const ai = require('./ai');
const { getSetting } = require('./settings');
const { AppError } = require('../middleware/errors');
const { TIMEZONE } = require('../utils/dates');

/** Uma questão de múltipla escolha com resolução custa perto de 500 tokens de saída. */
const MAX_TOKENS_POR_QUESTAO = 700;
const MAX_TOKENS_MINIMO = 1500;
const MAX_TOKENS_TETO = 12_000;
const TIMEOUT_MS = 120_000;
const MAX_POR_CHAMADA = 8;

/** Dias sem repetir uma questão para o mesmo aluno. */
const DIAS_SEM_REPETIR = 7;
/**
 * Quantas chamadas de elaboração um aluno pode provocar por dia.
 *
 * Sem isto o botão "Praticar de novo" é uma torneira aberta: as questões de
 * ontem estão excluídas pela regra de repetição, o assunto acaba, e cada clique
 * manda a IA escrever três questões novas. O limitador de requisições segura
 * rajada, não gasto ao longo do dia.
 */
const GERACOES_POR_DIA = 8;
/** Quantas questões a prática pós-aula entrega (uma por assunto da aula). */
const QUESTOES_POR_AULA = 3;

const LETRAS = ['A', 'B', 'C', 'D', 'E'];

/** Como cada nível é descrito para a IA — sem isso "difícil" vira só enunciado comprido. */
const DIFICULDADES = Object.freeze({
  1: {
    label: 'fácil',
    guia: 'aplicação direta do conceito, com uma única etapa de raciocínio e números simples.',
  },
  2: {
    label: 'média',
    guia: 'exige duas ou três etapas encadeadas, ou interpretação de um contexto antes de aplicar o conceito.',
  },
  3: {
    label: 'difícil',
    guia: 'combina mais de um conceito, pede interpretação de texto, gráfico ou tabela e tem pegadinha plausível nas alternativas erradas.',
  },
});

function difficultyOf(value) {
  const n = Number(value);
  return DIFICULDADES[n] ? n : 2;
}

/** Corta um texto sem cortar no meio de uma palavra. */
function trimText(value, max) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

// ---------------------------------------------------------------------------
// Os assuntos de uma aula
// ---------------------------------------------------------------------------

/**
 * Os assuntos que a aula cobre.
 *
 * O cliente pediu "uma questão de cada assunto da aula". No modelo, uma aula
 * pertence a um assunto (`topic`) e, quando o administrador detalhou, a um
 * subassunto. Os assuntos da aula são então os SUBASSUNTOS do assunto dela —
 * dado que já existe no conteúdo programático, com o subassunto da própria
 * aula na frente. Quando o assunto não foi detalhado em subassuntos, o alvo é
 * o assunto inteiro, e a IA recebe a aula como recorte.
 *
 * @returns {Promise<Array<{ subtopic_id: string|null, name: string }>>}
 */
async function lessonTargets(lesson, count = QUESTOES_POR_AULA) {
  const subtopics = await db.many(
    `SELECT id, name FROM subtopics
      WHERE topic_id = $1 AND active
      ORDER BY (id = $2) DESC, sort_order, name`,
    [lesson.topic_id, lesson.subtopic_id]
  );

  if (!subtopics.length) {
    return Array.from({ length: count }, () => ({ subtopic_id: null, name: lesson.topic_name }));
  }
  const alvos = subtopics.slice(0, count).map((row) => ({ subtopic_id: row.id, name: row.name }));
  // Assunto com menos subassuntos que o pedido: repete os que existem, para o
  // aluno receber as três questões mesmo assim.
  while (alvos.length < count) alvos.push(alvos[alvos.length % subtopics.length]);
  return alvos;
}

// ---------------------------------------------------------------------------
// O que o banco já tem
// ---------------------------------------------------------------------------

/**
 * Candidatas do banco para um assunto e uma dificuldade, sem o que o aluno
 * respondeu há pouco. Questão de prova vem antes de questão da IA: quando as
 * duas servem, a de prova é melhor.
 */
async function bankCandidates({ topicId, difficulty, userId, limit = 30 }) {
  return db.many(
    `SELECT q.id, q.subtopic_id, q.generated_by_ai
       FROM questions q
      WHERE q.active
        AND q.topic_id = $1
        AND q.difficulty = $2
        AND NOT EXISTS (
          SELECT 1 FROM question_attempts a
           WHERE a.user_id = $3 AND a.question_id = q.id
             AND a.answered_at > now() - ($4::int * interval '1 day'))
      ORDER BY q.generated_by_ai, random()
      LIMIT $5`,
    [topicId, difficulty, userId, DIAS_SEM_REPETIR, limit]
  );
}

/** Distribui as candidatas entre os alvos: cada alvo fica com uma questão do seu subassunto. */
function assignCandidates(targets, candidates) {
  const livres = [...candidates];
  const usados = new Set();
  const take = (predicate) => {
    const index = livres.findIndex((row) => !usados.has(row.id) && predicate(row));
    if (index < 0) return null;
    const row = livres[index];
    usados.add(row.id);
    return row;
  };

  return targets.map((alvo) => {
    // exatamente o subassunto do alvo; se não houver, qualquer questão do assunto
    const exata = alvo.subtopic_id ? take((row) => row.subtopic_id === alvo.subtopic_id) : null;
    return { target: alvo, question_id: (exata || take(() => true) || {}).id || null };
  });
}

// ---------------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------------

/**
 * Barra o aluno que já pediu questão nova demais hoje.
 *
 * Conta pelo registro de uso da IA, no fuso de São Paulo: não precisa de coluna
 * nova e acompanha exatamente o que foi cobrado.
 */
async function assertDailyQuota(userId) {
  if (!userId) return;
  const row = await db.one(
    `SELECT count(*)::int AS total
       FROM ai_usage
      WHERE user_id = $1
        AND feature = 'questions'
        AND status = 'ok'
        AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
    [userId, TIMEZONE]
  );
  if (row && row.total >= GERACOES_POR_DIA) {
    throw new AppError(
      429,
      'ai_limit_reached',
      'Você já pediu muitas questões novas hoje. Amanhã o limite se renova — enquanto isso, pratique com as questões que já estão no banco.'
    );
  }
}

/** Monta o prompt de elaboração de questões a partir do conteúdo da aula. */
function buildQuestionsPrompt({ subject, topic, lesson, exam, difficulty, targets }) {
  const nivel = DIFICULDADES[difficulty];
  const system = [
    'Você é um elaborador de questões objetivas para o ENEM, para a Academia do Barro Branco e para vestibulares brasileiros.',
    'Escreva sempre em português do Brasil, com o rigor de banca: enunciado autossuficiente, uma única alternativa correta',
    'e distratores plausíveis, que correspondam a erros que o candidato realmente comete.',
    'Nunca reproduza questão de prova existente nem trecho de obra protegida por direito autoral —',
    'as questões devem ser autorais.',
    'Responda somente com um objeto JSON válido, sem nenhum texto fora do JSON.',
  ].join(' ');

  const lines = [];
  lines.push(`Matéria: ${subject.name}`);
  lines.push(`Assunto: ${topic.name}`);
  if (topic.description) lines.push(`Ementa do assunto: ${trimText(topic.description, 400)}`);
  if (exam) {
    lines.push(`Prova do aluno: ${exam.name}${exam.board ? ` (banca ${exam.board})` : ''}`);
    lines.push(`Estilo: enunciado no formato cobrado por ${exam.short_name || exam.name}.`);
  }
  if (lesson) {
    lines.push('');
    lines.push(`Aula assistida: ${lesson.title}`);
    if (lesson.description) lines.push(`Descrição: ${trimText(lesson.description, 600)}`);
    if (lesson.summary) {
      lines.push('Resumo da aula (use como recorte do que foi ensinado):');
      lines.push(trimText(lesson.summary, 2500));
    }
  }
  lines.push('');
  lines.push(`Dificuldade: ${nivel.label} — ${nivel.guia}`);
  lines.push('');
  lines.push(`Elabore ${targets.length} ${targets.length === 1 ? 'questão' : 'questões'}, uma para cada item desta lista:`);
  targets.forEach((alvo, index) => lines.push(`${index + 1}. ${alvo.name}`));
  lines.push('');
  lines.push('Devolva um JSON exatamente com esta estrutura:');
  lines.push('{');
  lines.push('  "questions": [');
  lines.push('    {');
  lines.push('      "target": 1,');
  lines.push('      "statement": "o enunciado completo, com o contexto necessário para responder",');
  lines.push('      "options": [');
  lines.push('        { "letter": "A", "text": "texto da alternativa", "is_correct": false },');
  lines.push('        { "letter": "B", "text": "texto da alternativa", "is_correct": true }');
  lines.push('      ],');
  lines.push('      "resolution": "a resolução passo a passo, do enunciado até a alternativa correta",');
  lines.push('      "explanation": "por que cada alternativa errada é errada, em um parágrafo"');
  lines.push('    }');
  lines.push('  ]');
  lines.push('}');
  lines.push('');
  lines.push('Regras obrigatórias:');
  lines.push(`- "target" é o número do item da lista acima a que a questão corresponde (de 1 a ${targets.length}).`);
  lines.push('- Cinco alternativas, letras A, B, C, D e E, e exatamente uma com "is_correct": true.');
  lines.push('- A questão tem que ser respondível apenas com o enunciado: nada de "segundo a aula" ou "como vimos".');
  lines.push('- Não numere a questão nem escreva "Questão 1" dentro do enunciado.');
  lines.push('- Fórmulas e símbolos em texto simples; nada de LaTeX.');

  const user = lines.join('\n');
  return {
    system,
    user,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

/** Valida uma questão devolvida pela IA e a converte no formato de gravação. */
function normalizeGenerated(raw, { targets, difficulty }) {
  const statement = trimText(raw && raw.statement, 4000);
  if (statement.length < 20) return null;

  const options = (Array.isArray(raw && raw.options) ? raw.options : [])
    .map((option, index) => ({
      letter: String((option && option.letter) || LETRAS[index] || '').trim().toUpperCase(),
      text: trimText(option && option.text, 1000),
      is_correct: Boolean(option && option.is_correct),
    }))
    .filter((option) => option.text && LETRAS.includes(option.letter));

  // As mesmas regras da importação: de 2 a 5 alternativas, letras únicas, uma
  // só correta. Resposta que não obedece é descartada, não corrigida no chute.
  if (options.length < 2 || options.length > LETRAS.length) return null;
  if (new Set(options.map((option) => option.letter)).size !== options.length) return null;
  if (options.filter((option) => option.is_correct).length !== 1) return null;

  const index = Number.parseInt(raw && raw.target, 10);
  const target = targets[Number.isInteger(index) && index >= 1 && index <= targets.length ? index - 1 : 0];

  return {
    target,
    statement,
    options: options.map((option, sort) => ({ ...option, sort_order: sort })),
    resolution: trimText(raw && raw.resolution, 4000) || null,
    explanation: trimText(raw && raw.explanation, 4000) || null,
    difficulty,
  };
}

/** Grava a questão elaborada e devolve o id. */
async function persistGenerated(client, item, { subjectId, topicId, lessonId, source }) {
  const row = await client.one(
    `INSERT INTO questions (subject_id, topic_id, subtopic_id, statement, resolution, explanation,
                            difficulty, source, generated_by_ai, lesson_id, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, true)
     RETURNING id`,
    [
      subjectId,
      topicId,
      item.target ? item.target.subtopic_id : null,
      item.statement,
      item.resolution,
      item.explanation,
      item.difficulty,
      source,
      lessonId || null,
    ]
  );
  for (const option of item.options) {
    await client.query(
      `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.id, option.letter, option.text, option.is_correct, option.sort_order]
    );
  }
  return row.id;
}

/**
 * Pede à IA as questões que faltam e grava.
 * @returns {Promise<string[]>} ids das questões criadas, na ordem dos alvos
 */
async function generate({ subject, topic, lesson, exam, difficulty, targets, userId }) {
  if (!targets.length) return [];
  await assertDailyQuota(userId);
  const pedidos = targets.slice(0, MAX_POR_CHAMADA);

  const { messages } = buildQuestionsPrompt({ subject, topic, lesson, exam, difficulty, targets: pedidos });
  const model = (await getSetting('openrouter_model')) || undefined;
  const maxTokens = Math.min(
    MAX_TOKENS_TETO,
    Math.max(MAX_TOKENS_MINIMO, pedidos.length * MAX_TOKENS_POR_QUESTAO)
  );

  const result = await ai.json({
    messages,
    model,
    temperature: 0.7,
    maxTokens,
    // O segundo teto só entra em cena se o provedor cortar o primeiro JSON:
    // questão com texto de apoio longo estoura a estimativa por questão.
    retryMaxTokens: Math.min(MAX_TOKENS_TETO, maxTokens * 2),
    userId,
    feature: 'questions',
    timeoutMs: TIMEOUT_MS,
  });

  const brutas = Array.isArray(result.data && result.data.questions) ? result.data.questions : [];
  const prontas = brutas
    .map((raw) => normalizeGenerated(raw, { targets: pedidos, difficulty }))
    .filter(Boolean)
    // A IA responde na ordem que quiser. Quem chamou monta o conjunto contando
    // que o primeiro id corresponda ao primeiro assunto pedido.
    .sort((a, b) => pedidos.indexOf(a.target) - pedidos.indexOf(b.target));

  if (!prontas.length) {
    throw new AppError(503, 'ai_unavailable', 'A IA não conseguiu elaborar as questões agora. Tente novamente em instantes.');
  }

  const source = lesson
    ? `Questão elaborada por IA a partir da aula "${trimText(lesson.title, 120)}"`
    : `Questão elaborada por IA sobre ${trimText(topic.name, 120)}`;

  return db.tx(async (client) => {
    const ids = [];
    for (const item of prontas) {
      ids.push(
        await persistGenerated(client, item, {
          subjectId: subject.id,
          topicId: topic.id,
          lessonId: lesson ? lesson.id : null,
          source,
        })
      );
    }
    return ids;
  });
}

/** Assuntos elegíveis para o recorte do simulado, dos mais cobrados para os menos. */
async function fillableTopics({ examId, subjectId, topicId, filters = {} }) {
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['t.active', 's.active'];
  if (examId) where.push(`EXISTS (SELECT 1 FROM exam_topics et WHERE et.topic_id = t.id AND et.exam_id = ${add(examId)})`);
  if (subjectId) where.push(`t.subject_id = ${add(subjectId)}`);
  if (topicId) where.push(`t.id = ${add(topicId)}`);
  if (Array.isArray(filters.subject_ids) && filters.subject_ids.length) {
    where.push(`t.subject_id = ANY(${add(filters.subject_ids)}::uuid[])`);
  }
  if (Array.isArray(filters.topic_ids) && filters.topic_ids.length) {
    where.push(`t.id = ANY(${add(filters.topic_ids)}::uuid[])`);
  }

  // O peso do assunto na prova mora em exam_topics; sem prova no recorte, a
  // ordem do conteúdo programático é o melhor critério disponível.
  const pesoJoin = examId
    ? `LEFT JOIN exam_topics w ON w.topic_id = t.id AND w.exam_id = ${add(examId)}`
    : '';
  const ordem = examId ? 'w.weight DESC NULLS LAST, s.sort_order, t.sort_order, t.name' : 's.sort_order, t.sort_order, t.name';

  return db.many(
    `SELECT t.id, t.name, t.description, t.subject_id, s.name AS subject_name
       FROM topics t
       JOIN subjects s ON s.id = t.subject_id
       ${pesoJoin}
      WHERE ${where.join(' AND ')}
      ORDER BY ${ordem}`,
    params
  );
}

/**
 * Elabora questões novas para um recorte (prova, matéria ou assunto) e devolve
 * o que entrou, no formato do pool: { id, subject_id, topic_id }.
 *
 * Serve a dois lugares: o simulado que o banco não fecha e o banco de questões
 * do aluno quando o filtro dele não acha nada. O que muda entre os dois é só o
 * teto, que quem chama decide.
 */
async function fillPool({ examId = null, subjectId = null, topicId = null, filters = {}, difficulty = 2, count, userId }) {
  const teto = Math.max(0, Math.min(Number(count) || 0, 90));
  if (teto <= 0) return [];

  const topics = await fillableTopics({ examId, subjectId, topicId, filters });
  if (!topics.length) return [];

  const criadas = [];
  // Espalha pelos assuntos em vez de esgotar um: é assim que uma prova se
  // parece com uma prova.
  for (const topic of topics) {
    if (criadas.length >= teto) break;
    const querAgora = Math.min(MAX_POR_CHAMADA, teto - criadas.length);
    const subtopics = await db.many(
      'SELECT id, name FROM subtopics WHERE topic_id = $1 AND active ORDER BY sort_order, name',
      [topic.id]
    );
    const targets = Array.from({ length: querAgora }, (_, index) =>
      subtopics.length
        ? { subtopic_id: subtopics[index % subtopics.length].id, name: subtopics[index % subtopics.length].name }
        : { subtopic_id: null, name: topic.name }
    );

    try {
      const ids = await generate({
        subject: { id: topic.subject_id, name: topic.subject_name },
        topic: { id: topic.id, name: topic.name, description: topic.description },
        lesson: null,
        exam: null,
        difficulty,
        targets,
        userId,
      });
      for (const id of ids) criadas.push({ id, subject_id: topic.subject_id, topic_id: topic.id });
    } catch (err) {
      // Falta de questão não pode virar tela vazia: quem chamou recebe o que
      // deu para elaborar, e o motivo fica no log. Teto diário do aluno sobe.
      if (err && err.code === 'ai_limit_reached' && !criadas.length) throw err;
      console.warn(`[question-ai] não foi possível elaborar questões de ${topic.name}: ${err.message}`);
      break;
    }
  }
  return criadas;
}

module.exports = {
  DIFICULDADES,
  QUESTOES_POR_AULA,
  DIAS_SEM_REPETIR,
  GERACOES_POR_DIA,
  MAX_POR_CHAMADA,
  TIMEOUT_MS,
  difficultyOf,
  lessonTargets,
  bankCandidates,
  assignCandidates,
  buildQuestionsPrompt,
  normalizeGenerated,
  generate,
  fillableTopics,
  fillPool,
};
