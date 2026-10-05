'use strict';

/**
 * Questões da aula preparadas em segundo plano, logo depois do cadastro.
 *
 *   const lessonQuestions = require('./lesson-questions');
 *   lessonQuestions.start();                     // server/index.js, depois do listen (nunca em teste)
 *   await lessonQuestions.processNext();          // uma aula da fila → { lesson_id, status, ... } | null
 *   await lessonQuestions.releaseInterrupted();   // boot (scripts/bootstrap.js): 'generating' → 'pending'
 *   await lessonQuestions.releaseStuck();         // lazy: 'generating' parado há muito tempo → 'pending'
 *   await lessonQuestions.requeue(ids);           // painel: "Preparar as questões de novo"
 *
 * Cadastrar uma aula (ou trocar os assuntos dela) põe lessons.questions_status
 * em 'pending' (routes/admin/lessons.js, services/lesson-topics.js). Este
 * processo pega as pendentes uma por vez e deixa no banco as três questões da
 * prática da aula na dificuldade média, divididas entre os assuntos dela — a
 * mesma divisão da prática (question-ai.lessonTargets). Assim o primeiro aluno
 * que clica em "Pratique agora" recebe questão pronta, sem esperar a IA e sem
 * gastar moeda.
 *
 * O que já existe no banco é reaproveitado, pela mesma regra da prática
 * (bankCandidates + assignCandidates): a IA só escreve o que falta. A chamada
 * é da plataforma (userId null): não passa pela cota diária de nenhum aluno
 * nem cobra moeda — um envio de 200 aulas não pode parar na 13ª por causa do
 * teto de 12 gerações por dia.
 *
 * A fila mora no banco, não na memória: um reinício no meio de um envio em
 * massa não perde nada. O que estava em 'generating' quando o processo caiu
 * volta para 'pending' no boot e, se o boot não rodar (npm start sem o
 * bootstrap), pela varredura preguiçosa a cada rodada.
 *
 * Falha não é o fim da aula. Se a IA nem respondeu (fora do ar, sem crédito,
 * chave recusada), a culpa não é da aula: ela volta para a fila sem gastar
 * tentativa e o laço espera alguns minutos antes da próxima, em vez de passar
 * a fila inteira para 'failed' a cada dois segundos. Se a IA respondeu sem as
 * questões que faltavam, conta uma tentativa e a aula volta mais tarde; só na
 * terceira ela fica 'failed'. De 'failed' ela sai pelo painel ("Preparar as
 * questões de novo"), e a rodada seguinte só pede o que ainda falta.
 */
const db = require('../db/pool');
const config = require('../config');
const ai = require('./ai');
const questionAi = require('./question-ai');

/** Nível das questões preparadas: o meio da escala, o que o aluno mais escolhe. */
const DIFICULDADE = 2;
/** Intervalo entre consultas à fila quando ela está vazia. */
const INTERVALO_OCIOSO_MS = 20_000;
/** Pausa entre uma aula e a próxima quando há fila: não sufoca o provedor da IA. */
const PAUSA_ENTRE_AULAS_MS = 2_000;
/** Primeira rodada depois que o servidor sobe, para não disputar com o boot. */
const PRIMEIRA_RODADA_MS = 10_000;
/**
 * A partir de quanto tempo 'generating' é trabalho órfão. Uma aula leva uma
 * chamada de IA (até 2 min, com a segunda tentativa até uns 4); quinze minutos
 * só passam se quem estava gerando morreu.
 */
const PRESA_MINUTOS = 15;
/** Rodadas que podem falhar por causa da própria aula antes de ela parar em 'failed'. */
const MAX_TENTATIVAS = 3;
/** Espera antes de tentar de novo a aula cuja rodada falhou; cresce a cada tentativa. */
const ESPERA_POR_TENTATIVA_MIN = 10;
/**
 * Quando a IA nem responde, o laço espera isto antes da próxima aula (e a
 * aula, antes de voltar a ser pega): uma consulta a cada poucos minutos
 * descobre quando a IA voltou sem queimar a fila.
 */
const PAUSA_IA_FORA_MS = 5 * 60_000;

const MSG_INTERROMPIDA = 'A geração foi interrompida quando a aplicação reiniciou. A aula voltou para a fila.';
const MSG_PRESA = 'A geração anterior parou no meio. A aula voltou para a fila.';

/** O motivo gravado na aula, dizendo também o que acontece com ela agora ('pending' ou 'failed'). */
function motivo(base, status) {
  if (status === 'failed') {
    return (
      `${base} Depois de ${MAX_TENTATIVAS} tentativas a fila parou de tentar esta aula: ` +
      'a prática completa o que faltar quando o aluno pedir, ou use "Preparar as questões de novo".'
    );
  }
  return `${base} A aula volta para a fila e é tentada de novo em alguns minutos.`;
}

