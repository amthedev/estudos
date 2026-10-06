'use strict';

/**
 * Item da leitura de prova vira questão no banco.
 *
 *   const bank = require('./exam-import-bank');
 *   await bank.importarItens(leitura, itens, adminId);              // os escolhidos no painel
 *   await bank.importarConfirmadasAutomaticamente(leitura, adminId); // os que não precisam de ninguém
 *
 * Compartilhado pelas rotas da leitura (routes/admin/exam-imports.js) e pela
 * leitura no servidor (services/exam-reading.js): os dois caminhos aplicam a
 * mesma validação, a mesma deduplicação e atualizam os mesmos contadores.
 *
 * A gravação reaproveita a importação por planilha (buildImportRow →
 * insertQuestion) — mesma validação de alternativa, mesma resolução de slug,
 * mesmas mensagens de erro.
 */
const db = require('../db/pool');
const { audit } = require('../middleware/audit');
const { buildImportRow, loadSlugMaps, insertQuestion, RowError } = require('../routes/admin/questions');

/** Chave da questão dentro da prova: número + variante de idioma. */
function chaveDaQuestao(number, variant) {
  return `${number}|${variant || ''}`;
}

/** A variante do item: a coluna nova, ou o payload de itens gravados antes dela. */
function varianteDoItem(item) {
  return item.variant || (item.payload && item.payload.variant) || null;
}

/**
 * Questões pendentes que podem ir ao banco sem ninguém olhar: a resposta veio
 * do gabarito oficial, a classificação existe e o leitor não levantou alerta
 * nenhum.
 *
 * Item com alerta (texto ilegível, alternativa faltando, figura incerta, sem
 * gabarito...) espera a conferência no painel, mesmo com gabarito: o que vai
 * ao aluno sem conferência tem de estar inteiro.
 */
async function itensConfirmadosPeloGabarito(importId) {
  return db.many(
    `SELECT id, number, variant, payload FROM exam_import_items
      WHERE import_id = $1 AND status = 'pendente'
        AND coalesce((payload->>'answer_from_key')::boolean, false)
        -- Sem matéria e assunto a gravação falha e o item cairia em "Não
        -- entraram", como se a questão tivesse se perdido. Ela fica esperando
        -- conferência, que é onde o administrador escolhe o assunto pelo nome.
        AND coalesce(payload->>'subject_slug', '') <> ''
        AND coalesce(payload->>'topic_slug', '') <> ''
        AND (payload->'alerts' IS NULL OR payload->'alerts' = '[]'::jsonb)
      ORDER BY number NULLS LAST`,
    [importId]
  );
}

/**
 * Questões que uma leitura ANTERIOR da mesma prova já mandou para o banco.
 *
 * Reler uma prova é normal: a primeira leitura falha no meio, ou sai com menos
 * questões do que a prova tem, e o administrador cria outra. Sem esta conferência
 * cada releitura gravava tudo de novo — a prova que já tinha rendido 36 questões
 * voltava com as mesmas 36 duplicadas no banco do aluno.
 *
 * A chave é o número da questão dentro da prova e a variante de idioma: a
 * questão 1 de espanhol NÃO é a questão 1 de inglês. Duas leituras são da
 * mesma prova quando apontam para o mesmo registro de "provas anteriores" ou,
 * na falta dele, quando têm a mesma prova, o mesmo ano e o mesmo título.
 *
 * @returns {Promise<Map<string, string>>} chave (número|variante) → id da questão já gravada
 */
async function numerosJaNoBanco(row) {
  const rows = await db.many(
    `SELECT it.number, coalesce(it.variant, it.payload->>'variant') AS variant, it.question_id
       FROM exam_import_items it
       JOIN exam_imports i ON i.id = it.import_id
      WHERE it.status = 'importada'
        AND it.number IS NOT NULL
        AND it.question_id IS NOT NULL
        AND i.id <> $1
        AND CASE
              WHEN $2::uuid IS NOT NULL THEN i.past_exam_id = $2
              ELSE i.past_exam_id IS NULL
                   AND i.exam_id IS NOT DISTINCT FROM $3::uuid
                   AND i.year IS NOT DISTINCT FROM $4::int
                   AND i.title = $5
            END
        -- Questão apagada de propósito no painel pode voltar numa releitura.
        AND EXISTS (SELECT 1 FROM questions q WHERE q.id = it.question_id)`,
    [row.id, row.past_exam_id || null, row.exam_id || null, row.year ?? null, row.title]
  );
  const mapa = new Map();
  for (const linha of rows) {
    const chave = chaveDaQuestao(linha.number, linha.variant);
    if (!mapa.has(chave)) mapa.set(chave, linha.question_id);
  }
  return mapa;
}

