'use strict';

/**
 * Certificado do banco: como a configuração o recebe.
 *
 *   NODE_ENV=test node --test tests/config-db-ssl.test.js
 *
 * O PostgreSQL gerenciado da Square Cloud recusa conexão em texto puro e
 * entrega três arquivos: a autoridade (`ca-certificate.crt`), o certificado do
 * cliente junto com a chave (`certificate.pem`) e a chave sozinha
 * (`private-key.key`). Nada disso pode ser versionado — o repositório é
 * público —, então o material chega por variável de ambiente, em texto ou em
 * base64, ou por caminho de arquivo.
 *
 * Este teste cobre a leitura desse material. O PEM usado aqui é inventado: o
 * que está sob teste é de onde o conteúdo vem e como é decodificado, não a
 * validade criptográfica, que é o TLS do Node quem confere na conexão.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');

const PEM_FALSO = ['-----BEGIN CERTIFICATE-----', 'Zm9jbyBkZSBlbGl0ZSAtIHRlc3Rl', '-----END CERTIFICATE-----'].join('\n');
const base64De = (texto) => Buffer.from(texto, 'utf8').toString('base64');

describe('Certificado do banco na configuração', () => {
  let temp;

  before(() => {
    // Mesmo motivo do teste da porta: sem arquivo .env, como na hospedagem.
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'focoelite-ssl-'));
    fs.mkdirSync(path.join(temp, 'server'));
    fs.copyFileSync(path.join(raiz, 'server', 'config.js'), path.join(temp, 'server', 'config.js'));
    fs.copyFileSync(path.join(raiz, 'package.json'), path.join(temp, 'package.json'));
    fs.symlinkSync(path.join(raiz, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(temp, 'certificado-de-teste.pem'), `${PEM_FALSO}\n`);
  });

  after(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  /** Carrega a configuração num processo limpo. Devolve o resultado ou o erro. */
  function carrega(env) {
    try {
      const saida = execFileSync(
        process.execPath,
        [
          '-e',
          'const c = require("./server/config.js"); console.log(JSON.stringify({ cert: c.pgSslCert, ca: c.pgSslCa }))',
        ],
        {
          cwd: temp,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH,
            DATABASE_URL: 'postgres://usuario:senha@host:5432/focoelite',
            JWT_SECRET: 'a'.repeat(48),
            ADMIN_JWT_SECRET: 'b'.repeat(48),
            ...env,
          },
        }
      );
      return { ok: JSON.parse(saida.trim().split('\n').pop()) };
    } catch (err) {
      return { erro: String(err.stderr || err.message) };
    }
  }

  it('aceita o PEM em texto', () => {
    assert.equal(carrega({ PGSSL_CERT: PEM_FALSO }).ok.cert, PEM_FALSO);
  });

  it('aceita o PEM em base64, que é como ele cabe numa variável do painel', () => {
    const base64 = Buffer.from(PEM_FALSO, 'utf8').toString('base64');
    assert.equal(carrega({ PGSSL_CERT: base64 }).ok.cert, PEM_FALSO);
  });

  it('aceita o caminho de um arquivo, relativo à raiz do projeto', () => {
    assert.equal(carrega({ PGSSL_CERT_FILE: 'certificado-de-teste.pem' }).ok.cert, PEM_FALSO);
  });

  it('lê a autoridade separada do certificado do cliente', () => {
    // São dois arquivos distintos na Square Cloud, e a CA é o que permite
    // conferir o servidor de verdade em vez de usar o próprio certificado
    // do cliente como âncora.
    const { ok } = carrega({ PGSSL_CERT: PEM_FALSO, PGSSL_CA_FILE: 'certificado-de-teste.pem' });
    assert.equal(ok.ca, PEM_FALSO);
    assert.equal(ok.cert, PEM_FALSO);
  });

  it('fica sem certificado quando nada é informado', () => {
    const { ok } = carrega({});
    assert.equal(ok.cert, null);
    assert.equal(ok.ca, null);
  });

  it('recusa subir quando o arquivo apontado não existe', () => {
    // Falhar aqui, com o nome da variável na mensagem, é melhor do que subir e
    // quebrar na primeira consulta ao banco.
    const { erro } = carrega({ PGSSL_CERT_FILE: 'nao-existe.pem' });
    assert.match(erro, /PGSSL_CERT_FILE/);
    assert.match(erro, /não existe/);
  });

  it('recusa um valor que não é PEM, dizendo qual variável está errada', () => {
    const { erro } = carrega({ PGSSL_CA: 'isto-nao-e-um-certificado' });
    assert.match(erro, /PGSSL_CA/);
    assert.match(erro, /-----BEGIN/);
  });

  it('sobrevive ao que um campo de painel faz com texto colado', () => {
    // Aspas em volta, o "\n" escrito literalmente, quebras de linha viradas
    // espaço, base64 quebrado em várias linhas: nada disso é erro de quem
    // configurou, e todos chegam ao mesmo certificado.
    const variantes = {
      'entre aspas': `"${PEM_FALSO}"`,
      'com \\n literal': PEM_FALSO.replace(/\n/g, '\\n'),
      'base64 em várias linhas': `${base64De(PEM_FALSO).slice(0, 20)}\n${base64De(PEM_FALSO).slice(20)}`,
    };
    for (const [nome, valor] of Object.entries(variantes)) {
      const { ok, erro } = carrega({ PGSSL_CERT: valor });
      assert.ok(ok, `${nome} deveria ser aceito, mas deu: ${erro}`);
      assert.match(ok.cert, /-----BEGIN CERTIFICATE-----/, nome);
      assert.match(ok.cert, /-----END CERTIFICATE-----/, nome);
    }
  });

  it('recusa um certificado que chegou pela metade', () => {
    // Um valor cortado ao colar ainda mostra o -----BEGIN. Sem esta checagem
    // a aplicação subiria e só quebraria ao conectar no banco, com uma
    // mensagem do OpenSSL que não diz onde está o problema.
    const cortado = base64De(PEM_FALSO).slice(0, 30);
    const { erro } = carrega({ PGSSL_CERT: cortado });
    assert.match(erro, /PGSSL_CERT/);
    assert.match(erro, /cortado/);
    assert.match(erro, /-----END/);
  });
});
