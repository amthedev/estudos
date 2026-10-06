'use strict';

/**
 * Lê uma prova em PDF com o leitor do servidor e escreve o resultado para
 * conferência a olho.
 *
 *   node scripts/ler-prova.js prova.pdf --out saida/ [--tipo enem|vunesp|auto]
 *
 * Escreve em <saida>/:
 *   questoes.md     cada questão: número, variante, alertas, enunciado e alternativas,
 *                   com as figuras no lugar (![](figuras/q12-1.png))
 *   questoes.json   o mesmo, como o leitor devolve (cada figura com o nome do arquivo
 *                   no lugar do PNG)
 *   figuras/        o recorte de cada figura: q<numero>[-<variante>]-<n>.png
 *   descartado.md   tudo o que foi jogado fora (cabeçalho, rodapé, capa, redação,
 *                   títulos de seção...), página a página — para auditoria
 *
 * O gabarito que vier no fim do próprio PDF (VUNESP, FGV) sai em questoes.json
 * (`answer_key`) e no resumo do terminal.
 *
 * Não grava nada no banco nem no armazenamento.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readExam } = require('../server/services/exam-reader');

const VARIANTE = { ingles: 'Inglês', espanhol: 'Espanhol' };

function parseArgs(argv) {
  const args = { pdf: null, out: null, tipo: 'auto' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[(i += 1)];
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a === '--tipo') args.tipo = argv[(i += 1)];
    else if (a.startsWith('--tipo=')) args.tipo = a.slice(7);
    else if (!args.pdf) args.pdf = a;
  }
  return args;
}

/** Nome do arquivo da figura `i` da questão: q12-1.png, q3-espanhol-2.png. */
function nomeFigura(q, i) {
  return `q${q.number}${q.variant ? `-${q.variant}` : ''}-${i + 1}.png`;
}

/** Troca o marcador `figura:N` pelo caminho do arquivo da figura. */
function comFiguras(md, q) {
  return String(md || '').replace(/\]\(figura:(\d+)\)/g, (m, n) => (q.figures[Number(n)] ? `](figuras/${nomeFigura(q, Number(n))})` : m));
}

function questoesMarkdown(nome, resultado) {
  const linhas = [`# ${nome}`, '', `${resultado.questions.length} questões lidas (${resultado.kind}), ${resultado.pages} páginas.`, ''];
  for (const q of resultado.questions) {
    const variante = q.variant ? ` (${VARIANTE[q.variant] || q.variant})` : '';
    linhas.push(`## Questão ${q.number}${variante}`, '');
    linhas.push(`- Páginas: ${q.source_pages.join(', ')}`);
    linhas.push(`- Alertas: ${q.alerts.length ? q.alerts.join(', ') : 'nenhum'}`);
    if (q.figures.length) {
      const r = Math.round;
      linhas.push(`- Figuras: ${q.figures.map((f, i) => `${nomeFigura(q, i)} p${f.page} ${f.slot} ${f.kind} [${r(f.crop.x)},${r(f.crop.y)} ${r(f.crop.w)}×${r(f.crop.h)}]${f.uncertain ? ` (incerta: ${f.uncertain.join(', ')})` : ''}`).join('; ')}`);
    }
    linhas.push('', comFiguras(q.statement_md, q) || '_(enunciado vazio)_', '');
    for (const a of q.alternatives) linhas.push(`- **${a.letter})** ${comFiguras(a.text_md, q) || '_(vazia)_'}`);
    linhas.push('', '---', '');
  }
  return linhas.join('\n');
}

/** Grava os PNGs em <saida>/figuras (apaga os da leitura anterior). */
function gravarFiguras(pasta, resultado) {
  const dir = path.join(pasta, 'figuras');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^q\d+.*\.png$/.test(f)) fs.unlinkSync(path.join(dir, f));
  let n = 0;
  for (const q of resultado.questions) {
    q.figures.forEach((f, i) => {
      if (!f.png) return;
      fs.writeFileSync(path.join(dir, nomeFigura(q, i)), f.png);
      n += 1;
    });
  }
  return n;
}

