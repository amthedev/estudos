'use strict';

/**
 * Conversions API do Meta, lado servidor (server/services/tracking/meta-capi.js).
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/meta-capi.test.js
 *
 * O que não pode quebrar: e-mail e telefone saem SEMPRE com hash SHA-256 (nunca
 * em texto puro, como o Meta exige); buildPurchase monta o corpo no formato do
 * evento Purchase (centavos viram reais, user_data só com o que tem); e, acima
 * de tudo, sendPurchase NUNCA lança — é recado de ida, e integração sem config
 * ou evento incompleto viram { skipped } sem derrubar o pagamento do aluno.
 *
 * Importante sobre o ambiente: em NODE_ENV=test o config força
 * config.meta.pixelId='' e config.meta.capiToken='' por segurança (ninguém
 * manda evento de verdade rodando os testes), e o config é deepFreeze — não dá
 * para setar pixel/token em teste. Além disso a setting meta_pixel_id está
 * vazia e meta_pixel_enabled=false. Logo isConfigured() é sempre false e
 * sendPurchase() sempre devolve { skipped }. Por isso o caminho do POST real é
 * coberto INDIRETAMENTE por buildPurchase (separado do envio justamente para
 * isso, não depende de token nem de rede), e em sendPurchase só exercitamos a
 * promessa de nunca lançar.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const meta = require('../server/services/tracking/meta-capi');

/** Uma venda completa e bem formada, base para variações nos testes. */
function vendaBase(campos = {}) {
  return {
    eventId: 'assinatura-0001',
    value: 3990, // centavos
    currency: 'BRL',
    email: 'aluno@exemplo.com',
    phone: '11999990000',
    clientIp: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    tracking: { fbp: 'fb.1.123.456', fbc: 'fb.1.123.abc' },
    eventTime: 1771666800,
    eventSourceUrl: 'https://exemplo.com/obrigado',
    ...campos,
  };
}

describe('Meta CAPI: normalizeAndHash', () => {
  it('e-mail: faz trim, minúsculas e SHA-256 (64 hex, sem @)', () => {
    // O Meta exige o dado em hash; nunca pode sobrar o e-mail em texto.
    const h = meta.normalizeAndHash('Ana@Teste.com ');
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!h.includes('@'), 'o hash não pode conter o e-mail puro');
  });

  it('e-mail normaliza antes do hash: variações de caixa/espaço dão o MESMO hash', () => {
    assert.equal(meta.normalizeAndHash('Ana@Teste.com '), meta.normalizeAndHash('ana@teste.com'));
  });

  it('telefone {phone:true}: tira tudo que não é dígito antes de hashear', () => {
    // '(11) 98888-7777' e '11988887777' são o mesmo número: mesmo hash.
    const comSimbolos = meta.normalizeAndHash('(11) 98888-7777', { phone: true });
    const soDigitos = meta.normalizeAndHash('11988887777', { phone: true });
    assert.match(comSimbolos, /^[0-9a-f]{64}$/);
    assert.equal(comSimbolos, soDigitos);
  });

  it('valor vazio/null vira null', () => {
    assert.equal(meta.normalizeAndHash(''), null);
    assert.equal(meta.normalizeAndHash(null), null);
    assert.equal(meta.normalizeAndHash(undefined), null);
    // telefone que fica sem nenhum dígito também vira null
    assert.equal(meta.normalizeAndHash('sem numero', { phone: true }), null);
  });
});

