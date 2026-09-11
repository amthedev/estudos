-- =====================================================================
-- Foco Elite — schema inicial
-- Convenções:
--   * ids UUID (gen_random_uuid), timestamps com fuso (timestamptz)
--   * slugs únicos para conteúdo administrável (evita duplicidade de aulas)
--   * conteúdo NUNCA é duplicado por prova: aulas/assuntos são vinculados
--     a várias provas por tabelas de ligação (lesson_exams, exam_topics)
-- =====================================================================

-- pgcrypto só é usada aqui por causa de gen_random_uuid(). Do PostgreSQL 13 em
-- diante essa função já vem no núcleo, e num banco gerenciado o usuário da
-- aplicação normalmente não tem permissão para criar extensão — deixar o
-- comando cru aqui derrubava a primeira migration por um motivo que não
-- importa. Tenta criar e segue; a checagem logo abaixo é quem cobra o que o
-- schema realmente precisa.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pgcrypto indisponível: %', SQLERRM; END $$;
DO $$ BEGIN
  PERFORM gen_random_uuid();
EXCEPTION WHEN undefined_function THEN
  RAISE EXCEPTION 'Este banco não tem gen_random_uuid(). Use PostgreSQL 13 ou mais novo, ou habilite a extensão pgcrypto.';
END $$;
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS unaccent;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'unaccent indisponível: %', SQLERRM; END $$;
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm indisponível: %', SQLERRM; END $$;

-- função utilitária de updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

-- busca sem acento (fallback se unaccent não existir)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') THEN
    EXECUTE $f$CREATE OR REPLACE FUNCTION fe_unaccent(text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS 'SELECT public.unaccent($1)'$f$;
  ELSE
    EXECUTE $f$CREATE OR REPLACE FUNCTION fe_unaccent(text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS 'SELECT $1'$f$;
  END IF;
END $$;

-- =====================================================================
-- USUÁRIOS E ACESSO
-- =====================================================================
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  email            text NOT NULL,
  password_hash    text NOT NULL,
  role             text NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  token_version    integer NOT NULL DEFAULT 0,
  avatar_url       text,
  stripe_customer_id text,
  -- liberação manual de acesso pelo admin (ignora assinatura até esta data)
  access_override_until timestamptz,
  last_login_at    timestamptz,
  last_seen_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- e-mail único sem diferenciar maiúsculas
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX users_role_idx ON users (role, status);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- =====================================================================
-- PROVAS / VESTIBULARES (administráveis)
-- =====================================================================
CREATE TABLE exams (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL,
  short_name       text NOT NULL,
  -- trilha: define a experiência (ENEM / Barro Branco / outros vestibulares)
  track            text NOT NULL CHECK (track IN ('enem','barro_branco','vestibular')),
  board            text,                  -- banca (ex.: INEP, VUNESP, FUVEST)
  description      text,
  exam_date        date,                  -- data padrão da próxima prova
  has_essay        boolean NOT NULL DEFAULT true,
  essay_max_score  numeric(6,2) NOT NULL DEFAULT 1000,
  score_max        numeric(6,2),          -- nota máxima da prova objetiva (se aplicável)
  active           boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER exams_updated BEFORE UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- BIBLIOTECA CENTRAL DE CONTEÚDO
-- Área -> Matéria -> Assunto -> Subassunto -> Aula
-- =====================================================================
CREATE TABLE areas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0
);

CREATE TABLE subjects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id     uuid REFERENCES areas(id) ON DELETE SET NULL,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  icon        text NOT NULL DEFAULT 'book-open',   -- nome do ícone do sprite
  color       text NOT NULL DEFAULT '#2F80ED',
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER subjects_updated BEFORE UPDATE ON subjects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE topics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id  uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  name        text NOT NULL,
  description text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, slug)
);
CREATE INDEX topics_subject_idx ON topics (subject_id, sort_order);
CREATE TRIGGER topics_updated BEFORE UPDATE ON topics FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subtopics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id    uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  name        text NOT NULL,
  description text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_id, slug)
);
CREATE INDEX subtopics_topic_idx ON subtopics (topic_id, sort_order);
CREATE TRIGGER subtopics_updated BEFORE UPDATE ON subtopics FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Quais matérias caem em cada prova e com qual peso (usado pelo cronograma)
CREATE TABLE exam_subjects (
  exam_id     uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  subject_id  uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  weight      numeric(5,2) NOT NULL DEFAULT 1.0,
  PRIMARY KEY (exam_id, subject_id)
);

