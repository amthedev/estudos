-- =====================================================================
-- Conteúdo da landing e pagamentos por provedor
--
-- Motivo: nada que varia (preços, depoimentos, perguntas frequentes,
-- textos de venda) pode ficar fixo no código. Tudo passa a ser
-- administrável pelo painel. O meio de pagamento também deixa de ser
-- exclusivo do Stripe: o provedor é escolhido em configurações.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PLANOS: duração de acesso e bônus (ex.: "pague 12 meses, receba 15")
-- ---------------------------------------------------------------------
ALTER TABLE plans ADD COLUMN IF NOT EXISTS duration_months integer NOT NULL DEFAULT 1;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS bonus_months   integer NOT NULL DEFAULT 0;
-- preço de comparação (o que o aluno pagaria no mensal pelo mesmo período)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS compare_price_cents integer;
-- selo exibido no card (ex.: "MELHOR OFERTA")
ALTER TABLE plans ADD COLUMN IF NOT EXISTS badge text;
-- identificadores do provedor de pagamento genérico (Asaas e afins)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS provider_plan_id text;

-- duração = interval_count quando o intervalo é mensal (retrocompatível)
UPDATE plans SET duration_months = GREATEST(interval_count, 1)
 WHERE duration_months = 1 AND interval = 'month' AND interval_count > 1;

-- ---------------------------------------------------------------------
-- ASSINATURAS: provedor e identificadores genéricos
-- ---------------------------------------------------------------------
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'stripe';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_customer_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_subscription_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method text;
CREATE INDEX IF NOT EXISTS subscriptions_provider_idx
  ON subscriptions (provider, provider_subscription_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_customer_id text;

-- eventos de webhook de qualquer provedor (idempotência)
CREATE TABLE IF NOT EXISTS payment_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  event_id      text NOT NULL,
  type          text NOT NULL,
  payload       jsonb,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ---------------------------------------------------------------------
-- DEPOIMENTOS DE ALUNOS (a equipe cadastra pelo painel)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS testimonials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  role        text,                    -- ex.: "Aprovada em Medicina" / "Cadete PM-SP"
  content     text,                    -- depoimento em texto
  image_url   text,                    -- print da conversa, quando for imagem
  photo_url   text,                    -- foto do aluno
  rating      smallint CHECK (rating BETWEEN 1 AND 5),
  exam_id     uuid REFERENCES exams(id) ON DELETE SET NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- precisa ter texto ou imagem
  CHECK (content IS NOT NULL OR image_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS testimonials_order_idx ON testimonials (active, sort_order);
DROP TRIGGER IF EXISTS testimonials_updated ON testimonials;
CREATE TRIGGER testimonials_updated BEFORE UPDATE ON testimonials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- PERGUNTAS FREQUENTES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faqs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question    text NOT NULL,
  answer      text NOT NULL,
  category    text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS faqs_order_idx ON faqs (active, sort_order);
DROP TRIGGER IF EXISTS faqs_updated ON faqs;
CREATE TRIGGER faqs_updated BEFORE UPDATE ON faqs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- BLOCOS DE TEXTO DA LANDING (todo texto de venda é editável)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landing_blocks (
  key         text PRIMARY KEY,        -- ex.: 'hero', 'dores', 'objetivos', 'como_funciona'
  eyebrow     text,
  title       text,
  subtitle    text,
  body        text,
  items       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{icon,title,text,cta_label,cta_href,image_url}]
  cta_label   text,
  cta_href    text,
  image_url   text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS landing_blocks_updated ON landing_blocks;
CREATE TRIGGER landing_blocks_updated BEFORE UPDATE ON landing_blocks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- PROVAS: logo para os cards de trilha da landing
-- ---------------------------------------------------------------------
ALTER TABLE exams ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS landing_headline text;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS landing_text text;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS landing_cta text;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
