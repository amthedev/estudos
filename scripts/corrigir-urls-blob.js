'use strict';

/**
 * Conserta URLs de arquivo do Blob que foram salvas com o domínio ERRADO.
 *
 *   node scripts/corrigir-urls-blob.js            lista o que seria trocado
 *   node scripts/corrigir-urls-blob.js --aplicar  troca de verdade
 *
 * O caso real: a foto do professor era enviada ao Blob da Square Cloud e
 * gravada no banco com o endereço da API (blob.squarecloud.app). Esse endereço
 * exige a chave da conta e devolve 403 para o navegador do aluno — a foto
 * aparecia no cadastro e sumia para o aluno. O endereço público é outro:
 * public-blob.squarecloud.dev/<id>. O código novo já grava certo; este script
 * conserta o que ficou gravado errado.
 *
 * Varre TODA coluna de texto do banco à procura de um endereço do Blob e
 * reescreve só o domínio, preservando a chave do objeto (<conta>/<pasta>/<arquivo>).
 * É seguro rodar mais de uma vez: uma URL já pública não casa com o padrão e
 * fica como está. Sem --aplicar, nada é escrito.
 */
const db = require('../server/db/pool');
const { PUBLIC_BASE } = require('../server/services/storage/squarecloud');

const aplicar = process.argv.slice(2).includes('--aplicar');
const log = (msg) => console.log(`[corrigir-urls-blob] ${msg}`);

// A chave do objeto é <conta hex de 40>/<pasta>/<arquivo>. O domínio antes dela
// é o que estava errado; capturamos a chave para remontar com o domínio público.
const BLOB_HOST = /https?:\/\/[^/\s"']*blob[^/\s"']*squarecloud[^/\s"']*\/(?:v1\/objects\/)?([0-9a-f]{40}\/[^\s"']+)/gi;

/** Reescreve todo endereço de Blob de um texto para o domínio público. */
function corrigir(valor) {
  const texto = String(valor);
  return texto.replace(BLOB_HOST, (trecho, key) => {
    // Já está no domínio público: não mexe.
    if (trecho.startsWith(PUBLIC_BASE)) return trecho;
    return `${PUBLIC_BASE}/${key}`;
  });
}

/** Toda coluna de texto das tabelas do schema público. */
async function colunasDeTexto() {
  return db.many(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('text', 'character varying', 'character')
      ORDER BY table_name, column_name`
  );
}

async function main() {
  log(aplicar ? 'MODO APLICAR: as URLs erradas serão trocadas.' : 'MODO LISTAGEM: nada será escrito (use --aplicar para valer).');
  log(`Domínio público de destino: ${PUBLIC_BASE}`);

  const colunas = await colunasDeTexto();
  let totalTrocas = 0;

  for (const { table_name: tabela, column_name: coluna } of colunas) {
    // Só linhas que contêm um endereço de Blob; a varredura ignora o resto.
    let linhas;
    try {
      linhas = await db.many(
        `SELECT ctid, "${coluna}" AS valor
           FROM "${tabela}"
          WHERE "${coluna}" ~* 'blob[^/]*squarecloud'`
      );
    } catch (err) {
      // Tabela/coluna sem permissão ou tipo inesperado: pula sem derrubar tudo.
      continue;
    }
    if (!linhas.length) continue;

    for (const linha of linhas) {
      const antes = linha.valor;
      const depois = corrigir(antes);
      if (depois === antes) continue;

      totalTrocas += 1;
      log(`${tabela}.${coluna}:`);
      log(`   antes:  ${antes}`);
      log(`   depois: ${depois}`);

      if (aplicar) {
        await db.query(`UPDATE "${tabela}" SET "${coluna}" = $1 WHERE ctid = $2`, [depois, linha.ctid]);
      }
    }
  }

  log('—'.repeat(40));
  if (!totalTrocas) {
    log('Nenhuma URL para corrigir. Tudo já aponta para o domínio público.');
  } else if (aplicar) {
    log(`Pronto: ${totalTrocas} URL(s) corrigida(s).`);
  } else {
    log(`${totalTrocas} URL(s) seriam corrigidas. Rode com --aplicar para efetivar.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[corrigir-urls-blob] falhou: ${err.message}`);
    process.exit(1);
  });
