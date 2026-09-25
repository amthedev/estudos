'use strict';

/**
 * Fábrica do Express.
 *
 *   const { createApp } = require('./app');
 *   const app = createApp();
 *
 * Ordem dos middlewares: segurança (helmet/CSP) → compressão → cookies → parsers de corpo
 * (raw para o webhook de pagamento, JSON para o resto) → log → rate limit e CSRF em /api →
 * rotas de API (auto-mount de server/routes/*.js e server/routes/admin/*.js) → estáticos →
 * páginas HTML → 404 → errorHandler.
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const config = require('./config');
const uploads = require('./services/uploads');
const { requireAdmin } = require('./middleware/auth');
const { apiLimiter } = require('./middleware/rateLimit');
const { AppError, notFound, errorHandler } = require('./middleware/errors');
const assets = require('./utils/assets');

const ROUTES_DIR = path.join(__dirname, 'routes');
const ADMIN_ROUTES_DIR = path.join(ROUTES_DIR, 'admin');
const WEBHOOK_PATH = '/api/billing/webhook';
// O envio de arquivos do painel chega como corpo bruto (sem multipart).
const UPLOAD_PATH = '/api/admin/uploads';
// Partes do envio em partes (videoaula acima dos 100 MB do Cloudflare).
const UPLOAD_PART = /^\/api\/admin\/uploads\/sessions\/[^/]+\/parts\/\d+$/;
const CSRF_HEADER_VALUE = 'FocoElite';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const PAGES = [
  { paths: ['/'], file: 'index.html' },
  { paths: ['/login'], file: 'login.html' },
  { paths: ['/cadastro'], file: 'cadastro.html' },
  { paths: ['/recuperar-senha'], file: 'recuperar-senha.html' },
  { paths: ['/redefinir-senha'], file: 'redefinir-senha.html' },
  { paths: ['/app', '/app/*'], file: 'app.html' },
  { paths: ['/admin/login'], file: 'admin-login.html' },
  { paths: ['/admin', '/admin/*'], file: 'admin.html' },
];

function buildCsp() {
  const directives = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'self'"],
    'form-action': ["'self'"],
    'script-src': ["'self'"],
    'script-src-attr': ["'none'"],
    // 'unsafe-inline' em estilos permite atributos style="" (barras de progresso, gráficos);
    // fontes carregadas via @import do Google Fonts em app.css/admin.css
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
    'img-src': ["'self'", 'https:', 'data:', 'blob:'],
    // vídeo e áudio vêm do armazenamento da plataforma (Blob da Square Cloud)
    // ou do próprio domínio quando o provedor configurado é o disco
    'media-src': ["'self'", 'https://public-blob.squarecloud.dev', 'https://*.squarecloud.dev', 'blob:'],
    'frame-src': [
      // mantidos para aulas antigas que ainda apontem para vídeo externo;
      // o cadastro novo é sempre por arquivo enviado ao painel
      'https://www.youtube.com',
      'https://www.youtube-nocookie.com',
      'https://player.vimeo.com',
    ],
    'connect-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
  };
  if (config.isProd) directives['upgrade-insecure-requests'] = [];
  return { useDefaults: false, directives };
}

/** Carrega os módulos de rota de um diretório; arquivos ausentes ou com erro são ignorados com log. */
function loadRouteModules(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();

  const modules = [];
  for (const name of entries) {
    const file = path.join(dir, name);
    const label = path.relative(config.rootDir, file);
    try {
      const mod = require(file);
      if (!mod || typeof mod.basePath !== 'string' || !mod.basePath.startsWith('/api') || typeof mod.router !== 'function') {
        throw new Error('o módulo deve exportar { basePath: "/api/...", router }');
      }
      modules.push({ name, file, label, basePath: mod.basePath, router: mod.router });
    } catch (err) {
      console.error(`[rotas] ignorando ${label}: ${err.message}`);
      if (!config.isProd && err.stack && !/Cannot find module/.test(err.message)) {
        console.error(err.stack.split('\n').slice(1, 4).join('\n'));
      }
    }
  }
  return modules;
}

function csrfGuard(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (req.originalUrl.split('?')[0] === WEBHOOK_PATH) return next();
  if (req.get('x-requested-with') !== CSRF_HEADER_VALUE) {
    return next(new AppError(403, 'forbidden', 'Requisição bloqueada: cabeçalho de proteção ausente.'));
  }
  next();
}

/**
 * Serve uma página, versionando os endereços de JS, CSS e imagens.
 *
 * O HTML sai sem cache; os estáticos ganham a marca da versão no caminho. É o
 * que faz uma publicação nova chegar a quem já visitou o site — sem isso, o
 * Cloudflare mantém o JavaScript antigo no navegador por 31 dias.
 */
