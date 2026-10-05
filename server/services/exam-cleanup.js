'use strict';

/**
 * Remover as questões de uma prova anterior, para lê-la de novo do zero.
 *
 *   const examCleanup = require('../services/exam-cleanup');
 *   const impacto = await examCleanup.impact(pastExamId, { includeOrphans, importIds });
 *   const feito = await examCleanup.removeQuestions(pastExamId, { includeOrphans, importIds, req });
 *
 * APAGAR, e não desativar, foi decisão do cliente — e é o único jeito de a
 * releitura funcionar: numerosJaNoBanco (routes/admin/exam-imports.js)
 * reaproveita a questão que já existe sem olhar se ela está ativa, então uma
 * prova "desativada" e lida de novo continuaria apontando para as questões
 * ruins. O preço é real e aparece na tela antes da confirmação: o DELETE leva
 * em cascata as respostas dos alunos, o caderno de erros e os avisos.
 *
 * Quais questões saem:
 *
 *   - as LIGADAS à prova: questions.past_exam_id, a leitura de origem
 *     (questions.exam_import_id) ou um item de qualquer leitura dessa prova.
 *     Uma questão marcada com OUTRA prova nunca entra, mesmo que um item
 *     aponte para ela;
 *   - as de LEITURAS SEM PROVA ANTERIOR do mesmo vestibular e ano, só as das
 *     leituras que o administrador escolher, uma por uma. A tela de leitura
 *     deixa ler pelo arquivo sem escolher a prova ("ENEM 2024 — segundo
 *     dia"), e a leitura perde a prova quando ela é excluída: as questões têm
 *     a mesma marca das desta prova, mas podem ser do outro dia;
 *   - as SEM VÍNCULO, só quando o administrador marca a caixa: questões de
 *     leituras já excluídas, quando o elo se perdeu. É heurística (mesmo
 *     vestibular, mesmo ano, mesma origem que a leitura grava, sem aula, sem
 *     IA, sem marca de outra prova, sem leitura nenhuma apontando para ela) e
 *     por isso aparece separada no impacto. Questão cadastrada à mão pelo
 *     formulário do painel, ou com a prova de origem escolhida nele, fica
 *     sempre de fora.
 *
 * Depois disso as leituras da prova (e as escolhidas) são apagadas: a prova
 * volta a aparecer como "não lida" e a próxima leitura começa do zero, sem
 * reaproveitar nada.
 */
const db = require('../db/pool');
const { AppError } = require('../middleware/errors');
const { audit } = require('../middleware/audit');
const coins = require('./coins');

/**
 * A partir de quando uma leitura em "extraindo" é considerada parada. É o
 * mesmo prazo da rota de varredura (routes/admin/exam-imports.js): um lote de
 * verdade toca a linha bem antes disso.
 */
const VARREDURA_PARADA_MS = 2 * 60 * 1000;

const ZERADO = Object.freeze({
  questions: 0,
  attempts: 0,
  students: 0,
  error_notebook: 0,
  in_progress_simulados: 0,
  in_progress_simulados_emptied: 0,
  simulado_models: 0,
  simulado_models_emptied: 0,
  reports: 0,
  favorites: 0,
});

/** A prova anterior com o nome do vestibular. `trava` serializa duas remoções da mesma prova. */
async function carregarProva(conn, pastExamId, { trava = false } = {}) {
  const prova = await conn.one(
    `SELECT pe.id, pe.title, pe.year, pe.day, pe.exam_id,
            e.name AS exam_name, e.short_name AS exam_short_name
       FROM past_exams pe
       JOIN exams e ON e.id = pe.exam_id
      WHERE pe.id = $1
      ${trava ? 'FOR NO KEY UPDATE OF pe' : ''}`,
    [pastExamId]
  );
  if (!prova) throw new AppError(404, 'not_found', 'Prova anterior não encontrada.');
  return prova;
}

/** A origem que a leitura grava na questão: "<vestibular> <ano>" (services/exam-import.js, normalizeExtracted). */
function origemDaLeitura(prova) {
  return `${prova.exam_name} ${prova.year}`;
}