function descartadoMarkdown(nome, resultado) {
  const linhas = [`# ${nome} — descartado`, ''];
  const porPagina = new Map();
  for (const d of resultado.discarded) {
    if (!porPagina.has(d.page)) porPagina.set(d.page, []);
    porPagina.get(d.page).push(d);
  }
  for (const pagina of [...porPagina.keys()].sort((a, b) => a - b)) {
    linhas.push(`## Página ${pagina}`, '');
    const itens = porPagina.get(pagina);
    // texto solto de borda vem item a item: junta por tipo
    const agrupado = [];
    for (const d of itens) {
      const ultimo = agrupado[agrupado.length - 1];
      if (ultimo && ultimo.kind === d.kind && ['cabecalho', 'rodape', 'codigo_barras', 'margem'].includes(d.kind)) {
        ultimo.text += ` | ${d.text}`;
      } else {
        agrupado.push({ ...d });
      }
    }
    for (const d of agrupado) {
      const texto = String(d.text).replace(/\s+\n/g, '\n').trim();
      linhas.push(`- **${d.kind}**: ${texto.length > 400 ? `${texto.slice(0, 400)}…` : texto}`.replace(/\n/g, '\n  '));
    }
    linhas.push('');
  }
  return linhas.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pdf || !args.out) {
    console.error('Uso: node scripts/ler-prova.js <prova.pdf> --out <pasta> [--tipo enem|vunesp|auto]');
    process.exit(2);
  }
  const buffer = fs.readFileSync(args.pdf);
  const inicio = Date.now();
  const resultado = await readExam(buffer, { examKind: args.tipo });
  const ms = Date.now() - inicio;
  fs.mkdirSync(args.out, { recursive: true });
  const nome = path.basename(args.pdf);
  const nFiguras = gravarFiguras(args.out, resultado);
  fs.writeFileSync(path.join(args.out, 'questoes.md'), questoesMarkdown(nome, resultado));
  const json = {
    ...resultado,
    questions: resultado.questions.map((q) => ({
      ...q,
      figures: q.figures.map(({ png, ...f }, i) => ({ ...f, file: png ? `figuras/${nomeFigura(q, i)}` : null })),
    })),
  };
  fs.writeFileSync(path.join(args.out, 'questoes.json'), JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(args.out, 'descartado.md'), descartadoMarkdown(nome, resultado));

  const alertas = {};
  for (const q of resultado.questions) for (const a of q.alerts) alertas[a] = (alertas[a] || 0) + 1;
  const comAlerta = resultado.questions.filter((q) => q.alerts.length).length;
  const comFigura = resultado.questions.filter((q) => q.figures.length).length;
  const altFigura = resultado.questions.filter((q) => q.figures.some((f) => /^[A-E]$/.test(f.slot))).length;
  console.log(`${nome}: ${resultado.questions.length} questões (${resultado.kind}), ${comAlerta} com alerta, ${ms} ms, ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
  console.log(`  figuras: ${nFiguras} recortes, ${comFigura} questões com figura, ${altFigura} com alternativas em figura`);
  if (Object.keys(alertas).length) console.log(`  alertas: ${Object.entries(alertas).map(([k, n]) => `${k}=${n}`).join(' ')}`);
  if (resultado.answer_key) {
    const k = resultado.answer_key;
    console.log(`  gabarito no próprio PDF: ${k.count} respostas${k.tipo ? ` (tipo ${k.tipo})` : ''}${k.sharedLanguages ? ', uma letra para as duas línguas' : ''}`);
  }
  console.log(`  saída em ${path.resolve(args.out)}`);
}

main().catch((err) => {
  console.error(err && err.code ? `${err.code}: ${err.message}` : err);
  process.exit(1);
});
