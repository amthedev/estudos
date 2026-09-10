-- =====================================================================
-- Módulo IA — conversas do Tutor podem ter uma redação como contexto
-- ("Perguntar ao Tutor sobre esta correção").
-- =====================================================================
ALTER TABLE tutor_conversations
  ADD COLUMN IF NOT EXISTS essay_id uuid REFERENCES essays(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tutor_conversations_essay_idx ON tutor_conversations (essay_id) WHERE essay_id IS NOT NULL;
