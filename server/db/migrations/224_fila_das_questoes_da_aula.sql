-- =====================================================================
-- Fila das questões da aula: falha passageira da IA não derruba a fila.
--
-- Até aqui qualquer erro na preparação das questões marcava a aula como
-- 'failed', e 'failed' não saía mais da fila. Num envio de 200 aulas, bastava
-- a IA ficar fora do ar por alguns minutos (crédito acabou, chave trocada,
-- provedor caiu) para a fila inteira terminar em 'failed', uma aula a cada
-- dois segundos — e o primeiro aluno de cada aula pagava a geração na prática.
--
-- Agora a aula volta para a fila e espera:
--   - questions_retry_at: antes disso a fila não pega a aula de novo;
--   - questions_attempts: quantas rodadas falharam por causa da própria aula
--     (a IA respondeu, mas sem as questões que faltavam). Na terceira, 'failed'.
--     Erro do provedor (a IA nem respondeu) não conta: a culpa não é da aula.
-- =====================================================================

ALTER TABLE lessons ADD COLUMN IF NOT EXISTS questions_attempts smallint NOT NULL DEFAULT 0;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS questions_retry_at timestamptz;

COMMENT ON COLUMN lessons.questions_attempts IS
  'Rodadas da fila que falharam por causa da aula desde a última vez que ela entrou na fila. Zera ao ficar pronta ou voltar para a fila.';
COMMENT ON COLUMN lessons.questions_retry_at IS
  'A fila não pega a aula antes deste momento (espera depois de uma falha).';
