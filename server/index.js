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

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[servidor] ${signal} recebido, encerrando...`);
    const forceExit = setTimeout(() => {
      console.error('[servidor] encerramento forçado.');
      process.exit(1);
    }, 8_000);
    forceExit.unref();
    server.close(async () => {
      await db.closePool().catch(() => {});
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Toda queda vira registro no banco antes de qualquer outra coisa. O console
  // da hospedagem guarda só as últimas linhas e nem sempre se alcança; sem isto,
  // um reinício no meio de um trabalho longo não deixa rastro nenhum — e foi
  // exatamente assim que uma varredura de prova sumiu três vezes seguidas,
  // levando junto o que já tinha sido pago à IA.
  process.on('unhandledRejection', (reason) => {
    console.error('[processo] rejeição não tratada:', reason);
    persistProcessError(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('[processo] exceção não capturada:', err);
    // Grava e só então encerra: com o encerramento na frente, o registro não
    // chegava a ser escrito.
    persistProcessError(err, 'uncaughtException').finally(() => shutdown('uncaughtException'));
  });
}

main().catch((err) => {
  console.error('[servidor] falha ao iniciar:', err);
  process.exit(1);
});