function emVarredura(leitura, agora = Date.now()) {
  return leitura.status === 'extraindo' && agora - new Date(leitura.updated_at).getTime() <= VARREDURA_PARADA_MS;
}

/** Questões ligadas à prova pela coluna, pela leitura de origem ou por item de leitura. */
async function questoesLigadas(conn, pastExamId) {
  const rows = await conn.many(
    `WITH candidatas AS (
       SELECT q.id FROM questions q WHERE q.past_exam_id = $1
       UNION
       SELECT q.id FROM questions q JOIN exam_imports i ON i.id = q.exam_import_id
        WHERE i.past_exam_id = $1
       UNION
       SELECT it.question_id FROM exam_import_items it JOIN exam_imports i ON i.id = it.import_id
        WHERE i.past_exam_id = $1 AND it.question_id IS NOT NULL
     )
     SELECT q.id
       FROM questions q
       JOIN candidatas c ON c.id = q.id
      -- Marcada com outra prova é de outra prova, aponte o item para onde apontar.
      WHERE q.past_exam_id IS NULL OR q.past_exam_id = $1
      ORDER BY q.created_at, q.id`,
    [pastExamId]
  );
  return rows.map((row) => row.id);
}

/**
 * Questões que parecem desta prova mas perderam o elo: a leitura que as
 * gravou foi excluída (antes de existir a coluna de vínculo, ou era uma
 * leitura sem prova anterior).
 *
 * O filtro é estreito de propósito. Só entra o que tem exatamente a marca que
 * a leitura deixa (vestibular, ano e origem "<vestibular> <ano>"), não foi
 * feito pela IA nem para uma aula, não tem marca de outra prova e não tem
 * leitura NENHUMA apontando para ela — nem pela coluna (ON DELETE SET NULL:
 * preenchida, a leitura existe) nem por item. Questão de uma leitura viva não
 * é "sem vínculo" só porque a leitura não tem prova anterior: o 2º dia do
 * ENEM lido pelo arquivo tem a mesma marca do 1º dia, e entraria aqui inteiro.
 * Essas aparecem por leitura (leiturasSoltas) e o administrador escolhe.
 *
 * Fica de fora também o que passou pela mão de alguém no formulário. Criar
 * registra 'question.create' com o id da questão; editar registra
 * 'question.update' com os campos enviados. A questão de planilha nasce sem
 * prova de origem (buildImportRow não lê source_exam_id) e só ganha a marca
 * da leitura quando alguém escolhe "Prova de origem" no formulário — o que
 * fica na auditoria. A questão da leitura que alguém editou no formulário
 * também fica: na dúvida, não se apaga o que uma pessoa revisou.
 */
async function questoesSemVinculo(conn, prova, ligadas) {
  const rows = await conn.many(
    `SELECT q.id
       FROM questions q
      WHERE q.source_exam_id = $1
        AND q.year = $2
        AND lower(btrim(q.source)) = lower(btrim($3))
        AND NOT q.generated_by_ai
        AND q.lesson_id IS NULL
        AND q.past_exam_id IS NULL
        AND q.exam_import_id IS NULL
        AND NOT (q.id = ANY($4::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM exam_import_items it WHERE it.question_id = q.id)
        AND NOT EXISTS (
              SELECT 1 FROM audit_logs a
               WHERE a.entity_id = q.id
                 AND (a.action = 'question.create'
                      OR (a.action = 'question.update' AND a.data->'changes' ? 'source_exam_id')))
      ORDER BY q.created_at, q.id`,
    [prova.exam_id, prova.year, origemDaLeitura(prova), ligadas]
  );
  return rows.map((row) => row.id);
}

/**
 * Leituras do mesmo vestibular e ano sem prova anterior: lidas pelo arquivo
 * ("Não — vou escolher o arquivo") ou cuja prova anterior foi excluída
 * (exam_imports.past_exam_id é ON DELETE SET NULL). Só o administrador sabe
 * se são desta prova ou da irmã, então cada uma aparece com o título.
 *
 * `trava` é para a remoção: trava as escolhidas na ordem do id, como as da prova.
 */
