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
UPDATE plans
   SET trial_days = CASE WHEN duration_months IN (6, 12) THEN 1 ELSE 0 END;

-- Este projeto usa Asaas como provedor oficial. As credenciais continuam no ambiente.
INSERT INTO settings (key, value)
VALUES ('payment_provider', to_jsonb('asaas'::text))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
