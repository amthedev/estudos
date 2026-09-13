'use strict';

/**
 * Conferência de configuração.
 *
 *   npm run check
 *
 * Diz, em português, o que já está configurado e o que falta para a plataforma
 * funcionar por inteiro. Serve tanto na máquina de desenvolvimento quanto no
 * servidor, depois de publicar: rode e leia de cima para baixo.
 *
 * Nada de segredo é exibido — só se a chave existe e os quatro últimos
 * caracteres, para conferir se é a chave certa.
 */
// A própria configuração recusa carregar quando algo essencial está errado
// (segredo fraco, banco ausente). Quem roda esta conferência é justamente quem
// está configurando, então o erro precisa sair legível, não como rastro de pilha.
let config;
let erroDeConfig = null;
try {
  config = require('../server/config');
} catch (err) {
  erroDeConfig = err;
}

const RESET = '[0m';
const paint = (code, text) => (process.stdout.isTTY ? `[${code}m${text}${RESET}` : text);
const verde = (t) => paint('32', t);
const vermelho = (t) => paint('31', t);
const amarelo = (t) => paint('33', t);
const cinza = (t) => paint('90', t);
const forte = (t) => paint('1', t);

const OK = verde('  ok  ');
const FALTA = vermelho(' falta');
const AVISO = amarelo(' aviso');

const linhas = [];
let bloqueios = 0;
let avisos = 0;

function item(status, titulo, detalhe) {
  if (status === FALTA) bloqueios += 1;
  if (status === AVISO) avisos += 1;
  linhas.push(`  ${status}  ${titulo}${detalhe ? cinza(` — ${detalhe}`) : ''}`);
}

function secao(titulo) {
  linhas.push('');
  linhas.push(forte(titulo));
}

function mascarar(valor) {
  const texto = String(valor || '').trim();
  if (!texto) return null;
  return `••••${texto.slice(-4)}`;
}