async function leiturasSoltas(conn, prova, { ids = null, trava = false } = {}) {
  return conn.many(
    `SELECT i.id, i.title, i.status, i.created_at, i.updated_at
       FROM exam_imports i
      WHERE i.past_exam_id IS NULL AND i.exam_id = $1 AND i.year = $2
        ${ids ? 'AND i.id = ANY($3::uuid[])' : ''}
      ORDER BY ${trava ? 'i.id' : 'i.created_at, i.id'}
      ${trava ? 'FOR NO KEY UPDATE' : ''}`,
    ids ? [prova.exam_id, prova.year, ids] : [prova.exam_id, prova.year]
  );
}

/**
 * As questões no banco de cada leitura solta → Map(leitura → ids). Ficam de
 * fora as que já estão na conta (`excluir`) e as que são de outra prova:
 * marcadas com ela ou gravadas por uma leitura dela.
 */
async function questoesDasLeituras(conn, prova, leituraIds, excluir) {
  const porLeitura = new Map(leituraIds.map((id) => [id, []]));
  if (!leituraIds.length) return porLeitura;
  const rows = await conn.many(
    `WITH ligacoes AS (
       SELECT q.exam_import_id AS import_id, q.id AS question_id
         FROM questions q WHERE q.exam_import_id = ANY($1::uuid[])
       UNION
       SELECT it.import_id, it.question_id
         FROM exam_import_items it
        WHERE it.import_id = ANY($1::uuid[]) AND it.question_id IS NOT NULL
     )
     SELECT l.import_id, q.id
       FROM ligacoes l
       JOIN questions q ON q.id = l.question_id
      WHERE (q.past_exam_id IS NULL OR q.past_exam_id = $2)
        AND NOT (q.id = ANY($3::uuid[]))
        AND NOT EXISTS (
              SELECT 1 FROM exam_imports i
               WHERE i.id = q.exam_import_id AND i.past_exam_id IS NOT NULL AND i.past_exam_id <> $2)
        AND NOT EXISTS (
              SELECT 1 FROM exam_import_items it JOIN exam_imports i ON i.id = it.import_id
               WHERE it.question_id = q.id AND i.past_exam_id IS NOT NULL AND i.past_exam_id <> $2)
      ORDER BY q.created_at, q.id`,
    [leituraIds, prova.id, excluir]
  );
  for (const row of rows) porLeitura.get(row.import_id).push(row.id);
  return porLeitura;
}

const semRepetir = (ids) => [...new Set(ids)];

/** Outras provas do mesmo vestibular e ano: as sem vínculo podem ser delas (o ENEM tem dois dias). */
async function provasIrmas(conn, prova) {
  return conn.many(
    `SELECT id, title, day FROM past_exams
      WHERE exam_id = $1 AND year = $2 AND id <> $3
      ORDER BY day NULLS FIRST, sort_order, title`,
    [prova.exam_id, prova.year, prova.id]
  );
}

/** O que some junto com estas questões. Alunos contam uma vez, respondendo uma ou cem. */
async function contar(conn, ids) {
  if (!ids.length) return { ...ZERADO };
  const row = await conn.one(
    `SELECT
       (SELECT count(*) FROM question_attempts WHERE question_id = ANY($1::uuid[]))::int AS attempts,
       (SELECT count(*) FROM (
          SELECT user_id FROM question_attempts WHERE question_id = ANY($1::uuid[])
          UNION
          SELECT user_id FROM error_notebook WHERE question_id = ANY($1::uuid[])
        ) alunos)::int AS students,
       (SELECT count(*) FROM error_notebook WHERE question_id = ANY($1::uuid[]))::int AS error_notebook,
       (SELECT count(*) FROM simulado_attempts
         WHERE status = 'in_progress' AND question_ids && $1::uuid[])::int AS in_progress_simulados,
       (SELECT count(*) FROM simulado_attempts
         WHERE status = 'in_progress' AND question_ids && $1::uuid[] AND question_ids <@ $1::uuid[])::int
         AS in_progress_simulados_emptied,
       (SELECT count(*) FROM simulados WHERE question_ids && $1::uuid[])::int AS simulado_models,
       (SELECT count(*) FROM simulados
         WHERE question_ids && $1::uuid[] AND question_ids <@ $1::uuid[])::int AS simulado_models_emptied,
       (SELECT count(*) FROM question_reports WHERE question_id = ANY($1::uuid[]))::int AS reports,
       (SELECT count(*) FROM favorites
         WHERE item_type = 'question' AND item_id = ANY($1::uuid[]))::int AS favorites`,
    [ids]
  );
  return { questions: ids.length, ...row };
}

