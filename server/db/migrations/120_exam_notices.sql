-- =====================================================================
-- Editais das provas
--
-- O cliente pediu no escopo: "cadastrar e atualizar editais". O edital é o
-- documento oficial que abre cada certame e traz as datas, as vagas e o
-- conteúdo programático. Ele muda todo ano, então fica em tabela própria
-- com histórico, e não em colunas da prova.
--
-- O aluno enxerga o edital vigente da prova que escolheu; o administrador
-- cadastra, publica e arquiva pelo painel.
-- =====================================================================

CREATE TABLE IF NOT EXISTS exam_notices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id            uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  year               integer NOT NULL,
  title              text NOT NULL,
  -- rascunho: só o administrador vê. publicado: aparece para o aluno.
  -- arquivado: edital de ano anterior, mantido para consulta.
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  board              text,                    -- banca organizadora
  pdf_url            text,                    -- PDF oficial do edital
  external_url       text,                    -- página do certame
  summary            text,                    -- resumo em markdown escrito pela equipe
  -- datas do certame (todas opcionais: o edital nem sempre traz todas)
  published_at       date,
  registration_start date,
  registration_end   date,
  exam_date          date,
  second_exam_date   date,                    -- ENEM tem dois domingos
  result_date        date,
  vacancies          integer,
  fee_cents          integer,                 -- taxa de inscrição
  -- pontos de atenção destacados pela equipe: [{ label, value }]
  highlights         jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes              text,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (registration_end IS NULL OR registration_start IS NULL OR registration_end >= registration_start)
);

-- um edital por prova e ano
CREATE UNIQUE INDEX IF NOT EXISTS exam_notices_exam_year_unique ON exam_notices (exam_id, year);
CREATE INDEX IF NOT EXISTS exam_notices_exam_idx ON exam_notices (exam_id, status, year DESC);

DROP TRIGGER IF EXISTS exam_notices_updated ON exam_notices;
CREATE TRIGGER exam_notices_updated BEFORE UPDATE ON exam_notices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Configuração do provedor de pagamento: a escolha fica no banco (o painel
-- edita), as chaves continuam só no ambiente. 'auto' significa "usar o provedor
-- que estiver com chave configurada"; asaas, stripe ou none forçam a escolha.
INSERT INTO settings (key, value)
VALUES ('payment_provider', to_jsonb('auto'::text))
ON CONFLICT (key) DO NOTHING;
