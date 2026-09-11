-- A conta pode ser criada livremente, mas o conteúdo de estudo exige uma
-- assinatura ativa. A equipe ainda pode alterar esta opção pelo painel.

INSERT INTO settings (key, value, updated_at)
VALUES ('require_subscription', 'true'::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET value = 'true'::jsonb,
    updated_at = now();