/**
 * O que a remoção vai levar, para a tela mostrar ANTES de alguém confirmar.
 *
 * `with_orphans` é a conta com a caixa marcada. `selected` é a conta da
 * escolha pedida (`includeOrphans`, `importIds`): as leituras soltas são
 * escolhidas uma a uma, e as combinações não cabem numa resposta só — a tela
 * pede de novo a cada caixa. Nas duas, os alunos são contados sem repetir
 * quem respondeu questões de mais de um grupo.
 *
 * @param {string} pastExamId
 * @param {{ includeOrphans?: boolean, importIds?: string[] }} [options]
 */
async function impact(pastExamId, { includeOrphans = false, importIds = [] } = {}) {
  const prova = await carregarProva(db, pastExamId);
  const ligadas = await questoesLigadas(db, prova.id);
  const semVinculo = await questoesSemVinculo(db, prova, ligadas);
  const soltas = await leiturasSoltas(db, prova);
  const porLeitura = await questoesDasLeituras(
    db,
    prova,
    soltas.map((leitura) => leitura.id),
    ligadas
  );
  // Leitura solta sem questão no banco não tem o que apagar aqui.
  const comQuestoes = soltas.filter((leitura) => porLeitura.get(leitura.id).length);
  const pedidas = new Set(importIds || []);
  const escolhidas = comQuestoes.filter((leitura) => pedidas.has(leitura.id));
  const selecionadas = semRepetir([
    ...ligadas,
    ...(includeOrphans ? semVinculo : []),
    ...escolhidas.flatMap((leitura) => porLeitura.get(leitura.id)),
  ]);
  const escolheuAlgo = selecionadas.length !== ligadas.length;

  const [contagem, contagemSemVinculo, contagemTudo, leituras, irmas, contagemEscolha, contagensSoltas] =
    await Promise.all([
      contar(db, ligadas),
      contar(db, semVinculo),
      semVinculo.length ? contar(db, [...ligadas, ...semVinculo]) : null,
      db.many('SELECT id, status, updated_at FROM exam_imports WHERE past_exam_id = $1', [prova.id]),
      semVinculo.length || comQuestoes.length ? provasIrmas(db, prova) : [],
      escolheuAlgo ? contar(db, selecionadas) : null,
      Promise.all(comQuestoes.map((leitura) => contar(db, porLeitura.get(leitura.id)))),
    ]);

  return {
    past_exam: {
      id: prova.id,
      title: prova.title,
      year: prova.year,
      day: prova.day,
      exam_id: prova.exam_id,
      exam_name: prova.exam_name,
      exam_short_name: prova.exam_short_name,
    },
    ...contagem,
    imports: leituras.length,
    reading_now: leituras.some((leitura) => emVarredura(leitura)),
    orphans_heuristic: {
      ...contagemSemVinculo,
      source: origemDaLeitura(prova),
      siblings: semVinculo.length ? irmas : [],
    },
    with_orphans: contagemTudo || contagem,
    unlinked_imports: comQuestoes.map((leitura, index) => ({
      id: leitura.id,
      title: leitura.title,
      created_at: leitura.created_at,
      reading_now: emVarredura(leitura),
      ...contagensSoltas[index],
    })),
    unlinked_siblings: comQuestoes.length ? irmas : [],
    selected: {
      ...(contagemEscolha || contagem),
      include_orphans: Boolean(includeOrphans),
      import_ids: escolhidas.map((leitura) => leitura.id),
      imports: leituras.length + escolhidas.length,
    },
  };
}

