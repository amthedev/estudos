'use strict';

/**
 * Configuração da aplicação.
 * Lê o .env da raiz do projeto, valida com zod e exporta um objeto congelado.
 * Em NODE_ENV=test o banco usado é DATABASE_URL_TEST.
 */
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');
const { z } = require('zod');

const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

// Strings vazias no .env ("CHAVE=") valem como não definidas.
const emptyToUndefined = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const boolFromEnv = (fallback) =>
  z.preprocess((value) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'sim', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'nao', 'não', 'off'].includes(normalized)) return false;
    return fallback;
  }, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  APP_URL: z.string().url().default('http://localhost:4100'),
  BRAND_NAME: z.string().min(1).default('Foco Elite'),

  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_TEST: z.string().min(1).optional(),
  PGSSL: boolFromEnv(false),

  JWT_SECRET: z.string().min(16).optional(),
  ADMIN_JWT_SECRET: z.string().min(16).optional(),
  COOKIE_SECURE: boolFromEnv(undefined).optional(),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).optional(),
  TRUST_PROXY: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_ESSAY_MODEL: z.string().default('gpt-4o'),
  OPENAI_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().nonnegative().default(5_000_000),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  REQUIRE_SUBSCRIPTION: boolFromEnv(false),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: boolFromEnv(undefined).optional(),
  SMTP_FROM: z.string().default('Foco Elite <no-reply@focoelite.com.br>'),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_NAME: z.string().default('Administrador'),
});

const rawEnv = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, emptyToUndefined(value)]));
const parsed = envSchema.safeParse(rawEnv);

if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
  throw new Error(`Variáveis de ambiente inválidas:\n${lines.join('\n')}`);
}

const env = parsed.data;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';
const isDev = env.NODE_ENV === 'development';

// Banco: em teste usa obrigatoriamente o banco de testes (o schema é recriado a cada execução).
const databaseUrl = isTest ? env.DATABASE_URL_TEST : env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    isTest
      ? 'DATABASE_URL_TEST é obrigatória quando NODE_ENV=test.'
      : 'DATABASE_URL é obrigatória. Defina-a no arquivo .env.'
  );
}

// Segredos: obrigatórios e fortes em produção; em desenvolvimento/teste aceitam um valor de fallback.
function resolveSecret(name, value) {
  if (value) {
    if (isProd && (value.length < 32 || value.startsWith('dev-'))) {
      throw new Error(`${name} precisa ter ao menos 32 caracteres aleatórios em produção (ex.: openssl rand -hex 48).`);
    }
    return value;
  }
  if (isProd) throw new Error(`${name} é obrigatória em produção.`);
  const fallback = `${name.toLowerCase()}-inseguro-${env.NODE_ENV}-focoelite`;
  if (!isTest) console.warn(`[config] ${name} não definida; usando valor inseguro de desenvolvimento.`);
  return fallback;
}

const jwtSecret = resolveSecret('JWT_SECRET', env.JWT_SECRET);
const adminJwtSecret = resolveSecret('ADMIN_JWT_SECRET', env.ADMIN_JWT_SECRET);
if (jwtSecret === adminJwtSecret) {
  throw new Error('JWT_SECRET e ADMIN_JWT_SECRET precisam ser diferentes.');
}

// trust proxy: em produção normalmente há um proxy reverso (nginx/caddy) na frente.
function resolveTrustProxy(value) {
  if (value === undefined) return isProd ? 1 : false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return 1;
  if (normalized === 'false') return false;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return value; // ex.: 'loopback', lista de IPs
}

const deepFreeze = (obj) => {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
};

const config = deepFreeze({
  env: env.NODE_ENV,
  isProd,
  isDev,
  isTest,
  version: pkg.version,
  rootDir,
  publicDir: path.join(rootDir, 'public'),

  port: env.PORT,
  appUrl: env.APP_URL.replace(/\/+$/, ''),
  brandName: env.BRAND_NAME,
  trustProxy: resolveTrustProxy(env.TRUST_PROXY),

  databaseUrl,
  pgSsl: env.PGSSL,

  jwtSecret,
  adminJwtSecret,
  cookieSecure: env.COOKIE_SECURE ?? isProd,
  sessionDays: 7,
  bcryptRounds: env.BCRYPT_ROUNDS ?? (isTest ? 4 : 12),

  requireSubscription: env.REQUIRE_SUBSCRIPTION,

  openai: {
    apiKey: env.OPENAI_API_KEY ?? null,
    model: env.OPENAI_MODEL,
    essayModel: env.OPENAI_ESSAY_MODEL,
    monthlyTokenLimit: env.OPENAI_MONTHLY_TOKEN_LIMIT,
    enabled: Boolean(env.OPENAI_API_KEY),
  },

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY ?? null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
    enabled: Boolean(env.STRIPE_SECRET_KEY),
  },

  smtp: {
    host: env.SMTP_HOST ?? null,
    port: env.SMTP_PORT,
    user: env.SMTP_USER ?? null,
    pass: env.SMTP_PASS ?? null,
    secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
    from: env.SMTP_FROM,
    enabled: Boolean(env.SMTP_HOST),
  },

  admin: {
    email: env.ADMIN_EMAIL ?? null,
    password: env.ADMIN_PASSWORD ?? null,
    name: env.ADMIN_NAME,
  },
});

module.exports = config;
