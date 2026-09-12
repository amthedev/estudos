'use strict';

/**
 * Painel administrativo — configurações da plataforma.
 *
 *   GET /api/admin/settings               todas as chaves administráveis (padrões + o que está no banco)
 *   GET /api/admin/settings/integrations  status do OpenRouter, do Asaas e do SMTP (chaves sempre mascaradas)
 *   PUT /api/admin/settings               grava as chaves enviadas, validando uma a uma
 *   POST /api/admin/settings/smtp-test    envia um e-mail de teste para conferir o SMTP
 *
 * Segredos (OPENROUTER_API_KEY, ASAAS_API_KEY, SMTP_PASS…) NÃO passam por aqui: vivem apenas em
 * variáveis de ambiente. O painel só vê status e os últimos caracteres — nunca a chave inteira.
 */
const router = require('express').Router();
const config = require('../../config');
const { validate, z } = require('../../middleware/validate');
const { wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const settings = require('../../services/settings');
const ai = require('../../services/ai');
const payments = require('../../services/payments');
const mailer = require('../../services/mailer');

/** URL absoluta (https://…) ou caminho interno (/assets/brand/foco-elite-logo.png). */
const assetUrl = z
  .string()
  .trim()
  .min(1, 'Informe o endereço da imagem.')
  .max(500)
  .refine((value) => /^https?:\/\/\S+$/i.test(value) || value.startsWith('/'), 'Use uma URL completa ou um caminho interno começando com "/".');

const reviewIntervals = z
  .array(z.coerce.number().int().min(1, 'Use intervalos de pelo menos 1 dia.').max(3650))
  .length(3, 'Informe exatamente 3 intervalos de revisão (em dias).')
  .refine((list) => list[0] < list[1] && list[1] < list[2], 'Os intervalos precisam estar em ordem crescente.');

const scheduleDefaults = z
  .object({
    questions_block_min: z.coerce.number().int().min(5).max(180),
    review_block_min: z.coerce.number().int().min(5).max(120),
    essay_weekly: z.boolean(),
    simulado_every_days: z.coerce.number().int().min(1).max(90),
  })
  .strict();

const dailyQuotes = z.array(z.string().trim().min(3, 'Frase curta demais.').max(200)).max(50);

/** Uma entrada por chave administrável: a chave que não estiver aqui é recusada. */
const settingsBody = z
  .object({
    brand_name: z.string().trim().min(2, 'Informe o nome da marca.').max(80).optional(),
    logo_url: assetUrl.optional(),
    support_email: z.string().trim().toLowerCase().email('E-mail inválido.').max(160).optional(),
    require_subscription: z.boolean().optional(),
    openrouter_model: z.string().trim().min(3).max(120).optional(),
    openrouter_essay_model: z.string().trim().min(3).max(120).optional(),
    openrouter_monthly_token_limit: z.coerce.number().int().min(0, 'Use 0 para não limitar.').max(1_000_000_000).optional(),
    tutor_system_prompt: z.string().trim().min(40, 'O prompt do tutor precisa ser mais detalhado.').max(8000).optional(),
    review_intervals: reviewIntervals.optional(),
    schedule_defaults: scheduleDefaults.optional(),
    private_lessons_enabled: z.boolean().optional(),
    daily_quotes: dailyQuotes.optional(),
    // provedor de pagamento ativo: as chaves ficam no ambiente, aqui só a escolha
    payment_provider: z
      .enum(['asaas', 'none'], {
        errorMap: () => ({ message: 'Escolha Asaas ou nenhum.' }),
      })
      .optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nada para salvar.');

/** Acrescenta as chaves que ainda não existem no banco nem nos padrões do serviço. */
function withExtras(all) {
  return { daily_quotes: [], ...all };
}

router.get(
  '/integrations',
  wrap(async (req, res) => {
    const [openrouter, paymentStatus] = await Promise.all([ai.status(), payments.status()]);
    res.json({
      openrouter: {
        configured: openrouter.configured,
        mock: openrouter.mock,
        key: openrouter.key,
        model: openrouter.model,
        essay_model: openrouter.essay_model,
        month_tokens: openrouter.month_tokens,
        month_requests: openrouter.month_requests,
        limit: openrouter.limit,
        limit_reached: openrouter.limit_reached,
        last_error: openrouter.last_error,
      },
      asaas: paymentStatus.providers.asaas,
      payments: paymentStatus,
      smtp: mailer.smtpStatus(),
      app: { version: config.version, env: config.env, app_url: config.appUrl },
    });
  })
);

router.get(
  '/',
  wrap(async (req, res) => {
    res.json(withExtras(await settings.getAll()));
  })
);

router.put(
  '/',
  validate({ body: settingsBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const keys = Object.keys(body);
    const saved = await settings.setMany(body);
    await audit(req, 'settings.update', 'settings', null, { keys });
    res.json(withExtras(saved));
  })
);

/**
 * Dispara um e-mail de teste.
 *
 * Sem isto, a única forma de saber se o SMTP funciona era ler o log do
 * servidor — e a hospedagem usada não dá terminal. Quem configura precisa
 * conseguir confirmar de dentro do painel que a recuperação de senha vai
 * chegar ao aluno.
 */
router.post(
  '/smtp-test',
  validate({ body: z.object({ to: z.string().trim().email('Informe um e-mail válido.').max(160).optional() }) }),
  wrap(async (req, res) => {
    const destino = req.valid.body.to || req.admin.email;

    if (!mailer.isConfigured()) {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message:
            'SMTP não configurado. Cadastre SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS e SMTP_FROM ' +
            'nas variáveis de ambiente da hospedagem e reinicie a aplicação.',
        },
      });
      return;
    }

    // A conexão é conferida antes do envio porque os dois erros pedem ações
    // diferentes: credencial recusada é dado errado no painel da hospedagem;
    // mensagem recusada costuma ser remetente não verificado no provedor.
    const conexao = await mailer.verifyTransport();
    if (!conexao.ok) {
      await audit(req, 'settings.smtp_test', 'settings', null, { to: destino, ok: false, erro: conexao.error });
      res.status(502).json({
        error: {
          code: 'smtp_error',
          message: `O servidor de e-mail recusou a conexão: ${conexao.error}`,
          details: { etapa: 'conexao' },
        },
      });
      return;
    }

    const mensagem = mailer.testEmail({ name: req.admin.name });
    const envio = await mailer.sendMail({ to: destino, ...mensagem });
    await audit(req, 'settings.smtp_test', 'settings', null, { to: destino, ok: envio.sent, erro: envio.error || null });

    if (!envio.sent) {
      res.status(502).json({
        error: {
          code: 'smtp_error',
          message: `O servidor de e-mail recusou a mensagem: ${envio.error || 'motivo não informado'}`,
          details: { etapa: 'envio' },
        },
      });
      return;
    }

    res.json({
      ok: true,
      to: destino,
      message: `E-mail de teste enviado para ${destino}. Confira a caixa de entrada e o spam.`,
    });
  })
);

module.exports = { basePath: '/api/admin/settings', router };
