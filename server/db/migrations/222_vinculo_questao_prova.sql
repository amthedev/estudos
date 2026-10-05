-- =====================================================================
-- Cada questão importada sabe de qual leitura e de qual prova veio.
--
-- A leitura de prova em PDF gravava as questões no banco e o único elo de
-- volta era exam_import_items.question_id. Esse elo morre junto com a
-- leitura: excluir a leitura apaga os itens em cascata e deixa as questões
-- soltas no banco, sem nada que diga de onde saíram. Quando uma prova entra
-- errada (enunciado com a capa colada, alternativa cortada, imagem perdida),
-- o administrador precisa tirar TODAS as questões dela para ler de novo — e
-- sem o vínculo isso vira caça uma a uma no banco.
--
-- Daqui em diante a própria questão guarda a leitura e a prova anterior de
-- origem. As duas colunas ficam nulas quando a leitura ou a prova são
-- excluídas: a questão continua valendo para o aluno, só perde a etiqueta.
-- =====================================================================

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS exam_import_id uuid REFERENCES exam_imports(id) ON DELETE SET NULL;
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS past_exam_id uuid REFERENCES past_exams(id) ON DELETE SET NULL;

COMMENT ON COLUMN questions.exam_import_id IS
  'Leitura de prova em PDF que gravou esta questão. Nula para questão cadastrada à mão, por planilha ou pela IA.';
COMMENT ON COLUMN questions.past_exam_id IS
  'Prova anterior de onde a questão foi lida. É por aqui que o painel remove as questões de uma prova para lê-la de novo.';

CREATE INDEX IF NOT EXISTS questions_exam_import_idx ON questions (exam_import_id)
  WHERE exam_import_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS questions_past_exam_idx ON questions (past_exam_id)
  WHERE past_exam_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Backfill: o que as leituras que ainda existem já sabem
-- ---------------------------------------------------------------------
-- Uma questão pode estar ligada a itens de mais de uma leitura (a releitura
-- reaproveita a questão que a anterior gravou). A origem é a leitura mais
-- antiga; a prova anterior é a mesma em todas, porque o reaproveitamento só
-- acontece entre leituras da mesma prova.
--
-- O gatilho de updated_at fica desligado durante o preenchimento: carimbar
-- todas as questões importadas como "editadas hoje" seria mentira, e a lista
-- do painel ordena e mostra essa data.
ALTER TABLE questions DISABLE TRIGGER questions_updated;

WITH origem AS (
  SELECT DISTINCT ON (it.question_id) it.question_id, it.import_id
    FROM exam_import_items it
   WHERE it.question_id IS NOT NULL
   ORDER BY it.question_id, it.created_at, it.id
)
UPDATE questions q
   SET exam_import_id = o.import_id
  FROM origem o
 WHERE q.id = o.question_id
   AND q.exam_import_id IS NULL;

WITH prova AS (
  SELECT DISTINCT ON (it.question_id) it.question_id, i.past_exam_id
    FROM exam_import_items it
    JOIN exam_imports i ON i.id = it.import_id
   WHERE it.question_id IS NOT NULL
     AND i.past_exam_id IS NOT NULL
   ORDER BY it.question_id, it.created_at, it.id
)
UPDATE questions q
   SET past_exam_id = p.past_exam_id
  FROM prova p
 WHERE q.id = p.question_id
   AND q.past_exam_id IS NULL;

ALTER TABLE questions ENABLE TRIGGER questions_updated;

-- ---------------------------------------------------------------------
-- Índices por questão nas tabelas que a exclusão alcança
-- ---------------------------------------------------------------------
-- Remover uma prova apaga dezenas de questões de uma vez, e cada uma dispara
-- a cascata (ou o SET NULL) nestas tabelas. Sem índice por questão, cada
-- cascata é uma varredura inteira da tabela — com o histórico de respostas de
-- todos os alunos, isso segurava a requisição por segundos. O mesmo índice
-- serve à conta de impacto mostrada antes da confirmação e à taxa de acerto
-- por questão do painel.
CREATE INDEX IF NOT EXISTS question_attempts_question_idx ON question_attempts (question_id);
CREATE INDEX IF NOT EXISTS error_notebook_question_idx ON error_notebook (question_id);
CREATE INDEX IF NOT EXISTS exam_import_items_question_idx ON exam_import_items (question_id)
  WHERE question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tutor_conversations_question_idx ON tutor_conversations (question_id)
  WHERE question_id IS NOT NULL;
