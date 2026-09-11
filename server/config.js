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

/**
 * Ambiente presumido quando NODE_ENV não é informada.
 *
 * Presumir desenvolvimento numa hospedagem é perigoso: os segredos de sessão
 * ganham um valor de desenvolvimento previsível — que está publicado neste
 * repositório —, os cookies deixam de exigir HTTPS, e nada disso aparece como
 * erro. A aplicação sobe, o site responde e qualquer pessoa consegue forjar
 * uma sessão.
 *
 * A Square Cloud injeta SQUARECLOUD_APP_ID no processo. Havendo essa marca,
 * o padrão passa a ser produção, e a aplicação recusa subir sem segredos de
 * verdade em vez de ficar aberta em silêncio. NODE_ENV explícita sempre vence.
 */
const AMBIENTE_PADRAO = process.env.SQUARECLOUD_APP_ID ? 'production' : 'development';

const envSchema = z.object({
  // O padrão muda conforme onde a aplicação está: numa hospedagem ela é
  // produção até prova em contrário. Ver AMBIENTE_PADRAO, logo acima.
  NODE_ENV: z.enum(['development', 'test', 'production']).default(AMBIENTE_PADRAO),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  HOST: z.string().min(1).default('0.0.0.0'),
  APP_URL: z
    .string()
    .url('precisa ser o endereço completo do site, com o protocolo na frente (ex.: https://focoelite.com.br)')
    .default('http://localhost:4100'),
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

  JWT_SECRET: z.string().min(16, 'precisa de pelo menos 16 caracteres (gere com: openssl rand -hex 48)').optional(),
  ADMIN_JWT_SECRET: z
    .string()
    .min(16, 'precisa de pelo menos 16 caracteres (gere com: openssl rand -hex 48)')
    .optional(),
  COOKIE_SECURE: boolFromEnv(undefined).optional(),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).optional(),
  TRUST_PROXY: z.string().optional(),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('qwen/qwen3.8-flash'),
  OPENROUTER_ESSAY_MODEL: z.string().default('qwen/qwen3.8-flash'),
  OPENROUTER_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().nonnegative().default(5_000_000),

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
  const lines = parsed.error.issues.map((issue) => {
    const nome = issue.path.join('.') || '(raiz)';
    // O valor recebido ajuda a achar o erro de digitação, mas nem todo valor
    // pode ir para o log: chave e senha ficam de fora.
    const sensivel = /SECRET|PASS|KEY|TOKEN|DATABASE_URL|CERT|_CA$/i.test(nome);
    const recebido = process.env[nome];
    const mostra = !sensivel && recebido !== undefined ? ` (recebeu: "${recebido}")` : '';
    return `  - ${nome}: ${issue.message}${mostra}`;
  });
  throw new Error(
    [
      `${lines.length} variável(is) de ambiente com valor inválido:`,
      ...lines,
      '',
      hasEnvFile
        ? `Corrija no arquivo .env da raiz do projeto (${envFile}).`
        : 'Corrija na tela de variáveis de ambiente da aplicação, no painel da hospedagem, e publique de novo.',
    ].join('\n')
  );
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
/** Um PEM truncado ainda mostra o -----BEGIN; sem o -----END ele está cortado. */
function pemCompleto(texto) {
  const inicios = (texto.match(/-----BEGIN /g) || []).length;
  const fins = (texto.match(/-----END /g) || []).length;
  return inicios > 0 && inicios === fins;
}

function readPem(nomeInline, inline, nomeFile, file) {
  if (!inline && !file) return null;

  if (!inline) {
    const full = path.isAbsolute(file) ? file : path.join(rootDir, file);
    if (!fs.existsSync(full)) {
      throw new Error(`${nomeFile} aponta para um arquivo que não existe: ${full}`);
    }
    const doArquivo = fs.readFileSync(full, 'utf8').trim();
    if (!pemCompleto(doArquivo)) {
      throw new Error(`O arquivo apontado por ${nomeFile} não é um PEM completo: falta -----BEGIN ou -----END. (${full})`);
    }
    return doArquivo;
  }

  // Campo de painel maltrata texto colado: pode vir entre aspas, com o "\n"
  // escrito literalmente no lugar da quebra de linha, ou com a quebra virando
  // espaço. Nada disso é erro de quem configurou, então é tratado aqui.
  const limpo = inline.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');

  if (limpo.includes('-----BEGIN')) {
    if (!pemCompleto(limpo)) {
      throw new Error(
        `${nomeInline} chegou cortado: começa com -----BEGIN mas o -----END não veio junto. ` +
          `Recebi ${limpo.length} caractere(s). Copie o conteúdo inteiro do arquivo, ` +
          `ou use ${nomeFile} apontando para ele.`
      );
    }
    // PEM colado direto. Se as quebras viraram espaço, o conteúdo em base64
    // entre os cabeçalhos é remontado — o OpenSSL aceita a linha única.
    return limpo.includes('\n') ? limpo : limpo.replace(/(-----)\s+/g, '$1\n').replace(/\s+(-----)/g, '\n$1');
  }

  const semEspaco = limpo.replace(/\s+/g, '');
  const decodificado = Buffer.from(semEspaco.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    .toString('utf8')
    .trim();
  if (pemCompleto(decodificado)) return decodificado;

  // Decodificou mas veio pela metade: o valor foi cortado na hora de colar.
  // Isso precisa falhar aqui, senão o erro só apareceria na conexão com o
  // banco, com uma mensagem do OpenSSL que não ajuda ninguém.
  if (decodificado.includes('-----BEGIN')) {
    throw new Error(
      `${nomeInline} chegou cortado: o conteúdo começa certo, com -----BEGIN, mas o -----END não veio junto. ` +
        `Recebi ${limpo.length} caractere(s) — o valor foi truncado ao ser colado. ` +
        `Copie o conteúdo inteiro, ou apague ${nomeInline} e use ${nomeFile}=certificate.pem apontando para o arquivo.`
    );
  }

  // Não deu: o diagnóstico descreve o valor sem imprimi-lo. É certificado, e o
  // log de deploy fica guardado no painel da hospedagem.
  const pistas = [`${limpo.length} caractere(s)`];
  if (/^[A-Za-z0-9+/=_-]+$/.test(semEspaco)) pistas.push('parece base64');
  else pistas.push('tem caracteres que não existem em base64 — provavelmente não é o conteúdo do arquivo');
  if (limpo.length >= 4000) pistas.push('perto do limite de 4096 do painel, pode ter sido cortado');

  throw new Error(
    `${nomeInline} não é um certificado válido: nem em texto nem em base64 aparece o bloco -----BEGIN. ` +
      `Recebi ${pistas.join('; ')}. ` +
      `Se o arquivo já está na aplicação, o caminho mais simples é apagar ${nomeInline} e usar ` +
      `${nomeFile} com o nome do arquivo, por exemplo ${nomeFile}=certificate.pem.`
  );
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

  openrouter: {
    apiKey: env.OPENROUTER_API_KEY ?? null,
    baseUrl: env.OPENROUTER_BASE_URL.replace(/\/+$/, ''),
    model: env.OPENROUTER_MODEL,
    essayModel: env.OPENROUTER_ESSAY_MODEL,
    monthlyTokenLimit: env.OPENROUTER_MONTHLY_TOKEN_LIMIT,
    enabled: Boolean(env.OPENROUTER_API_KEY),
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