/** Aulas que ESTE processo está gerando agora: a varredura de presas não mexe nelas. */
const emAndamento = new Set();

let timer = null;
let ligado = false;
let avisouSemIa = false;

// ---------------------------------------------------------------------------
// Recuperação
// ---------------------------------------------------------------------------

/**
 * Boot: ninguém está gerando quando o processo acabou de subir. Tudo o que
 * ficou em 'generating' volta para a fila. Só pode ser chamado antes de o
 * servidor começar a trabalhar (scripts/bootstrap.js).
 *
 * @returns {Promise<number>} quantas aulas voltaram para a fila
 */
async function releaseInterrupted() {
  const rows = await db.many(
    `UPDATE lessons
        SET questions_status = 'pending', questions_error = $1, questions_updated_at = now()
      WHERE questions_status = 'generating'
      RETURNING id`,
    [MSG_INTERROMPIDA]
  );
  return rows.length;
}

/**
 * Lazy: 'generating' parado há mais de `minutes` minutos, sem ser deste
 * processo, é de alguém que morreu. Volta para a fila.
 *
 * @returns {Promise<number>}
 */
async function releaseStuck({ minutes = PRESA_MINUTOS } = {}) {
  const rows = await db.many(
    `UPDATE lessons
        SET questions_status = 'pending', questions_error = $2, questions_updated_at = now()
      WHERE questions_status = 'generating'
        AND (questions_updated_at IS NULL OR questions_updated_at < now() - ($1::int * interval '1 minute'))
        AND NOT (id = ANY($3::uuid[]))
      RETURNING id`,
    [minutes, MSG_PRESA, [...emAndamento]]
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

/**
 * Pega a próxima aula pendente e marca 'generating' no mesmo comando. O SKIP
 * LOCKED deixa dois processos (ou duas rodadas) pegarem aulas diferentes em
 * vez de a mesma. Aula esperando depois de uma falha (questions_retry_at no
 * futuro) fica para depois.
 */
async function claimNext() {
  return db.one(
    `UPDATE lessons
        SET questions_status = 'generating', questions_updated_at = now()
      WHERE id = (
              SELECT id FROM lessons
               WHERE questions_status = 'pending'
                 AND (questions_retry_at IS NULL OR questions_retry_at <= now())
               ORDER BY questions_updated_at, id
               LIMIT 1
               FOR UPDATE SKIP LOCKED)
        AND questions_status = 'pending'
      RETURNING id`
  );
}

/**
 * Fecha a aula pronta. Só vale se ela ainda estiver em 'generating': se o
 * administrador trocou os assuntos no meio (a aula voltou para 'pending'), o
 * resultado desta rodada é dos assuntos antigos e a aula tem de ser feita de
 * novo — o que já foi gravado fica no banco e é reaproveitado.
 */
async function finishReady(lessonId) {
  await db.query(
    `UPDATE lessons
        SET questions_status = 'ready', questions_error = NULL, questions_updated_at = now(),
            questions_attempts = 0, questions_retry_at = NULL
      WHERE id = $1 AND questions_status = 'generating'`,
    [lessonId]
  );
}

/**
 * A rodada falhou: a aula volta para a fila com uma espera, ou para em
 * 'failed' quando a culpa é dela pela terceira vez. Mesma condição de
 * finishReady: aula que saiu de 'generating' no meio não é mexida.
 *
 * @param {{ base: string, contaTentativa: boolean, esperaMs?: number|null }} falha
 *   base: o que deu errado; contaTentativa: false quando a IA nem respondeu (não é culpa da aula)
 * @returns {Promise<{ status: 'pending'|'failed', attempts: number, error: string } | null>}
 *   null quando a aula saiu de 'generating'
 */
async function finishFailed(lessonId, { base, contaTentativa, esperaMs = null }) {
  // No SET, questions_attempts é o valor de antes: "+ $3" é a conta nova. O
  // motivo muda com o desfecho: a aula que parou não volta mais sozinha.
  return db.one(
    `UPDATE lessons
        SET questions_attempts = questions_attempts + $3::int,
            questions_status = CASE WHEN questions_attempts + $3::int >= $4::int THEN 'failed' ELSE 'pending' END,
            questions_retry_at = CASE
              WHEN questions_attempts + $3::int >= $4::int THEN NULL
              WHEN $5::int IS NOT NULL THEN now() + $5::int * interval '1 millisecond'
              ELSE now() + greatest(questions_attempts + $3::int, 1) * $6::int * interval '1 minute'
            END,
            questions_error = CASE WHEN questions_attempts + $3::int >= $4::int THEN $7 ELSE $2 END,
            questions_updated_at = now()
      WHERE id = $1 AND questions_status = 'generating'
      RETURNING questions_status AS status, questions_attempts AS attempts, questions_error AS error`,
    [
      lessonId,
      motivo(base, 'pending').slice(0, 1000),
      contaTentativa ? 1 : 0,
      MAX_TENTATIVAS,
      esperaMs === null ? null : Math.round(esperaMs),
      ESPERA_POR_TENTATIVA_MIN,
      motivo(base, 'failed').slice(0, 1000),
    ]
  );
}

/**
 * A IA nem respondeu? ai.chat converte todo erro do provedor (HTTP 4xx/5xx,
 * conexão recusada, tempo esgotado) em 503 'ai_unavailable' e guarda o erro
 * original em `cause`. Resposta que chegou mas veio inválida, cortada ou sem
 * questão aproveitável não tem `cause`: foi a IA respondendo mal para ESTA aula.
 */
function iaNaoRespondeu(err) {
  return Boolean(err && err.code === 'ai_unavailable' && err.cause);
}

async function loadLesson(lessonId) {
  return db.one(
    `SELECT l.id, l.title, l.description, l.summary, l.subject_id, s.name AS subject_name,
            l.topic_id, t.name AS topic_name, t.description AS topic_description,
            l.subtopic_id, st.name AS subtopic_name
       FROM lessons l
       JOIN subjects s ON s.id = l.subject_id
       JOIN topics t ON t.id = l.topic_id
       LEFT JOIN subtopics st ON st.id = l.subtopic_id
      WHERE l.id = $1`,
    [lessonId]
  );
}

/** A prova da aula dá o estilo do enunciado; sem prova marcada, o prompt segue sem. */
async function lessonExam(lessonId) {
  return db.one(
    `SELECT e.id, e.name, e.short_name, e.board
       FROM lesson_exams le JOIN exams e ON e.id = le.exam_id AND e.active
      WHERE le.lesson_id = $1
      ORDER BY e.sort_order, e.name
      LIMIT 1`,
    [lessonId]
  );
}

/**
 * Deixa no banco as questões da prática da aula: reaproveita o que serve e
 * pede à IA só o que falta.
 *
 * @returns {Promise<{ total: number, reused: number, created: number, missing: string[] } | null>}
 *   null quando a aula não existe mais
 */
async function prepareLesson(lessonId) {
  const lesson = await loadLesson(lessonId);
  if (!lesson) return null;

  const targets = await questionAi.lessonTargets(lesson);
  const candidates = await questionAi.bankCandidates({
    topicIds: targets.map((alvo) => alvo.topic_id),
    difficulty: DIFICULDADE,
    userId: null,
  });
  const assigned = questionAi.assignCandidates(targets, candidates);
  const reused = assigned.filter((item) => item.question_id).length;
  const vazias = assigned.filter((item) => !item.question_id);

  let created = 0;
  if (vazias.length) {
    const geradas = await questionAi.generateItems({
      subject: { id: lesson.subject_id, name: lesson.subject_name },
      topic: { id: lesson.topic_id, name: lesson.topic_name, description: lesson.topic_description },
      lesson,
      exam: await lessonExam(lesson.id),
      difficulty: DIFICULDADE,
      targets: vazias.map((item) => item.target),
      // trabalho da plataforma: sem cota diária de aluno e sem moeda
      userId: null,
      timeoutMs: questionAi.TIMEOUT_MS,
    });
    created = geradas.length;
    for (const gerada of geradas) {
      const vaga = vazias[gerada.index];
      if (vaga && !vaga.question_id) vaga.question_id = gerada.id;
    }
  }

  return {
    total: targets.length,
    reused,
    created,
    missing: assigned.filter((item) => !item.question_id).map((item) => item.target.name),
  };
}

/**
 * Processa a próxima aula da fila.
 *
 * Termina em 'ready' quando todas as vagas da prática têm questão. Quando
 * falha, a aula volta para 'pending' com uma espera (questions_retry_at) e o
 * motivo em questions_error; só para em 'failed' depois de MAX_TENTATIVAS
 * rodadas em que a IA respondeu sem o que faltava. O que ficou pronto
 * continua no banco: a rodada seguinte, e a prática do aluno, só completam o
 * resto.
 *
 * @returns {Promise<null | { lesson_id: string, status: 'ready'|'pending'|'failed', total?: number,
 *   reused?: number, created?: number, missing?: string[], error?: string, attempts?: number,
 *   ai_down?: boolean }>}
 *   null quando não há aula pendente (ou a IA não está configurada); ai_down quando a IA nem
 *   respondeu e o laço deve esperar antes da próxima
 */
async function processNext() {
  await releaseStuck();
  if (!ai.isConfigured()) {
    // Sem IA não adianta tirar a aula da fila: ela espera a chave ser
    // configurada em vez de virar 'failed' em massa.
    if (!avisouSemIa) console.warn('[lesson-questions] IA não configurada: as questões das aulas ficam na fila.');
    avisouSemIa = true;
    return null;
  }

  const claimed = await claimNext();
  if (!claimed) return null;
  const lessonId = claimed.id;
  emAndamento.add(lessonId);
  try {
    const outcome = await prepareLesson(lessonId);
    if (!outcome) return { lesson_id: lessonId, status: 'failed', error: 'Aula não encontrada.' };
    if (outcome.missing.length) {
      const fechamento = await finishFailed(lessonId, {
        base: `Ficaram ${outcome.missing.length} de ${outcome.total} questões sem elaborar (${outcome.missing.join(', ')}).`,
        contaTentativa: true,
      });
      return { lesson_id: lessonId, ...outcome, ...fechado(fechamento) };
    }
    await finishReady(lessonId);
    return { lesson_id: lessonId, status: 'ready', ...outcome };
  } catch (err) {
    const base = (err && err.message) || 'Não foi possível elaborar as questões da aula.';
    const foraDoAr = iaNaoRespondeu(err);
    console.warn(`[lesson-questions] aula ${lessonId}${foraDoAr ? ' (a IA não respondeu)' : ''}: ${base}`);
    let fechamento = null;
    try {
      fechamento = await finishFailed(lessonId, {
        base,
        contaTentativa: !foraDoAr,
        esperaMs: foraDoAr ? PAUSA_IA_FORA_MS : null,
      });
    } catch {
      // banco fora do ar: a aula fica em 'generating' e a varredura de presas a devolve
    }
    return { lesson_id: lessonId, ...fechado(fechamento, base), ai_down: foraDoAr };
  } finally {
    emAndamento.delete(lessonId);
  }
}

/** O desfecho de uma rodada que falhou, no formato de processNext. Sem linha: a aula saiu de 'generating' no meio. */
function fechado(fechamento, base = '') {
  if (!fechamento) return { status: 'pending', error: base || null };
  return { status: fechamento.status, attempts: fechamento.attempts, error: fechamento.error };
}

/**
 * "Preparar as questões de novo", no painel: põe as aulas na fila na hora,
 * com as tentativas zeradas. Vale para a que falhou, para a pronta (alguém
 * apagou uma questão dela) e para a de antes da preparação automática; a que
 * já está na fila ou sendo preparada fica como está. A rodada só pede à IA o
 * que ainda falta.
 *
 * @param {string[]} ids
 * @returns {Promise<string[]>} as aulas que entraram na fila
 */
async function requeue(ids) {
  if (!ids.length) return [];
  const rows = await db.many(
    `UPDATE lessons
        SET questions_status = 'pending', questions_error = NULL, questions_updated_at = now(),
            questions_attempts = 0, questions_retry_at = NULL
      WHERE id = ANY($1::uuid[]) AND questions_status IN ('none', 'ready', 'failed')
      RETURNING id`,
    [ids]
  );
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Laço
// ---------------------------------------------------------------------------

function schedule(ms) {
  if (!ligado) return;
  timer = setTimeout(tick, ms);
  // o laço nunca segura o processo de pé: o encerramento não espera por ele
  timer.unref();
}

/** Quanto esperar depois desta rodada. IA fora do ar: alguns minutos, em vez de seguir a fila. */
function proximaRodadaMs(resultado) {
  if (!resultado) return INTERVALO_OCIOSO_MS;
  if (resultado.ai_down) return PAUSA_IA_FORA_MS;
  return PAUSA_ENTRE_AULAS_MS;
}

async function tick() {
  timer = null;
  let resultado = null;
  try {
    resultado = await processNext();
  } catch (err) {
    // banco fora do ar, por exemplo: tenta de novo na próxima rodada
    console.error(`[lesson-questions] rodada falhou: ${err.message}`);
  }
  schedule(proximaRodadaMs(resultado));
}

/**
 * Liga o laço junto com o servidor. Em teste não liga: os testes chamam
 * processNext() direto, na hora que querem, sem um timer disputando a fila.
 */
function start({ firstDelayMs = PRIMEIRA_RODADA_MS } = {}) {
  if (config.isTest || ligado) return false;
  ligado = true;
  schedule(firstDelayMs);
  return true;
}

function stop() {
  ligado = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  DIFICULDADE,
  PRESA_MINUTOS,
  MAX_TENTATIVAS,
  PAUSA_IA_FORA_MS,
  processNext,
  prepareLesson,
  proximaRodadaMs,
  releaseStuck,
  releaseInterrupted,
  requeue,
  start,
  stop,
};
