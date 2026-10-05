'use strict';

/**
 * Questões elaboradas por IA.
 *
 *   const questionAi = require('./question-ai');
 *   const alvos = await questionAi.lessonTargets(lesson);          // 3 alvos pelos assuntos da aula
 *   const banco = await questionAi.bankCandidates({ topicIds, difficulty, userId });
 *   const casadas = questionAi.assignCandidates(alvos, banco);      // [{ target, question_id|null }]
 *   const novas = await questionAi.generateItems({ subject, lesson, difficulty, targets, userId });
 *                                                                   // [{ id, index, target }]
 *   const pool = await questionAi.fillPool({ topicId, difficulty, count, userId });
 *
 * Três situações pedem questão que ainda não existe: logo depois da aula,
 * quando o aluno quer praticar o que acabou de ver e o banco não tem nada
 * daquele assunto na dificuldade escolhida; no cadastro da aula, quando a fila
 * de services/lesson-questions deixa as questões prontas antes do primeiro
 * aluno; e no simulado, quando o aluno pede 80 questões e o banco tem 12.
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

/**
 * Quanto custa, em tokens de saída, uma questão com resolução.
 *
 * Os 700 anteriores eram um chute otimista. Medido com o modelo em produção,
 * três questões de Porcentagem no formato do ENEM — enunciado com contexto,
 * cinco alternativas, resolução passo a passo e explicação dos distratores —
 * gastam de 1800 a 2700 tokens. Com o teto antigo, o JSON era cortado no meio
 * e a geração inteira era descartada: o aluno pedia questão nova e recebia
 * "não foi possível elaborar", sempre.
 */
const MAX_TOKENS_POR_QUESTAO = 1400;
const MAX_TOKENS_MINIMO = 4000;
const MAX_TOKENS_TETO = 12_000;
const TIMEOUT_MS = 120_000;
/**
 * Prazo de uma chamada quando quem espera é uma tela aberta.
 *
 * A borda (Cloudflare na frente da Square Cloud) corta a requisição perto dos
 * 100 segundos e devolve uma página de erro que o front não sabe ler — o aluno
 * via o botão girar e no fim um erro sem sentido no canto da tela. Uma chamada
 * interativa precisa caber, com folga, dentro desse corte.
 */
const TIMEOUT_INTERATIVO_MS = 40_000;
/**
 * Teto de tempo da elaboração inteira, não de cada chamada.
 *
 * Sem ele, o laço abaixo tenta um assunto por vez e só desiste depois de falhar
 * uma vez em CADA assunto da matéria. Matemática tem 35 assuntos: com a IA
 * lenta, um clique virava mais de uma hora de requisição pendurada, gastando
 * crédito, para terminar em erro. O prazo estourado devolve o que já deu para
 * elaborar, do mesmo jeito que a cota diária já fazia.
 */
const PRAZO_TOTAL_MS = 6 * 60_000;
const PRAZO_INTERATIVO_MS = 50_000;
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
// Dez chamadas de oito questões são necessárias para montar um simulado
// completo em um banco vazio. Doze deixam essa operação caber no limite sem
// transformar o botão de prática em geração ilimitada.
const GERACOES_POR_DIA = 12;
/**
 * Teto de TENTATIVAS por dia, contando as que falharam.
 *
 * A cota acima só conta chamada bem-sucedida. Quando o modelo responde fora do
 * formato, a questão é descartada, nada é gravado — e o gasto acontece do mesmo
 * jeito, porque o prompt foi enviado e cobrado. Sem este segundo teto, um
 * modelo mal configurado gasta sem limite justamente no dia em que não entrega
 * nada. É folgado de propósito: quem está usando a plataforma normalmente não
 * chega perto dele.
 */
