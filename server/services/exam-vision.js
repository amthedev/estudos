'use strict';

/**
 * Leitura de questão pela imagem — o reforço OPCIONAL da leitura de provas.
 *
 *   const visao = require('./exam-vision');
 *   const { enabled, model, available } = await visao.configuracao();
 *   visao.precisaDeVisao(q);                       // alerta de texto ilegível ou de alternativa faltando?
 *   const r = await visao.transcrever(q, { model }); // { ok, motivo, transcricao, usage, model }
 *   visao.aplicar(q, r.transcricao);               // troca o texto e tira o alerta
 *   await visao.melhorar(questoes, { model });     // as duas coisas, para as que precisam
 *
 * O recorte das questões é determinístico (exam-reader/) e quase sempre basta.
 * Sobra a questão cuja fonte veio embaralhada a ponto de nem o deslocamento de
 * código salvar ('texto_ilegivel') e a de alternativa que não foi achada
 * ('alternativas_incompletas'). Para essas, e SÓ para essas, a imagem da região
 * da questão (q.region_png, renderizada pelo leitor) vai a um modelo de visão
 * pedindo a transcrição fiel em JSON. Resposta válida troca o texto e tira o
 * alerta; resposta ruim, cortada ou falha mantém o alerta — a questão continua
 * esperando a conferência no painel, como sem visão.
 *
 * Desligado por padrão (setting exam_import_vision_enabled): ler uma questão
 * pela imagem custa bem mais que classificá-la, e o custo precisa ser medido
 * antes de ligar (scripts/medir-leitura-visao.js).
 *
 * As figuras não passam pela IA: o modelo escreve [[FIGURA]] onde a figura
 * está, e o marcador de figura que o leitor já tinha (`![Figura](figura:N)`)
 * volta para esse lugar. Alternativa que é figura continua sendo a figura.
 */
const ai = require('./ai');
const { getSetting } = require('./settings');
const { isGarbled } = require('./exam-reader/decode');
const { escapeInline, escapeMarkdown } = require('./exam-reader/questions');

const LETRAS = ['A', 'B', 'C', 'D', 'E'];
/** Os alertas que a leitura pela imagem resolve. Os outros pedem olho humano. */
const ALERTAS_DE_VISAO = ['texto_ilegivel', 'alternativas_incompletas'];
const VARIANTE = { ingles: 'opção inglês', espanhol: 'opção espanhol' };
const MARCA_FIGURA = '[[FIGURA]]';
/** Marcador de figura do leitor no markdown: ![Figura](figura:3). */
const MARCADOR = /!\[[^\]]*\]\(figura:(\d+)\)/g;

/** Limites do painel (PATCH do item): o que passar disso não é transcrição. */
const MAX_ENUNCIADO = 30_000;
const MAX_ALTERNATIVA = 6000;
/** A transcrição de uma questão com texto de apoio passa de 1.500 tokens. */
const MAX_TOKENS = 4000;
const MAX_TOKENS_REPETICAO = 8000;
const TIMEOUT_MS = 90_000;
/** Questões lidas ao mesmo tempo. */
const CONCORRENCIA = 3;
/** Falhas seguidas do serviço (não da resposta) que fazem desistir desta leitura. */
const DESISTE_APOS = 3;

/**
 * A leitura pela imagem está ligada? Com que modelo? `available` diz se a IA
 * existe neste servidor (sem chave, ligada ou não, nada é chamado).
 */
async function configuracao() {
  const enabled = (await getSetting('exam_import_vision_enabled')) === true;
  const model =
    String((await getSetting('openrouter_vision_model')) || '').trim() ||
    String((await getSetting('openrouter_extract_model')) || '').trim() ||
    String((await getSetting('openrouter_model')) || '').trim() ||
    undefined;
  return { enabled, model, available: ai.isConfigured() };
}

/** A questão tem alerta que a leitura pela imagem resolve? */
function precisaDeVisao(q) {
  return Boolean(q && (q.alerts || []).some((a) => ALERTAS_DE_VISAO.includes(a)));
}

/** Marcadores de figura de um trecho de markdown, na ordem: { md, index }. */
function marcadoresDe(md) {
  return [...String(md || '').matchAll(MARCADOR)].map((m) => ({ md: m[0], index: Number(m[1]) }));
}

