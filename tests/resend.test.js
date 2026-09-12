'use strict';

/**
 * Envio de e-mail pelo Resend.
 *
 *   NODE_ENV=test node --test tests/resend.test.js
 *
 * O Resend é a escolha do projeto para recuperação de senha e avisos. Envia
 * por API, não por SMTP, e exige domínio verificado no painel dele — que é o
 * tropeço mais comum de quem configura pela primeira vez.
 *
 * O que não pode quebrar: a mensagem de erro do provedor tem que chegar
 * inteira a quem está configurando (é ela que diz o que falta), a chave nunca
 * pode aparecer no painel, e o SMTP tem que continuar funcionando para quem
 * preferir outro serviço.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const resend = require('../server/services/resend');

/** Resposta HTTP falsa, no formato que o fetch devolve. */
const resposta = (status, corpo) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
});

/** Liga a chave só durante o teste: o objeto de configuração é congelado. */
function comChave(valor, fn) {
  resend.setApiKeyForTests(valor);
  return Promise.resolve()
    .then(fn)
    .finally(() => resend.setApiKeyForTests(null));
}

describe('Resend', () => {
  afterEach(() => {
    resend.setHttpClient(null);
  });

  it('envia para o endpoint certo, com a chave no cabeçalho', async () => {
    const chamadas = [];
    resend.setHttpClient(async (url, init) => {
      chamadas.push({ url, init });
      return resposta(200, { id: 'msg_123' });
    });

    await comChave('re_chave_de_teste', async () => {
      const res = await resend.send({
        from: 'Foco de Elite <no-reply@focoelite.com.br>',
        to: 'aluno@exemplo.com',
        subject: 'Assunto',
        text: 'corpo',
      });
      assert.equal(res.id, 'msg_123');
    });

    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].url, resend.API_URL);
    assert.equal(chamadas[0].init.headers.Authorization, 'Bearer re_chave_de_teste');

    const corpo = JSON.parse(chamadas[0].init.body);
    assert.deepEqual(corpo.to, ['aluno@exemplo.com'], 'o destinatário vai como lista');
    assert.equal(corpo.subject, 'Assunto');
    assert.equal(corpo.html, undefined, 'não manda html vazio');
  });

  it('repassa inteira a explicação do Resend quando ele recusa', async () => {
    // É esta mensagem que diz a quem configura o que está faltando. Trocar por
    // um texto genérico deixaria a pessoa sem saber o que fazer.
    resend.setHttpClient(async () =>
      resposta(403, { message: 'The focoelite.com.br domain is not verified. Please verify your domain.' })
    );

    await comChave('re_chave', async () => {
      await assert.rejects(
        () => resend.send({ from: 'a@b.com', to: 'c@d.com', subject: 'x', text: 'y' }),
        (err) => {
          assert.match(err.message, /is not verified/);
          assert.match(err.message, /focoelite\.com\.br/);
          return true;
        }
      );
    });
  });

  it('entende o outro formato de erro do provedor', async () => {
    resend.setHttpClient(async () => resposta(422, { error: { message: 'Invalid `to` field' } }));
    await comChave('re_chave', async () => {
      await assert.rejects(
        () => resend.send({ from: 'a@b.com', to: 'x', subject: 'x', text: 'y' }),
        (err) => {
          assert.match(err.message, /Invalid `to` field/);
          return true;
        }
      );
    });
  });

  it('não engole uma resposta que nem é JSON', async () => {
    resend.setHttpClient(async () => resposta(502, '<html>Bad Gateway</html>'));
    await comChave('re_chave', async () => {
      await assert.rejects(
        () => resend.send({ from: 'a@b.com', to: 'c@d.com', subject: 'x', text: 'y' }),
        (err) => {
          assert.match(err.message, /Bad Gateway/);
          return true;
        }
      );
    });
  });

  it('recusa enviar sem chave configurada', async () => {
    await assert.rejects(
      () => resend.send({ from: 'a@b.com', to: 'c@d.com', subject: 'x', text: 'y' }),
      /RESEND_API_KEY/
    );
  });

  it('o status mostra só os últimos caracteres da chave', async () => {
    await comChave('re_chave_secreta_9f3a', async () => {
      const s = resend.status();
      assert.equal(s.configured, true);
      assert.equal(s.key_last4, '9f3a');
      assert.equal(JSON.stringify(s).includes('re_chave_secreta'), false, 'a chave inteira não pode vazar');
    });
  });
});

describe('Escolha do provedor de e-mail', () => {
  it('prefere o Resend quando a chave existe, e cai no SMTP quando não', async () => {
    const mailer = require('../server/services/mailer');
    assert.equal(mailer.provider(), null, 'sem nada configurado, não há provedor');

    await comChave('re_chave', async () => {
      assert.equal(mailer.provider(), 'resend');
      const status = mailer.smtpStatus();
      assert.equal(status.provider, 'resend');
      assert.equal(status.provider_label, 'Resend');
      assert.equal(status.configured, true);
      assert.equal(status.key_last4, 'have');
    });
  });
});
