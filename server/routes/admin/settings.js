'use strict';

/**
 * Painel administrativo — configurações da plataforma.
 *
 *   GET /api/admin/settings               todas as chaves administráveis (padrões + o que está no banco)
 *   GET /api/admin/settings/integrations  status da OpenAI, do Stripe e do SMTP (chaves sempre mascaradas)
 *   PUT /api/admin/settings               grava as chaves enviadas, validando uma a uma
 *
 * Segredos (OPENAI_API_KEY, STRIPE_SECRET_KEY, SMTP_PASS…) NÃO passam por aqui: vivem apenas em
 * variáveis de ambiente. O painel só vê status e os últimos caracteres — nunca a chave inteira.
 */
const router = require('express').Router();
const config = require('../../config');
const { validate, z } = require('../../middleware/validate');
const { wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const settings = require('../../services/settings');
const ai = require('../../services/ai');
const stripeService = require('../../services/stripe');
const mailer = require('../../services/mailer');

/** URL absoluta (https://…) ou caminho interno (/assets/logo.svg). */
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
    openai_model: z.string().trim().min(3).max(80).optional(),
    openai_essay_model: z.string().trim().min(3).max(80).optional(),
    openai_monthly_token_limit: z.coerce.number().int().min(0, 'Use 0 para não limitar.').max(1_000_000_000).optional(),
    tutor_system_prompt: z.string().trim().min(40, 'O prompt do tutor precisa ser mais detalhado.').max(8000).optional(),
    review_intervals: reviewIntervals.optional(),
    schedule_defaults: scheduleDefaults.optional(),
    private_lessons_enabled: z.boolean().optional(),
    daily_quotes: dailyQuotes.optional(),
    // provedor de pagamento ativo: as chaves ficam no ambiente, aqui só a escolha
    payment_provider: z
      .enum(['asaas', 'stripe', 'none'], { errorMap: () => ({ message: 'Escolha Asaas, Stripe ou nenhum.' }) })
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
    const openai = await ai.status();
    res.json({
      openai: {
        configured: openai.configured,
        mock: openai.mock,
        key: openai.key,
        model: openai.model,
        essay_model: openai.essay_model,
        month_tokens: openai.month_tokens,
        month_requests: openai.month_requests,
        limit: openai.limit,
        limit_reached: openai.limit_reached,
        last_error: openai.last_error,
      },
      stripe: stripeService.status(),
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

module.exports = { basePath: '/api/admin/settings', router };
