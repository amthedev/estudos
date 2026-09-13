'use strict';

/**
 * Marca de versão dos arquivos de interface (JS, CSS, ícones e bibliotecas).
 *
 *   const assets = require('./utils/assets');
 *   assets.stamp();                    // 'a1b2c3d4'
 *   assets.versionHtml(html);          // troca /js/… por /a/a1b2c3d4/js/…
 *
 * Existe por um motivo concreto: a plataforma roda atrás do Cloudflare, que
 * reescreve o cabeçalho de cache dos estáticos para 31 DIAS no navegador,
 * independentemente do que o servidor mandou (a aplicação pede 5 minutos).
 * O resultado é que quem já tinha aberto o site continuava com o JavaScript
 * antigo por um mês — publicar uma correção não chegava a ninguém, e a saída
 * virava pedir para cada pessoa limpar o cache.
 *
 * A solução não depende de configurar o Cloudflare (a conta é da hospedagem):
 * o endereço dos arquivos passa a carregar uma marca que muda quando eles
 * mudam. Endereço novo é arquivo novo, e o cache de 31 dias deixa de importar.
 *
 * Por que um PREFIXO de caminho e não `?v=`: módulos ES importam uns aos
 * outros por caminho relativo. `/a/<marca>/js/app/shell.js` que importa
 * `../core/api.js` resolve para `/a/<marca>/js/core/api.js` sozinho — a marca
 * se propaga por toda a árvore. Com `?v=` só o primeiro arquivo seria
 * versionado, e todos os outros continuariam vindo do cache.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Prefixo dos endereços versionados. Curto de propósito: aparece em toda URL. */
const PREFIX = '/a';
/** Pastas cujo conteúdo define a marca e que passam a ser servidas versionadas. */
const VERSIONED = ['js', 'css', 'vendor', 'assets'];

let cache = null;

/**
 * Percorre a pasta somando o nome e o CONTEÚDO de cada arquivo.
 *
 * Conteúdo, e não data de modificação: publicar de novo copia os arquivos e
 * renova a data mesmo quando nada mudou. Com a data, toda publicação jogaria
 * fora o cache de todos os visitantes sem motivo. Com o conteúdo, o endereço
 * só muda quando o arquivo realmente mudou.
 *
 * A leitura acontece uma vez, no boot, sobre alguns megabytes — custa
 * milissegundos e poupa megabytes de download repetido a cada publicação.
 */
function collect(dir, hash) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, hash);
      continue;
    }
    try {
      hash.update(entry.name);
      hash.update(fs.readFileSync(full));
    } catch {
      // arquivo sumiu no meio da varredura: ignorar é melhor que derrubar o boot
    }
  }
}

/**
 * A marca desta versão dos arquivos de interface.
 * Calculada uma vez, no primeiro uso — em produção os arquivos não mudam com o
 * processo no ar, e recalcular a cada página seria varrer o disco à toa.
 */
function stamp(publicDir) {
  if (cache) return cache;
  const hash = crypto.createHash('sha1');
  for (const pasta of VERSIONED) collect(path.join(publicDir, pasta), hash);
  cache = hash.digest('hex').slice(0, 10);
  return cache;
}

/** Esquece a marca calculada (usado nos testes e no desenvolvimento). */
function reset() {
  cache = null;
}

/** O caminho versionado de um endereço interno: `/js/x.js` → `/a/<marca>/js/x.js`. */
function versioned(url, publicDir) {
  const alvo = String(url || '');
  const pasta = alvo.split('/')[1];
  if (!VERSIONED.includes(pasta)) return alvo;
  return `${PREFIX}/${stamp(publicDir)}${alvo}`;
}

/**
 * Reescreve os endereços dos estáticos dentro de um HTML.
 * Só mexe no que aparece entre aspas depois de src=, href= ou url( — não sai
 * trocando texto solto que por acaso pareça um caminho.
 */
function versionHtml(html, publicDir) {
  const marca = stamp(publicDir);
  const pastas = VERSIONED.join('|');
  const padrao = new RegExp(`((?:src|href)=["']|url\\(["']?)/(${pastas})/`, 'gi');
  const versionado = String(html).replace(padrao, (_, antes, pasta) => `${antes}${PREFIX}/${marca}/${pasta}/`);

  // A marca também vai como meta para o JavaScript alcançá-la — o sprite de
  // ícones é montado em código, não no HTML. Vai como meta, e não como script
  // embutido, porque a política de segurança da página proíbe script inline.
  return versionado.replace(/<\/head>/i, `  <meta name="fe-assets" content="${marca}">\n</head>`);
}

/**
 * Extrai a marca do começo do caminho, quando houver.
 * @returns {{ stamp: string, rest: string }|null}
 */
function splitVersioned(urlPath) {
  const match = String(urlPath || '').match(/^\/a\/([0-9a-f]{6,40})(\/.*)$/i);
  return match ? { stamp: match[1], rest: match[2] } : null;
}

module.exports = { PREFIX, VERSIONED, stamp, reset, versioned, versionHtml, splitVersioned };
