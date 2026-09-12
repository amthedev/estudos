-- =====================================================================
-- Conferência das questões e gabarito oficial da prova importada.
--
-- A 210 deixou a questão elaborada pela IA entrar ATIVA no banco — é o
-- único jeito de o caderno de erros continuar mostrando o erro do aluno,
-- já que ele filtra por q.active em seis consultas (routes/errors.js).
-- O preço dessa decisão é real: uma questão com gabarito errado chega ao
-- aluno antes de alguém olhar, entra no caderno de erros e conta no
-- desempenho. A 210 criou `questions.reviewed_at`, mas faltavam os dois
-- sinais que transformam isso em fila de trabalho no painel: o aluno
-- avisando, e a taxa de acerto denunciando sozinha.
--
-- Do lado da importação de prova, faltava o gabarito oficial. Sem ele a
-- IA não transcreve a resposta: ela ESCOLHE a resposta de uma questão que
-- ela mesma acabou de transcrever — e escolhe com confiança.
-- =====================================================================

-- ---------------------------------------------------------------------
-- O aluno avisa
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  reason      text NOT NULL CHECK (reason IN ('gabarito', 'enunciado', 'alternativas', 'assunto', 'outro')),
  comment     text,
  status      text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'resolvido', 'descartado')),
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_reports_abertos_idx
  ON question_reports (created_at DESC) WHERE status = 'aberto';
-- Um aluno não abre dois chamados para a mesma questão.
CREATE UNIQUE INDEX IF NOT EXISTS question_reports_unicos_idx
  ON question_reports (question_id, user_id) WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- A consulta quente da prática pós-aula
-- ---------------------------------------------------------------------
-- É (assunto, dificuldade) com active — ver services/question-ai.js. O
-- índice que existia cobria só topic_id.
CREATE INDEX IF NOT EXISTS questions_topic_dificuldade_idx
  ON questions (topic_id, difficulty) WHERE active;

-- ---------------------------------------------------------------------
-- Importação de prova: onde parou e qual é o gabarito
-- ---------------------------------------------------------------------
-- O cursor de caracteres da 210 não sabe qual foi a última questão numerada
-- que entrou, e o corte de um lote cai no meio de um enunciado.
ALTER TABLE exam_imports ADD COLUMN IF NOT EXISTS last_number integer;
-- Gabarito oficial colado pelo administrador: { "1": "C", "2": "A", ... }.
-- Quando existe, vence a resposta que a IA deduziu.
ALTER TABLE exam_imports ADD COLUMN IF NOT EXISTS answer_key jsonb;

COMMENT ON COLUMN exam_imports.answer_key IS
  'Gabarito oficial por número de questão. Sem ele, todo item entra marcado '
  'como "gabarito sugerido pela IA" e não é importado em lote.';
