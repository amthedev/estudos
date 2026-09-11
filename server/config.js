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
const envFile = path.join(rootDir, '.env');
const hasEnvFile = fs.existsSync(envFile);
dotenv.config({ path: envFile });

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
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  HOST: z.string().min(1).default('0.0.0.0'),
  APP_URL: z.string().url().default('http://localhost:4100'),
  BRAND_NAME: z.string().min(1).default('Foco Elite'),

  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_TEST: z.string().min(1).optional(),
  PGSSL: boolFromEnv(false),
  // Certificado do PostgreSQL gerenciado da Square Cloud: um único .pem que
  // serve como CA, certificado e chave do cliente. Pode vir como o próprio
  // texto PEM ou em base64, que é como a API da Square Cloud o entrega.
  PGSSL_CERT: z.string().optional(),
  PGSSL_CERT_FILE: z.string().optional(),
  PGSSL_CA: z.string().optional(),
  PGSSL_CA_FILE: z.string().optional(),

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
  SQUARECLOUD_API_KEY: z.string().optional(),
  STORAGE_PROVIDER: z.string().optional(),

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

// Tudo que falta é acumulado e relatado de uma vez. Subir, falhar numa
// variável, corrigir e subir de novo para falhar na seguinte custa um ciclo de
// publicação inteiro a cada vez; quem está configurando merece a lista completa
// na primeira tentativa.
const problemas = [];

// Banco: em teste usa obrigatoriamente o banco de testes (o schema é recriado a cada execução).
const databaseUrl = isTest ? env.DATABASE_URL_TEST : env.DATABASE_URL;
if (!databaseUrl) {
  problemas.push(
    isTest
      ? 'DATABASE_URL_TEST — obrigatória quando NODE_ENV=test.'
      : 'DATABASE_URL — endereço do PostgreSQL, ex.: postgres://usuario:senha@host:5432/focoelite?sslmode=require'
  );
}

// Segredos: obrigatórios e fortes em produção; em desenvolvimento/teste aceitam um valor de fallback.
function resolveSecret(name, value) {
  if (value) {
    if (isProd && (value.length < 32 || value.startsWith('dev-'))) {
      problemas.push(`${name} — precisa de ao menos 32 caracteres aleatórios em produção. Gere com: openssl rand -hex 48`);
    }
    return value;
  }
  if (isProd) {
    problemas.push(`${name} — obrigatória em produção. Gere com: openssl rand -hex 48`);
    return null;
  }
  const fallback = `${name.toLowerCase()}-inseguro-${env.NODE_ENV}-focoelite`;
  if (!isTest) console.warn(`[config] ${name} não definida; usando valor inseguro de desenvolvimento.`);
  return fallback;
}

const jwtSecret = resolveSecret('JWT_SECRET', env.JWT_SECRET);
const adminJwtSecret = resolveSecret('ADMIN_JWT_SECRET', env.ADMIN_JWT_SECRET);
if (jwtSecret && adminJwtSecret && jwtSecret === adminJwtSecret) {
  problemas.push('JWT_SECRET e ADMIN_JWT_SECRET — precisam ser dois valores diferentes.');
}

if (problemas.length) {
  // O aviso muda conforme onde a aplicação está rodando: cobrar um arquivo .env
  // de quem publicou numa hospedagem, onde esse arquivo não existe, manda a
  // pessoa procurar no lugar errado.
  const onde = hasEnvFile
    ? `Defina no arquivo .env da raiz do projeto (${envFile}).`
    : 'Não há arquivo .env aqui: defina estas variáveis no painel da hospedagem, na tela de variáveis de ambiente da aplicação, e publique de novo.';

  throw new Error(
    [
      `Faltam ${problemas.length} configuração(ões) para a aplicação subir:`,
      ...problemas.map((linha) => `  - ${linha}`),
      '',
      onde,
      'Para conferir tudo de uma vez, sem subir o servidor: npm run check',
    ].join('\n')
  );
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

/**
 * Porta em que o processo escuta.
 *
 * A Square Cloud roteia o tráfego HTTPS da borda para a porta 80 do container,
 * e só para ela: escutar em qualquer outra faz o endereço dar timeout com o
 * log limpo, sem erro nenhum para investigar. A documentação da plataforma não
 * promete injetar PORT no processo — a única variável que ela afirma injetar
 * sozinha é SQUARECLOUD_APP_ID. Então é essa que serve para reconhecer onde a
 * aplicação está rodando e escolher a porta 80 por conta própria.
 *
 * PORT explícita sempre vence, para quem hospedar em outro lugar.
 */
function resolvePort(value) {
  if (value !== undefined) return value;
  return process.env.SQUARECLOUD_APP_ID ? 80 : 4100;
}

/**
 * Lê um material PEM do ambiente: o texto direto, o mesmo texto em base64 (é
 * assim que a API da Square Cloud entrega, e é a forma que cabe numa linha só
 * no painel) ou o caminho de um arquivo dentro do projeto.
 *
 * O PostgreSQL gerenciado da Square Cloud recusa conexão em texto puro e
 * entrega três arquivos: `ca-certificate.crt` (a autoridade), `certificate.pem`
 * (certificado e chave do cliente no mesmo arquivo) e `private-key.key` (a
 * chave sozinha, para clientes que exigem separada). O `pg` aceita o
 * `certificate.pem` como certificado e chave ao mesmo tempo, então bastam dois:
 * PGSSL_CERT com o .pem e PGSSL_CA com o .crt.
 */
function readPem(nomeInline, inline, nomeFile, file) {
  const raw = (() => {
    if (inline) return inline.includes('-----BEGIN') ? inline : Buffer.from(inline, 'base64').toString('utf8');
    if (!file) return '';
    const full = path.isAbsolute(file) ? file : path.join(rootDir, file);
    if (!fs.existsSync(full)) {
      throw new Error(`${nomeFile} aponta para um arquivo que não existe: ${full}`);
    }
    return fs.readFileSync(full, 'utf8');
  })();

  const pem = raw.trim();
  if (!pem) return null;
  if (!pem.includes('-----BEGIN')) {
    throw new Error(
      `${inline ? nomeInline : nomeFile} não parece ser um PEM válido: falta o bloco -----BEGIN. ` +
        'Use o conteúdo do arquivo, em texto ou em base64.'
    );
  }
  return pem;
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
  squarecloud: {
    // Chave da conta usada pelo Blob Storage; fica só no servidor.
    // Em teste é sempre vazia: a suíte não pode gravar nem apagar nada na
    // conta real de quem estiver rodando os testes.
    blobKey: isTest ? '' : env.SQUARECLOUD_API_KEY || '',
  },
  storageProvider: env.STORAGE_PROVIDER || '',
  publicDir: path.join(rootDir, 'public'),

  port: resolvePort(env.PORT),
  host: env.HOST,
  appUrl: env.APP_URL.replace(/\/+$/, ''),
  brandName: env.BRAND_NAME,
  trustProxy: resolveTrustProxy(env.TRUST_PROXY),

  databaseUrl,
  pgSsl: env.PGSSL,
  pgSslCert: readPem('PGSSL_CERT', env.PGSSL_CERT, 'PGSSL_CERT_FILE', env.PGSSL_CERT_FILE),
  pgSslCa: readPem('PGSSL_CA', env.PGSSL_CA, 'PGSSL_CA_FILE', env.PGSSL_CA_FILE),

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
