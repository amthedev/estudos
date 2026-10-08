-- =====================================================================
-- Rastreio de origem da venda (Utmify).
--
-- Quando o aluno chega pela landing por um anúncio, a landing captura as UTMs
-- (?utm_source=…, utm_campaign, src, sck) e o cadastro as guarda aqui. Na hora
-- em que o pagamento é confirmado (webhook do Asaas), o envio para a Utmify
-- (services/tracking/utmify.js) lê estes parâmetros e liga a venda ao anúncio.
--
-- Fica no usuário, não na cobrança: é a primeira origem que importa, e ela é
-- conhecida já no cadastro, antes de existir qualquer checkout.
-- =====================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS tracking jsonb;

COMMENT ON COLUMN users.tracking IS
  'Parâmetros de rastreio capturados na chegada (utm_source/medium/campaign/term/content, src, sck). Usados no envio da venda à Utmify.';
