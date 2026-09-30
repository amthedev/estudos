-- =====================================================================
-- Níveis de plano, moedas diárias e upgrade pela diferença.
--
-- O limite de uso deixa de ser "tantas redações por mês" e passa a ser
-- moeda: cada nível de plano (Básico, Pro, Avançado) recebe um tanto de
-- moedas por dia, e cada ação que chama a IA custa algumas. As moedas do dia
-- não acumulam: à meia-noite de São Paulo o saldo volta ao valor do nível.
--
-- O saldo não é um número guardado e decrementado. É a conta do dia feita
-- sobre um livro de lançamentos (coin_ledger): moedas do nível + concessões
-- do dia - cobranças do dia que não foram estornadas. Assim a virada do dia
-- não depende de nenhum processo zerando saldo às 00h, o estorno é só marcar
-- a linha, e o suporte consegue ver de onde veio cada moeda.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Nível do plano
-- ---------------------------------------------------------------------
-- NULL é o plano antigo, vendido antes dos níveis. Quem assinou um deles
-- continua com tudo liberado até o fim do período que já pagou (ver
-- subscriptions.legacy_until abaixo).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS tier text
  CHECK (tier IS NULL OR tier IN ('basico', 'pro', 'avancado'));

COMMENT ON COLUMN plans.tier IS
  'Nível do plano (basico, pro, avancado). Nulo é plano antigo, de antes das moedas.';

-- ---------------------------------------------------------------------
-- Assinante antigo
-- ---------------------------------------------------------------------
-- "Plano sem nível = tudo liberado" vazaria: o webhook grava plan_id nulo
-- quando não reconhece o plano, e o painel cria plano sem nível. Por isso o
-- direito do assinante antigo é uma data explícita, gravada só aqui, para
-- quem já tinha assinatura vigente quando as moedas entraram. A renovação no
-- cartão estende current_period_end, mas não mexe nesta coluna: o assinante
-- antigo tem acesso completo até o fim do período que já estava pago, e daí
-- em diante passa a valer o nível.
--
-- A exceção é a compra de plano antigo que ainda estava em andamento aqui
-- (teste de 24h, primeira cobrança pendente, Pix aberto e pago depois): o
-- UPDATE abaixo só enxerga o teste, e com o fim das 24h. O webhook estende o
-- legado quando essa primeira cobrança é paga (oldPlanPurchaseInFlight em
-- services/payments/index.js).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS legacy_until timestamptz;

COMMENT ON COLUMN subscriptions.legacy_until IS
  'Até quando o assinante de plano antigo (sem nível) tem acesso completo, sem moedas.';

UPDATE subscriptions s
   SET legacy_until = s.current_period_end
  FROM plans p
 WHERE p.id = s.plan_id
   AND p.tier IS NULL
   AND s.legacy_until IS NULL
   AND s.status IN ('active', 'trialing', 'past_due')
   AND s.current_period_end > now();

-- Assinatura vigente cujo plano não foi reconhecido (ou foi apagado) também
-- era acesso completo até hoje; tratá-la como Básico seria tirar do aluno
-- algo que ele pagou.
UPDATE subscriptions
   SET legacy_until = current_period_end
 WHERE plan_id IS NULL
   AND legacy_until IS NULL
   AND status IN ('active', 'trialing', 'past_due')
   AND current_period_end > now();

-- Os planos antigos saem da vitrine. Não são apagados: há assinaturas
-- apontando para eles, e o painel precisa continuar mostrando o nome.
UPDATE plans SET active = false WHERE slug IN ('mensal', 'seis-meses', 'anual');

-- ---------------------------------------------------------------------
-- Livro de moedas
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coin_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Dia civil em São Paulo a que o lançamento pertence. Vem calculado da
  -- aplicação, não do now() do banco, para a virada do dia ser uma conta só.
  day           date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('debit', 'grant')),
  -- O que gerou o lançamento: essay_correction, simulado, practice,
  -- questions, essay_theme, admin_grant...
  action        text NOT NULL,
  amount        integer NOT NULL CHECK (amount > 0),
  -- Objeto cobrado (redação, tentativa de simulado...). É o que impede a
  -- mesma ação de ser cobrada duas vezes por dois cliques.
  ref_type      text,
  ref_id        text,
  refunded_at   timestamptz,
  refund_reason text,
  -- Quem da equipe concedeu moedas extras.
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- O saldo do dia soma os lançamentos de um aluno em um dia: é a consulta
-- que roda a cada ação cobrada e a cada abertura do app.
CREATE INDEX IF NOT EXISTS coin_ledger_user_day_idx ON coin_ledger (user_id, day);

-- No máximo UMA cobrança viva por objeto. Dois cliques em "corrigir" chegam
-- juntos ao servidor; sem isto, os dois debitariam. Depois de estornada, a
-- cobrança sai do índice e o reenvio pode cobrar de novo.
CREATE UNIQUE INDEX IF NOT EXISTS coin_ledger_cobranca_viva_idx
  ON coin_ledger (user_id, action, ref_type, ref_id)
  WHERE kind = 'debit' AND refunded_at IS NULL AND ref_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Troca de plano (upgrade pela diferença)
-- ---------------------------------------------------------------------
-- Cada pedido de upgrade vira uma cobrança avulsa no provedor, e o webhook
-- precisa reconhecê-la pelo id do pagamento ANTES da lógica de compra e
-- renovação — senão pagar a diferença daria ao aluno um período inteiro novo.
CREATE TABLE IF NOT EXISTS plan_changes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id     uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  from_plan_id        uuid REFERENCES plans(id),
  to_plan_id          uuid REFERENCES plans(id),
  amount_cents        integer NOT NULL,
  -- Fim do período usado na conta do valor; se o período mudar antes do
  -- pagamento, dá para saber com que base a diferença foi cotada.
  period_end_at_quote timestamptz,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'expired', 'canceled', 'refunded')),
  provider            text NOT NULL DEFAULT 'asaas',
  provider_payment_id text UNIQUE,
  invoice_url         text,
  created_at          timestamptz DEFAULT now(),
  paid_at             timestamptz,
  refunded_at         timestamptz,
  updated_at          timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_changes_user_status_idx ON plan_changes (user_id, status);
CREATE TRIGGER plan_changes_updated BEFORE UPDATE ON plan_changes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
