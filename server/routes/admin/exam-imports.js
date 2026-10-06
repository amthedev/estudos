'use strict';

/**
 * Painel administrativo — prova em PDF vira banco de questões.
 *
 *   GET    /api/admin/exam-imports              leituras recentes
 *   POST   /api/admin/exam-imports              { title, source_url, exam_id?, past_exam_id?, year?, board?,
 *                                                 answer_key? } → cria a leitura
 *   POST   /api/admin/exam-imports/:id/text     { chunk, done } → o texto do PDF sobe em pedaços
 *   POST   /api/admin/exam-imports/:id/sweep    varre UM lote e devolve o que encontrou + o progresso
 *   GET    /api/admin/exam-imports/leitor       { available, message } — a leitura no servidor funciona aqui?
 *   POST   /api/admin/exam-imports/:id/ler      { source_url? } → lê o PDF NO SERVIDOR, em segundo plano (202)
 *   GET    /api/admin/exam-imports/:id          leitura + itens encontrados
 *   PATCH  /api/admin/exam-imports/:id/items/:itemId  corrige matéria, assunto, gabarito, dificuldade,
 *                                              enunciado, alternativas (markdown com figuras) ou situação
 *   POST   /api/admin/exam-imports/:id/import   { item_ids } → manda as escolhidas para o banco
 *                                              { com_gabarito: true } → manda todas as que a
 *                                              banca já respondeu no gabarito oficial
 *   DELETE /api/admin/exam-imports/:id
 *   GET    /api/admin/exam-imports/provas                 provas anteriores com PDF, para escolher
 *   GET    /api/admin/exam-imports/provas/:id/arquivo/prova|gabarito
 *                                                        entrega o PDF pelo próprio domínio
 *   GET    /api/admin/exam-imports/provas/:id/questoes/impacto?include_orphans=true&import_ids=…
 *                                                        o que some se as questões da prova forem apagadas
 *   DELETE /api/admin/exam-imports/provas/:id/questoes  { confirm: true, include_orphans?, import_ids? } →
 *                                                        apaga as questões e as leituras; a prova volta a "não lida"
 *
 * Por que em lotes: uma prova do ENEM tem 90 questões e o texto passa de 200
 * mil caracteres. Isso não cabe em uma chamada de IA nem em uma requisição
 * HTTP. Cada varredura é uma requisição curta, e onde ela parou fica gravado —
 * fechar a aba custa "continuar de onde parou", não recomeçar.
 *
 * Dois caminhos de leitura:
 *   - no servidor (POST /:id/ler, services/exam-reading.js): o PDF é lido com
 *     posição, as figuras são recortadas e cada questão sai com alertas; é o
 *     caminho padrão do painel;
 *   - no navegador (POST /:id/text + /:id/sweep): o texto do PDF sobe em
 *     pedaços e é varrido em lotes. Fica como plano B para quando o leitor do
 *     servidor não carrega (GET /leitor diz).
 * Em nenhum dos dois o arquivo vai para a IA: em base64 ele seria contado como
 * consumo de tokens e derrubaria o teto mensal que o Tutor e a redação
 * compartilham. A IA só classifica.
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
const { nullableFileRef, fileRef } = require('../../utils/validators');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const uploads = require('../../services/uploads');
const examImport = require('../../services/exam-import');
const examCleanup = require('../../services/exam-cleanup');
const examReading = require('../../services/exam-reading');
const answerKeys = require('../../services/exam-reader/answer-key');
const { isGarbled } = require('../../services/exam-reader/decode');
const {
  itensConfirmadosPeloGabarito,
  importarItens,
  importarConfirmadasAutomaticamente,
} = require('../../services/exam-import-bank');

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const itemParams = z.object({ id: uuid, itemId: uuid });
const arquivoParams = z.object({ id: uuid, qual: z.enum(['prova', 'gabarito']) });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const optionalUuid = z.preprocess(emptyToUndefined, uuid.optional());

const LIST_LIMIT = 100;
/** O download com prazo e retentativa mora no leitor do servidor (o mesmo para os dois). */
const { baixarPdf } = examReading;
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
    reset: z.boolean().optional(),
    // Endereço do PDF que acabou de ser guardado. Sem isto o arquivo subia para
    // o Blob e não ficava registrado em lugar nenhum: sumia no F5, e do lado de
    // fora parecia que "o PDF não subiu".
    source_url: z.string().trim().url().max(500).optional(),
  })
  .strict();

const answerKeyBody = z
  .object({
    answer_key: z.string().trim().min(1, 'Informe o gabarito oficial.').max(20_000),
  })
  .strict();