-- Quais assuntos caem em cada prova (edital / conteúdo programático)
CREATE TABLE exam_topics (
  exam_id     uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  topic_id    uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  weight      numeric(5,2) NOT NULL DEFAULT 1.0,
  PRIMARY KEY (exam_id, topic_id)
);
CREATE INDEX exam_topics_topic_idx ON exam_topics (topic_id);

CREATE TABLE lessons (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id     uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  topic_id       uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  subtopic_id    uuid REFERENCES subtopics(id) ON DELETE SET NULL,
  slug           text NOT NULL UNIQUE,
  title          text NOT NULL,
  description    text,
  video_url      text,
  video_provider text NOT NULL DEFAULT 'none' CHECK (video_provider IN ('youtube','vimeo','external','none')),
  thumbnail_url  text,
  duration_min   integer NOT NULL DEFAULT 30,
  teacher_name   text,
  difficulty     smallint NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 3), -- 1 básico, 2 intermediário, 3 avançado
  summary        text,                       -- resumo da aula (markdown)
  sort_order     integer NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  search_vector  tsvector,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lessons_topic_idx ON lessons (topic_id, sort_order);
CREATE INDEX lessons_subject_idx ON lessons (subject_id);
CREATE INDEX lessons_search_idx ON lessons USING gin (search_vector);
CREATE TRIGGER lessons_updated BEFORE UPDATE ON lessons FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION lessons_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('portuguese', fe_unaccent(coalesce(NEW.title,''))), 'A') ||
    setweight(to_tsvector('portuguese', fe_unaccent(coalesce(NEW.description,''))), 'B') ||
    setweight(to_tsvector('portuguese', fe_unaccent(coalesce(NEW.summary,''))), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lessons_search BEFORE INSERT OR UPDATE OF title, description, summary ON lessons
  FOR EACH ROW EXECUTE FUNCTION lessons_search_update();

-- Tags: em quais provas a aula cai (uma aula, várias provas)
CREATE TABLE lesson_exams (
  lesson_id  uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  exam_id    uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  PRIMARY KEY (lesson_id, exam_id)
);
CREATE INDEX lesson_exams_exam_idx ON lesson_exams (exam_id);

-- =====================================================================
-- PERFIL DO ALUNO (onboarding)
-- =====================================================================
CREATE TABLE student_profiles (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  exam_id              uuid REFERENCES exams(id) ON DELETE SET NULL,
  other_exam_name      text,                       -- vestibular digitado quando não cadastrado
  study_days           smallint[] NOT NULL DEFAULT '{}', -- 0=domingo ... 6=sábado
  hours_per_day        numeric(4,2) NOT NULL DEFAULT 2,
  level                text NOT NULL DEFAULT 'iniciante' CHECK (level IN ('iniciante','intermediario','avancado')),
  weakest_subject_id   uuid REFERENCES subjects(id) ON DELETE SET NULL,
  exam_date            date,
  target_course        text,
  target_university    text,
  target_score         text,
  main_difficulty      text,
  performance_goal     text,
  weekly_goal_hours    numeric(5,2),
  onboarding_completed boolean NOT NULL DEFAULT false,
  schedule_generated_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER student_profiles_updated BEFORE UPDATE ON student_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- QUESTÕES
-- =====================================================================
CREATE TABLE questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id    uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  topic_id      uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  subtopic_id   uuid REFERENCES subtopics(id) ON DELETE SET NULL,
  statement     text NOT NULL,             -- enunciado (markdown permitido)
  image_url     text,
  resolution    text,                      -- resolução passo a passo
  explanation   text,                      -- explicação da resposta
  difficulty    smallint NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 3),
  source_exam_id uuid REFERENCES exams(id) ON DELETE SET NULL, -- prova de origem (concurso)
  year          integer,
  board         text,                      -- banca
  source        text,                      -- referência livre
  active        boolean NOT NULL DEFAULT true,
  search_vector tsvector,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_topic_idx ON questions (topic_id);
CREATE INDEX questions_subject_idx ON questions (subject_id);
CREATE INDEX questions_filters_idx ON questions (subject_id, difficulty, year);
CREATE INDEX questions_search_idx ON questions USING gin (search_vector);
CREATE TRIGGER questions_updated BEFORE UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION questions_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('portuguese', fe_unaccent(coalesce(NEW.statement,'')));
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER questions_search BEFORE INSERT OR UPDATE OF statement ON questions
  FOR EACH ROW EXECUTE FUNCTION questions_search_update();

CREATE TABLE question_options (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id  uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  letter       char(1) NOT NULL,
  text         text NOT NULL,
  is_correct   boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  UNIQUE (question_id, letter)
);
CREATE INDEX question_options_q_idx ON question_options (question_id, sort_order);

-- Em quais provas a questão é relevante (filtro "prova")
CREATE TABLE question_exams (
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  exam_id     uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, exam_id)
);
CREATE INDEX question_exams_exam_idx ON question_exams (exam_id);

