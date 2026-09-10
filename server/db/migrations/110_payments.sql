-- =====================================================================
-- Pagamentos com provedor selecionável (Asaas e Stripe)
--
-- A migration 100 já criou as colunas genéricas de provedor em plans,
-- subscriptions e users, além da tabela payment_events. Falta o que
-- torna a gravação idempotente e o que o Asaas exige do pagador.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ASSINATURAS: um identificador de assinatura é único dentro do provedor.
-- É o alvo do ON CONFLICT usado pelo webhook (mesmo evento reprocessado
-- não pode criar uma segunda linha).
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_subscription_uniq
  ON subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

-- Assinaturas criadas antes desta migration só têm as colunas do Stripe.
UPDATE subscriptions
   SET provider                 = 'stripe',
       provider_subscription_id = COALESCE(provider_subscription_id, stripe_subscription_id),
       provider_customer_id     = COALESCE(provider_customer_id, stripe_customer_id)
 WHERE stripe_subscription_id IS NOT NULL
   AND (provider_subscription_id IS NULL OR provider_customer_id IS NULL);

UPDATE users
   SET provider_customer_id = stripe_customer_id
 WHERE provider_customer_id IS NULL
   AND stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_provider_customer_idx ON users (provider_customer_id);

-- ---------------------------------------------------------------------
-- PAGADOR: o Asaas exige CPF/CNPJ do cliente para emitir pix e boleto.
-- Fica em users porque vale para qualquer provedor e o aluno informa uma
-- única vez, no checkout.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_id text;

-- ---------------------------------------------------------------------
-- EVENTOS DE WEBHOOK: consulta por tipo e data no painel.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS payment_events_type_idx
  ON payment_events (provider, type, processed_at DESC);