function sendPage(file) {
  const absolute = path.join(config.publicDir, file);
  // O HTML versionado é montado uma vez por arquivo: reler e reescrever a cada
  // visita seria trabalho repetido para um resultado sempre igual.
  let pronto = null;
  return (req, res, next) => {
    try {
      if (pronto === null || config.isDev) {
        pronto = assets.versionHtml(fs.readFileSync(absolute, 'utf8'), config.publicDir);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.warn(`[páginas] arquivo ausente: public/${file}`);
        return next(new AppError(404, 'not_found', 'Página não encontrada.'));
      }
      return next(err);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(pronto);
  };
}

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', 'weak');
  app.locals.version = config.version;
  app.locals.brandName = config.brandName;

  // ---- segurança e utilitários ---------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: buildCsp(),
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      strictTransportSecurity: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
    })
  );
  app.use(compression());
  app.use(cookieParser());

  // ---- corpo da requisição ---------------------------------------------------
  // O webhook de pagamento precisa do corpo bruto para validar o evento.
  app.use(WEBHOOK_PATH, express.raw({ type: 'application/json', limit: '2mb' }));
  // POST de arquivo: o corpo NÃO é lido aqui. A rota consome a requisição em
  // fluxo e grava direto no disco, porque uma videoaula passa de 300 MB e
  // montar isso na memória derrubaria o servidor.
  app.use((req, res, next) => {
    const path = req.originalUrl.split('?')[0];
    if (path === WEBHOOK_PATH) return next();
    if (path === UPLOAD_PATH && req.method === 'POST') return next();
    // parte de envio em partes: corpo bruto, lido pela própria rota
    if (req.method === 'PUT' && UPLOAD_PART.test(path)) return next();
    express.json({ limit: '2mb' })(req, res, next);
  });

  if (config.isDev) {
    app.use(
      morgan('dev', {
        skip: (req) => /^\/(assets|vendor|css|js)\//.test(req.path),
      })
    );
  }

  // ---- API ---------------------------------------------------------------------
  app.use('/api', apiLimiter, csrfGuard);

  const publicRoutes = loadRouteModules(ROUTES_DIR);
  const adminRoutes = loadRouteModules(ADMIN_ROUTES_DIR);

  for (const mod of publicRoutes) app.use(mod.basePath, mod.router);

  // /api/admin/auth precisa ficar acessível sem sessão de admin (login);
  // todo o restante de /api/admin exige requireAdmin.
  const adminAuth = adminRoutes.find((mod) => mod.name === 'auth.js');
  if (adminAuth) app.use(adminAuth.basePath, adminAuth.router);
  app.use('/api/admin', requireAdmin);
  for (const mod of adminRoutes) {
    if (mod === adminAuth) continue;
    app.use(mod.basePath, mod.router);
  }

  if (!config.isTest) {
    const mounted = [...publicRoutes, ...adminRoutes].map((mod) => mod.basePath);
    console.log(`[rotas] ${mounted.length} módulo(s) montado(s): ${mounted.join(', ')}`);
  }

  app.use('/api', notFound);

  // ---- estáticos e páginas ------------------------------------------------------
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/assets/favicon.svg'));
  // Caminho versionado (/a/<marca>/js/…): a marca some da URL e o arquivo é
  // servido normalmente. Como o endereço muda a cada publicação, aqui o cache
  // longo do Cloudflare é aliado, não problema — o conteúdo daquele endereço
  // nunca muda.
  app.use((req, res, next) => {
    const separado = assets.splitVersioned(req.url.split('?')[0]);
    if (!separado) return next();
    req.url = separado.rest + (req.url.includes('?') ? `?${req.url.split('?').slice(1).join('?')}` : '');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    next();
  });

  app.use(
    express.static(config.publicDir, {
      index: false,
      dotfiles: 'ignore',
      maxAge: config.isProd ? '5m' : 0,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      },
    })
  );

  // arquivos enviados pelo painel (logos, prints, editais em PDF)
  app.use(
    '/uploads',
    express.static(uploads.UPLOADS_DIR, {
      index: false,
      dotfiles: 'deny',
      maxAge: config.isProd ? '30d' : 0,
      setHeaders: (res) => {
        // nada aqui é executável: o navegador não deve tentar adivinhar o tipo
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    })
  );

  for (const page of PAGES) app.get(page.paths, sendPage(page.file));

  // ---- erros ------------------------------------------------------------------------
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, loadRouteModules, CSRF_HEADER_VALUE, WEBHOOK_PATH };
