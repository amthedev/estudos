-- =====================================================================
-- Uma aula pode cobrir até três assuntos.
--
-- Até aqui cada aula pertencia a um assunto só (lessons.topic_id). Uma aula
-- chamada "Razão e Proporção, Regra de Três e Porcentagem" ficava cadastrada
-- inteira em Porcentagem: não aparecia na página de Regra de Três e a prática
-- depois dela saía com as três questões do mesmo assunto.
--
-- lesson_topics guarda os assuntos da aula na ordem do título (posição 1 a 3).
-- lessons.topic_id CONTINUA existindo e continua NOT NULL: é o assunto
-- principal, igual à posição 1. As dezenas de consultas que só precisam de um
-- assunto por aula (cronograma, revisões, navegação) seguem funcionando sem
-- mudança — e sem contar a mesma aula três vezes.
--
-- Todos os assuntos de uma aula pertencem à matéria dela (lessons.subject_id);
-- quem garante isso é o código de escrita (server/services/lesson-topics.js).
-- =====================================================================

CREATE TABLE IF NOT EXISTS lesson_topics (
  lesson_id   uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position    smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  topic_id    uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  subtopic_id uuid REFERENCES subtopics(id) ON DELETE SET NULL,
  -- trecho do título que deu origem ao vínculo, ex.: 'Regra de Três'
  label       text,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ia','legado')),
  PRIMARY KEY (lesson_id, position)
);

COMMENT ON TABLE lesson_topics IS
  'Assuntos de cada aula, na ordem do título. A posição 1 é sempre igual a lessons.topic_id/subtopic_id.';
COMMENT ON COLUMN lesson_topics.source IS
  'manual = escolhido no painel; ia = identificado automaticamente pelo título; legado = veio do assunto único da aula.';

-- Página do assunto, progresso e contagens procuram as aulas pelo assunto.
CREATE INDEX IF NOT EXISTS lesson_topics_topic_idx ON lesson_topics (topic_id);

-- O mesmo assunto não entra duas vezes na mesma aula. Dois subassuntos do
-- mesmo assunto podem ("Gráfico da função afim" e "Zero da função afim").
CREATE UNIQUE INDEX IF NOT EXISTS lesson_topics_unico_idx
  ON lesson_topics (lesson_id, topic_id, coalesce(subtopic_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------------
-- Backfill: as aulas que já existem ficam com o assunto que já tinham
-- ---------------------------------------------------------------------
INSERT INTO lesson_topics (lesson_id, position, topic_id, subtopic_id, label, source)
SELECT l.id, 1, l.topic_id, l.subtopic_id, NULL, 'legado'
  FROM lessons l
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- A posição 1 acompanha o assunto principal sozinha
-- ---------------------------------------------------------------------
-- Há aula nascendo por mais de um caminho: o painel, o seed de demonstração
-- (que roda a cada subida) e os testes. Se só o painel gravasse
-- lesson_topics, toda aula vinda dos outros caminhos sumiria das telas que
-- passam a ler os assuntos por esta tabela. O gatilho mantém a regra em
-- qualquer caminho: inserir a aula ou trocar o principal atualiza a posição 1.
-- Quando o painel já gravou lesson_topics antes (caso normal), não há nada a
-- fazer e o gatilho sai na primeira conferência.
CREATE OR REPLACE FUNCTION lesson_topics_principal() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.topic_id IS NOT DISTINCT FROM OLD.topic_id
     AND NEW.subtopic_id IS NOT DISTINCT FROM OLD.subtopic_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM lesson_topics
              WHERE lesson_id = NEW.id AND position = 1
                AND topic_id = NEW.topic_id
                AND subtopic_id IS NOT DISTINCT FROM NEW.subtopic_id) THEN
    RETURN NEW;
  END IF;
  -- o novo principal pode já ser um assunto secundário da aula: sai de lá
  -- para não ficar repetido
  DELETE FROM lesson_topics
   WHERE lesson_id = NEW.id AND position > 1
     AND topic_id = NEW.topic_id
     AND subtopic_id IS NOT DISTINCT FROM NEW.subtopic_id;
  INSERT INTO lesson_topics (lesson_id, position, topic_id, subtopic_id, label, source)
  VALUES (NEW.id, 1, NEW.topic_id, NEW.subtopic_id, NULL, 'legado')
  ON CONFLICT (lesson_id, position) DO UPDATE
     SET topic_id = EXCLUDED.topic_id,
         subtopic_id = EXCLUDED.subtopic_id,
         label = NULL,
         source = 'legado';
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lessons_assunto_principal ON lessons;
CREATE TRIGGER lessons_assunto_principal
  AFTER INSERT OR UPDATE OF topic_id, subtopic_id ON lessons
  FOR EACH ROW EXECUTE FUNCTION lesson_topics_principal();

-- Excluir um subassunto põe NULL no vínculo. Se a mesma aula já tem o assunto
-- dele sem subassunto, o NULL repetiria o par e a exclusão do subassunto
-- falharia no índice único. O vínculo mais específico sai antes.
CREATE OR REPLACE FUNCTION lesson_topics_subassunto_excluido() RETURNS trigger AS $$
BEGIN
  DELETE FROM lesson_topics lt
   WHERE lt.subtopic_id = OLD.id
     AND EXISTS (SELECT 1 FROM lesson_topics o
                  WHERE o.lesson_id = lt.lesson_id
                    AND o.topic_id = lt.topic_id
                    AND o.subtopic_id IS NULL);
  RETURN OLD;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS subtopics_lesson_topics ON subtopics;
CREATE TRIGGER subtopics_lesson_topics
  BEFORE DELETE ON subtopics
  FOR EACH ROW EXECUTE FUNCTION lesson_topics_subassunto_excluido();

-- ---------------------------------------------------------------------
-- Questões da aula geradas em segundo plano
-- ---------------------------------------------------------------------
-- Cadastrar a aula (ou trocar os assuntos dela) põe 'pending'; um processo em
-- segundo plano gera as questões e marca 'ready' ou 'failed'. O estado mora
-- no banco porque o servidor reinicia no meio do trabalho: o que estava em
-- 'generating' volta para a fila em vez de ficar preso.
-- As aulas que já existem ficam em 'none': gerar para o acervo inteiro de uma
-- vez, no primeiro deploy, é gasto de IA que ninguém pediu.
ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS questions_status text NOT NULL DEFAULT 'none'
    CHECK (questions_status IN ('none','pending','generating','ready','failed'));
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS questions_error text;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS questions_updated_at timestamptz;

COMMENT ON COLUMN lessons.questions_status IS
  'Geração das questões da aula: none (nunca pedida), pending (na fila), generating, ready, failed.';

-- A fila só olha as poucas aulas pendentes ou em andamento.
CREATE INDEX IF NOT EXISTS lessons_questions_fila_idx
  ON lessons (questions_updated_at)
  WHERE questions_status IN ('pending','generating');