-- Toda resposta do aluno passa por aqui (fonte única de desempenho)
CREATE TABLE question_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id        uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  subject_id         uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  topic_id           uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  selected_option_id uuid REFERENCES question_options(id) ON DELETE SET NULL,
  is_correct         boolean NOT NULL,
  context            text NOT NULL CHECK (context IN ('practice','bank','simulado','review','errors_redo')),
  context_id         uuid,                 -- lesson_id, simulado_attempt_id ou review_id
  time_spent_sec     integer,
  answered_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX question_attempts_user_idx ON question_attempts (user_id, answered_at DESC);
CREATE INDEX question_attempts_user_topic_idx ON question_attempts (user_id, topic_id);
CREATE INDEX question_attempts_user_subject_idx ON question_attempts (user_id, subject_id);
CREATE INDEX question_attempts_ctx_idx ON question_attempts (context, context_id);

-- Caderno de erros
CREATE TABLE error_notebook (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id      uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  subject_id       uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  topic_id         uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  wrong_option_id  uuid REFERENCES question_options(id) ON DELETE SET NULL,
  times_wrong      integer NOT NULL DEFAULT 1,
  resolved         boolean NOT NULL DEFAULT false,  -- acertou ao refazer
  resolved_at      timestamptz,
  notes            text,
  added_at         timestamptz NOT NULL DEFAULT now(),
  last_wrong_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, question_id)
);
CREATE INDEX error_notebook_user_idx ON error_notebook (user_id, resolved, last_wrong_at DESC);

-- =====================================================================
-- PROGRESSO, ANOTAÇÕES, FAVORITOS, REGISTRO DE ESTUDO
-- =====================================================================
CREATE TABLE lesson_progress (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id     uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  PRIMARY KEY (user_id, lesson_id)
);
CREATE INDEX lesson_progress_user_idx ON lesson_progress (user_id, status);

CREATE TABLE notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id   uuid REFERENCES lessons(id) ON DELETE SET NULL,
  subject_id  uuid REFERENCES subjects(id) ON DELETE SET NULL,
  topic_id    uuid REFERENCES topics(id) ON DELETE SET NULL,
  title       text NOT NULL DEFAULT '',
  content     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- uma anotação por aula por aluno (a anotação da aula); resumos avulsos têm lesson_id nulo