/** Figura que é fórmula montada (recorte de símbolo): na imagem, parece texto. */
function ehFormula(q, marcador) {
  const figura = (q.figures || [])[marcador.index];
  return Boolean(figura && figura.kind === 'formula');
}

/** Alternativas que são só figura (sem texto além do marcador). */
function alternativasFigura(q) {
  return (q.alternatives || [])
    .filter((a) => marcadoresDe(a.text_md).length && !String(a.text_md).replace(MARCADOR, '').trim())
    .map((a) => a.letter);
}

/** Imagem da região em data URL (a IA recebe o PNG inteiro, sem passar pelo armazenamento). */
function imagemDaQuestao(q) {
  if (q.region_url) return q.region_url;
  if (!q.region_png || !q.region_png.length) return null;
  return `data:image/png;base64,${Buffer.from(q.region_png).toString('base64')}`;
}

/**
 * Mensagens da transcrição: instrução em texto e a imagem da região. O
 * prompt diz quantas figuras há no enunciado e quais alternativas são figura,
 * para o modelo marcar o lugar delas em vez de descrevê-las.
 */
function montarMensagens(q, imagemUrl) {
  const figuras = marcadoresDe(q.statement_md).filter((m) => !ehFormula(q, m)).length;
  const figuraNasAlternativas = alternativasFigura(q);
  const variante = q.variant && VARIANTE[q.variant] ? ` (${VARIANTE[q.variant]})` : '';
  const texto = [
    `Transcreva a questão ${q.number}${variante} desta prova, que está na imagem.`,
    `Figuras no enunciado: ${figuras}`,
    figuraNasAlternativas.length ? `Alternativas que são figura: ${figuraNasAlternativas.join(', ')}` : '',
    '',
    'Regras:',
    '- Copie o texto exatamente como está na imagem, no idioma original. Não resuma, não corrija, não resolva a questão.',
    '- statement: o enunciado inteiro, na ordem em que aparece — textos de apoio, referências bibliográficas e a pergunta —, até antes da alternativa A. Não inclua o número da questão.',
    '- Separe os parágrafos com uma linha em branco. Não quebre a linha no meio do parágrafo; em poema, uma linha por verso. Títulos como "TEXTO I" e a referência bibliográfica ficam em linha própria.',
    `- Onde houver figura, gráfico, tabela, mapa, charge ou tirinha, escreva ${MARCA_FIGURA} numa linha própria e não descreva a imagem. Use ${MARCA_FIGURA} exatamente uma vez para cada figura do enunciado.`,
    `- alternatives: o texto de cada alternativa, de A a E, sem a letra. Alternativa que é só figura: "${MARCA_FIGURA}".`,
    '- Texto puro: sem markdown, sem HTML. Fórmulas e unidades em texto simples (x², √2, 3/4, 10 m/s).',
    '- Se um trecho não estiver legível na imagem, escreva [ilegível] no lugar — nunca invente.',
    '',
    'Responda só com JSON neste formato:',
    '{"statement": "enunciado", "alternatives": {"A": "texto", "B": "texto", "C": "texto", "D": "texto", "E": "texto"}}',
  ]
    .filter((linha, i, todas) => linha !== '' || todas[i - 1] !== '')
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'Você transcreve questões de provas brasileiras (ENEM, vestibulares, concursos) a partir da imagem da questão. ' +
        'Sua única tarefa é copiar o texto com fidelidade, em JSON.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: texto },
        { type: 'image_url', image_url: { url: imagemUrl } },
      ],
    },
  ];
}

/** Texto do modelo sem HTML, sem imagem inventada, sem ênfase de markdown. */
function textoLimpo(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/\r\n?/g, '\n')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "TEXTO I", "Texto II", "TEXT III" em linha própria: título, em negrito como no leitor. */
const TITULO = /^(?:texto|text)\s+[ivx\d]+$/i;

/** Alternativas como vierem: { A: '...' } ou [{ letter, text }] ou ['...', ...]. */
function alternativasDoModelo(bruto) {
  const out = {};
  if (Array.isArray(bruto)) {
    bruto.forEach((item, i) => {
      if (typeof item === 'string') {
        if (i < 5) out[LETRAS[i]] = item;
      } else if (item && typeof item === 'object') {
        const letra = String(item.letter || item.letra || '').trim().toUpperCase().replace(/[^A-E]/g, '');
        if (LETRAS.includes(letra)) out[letra] = item.text ?? item.texto ?? '';
      }
    });
  } else if (bruto && typeof bruto === 'object') {
    for (const [chave, valor] of Object.entries(bruto)) {
      const letra = String(chave).trim().toUpperCase().replace(/[^A-E]/g, '');
      if (LETRAS.includes(letra) && letra.length === 1) out[letra] = valor;
    }
  }
  return out;
}

