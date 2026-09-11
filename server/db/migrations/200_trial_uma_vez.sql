-- =====================================================================
-- O teste de 24 horas passa a valer uma vez por aluno.
--
-- Antes, a oferta dependia só do plano e da forma de pagamento. Como nada
-- registrava que o aluno já tinha usado, o teste era repetível: bastava um
-- cartão que passasse na validação do Checkout e falhasse na cobrança — a
-- assinatura virava `past_due`, o guarda do checkout deixava passar, e um
-- novo teste de 24 horas começava. Todo dia, sem pagar.
--
-- A marca fica no aluno, não na assinatura, porque é o aluno que tem direito
-- a um teste — e assinatura cancelada ou vencida sai da frente do guarda.
-- =====================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_used_at timestamptz;

COMMENT ON COLUMN users.trial_used_at IS
  'Quando o aluno iniciou o período de teste. Preenchido uma única vez: a '
  'presença do valor é o que impede um segundo teste.';

-- Quem já está em teste ou já passou por um não deve ganhar outro quando esta
-- versão subir. Sem isso, todo aluno com assinatura em andamento ganharia um
-- teste novo na primeira vez que voltasse ao checkout.
UPDATE users u
   SET trial_used_at = s.inicio
  FROM (
    SELECT user_id, min(coalesce(current_period_start, created_at)) AS inicio
      FROM subscriptions
     WHERE status = 'trialing' OR last_payment_at IS NOT NULL
     GROUP BY user_id
  ) s
 WHERE s.user_id = u.id
   AND u.trial_used_at IS NULL;
