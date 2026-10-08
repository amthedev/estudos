'use strict';

/**
 * Rastreio de vendas na Utmify (server/services/tracking/utmify.js).
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/utmify.test.js
 *
 * O que não pode quebrar: o corpo da ordem sai no formato que a Utmify espera
 * (centavos, datas UTC, método e status mapeados, só os UTMs conhecidos); a
 * comissão nunca fica negativa; e, acima de tudo, sendOrder NUNCA lança — é
 * recado de ida, e um pedido incompleto ou a integração desligada viram
 * { skipped } sem derrubar o pagamento do aluno.
 *
 * Importante sobre o ambiente: em NODE_ENV=test o config força
 * utmify.apiToken='' e utmify.enabled=false por segurança (ninguém manda venda
 * de verdade rodando os testes), e o config é deepFreeze — não dá para setar o
 * token em teste. Por isso o caminho do POST real é coberto INDIRETAMENTE: a
 * gente confere o corpo direto em buildOrder (que é separado do envio
 * justamente para isso), e em sendOrder só exercita os ramos que não dependem
 * de token (desligado / pedido incompleto), que são os que respondem sempre.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const utmify = require('../server/services/tracking/utmify');

/** Um pedido completo e bem formado, base para variações nos testes. */
function pedidoBase(campos = {}) {
  return {
    orderId: 'pedido-0001',
    status: 'paid',
    paymentMethod: 'pix',
    createdAt: new Date('2026-03-10T09:00:00.000Z'),
    approvedDate: new Date('2026-03-10T09:05:00.000Z'),
    customer: { name: 'Aluno Teste', email: 'aluno@exemplo.com', phone: '11999990000', document: '39053344705' },
    product: { id: 'plano-15', name: '15 meses', planId: '15-meses', planName: '15 meses', priceInCents: 35990 },
    tracking: {},
    gatewayFeeInCents: 1990,
    ...campos,
  };
}

