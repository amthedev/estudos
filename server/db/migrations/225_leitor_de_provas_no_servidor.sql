-- =====================================================================
-- Leitura de prova no servidor (services/exam-reading.js).
--
-- Até aqui o PDF era lido no navegador do administrador, sem posição, e
-- cortado por expressão regular: a capa caía na questão 1, o rodapé dentro
-- de metade dos enunciados, figura nenhuma era capturada e tudo ia direto
-- para o aluno. Agora o servidor lê o PDF com posição (exam-reader/), recorta
-- as figuras e marca o que precisa de conferência. O caminho antigo continua
-- existindo como plano B (engine = 'texto').
--
-- A leitura no servidor usa o mesmo `status` da varredura em lotes
-- ('extraindo' enquanto trabalha, 'pronta' quando parou no meio, 'concluida'),
-- então o destravamento no boot (scripts/bootstrap.js) vale para as duas.
-- =====================================================================

-- Qual caminho leu esta prova: 'texto' (navegador + lotes) ou 'leitor' (servidor).
ALTER TABLE exam_imports ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'texto'
  CHECK (engine IN ('texto', 'leitor'));
-- Etapa em andamento da leitura no servidor, para a tela dizer o que está
-- acontecendo: 'baixando', 'gabarito', 'lendo', 'classificando'.
ALTER TABLE exam_imports ADD COLUMN IF NOT EXISTS stage text;
-- Progresso da leitura no servidor, em questões (a varredura em lotes conta
-- caracteres em chars_read/chars_total).
ALTER TABLE exam_imports ADD COLUMN IF NOT EXISTS progress_done integer NOT NULL DEFAULT 0;
ALTER TABLE exam_imports ADD COLUMN IF NOT EXISTS progress_total integer NOT NULL DEFAULT 0;
ALTER TABLE exam_imports ADD COLUMN IF NOT EXISTS pages integer;
-- Resumo da leitura: questões, alertas por tipo, figuras, o que foi descartado
-- (capa, redação, cabeçalho), tempo.
ALTER TABLE exam_imports ADD COLUMN IF NOT EXISTS read_report jsonb;

COMMENT ON COLUMN exam_imports.engine IS
  'texto = PDF lido no navegador e varrido em lotes (plano B); leitor = PDF lido no servidor, com figuras e alertas.';

-- Variante de idioma da questão (ENEM dia 1 e VUNESP: inglês e espanhol com o
-- mesmo número). Faz parte da chave da questão dentro da prova: a de espanhol
-- não é a mesma questão que a de inglês e não pode ser deduplicada com ela.
ALTER TABLE exam_import_items ADD COLUMN IF NOT EXISTS variant text
  CHECK (variant IS NULL OR variant IN ('ingles', 'espanhol'));

COMMENT ON COLUMN exam_import_items.variant IS
  'ingles/espanhol quando a prova traz as duas opções com o mesmo número; nulo nas demais.';
