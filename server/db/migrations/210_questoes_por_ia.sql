-- =====================================================================
-- Questões geradas por IA e extração de questões de provas em PDF.
--
-- O banco de questões nasceu para ser preenchido à mão, uma questão por vez,
-- ou em lote por CSV. Nenhum dos dois resolve o problema real de quem está
-- montando a plataforma: as provas existem em PDF, com centenas de questões,
-- e digitar isso não acontece. Enquanto o banco está vazio, a prática depois
-- da aula não tem o que mostrar e o simulado não tem o que sortear.
--
-- Duas origens novas passam a alimentar o banco:
--
--   1. a IA, quando falta questão do assunto para o aluno praticar;
--   2. a prova em PDF, lida uma vez e varrida em lotes pelo painel.
--
-- As duas gravam em `questions` como qualquer outra questão — e precisam
-- disso: tentativa, caderno de erros, revisão e simulado referenciam
-- question_id. O que muda é a marca de origem, para o administrador saber
-- o que veio de onde e poder revisar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Origem da questão
-- ---------------------------------------------------------------------
ALTER TABLE questions ADD COLUMN IF NOT EXISTS generated_by_ai boolean NOT NULL DEFAULT false;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS lesson_id uuid REFERENCES lessons(id) ON DELETE SET NULL;

COMMENT ON COLUMN questions.generated_by_ai IS
  'Questão elaborada pela IA, não copiada de prova. Fica ativa como qualquer '
  'outra — o caderno de erros e as revisões filtram por active, e esconder a '
  'questão faria o erro do aluno sumir da lista dele.';
COMMENT ON COLUMN questions.reviewed_at IS
  'Quando o administrador conferiu a questão no painel. Nulo enquanto ninguém olhou.';
COMMENT ON COLUMN questions.lesson_id IS
  'Aula que originou a questão, quando ela foi gerada a partir do conteúdo da aula.';

-- Buscar as questões geradas para uma aula, na dificuldade pedida, é a
-- consulta quente da prática pós-aula.
CREATE INDEX IF NOT EXISTS questions_lesson_idx ON questions (lesson_id, difficulty)
  WHERE lesson_id IS NOT NULL;
-- A fila de revisão do painel: o que a IA criou e ninguém conferiu ainda.
CREATE INDEX IF NOT EXISTS questions_ia_revisao_idx ON questions (created_at DESC)
  WHERE generated_by_ai AND reviewed_at IS NULL;

-- ---------------------------------------------------------------------
-- Registro de uso da IA
-- ---------------------------------------------------------------------
-- A restrição listava só tutor, redação e tema. Sem isto, toda geração de
-- questão falharia ao gravar o consumo — e o registro de uso é o que segura
-- o limite mensal de tokens.
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_feature_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('tutor', 'essay', 'essay_theme', 'questions', 'exam_import', 'other'));

-- ---------------------------------------------------------------------
-- Leitura de prova em PDF
-- ---------------------------------------------------------------------
-- Uma prova do ENEM tem 90 questões e o PDF passa de 10 MB. Isso não cabe em
-- uma requisição: o PDF é lido UMA vez (o texto fica guardado aqui) e depois
-- varrido em lotes, cada lote em sua própria requisição. O estado mora no
-- banco porque a hospedagem reinicia o processo quando quer, e o que estiver
-- só na memória morre junto.
CREATE TABLE IF NOT EXISTS exam_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  past_exam_id  uuid REFERENCES past_exams(id) ON DELETE SET NULL,
  exam_id       uuid REFERENCES exams(id) ON DELETE SET NULL,
  title         text NOT NULL,
  -- O PDF de origem, quando houver. Colar o texto direto também vale.
  source_url    text,
  year          integer,
  board         text,
  status        text NOT NULL DEFAULT 'lendo'
                CHECK (status IN ('lendo', 'pronta', 'extraindo', 'concluida', 'falhou')),
  document_text text,                                   -- o PDF já convertido em texto
  chars_total   integer NOT NULL DEFAULT 0,
  chars_read    integer NOT NULL DEFAULT 0,             -- até onde a varredura chegou
  found_count   integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exam_imports_recentes_idx ON exam_imports (created_at DESC);
CREATE TRIGGER exam_imports_updated BEFORE UPDATE ON exam_imports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cada questão que a varredura encontrou, antes de virar questão de verdade.
-- O administrador confere e manda para o banco; o que ele recusar fica aqui
-- como registro, e não some.
CREATE TABLE IF NOT EXISTS exam_import_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id     uuid NOT NULL REFERENCES exam_imports(id) ON DELETE CASCADE,
  number        integer,                                -- número da questão na prova
  payload       jsonb NOT NULL,                         -- enunciado, alternativas, gabarito, classificação
  status        text NOT NULL DEFAULT 'pendente'
                CHECK (status IN ('pendente', 'importada', 'recusada', 'falhou')),
  question_id   uuid REFERENCES questions(id) ON DELETE SET NULL,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exam_import_items_import_idx ON exam_import_items (import_id, number);
