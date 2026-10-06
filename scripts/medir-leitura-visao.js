'use strict';

/**
 * Mede quanto custa ler questões de prova pela imagem (IA de visão) ANTES de
 * ligar "Ler com IA de visão as questões com alerta" no painel.
 *
 *   node scripts/medir-leitura-visao.js prova.pdf                 até 5 questões com alerta
 *   node scripts/medir-leitura-visao.js prova.pdf --questoes 10   até 10 questões com alerta
 *   node scripts/medir-leitura-visao.js prova.pdf --paginas 2     todas as questões das 2 primeiras
 *                                                                 páginas com questão (com ou sem alerta)
 *   node scripts/medir-leitura-visao.js prova.pdf --modelo qwen/qwen2.5-vl-72b-instruct
 *   node scripts/medir-leitura-visao.js prova.pdf --saida pasta/  grava a imagem e a transcrição de cada uma
 *
 * Precisa de OPENROUTER_API_KEY no .env (sem ela, explica o que fazer e sai
 * sem chamar nada). Usa o mesmo caminho da leitura de verdade
 * (services/exam-vision.js): a mesma imagem da região, o mesmo prompt, a
 * mesma validação. Imprime, por questão, os tokens de entrada e saída, o tempo
 * e o que voltou; no fim, o preço do modelo (catálogo do OpenRouter) e o custo
 * estimado por prova.
 *
 * Com --paginas, as questões não têm alerta: o texto que a leitura sem IA já
 * tinha serve de comparação, e o script mostra o quanto a transcrição bate
 * com ele — é a medida de qualidade do modelo.
 *
 * Modelo: --modelo, ou o configurado no painel (openrouter_vision_model →
 * openrouter_extract_model → openrouter_model). OPENROUTER_MOCK=1 roda com o
 * cliente de simulação (sem rede, sem custo, sem preço) — só para conferir o
 * script.
 */
const fs = require('node:fs');
const path = require('node:path');

const MODELOS_URL = 'https://openrouter.ai/api/v1/models';

function parseArgs(argv) {
  const args = { pdf: null, questoes: 5, paginas: 0, modelo: null, saida: null, tipo: 'auto' };
  const valor = (i, a, nome) => (a.includes('=') ? a.slice(nome.length + 3) : argv[i + 1]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const pula = a.includes('=') ? 0 : 1;
    if (a.startsWith('--questoes')) {
      args.questoes = Number.parseInt(valor(i, a, 'questoes'), 10);
      i += pula;
    } else if (a.startsWith('--paginas')) {
      args.paginas = Number.parseInt(valor(i, a, 'paginas'), 10);
      i += pula;
    } else if (a.startsWith('--modelo')) {
      args.modelo = valor(i, a, 'modelo');
      i += pula;
    } else if (a.startsWith('--saida')) {
      args.saida = valor(i, a, 'saida');
      i += pula;
    } else if (a.startsWith('--tipo')) {
      args.tipo = valor(i, a, 'tipo');
      i += pula;
    } else if (!args.pdf) {
      args.pdf = a;
    }
  }
  return args;
}

const USO =
  'Uso: node scripts/medir-leitura-visao.js <prova.pdf> [--questoes 5 | --paginas 2] [--modelo provedor/modelo] [--saida pasta]';

function explicarChave() {
  console.log(
    [
      'Para medir, o script precisa falar com o OpenRouter de verdade — e o .env não tem OPENROUTER_API_KEY.',
      '',
      '  1. Pegue a chave: a mesma que está nas variáveis da hospedagem, ou crie uma em https://openrouter.ai/keys',
      '  2. Coloque no .env da raiz do projeto:  OPENROUTER_API_KEY=sk-or-...',
      '  3. (opcional) Escolha um modelo que lê imagem: --modelo provedor/modelo, ou "Modelo de visão" no painel',
      `  4. Rode de novo: ${USO.replace('Uso: ', '')}`,
      '',
      'Nada foi chamado e nada foi gasto.',
    ].join('\n')
  );
}

/** Preço e entradas do modelo no catálogo público do OpenRouter (null se não achar). */
async function precoDoModelo(ids) {
  const resposta = await fetch(MODELOS_URL, { headers: { accept: 'application/json' } });
  if (!resposta.ok) throw new Error(`o catálogo do OpenRouter respondeu HTTP ${resposta.status}`);
  const lista = ((await resposta.json()) || {}).data || [];
  for (const id of ids.filter(Boolean)) {
    const limpo = String(id).replace(/\s*\(simulação\)$/, '');
    // o modelo que respondeu pode vir com a versão no fim (provedor/modelo-20250101)
    const modelo =
      lista.find((m) => m.id === limpo) ||
      lista.filter((m) => limpo.startsWith(`${m.id}-`)).sort((a, b) => b.id.length - a.id.length)[0];
    if (modelo) {
      const p = modelo.pricing || {};
      const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      return {
        id: modelo.id,
        entrada: n(p.prompt),
        saida: n(p.completion),
        imagem: n(p.image),
        chamada: n(p.request),
        modalidades: (modelo.architecture && modelo.architecture.input_modalities) || [],
      };
    }
  }
  return null;
}