const letrasDe = (texto) => (String(texto || '').match(/\p{L}/gu) || []).length;

/**
 * Confere a resposta do modelo e monta o markdown da questão.
 *
 * Recusa (devolve { erro }) quando: falta o enunciado ou uma alternativa, o
 * texto ainda é lixo de fonte, o modelo marcou [ilegível], ou marcou MENOS
 * figuras do que o enunciado tem (uma figura sumiria). Figura a mais é
 * descartada, com alerta 'figura_incerta' para alguém olhar.
 *
 * @returns {{ statement_md: string, alternatives: Array<{letter, text_md}>, alerts: string[] } | { erro: string }}
 */
function validar(data, q) {
  if (!data || typeof data !== 'object') return { erro: 'resposta sem JSON' };
  const enunciado = textoLimpo(data.statement ?? data.enunciado);
  if (!enunciado || letrasDe(enunciado.split(MARCA_FIGURA).join(' ')) < 10) return { erro: 'enunciado vazio' };
  if (enunciado.length > MAX_ENUNCIADO) return { erro: 'enunciado longo demais' };
  const alternativas = alternativasDoModelo(data.alternatives ?? data.alternativas);
  const tudo = [enunciado, ...Object.values(alternativas).map(textoLimpo)].join('\n');
  if (/\[\s*ileg[ií]vel\s*\]/i.test(tudo)) return { erro: 'o modelo não conseguiu ler um trecho' };
  if (isGarbled(tudo)) return { erro: 'texto ainda ilegível' };

  const alerts = [];
  // Enunciado: cada [[FIGURA]] volta a ser o marcador do leitor, na ordem.
  const marcadores = marcadoresDe(q.statement_md);
  const figuras = marcadores.filter((m) => !ehFormula(q, m));
  // Fórmula montada que tinha virado recorte: na imagem ela parece texto, e o
  // modelo a escreve como texto. O recorte sai; a conferência confere a conta.
  if (marcadores.some((m) => ehFormula(q, m))) alerts.push('figura_incerta');
  const blocos = enunciado
    .split(MARCA_FIGURA)
    .join(`\n\n${MARCA_FIGURA}\n\n`)
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const partes = [];
  let usadas = 0;
  let sobrando = 0;
  for (const bloco of blocos) {
    if (bloco === MARCA_FIGURA) {
      if (usadas < figuras.length) partes.push(figuras[usadas++].md);
      else sobrando += 1;
      continue;
    }
    const linhas = bloco
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (TITULO.test(l) ? `**${escapeMarkdown(l)}**` : escapeMarkdown(l)));
    if (linhas.length) partes.push(linhas.join('\n'));
  }
  if (usadas < figuras.length) return { erro: 'a transcrição deixou de fora uma figura do enunciado' };
  if (sobrando && !alerts.includes('figura_incerta')) alerts.push('figura_incerta');

  // Alternativas: o texto do modelo; a figura que a alternativa tinha continua.
  const saida = [];
  for (const letra of LETRAS) {
    const original = (q.alternatives || []).find((a) => a.letter === letra);
    const marcas = original ? marcadoresDe(original.text_md).map((m) => m.md) : [];
    const textoOriginal = original ? String(original.text_md || '').replace(MARCADOR, '').trim() : '';
    const doModelo = textoLimpo(alternativas[letra]).split(MARCA_FIGURA).join(' ').replace(/\s+/g, ' ').trim();
    let texto;
    if (marcas.length && !textoOriginal) texto = marcas.join(' ');
    else texto = [doModelo ? escapeInline(doModelo) : '', ...marcas].filter(Boolean).join(' ');
    if (!texto) return { erro: `alternativa ${letra} vazia` };
    if (texto.length > MAX_ALTERNATIVA) return { erro: `alternativa ${letra} longa demais` };
    saida.push({ letter: letra, text_md: texto });
  }
  return { statement_md: partes.join('\n\n'), alternatives: saida, alerts };
}

