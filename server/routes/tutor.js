'use strict';

/**
 * Tutor IA — conversas do aluno com o professor virtual.
 *
 *   GET    /api/tutor/status                    → { available, configured, limit_reached }
 *   GET    /api/tutor/conversations             → lista das conversas do aluno (mais recentes primeiro)
 *   POST   /api/tutor/conversations             { subject_id?, topic_id?, lesson_id?, question_id?, essay_id? }
 *   GET    /api/tutor/conversations/:id         → conversa + mensagens + contexto
 *   DELETE /api/tutor/conversations/:id
 *   POST   /api/tutor/conversations/:id/messages { content } → SSE (delta / done / error)
 *
 * A resposta do tutor é enviada em text/event-stream: eventos `delta` { text }, `done`
 * { message_id, usage, title } e `error` { code, message }, com heartbeat a cada 15s.
 * O prompt de sistema é a configuração `tutor_system_prompt` somada ao contexto da conversa
 * (prova e nível do aluno, matéria, assunto, aula, questão ou redação) e às últimas 20 mensagens.
 *
 * Toda consulta filtra por user_id = req.user.id: um aluno nunca lê a conversa de outro.
 */
const router = require('express').Router();
const db = require('../db/pool');
const ai = require('../services/ai');
const { getSetting } = require('../services/settings');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const { aiLimiter } = require('../middleware/rateLimit');

const DEFAULT_TITLE = 'Nova conversa';
const MAX_TITLE_CHARS = 120;
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_SUMMARY_CHARS = 2000;
const MAX_STATEMENT_CHARS = 2000;
const HEARTBEAT_MS = 15_000;

