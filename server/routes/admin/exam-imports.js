'use strict';

/**
 * Painel administrativo — prova em PDF vira banco de questões.
 *
 *   GET    /api/admin/exam-imports              leituras recentes
 *   POST   /api/admin/exam-imports              { title, source_url, exam_id?, past_exam_id?, year?, board?,
 *                                                 answer_key? } → cria a leitura
 *   POST   /api/admin/exam-imports/:id/text     { chunk, done } → o texto do PDF sobe em pedaços
 *   POST   /api/admin/exam-imports/:id/sweep    varre UM lote e devolve o que encontrou + o progresso
 *   GET    /api/admin/exam-imports/:id          leitura + itens encontrados
 *   PATCH  /api/admin/exam-imports/:id/items/:itemId  corrige matéria, assunto, gabarito ou dificuldade
 *   POST   /api/admin/exam-imports/:id/import   { item_ids } → manda para o banco de questões
 *   DELETE /api/admin/exam-imports/:id
 *   GET    /api/admin/exam-imports/provas                 provas anteriores com PDF, para escolher
 *   GET    /api/admin/exam-imports/provas/:id/arquivo/prova|gabarito
 *                                                        entrega o PDF pelo próprio domínio
 *
 * Por que em lotes: uma prova do ENEM tem 90 questões e o texto passa de 200
 * mil caracteres. Isso não cabe em uma chamada de IA nem em uma requisição
 * HTTP. Cada varredura é uma requisição curta, e onde ela parou fica gravado —
 * fechar a aba custa "continuar de onde parou", não recomeçar.
 *
 * O PDF é lido no navegador de quem está no painel (public/js/components/pdf-text.js).
 * O arquivo nunca é enviado à IA: em base64 ele seria contado como consumo de
 * tokens e derrubaria o teto mensal que o Tutor e a redação compartilham.
 *
 * A gravação da questão reaproveita a importação por planilha — mesma validação
 * de alternativa, mesma resolução de slug, mesmas mensagens de erro.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { aiLimiter } = require('../../middleware/rateLimit');
const { nullableFileRef } = require('../../utils/validators');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const uploads = require('../../services/uploads');
const examImport = require('../../services/exam-import');
const { buildImportRow, loadSlugMaps, insertQuestion, RowError } = require('./questions');

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const itemParams = z.object({ id: uuid, itemId: uuid });
const arquivoParams = z.object({ id: uuid, qual: z.enum(['prova', 'gabarito']) });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const optionalUuid = z.preprocess(emptyToUndefined, uuid.optional());

const LIST_LIMIT = 30;
/** Cada pedaço do texto cabe folgado no corpo aceito pelo servidor (2 MB). */
const MAX_CHUNK_CHARS = 400_000;

const createBody = z
  .object({
    title: z.string().trim().min(3, 'Dê um nome para esta leitura.').max(200),
    source_url: nullableFileRef(2000, 'Informe o endereço do PDF ou envie o arquivo.'),
    exam_id: optionalUuid,
    past_exam_id: optionalUuid,
    year: z.preprocess(emptyToNull, z.coerce.number().int().min(1950).max(2100).nullable().optional()),
    board: z.preprocess(emptyToNull, z.string().trim().max(80).nullable().optional()),
    answer_key: z.preprocess(emptyToNull, z.string().trim().max(20_000).nullable().optional()),
  })
  .strict();

const textBody = z
  .object({
    chunk: z.string().max(MAX_CHUNK_CHARS),
    done: z.boolean().optional(),
  })
  .strict();

