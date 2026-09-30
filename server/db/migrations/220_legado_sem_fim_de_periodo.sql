-- Assinante de plano antigo sem data de fim também fica com acesso completo.
--
-- A 218 só gravou legacy_until para quem tinha current_period_end no futuro.
-- Uma assinatura vigente SEM data de fim (o acesso a trata como válida para
-- sempre — é o caso de acesso concedido à mão) ficava de fora e, sem
-- legacy_until, passaria a valer como Básico: o aluno perderia o acesso
-- completo que tinha. Como o período dela não acaba, o legado também não:
-- a data distante mantém a regra "legacy_until > agora" sem caso especial.
-- Rodar de novo não muda nada: só pega quem ainda não tem legacy_until.
UPDATE subscriptions s
   SET legacy_until = '2099-12-31T23:59:59Z'
 WHERE s.legacy_until IS NULL
   AND s.current_period_end IS NULL
   AND s.status IN ('active', 'trialing', 'past_due')
   AND (s.plan_id IS NULL OR EXISTS (SELECT 1 FROM plans p WHERE p.id = s.plan_id AND p.tier IS NULL));
