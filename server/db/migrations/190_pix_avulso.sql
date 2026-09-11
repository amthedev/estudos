-- =====================================================================
-- Pix avulso e cobrança creditada uma única vez.
--
-- Duas correções de cobrança que andam juntas porque tocam a mesma linha
-- de assinatura.
--
-- 1. O Asaas não faz Pix recorrente: assinatura recorrente lá é só cartão,
--    e Pix existe apenas como cobrança avulsa (DETACHED). Então o Pix passa
--    a ser pagamento único do período contratado, sem renovação automática.
--    Essa assinatura não tem identificador de assinatura no Asaas, e por isso
--    `provider_subscription_id` fica nulo — o índice único da coluna já é
--    parcial (só vale quando não é nulo), então várias linhas assim convivem.
--
-- 2. O Asaas emite PAYMENT_CONFIRMED e PAYMENT_RECEIVED como dois eventos
--    distintos para a MESMA cobrança, e os dois estendiam o período. Um aluno
--    que pagasse uma vez o plano de 12+3 meses recebia 27 meses de acesso.
--    A idempotência por id de evento não pega isso, porque são eventos
--    diferentes. `last_payment_id` guarda qual cobrança já foi creditada.
-- =====================================================================

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_payment_id text;

COMMENT ON COLUMN subscriptions.last_payment_id IS
  'Id da cobrança no provedor que concedeu o período atual. Impede creditar '
  'duas vezes quando o provedor emite mais de um evento para o mesmo pagamento.';

-- Assinatura de Pix avulso é encontrada pelo aluno, não pelo id de assinatura
-- do provedor, que não existe nesse caso.
CREATE INDEX IF NOT EXISTS subscriptions_avulsa_idx
  ON subscriptions (user_id, provider, created_at DESC)
  WHERE provider_subscription_id IS NULL;