const TENTATIVAS_POR_DIA = 30;
/**
 * Quantas questões a prática pós-aula entrega. São sempre três, divididas entre
 * os assuntos da aula (ver distribute): o cliente decidiu que a prática não
 * encolhe quando a aula tem um assunto só.
 */
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
 * Quantas das `count` questões cabem a cada um dos `n` assuntos, na ordem.
 *
 * A regra é do cliente: três assuntos, uma de cada; dois, duas do primeiro e
 * uma do segundo; um, as três dele. O primeiro assunto do título é o que a
 * aula mais trabalha, e é ele que leva a sobra.
 *
 *   distribute(3) → [1, 1, 1]   distribute(2) → [2, 1]   distribute(1) → [3]
 */
function distribute(n, count = QUESTOES_POR_AULA) {
  const total = Math.max(0, Math.floor(Number(n) || 0));
  if (!total) return [];
  const base = Math.floor(count / total);
  const sobra = count % total;
  return Array.from({ length: total }, (_, index) => base + (index < sobra ? 1 : 0));
}

/**
 * Os assuntos da aula, na ordem do título (lesson_topics). Assunto desativado
 * fica de fora: o aluno não acharia a página dele. Aula sem nenhuma linha (não
 * deveria existir — o gatilho da migration 223 grava a primeira) cai no
 * assunto principal, para a prática nunca ficar sem alvo.
 */
async function lessonTopicsOf(lesson) {
  const rows = await db.many(
    `SELECT lt.position, lt.topic_id, t.name AS topic_name, t.description AS topic_description,
            lt.subtopic_id, st.name AS subtopic_name
       FROM lesson_topics lt
       JOIN topics t ON t.id = lt.topic_id AND t.active
       LEFT JOIN subtopics st ON st.id = lt.subtopic_id
      WHERE lt.lesson_id = $1
      ORDER BY lt.position`,
    [lesson.id]
  );
  if (rows.length) return rows;
  return [
    {
      position: 1,
      topic_id: lesson.topic_id,
      topic_name: lesson.topic_name,
      topic_description: lesson.topic_description || null,
      subtopic_id: lesson.subtopic_id || null,
      subtopic_name: lesson.subtopic_name || null,
    },
  ];
}

/**
 * Os alvos da prática da aula: uma vaga por questão, com o assunto de cada uma.
 *
 * As três vagas são divididas entre os assuntos da aula (distribute). Um
 * assunto com uma vaga é cobrado inteiro — ou só no subassunto, quando a aula
 * foi ligada a ele. Um assunto com duas ou três vagas espalha as questões pelos
 * subassuntos dele, com o da aula na frente, para não sair três vezes a mesma
 * coisa; sem subassunto cadastrado, as vagas repetem o assunto inteiro.
 *
 * @returns {Promise<Array<{ slot: number, topic_id: string, topic_name: string,
 *   topic_description: string|null, subtopic_id: string|null, name: string }>>}
 */
async function lessonTargets(lesson, count = QUESTOES_POR_AULA) {
  const topics = await lessonTopicsOf(lesson);
  const vagas = distribute(topics.length, count);
  const comVariasVagas = topics.filter((_, index) => vagas[index] > 1).map((topic) => topic.topic_id);
  const subtopics = comVariasVagas.length
    ? await db.many(
        `SELECT id, topic_id, name FROM subtopics
          WHERE topic_id = ANY($1::uuid[]) AND active
          ORDER BY sort_order, name`,
        [comVariasVagas]
      )
    : [];

  const alvos = [];
  topics.forEach((topic, index) => {
    const base = {
      topic_id: topic.topic_id,
      topic_name: topic.topic_name,
      topic_description: topic.topic_description || null,
    };
    const proprio = topic.subtopic_id ? { subtopic_id: topic.subtopic_id, name: topic.subtopic_name || topic.topic_name } : null;
    const k = vagas[index];
    if (k <= 0) return;
    if (k === 1) {
      alvos.push({ ...base, ...(proprio || { subtopic_id: null, name: topic.topic_name }) });
      return;
    }
    const recortes = [
      ...(proprio ? [proprio] : []),
      ...subtopics
        .filter((row) => row.topic_id === topic.topic_id && row.id !== topic.subtopic_id)
        .map((row) => ({ subtopic_id: row.id, name: row.name })),
    ];
    for (let i = 0; i < k; i += 1) {
      alvos.push({ ...base, ...(recortes.length ? recortes[i % recortes.length] : { subtopic_id: null, name: topic.topic_name }) });
    }
  });
  return alvos.map((alvo, slot) => ({ slot, ...alvo }));
}