describe('Utmify: monta o corpo da ordem (buildOrder)', () => {
  it('mantém os valores em centavos, inteiros e sem arredondamento perdido', () => {
    // A Utmify quer centavos; o serviço arredonda e nunca deixa negativo.
    const body = utmify.buildOrder(pedidoBase({ gatewayFeeInCents: 1990, product: { id: 'p', name: 'Plano', priceInCents: 35990.4 } }));
    assert.equal(body.products[0].priceInCents, 35990);
    assert.equal(body.commission.totalPriceInCents, 35990);
    assert.equal(body.commission.gatewayFeeInCents, 1990);
    assert.equal(body.commission.currency, 'BRL');
    assert.equal(body.products[0].quantity, 1);
  });

  it('mapeia a forma de pagamento; o que a Utmify não conhece vira pix', () => {
    assert.equal(utmify.buildOrder(pedidoBase({ paymentMethod: 'pix' })).paymentMethod, 'pix');
    assert.equal(utmify.buildOrder(pedidoBase({ paymentMethod: 'credit_card' })).paymentMethod, 'credit_card');
    assert.equal(utmify.buildOrder(pedidoBase({ paymentMethod: 'boleto' })).paymentMethod, 'boleto');
    // boleto é conhecido, mas "ted", undefined e lixo caem na cobrança avulsa (pix)
    assert.equal(utmify.buildOrder(pedidoBase({ paymentMethod: 'ted' })).paymentMethod, 'pix');
    assert.equal(utmify.buildOrder(pedidoBase({ paymentMethod: undefined })).paymentMethod, 'pix');
  });

  it('mantém status válido e troca status inválido por waiting_payment', () => {
    for (const s of ['waiting_payment', 'paid', 'refused', 'refunded', 'chargedback']) {
      assert.equal(utmify.buildOrder(pedidoBase({ status: s })).status, s);
    }
    assert.equal(utmify.buildOrder(pedidoBase({ status: 'inventado' })).status, 'waiting_payment');
    assert.equal(utmify.buildOrder(pedidoBase({ status: undefined })).status, 'waiting_payment');
  });

  it('status paid sempre tem approvedDate, mesmo sem a data informada', () => {
    // "paid" sem data de aprovação não liga a venda ao anúncio: o serviço
    // preenche com agora quando falta.
    const comData = utmify.buildOrder(pedidoBase({ status: 'paid', approvedDate: new Date('2026-03-10T09:05:00.000Z') }));
    assert.equal(comData.approvedDate, '2026-03-10 09:05:00');

    const semData = utmify.buildOrder(pedidoBase({ status: 'paid', approvedDate: null }));
    assert.ok(semData.approvedDate, 'paid sem data precisa receber uma data mesmo assim');
    assert.match(semData.approvedDate, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // Fora do paid, sem data informada, approvedDate fica null.
    const pendente = utmify.buildOrder(pedidoBase({ status: 'waiting_payment', approvedDate: null }));
    assert.equal(pendente.approvedDate, null);
  });

  it('trackingParameters só traz os UTMs conhecidos e descarta chaves estranhas', () => {
    const body = utmify.buildOrder(
      pedidoBase({
        tracking: {
          utm_source: 'facebook',
          utm_medium: 'cpc',
          utm_campaign: 'enem-2026',
          utm_term: 'simulado',
          utm_content: 'criativo-a',
          src: 'ig',
          sck: 'abc123',
          // ruído que não pode vazar para a Utmify:
          fbclid: 'nao-deve-ir',
          qualquer_coisa: 'lixo',
        },
      })
    );
    assert.deepEqual(Object.keys(body.trackingParameters).sort(), [
      'sck',
      'src',
      'utm_campaign',
      'utm_content',
      'utm_medium',
      'utm_source',
      'utm_term',
    ]);
    assert.equal(body.trackingParameters.utm_source, 'facebook');
    assert.equal(body.trackingParameters.src, 'ig');
    assert.equal(body.trackingParameters.sck, 'abc123');
    // nenhuma chave estranha sobreviveu
    assert.equal(body.trackingParameters.fbclid, undefined);
    assert.equal(body.trackingParameters.qualquer_coisa, undefined);
  });

  it('campos de rastreio ausentes ou vazios viram null, não string vazia', () => {
    const body = utmify.buildOrder(pedidoBase({ tracking: { utm_source: 'google', utm_medium: '' } }));
    assert.equal(body.trackingParameters.utm_source, 'google');
    assert.equal(body.trackingParameters.utm_medium, null, 'string vazia vira null');
    assert.equal(body.trackingParameters.utm_campaign, null, 'ausente vira null');
  });

  it('sem objeto de rastreio o corpo ainda sai válido, com todos os UTMs em null', () => {
    const body = utmify.buildOrder(pedidoBase({ tracking: undefined }));
    for (const v of Object.values(body.trackingParameters)) assert.equal(v, null);
  });

  it('a comissão do lojista é o total menos a taxa do gateway, nunca negativa', () => {
    const normal = utmify.buildOrder(pedidoBase({ product: { id: 'p', name: 'P', priceInCents: 35990 }, gatewayFeeInCents: 1990 }));
    assert.equal(normal.commission.userCommissionInCents, 35990 - 1990);

    // taxa maior que o total não pode gerar comissão negativa
    const taxaAlta = utmify.buildOrder(pedidoBase({ product: { id: 'p', name: 'P', priceInCents: 1000 }, gatewayFeeInCents: 5000 }));
    assert.equal(taxaAlta.commission.userCommissionInCents, 0);
  });
});

describe('Utmify: data no formato UTC (utcDateTime)', () => {
  it('formata "YYYY-MM-DD HH:MM:SS" em UTC a partir de Date e de string', () => {
    assert.equal(utmify.utcDateTime(new Date('2026-03-10T09:05:03.000Z')), '2026-03-10 09:05:03');
    assert.equal(utmify.utcDateTime('2026-03-10T09:05:03.000Z'), '2026-03-10 09:05:03');
  });

  it('devolve null para data inválida ou valor vazio', () => {
    assert.equal(utmify.utcDateTime(null), null);
    assert.equal(utmify.utcDateTime(undefined), null);
    assert.equal(utmify.utcDateTime(''), null);
    assert.equal(utmify.utcDateTime('não é uma data'), null);
    assert.equal(utmify.utcDateTime(new Date('nada')), null);
  });
});

describe('Utmify: envio da venda (sendOrder) nunca lança', () => {
  // Em teste o token é forçado vazio pelo config, então sendOrder sempre
  // devolve { skipped } — nunca chega ao POST. O caminho do POST real é
  // coberto indiretamente por buildOrder (o corpo), conforme explicado no topo.

  it('sem token configurado devolve { skipped } e não lança', async () => {
    // Em NODE_ENV=test o config.utmify.apiToken é '' por segurança.
    const r = await utmify.sendOrder(pedidoBase());
    assert.equal(typeof r, 'object');
    assert.ok(r.skipped, 'sem token nada é enviado');
    assert.equal(r.ok, undefined);
  });

  it('pedido incompleto (sem orderId/customer/product) devolve { skipped }', async () => {
    // Esses ramos respondem antes de precisar de token ou rede.
    for (const incompleto of [
      undefined,
      {},
      { orderId: 'x' },
      { orderId: 'x', customer: {} },
      { orderId: 'x', product: {} },
      { customer: {}, product: {} },
    ]) {
      const r = await utmify.sendOrder(incompleto);
      assert.equal(typeof r, 'object');
      assert.ok(r.skipped, `deveria pular: ${JSON.stringify(incompleto)}`);
    }
  });

  it('nunca rejeita: resolve sempre com um objeto', async () => {
    // A promessa de sendOrder é não derrubar quem chama de jeito nenhum.
    await assert.doesNotReject(() => utmify.sendOrder(pedidoBase()));
    await assert.doesNotReject(() => utmify.sendOrder(null));
  });
});

describe('Utmify: situação para o painel (status / isConfigured)', () => {
  it('sem token: configured e enabled falsos, token_last4 null', async () => {
    const s = await utmify.status();
    assert.equal(s.configured, false);
    assert.equal(s.enabled, false);
    assert.equal(s.token_last4, null);
  });

  it('isConfigured é false sem token em teste', () => {
    assert.equal(utmify.isConfigured(), false);
  });

  it('API_URL é o endpoint documentado da Utmify', () => {
    assert.equal(utmify.API_URL, 'https://api.utmify.com.br/api-credentials/orders');
  });
});