CREATE UNIQUE INDEX notes_user_lesson_unique ON notes (user_id, lesson_id) WHERE lesson_id IS NOT NULL;
CREATE INDEX notes_user_idx ON notes (user_id, updated_at DESC);
CREATE TRIGGER notes_updated BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE favorites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type  text NOT NULL CHECK (item_type IN ('lesson','question','topic','note')),
  item_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, item_type, item_id)
);

-- Registro de tempo de estudo (para horas estudadas e sequência de dias)
CREATE TABLE study_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_type text NOT NULL CHECK (activity_type IN ('lesson','practice','questions','simulado','review','essay','schedule','tutor','manual')),
  ref_id        uuid,
  subject_id    uuid REFERENCES subjects(id) ON DELETE SET NULL,
  minutes       integer NOT NULL DEFAULT 0,
  study_date    date NOT NULL DEFAULT current_date,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX study_logs_user_date_idx ON study_logs (user_id, study_date DESC);

-- =====================================================================
-- CRONOGRAMA E REVISÕES
-- =====================================================================
CREATE TABLE reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id      uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  lesson_id     uuid REFERENCES lessons(id) ON DELETE CASCADE,
  stage         smallint NOT NULL CHECK (stage IN (1,2,3)),  -- 1 = +1 dia, 2 = +7 dias, 3 = +30 dias
  due_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
  score         numeric(5,2),              -- % de acerto na revisão
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_user_due_idx ON reviews (user_id, status, due_date);
CREATE UNIQUE INDEX reviews_unique_stage ON reviews (user_id, lesson_id, stage) WHERE lesson_id IS NOT NULL;

CREATE TABLE schedule_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          date NOT NULL,
  position      integer NOT NULL DEFAULT 0,
  type          text NOT NULL CHECK (type IN ('lesson','topic','questions','review','essay','simulado','custom')),
  title         text NOT NULL,
  subject_id    uuid REFERENCES subjects(id) ON DELETE SET NULL,
  topic_id      uuid REFERENCES topics(id) ON DELETE SET NULL,
  lesson_id     uuid REFERENCES lessons(id) ON DELETE SET NULL,
  review_id     uuid REFERENCES reviews(id) ON DELETE SET NULL,
  duration_min  integer NOT NULL DEFAULT 30,
  start_time    time,                      -- horário opcional definido pelo aluno
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped','missed')),
  completed_at  timestamptz,
  generated     boolean NOT NULL DEFAULT true,   -- false = criado manualmente pelo aluno
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedule_items_user_date_idx ON schedule_items (user_id, date, position);
CREATE TRIGGER schedule_items_updated BEFORE UPDATE ON schedule_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- SIMULADOS
-- =====================================================================
-- Modelos de simulado (admin) — opcional; alunos também geram simulados dinâmicos
CREATE TABLE simulados (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  description    text,
  type           text NOT NULL CHECK (type IN ('exam','subject','topic','custom')),
  exam_id        uuid REFERENCES exams(id) ON DELETE SET NULL,
  subject_id     uuid REFERENCES subjects(id) ON DELETE SET NULL,
  topic_id       uuid REFERENCES topics(id) ON DELETE SET NULL,
  duration_min   integer NOT NULL DEFAULT 60,
  question_count integer NOT NULL DEFAULT 20,
  question_ids   uuid[] NOT NULL DEFAULT '{}',    -- vazio = sorteado pelos filtros
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER simulados_updated BEFORE UPDATE ON simulados FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE simulado_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  simulado_id    uuid REFERENCES simulados(id) ON DELETE SET NULL,
  title          text NOT NULL,
  type           text NOT NULL CHECK (type IN ('exam','subject','topic','custom')),
  exam_id        uuid REFERENCES exams(id) ON DELETE SET NULL,
  subject_id     uuid REFERENCES subjects(id) ON DELETE SET NULL,
  topic_id       uuid REFERENCES topics(id) ON DELETE SET NULL,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  question_ids   uuid[] NOT NULL,
  answers        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {question_id: option_id} durante a prova
  duration_min   integer NOT NULL DEFAULT 60,
  status         text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','finished','abandoned')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  time_spent_sec integer,
  score          numeric(6,2),             -- 0..100
  correct_count  integer,
  wrong_count    integer,
  blank_count    integer,
  breakdown      jsonb                     -- desempenho por matéria/assunto calculado ao finalizar
);
CREATE INDEX simulado_attempts_user_idx ON simulado_attempts (user_id, started_at DESC);

