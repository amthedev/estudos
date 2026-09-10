-- =====================================================================
-- Planos de estudo (a sequência de aulas de cada prova)
--
-- O cliente definiu como o cronograma deve se montar: um dia de videoaula,
-- o dia seguinte com o resumo daquela aula e questões só daquele conteúdo,
-- e assim por diante. A cada quatro semanas, um dia vira prova anterior ou
-- simulado. Domingo é descanso, revisão de erros ou redação.
--
-- A sequência de assuntos (52 semanas de ENEM e 52 de Barro Branco) deixa de
-- ser decidida por pontuação e passa a vir de um plano cadastrado, que o
-- administrador edita pelo painel. O cronograma continua se adaptando ao
-- aluno no encaixe: quem tem menos dias por semana avança mais devagar,
-- na mesma ordem.
-- =====================================================================

CREATE TABLE IF NOT EXISTS study_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id     uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  -- quantas semanas o plano cobre quando o aluno estuda todos os dias previstos
  weeks       integer NOT NULL DEFAULT 52,
  -- ritmo: quantas aulas novas por semana e o que fazer no dia seguinte
  lessons_per_week   integer NOT NULL DEFAULT 3,
  -- a cada quantas semanas o último dia vira prova anterior ou simulado
  exam_every_weeks   integer NOT NULL DEFAULT 4,
  -- treino físico paralelo (Barro Branco): dias da semana 0=domingo
  training_weekdays  smallint[] NOT NULL DEFAULT '{}',
  training_label     text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS study_plans_exam_idx ON study_plans (exam_id, active);
DROP TRIGGER IF EXISTS study_plans_updated ON study_plans;
CREATE TRIGGER study_plans_updated BEFORE UPDATE ON study_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cada item é uma aula nova da sequência. O dia de resumo e questões é
-- derivado dela pelo gerador, não precisa ser cadastrado.
CREATE TABLE IF NOT EXISTS study_plan_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  week        integer,
  subject_id  uuid REFERENCES subjects(id) ON DELETE SET NULL,
  topic_id    uuid REFERENCES topics(id) ON DELETE SET NULL,
  -- título do que estudar, do jeito que o cliente escreveu
  title       text NOT NULL,
  kind        text NOT NULL DEFAULT 'lesson'
              CHECK (kind IN ('lesson', 'essay', 'past_exam', 'simulado', 'review', 'training')),
  notes       text,
  UNIQUE (plan_id, position)
);
CREATE INDEX IF NOT EXISTS study_plan_items_plan_idx ON study_plan_items (plan_id, position);

-- Onde o aluno está na sequência do plano
ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS study_plan_id uuid REFERENCES study_plans(id) ON DELETE SET NULL;
ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS plan_position integer NOT NULL DEFAULT 0;

-- O item do cronograma passa a saber de qual passo do plano ele veio, para
-- o dia de resumo apontar para a aula certa e para o aluno ver o progresso.
ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS plan_item_id uuid REFERENCES study_plan_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS schedule_items_plan_item_idx ON schedule_items (plan_item_id);

-- Novos tipos de atividade: resumo do dia seguinte, treino físico e prova anterior
ALTER TABLE schedule_items DROP CONSTRAINT IF EXISTS schedule_items_type_check;
ALTER TABLE schedule_items ADD CONSTRAINT schedule_items_type_check
  CHECK (type IN ('lesson', 'topic', 'questions', 'review', 'essay', 'simulado', 'custom', 'summary', 'training', 'past_exam', 'rest'));

ALTER TABLE study_logs DROP CONSTRAINT IF EXISTS study_logs_activity_type_check;
ALTER TABLE study_logs ADD CONSTRAINT study_logs_activity_type_check
  CHECK (activity_type IN ('lesson', 'practice', 'questions', 'simulado', 'review', 'essay', 'schedule', 'tutor', 'manual', 'summary', 'training', 'past_exam'));
