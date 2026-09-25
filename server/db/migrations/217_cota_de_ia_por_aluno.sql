-- Cota de IA por aluno no lugar do teto global.
--
-- O teto global (openrouter_monthly_token_limit, 5 milhões de tokens para a
-- plataforma inteira) desligava a IA de TODOS os alunos quando dois ou três
-- engajados o esgotavam — um aluno usando muito tirava o tutor dos outros.
-- Agora cada aluno tem a sua cota mensal; quem passar dela não afeta ninguém.
-- 3 milhões de tokens ≈ US$ 0,80 no modelo atual, acima do uso de um aluno
-- engajado medido com folga (~2,3 milhões).
INSERT INTO settings (key, value, updated_at)
VALUES ('ai_student_monthly_token_limit', '3000000'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

DELETE FROM settings WHERE key = 'openrouter_monthly_token_limit';