const LEVEL_LABELS = {
  iniciante: 'iniciante',
  intermediario: 'intermediário',
  avancado: 'avançado',
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

const createSchema = z
  .object({
    subject_id: uuid.nullish(),
    topic_id: uuid.nullish(),
    lesson_id: uuid.nullish(),
    question_id: uuid.nullish(),
    essay_id: uuid.nullish(),
  })
  .default({});

const messageSchema = z.object({
  content: z.string().trim().min(1, 'Escreva sua dúvida.').max(MAX_MESSAGE_CHARS),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clip(text, max) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Prova do aluno + nível (usado no contexto do prompt). */
async function loadStudentContext(userId) {
  return db.one(
    `SELECT p.level, p.exam_id, x.name AS exam_name, x.short_name AS exam_short_name, x.track AS exam_track
       FROM student_profiles p
       LEFT JOIN exams x ON x.id = p.exam_id
      WHERE p.user_id = $1`,
    [userId]
  );
}

/**
 * Resolve as referências enviadas na criação da conversa (aula, questão, redação, assunto, matéria),
 * devolvendo os identificadores normalizados e o título da conversa.
 */
async function resolveReferences(userId, input) {
  const resolved = {
    subject_id: null,
    topic_id: null,
    lesson_id: null,
    question_id: null,
    essay_id: null,
    exam_id: null,
  };
  let title = DEFAULT_TITLE;

  if (input.lesson_id) {
    const lesson = await db.one(
      `SELECT l.id, l.title, l.subject_id, l.topic_id FROM lessons l WHERE l.id = $1 AND l.active`,
      [input.lesson_id]
    );
    if (!lesson) throw new AppError(404, 'not_found', 'Aula não encontrada.');
    resolved.lesson_id = lesson.id;
    resolved.subject_id = lesson.subject_id;
    resolved.topic_id = lesson.topic_id;
    title = `Dúvida sobre a aula "${truncate(lesson.title, 80)}"`;
  }

  if (input.question_id) {
    const question = await db.one(
      `SELECT q.id, q.statement, q.subject_id, q.topic_id, t.name AS topic_name
         FROM questions q
         LEFT JOIN topics t ON t.id = q.topic_id
        WHERE q.id = $1 AND q.active`,
      [input.question_id]
    );
    if (!question) throw new AppError(404, 'not_found', 'Questão não encontrada.');
    resolved.question_id = question.id;
    resolved.subject_id = resolved.subject_id || question.subject_id;
    resolved.topic_id = resolved.topic_id || question.topic_id;
    if (!input.lesson_id) {
      title = question.topic_name
        ? `Dúvida sobre uma questão de ${truncate(question.topic_name, 70)}`
        : 'Dúvida sobre uma questão';
    }
  }

  if (input.essay_id) {
    const essay = await db.one(
      `SELECT id, theme_title, exam_id FROM essays WHERE id = $1 AND user_id = $2`,
      [input.essay_id, userId]
    );
    if (!essay) throw new AppError(404, 'not_found', 'Redação não encontrada.');
    resolved.essay_id = essay.id;
    resolved.exam_id = essay.exam_id;
    if (!input.lesson_id && !input.question_id) {
      title = `Dúvida sobre a redação "${truncate(essay.theme_title, 70)}"`;
    }
  }

  if (input.topic_id) {
    const topic = await db.one(
      `SELECT t.id, t.name, t.subject_id FROM topics t WHERE t.id = $1 AND t.active`,
      [input.topic_id]
    );
    if (!topic) throw new AppError(404, 'not_found', 'Assunto não encontrado.');
    resolved.topic_id = topic.id;
    resolved.subject_id = resolved.subject_id || topic.subject_id;
    if (!input.lesson_id && !input.question_id && !input.essay_id) {
      title = `Dúvida sobre ${truncate(topic.name, 80)}`;
    }
  }

  if (input.subject_id) {
    const subject = await db.one(`SELECT id, name FROM subjects WHERE id = $1 AND active`, [input.subject_id]);
    if (!subject) throw new AppError(404, 'not_found', 'Matéria não encontrada.');
    resolved.subject_id = resolved.subject_id || subject.id;
    if (!input.lesson_id && !input.question_id && !input.essay_id && !input.topic_id) {
      title = `Dúvida sobre ${truncate(subject.name, 80)}`;
    }
  }

  if (!resolved.exam_id) {
    const profile = await loadStudentContext(userId);
    resolved.exam_id = profile ? profile.exam_id : null;
  }

  return { resolved, title: truncate(title, MAX_TITLE_CHARS) };
}

const CONVERSATION_COLUMNS = `
  c.id, c.user_id, c.title, c.exam_id, c.subject_id, c.topic_id, c.lesson_id, c.question_id, c.essay_id,
  c.created_at, c.updated_at,
  x.name AS exam_name, x.short_name AS exam_short_name,
  s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
  t.name AS topic_name, l.title AS lesson_title, e.theme_title AS essay_title`;

const CONVERSATION_JOINS = `
  LEFT JOIN exams x ON x.id = c.exam_id
  LEFT JOIN subjects s ON s.id = c.subject_id
  LEFT JOIN topics t ON t.id = c.topic_id
  LEFT JOIN lessons l ON l.id = c.lesson_id
  LEFT JOIN essays e ON e.id = c.essay_id AND e.user_id = c.user_id`;

/** Conversa do aluno (404 quando não existe ou pertence a outro aluno). */
async function findConversation(userId, id) {
  return db.one(
    `SELECT ${CONVERSATION_COLUMNS}
       FROM tutor_conversations c ${CONVERSATION_JOINS}
      WHERE c.id = $1 AND c.user_id = $2`,
    [id, userId]
  );
}

/**
 * Monta o prompt de sistema: configuração tutor_system_prompt + contexto da conversa.
 * Cada informação vai em uma linha própria ("Matéria: ...") para ficar fácil de ler pelo modelo.
 */
async function buildSystemPrompt(conversation, userId) {
  const [basePrompt, profile] = await Promise.all([getSetting('tutor_system_prompt'), loadStudentContext(userId)]);

  const lines = [];
  const examName = conversation.exam_name || (profile && profile.exam_name) || null;
  if (examName) lines.push(`Prova: ${examName}`);
  if (profile && profile.level) lines.push(`Nível do aluno: ${LEVEL_LABELS[profile.level] || profile.level}`);
  if (conversation.subject_name) lines.push(`Matéria: ${conversation.subject_name}`);
  if (conversation.topic_name) lines.push(`Assunto: ${conversation.topic_name}`);

  if (conversation.lesson_id) {
    const lesson = await db.one(
      `SELECT title, description, summary, duration_min FROM lessons WHERE id = $1`,
      [conversation.lesson_id]
    );
    if (lesson) {
      lines.push(`Aula: ${lesson.title}`);
      const summary = clip(lesson.summary || lesson.description, MAX_SUMMARY_CHARS);
      if (summary) {
        lines.push('Resumo da aula:');
        lines.push(summary);
      }
    }
  }

  if (conversation.question_id) {
    const question = await db.one(
      `SELECT q.statement, q.resolution, q.explanation,
              COALESCE((
                SELECT json_agg(json_build_object('letter', o.letter, 'text', o.text, 'is_correct', o.is_correct)
                                ORDER BY o.sort_order, o.letter)
                  FROM question_options o WHERE o.question_id = q.id
              ), '[]'::json) AS options
         FROM questions q WHERE q.id = $1`,
      [conversation.question_id]
    );
    if (question) {
      lines.push('Questão em discussão:');
      lines.push(clip(question.statement, MAX_STATEMENT_CHARS));
      const options = Array.isArray(question.options) ? question.options : [];
      if (options.length > 0) {
        lines.push('Alternativas:');
        for (const option of options) {
          lines.push(`${option.letter}) ${clip(option.text, 400)}${option.is_correct ? '  [correta]' : ''}`);
        }
      }
      const resolution = clip(question.resolution, 1500);
      if (resolution) {
        lines.push('Resolução oficial:');
        lines.push(resolution);
      }
      const explanation = clip(question.explanation, 800);
      if (explanation) lines.push(`Explicação: ${explanation}`);
      lines.push('Conduza o aluno pelo raciocínio antes de confirmar a alternativa correta.');
    }
  }

  if (conversation.essay_id) {
    const essay = await db.one(
      `SELECT theme_title, score, max_score, status, correction FROM essays WHERE id = $1 AND user_id = $2`,
      [conversation.essay_id, userId]
    );
    if (essay) {
      lines.push(`Redação: ${essay.theme_title}`);
      if (essay.score !== null && essay.score !== undefined) {
        lines.push(`Nota da redação: ${essay.score} de ${essay.max_score}`);
      }
      const correction = essay.correction || {};
      if (correction.summary) lines.push(`Parecer geral: ${clip(correction.summary, 900)}`);
      if (Array.isArray(correction.criteria) && correction.criteria.length > 0) {
        lines.push('Notas por critério:');
        for (const item of correction.criteria.slice(0, 10)) {
          lines.push(`- ${item.name}: ${item.score} de ${item.max}. ${clip(item.comment, 400)}`);
        }
      }
      if (Array.isArray(correction.weaknesses) && correction.weaknesses.length > 0) {
        lines.push(`Pontos a melhorar: ${correction.weaknesses.slice(0, 6).join(' ')}`);
      }
    }
  }

  const context = lines.length > 0 ? `\n\nContexto desta conversa:\n${lines.join('\n')}` : '';
  const closing = lines.length > 0
    ? '\n\nUse o contexto acima como referência principal das suas respostas; se o aluno mudar de assunto, acompanhe-o.'
    : '';
  return `${basePrompt}${context}${closing}`;
}

/** Últimas mensagens da conversa em ordem cronológica. */
async function loadHistory(conversationId, limit = MAX_HISTORY_MESSAGES) {
  const rows = await db.many(
    `SELECT role, content FROM (
       SELECT role, content, created_at, id
         FROM tutor_messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
     ) recentes
     ORDER BY created_at ASC, id ASC`,
    [conversationId, limit]
  );
  return rows.map((row) => ({ role: row.role, content: row.content }));
}

/** Título a partir da primeira pergunta do aluno (usado quando não há contexto). */
function titleFromMessage(content) {
  const clean = String(content || '').replace(/\s+/g, ' ').trim();
  if (!clean) return DEFAULT_TITLE;
  const sentence = clean.split(/[.?!\n]/)[0].trim() || clean;
  const base = sentence.length > 60 ? `${sentence.slice(0, 59)}…` : sentence;
  return truncate(base.charAt(0).toUpperCase() + base.slice(1), MAX_TITLE_CHARS);
}

function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------
router.use(requireStudent);

// Situação da integração — não exige assinatura (o front usa para esconder o Tutor).
router.get(
  '/status',
  wrap(async (req, res) => {
    const info = await ai.status();
    res.json({
      available: Boolean(info.configured) && !info.limit_reached,
      configured: Boolean(info.configured),
      limit_reached: Boolean(info.limit_reached),
    });
  })
);

router.use(requireAccess);

router.get(
  '/conversations',
  validate({ query: listQuerySchema }),
  wrap(async (req, res) => {
    const limit = req.valid.query.limit || 100;
    const rows = await db.many(
      `SELECT ${CONVERSATION_COLUMNS},
              (SELECT count(*)::int FROM tutor_messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT m.content FROM tutor_messages m
                WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
              (SELECT m.created_at FROM tutor_messages m
                WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_at
         FROM tutor_conversations c ${CONVERSATION_JOINS}
        WHERE c.user_id = $1
        ORDER BY c.updated_at DESC
        LIMIT $2`,
      [req.user.id, limit]
    );
    res.json(
      rows.map((row) => ({
        ...row,
        last_message: row.last_message ? truncate(row.last_message, 180) : null,
      }))
    );
  })
);

router.post(
  '/conversations',
  validate({ body: createSchema }),
  wrap(async (req, res) => {
    const input = req.valid.body || {};
    const { resolved, title } = await resolveReferences(req.user.id, input);

    const created = await db.one(
      `INSERT INTO tutor_conversations (user_id, title, exam_id, subject_id, topic_id, lesson_id, question_id, essay_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        req.user.id,
        title,
        resolved.exam_id,
        resolved.subject_id,
        resolved.topic_id,
        resolved.lesson_id,
        resolved.question_id,
        resolved.essay_id,
      ]
    );

    const conversation = await findConversation(req.user.id, created.id);
    res.status(201).json({ ...conversation, messages: [], message_count: 0 });
  })
);

router.get(
  '/conversations/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const conversation = await findConversation(req.user.id, req.valid.params.id);
    if (!conversation) throw new AppError(404, 'not_found', 'Conversa não encontrada.');

    const messages = await db.many(
      `SELECT id, role, content, tokens, created_at
         FROM tutor_messages WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`,
      [conversation.id]
    );
    res.json({ ...conversation, messages, message_count: messages.length });
  })
);

router.delete(
  '/conversations/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const removed = await db.one(
      'DELETE FROM tutor_conversations WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.valid.params.id, req.user.id]
    );
    if (!removed) throw new AppError(404, 'not_found', 'Conversa não encontrada.');
    res.status(204).end();
  })
);

router.post(
  '/conversations/:id/messages',
  aiLimiter,
  validate({ params: idParams, body: messageSchema }),
  wrap(async (req, res) => {
    const conversation = await findConversation(req.user.id, req.valid.params.id);
    if (!conversation) throw new AppError(404, 'not_found', 'Conversa não encontrada.');

    // Verificações que podem virar erro HTTP normal precisam acontecer ANTES de abrir o stream.
    await ai.assertAvailable();

    const content = req.valid.body.content;
    const previous = await db.one(
      `SELECT count(*)::int AS total FROM tutor_messages WHERE conversation_id = $1`,
      [conversation.id]
    );
    const isFirstExchange = !previous || previous.total === 0;

    const userMessage = await db.one(
      `INSERT INTO tutor_messages (conversation_id, role, content) VALUES ($1, 'user', $2) RETURNING id, created_at`,
      [conversation.id, content]
    );

    const [system, history] = await Promise.all([
      buildSystemPrompt(conversation, req.user.id),
      loadHistory(conversation.id, MAX_HISTORY_MESSAGES),
    ]);
    const messages = [{ role: 'system', content: system }, ...history];

    // ---- abre o stream ----------------------------------------------------
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform impede que a compressão do Express segure os trechos
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`event: start\ndata: ${JSON.stringify({ user_message_id: userMessage.id })}\n\n`);
    if (typeof res.flush === 'function') res.flush();

    const controller = new AbortController();
    let closed = false;
    // 'close' na resposta cobre a desconexão do aluno; writableEnded evita confundir com o fim normal
    const onClose = () => {
      if (res.writableEnded) return;
      closed = true;
      controller.abort();
    };
    res.on('close', onClose);

    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    }, HEARTBEAT_MS);

    let answer = '';
    try {
      const result = await ai.chat({
        messages,
        stream: true,
        temperature: 0.4,
        maxTokens: 1500,
        userId: req.user.id,
        feature: 'tutor',
        signal: controller.signal,
        onDelta: (text) => {
          answer += text;
          if (!closed) sseEvent(res, 'delta', { text });
        },
      });

      const finalText = (result.content || answer).trim();
      let messageId = null;
      if (finalText) {
        const saved = await db.one(
          `INSERT INTO tutor_messages (conversation_id, role, content, tokens)
           VALUES ($1, 'assistant', $2, $3) RETURNING id`,
          [conversation.id, finalText, result.usage ? result.usage.completion_tokens : null]
        );
        messageId = saved.id;
      }

      // Título na primeira troca: mantém o contexto quando existe, senão usa a pergunta do aluno.
      let title = conversation.title;
      if (isFirstExchange && (!title || title === DEFAULT_TITLE)) {
        title = titleFromMessage(content);
      }
      await db.query('UPDATE tutor_conversations SET title = $2, updated_at = now() WHERE id = $1', [
        conversation.id,
        title,
      ]);

      if (!closed) {
        sseEvent(res, 'done', {
          message_id: messageId,
          user_message_id: userMessage.id,
          usage: result.usage,
          title,
          aborted: Boolean(result.aborted),
        });
      }
    } catch (err) {
      const isApp = err instanceof AppError;
      if (!isApp) console.error('[tutor] falha ao responder:', err && err.message ? err.message : err);
      if (!closed) {
        sseEvent(res, 'error', {
          code: isApp ? err.code : 'ai_unavailable',
          message: isApp ? err.message : 'Não foi possível responder agora. Tente novamente em instantes.',
        });
      }
    } finally {
      clearInterval(heartbeat);
      res.off('close', onClose);
      res.end();
    }
  })
);

module.exports = { basePath: '/api/tutor', router };
