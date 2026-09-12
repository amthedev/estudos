-- =====================================================================
-- Checkout Asaas com forma de pagamento explícita e teste de 24 horas.
--
-- O checkout fica registrado antes do redirecionamento para que os
-- webhooks do Asaas consigam relacionar a assinatura ao aluno e ao plano.
-- =====================================================================

CREATE TABLE IF NOT EXISTS payment_checkouts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 text NOT NULL,
  provider_checkout_id     text NOT NULL,
  provider_subscription_id text,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id                  uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  payment_method           text NOT NULL CHECK (payment_method IN ('credit_card', 'pix')),
  status                   text NOT NULL DEFAULT 'pending',
  trial_ends_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_checkout_id)
);

CREATE INDEX IF NOT EXISTS payment_checkouts_user_idx
  ON payment_checkouts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_checkouts_subscription_idx
  ON payment_checkouts (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

-- O teste é oferecido somente nos contratos de 6 e 12 meses.
--
-- Só mexe em quem ainda está no padrão do seed: um administrador que já tenha
-- ajustado trial_days pelo painel não deve ter a escolha dele revertida por
-- uma publicação. Migration roda uma vez só, mas instalações novas partem
-- daqui, e a regra vale para elas também.
UPDATE plans
   SET trial_days = 1
 WHERE duration_months IN (6, 12)
   AND trial_days = 0
   AND created_at = updated_at;

-- Este projeto usa Asaas como provedor oficial. As credenciais continuam no
-- ambiente.
--
-- DO NOTHING, não DO UPDATE: a chave pertence ao painel, e sobrescrever
-- desfaria a escolha do administrador a cada publicação. A migration 120 criou
-- a mesma chave com DO NOTHING pelo mesmo motivo.
INSERT INTO settings (key, value)
VALUES ('payment_provider', to_jsonb('asaas'::text))
ON CONFLICT (key) DO NOTHING;