const itemBody = z
  .object({
    subject_slug: z.string().trim().max(120).optional(),
    topic_slug: z.string().trim().max(120).optional(),
    subtopic_slug: z.preprocess(emptyToNull, z.string().trim().max(120).nullable().optional()),
    correct: z.string().trim().toUpperCase().regex(/^[A-E]$/, 'Use uma letra de A a E.').optional(),
    difficulty: z.coerce.number().int().min(1).max(3).optional(),
    statement: z.string().trim().min(10).max(8000).optional(),
    status: z.enum(['pendente', 'recusada']).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nada para alterar.');

const importBody = z
  .object({ item_ids: z.array(uuid).min(1, 'Escolha ao menos uma questão.').max(300) })
  .strict();

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

async function loadImport(id) {
  const row = await db.one(
    `SELECT i.*, e.name AS exam_name, e.short_name AS exam_short_name, e.board AS exam_board
       FROM exam_imports i
       LEFT JOIN exams e ON e.id = i.exam_id
      WHERE i.id = $1`,
    [id]
  );
  if (!row) throw new AppError(404, 'not_found', 'Leitura de prova não encontrada.');
  return row;
}

/** Resumo para a lista e para o cabeçalho da tela (sem o texto inteiro). */
function serialize(row, { counts = null } = {}) {
  const { document_text, ...rest } = row;
  const chars = Number(row.chars_total) || 0;
  return {
    ...rest,
    answer_key_count: row.answer_key ? Object.keys(row.answer_key).length : 0,
    answer_key: undefined,
    percent: chars > 0 ? Math.min(100, Math.round((Number(row.chars_read) / chars) * 100)) : 0,
    has_text: Boolean(document_text),
    counts,
  };
}

async function itemCounts(importId) {
  const row = await db.one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'pendente')::int AS pendentes,
            count(*) FILTER (WHERE status = 'importada')::int AS importadas,
            count(*) FILTER (WHERE status = 'recusada')::int AS recusadas,
            count(*) FILTER (WHERE status = 'pendente'
                             AND coalesce((payload->>'answer_from_key')::boolean, false))::int AS com_gabarito
       FROM exam_import_items WHERE import_id = $1`,
    [importId]
  );
  return row || { total: 0, pendentes: 0, importadas: 0, recusadas: 0, com_gabarito: 0 };
}

router.get(
  '/',
  wrap(async (req, res) => {
    const rows = await db.many(
      `SELECT i.id, i.title, i.source_url, i.exam_id, i.year, i.board, i.status,
              i.chars_total, i.chars_read, i.found_count, i.imported_count, i.last_number,
              i.error_message, i.created_at, i.updated_at,
              e.short_name AS exam_short_name
         FROM exam_imports i
         LEFT JOIN exams e ON e.id = i.exam_id
        ORDER BY i.created_at DESC
        LIMIT $1`,
      [LIST_LIMIT]
    );
    res.json({ items: rows.map((row) => serialize(row)), total: rows.length });
  })
);

router.post(
  '/',
  validate({ body: createBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const { key, count } = examImport.parseAnswerKey(body.answer_key);

    const created = await db.one(
      `INSERT INTO exam_imports (title, source_url, exam_id, past_exam_id, year, board, answer_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING *`,
      [
        body.title,
        body.source_url,
        body.exam_id || null,
        body.past_exam_id || null,
        body.year ?? null,
        body.board ?? null,
        count ? JSON.stringify(key) : null,
        req.admin ? req.admin.id : null,
      ]
    );
    await audit(req, 'exam_import.create', 'exam_import', created.id, { title: body.title, answer_key: count });
    // Relê com o nome do vestibular: o INSERT devolve só o id, e a tela ficava
    // dizendo "Sem vestibular" numa leitura que tinha vestibular.
    const completo = await loadImport(created.id);
    res.status(201).json({ ...serialize(completo), answer_key_count: count });
  })
);

/**
 * As provas anteriores que já têm PDF cadastrado.
 *
 * O cliente sobe a prova uma vez em "Provas anteriores"; ler as questões dela
 * não pode exigir enviar o mesmo arquivo de novo.
 */
/**
 * Matérias e assuntos com nome E identificador.
 *
 * A tela de conferência precisa deixar o administrador corrigir a
 * classificação escolhendo pelo NOME — o identificador não aparece em lugar
 * nenhum do painel, e exigir que ele o soubesse deixava a questão presa.
 */
router.get(
  '/taxonomia',
  wrap(async (req, res) => {
    const rows = await db.many(
      `SELECT s.slug AS subject_slug, s.name AS subject_name,
              t.slug AS topic_slug, t.name AS topic_name
         FROM topics t
         JOIN subjects s ON s.id = t.subject_id AND s.active
        WHERE t.active
        ORDER BY s.sort_order, s.name, t.sort_order, t.name`
    );
    const materias = new Map();
    for (const row of rows) {
      if (!materias.has(row.subject_slug)) {
        materias.set(row.subject_slug, { slug: row.subject_slug, name: row.subject_name, topics: [] });
      }
      materias.get(row.subject_slug).topics.push({ slug: row.topic_slug, name: row.topic_name });
    }
    res.json({ items: [...materias.values()] });
  })
);

router.get(
  '/provas',
  wrap(async (req, res) => {
    const rows = await db.many(
      `SELECT p.id, p.title, p.year, p.day, p.board, p.pdf_url, p.exam_id,
              (p.answer_key_url IS NOT NULL AND p.answer_key_url <> '') AS tem_gabarito,
              e.name AS exam_name, e.short_name AS exam_short_name, e.board AS exam_board,
              (SELECT count(*)::int FROM exam_imports i WHERE i.past_exam_id = p.id) AS leituras
         FROM past_exams p
         LEFT JOIN exams e ON e.id = p.exam_id
        WHERE p.pdf_url IS NOT NULL AND p.pdf_url <> ''
        ORDER BY p.year DESC, e.sort_order, p.sort_order, p.title`
    );
    res.json({ items: rows, total: rows.length });
  })
);

/**
 * Entrega o PDF de uma prova anterior pelo próprio domínio.
 *
 * O arquivo mora no Blob da Square Cloud, em outro endereço. O navegador do
 * administrador não pode buscá-lo direto: a política de segurança da página
 * (connect-src 'self') barra, e afrouxá-la valeria para o site inteiro. Aqui o
 * servidor busca e devolve — e a origem do arquivo vem do banco, nunca de um
 * endereço que alguém tenha digitado.
 */
router.get(
  '/provas/:id/arquivo/:qual',
  validate({ params: arquivoParams }),
  wrap(async (req, res) => {
    const { id, qual } = req.valid.params;
    const prova = await db.one('SELECT id, title, pdf_url, answer_key_url FROM past_exams WHERE id = $1', [id]);
    const endereco = prova && (qual === 'gabarito' ? prova.answer_key_url : prova.pdf_url);
    if (!endereco) {
      throw new AppError(
        404,
        'not_found',
        qual === 'gabarito' ? 'Esta prova não tem gabarito cadastrado.' : 'Esta prova não tem PDF cadastrado.'
      );
    }

    const url = String(endereco).trim();
    res.setHeader('Content-Type', 'application/pdf');

    // Caminho interno: o arquivo está no disco da própria aplicação.
    if (url.startsWith('/uploads/')) {
      const alvo = path.join(uploads.UPLOADS_DIR, url.replace('/uploads/', ''));
      if (!alvo.startsWith(uploads.UPLOADS_DIR) || !fs.existsSync(alvo)) {
        throw new AppError(404, 'not_found', 'O arquivo desta prova não foi encontrado no servidor.');
      }
      // pipeline e não pipe: `pipe` não repassa erro, e um erro de stream sem
      // tratamento derruba o processo inteiro — é o que acontecia quando o
      // navegador desistia no meio do download.
      return pipeline(fs.createReadStream(alvo), res).catch(() => {});
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new AppError(409, 'conflict', 'O endereço do PDF desta prova não é um arquivo que a plataforma consiga abrir.');
    }

    // Link do Google Drive abre o visualizador, não o arquivo. Sem converter,
    // a leitura receberia uma página HTML e diria que o PDF não tem texto.
    const destino = examImport.directDownloadUrl(url);
    const resposta = await fetch(destino, { redirect: 'follow' });
    if (!resposta.ok || !resposta.body) {
      throw new AppError(502, 'bad_gateway', `Não foi possível baixar o PDF desta prova (HTTP ${resposta.status}).`);
    }

    // O Drive devolve HTML quando o arquivo não é público — e um HTML servido
    // como PDF vira "este arquivo não tem texto", que manda olhar o lugar errado.
    const tipo = String(resposta.headers.get('content-type') || '');
    if (/text\/html/i.test(tipo)) {
      throw new AppError(
        409,
        'conflict',
        examImport.isDriveUrl(url)
          ? 'O Google Drive não entregou o arquivo. Abra o link no Drive, em Compartilhar, e deixe como "qualquer pessoa com o link".'
          : 'O endereço cadastrado devolveu uma página, não um PDF. Confira o link da prova.'
      );
    }

    const tamanho = resposta.headers.get('content-length');
    if (tamanho) res.setHeader('Content-Length', tamanho);
    // Mesmo motivo do caminho de disco: cliente que desiste no meio não pode
    // virar erro de stream sem dono.
    await pipeline(Readable.fromWeb(resposta.body), res).catch(() => {});
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const row = await loadImport(req.valid.params.id);
    const [items, counts] = await Promise.all([
      db.many(
        `SELECT id, number, payload, status, question_id, error_message
           FROM exam_import_items WHERE import_id = $1
          ORDER BY number NULLS LAST, created_at`,
        [row.id]
      ),
      itemCounts(row.id),
    ]);
    res.json({ ...serialize(row, { counts }), items });
  })
);

// ---------------------------------------------------------------------------
// O texto do PDF sobe em pedaços
// ---------------------------------------------------------------------------
router.post(
  '/:id/text',
  validate({ params: idParams, body: textBody }),
  wrap(async (req, res) => {
    const row = await loadImport(req.valid.params.id);
    if (row.status === 'extraindo' || row.status === 'concluida') {
      throw new AppError(409, 'conflict', 'Esta leitura já foi processada. Crie outra para enviar um texto novo.');
    }

    const { chunk, done } = req.valid.body;
    const atualizado = await db.one(
      `UPDATE exam_imports
          SET document_text = coalesce(document_text, '') || $2,
              chars_total   = length(coalesce(document_text, '') || $2),
              status        = CASE WHEN $3 THEN 'pronta' ELSE 'lendo' END,
              error_message = NULL
        WHERE id = $1
        RETURNING *`,
      [row.id, chunk, Boolean(done)]
    );

    if (Number(atualizado.chars_total) > examImport.MAX_DOCUMENT_CHARS) {
      await db.query(`UPDATE exam_imports SET status = 'falhou', error_message = $2 WHERE id = $1`, [
        row.id,
        'O texto enviado é grande demais para uma prova.',
      ]);
      throw new AppError(413, 'too_large', 'O texto enviado é grande demais para uma prova.');
    }

    res.json(serialize(atualizado));
  })
);

// ---------------------------------------------------------------------------
// Varredura, um lote por requisição
// ---------------------------------------------------------------------------
router.post(
  '/:id/sweep',
  aiLimiter,
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const row = await loadImport(req.valid.params.id);
    if (!row.document_text) {
      throw new AppError(409, 'conflict', 'Envie o texto da prova antes de varrer.');
    }

    const batch = examImport.nextBatch(row.document_text, Number(row.chars_read) || 0);
    if (!batch) {
      const concluida = await db.one(
        `UPDATE exam_imports SET status = 'concluida' WHERE id = $1 RETURNING *`,
        [row.id]
      );
      return res.json({ ...serialize(concluida, { counts: await itemCounts(row.id) }), done: true, found: 0, items: [] });
    }

    // Marca que está trabalhando, guardando a hora: se o processo reiniciar no
    // meio (a hospedagem reinicia sozinha), a leitura não pode ficar presa
    // nesse estado para sempre — a próxima varredura retoma.
    await db.query(
      `UPDATE exam_imports SET status = 'extraindo', error_message = NULL, updated_at = now() WHERE id = $1`,
      [row.id]
    );

    let encontradas;
    try {
      encontradas = await examImport.extract({
        batch,
        exam: row.exam_id ? { id: row.exam_id, name: row.exam_name, board: row.exam_board } : null,
        year: row.year,
        board: row.board,
        answerKey: row.answer_key || null,
        userId: req.admin ? req.admin.id : null,
      });
    } catch (err) {
      // O cursor NÃO anda: o próximo "Continuar" tenta o mesmo trecho de novo.
      await db.query(`UPDATE exam_imports SET status = 'pronta', error_message = $2 WHERE id = $1`, [
        row.id,
        String(err && err.message ? err.message : err).slice(0, 500),
      ]);
      throw err;
    }

    // Questão repetida acontece de dois jeitos: entre lotes, quando um começa
    // onde o anterior terminou, e DENTRO do mesmo lote, quando o modelo
    // transcreve a mesma questão duas vezes. Uma varredura de prova real
    // trouxe as duas coisas.
    const jaVistos = new Set(
      (await db.many('SELECT number FROM exam_import_items WHERE import_id = $1 AND number IS NOT NULL', [row.id])).map(
        (item) => item.number
      )
    );
    const novas = [];
    for (const item of encontradas) {
      if (item.number !== null) {
        if (jaVistos.has(item.number)) continue;
        jaVistos.add(item.number);
      }
      novas.push(item);
    }

    for (const item of novas) {
      await db.query(
        `INSERT INTO exam_import_items (import_id, number, payload) VALUES ($1, $2, $3::jsonb)`,
        [row.id, item.number, JSON.stringify(item)]
      );
    }

    const fim = batch.end >= String(row.document_text).length;
    const atualizado = await db.one(
      `UPDATE exam_imports
          SET chars_read  = $2,
              found_count = found_count + $3,
              last_number = coalesce($4, last_number),
              status      = CASE WHEN $5 THEN 'concluida' ELSE 'pronta' END
        WHERE id = $1
        RETURNING *`,
      [row.id, batch.end, novas.length, batch.last_number, fim]
    );

    const items = await db.many(
      `SELECT id, number, payload, status, question_id, error_message
         FROM exam_import_items WHERE import_id = $1
        ORDER BY number NULLS LAST, created_at`,
      [row.id]
    );

    res.json({
      ...serialize(atualizado, { counts: await itemCounts(row.id) }),
      done: fim,
      found: novas.length,
      items,
    });
  })
);

// ---------------------------------------------------------------------------
// Conferência e gravação
// ---------------------------------------------------------------------------
router.patch(
  '/:id/items/:itemId',
  validate({ params: itemParams, body: itemBody }),
  wrap(async (req, res) => {
    const { id, itemId } = req.valid.params;
    const item = await db.one('SELECT * FROM exam_import_items WHERE id = $1 AND import_id = $2', [itemId, id]);
    if (!item) throw new AppError(404, 'not_found', 'Questão não encontrada nesta leitura.');
    if (item.status === 'importada') {
      throw new AppError(409, 'conflict', 'Esta questão já está no banco. Edite-a pelo banco de questões.');
    }

    const { status, ...campos } = req.valid.body;
    // Corrigir o gabarito à mão vale tanto quanto o gabarito oficial: quem
    // corrigiu foi uma pessoa olhando a prova.
    const payload = { ...item.payload, ...campos };
    if (campos.correct) payload.answer_from_key = true;
    // Trocar a matéria zera o assunto: assunto pertence a uma matéria, e o que
    // valia na anterior quase nunca vale na nova.
    if (campos.subject_slug && campos.subject_slug !== item.payload.subject_slug && !campos.topic_slug) {
      payload.topic_slug = '';
    }

    // Item que falhou e acabou de ser corrigido volta para a fila. Sem isto a
    // correção não servia para nada: a importação só leva o que está pendente,
    // e o item consertado ficava preso em "falhou" para sempre.
    const corrigiu = Object.keys(campos).length > 0;
    const proximoStatus = status || (item.status === 'falhou' && corrigiu ? 'pendente' : null);

    const atualizado = await db.one(
      `UPDATE exam_import_items
          SET payload = $2::jsonb, status = coalesce($3, status), error_message = NULL
        WHERE id = $1
        RETURNING id, number, payload, status, question_id, error_message`,
      [itemId, JSON.stringify(payload), proximoStatus]
    );
    res.json(atualizado);
  })
);

router.post(
  '/:id/import',
  validate({ params: idParams, body: importBody }),
  wrap(async (req, res) => {
    const row = await loadImport(req.valid.params.id);
    const items = await db.many(
      `SELECT id, number, payload FROM exam_import_items
        WHERE import_id = $1 AND id = ANY($2::uuid[]) AND status = 'pendente'
        ORDER BY number NULLS LAST`,
      [row.id, req.valid.body.item_ids]
    );
    if (!items.length) throw new AppError(400, 'validation_error', 'Nenhuma questão pendente entre as escolhidas.');

    const maps = await loadSlugMaps();
    const errors = [];
    const criadas = [];

    for (const item of items) {
      const payload = item.payload || {};
      const bruto = { ...payload };
      // A prova de origem entra como referência da questão.
      if (row.exam_id) bruto.exams = [row.exam_id];

      let dados;
      try {
        dados = buildImportRow(bruto, maps);
      } catch (err) {
        if (!(err instanceof RowError)) throw err;
        errors.push({ number: item.number, message: err.message });
        await db.query(`UPDATE exam_import_items SET status = 'falhou', error_message = $2 WHERE id = $1`, [
          item.id,
          err.message,
        ]);
        continue;
      }

      if (row.exam_id) {
        dados.exam_ids = [row.exam_id];
        dados.source_exam_id = row.exam_id;
      }

      try {
        // Cada questão em sua própria transação: uma falha não desfaz as anteriores.
        const questionId = await db.tx(async (client) =>
          insertQuestion(client, dados, req.admin ? req.admin.id : null)
        );
        await db.query(
          `UPDATE exam_import_items SET status = 'importada', question_id = $2, error_message = NULL WHERE id = $1`,
          [item.id, questionId]
        );
        criadas.push(questionId);
      } catch (err) {
        const mensagem = 'Não foi possível gravar esta questão. Revise os dados e tente de novo.';
        errors.push({ number: item.number, message: mensagem });
        await db.query(`UPDATE exam_import_items SET status = 'falhou', error_message = $2 WHERE id = $1`, [
          item.id,
          mensagem,
        ]);
        console.error(`[exam-imports] falha ao gravar a questão ${item.number}:`, err.message);
      }
    }

    const atualizado = await db.one(
      `UPDATE exam_imports SET imported_count = imported_count + $2 WHERE id = $1 RETURNING *`,
      [row.id, criadas.length]
    );
    await audit(req, 'exam_import.import', 'exam_import', row.id, {
      requested: items.length,
      imported: criadas.length,
      failed: errors.length,
    });

    res.json({
      imported: criadas.length,
      total: items.length,
      failed: errors.length,
      errors,
      ids: criadas,
      ...serialize(atualizado, { counts: await itemCounts(row.id) }),
    });
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const row = await loadImport(req.valid.params.id);
    await db.query('DELETE FROM exam_imports WHERE id = $1', [row.id]);
    await audit(req, 'exam_import.delete', 'exam_import', row.id, { title: row.title });
    res.json({ ok: true });
  })
);

module.exports = { basePath: '/api/admin/exam-imports', router };
