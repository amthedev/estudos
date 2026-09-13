-- O formato completo promete 80 questões. A primeira versão do complemento
-- por IA gravava 20 como teto, fazendo a prova completa parar cedo quando o
-- banco ainda não tinha questões suficientes.
--
-- Atualiza somente o valor antigo de fábrica. Qualquer limite que o
-- administrador tenha escolhido no painel continua intacto.

INSERT INTO settings (key, value, updated_at)
VALUES ('simulado_ai_questions_max', '80'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

UPDATE settings
SET value = '80'::jsonb,
    updated_at = now()
WHERE key = 'simulado_ai_questions_max'
  AND value = '20'::jsonb;