-- =====================================================================
-- PROVAS ANTERIORES
-- =====================================================================
CREATE TABLE past_exams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id         uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  year            integer NOT NULL,
  day             smallint,                -- ENEM: 1 ou 2
  title           text NOT NULL,
  board           text,
  pdf_url         text,
  answer_key_url  text,                    -- gabarito
  external_url    text,
  notes           text,
  sort_order      integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX past_exams_exam_idx ON past_exams (exam_id, year DESC);
CREATE TRIGGER past_exams_updated BEFORE UPDATE ON past_exams FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- REDAÇÃO
-- =====================================================================
-- Critérios de correção por prova (editáveis pelo admin). Usados no prompt da IA.
CREATE TABLE essay_criteria_sets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id       uuid NOT NULL UNIQUE REFERENCES exams(id) ON DELETE CASCADE,
  name          text NOT NULL,
  max_score     numeric(6,2) NOT NULL DEFAULT 1000,
  genre         text NOT NULL DEFAULT 'Texto dissertativo-argumentativo',
  -- [{key, name, max, description, guidance}]
  criteria      jsonb NOT NULL DEFAULT '[]'::jsonb,
  instructions  text,                      -- orientações extras para o corretor IA
  min_lines     integer,
  max_lines     integer,
  active        boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER essay_criteria_updated BEFORE UPDATE ON essay_criteria_sets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE essay_themes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id        uuid REFERENCES exams(id) ON DELETE SET NULL,  -- nulo = serve para todas
  title          text NOT NULL,
  prompt_text    text,                     -- proposta
  support_texts  text,                     -- textos motivadores
  source         text,
  year           integer,
  generated_by_ai boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX essay_themes_exam_idx ON essay_themes (exam_id, active);
