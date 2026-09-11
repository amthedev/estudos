-- Adota o Qwen3.8 Flash como padrão econômico para tutor e redação.
-- Só troca os padrões da versão anterior; escolhas feitas manualmente no
-- painel continuam intactas.

INSERT INTO settings (key, value, updated_at)
VALUES
  ('openrouter_model', '"qwen/qwen3.8-flash"'::jsonb, now()),
  ('openrouter_essay_model', '"qwen/qwen3.8-flash"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

UPDATE settings
SET value = '"qwen/qwen3.8-flash"'::jsonb,
    updated_at = now()
WHERE key = 'openrouter_model'
  AND value = '"google/gemini-3.8-flash"'::jsonb;

UPDATE settings
SET value = '"qwen/qwen3.8-flash"'::jsonb,
    updated_at = now()
WHERE key = 'openrouter_essay_model'
  AND value = '"anthropic/claude-sonnet-5"'::jsonb;