/**
 * Grava itens já selecionados no banco de questões.
 *
 * É compartilhado pela importação automática do gabarito e pelo botão de
 * revisão. Assim os dois caminhos aplicam exatamente a mesma validação e
 * atualizam os mesmos contadores.
 */
async function importarItens(row, items, adminId) {
  const maps = await loadSlugMaps();
  const errors = [];
  const criadas = [];
  const reaproveitadas = [];
  const jaNoBanco = await numerosJaNoBanco(row);

  for (const item of items) {
    // Já veio de outra leitura desta mesma prova: o item aponta para a questão
    // que existe, em vez de gravar uma cópia. Ele conta como "no banco" porque
    // é exatamente o que ele é.
    const existente = item.number !== null ? jaNoBanco.get(chaveDaQuestao(item.number, varianteDoItem(item))) : undefined;
    if (existente) {
      await db.query(
        `UPDATE exam_import_items SET status = 'importada', question_id = $2, error_message = NULL
          WHERE id = $1 AND status = 'pendente'`,
        [item.id, existente]
      );
      reaproveitadas.push(existente);
      continue;
    }

    try {
      const questionId = await db.tx(async (client) => {
        // A seleção aconteceu antes da transação. Trava e relê a linha para
        // impedir que dois cliques simultâneos gravem duas questões a partir
        // do mesmo item, e para respeitar uma correção feita nesse intervalo.
        const atual = await client.one(
          `SELECT payload, status FROM exam_import_items WHERE id = $1 FOR UPDATE`,
          [item.id]
        );
        if (!atual || atual.status !== 'pendente') return null;

        const bruto = { ...(atual.payload || {}) };
        if (row.exam_id) bruto.exams = [row.exam_id];
        const dados = buildImportRow(bruto, maps);

        if (row.exam_id) {
          dados.exam_ids = [row.exam_id];
          dados.source_exam_id = row.exam_id;
        }
        // A questão guarda de onde saiu. O item da leitura também guarda, mas
        // morre com ela; sem isto, remover as questões de uma prova para ler
        // de novo dependia de a leitura ainda existir.
        dados.exam_import_id = row.id;
        dados.past_exam_id = row.past_exam_id || null;

        const id = await insertQuestion(client, dados, adminId || null);
        await client.query(
          `UPDATE exam_import_items SET status = 'importada', question_id = $2, error_message = NULL WHERE id = $1`,
          [item.id, id]
        );
        return id;
      });
      if (questionId) criadas.push(questionId);
    } catch (err) {
      const mensagem =
        err instanceof RowError
          ? err.message
          : 'Não foi possível gravar esta questão. Revise os dados e tente de novo.';
      errors.push({ number: item.number, message: mensagem });
      // Se outro pedido conseguiu importar enquanto este falhava, não desfaça
      // o estado vencedor. A condição mantém a atualização idempotente.
      await db.query(
        `UPDATE exam_import_items SET status = 'falhou', error_message = $2
          WHERE id = $1 AND status = 'pendente'`,
        [item.id, mensagem]
      );
      if (!(err instanceof RowError)) {
        console.error(`[exam-imports] falha ao gravar a questão ${item.number}:`, err.message);
      }
    }
  }

  const atualizado = await db.one(
    `UPDATE exam_imports SET imported_count = imported_count + $2 WHERE id = $1 RETURNING *`,
    [row.id, criadas.length]
  );
  return { atualizado, criadas, errors, reaproveitadas };
}

/** Importa, sem outro clique, tudo que a banca já respondeu oficialmente e não tem alerta. */
async function importarConfirmadasAutomaticamente(row, adminId) {
  const confirmadas = await itensConfirmadosPeloGabarito(row.id);
  if (!confirmadas.length) return { imported: 0, failed: 0 };

  const resultado = await importarItens(row, confirmadas, adminId);
  await audit(
    adminId ? { admin: { id: adminId } } : null,
    'exam_import.auto_import',
    'exam_import',
    row.id,
    {
      requested: confirmadas.length,
      imported: resultado.criadas.length,
      reused: resultado.reaproveitadas.length,
      failed: resultado.errors.length,
    }
  );
  return {
    imported: resultado.criadas.length,
    reused: resultado.reaproveitadas.length,
    failed: resultado.errors.length,
  };
}

module.exports = {
  chaveDaQuestao,
  itensConfirmadosPeloGabarito,
  numerosJaNoBanco,
  importarItens,
  importarConfirmadasAutomaticamente,
};
