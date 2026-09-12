'use strict';

/**
 * Teste de envio de e-mail pelo painel.
 *
 *   NODE_ENV=test node --test tests/smtp-test.test.js
 *
 * A hospedagem não dá terminal, então não havia como saber se o envio estava
 * funcionando sem pedir uma recuperação de senha de verdade e torcer. Esta
 * rota confirma de dentro do painel, valendo para Resend ou SMTP.
 *
 * O que não pode quebrar: aluno nenhum chega aqui, sem provedor a mensagem diz
 * o que fazer em vez de falhar seco, e credencial recusada é distinguida de
 * mensagem recusada — são problemas diferentes, com soluções diferentes.
 */
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const mailer = require('../server/services/mailer');

describe('Teste de envio de e-mail pelo painel', () => {
  let ctx;
  let admin;
  let student;
  const original = {};

  before(async () => {
    ctx = await createTestContext();
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluno Sem Acesso' });
    original.isConfigured = mailer.isConfigured;
    original.verifyTransport = mailer.verifyTransport;
    original.sendMail = mailer.sendMail;
  });

  afterEach(() => {
    Object.assign(mailer, original);
    mailer.outbox.length = 0;
  });

  after(async () => {
    Object.assign(mailer, original);
    await ctx.close();
  });

  it('aluno não dispara e-mail de teste', async () => {
    const res = await student.agent.post('/api/admin/settings/smtp-test', {});
    assert.ok([401, 403].includes(res.status), `respondeu ${res.status} a um aluno`);
  });

  it('sem provedor configurado, explica o que cadastrar', async () => {
    mailer.isConfigured = () => false;
    const res = await admin.agent.post('/api/admin/settings/smtp-test', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /SMTP_HOST/, 'nomeia as variáveis que faltam');
    assert.match(res.body.error.message, /RESEND_API_KEY/, 'e a alternativa por API');
    assert.match(res.body.error.message, /reinicie/i, 'variável só vale depois do restart');
  });

  it('credencial recusada aponta a conexão, não a mensagem', async () => {
    // É o erro de quem digitou usuário ou senha errados no painel da
    // hospedagem — e a ação é ir lá corrigir.
    mailer.isConfigured = () => true;
    mailer.verifyTransport = async () => ({ ok: false, error: 'Invalid login: 535 Authentication failed' });

    const res = await admin.agent.post('/api/admin/settings/smtp-test', {});
    assert.equal(res.status, 502);
    assert.equal(res.body.error.details.etapa, 'conexao');
    assert.match(res.body.error.message, /recusou a conexão/i);
    assert.match(res.body.error.message, /Authentication failed/, 'o motivo do provedor tem que aparecer');
  });

  it('domínio não verificado vira instrução, não só o erro cru', async () => {
    // Foi o erro real ao configurar: o Resend nomeia o domínio, mas não diz o
    // que fazer. A dica é o que transforma a mensagem em ação.
    mailer.isConfigured = () => true;
    mailer.verifyTransport = async () => ({ ok: true });
    mailer.sendMail = async () => ({
      sent: false,
      error: 'The mail.exemplo.com domain is not verified. Please, add and verify your domain',
    });

    const res = await admin.agent.post('/api/admin/settings/smtp-test', {});
    assert.equal(res.status, 502);
    assert.match(res.body.error.message, /mail\.exemplo\.com/, 'mantém o domínio que o provedor citou');
    assert.match(res.body.error.message, /SMTP_FROM/, 'e diz onde mexer');
  });

  it('chave sem permissão para o domínio também vira instrução', async () => {
    mailer.isConfigured = () => true;
    mailer.verifyTransport = async () => ({ ok: true });
    mailer.sendMail = async () => ({
      sent: false,
      error: 'This API key is not authorized to send emails from mail.exemplo.com',
    });

    const res = await admin.agent.post('/api/admin/settings/smtp-test', {});
    assert.equal(res.status, 502);
    assert.match(res.body.error.message, /permissão/i);
    assert.match(res.body.error.message, /acesso total/i);
  });

  it('mensagem recusada aponta o envio, não a conexão', async () => {
    // Conexão boa, mensagem rejeitada: no Resend isso costuma ser domínio
    // ainda não verificado, que se resolve no painel do provedor.
    mailer.isConfigured = () => true;
    mailer.verifyTransport = async () => ({ ok: true });
    mailer.sendMail = async () => ({ sent: false, error: 'Sender address not verified' });

    const res = await admin.agent.post('/api/admin/settings/smtp-test', {});
    assert.equal(res.status, 502);
    assert.equal(res.body.error.details.etapa, 'envio');
    assert.match(res.body.error.message, /recusou a mensagem/i);
    assert.match(res.body.error.message, /not verified/);
  });

  it('com o envio funcionando, manda para o próprio administrador', async () => {
    mailer.isConfigured = () => true;
    mailer.verifyTransport = async () => ({ ok: true });
    const enviados = [];
    mailer.sendMail = async (mensagem) => {
      enviados.push(mensagem);
      return { sent: true, messageId: '<teste@focoelite>' };
    };

    const res = await admin.agent.post('/api/admin/settings/smtp-test', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].to, res.body.to, 'o destino informado é o que foi usado');
    assert.match(enviados[0].subject, /Teste de envio/i);
    assert.match(res.body.message, /spam/i, 'avisa para conferir o spam');
  });

  it('aceita um destinatário informado', async () => {
    mailer.isConfigured = () => true;
    mailer.verifyTransport = async () => ({ ok: true });
    const enviados = [];
    mailer.sendMail = async (mensagem) => {
      enviados.push(mensagem);
      return { sent: true };
    };

    const res = await admin.agent.post('/api/admin/settings/smtp-test', { to: 'outro@focoelite.com.br' });
    assert.equal(res.status, 200);
    assert.equal(enviados[0].to, 'outro@focoelite.com.br');
  });

  it('recusa um endereço inválido antes de tentar enviar', async () => {
    mailer.isConfigured = () => true;
    let tentou = false;
    mailer.sendMail = async () => {
      tentou = true;
      return { sent: true };
    };

    const res = await admin.agent.post('/api/admin/settings/smtp-test', { to: 'nao-e-email' });
    assert.equal(res.status, 400);
    assert.equal(tentou, false, 'nem chega a tentar enviar');
  });
});