// ---------------------------------------------------------------------------
// O que o banco já tem
// ---------------------------------------------------------------------------

/**
 * Candidatas do banco para os assuntos e a dificuldade, sem o que o aluno
 * respondeu há pouco. Questão de prova vem antes de questão da IA: quando as
 * duas servem, a de prova é melhor.
 *
 * O teto vale POR ASSUNTO: com um teto só para todos, o assunto com mil
 * questões no banco tomava as vagas do que tem dez.
 *
 * @param {{ topicIds?: string[], topicId?: string, difficulty: number, userId: string|null, limit?: number }} options
 */
async function bankCandidates({ topicIds, topicId, difficulty, userId, limit = 30 }) {
  const ids = Array.from(new Set([...(Array.isArray(topicIds) ? topicIds : []), ...(topicId ? [topicId] : [])].filter(Boolean)));
  if (!ids.length) return [];
  return db.many(
    `SELECT c.id, c.topic_id, c.subtopic_id, c.generated_by_ai
       FROM (
         SELECT q.id, q.topic_id, q.subtopic_id, q.generated_by_ai,
                row_number() OVER (PARTITION BY q.topic_id ORDER BY q.generated_by_ai, random()) AS ordem
           FROM questions q
          WHERE q.active
            AND q.topic_id = ANY($1::uuid[])
            AND q.difficulty = $2
            AND NOT EXISTS (
              SELECT 1 FROM question_attempts a
               WHERE a.user_id = $3 AND a.question_id = q.id
                 AND a.answered_at > now() - ($4::int * interval '1 day'))
       ) c
      WHERE c.ordem <= $5
      ORDER BY c.topic_id, c.ordem`,
    [ids, difficulty, userId, DIAS_SEM_REPETIR, limit]
  );
}

/**
 * Distribui as candidatas entre os alvos, cada alvo com uma questão do SEU
 * assunto — nunca de outro: a questão de Porcentagem não ocupa a vaga de Regra
 * de Três, senão a prática promete três assuntos e entrega dois.
 *
 * Duas passadas: primeiro os alvos que pedem um subassunto pegam a questão
 * exata; depois os que sobraram pegam qualquer uma do assunto. Numa passada só,
 * o alvo sem par exato podia levar justamente a questão exata do alvo seguinte.
 *
 * @returns {Array<{ target: object, question_id: string|null }>} na ordem dos alvos
 */