CREATE TRIGGER essay_themes_updated BEFORE UPDATE ON essay_themes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE essays (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id       uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
  theme_id      uuid REFERENCES essay_themes(id) ON DELETE SET NULL,
  theme_title   text NOT NULL,
  content       text NOT NULL DEFAULT '',
  word_count    integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','corrected','failed')),
  score         numeric(6,2),
  max_score     numeric(6,2),
  -- {summary, criteria:[{key,name,score,max,comment}], strengths[], weaknesses[],
  --  grammar_errors[{excerpt,fix,explanation}], argumentation, repertoire, structure,
  --  cohesion, intervention_proposal, suggestions[]}
  correction    jsonb,
  model         text,
  error_message text,
  submitted_at  timestamptz,
  corrected_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX essays_user_idx ON essays (user_id, created_at DESC);
CREATE TRIGGER essays_updated BEFORE UPDATE ON essays FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- TUTOR IA
-- =====================================================================
CREATE TABLE tutor_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT 'Nova conversa',
  exam_id     uuid REFERENCES exams(id) ON DELETE SET NULL,
  subject_id  uuid REFERENCES subjects(id) ON DELETE SET NULL,
  topic_id    uuid REFERENCES topics(id) ON DELETE SET NULL,
  lesson_id   uuid REFERENCES lessons(id) ON DELETE SET NULL,
  question_id uuid REFERENCES questions(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tutor_conversations_user_idx ON tutor_conversations (user_id, updated_at DESC);
CREATE TRIGGER tutor_conversations_updated BEFORE UPDATE ON tutor_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tutor_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES tutor_conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user','assistant')),
  content          text NOT NULL,
  tokens           integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tutor_messages_conv_idx ON tutor_messages (conversation_id, created_at);

-- Uso da OpenAI (métricas e limite mensal no painel)
CREATE TABLE ai_usage (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  feature            text NOT NULL CHECK (feature IN ('tutor','essay','essay_theme','other')),
  model              text,
  prompt_tokens      integer NOT NULL DEFAULT 0,
  completion_tokens  integer NOT NULL DEFAULT 0,
  total_tokens       integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
  error_message      text,
  latency_ms         integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_created_idx ON ai_usage (created_at DESC);
CREATE INDEX ai_usage_user_idx ON ai_usage (user_id, created_at DESC);

-- =====================================================================
-- ASSINATURAS (Stripe)
-- =====================================================================
CREATE TABLE plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  description       text,
  price_cents       integer NOT NULL DEFAULT 0,
  currency          text NOT NULL DEFAULT 'brl',
  interval          text NOT NULL DEFAULT 'month' CHECK (interval IN ('month','year')),
  interval_count    integer NOT NULL DEFAULT 1,
  trial_days        integer NOT NULL DEFAULT 0,
  stripe_product_id text,
  stripe_price_id   text,
  features          jsonb NOT NULL DEFAULT '[]'::jsonb,
  highlight         boolean NOT NULL DEFAULT false,
  active            boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER plans_updated BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id                 uuid REFERENCES plans(id) ON DELETE SET NULL,
  stripe_customer_id      text,
  stripe_subscription_id  text UNIQUE,
  status                  text NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid','paused')),
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean NOT NULL DEFAULT false,
  canceled_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id, status);
CREATE TRIGGER subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- idempotência do webhook
CREATE TABLE stripe_events (
  id            text PRIMARY KEY,          -- evt_...
  type          text NOT NULL,
  payload       jsonb,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- AULAS PARTICULARES (professores e agendamentos)
-- =====================================================================
CREATE TABLE teachers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  email              text,
  phone              text,
  bio                text,
  photo_url          text,
  hourly_price_cents integer NOT NULL DEFAULT 0,
  slot_minutes       integer NOT NULL DEFAULT 60,
  meeting_link       text,                 -- link padrão (Meet/Zoom) enviado ao confirmar
  active             boolean NOT NULL DEFAULT true,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER teachers_updated BEFORE UPDATE ON teachers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE teacher_subjects (
  teacher_id  uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  subject_id  uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (teacher_id, subject_id)
);

CREATE TABLE teacher_availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  CHECK (end_time > start_time)
);
CREATE INDEX teacher_availability_idx ON teacher_availability (teacher_id, weekday);

CREATE TABLE bookings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  teacher_id     uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  subject_id     uuid REFERENCES subjects(id) ON DELETE SET NULL,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','completed')),
  student_notes  text,
  admin_notes    text,
  meeting_link   text,
  price_cents    integer NOT NULL DEFAULT 0,
  cancelled_by   text CHECK (cancelled_by IN ('student','admin')),
  cancel_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX bookings_user_idx ON bookings (user_id, starts_at DESC);
CREATE INDEX bookings_teacher_idx ON bookings (teacher_id, starts_at);
-- impede dois agendamentos ativos no mesmo horário com o mesmo professor
CREATE UNIQUE INDEX bookings_teacher_slot_unique ON bookings (teacher_id, starts_at) WHERE status IN ('pending','confirmed');
CREATE TRIGGER bookings_updated BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- CONFIGURAÇÕES, AUDITORIA E SAÚDE DA PLATAFORMA
-- =====================================================================
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,               -- ex.: lesson.create, student.block
  entity      text,
  entity_id   uuid,
  data        jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

CREATE TABLE error_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level       text NOT NULL DEFAULT 'error',
  message     text NOT NULL,
  stack       text,
  path        text,
  method      text,
  user_id     uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX error_logs_created_idx ON error_logs (created_at DESC);