describe('Meta CAPI: monta o corpo do Purchase (buildPurchase)', () => {
  it('evento Purchase com action_source website e event_id string', () => {
    const ev = meta.buildPurchase(vendaBase()).data[0];
    assert.equal(ev.event_name, 'Purchase');
    assert.equal(ev.action_source, 'website');
    assert.equal(ev.event_id, 'assinatura-0001');
    assert.equal(typeof ev.event_id, 'string');
  });

  it('event_id sempre vira string, mesmo quando a venda manda número', () => {
    const ev = meta.buildPurchase(vendaBase({ eventId: 12345 })).data[0];
    assert.equal(ev.event_id, '12345');
    assert.equal(typeof ev.event_id, 'string');
  });

  it('value converte centavos para reais e currency cai para BRL', () => {
    const ev = meta.buildPurchase(vendaBase({ value: 3990, currency: undefined })).data[0];
    assert.equal(ev.custom_data.value, 39.9);
    assert.equal(ev.custom_data.currency, 'BRL');
  });

  it('currency informada é respeitada', () => {
    const ev = meta.buildPurchase(vendaBase({ currency: 'USD' })).data[0];
    assert.equal(ev.custom_data.currency, 'USD');
  });

  it('em é um ARRAY com o hash do e-mail, nunca o e-mail puro', () => {
    const ev = meta.buildPurchase(vendaBase({ email: 'ana@teste.com' })).data[0];
    assert.ok(Array.isArray(ev.user_data.em));
    assert.equal(ev.user_data.em[0], meta.normalizeAndHash('ana@teste.com'));
    assert.match(ev.user_data.em[0], /^[0-9a-f]{64}$/);
  });

  it('ph só aparece quando o telefone foi passado', () => {
    const comTel = meta.buildPurchase(vendaBase({ phone: '11988887777' })).data[0];
    assert.ok(Array.isArray(comTel.user_data.ph));
    assert.equal(comTel.user_data.ph[0], meta.normalizeAndHash('11988887777', { phone: true }));

    const semTel = meta.buildPurchase(vendaBase({ phone: undefined })).data[0];
    assert.equal(semTel.user_data.ph, undefined);
  });

  it('fbp/fbc do tracking vão para user_data; chaves estranhas são descartadas', () => {
    const ev = meta.buildPurchase(
      vendaBase({ tracking: { fbp: 'fb.1.1.p', fbc: 'fb.1.1.c', utm_source: 'face', lixo: 'x' } })
    ).data[0];
    assert.equal(ev.user_data.fbp, 'fb.1.1.p');
    assert.equal(ev.user_data.fbc, 'fb.1.1.c');
    assert.equal(ev.user_data.utm_source, undefined, 'só fbp/fbc do Meta sobrevivem');
    assert.equal(ev.user_data.lixo, undefined);
  });

  it('sem email e sem phone: user_data não tem em/ph e não quebra', () => {
    const ev = meta.buildPurchase(vendaBase({ email: undefined, phone: undefined })).data[0];
    assert.equal(ev.user_data.em, undefined);
    assert.equal(ev.user_data.ph, undefined);
    // o resto do user_data (ip, user agent, click ids) continua presente
    assert.equal(ev.user_data.client_ip_address, '203.0.113.7');
  });

  it('value negativo ou ausente vira 0', () => {
    assert.equal(meta.buildPurchase(vendaBase({ value: -500 })).data[0].custom_data.value, 0);
    assert.equal(meta.buildPurchase(vendaBase({ value: undefined })).data[0].custom_data.value, 0);
    assert.equal(meta.buildPurchase(vendaBase({ value: 'abc' })).data[0].custom_data.value, 0);
  });
});

describe('Meta CAPI: envio do Purchase (sendPurchase) nunca lança', () => {
  // Em teste não há pixel/token, então isConfigured() é false e sendPurchase
  // devolve { skipped } antes de qualquer rede. O ramo do eventId nunca é
  // alcançado (isConfigured ganha primeiro); aqui garantimos só que não lança
  // e que devolve um objeto com skipped. O POST real é coberto por buildPurchase.

  it('sem pixel/token devolve { skipped } e não lança', async () => {
    const r = await meta.sendPurchase(vendaBase());
    assert.equal(typeof r, 'object');
    assert.ok(r.skipped, 'sem config nada é enviado');
    assert.equal(r.ok, undefined);
  });

  it('venda vazia/incompleta também devolve objeto com skipped, sem lançar', async () => {
    // isConfigured false ganha antes do ramo do eventId, mas o contrato
    // segue: devolve objeto com skipped.
    for (const incompleto of [undefined, null, {}, { eventId: '' }]) {
      const r = await meta.sendPurchase(incompleto);
      assert.equal(typeof r, 'object');
      assert.ok(r.skipped, `deveria pular: ${JSON.stringify(incompleto)}`);
    }
  });

  it('nunca rejeita: resolve sempre com um objeto', async () => {
    await assert.doesNotReject(() => meta.sendPurchase(vendaBase()));
    await assert.doesNotReject(() => meta.sendPurchase(null));
    await assert.doesNotReject(() => meta.sendPurchase({}));
  });
});

describe('Meta CAPI: situação para o painel (status) e flags', () => {
  it('sem pixel e sem token: tudo desligado e nada vazado', async () => {
    const s = await meta.status();
    assert.equal(s.pixel_id, null);
    assert.equal(s.capi_configured, false);
    assert.equal(s.capi_token_last4, null);
    assert.equal(s.enabled, false);
  });

  it('pixel_id_source é null quando não há id', async () => {
    const s = await meta.status();
    assert.equal(s.pixel_id_source, null);
  });

  it('isConfigured e isEnabled são false em teste', async () => {
    assert.equal(await meta.isConfigured(), false);
    assert.equal(await meta.isEnabled(), false);
  });

  it('pixelId() devolve string vazia sem painel nem ambiente', async () => {
    assert.equal(await meta.pixelId(), '');
  });

  it('GRAPH_VERSION é a versão documentada do Graph', () => {
    assert.equal(meta.GRAPH_VERSION, 'v21.0');
  });
});