/**
 * Troca o texto da questão pela transcrição validada e tira os alertas que a
 * visão resolve. Os outros alertas (número fora de sequência, região partida,
 * sem gabarito) continuam: a visão não responde por eles.
 */
function aplicar(q, transcricao, { model = null } = {}) {
  q.statement_md = transcricao.statement_md;
  q.alternatives = transcricao.alternatives.map((a) => ({ ...a }));
  const alerts = (q.alerts || []).filter((a) => !ALERTAS_DE_VISAO.includes(a));
  for (const a of transcricao.alerts || []) if (!alerts.includes(a)) alerts.push(a);
  q.alerts = alerts;
  q.vision = { model };
  return q;
}

/**
 * Lê uma questão pela imagem. Nunca lança: falha do serviço ou resposta
 * recusada voltam em { ok: false, motivo }, e `servico: true` separa o
 * primeiro caso (a IA não respondeu) do segundo (respondeu mal).
 */
async function transcrever(q, { model, userId = null } = {}) {
  const imagem = imagemDaQuestao(q);
  if (!imagem) return { ok: false, motivo: 'questão sem imagem da região', servico: false };
  try {
    const resposta = await ai.json({
      messages: montarMensagens(q, imagem),
      model,
      temperature: 0,
      maxTokens: MAX_TOKENS,
      retryMaxTokens: MAX_TOKENS_REPETICAO,
      userId,
      feature: 'exam_import',
      timeoutMs: TIMEOUT_MS,
    });
    const base = { usage: resposta.usage, model: resposta.model, latency_ms: resposta.latency_ms };
    if (resposta.aborted) return { ...base, ok: false, motivo: 'chamada cancelada', servico: true };
    const transcricao = validar(resposta.data, q);
    if (transcricao.erro) return { ...base, ok: false, motivo: transcricao.erro, servico: false, data: resposta.data };
    return { ...base, ok: true, transcricao, data: resposta.data };
  } catch (err) {
    return { ok: false, motivo: err && err.message ? err.message : String(err), servico: true };
  }
}

/**
 * Lê pela imagem as questões que precisam (alerta de texto ilegível ou de
 * alternativa faltando, com a imagem da região) e aplica o que vier válido.
 * Questões fora disso não são tocadas. A imagem sai da memória depois do uso.
 *
 * @returns {Promise<{ tried, fixed, failed, stopped, prompt_tokens, completion_tokens }>}
 */
async function melhorar(questoes, { model, userId = null, concorrencia = CONCORRENCIA } = {}) {
  const stats = { tried: 0, fixed: 0, failed: 0, stopped: false, prompt_tokens: 0, completion_tokens: 0 };
  const fila = questoes.filter((q) => precisaDeVisao(q) && (q.region_png || q.region_url));
  let seguidas = 0;

  const proxima = async () => {
    while (fila.length && !stats.stopped) {
      const q = fila.shift();
      stats.tried += 1;
      // eslint-disable-next-line no-await-in-loop
      const r = await transcrever(q, { model, userId });
      delete q.region_png;
      if (r.usage) {
        stats.prompt_tokens += Number(r.usage.prompt_tokens) || 0;
        stats.completion_tokens += Number(r.usage.completion_tokens) || 0;
      }
      if (r.ok) {
        aplicar(q, r.transcricao, { model: r.model || model || null });
        stats.fixed += 1;
        seguidas = 0;
        continue;
      }
      stats.failed += 1;
      if (r.servico) {
        seguidas += 1;
        console.warn(`[exam-vision] questão ${q.number}: ${r.motivo}`);
        // A IA fora do ar (ou a chave recusada) responde igual para todas:
        // insistir só atrasa a leitura. O alerta fica; a conferência resolve.
        if (seguidas >= DESISTE_APOS) stats.stopped = true;
      } else {
        seguidas = 0;
      }
    }
  };
  const n = Math.max(1, Math.min(concorrencia, fila.length));
  await Promise.all(Array.from({ length: n }, proxima));
  for (const q of questoes) delete q.region_png;
  return stats;
}

module.exports = {
  ALERTAS_DE_VISAO,
  MARCA_FIGURA,
  configuracao,
  precisaDeVisao,
  montarMensagens,
  imagemDaQuestao,
  validar,
  aplicar,
  transcrever,
  melhorar,
};