/**
 * Endereços das imagens de um markdown (`![alt](url)`). A figura recortada leva
 * a largura de exibição no fragmento (`#w=320`), que não faz parte do arquivo.
 */
function imagensDoMarkdown(md) {
  return [...String(md || '').matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]);
}

/**
 * Figura dentro do enunciado ou da alternativa: arquivo enviado pelo painel
 * (/uploads/…) ou URL do Blob. z.string().url() recusaria justamente o
 * caminho interno que o armazenamento local devolve.
 */
const endereco = fileRef(2000);
function figurasValidas(md) {
  return imagensDoMarkdown(md).every((url) => endereco.safeParse(url.split('#')[0]).success);
}
const MSG_FIGURA = 'Uma figura do texto tem endereço inválido. Envie a imagem pelo botão de figura.';

/** Enunciado e alternativas em markdown, com as figuras no lugar. */
const statementField = z
  .string()
  .trim()
  .min(10, 'O enunciado ficou curto demais.')
  .max(30_000)
  .refine(figurasValidas, MSG_FIGURA);
const alternativeField = z.string().trim().max(6000).refine(figurasValidas, MSG_FIGURA);

const itemBody = z
  .object({
    subject_slug: z.string().trim().max(120).optional(),
    topic_slug: z.string().trim().max(120).optional(),
    subtopic_slug: z.preprocess(emptyToNull, z.string().trim().max(120).nullable().optional()),
    correct: z.string().trim().toUpperCase().regex(/^[A-E]$/, 'Use uma letra de A a E.').optional(),
    difficulty: z.coerce.number().int().min(1).max(3).optional(),
    statement: statementField.optional(),
    A: alternativeField.optional(),
    B: alternativeField.optional(),
    C: alternativeField.optional(),
    D: alternativeField.optional(),
    E: alternativeField.optional(),
    image_url: nullableFileRef(2000, 'Informe o endereço da imagem ou envie o arquivo.'),
    status: z.enum(['pendente', 'recusada']).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nada para alterar.');

const lerBody = z
  .object({
    // PDF que o painel acabou de enviar para o armazenamento. Sem ele, vale o
    // que a leitura já tem (source_url) ou o PDF da prova anterior.
    source_url: nullableFileRef(2000, 'Informe o endereço do PDF ou envie o arquivo.'),
  })
  .strict();

/**
 * O que mandar para o banco: uma escolha explícita, ou todas as conferidas
 * pelo gabarito oficial.
 *
 * `com_gabarito` existe porque ler a prova não é o mesmo que ter a questão no
 * banco, e quem lê 25 provas de uma vez não vai marcar 2.000 caixinhas. Quando
 * a resposta veio do gabarito publicado pela banca, não há o que conferir — a
 * alternativa correta não é palpite da inteligência artificial. As demais
 * continuam esperando alguém olhar.
 */
const importBody = z
  .object({
    item_ids: z.array(uuid).min(1, 'Escolha ao menos uma questão.').max(300).optional(),
    com_gabarito: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (body) => Boolean(body.item_ids) !== Boolean(body.com_gabarito),
    'Escolha as questões ou peça as que têm gabarito oficial — não os dois.'
  );

/** Leituras sem prova anterior que o administrador escolheu, uma por uma (ver services/exam-cleanup.js). */
const importIdsField = z.array(uuid).max(50, 'Escolha no máximo 50 leituras.');

const removeQuestionsBody = z
  .object({
    include_orphans: z.boolean().optional(),
    import_ids: importIdsField.optional(),
    confirm: z.literal(true, {
      errorMap: () => ({ message: 'Confirme que quer apagar as questões desta prova.' }),
    }),
  })
  .strict();

// Na query string uma leitura só chega como texto e várias, como lista.
const impactQuery = z.object({
  include_orphans: z.enum(['true', 'false']).optional(),
  import_ids: z.preprocess((value) => (value === undefined || value === '' ? undefined : [].concat(value)), importIdsField.optional()),
});

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
  // has_text pode vir pronto da lista (que não carrega o texto inteiro de
  // propósito) ou ser derivado do texto quando ele acompanha a linha.
  const temTexto = row.has_text !== undefined ? Boolean(row.has_text) : Boolean(document_text);
  // A leitura no servidor conta questões, não caracteres.
  const total = Number(row.progress_total) || 0;
  let percent = chars > 0 ? Math.min(100, Math.round((Number(row.chars_read) / chars) * 100)) : 0;
  if (row.engine === 'leitor') {
    percent = row.status === 'concluida' ? 100 : total > 0 ? Math.min(100, Math.round((Number(row.progress_done) / total) * 100)) : 0;
  }
  return {
    ...rest,
    answer_key_count: row.answer_key ? Object.keys(row.answer_key).length : 0,
    answer_key: undefined,
    percent,
    has_text: temTexto,
    running: row.engine === 'leitor' ? examReading.isRunning(row.id) : undefined,
    counts,
  };
}

async function itemCounts(importId) {
  const row = await db.one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'pendente')::int AS pendentes,
            count(*) FILTER (WHERE status = 'importada')::int AS importadas,
            count(*) FILTER (WHERE status = 'recusada')::int AS recusadas,
            count(*) FILTER (WHERE status = 'falhou')::int AS falharam,
            count(*) FILTER (WHERE status = 'pendente'
                             AND coalesce((payload->>'answer_from_key')::boolean, false))::int AS com_gabarito,
            count(*) FILTER (WHERE status = 'pendente'
                             AND payload->'alerts' IS NOT NULL AND payload->'alerts' <> '[]'::jsonb)::int AS com_alerta
       FROM exam_import_items WHERE import_id = $1`,
    [importId]
  );
  return row || { total: 0, pendentes: 0, importadas: 0, recusadas: 0, falharam: 0, com_gabarito: 0, com_alerta: 0 };
}

router.get(
  '/',
  wrap(async (req, res) => {
    const rows = await db.many(
      `SELECT i.id, i.title, i.source_url, i.exam_id, i.year, i.board, i.status,
              i.chars_total, i.chars_read, i.found_count, i.imported_count, i.last_number,
              i.engine, i.stage, i.progress_done, i.progress_total,
              i.error_message, i.created_at, i.updated_at,
              (i.document_text IS NOT NULL AND i.document_text <> '') AS has_text,
              c.pendentes AS pending_count,
              -- Contados dos itens, não dos acumuladores da leitura: se o
              -- processo cair entre gravar as questões e somar o contador, o
              -- acumulador fica para trás e a linha passa a mentir. E o que
              -- falhou não aparecia em número nenhum — a conta "8 lidas, 1 no
              -- banco" não fechava e ninguém sabia onde estavam as outras 7.
              c.lidas AS read_count,
              c.no_banco AS in_bank_count,
              c.nao_entraram AS rejected_count,
              e.short_name AS exam_short_name
         FROM exam_imports i
         LEFT JOIN exams e ON e.id = i.exam_id
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS lidas,
                  count(*) FILTER (WHERE it.status = 'pendente')::int AS pendentes,
                  count(*) FILTER (WHERE it.status = 'importada')::int AS no_banco,
                  count(*) FILTER (WHERE it.status IN ('falhou', 'recusada'))::int AS nao_entraram
             FROM exam_import_items it
            WHERE it.import_id = i.id
         ) c ON true
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
    const { key, count, sharedLanguages } = examImport.parseAnswerKey(body.answer_key);

    // (answer_key_shared: a folha colada não fala em espanhol — a leitura
    // decide, depois de ver a prova, se a letra vale para as duas línguas)
    const created = await db.one(
      `INSERT INTO exam_imports (title, source_url, exam_id, past_exam_id, year, board, answer_key, answer_key_shared, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       RETURNING *`,
      [
        body.title,
        body.source_url,
        body.exam_id || null,
        body.past_exam_id || null,
        body.year ?? null,
        body.board ?? null,
        count ? JSON.stringify(key) : null,
        Boolean(count && sharedLanguages),
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

/**
 * A leitura no servidor funciona aqui? O painel pergunta antes de escolher o
 * caminho: sem o leitor (pdf.js/canvas que não carregou na hospedagem), cai na
 * leitura pelo navegador, que continua existindo para isso.
 */
router.get(
  '/leitor',
  wrap(async (req, res) => {
    const { ok, message } = await examReading.available();
    res.json({ available: ok, message });
  })
);

router.get(
  '/provas',
  wrap(async (req, res) => {
    const rows = await db.many(
      `SELECT p.id, p.title, p.year, p.day, p.board, p.pdf_url, p.exam_id,
              (p.answer_key_url IS NOT NULL AND p.answer_key_url <> '') AS tem_gabarito,
              e.name AS exam_name, e.short_name AS exam_short_name, e.board AS exam_board,
              coalesce(historico.leituras, 0)::int AS leituras,
              coalesce(historico.concluidas, 0) > 0 AS leitura_concluida,
              ultima.id AS ultima_leitura_id,
              ultima.status AS ultima_leitura_status,
              ultima.found_count AS ultima_leitura_encontradas,
              ultima.imported_count AS ultima_leitura_importadas,
              (ultima.document_text IS NOT NULL AND ultima.document_text <> '') AS ultima_leitura_tem_texto,
              CASE
                WHEN ultima.engine = 'leitor' AND ultima.status = 'concluida' THEN 100
                WHEN ultima.engine = 'leitor' AND coalesce(ultima.progress_total, 0) > 0
                  THEN least(100, round((ultima.progress_done::numeric / ultima.progress_total) * 100)::int)
                WHEN coalesce(ultima.chars_total, 0) > 0
                  THEN least(100, round((ultima.chars_read::numeric / ultima.chars_total) * 100)::int)
                ELSE 0
              END AS ultima_leitura_percent,
              ultima.engine AS ultima_leitura_engine
         FROM past_exams p
         LEFT JOIN exams e ON e.id = p.exam_id
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS leituras,
                  count(*) FILTER (WHERE i.status = 'concluida'
                                     AND (i.engine = 'leitor'
                                          OR (i.chars_total > 0 AND i.chars_read >= i.chars_total)))::int AS concluidas
             FROM exam_imports i
            WHERE i.past_exam_id = p.id
         ) historico ON true
         LEFT JOIN LATERAL (
           SELECT i.id, i.status, i.document_text, i.chars_total, i.chars_read,
                  i.found_count, i.imported_count, i.engine, i.progress_done, i.progress_total
             FROM exam_imports i
            WHERE i.past_exam_id = p.id
            ORDER BY i.updated_at DESC, i.created_at DESC
            LIMIT 1
         ) ultima ON true
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
    // O cabeçalho de PDF vai só quando o arquivo está a caminho. Marcado antes,
    // ele saía junto com o JSON de erro — e o leitor de PDF do navegador
    // mostrava "resposta inesperada do servidor" no lugar da explicação.

    // Caminho interno: o arquivo está no disco da própria aplicação.
    if (url.startsWith('/uploads/')) {
      const alvo = path.join(uploads.UPLOADS_DIR, url.replace('/uploads/', ''));
      if (!alvo.startsWith(uploads.UPLOADS_DIR) || !fs.existsSync(alvo)) {
        throw new AppError(404, 'not_found', 'O arquivo desta prova não foi encontrado no servidor.');
      }
      res.setHeader('Content-Type', 'application/pdf');
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
    const resposta = await baixarPdf(destino);

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

    res.setHeader('Content-Type', 'application/pdf');
    const tamanho = resposta.headers.get('content-length');
    if (tamanho) res.setHeader('Content-Length', tamanho);
    // Mesmo motivo do caminho de disco: cliente que desiste no meio não pode
    // virar erro de stream sem dono.
    await pipeline(Readable.fromWeb(resposta.body), res).catch(() => {});
  })
);

// ---------------------------------------------------------------------------
// Remover as questões de uma prova, para ler de novo
// ---------------------------------------------------------------------------
/**
 * O que some se as questões desta prova forem apagadas: quantas questões,
 * quantos alunos responderam, tentativas, caderno de erros, simulados em
 * andamento. As questões sem vínculo e as das leituras sem prova anterior
 * vêm separadas, porque só entram com a caixa marcada; `selected` é a conta
 * da escolha pedida na query (ver services/exam-cleanup.js).
 */
router.get(
  '/provas/:id/questoes/impacto',
  validate({ params: idParams, query: impactQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query || {};
    res.json(
      await examCleanup.impact(req.valid.params.id, {
        includeOrphans: query.include_orphans === 'true',
        importIds: query.import_ids || [],
      })
    );
  })
);

/**
 * Apaga as questões da prova e as leituras dela. A prova volta a "não lida".
 *
 * `confirm: true` é obrigatório: um DELETE solto, sem corpo, não apaga o
 * histórico de ninguém por engano.
 */
router.delete(
  '/provas/:id/questoes',
  validate({ params: idParams, body: removeQuestionsBody }),
  wrap(async (req, res) => {
    const resultado = await examCleanup.removeQuestions(req.valid.params.id, {
      includeOrphans: Boolean(req.valid.body.include_orphans),
      importIds: req.valid.body.import_ids || [],
      req,
    });
    res.json(resultado);
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    let row = await loadImport(req.valid.params.id);
    // A tela acompanha a leitura no servidor por aqui. Se quem lia morreu sem
    // o boot passar (npm start sem o bootstrap), a linha diria "lendo" para
    // sempre: destrava e explica, e "Continuar" retoma de onde parou.
    if (await examReading.releaseIfStalled(row)) row = await loadImport(row.id);
    const [items, counts] = await Promise.all([
      db.many(
        `SELECT id, number, variant, payload, status, question_id, error_message
           FROM exam_import_items WHERE import_id = $1
          ORDER BY number NULLS LAST, CASE coalesce(variant, '') WHEN 'espanhol' THEN 1 ELSE 0 END, created_at`,
        [row.id]
      ),
      itemCounts(row.id),
    ]);
    res.json({ ...serialize(row, { counts }), items });
  })
);

/**
 * Acrescenta ou corrige o gabarito de uma leitura já iniciada.
 *
 * Isso é necessário na retomada: o PDF da prova pode ter subido antes de o PDF
 * do gabarito ficar disponível. As questões já encontradas são reconciliadas
 * pelo número e, quando a alternativa existe, passam a ser confirmadas pela
 * fonte oficial e entram no banco pelo mesmo caminho automático da varredura.
 */
router.put(
  '/:id/answer-key',
  validate({ params: idParams, body: answerKeyBody }),
  wrap(async (req, res) => {
    const row = await loadImport(req.valid.params.id);
    const lido = examImport.parseAnswerKey(req.valid.body.answer_key);
    if (!lido.count) throw new AppError(400, 'validation_error', 'Não foi possível identificar respostas nesse gabarito.');
    // Uma letra por número (a folha não fala em espanhol), numa prova lida no
    // servidor que não é do ENEM: a letra vale para a opção de espanhol também
    // (VUNESP). No ENEM, nunca — a folha do INEP sempre traz as duas colunas.
    let { key } = lido;
    const tipoDaProva = row.read_report && typeof row.read_report === 'object' ? row.read_report.kind : null;
    if (lido.sharedLanguages && tipoDaProva && tipoDaProva !== 'enem') {
      const espanhol = await db.many(
        `SELECT DISTINCT number FROM exam_import_items
          WHERE import_id = $1 AND number IS NOT NULL AND coalesce(variant, payload->>'variant') = 'espanhol'`,
        [row.id]
      );
      key = answerKeys.shareLanguages(key, espanhol.map((r) => r.number));
    }
    const count = Object.keys(key).length;

    const pendentes = await db.many(
      `SELECT id, number, variant, payload
         FROM exam_import_items
        WHERE import_id = $1 AND status = 'pendente' AND number IS NOT NULL`,
      [row.id]
    );
    let reconciliadas = 0;

    await db.tx(async (client) => {
      await client.query(
        `UPDATE exam_imports SET answer_key = $2::jsonb, answer_key_shared = $3, error_message = NULL WHERE id = $1`,
        [row.id, JSON.stringify(key), Boolean(lido.sharedLanguages)]
      );
      for (const item of pendentes) {
        // A questão de espanhol tem a própria letra ("1:espanhol"); nunca herda a de inglês.
        const letra = answerKeys.answerFor(key, item.number, item.variant || (item.payload && item.payload.variant));
        if (!letra || !item.payload) continue;
        // Da leitura no servidor, a letra oficial vale mesmo com a alternativa
        // vazia: o alerta de alternativa faltando segura a questão até alguém
        // completar, e aí ela já está com a resposta certa.
        if (!item.payload[letra] && item.payload.reader !== 'leitor') continue;
        const alerts = Array.isArray(item.payload.alerts) ? item.payload.alerts.filter((a) => a !== 'sem_gabarito') : undefined;
        const payload = { ...item.payload, correct: letra, answer_from_key: true, needs_answer: false, ...(alerts ? { alerts } : {}) };
        await client.query(`UPDATE exam_import_items SET payload = $2::jsonb, error_message = NULL WHERE id = $1`, [
          item.id,
          JSON.stringify(payload),
        ]);
        reconciliadas += 1;
      }
    });

    const atualizada = await loadImport(row.id);
    const resultado = await importarConfirmadasAutomaticamente(atualizada, req.admin ? req.admin.id : null);
    await audit(req, 'exam_import.answer_key', 'exam_import', row.id, {
      answers: count,
      reconciled: reconciliadas,
      imported: resultado.imported,
    });
    res.json({
      ...serialize(await loadImport(row.id), { counts: await itemCounts(row.id) }),
      reconciled: reconciliadas,
      imported_now: resultado.imported,
    });
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

    const { chunk, done, reset, source_url: sourceUrl } = req.valid.body;
    // O que impede reenviar o texto é a varredura já ter começado, não o rótulo
    // da situação: uma leitura marcada como "pronta" que ficou sem texto nenhum
    // era recusada com uma mensagem que dizia o contrário do que acontecia, e
    // não havia como consertá-la.
    if (reset && Number(row.chars_read) > 0) {
      throw new AppError(409, 'conflict', 'Esta leitura já começou. Continue a varredura em vez de reenviar o texto.');
    }
    const atualizado = await db.one(
      `UPDATE exam_imports
          SET document_text = CASE WHEN $4 THEN $2 ELSE coalesce(document_text, '') || $2 END,
              chars_total   = length(CASE WHEN $4 THEN $2 ELSE coalesce(document_text, '') || $2 END),
              chars_read    = CASE WHEN $4 THEN 0 ELSE chars_read END,
              status        = CASE WHEN $3 THEN 'pronta' ELSE 'lendo' END,
              source_url    = coalesce($5, source_url),
              engine        = 'texto',
              stage         = NULL,
              error_message = NULL
        WHERE id = $1
        RETURNING *`,
      [row.id, chunk, Boolean(done), Boolean(reset), sourceUrl || null]
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
/**
 * Varreduras em andamento, por leitura.
 *
 * A varredura de um trecho leva de 60 a 90 segundos — mais do que a borda da
 * hospedagem deixa uma requisição HTTP durar, e segurar a requisição aberta
 * fazia a plataforma derrubar o processo no meio, perdendo o trabalho que já
 * tinha sido pago à IA. Então a rota DISPARA o trabalho e responde na hora; a
 * tela acompanha pelo estado da leitura, que mora no banco.
 *
 * O mapa serve para dois cliques seguidos não varrerem o mesmo trecho duas
 * vezes. Ele vive na memória de propósito: se o processo reiniciar, o mapa some
 * junto com o trabalho, e o bootstrap destrava a leitura que ficou em
 * "extraindo".
 */
const emAndamento = new Map();

// A gravação no banco (itensConfirmadosPeloGabarito, importarItens,
// importarConfirmadasAutomaticamente) mora em services/exam-import-bank.js:
// a leitura no servidor usa exatamente a mesma.

/** Varre UM lote e grava o resultado. Roda solta, fora da requisição. */
async function varrerUmLote(row, adminId) {
  // Recupera também itens seguros deixados por uma tentativa anterior. A
  // próxima chamada de IA pode falhar; o que já veio do gabarito não depende
  // dela e não deve continuar preso.
  await importarConfirmadasAutomaticamente(row, adminId);

  const batch = examImport.nextBatch(row.document_text, Number(row.chars_read) || 0);
  if (!batch) {
    await db.query(`UPDATE exam_imports SET status = 'concluida' WHERE id = $1`, [row.id]);
    return;
  }

  let encontradas;
  try {
    encontradas = await examImport.extract({
      batch,
      exam: row.exam_id ? { id: row.exam_id, name: row.exam_name, board: row.exam_board } : null,
      year: row.year,
      board: row.board,
      answerKey: row.answer_key || null,
      userId: adminId,
    });
  } catch (err) {
    // O cursor NÃO anda: o próximo "Continuar" tenta o mesmo trecho de novo.
    await db.query(`UPDATE exam_imports SET status = 'pronta', error_message = $2 WHERE id = $1`, [
      row.id,
      String(err && err.message ? err.message : err).slice(0, 500),
    ]);
    return;
  }

  // Questão repetida acontece de dois jeitos: entre lotes, quando um começa
  // onde o anterior terminou, e DENTRO do mesmo lote, quando o modelo
  // transcreve a mesma questão duas vezes.
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
    await db.query(`INSERT INTO exam_import_items (import_id, number, payload) VALUES ($1, $2, $3::jsonb)`, [
      row.id,
      item.number,
      JSON.stringify(item),
    ]);
  }

  // Gabarito oficial não precisa de conferência humana. Antes isso só
  // acontecia no botão de leitura em massa; ao ler uma prova individualmente,
  // o painel dizia que terminou mas o banco do aluno continuava vazio.
  await importarConfirmadasAutomaticamente(row, adminId);

  const fim = batch.end >= String(row.document_text).length;
  await db.query(
    `UPDATE exam_imports
        SET chars_read = $2, found_count = found_count + $3, last_number = coalesce($4, last_number),
            status = CASE WHEN $5 THEN 'concluida' ELSE 'pronta' END
      WHERE id = $1`,
    [row.id, batch.end, novas.length, batch.last_number, fim]
  );
}

router.post(
  '/:id/sweep',
  aiLimiter,
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const row = await loadImport(req.valid.params.id);
    const adminId = req.admin ? req.admin.id : null;
    if (!row.document_text) {
      throw new AppError(409, 'conflict', 'Envie o texto da prova antes de varrer.');
    }

    // Faz primeiro o trabalho determinístico. Mesmo que não exista mais texto
    // para varrer, ou que a próxima chamada de IA falhe, o gabarito que já foi
    // extraído chega ao banco.
    await importarConfirmadasAutomaticamente(row, adminId);

    // "extraindo" órfão: a linha diz que está varrendo, mas ninguém está — este
    // processo não a conhece (emAndamento é da memória e some no restart) e o
    // último toque foi há mais de dois minutos. Sem isto, a única saída era
    // esperar o próximo reinício destravar. Um lote real atualiza updated_at bem
    // antes disso, então uma varredura de verdade em curso nunca é interrompida.
    if (row.status === 'extraindo' && !emAndamento.has(row.id)) {
      const parado = Date.now() - new Date(row.updated_at).getTime();
      if (parado > 2 * 60 * 1000) {
        await db.query(`UPDATE exam_imports SET status = 'pronta' WHERE id = $1`, [row.id]);
        row.status = 'pronta';
      }
    }

    if (row.chars_read >= String(row.document_text).length) {
      const concluida = await db.one(`UPDATE exam_imports SET status = 'concluida' WHERE id = $1 RETURNING *`, [row.id]);
      return res.json({ ...serialize(concluida, { counts: await itemCounts(row.id) }), done: true, running: false });
    }

    if (!emAndamento.has(row.id)) {
      // A marca entra no mapa SEM await pelo meio: com uma espera entre o
      // "já está rodando?" e o "marquei que está", dois cliques ao mesmo tempo
      // passavam os dois pela porta e o mesmo trecho era varrido — e pago —
      // duas vezes.
      const trabalho = (async () => {
        await db.query(
          `UPDATE exam_imports SET status = 'extraindo', error_message = NULL, updated_at = now() WHERE id = $1`,
          [row.id]
        );
        await varrerUmLote(row, adminId);
      })()
        .catch((err) => {
          console.error(`[exam-imports] varredura de ${row.id} falhou: ${err.message}`);
          return db
            .query(`UPDATE exam_imports SET status = 'pronta', error_message = $2 WHERE id = $1`, [
              row.id,
              String(err && err.message ? err.message : err).slice(0, 500),
            ])
            .catch(() => {});
        })
        .finally(() => emAndamento.delete(row.id));
      emAndamento.set(row.id, trabalho);
    }

    // Responde na hora: o trabalho segue solto e a tela acompanha pelo estado.
    const atual = await loadImport(row.id);
    res.status(202).json({
      ...serialize(atual, { counts: await itemCounts(row.id) }),
      done: false,
      running: true,
    });
  })
);

// ---------------------------------------------------------------------------
// Leitura no servidor
// ---------------------------------------------------------------------------
/**
 * Lê o PDF no servidor, em segundo plano (services/exam-reading.js).
 *
 * Responde na hora (202) e a tela acompanha pelo GET /:id: uma prova de 30
 * páginas é lida em segundos, mas a classificação pela IA e o envio das
 * figuras passam do que a borda da hospedagem deixa uma requisição durar.
 *
 * Chamar de novo numa leitura que parou no meio continua de onde parou: o PDF
 * é relido (sem IA) e as questões que já viraram item são puladas.
 */
router.post(
  '/:id/ler',
  aiLimiter,
  validate({ params: idParams, body: lerBody }),
  wrap(async (req, res) => {
    let row = await loadImport(req.valid.params.id);
    const adminId = req.admin ? req.admin.id : null;

    const leitor = await examReading.available();
    if (!leitor.ok) throw new AppError(503, 'leitor_indisponivel', leitor.message);

    if (await examReading.releaseIfStalled(row)) row = await loadImport(row.id);
    if (examReading.isRunning(row.id)) {
      // Clique duplo: a leitura já está andando neste processo.
      return res.status(202).json({ ...serialize(row, { counts: await itemCounts(row.id) }), done: false, running: true });
    }
    if (row.status === 'extraindo') {
      throw new AppError(409, 'conflict', 'Esta prova já está sendo lida. Espere terminar.');
    }
    if (row.engine === 'texto' && (Number(row.chars_read) > 0 || row.status === 'concluida')) {
      throw new AppError(
        409,
        'conflict',
        'Esta leitura começou pelo texto do navegador. Continue a varredura, ou crie outra leitura para ler no servidor.'
      );
    }
    if (row.engine === 'leitor' && row.status === 'concluida') {
      return res.json({ ...serialize(row, { counts: await itemCounts(row.id) }), done: true, running: false });
    }

    const novoArquivo = req.valid.body.source_url || null;
    if (novoArquivo) {
      await db.query('UPDATE exam_imports SET source_url = $2 WHERE id = $1', [row.id, novoArquivo]);
    } else if (!row.source_url) {
      const prova = row.past_exam_id
        ? await db.one('SELECT pdf_url FROM past_exams WHERE id = $1', [row.past_exam_id])
        : null;
      if (!prova || !prova.pdf_url) {
        throw new AppError(409, 'conflict', 'Envie o PDF da prova ou escolha uma prova cadastrada que tenha o arquivo.');
      }
    }

    const { started, marked } = examReading.start(row.id, { adminId });
    await marked;
    if (started) {
      await audit(req, 'exam_import.read', 'exam_import', row.id, {
        source: novoArquivo || row.source_url || 'prova anterior',
        resume: Number(row.progress_done) > 0,
      });
    }
    const atual = await loadImport(row.id);
    res.status(202).json({ ...serialize(atual, { counts: await itemCounts(row.id) }), done: false, running: true });
  })
);

// ---------------------------------------------------------------------------
// Conferência e gravação
// ---------------------------------------------------------------------------
const TEXTO_DA_QUESTAO = ['statement', 'A', 'B', 'C', 'D', 'E'];
/** Alertas que a pessoa resolve só de olhar e corrigir o texto. */
const ALERTAS_DE_CONFERENCIA = ['figura_incerta', 'texto_incerto', 'regiao_quebrada', 'enunciado_curto', 'numero_fora_de_sequencia'];

/**
 * O que continua valendo de alerta depois de uma correção no painel.
 *
 * Quem editou o enunciado ou uma alternativa olhou a questão: os alertas de
 * "confira isto" saem. Os que dá para medir são medidos de novo no texto
 * corrigido (alternativa vazia, texto ilegível), e 'sem_gabarito' só sai com
 * a letra escolhida. A conferência é o que manda a questão ao banco — o
 * alerta só decide o que pode ir sozinho.
 */
function alertasDepoisDaEdicao(antes, depois, campos) {
  let alerts = [...antes.alerts];
  const mexeuNoTexto = TEXTO_DA_QUESTAO.some((campo) => campos[campo] !== undefined);
  if (mexeuNoTexto) {
    alerts = alerts.filter((a) => !ALERTAS_DE_CONFERENCIA.includes(a));
    const completas = examImport.LETRAS.every((letra) => String(depois[letra] || '').trim());
    alerts = alerts.filter((a) => a !== 'alternativas_incompletas');
    if (!completas) alerts.push('alternativas_incompletas');
    const texto = TEXTO_DA_QUESTAO.map((campo) => String(depois[campo] || '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')).join(' ');
    alerts = alerts.filter((a) => a !== 'texto_ilegivel');
    if (isGarbled(texto)) alerts.push('texto_ilegivel');
  }
  if (campos.correct) alerts = alerts.filter((a) => a !== 'sem_gabarito');
  return alerts;
}

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
    if (campos.correct) {
      payload.answer_from_key = true;
      payload.needs_answer = false;
    }
    if (Array.isArray(item.payload.alerts)) payload.alerts = alertasDepoisDaEdicao(item.payload, payload, campos);
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
        RETURNING id, number, variant, payload, status, question_id, error_message`,
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
    const items = req.valid.body.com_gabarito
      ? await itensConfirmadosPeloGabarito(row.id)
      : await db.many(
          `SELECT id, number, payload FROM exam_import_items
            WHERE import_id = $1 AND id = ANY($2::uuid[]) AND status = 'pendente'
            ORDER BY number NULLS LAST`,
          [row.id, req.valid.body.item_ids]
        );
    if (!items.length) {
      throw new AppError(
        400,
        'validation_error',
        req.valid.body.com_gabarito
          ? 'Nenhuma questão desta prova teve a resposta confirmada pelo gabarito oficial.'
          : 'Nenhuma questão pendente entre as escolhidas.'
      );
    }

    const { atualizado, criadas, errors, reaproveitadas } = await importarItens(
      row,
      items,
      req.admin ? req.admin.id : null
    );
    await audit(req, 'exam_import.import', 'exam_import', row.id, {
      requested: items.length,
      imported: criadas.length,
      reused: reaproveitadas.length,
      failed: errors.length,
    });

    res.json({
      imported: criadas.length,
      reused: reaproveitadas.length,
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
