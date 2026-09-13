'use strict';

/**
 * Preparação da aplicação antes de subir, em hospedagem sem terminal.
 *
 *   node scripts/bootstrap.js
 *
 * É o que o comando de início executa na Square Cloud. Faz, nesta ordem:
 *
 *   1. aplica as migrations pendentes;
 *   2. garante o conteúdo base (provas, matérias, assuntos, critérios de
 *      redação, planos de estudo, textos da página inicial).
 *
 * Tudo é idempotente: publicar uma versão nova roda isto de novo sem
 * duplicar nada e sem desfazer o que a equipe editou pelo painel.
 *
 * O administrador NÃO é criado aqui. A primeira pessoa a abrir /admin/login
 * sem nenhum administrador cadastrado vê uma tela de configuração inicial
 * e cria a própria conta ali (POST /api/admin/auth/setup) — sem variável de
 * ambiente, sem terminal. As credenciais ficam só no banco.
 *
 * Quem preferir criar por linha de comando (ex.: para repor acesso depois)
 * continua podendo: node scripts/create-admin.js.
 */
const db = require('../server/db/pool');
const { runMigrations } = require('../server/db/migrate');
const { runSeed } = require('../server/db/seed/run');

function log(mensagem) {
  console.log(`[bootstrap] ${mensagem}`);
}

async function main() {
  log('aplicando migrations…');
  await runMigrations({ quiet: true });

  log('garantindo o conteúdo base…');
  await runSeed({ quiet: true });

  // Leitura de prova interrompida por um reinício fica marcada como "extraindo"
  // para sempre, e a tela não explica nada. Quem sobe agora sabe que ninguém
  // está varrendo: devolve para "pronta" e diz o que houve, para o
  // administrador poder continuar de onde parou.
  const retomadas = await db.many(
    `UPDATE exam_imports
        SET status = 'pronta',
            error_message = 'A leitura foi interrompida quando a aplicação reiniciou. Continue de onde parou.'
      WHERE status = 'extraindo'
      RETURNING id`
  );
  if (retomadas.length) log(`${retomadas.length} leitura(s) de prova destravada(s) após reinício.`);

  // Redação enviada fica "submitted" enquanto a IA corrige. Se o processo
  // reiniciar nessa janela, a correção síncrona não termina e a redação fica
  // presa para sempre — o aluno vê "em correção" eterno, sem poder reenviar.
  // Mesmo caso da leitura de prova acima, e a mesma cura: quem sobe agora sabe
  // que ninguém está corrigindo. Volta para "failed" com aviso, e a tela do
  // aluno já oferece "Enviar novamente" nesse estado.
  const redacoes = await db.many(
    `UPDATE essays
        SET status = 'failed',
            error_message = 'A correção foi interrompida quando a aplicação reiniciou. Envie novamente.'
      WHERE status = 'submitted'
      RETURNING id`
  );
  if (redacoes.length) log(`${redacoes.length} redação(ões) destravada(s) após reinício.`);

  log('pronto.');
}

main()
  .then(() => db.closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`[bootstrap] falhou: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    await db.closePool().catch(() => {});
    process.exit(1);
  });