function assignCandidates(targets, candidates) {
  const usados = new Set();
  const take = (predicate) => {
    const row = candidates.find((candidate) => !usados.has(candidate.id) && predicate(candidate));
    if (!row) return null;
    usados.add(row.id);
    return row;
  };
  // alvo sem assunto (o formato antigo, de um assunto só) aceita qualquer candidata
  const doAssunto = (alvo, row) => !alvo.topic_id || row.topic_id === alvo.topic_id;

  const out = targets.map((alvo) => ({ target: alvo, question_id: null }));
  for (const item of out) {
    if (!item.target.subtopic_id) continue;
    const row = take((candidate) => doAssunto(item.target, candidate) && candidate.subtopic_id === item.target.subtopic_id);
    if (row) item.question_id = row.id;
  }
  for (const item of out) {
    if (item.question_id) continue;
    const row = take((candidate) => doAssunto(item.target, candidate));
    if (row) item.question_id = row.id;
  }
  return out;
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
    `SELECT count(*) FILTER (WHERE status = 'ok')::int AS entregues,
            count(*)::int AS tentativas
       FROM ai_usage
      WHERE user_id = $1
        AND feature = 'questions'
        AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
    [userId, TIMEZONE]
  );
  const entregues = row ? row.entregues : 0;
  const tentativas = row ? row.tentativas : 0;
  if (entregues >= GERACOES_POR_DIA || tentativas >= TENTATIVAS_POR_DIA) {
    throw new AppError(
      429,
      'ai_limit_reached',
      'Você já pediu muitas questões novas hoje. Amanhã o limite se renova — enquanto isso, pratique com as questões que já estão no banco.'
    );
  }
}

/**
 * Os assuntos que entram no prompt: os dos alvos (aula com vários assuntos),
 * na ordem em que aparecem, ou o assunto único de quem chamou.
 */
function promptTopics({ topic, targets }) {
  const vistos = new Map();
  for (const alvo of targets) {
    if (alvo && alvo.topic_id && !vistos.has(alvo.topic_id)) {
      vistos.set(alvo.topic_id, { id: alvo.topic_id, name: alvo.topic_name, description: alvo.topic_description });
    }
  }
  if (vistos.size) return [...vistos.values()];
  return topic ? [topic] : [];
}

/** Como o item aparece na lista do prompt: o assunto e, quando há, o recorte dele. */
function targetLabel(alvo) {
  if (alvo.topic_name && alvo.name && alvo.name !== alvo.topic_name) return `${alvo.topic_name} — ${alvo.name}`;
  return alvo.name || alvo.topic_name || '';
}

/** Monta o prompt de elaboração de questões a partir do conteúdo da aula. */
function buildQuestionsPrompt({ subject, topic, lesson, exam, difficulty, targets }) {
  const nivel = DIFICULDADES[difficulty];
  const assuntos = promptTopics({ topic, targets });
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
  if (assuntos.length === 1) {
    lines.push(`Assunto: ${assuntos[0].name}`);
    if (assuntos[0].description) lines.push(`Ementa do assunto: ${trimText(assuntos[0].description, 400)}`);
  } else if (assuntos.length > 1) {
    // Com marcador e sem número: a lista numerada do prompt é a dos itens a
    // elaborar, e o "target" de cada questão aponta para ela.
    lines.push('Assuntos da aula:');
    for (const assunto of assuntos) {
      lines.push(`- ${assunto.name}${assunto.description ? `: ${trimText(assunto.description, 300)}` : ''}`);
    }
  }
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
  targets.forEach((alvo, index) => lines.push(`${index + 1}. ${targetLabel(alvo)}`));
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
  if (assuntos.length > 1) {
    lines.push('- Cada questão cobra somente o assunto do seu item; não misture os assuntos de itens diferentes.');
  }
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

  // Item que não diz a que alvo pertence fica sem alvo (null): quem chamou
  // decide onde ele cabe. Antes ia para o primeiro, e numa aula de três
  // assuntos a questão de Porcentagem podia ser gravada como Regra de Três.
  const numero = Number.parseInt(raw && raw.target, 10);
  let index = Number.isInteger(numero) && numero >= 1 && numero <= targets.length ? numero - 1 : null;
  if (index === null && targets.length === 1) index = 0;

  return {
    index,
    target: index === null ? null : targets[index],
    statement,
    options: options.map((option, sort) => ({ ...option, sort_order: sort })),
    resolution: trimText(raw && raw.resolution, 4000) || null,
    explanation: trimText(raw && raw.explanation, 4000) || null,
    difficulty,
  };
}

/**
 * Grava a questão elaborada e devolve o id.
 *
 * O assunto é o do ALVO da questão quando o alvo traz um (aula com vários
 * assuntos); `topicId` é só o assunto de quem chamou com um assunto único.
 * Tentativa, caderno de erros e revisão contam pelo topic_id da questão:
 * gravar a questão de Regra de Três no assunto principal da aula jogaria o
 * desempenho do aluno no assunto errado.
 */
async function persistGenerated(client, item, { subjectId, topicId, lessonId, source }) {
  const alvo = item.target || null;
  const row = await client.one(
    `INSERT INTO questions (subject_id, topic_id, subtopic_id, statement, resolution, explanation,
                            difficulty, source, generated_by_ai, lesson_id, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, true)
     RETURNING id`,
    [
      subjectId,
      (alvo && alvo.topic_id) || topicId,
      alvo ? alvo.subtopic_id || null : null,
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
 * Põe cada questão devolvida no seu alvo.
 *
 * Questão com alvo válido fica nele (duas para o mesmo alvo ficam as duas:
 * vão para o banco do assunto certo). Questão sem alvo só ganha um quando
 * não há escolha: ela é a única sem alvo e sobrou uma vaga só. Em qualquer
 * outro caso é descartada. Duas sem alvo para duas vagas, casadas pela ordem
 * em que a IA respondeu, podiam trocar os assuntos — a de Porcentagem gravada
 * como Regra de Três, com a tentativa e o caderno de erros do aluno contando
 * no assunto errado. A vaga que fica vazia é pedida de novo por quem chamou.
 */
function placeGenerated(prontas, pedidos) {
  const comAlvo = prontas.filter((item) => item.index !== null);
  const semAlvo = prontas.filter((item) => item.index === null);
  const cobertos = new Set(comAlvo.map((item) => item.index));
  const vazias = pedidos.map((_, index) => index).filter((index) => !cobertos.has(index));
  const out = [...comAlvo];
  if (semAlvo.length === 1 && vazias.length === 1) {
    out.push({ ...semAlvo[0], index: vazias[0], target: pedidos[vazias[0]] });
  }
  // A IA responde na ordem que quiser; quem chamou lê na ordem dos alvos.
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Pede à IA as questões dos alvos e grava.
 *
 * Cada questão volta com o índice do alvo a que responde, para quem chamou
 * casar pelo alvo e não pela posição: se a IA devolver duas questões do
 * primeiro assunto e nenhuma do segundo, a vaga do segundo continua vazia em
 * vez de receber uma questão de outro assunto.
 *
 * @param {object} options
 * @param {{ id: string, name: string }} options.subject
 * @param {{ id: string, name: string, description?: string }} [options.topic]
 *   assunto único de quem chama sem alvos por assunto (simulado, banco)
 * @param {Array<{ name: string, topic_id?: string, topic_name?: string, subtopic_id?: string|null }>} options.targets
 * @param {string|null} options.userId  null = trabalho da plataforma (sem cota diária)
 * @returns {Promise<Array<{ id: string, index: number, target: object }>>} na ordem dos alvos
 */
async function generateItems({
  subject,
  topic = null,
  lesson,
  exam,
  difficulty,
  targets,
  userId,
  timeoutMs = TIMEOUT_MS,
  signal = null,
  examId = null,
}) {
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
    timeoutMs,
    signal,
  });

  const brutas = Array.isArray(result.data && result.data.questions) ? result.data.questions : [];
  const prontas = placeGenerated(
    brutas.map((raw) => normalizeGenerated(raw, { targets: pedidos, difficulty })).filter(Boolean),
    pedidos
  );

  if (!prontas.length) {
    throw new AppError(503, 'ai_unavailable', 'A IA não conseguiu elaborar as questões agora. Tente novamente em instantes.');
  }

  const sobre = (topic && topic.name) || (pedidos[0] && (pedidos[0].topic_name || pedidos[0].name)) || subject.name;
  const source = lesson
    ? `Questão elaborada por IA a partir da aula "${trimText(lesson.title, 120)}"`
    : `Questão elaborada por IA sobre ${trimText(sobre, 120)}`;

  return db.tx(async (client) => {
    const criadas = [];
    for (const item of prontas) {
      const id = await persistGenerated(client, item, {
        subjectId: subject.id,
        topicId: topic ? topic.id : null,
        lessonId: lesson ? lesson.id : null,
        source,
      });
      // O aluno filtrou por prova antes de pedir a elaboração. Sem este
      // vínculo, a questão nasce fora do filtro que a pediu: a tela recarregava
      // com "5 questões elaboradas" e continuava vazia.
      if (examId) {
        await client.query(
          'INSERT INTO question_exams (question_id, exam_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, examId]
        );
      }
      criadas.push({ id, index: item.index, target: item.target });
    }
    return criadas;
  });
}

/**
 * Como generateItems, devolvendo só os ids, na ordem dos alvos. É o formato de
 * quem não precisa saber o alvo de cada questão (simulado, banco do aluno).
 * @returns {Promise<string[]>}
 */
async function generate(options) {
  return (await generateItems(options)).map((item) => item.id);
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
async function fillPool({
  examId = null,
  subjectId = null,
  topicId = null,
  filters = {},
  difficulty = 2,
  count,
  userId,
  prazoMs = PRAZO_TOTAL_MS,
  timeoutMs = TIMEOUT_MS,
  signal = null,
}) {
  const teto = Math.max(0, Math.min(Number(count) || 0, 90));
  if (teto <= 0) return [];

  const topics = await fillableTopics({ examId, subjectId, topicId, filters });
  if (!topics.length) return [];

  const criadas = [];
  const limite = Date.now() + Math.max(5_000, Number(prazoMs) || PRAZO_TOTAL_MS);
  // Espalha pelos assuntos e volta ao primeiro quando ainda falta questão.
  // A versão anterior passava por cada assunto uma vez; um simulado de um
  // único assunto, portanto, nunca recebia mais que MAX_POR_CHAMADA questões.
  let cursor = 0;
  let falhasSeguidas = 0;
  while (criadas.length < teto && falhasSeguidas < topics.length) {
    // O aluno fechou a aba ou o prazo acabou: devolve o que já ficou pronto em
    // vez de continuar chamando a IA para uma tela que não existe mais.
    if (signal && signal.aborted) break;
    const restante = limite - Date.now();
    if (restante <= 5_000) {
      console.warn(`[question-ai] prazo esgotado com ${criadas.length} de ${teto} questões elaboradas.`);
      break;
    }
    const topic = topics[cursor % topics.length];
    cursor += 1;
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
        timeoutMs: Math.min(timeoutMs, restante - 2_000),
        signal,
        examId,
      });
      for (const id of ids) criadas.push({ id, subject_id: topic.subject_id, topic_id: topic.id });
      falhasSeguidas = ids.length ? 0 : falhasSeguidas + 1;
    } catch (err) {
      // Falta de questão não pode virar tela vazia: quem chamou recebe o que
      // deu para elaborar, e o motivo fica no log. Teto diário do aluno sobe.
      if (err && err.code === 'ai_limit_reached' && !criadas.length) throw err;
      console.warn(`[question-ai] não foi possível elaborar questões de ${topic.name}: ${err.message}`);
      if (err && err.code === 'ai_limit_reached') break;
      falhasSeguidas += 1;
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
  TENTATIVAS_POR_DIA,
  TIMEOUT_MS,
  TIMEOUT_INTERATIVO_MS,
  PRAZO_TOTAL_MS,
  PRAZO_INTERATIVO_MS,
  difficultyOf,
  assertDailyQuota,
  distribute,
  lessonTopicsOf,
  lessonTargets,
  bankCandidates,
  assignCandidates,
  buildQuestionsPrompt,
  normalizeGenerated,
  placeGenerated,
  generate,
  generateItems,
  fillableTopics,
  fillPool,
};