/**
 * Apaga as questões da prova e as leituras dela, numa transação só.
 *
 * Ordem das travas: prova, leituras e itens das leituras, e só então a lista
 * de questões. Uma gravação da leitura em curso trava o item antes de inserir
 * a questão; esperar por ela aqui (em vez de travar a leitura com FOR UPDATE,
 * que bloquearia a checagem de chave dela) evita o impasse e garante que a
 * questão que ela acabou de gravar entra na conta.
 *
 * As leituras soltas escolhidas (`importIds`) entram inteiras: as questões
 * delas saem e elas são apagadas junto com as da prova.
 *
 * @param {string} pastExamId
 * @param {{ includeOrphans?: boolean, importIds?: string[], req?: object|null }} [options]
 *   req vai para a auditoria
 */
async function removeQuestions(pastExamId, { includeOrphans = false, importIds = [], req = null } = {}) {
  const feito = await db.tx(async (client) => {
    const prova = await carregarProva(client, pastExamId, { trava: true });
    const leituras = await client.many(
      `SELECT id, title, status, updated_at FROM exam_imports
        WHERE past_exam_id = $1 ORDER BY id FOR NO KEY UPDATE`,
      [prova.id]
    );
    if (leituras.some((leitura) => emVarredura(leitura))) {
      throw new AppError(
        409,
        'conflict',
        'Uma leitura desta prova está varrendo agora. Espere a varredura parar e tente de novo.'
      );
    }
    const pedidas = semRepetir(importIds || []);
    const escolhidas = pedidas.length ? await leiturasSoltas(client, prova, { ids: pedidas, trava: true }) : [];
    if (escolhidas.length !== pedidas.length) {
      // Excluída ou ligada a uma prova depois de a janela abrir: a conta que o
      // administrador viu não vale mais.
      throw new AppError(
        409,
        'conflict',
        'Uma das leituras escolhidas foi excluída ou ligada a uma prova. Abra a janela de novo para ver a conta atualizada.'
      );
    }
    const varrendo = escolhidas.find((leitura) => emVarredura(leitura));
    if (varrendo) {
      throw new AppError(
        409,
        'conflict',
        `A leitura "${varrendo.title}" está varrendo agora. Espere a varredura parar e tente de novo.`
      );
    }
    const idsLeituras = [...leituras, ...escolhidas].map((leitura) => leitura.id);
    if (idsLeituras.length) {
      await client.query(
        'SELECT id FROM exam_import_items WHERE import_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [idsLeituras]
      );
    }

    const ligadas = await questoesLigadas(client, prova.id);
    const semVinculo = includeOrphans ? await questoesSemVinculo(client, prova, ligadas) : [];
    const porLeitura = await questoesDasLeituras(
      client,
      prova,
      escolhidas.map((leitura) => leitura.id),
      [...ligadas, ...semVinculo]
    );
    const dasLeituras = semRepetir([...porLeitura.values()].flat());
    const ids = [...ligadas, ...semVinculo, ...dasLeituras];
    const contagem = await contar(client, ids);

    let modelosOcultados = 0;
    let tentativasEncerradas = 0;
    if (ids.length) {
      // Modelo de simulado com questões fixas perde as apagadas, na mesma
      // ordem. O que ficar vazio sai do ar: lista vazia quer dizer "sorteado
      // pelos filtros" (services/simulados.js), e o modelo que o administrador
      // montou questão por questão viraria outro simulado sem ninguém pedir.
      const modelos = await client.many(
        `UPDATE simulados
            SET question_ids = ARRAY(
                  SELECT x FROM unnest(question_ids) WITH ORDINALITY AS t(x, n)
                   WHERE NOT (x = ANY($1::uuid[])) ORDER BY n),
                active = CASE WHEN question_ids <@ $1::uuid[] THEN false ELSE active END
          WHERE question_ids && $1::uuid[]
          RETURNING id, cardinality(question_ids) AS restantes`,
        [ids]
      );
      modelosOcultados = modelos.filter((modelo) => Number(modelo.restantes) === 0).length;

      // Simulado em andamento perde as questões apagadas e as respostas dadas
      // nelas; a nota sai sobre o que sobrou. Os finalizados ficam como estão:
      // a nota já foi dada e o aluno a viu. Tentativa que ficaria sem questão
      // nenhuma é encerrada e a moeda volta — o aluno pagou por um simulado
      // que deixou de existir.
      const tentativas = await client.many(
        `UPDATE simulado_attempts
            SET question_ids = ARRAY(
                  SELECT x FROM unnest(question_ids) WITH ORDINALITY AS t(x, n)
                   WHERE NOT (x = ANY($1::uuid[])) ORDER BY n),
                answers = answers - $2::text[],
                status = CASE WHEN question_ids <@ $1::uuid[] THEN 'abandoned' ELSE status END,
                finished_at = CASE WHEN question_ids <@ $1::uuid[] THEN now() ELSE finished_at END
          WHERE status = 'in_progress' AND question_ids && $1::uuid[]
          RETURNING id, user_id, status`,
        [ids, ids]
      );
      for (const tentativa of tentativas.filter((linha) => linha.status === 'abandoned')) {
        tentativasEncerradas += 1;
        await coins.refundByRef(
          tentativa.user_id,
          'simulado',
          'simulado_attempt',
          tentativa.id,
          'questões removidas pelo administrador',
          client
        );
      }

      // Outra leitura que tinha reaproveitado alguma destas (uma leitura solta
      // que não foi escolhida e repete o título de uma escolhida, por
      // exemplo): o item deixa de dizer "no banco" para uma questão que não
      // existe mais, e não volta para a fila — voltar faria a próxima
      // varredura gravar a mesma questão ruim de novo. As sem vínculo nunca
      // chegam aqui: questão com item não é sem vínculo.
      await client.query(
        `UPDATE exam_import_items
            SET status = 'recusada', error_message = $2
          WHERE question_id = ANY($1::uuid[]) AND NOT (import_id = ANY($3::uuid[]))`,
        [ids, `A questão foi apagada junto com as questões da prova "${prova.title}".`, idsLeituras]
      );

      // Favorito não tem chave estrangeira (aponta para aula, questão, nota…)
      // e ficaria órfão para sempre.
      await client.query(`DELETE FROM favorites WHERE item_type = 'question' AND item_id = ANY($1::uuid[])`, [ids]);

      // A cascata leva alternativas, respostas, caderno de erros e avisos.
      await client.query('DELETE FROM questions WHERE id = ANY($1::uuid[])', [ids]);
    }

    // Sem leitura, a prova volta a "não lida" e a próxima começa do zero:
    // numerosJaNoBanco não acha nada para reaproveitar.
    if (idsLeituras.length) {
      await client.query('DELETE FROM exam_imports WHERE id = ANY($1::uuid[])', [idsLeituras]);
    }

    return {
      prova,
      ids,
      ligadas,
      semVinculo,
      dasLeituras,
      contagem,
      leituras: leituras.map((leitura) => ({ id: leitura.id, title: leitura.title })),
      escolhidas: escolhidas.map((leitura) => ({ id: leitura.id, title: leitura.title })),
      modelosOcultados,
      tentativasEncerradas,
    };
  });

  const removed = {
    ...feito.contagem,
    simulado_models_emptied: feito.modelosOcultados,
    in_progress_simulados_emptied: feito.tentativasEncerradas,
  };
  await audit(req, 'past_exam.questions_remove', 'past_exam', feito.prova.id, {
    title: feito.prova.title,
    include_orphans: Boolean(includeOrphans),
    question_ids: feito.ligadas,
    orphan_ids: feito.semVinculo,
    unlinked_import_question_ids: feito.dasLeituras,
    imports: feito.leituras,
    unlinked_imports: feito.escolhidas,
    counts: removed,
  });

  return {
    past_exam: { id: feito.prova.id, title: feito.prova.title, year: feito.prova.year },
    include_orphans: Boolean(includeOrphans),
    removed,
    orphans_removed: feito.semVinculo.length,
    unlinked_questions_removed: feito.dasLeituras.length,
    imports_removed: feito.leituras.length + feito.escolhidas.length,
    unlinked_imports_removed: feito.escolhidas.length,
  };
}

module.exports = { impact, removeQuestions, VARREDURA_PARADA_MS };
