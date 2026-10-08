// =====================================================================
// Foco Elite — Pixel do Meta (Facebook/Instagram), no navegador.
//
//   Uso (de public/js/landing.js ou auth.js):
//     importa initMetaPixel, trackLead, trackRegistration, trackWhatsApp deste módulo
//   initMetaPixel(pixelId);          // carrega o fbevents.js e dispara PageView
//   trackLead();                     // interesse (ex.: começou o checkout)
//   trackRegistration();             // cadastro concluído
//   trackWhatsApp();                 // clicou no WhatsApp
//
// A compra (Purchase) NÃO sai daqui: vai do servidor, pela Conversions API,
// porque o Pix é pago fora do site (services/tracking/meta-capi.js). Aqui ficam
// só os eventos que acontecem na tela.
//
// Sem um pixelId (integração desligada no painel), nada é carregado: nenhuma
// chamada ao Facebook, nenhum cookie do Pixel. Ligar/desligar é no painel.
//
// Privacidade: o Pixel marca o visitante no Facebook. Quando a landing ganhar
// um aviso de cookies, basta chamar initMetaPixel só depois do "aceitar" —
// este módulo já é o ponto único que liga tudo.
// =====================================================================

let carregado = false;

/** Carrega o fbevents.js uma vez e inicia o Pixel com PageView. */
export function initMetaPixel(pixelId) {
  const id = String(pixelId || '').trim();
  if (!id || carregado || typeof window === 'undefined') return;
  carregado = true;

  // Trecho oficial do Meta (fbq stub + carregamento do fbevents.js).
  /* eslint-disable */
  !(function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = !0;
    n.version = '2.0';
    n.queue = [];
    t = b.createElement(e);
    t.async = !0;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */

  window.fbq('init', id);
  window.fbq('track', 'PageView');
}

/** Dispara um evento padrão se o Pixel estiver carregado. */
function track(evento, dados) {
  if (typeof window === 'undefined' || typeof window.fbq !== 'function') return;
  try {
    if (dados) window.fbq('track', evento, dados);
    else window.fbq('track', evento);
  } catch {
    // o Pixel nunca pode quebrar a página
  }
}

/** Interesse: o visitante demonstrou intenção (ex.: abriu o checkout). */
export function trackLead(dados) {
  track('Lead', dados);
}

/** Cadastro concluído. */
export function trackRegistration(dados) {
  track('CompleteRegistration', dados);
}

/**
 * Clique no WhatsApp. O Meta não tem evento padrão de "clique no WhatsApp";
 * o mais fiel é Contact, que é o que as contas de anúncio usam para isso.
 */
export function trackWhatsApp(dados) {
  track('Contact', dados);
}