function formatarBytes(valor) {
  const bytes = Number(valor) || 0;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function env(nome) {
  const valor = String(process.env[nome] || '').trim();
  if (!valor || valor.toLowerCase().includes('troque')) return null;
  return valor;
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'sim', 'yes', 'on'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function findPendingMigrations(files, appliedNames) {
  const applied = new Set(appliedNames || []);
  return (files || []).filter((file) => !applied.has(file));
}

async function main() {
  console.log('');
  console.log(forte('Foco de Elite — conferência de configuração'));

  if (erroDeConfig) {
    console.log('');
    console.log(vermelho(forte('A configuração não pôde ser carregada:')));
    console.log(`  ${erroDeConfig.message}`);
    console.log('');
    console.log(cinza('Corrija o arquivo .env (ou as variáveis do painel de hospedagem) e rode de novo.'));
    console.log('');
    process.exit(1);
  }

  const db = require('../server/db/pool');
  const { listMigrationFiles } = require('../server/db/migrate');
  console.log(cinza(`ambiente: ${config.env} · versão ${config.version}`));

  // -------------------------------------------------------------- essencial
  secao('Essencial (sem isto a plataforma não sobe)');

  let bancoOk = false;
  try {
    const inicio = Date.now();
    await db.query('SELECT 1');
    bancoOk = true;
    item(OK, 'Banco de dados', `respondeu em ${Date.now() - inicio}ms`);
  } catch (err) {
    item(FALTA, 'Banco de dados', err.message);
  }

  if (bancoOk) {
    try {
      const pendentes = await db.one(
        `SELECT count(*)::int AS total FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
      );
      if (!pendentes.total) {
        item(FALTA, 'Migrations', 'rode: npm run migrate');
      } else {
        const aplicadas = await db.many('SELECT name FROM schema_migrations ORDER BY name');
        const faltantes = findPendingMigrations(
          listMigrationFiles(),
          aplicadas.map((migration) => migration.name)
        );
        const tabelas = await db.one(
          `SELECT count(*)::int AS total FROM information_schema.tables WHERE table_schema = 'public'`
        );
        if (faltantes.length) {
          item(FALTA, 'Migrations', `${faltantes.length} pendente(s): ${faltantes.join(', ')} — rode: npm run migrate`);
        } else {
          item(OK, 'Migrations', `${aplicadas.length} aplicada(s), ${tabelas.total} tabelas`);
        }
      }

      const conteudo = await db.one(
        `SELECT (SELECT count(*) FROM exams)::int AS provas,
                (SELECT count(*) FROM subjects)::int AS materias,
                (SELECT count(*) FROM topics)::int AS assuntos`
      );
      if (!conteudo.provas) item(FALTA, 'Conteúdo base', 'rode: npm run seed');
      else item(OK, 'Conteúdo base', `${conteudo.provas} provas, ${conteudo.materias} matérias, ${conteudo.assuntos} assuntos`);

      const admin = await db.one(`SELECT count(*)::int AS total FROM users WHERE role = 'admin'`);
      // Zero administradores não impede a publicação: é o estado normal de um
      // banco novo, e a conta se cria na própria tela de login.
      if (!admin.total) item(AVISO, 'Administrador', 'nenhum ainda — abra /admin/login para criar o primeiro');
      else item(OK, 'Administrador', `${admin.total} cadastrado(s)`);

      const aulas = await db.one(`SELECT count(*)::int AS total FROM lessons WHERE active`);
      const questoes = await db.one(`SELECT count(*)::int AS total FROM questions WHERE active`);
      if (!aulas.total) item(AVISO, 'Aulas', 'nenhuma cadastrada — a equipe cadastra pelo painel');
      else item(OK, 'Aulas', `${aulas.total} ativa(s), ${questoes.total} questão(ões)`);
    } catch (err) {
      item(FALTA, 'Leitura do banco', err.message);
    }
  }

  const segredosFracos = [config.jwtSecret, config.adminJwtSecret].filter(
    (valor) => !valor || String(valor).length < 32 || String(valor).includes('troque')
  );
  if (segredosFracos.length) item(FALTA, 'Segredos de sessão', 'gere com: openssl rand -hex 48');
  else item(OK, 'Segredos de sessão', 'definidos e longos o bastante');

  if (config.isProd && !config.cookieSecure) {
    item(FALTA, 'COOKIE_SECURE', 'em produção precisa ser true, senão a sessão viaja sem HTTPS');
  }

  // ---------------------------------------------------------- armazenamento
  secao('Armazenamento de arquivos (videoaulas, imagens e PDFs)');
  try {
    const uploads = require('../server/services/uploads');
    const situacao = await uploads.status();
    if (situacao.provider === 'squarecloud' && situacao.configured) {
      const consumo = situacao.usage;
      item(
        OK,
        'Square Cloud Blob',
        consumo
          ? `chave ${situacao.key_masked} · ${consumo.objects} arquivo(s), ${formatarBytes(consumo.used_bytes)}` +
            (consumo.included_bytes ? ` de ${formatarBytes(consumo.included_bytes)} (${consumo.used_pct}%)` : '')
          : `chave ${situacao.key_masked}`
      );
    } else if (situacao.provider === 'squarecloud') {
      item(FALTA, 'Square Cloud Blob', 'defina SQUARECLOUD_API_KEY');
    } else if (config.isProd) {
      item(AVISO, 'Disco do servidor', 'em produção prefira o Blob: publicar versão nova pode apagar os arquivos');
    } else {
      item(OK, 'Disco do servidor', 'suficiente para desenvolvimento');
    }
  } catch (err) {
    item(FALTA, 'Armazenamento', err.message);
  }

  // --------------------------------------------------------------------- IA
  secao('Inteligência artificial (Tutor IA e correção de redação)');
  if (env('OPENROUTER_API_KEY')) {
    item(OK, 'OpenRouter', `chave ${mascarar(process.env.OPENROUTER_API_KEY)} · tutor com ${config.openrouter.model}`);
  } else {
    item(AVISO, 'OpenRouter', 'sem a chave, o Tutor IA e a correção de redação ficam desligados');
  }

  // -------------------------------------------------------------- pagamento
  secao('Cobrança das assinaturas');
  const provedor = env('PAYMENT_PROVIDER') || 'asaas';
  let exigeAssinatura = config.requireSubscription;
  if (bancoOk) {
    try {
      const salvo = await db.one(`SELECT value FROM settings WHERE key = 'require_subscription'`);
      if (salvo) exigeAssinatura = toBool(salvo.value);
    } catch (err) {
      item(FALTA, 'Configuração da assinatura', `não foi possível ler o banco: ${err.message}`);
    }
  }
  if (env('ASAAS_API_KEY')) {
    const ambiente = env('ASAAS_ENV') === 'sandbox' ? 'sandbox (teste)' : 'produção';
    item(OK, 'Asaas', `chave ${mascarar(process.env.ASAAS_API_KEY)} · ${ambiente}`);
    if (!env('ASAAS_WEBHOOK_TOKEN')) {
      item(AVISO, 'Webhook do Asaas', 'sem ASAAS_WEBHOOK_TOKEN a confirmação de pagamento não é validada');
    } else {
      item(OK, 'Webhook do Asaas', `aponte para ${config.appUrl}/api/billing/webhook`);
    }
  } else {
    item(
      exigeAssinatura ? FALTA : AVISO,
      'Nenhum meio de cobrança',
      exigeAssinatura
        ? 'a assinatura está obrigatória: nenhum aluno novo conseguirá acessar sem pagamento ou liberação manual'
        : `assinatura desligada, todo aluno tem acesso (provedor: ${provedor})`
    );
  }

  // ------------------------------------------------------------------ email
  secao('E-mail (recuperação de senha e avisos)');
  if (env('SMTP_HOST') && env('SMTP_USER')) {
    item(OK, 'SMTP', `${process.env.SMTP_HOST} como ${process.env.SMTP_USER}`);
  } else {
    item(
      config.isProd ? FALTA : AVISO,
      'SMTP',
      config.isProd
        ? 'em produção o aluno não consegue recuperar a senha sem isto'
        : 'em desenvolvimento o link de recuperação aparece no console'
    );
  }

  // -------------------------------------------------------------- endereço
  secao('Endereço público');
  if (config.isProd && !/^https:\/\//.test(config.appUrl)) {
    item(FALTA, 'APP_URL', `está "${config.appUrl}" — em produção precisa ser o endereço https do site`);
  } else {
    item(OK, 'APP_URL', config.appUrl);
  }

  // A porta errada na Square Cloud não gera erro nenhum: a aplicação sobe, o
  // log fica limpo e o endereço dá timeout. Como isso não aparece em log,
  // aparece aqui.
  const naSquareCloud = Boolean(process.env.SQUARECLOUD_APP_ID);
  if (naSquareCloud && config.port !== 80) {
    item(FALTA, 'Porta', `está ${config.port}; a Square Cloud só roteia para a 80 — o site daria timeout sem erro no log`);
  } else if (naSquareCloud) {
    item(OK, 'Porta', `${config.host}:${config.port}`);
  } else {
    item(OK, 'Porta', `${config.host}:${config.port} (fora da Square Cloud)`);
  }

  // -------------------------------------------------------------- resultado
  console.log(linhas.join('\n'));
  console.log('');
  if (bloqueios) {
    console.log(vermelho(forte(`${bloqueios} item(ns) impedem o funcionamento completo.`)));
    console.log(cinza('Corrija os marcados como "falta" e rode npm run check de novo.'));
  } else if (avisos) {
    console.log(amarelo(forte(`Tudo essencial configurado. ${avisos} item(ns) opcional(is) desligado(s).`)));
  } else {
    console.log(verde(forte('Tudo configurado.')));
  }
  console.log('');

  await db.closePool().catch(() => {});
  process.exit(bloqueios ? 1 : 0);
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(vermelho(`\nNão foi possível conferir: ${err.message}\n`));
    try {
      await require('../server/db/pool').closePool();
    } catch {
      // o pool pode nem ter sido aberto
    }
    process.exit(1);
  });
}

module.exports = { main, findPendingMigrations, toBool };
