'use strict';

/**
 * Reprocessa eventos de pagamento que já chegaram mas não liberaram acesso.
 *
 *   node scripts/reprocessar-pagamentos.js                 lista o que está órfão
 *   node scripts/reprocessar-pagamentos.js --aplicar       reprocessa de verdade
 *   node scripts/reprocessar-pagamentos.js --dias 30       janela (padrão: 30)
 *
 * Existe por causa de um caso real: um Pix foi pago, o webhook chegou, e o
 * evento foi descartado em silêncio porque o código da época procurava o aluno
 * por um campo que o Asaas não envia na cobrança. O aluno pagou e não recebeu.
 *
 * O corpo de todo evento fica guardado em `payment_events`, inclusive os que o
 * processamento descartou — é isso que torna a recuperação possível. Este
 * script passa os eventos guardados pelo processamento ATUAL, já corrigido.
 *
 * É seguro rodar mais de uma vez: o crédito de cada cobrança é travado por
 * subscriptions.last_payment_id, então reprocessar não soma período nem cria
 * assinatura duplicada. Sem --aplicar, nada é escrito.
 */
const db = require('../server/db/pool');
const payments = require('../server/services/payments');

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
function lerDias() {
  const igual = args.find((a) => a.startsWith('--dias='));
  if (igual) return Number(igual.split('=')[1]);
  const i = args.indexOf('--dias');
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]);
  return 30;
}
const dias = Math.max(1, Number.isFinite(lerDias()) ? lerDias() : 30);

const log = (msg) => console.log(`[reprocessar] ${msg}`);

/** Eventos de pagamento cujo aluno hoje não tem acesso liberado. */
async function orfaos() {
  return db.many(
    `SELECT e.id, e.event_id, e.type, e.payload, e.processed_at
       FROM payment_events e
      WHERE e.provider = 'asaas'
        AND e.processed_at > now() - ($1 || ' days')::interval
        AND e.type IN ('CHECKOUT_PAID', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED')
      ORDER BY e.processed_at`,
    [String(Math.max(1, dias))]
  );
}

/** Quem tem assinatura valendo agora, para saber o que o reprocessamento mudou. */
async function comAcesso() {
  const linhas = await db.many(
    `SELECT user_id FROM subscriptions
      WHERE status IN ('active','trialing')
        AND (current_period_end IS NULL OR current_period_end > now())`
  );
  return new Set(linhas.map((l) => l.user_id));
}

async function main() {
  const eventos = await orfaos();
  if (!eventos.length) {
    log(`nenhum evento de pagamento nos últimos ${dias} dias.`);
    return;
  }

  const antes = await comAcesso();
  log(`${eventos.length} evento(s) de pagamento nos últimos ${dias} dias.`);
  log(`${antes.size} aluno(s) com acesso valendo agora.`);

  if (!aplicar) {
    for (const ev of eventos) {
      log(`  ${ev.processed_at.toISOString().slice(0, 16).replace('T', ' ')}  ${ev.type}  ${ev.event_id}`);
    }
    log('');
    log('Nada foi alterado. Para reprocessar de verdade, rode com --aplicar.');
    return;
  }

  let aplicados = 0;
  let falhas = 0;
  for (const ev of eventos) {
    try {
      // O mesmo caminho do webhook, mas sem a trava de duplicidade: o evento já
      // está gravado, e o que se quer agora é justamente passá-lo de novo pelo
      // processamento corrigido.
      await db.tx(async (tx) => {
        const evento = { provider: 'asaas', event_id: ev.event_id, type: ev.type, payload: ev.payload };
        const resultado = ev.type.startsWith('CHECKOUT_')
          ? await payments.applyAsaasCheckoutEvent(tx, evento)
          : await payments.applyAsaasEvent(tx, evento);
        const resumo = resultado && (resultado.skipped || resultado.unchanged || resultado.subscription_id || 'ok');
        log(`  ${ev.type} ${ev.event_id} → ${resumo}`);
      });
      aplicados += 1;
    } catch (err) {
      falhas += 1;
      log(`  ${ev.type} ${ev.event_id} → ERRO: ${err.message}`);
    }
  }

  const depois = await comAcesso();
  const novos = [...depois].filter((id) => !antes.has(id));

  log('');
  log(`${aplicados} evento(s) reprocessado(s), ${falhas} com erro.`);
  log(`${novos.length} aluno(s) passaram a ter acesso.`);
  for (const id of novos) {
    const u = await db.one('SELECT name, email FROM users WHERE id = $1', [id]);
    if (u) log(`  liberado: ${u.name} <${u.email}>`);
  }
}

main()
  .then(() => db.closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`[reprocessar] falhou: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    await db.closePool().catch(() => {});
    process.exit(1);
  });