/** Palavras de um texto, sem markdown, para comparar transcrições. */
function palavras(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\\(.)/g, '$1')
    .replace(/[*_#>]/g, ' ')
    .toLowerCase()
    .normalize('NFC')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

/** Quanto duas transcrições batem (palavras em comum / palavras da maior), de 0 a 1. */
function semelhanca(a, b) {
  const pa = palavras(a);
  const pb = palavras(b);
  if (!pa.length && !pb.length) return 1;
  const conta = new Map();
  for (const p of pa) conta.set(p, (conta.get(p) || 0) + 1);
  let comuns = 0;
  for (const p of pb) {
    const n = conta.get(p) || 0;
    if (n > 0) {
      comuns += 1;
      conta.set(p, n - 1);
    }
  }
  return comuns / Math.max(pa.length, pb.length);
}

const textoDaQuestao = (q) => [q.statement_md, ...q.alternatives.map((a) => `${a.letter}) ${a.text_md}`)].join('\n');
const usd = (v) => `US$ ${v < 0.01 ? v.toFixed(5) : v.toFixed(4)}`;
const resumo = (texto, max = 500) => {
  const s = String(texto || '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pdf) {
    console.error(USO);
    process.exitCode = 2;
    return;
  }
  // eslint-disable-next-line global-require
  const config = require('../server/config');
  const simulacao = process.env.OPENROUTER_MOCK === '1';
  if (!config.openrouter.apiKey && !simulacao) {
    explicarChave();
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(args.pdf)) {
    console.error(`Arquivo não encontrado: ${args.pdf}`);
    process.exitCode = 2;
    return;
  }

  /* eslint-disable global-require */
  const { readExam } = require('../server/services/exam-reader');
  const visao = require('../server/services/exam-vision');
  const db = require('../server/db/pool');
  /* eslint-enable global-require */

  try {
    const { model: configurado } = await visao.configuracao();
    const modelo = args.modelo || configurado;
    const nome = path.basename(args.pdf);

    // Que questões medir: as com alerta (o que a leitura de verdade mandaria),
    // ou todas as das N primeiras páginas com questão.
    const paginas = new Set();
    const porPagina = (q) => {
      const p = q.source_pages[0];
      if (paginas.has(p)) return true;
      if (paginas.size >= args.paginas) return false;
      paginas.add(p);
      return true;
    };
    const escolher = args.paginas > 0 ? porPagina : visao.precisaDeVisao;
    const inicio = Date.now();
    const prova = await readExam(fs.readFileSync(args.pdf), { examKind: args.tipo, figures: false, regions: escolher });
    const comAlerta = prova.questions.filter(visao.precisaDeVisao);
    let alvo = prova.questions.filter((q) => q.region_png);
    if (args.paginas <= 0) alvo = alvo.slice(0, Math.max(1, args.questoes || 5));
    console.log(
      `${nome}: ${prova.questions.length} questões lidas em ${Date.now() - inicio} ms; ` +
        `${comAlerta.length} com alerta de texto ilegível ou de alternativa faltando.`
    );
    if (!alvo.length) {
      console.log(
        'Nenhuma questão desta prova precisa da leitura pela imagem: com a visão ligada, ela não gastaria nada.\n' +
          'Para medir o custo por questão mesmo assim, rode com --paginas 2.'
      );
      return;
    }
    console.log(
      `Modelo: ${modelo || '(padrão do servidor)'}${simulacao ? ' — SIMULAÇÃO (OPENROUTER_MOCK=1): tokens estimados, sem custo real' : ''}`
    );
    console.log(
      args.paginas > 0
        ? `Medindo ${alvo.length} questões das páginas ${[...paginas].join(', ')} (com ou sem alerta).\n`
        : `Medindo ${alvo.length} das ${comAlerta.length} questões com alerta.\n`
    );
    if (args.saida) fs.mkdirSync(args.saida, { recursive: true });

    const medidas = [];
    for (const q of alvo) {
      const nomeQ = `q${q.number}${q.variant ? `-${q.variant}` : ''}`;
      if (args.saida) fs.writeFileSync(path.join(args.saida, `${nomeQ}.png`), q.region_png);
      const antes = textoDaQuestao(q);
      const imagemKb = Math.round(q.region_png.length / 1024);
      // eslint-disable-next-line no-await-in-loop
      const r = await visao.transcrever(q, { model: modelo });
      const uso = r.usage || { prompt_tokens: 0, completion_tokens: 0 };
      medidas.push({ q, r, uso });
      const cabecalho =
        `Questão ${q.number}${q.variant ? ` (${q.variant})` : ''} — alertas: ${q.alerts.join(', ') || 'nenhum'} — ` +
        `imagem ${imagemKb} KB — ${uso.prompt_tokens} tokens de entrada, ${uso.completion_tokens} de saída` +
        `${r.latency_ms ? `, ${(r.latency_ms / 1000).toFixed(1)} s` : ''}`;
      console.log(cabecalho);
      if (!r.ok) {
        console.log(`  RECUSADA: ${r.motivo}${r.servico ? ' (a IA não respondeu)' : ''}`);
        if (r.data) console.log(`  resposta: ${resumo(JSON.stringify(r.data), 300)}`);
      } else {
        visao.aplicar(q, r.transcricao, { model: r.model });
        const depois = textoDaQuestao(q);
        if (args.paginas > 0) console.log(`  bate com a leitura sem IA: ${Math.round(semelhanca(antes, depois) * 100)}%`);
        console.log(`  alertas depois: ${q.alerts.join(', ') || 'nenhum'}`);
        console.log(`  ${resumo(q.statement_md).replace(/\n/g, '\n  ')}`);
        for (const a of q.alternatives) console.log(`  ${a.letter}) ${resumo(a.text_md, 160)}`);
        if (args.saida) fs.writeFileSync(path.join(args.saida, `${nomeQ}.md`), `${depois}\n\n---\nAntes (leitura sem IA):\n\n${antes}\n`);
      }
      console.log('');
    }

    // Custo
    const n = medidas.length;
    const entrada = medidas.reduce((s, m) => s + (Number(m.uso.prompt_tokens) || 0), 0);
    const saida = medidas.reduce((s, m) => s + (Number(m.uso.completion_tokens) || 0), 0);
    const aceitas = medidas.filter((m) => m.r.ok).length;
    console.log(`Resumo: ${aceitas} de ${n} transcrições aceitas; média de ${Math.round(entrada / n)} tokens de entrada e ${Math.round(saida / n)} de saída por questão.`);
    if (simulacao) {
      console.log('Simulação: sem preço. Rode com a chave de verdade para ver o custo.');
      return;
    }
    let preco = null;
    try {
      preco = await precoDoModelo([modelo, medidas.find((m) => m.r.model)?.r.model]);
    } catch (err) {
      console.log(`Não foi possível ler o preço do modelo (${err.message}).`);
    }
    if (!preco) {
      console.log(`O modelo ${modelo} não está no catálogo ${MODELOS_URL}: confira o identificador.`);
      return;
    }
    if (preco.modalidades.length && !preco.modalidades.includes('image')) {
      console.log(`ATENÇÃO: o catálogo diz que ${preco.id} NÃO lê imagem (entradas: ${preco.modalidades.join(', ')}). Escolha outro modelo de visão.`);
    }
    const porMilhao = (v) => `US$ ${(v * 1e6).toFixed(3)}`;
    console.log(
      `Preço de ${preco.id}: ${porMilhao(preco.entrada)} por milhão de tokens de entrada, ${porMilhao(preco.saida)} por milhão de saída` +
        `${preco.imagem ? `, ${usd(preco.imagem)} por imagem` : ''}${preco.chamada ? `, ${usd(preco.chamada)} por chamada` : ''}.`
    );
    const custoTotal = entrada * preco.entrada + saida * preco.saida + n * (preco.imagem + preco.chamada);
    const porQuestao = custoTotal / n;
    console.log(`Custo medido: ${usd(custoTotal)} nas ${n} questões — ${usd(porQuestao)} por questão.`);
    console.log(
      `Estimativa por prova: ${usd(porQuestao * comAlerta.length)} nesta prova (${comAlerta.length} questões com alerta); ` +
        `${usd(porQuestao * prova.questions.length)} se todas as ${prova.questions.length} questões precisassem.`
    );
    if (preco.imagem) console.log('(O preço por imagem pode já estar dentro dos tokens de entrada, conforme o provedor: o custo acima é o teto.)');
  } finally {
    await db.closePool().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err && err.code ? `${err.code}: ${err.message}` : err);
  process.exitCode = 1;
});
