-- Migra as configurações do provedor antigo para o OpenRouter.
-- Os modelos mudam de propósito para opções de outros provedores disponíveis
-- no catálogo do OpenRouter; o limite de consumo existente é preservado.

INSERT INTO settings (key, value, updated_at)
VALUES
  ('openrouter_model', '"google/gemini-3.8-flash"'::jsonb, now()),
  ('openrouter_essay_model', '"anthropic/claude-sonnet-5"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value, updated_at)
SELECT
  'openrouter_monthly_token_limit',
  coalesce(
    (SELECT value FROM settings WHERE key = 'openai_monthly_token_limit'),
    '5000000'::jsonb
  ),
  now()
ON CONFLICT (key) DO NOTHING;

DELETE FROM settings
WHERE key IN ('openai_model', 'openai_essay_model', 'openai_monthly_token_limit');
