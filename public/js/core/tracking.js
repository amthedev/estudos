// =====================================================================
// Foco Elite — captura da origem do visitante (UTMs), no navegador.
//
//   Uso (de public/js/landing.js ou auth.js):
//     importa captureTracking, readTracking deste módulo
//   captureTracking();              // na chegada (landing): guarda ?utm_source=…
//   const t = readTracking();       // no cadastro: devolve o que foi guardado
//
// Quando o visitante chega por um anúncio, a URL traz utm_source, utm_campaign,
// etc. (e src/sck, que a Utmify também usa). Guardamos a PRIMEIRA origem — a
// que de fato trouxe a pessoa — e ela viaja até o cadastro, onde o servidor a
// grava no usuário. No pagamento, a venda é ligada a esse anúncio na Utmify.
//
// Fica em localStorage (1ª parte, nada de cookie de terceiro). Se o navegador
// bloquear o armazenamento, a captura falha em silêncio: sem rastreio é melhor
// que uma página quebrada.
// =====================================================================

const STORAGE_KEY = 'fe.tracking';
const CAMPOS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'src', 'sck'];
const VALIDADE_MS = 90 * 24 * 60 * 60 * 1000; // 90 dias

/** Lê com segurança: armazenamento bloqueado nunca pode derrubar a página. */
function lerBruto() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Guarda as UTMs da URL atual, se houver. A primeira origem vence: uma vez
 * gravada (e dentro da validade), uma visita nova por link sem UTM, ou por
 * outro anúncio, não sobrescreve quem já trouxe a pessoa.
 */
export function captureTracking() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }

  const capturado = {};
  for (const campo of CAMPOS) {
    const valor = params.get(campo);
    if (valor) capturado[campo] = String(valor).slice(0, 500);
  }
  if (!Object.keys(capturado).length) return;

  const atual = lerBruto();
  // Já existe origem válida: não sobrescreve (primeira origem vence).
  if (atual && atual.at && Date.now() - atual.at < VALIDADE_MS && atual.params) return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now(), params: capturado }));
  } catch {
    // armazenamento indisponível: segue sem rastreio
  }
}

/**
 * Devolve as UTMs guardadas (ou null). Expira depois da validade — origem
 * velha não deve ser creditada a uma compra meses depois.
 */
export function readTracking() {
  const atual = lerBruto();
  if (!atual || !atual.params || !atual.at) return null;
  if (Date.now() - atual.at >= VALIDADE_MS) return null;
  const limpo = {};
  for (const campo of CAMPOS) {
    if (atual.params[campo]) limpo[campo] = atual.params[campo];
  }
  return Object.keys(limpo).length ? limpo : null;
}
