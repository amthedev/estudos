'use strict';

/**
 * Ponto de entrada: lê a configuração, cria o app e escuta a porta.
 * Encerramento gracioso em SIGINT/SIGTERM (fecha o servidor e o pool do banco).
 */
const config = require('./config');
const { createApp } = require('./app');
const db = require('./db/pool');
const { persistProcessError } = require('./middleware/errors');

function maskDatabaseUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(URL inválida)';
  }
}

async function main() {
  try {
    await db.query('SELECT 1');
    console.log(`[db] conectado em ${maskDatabaseUrl(config.databaseUrl)}`);
  } catch (err) {
    console.error(`[db] não foi possível conectar (${err.message}). O servidor sobe, mas a API responderá com erro.`);
  }

  const app = createApp();
  // O host é explícito de propósito: a Square Cloud só roteia o tráfego da
  // borda para quem escuta em 0.0.0.0, e uma aplicação ligada a localhost sobe
  // com o log limpo e o endereço dando timeout, sem nada para investigar.
  const server = app.listen(config.port, config.host, () => {
    // Em produção o endereço público não é localhost: quem lê o log da
    // hospedagem precisa ver onde o processo escutou e o endereço pelo qual o
    // site responde, que são coisas diferentes.
    const onde = config.isProd
      ? `${config.host}:${config.port} — ${config.appUrl}`
      : `http://localhost:${config.port}`;
    console.log(`${config.brandName} v${config.version} — ${config.env} — ${onde}`);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  /** Erros que pertencem a UMA conexão, não ao processo inteiro. */
  const ERRO_DE_CONEXAO = new Set([
    'EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED',
    'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_PREMATURE_CLOSE',
  ]);

  let shuttingDown = false;
  /**
   * Encerramento.
   *
   * Três coisas que o desenho anterior errava, e que custaram uma investigação
   * inteira atrás de um defeito que não existia:
   *
   *  - `server.close()` espera as requisições EM CURSO terminarem. Basta uma
   *    conversa do Tutor aberta para o retorno nunca chegar e o prazo estourar.
   *  - o prazo saía com código 1 SEMPRE. Para a hospedagem, código 1 é "a
   *    aplicação caiu": uma parada PEDIDA (publicação, por exemplo) voltava
   *    como queda. Agora parada pedida sai 0 e só queda sai 1 — e é essa
   *    diferença que torna o próximo reinício diagnosticável.
   *  - o caminho de sinal não gravava em lugar nenhum. Um SIGTERM no meio de
   *    uma leitura de prova de 90 segundos sumia sem deixar uma linha, e o
   *    painel da hospedagem guarda só as últimas mil.
   */
  const shutdown = async (signal, err = null) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const queda = Boolean(err);
    console.log(`\n[servidor] ${signal} recebido, encerrando...`);

    const forceExit = setTimeout(() => {
      console.error('[servidor] encerramento forçado.');
      process.exit(queda ? 1 : 0);
    }, 8_000);
    forceExit.unref();

    // Grava ANTES de fechar: é a única linha que explica um reinício depois.
    await persistProcessError(
      err || new Error(`encerramento por ${signal}`),
      signal,
      queda ? 'fatal' : 'warn'
    ).catch(() => {});

    server.close(async () => {
      await db.closePool().catch(() => {});
      clearTimeout(forceExit);
      process.exit(queda ? 1 : 0);
    });
    // Sem isto, uma resposta aberta (o SSE do Tutor, um PDF em trânsito) segura
    // o close() até o prazo estourar — e aí a saída era sempre "caiu".
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }, 2_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[processo] rejeição não tratada:', reason);
    persistProcessError(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('[processo] exceção não capturada:', err);
    // Socket que morreu no meio de uma resposta é problema DAQUELA requisição.
    // Derrubar o processo por causa dele transformava "um aluno fechou a aba"
    // em "a leitura de prova de 90 segundos sumiu". Qualquer OUTRA exceção
    // continua fatal de propósito: estado desconhecido não se leva adiante.
    if (err && ERRO_DE_CONEXAO.has(err.code)) {
      persistProcessError(err, 'uncaughtException-conexao', 'error');
      return;
    }
    persistProcessError(err, 'uncaughtException').finally(() => shutdown('uncaughtException', err));
  });
}

main().catch((err) => {
  console.error('[servidor] falha ao iniciar:', err);
  process.exit(1);
});
