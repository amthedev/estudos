-- =====================================================================
-- Gabarito de letra única para as duas línguas (VUNESP).
--
-- O gabarito do INEP traz as duas opções de idioma ("1 B A", sob INGLÊS e
-- ESPANHOL), e a FGV publica uma tabela por língua. A VUNESP publica uma
-- letra só por número, que vale para a prova de inglês e para a de espanhol
-- (questões 39 a 44 do Barro Branco). Sem saber disso, a questão de espanhol
-- ficava sem gabarito (a regra é nunca herdar a letra do inglês) e ia para o
-- banco com a letra deduzida pela IA.
--
-- A marca diz que a folha lida não fala em espanhol: na prova que não é do
-- ENEM, a leitura (services/exam-reading.js) e o gabarito colado depois
-- (PUT /api/admin/exam-imports/:id/answer-key) põem a entrada "N:espanhol"
-- com a mesma letra nas questões que têm a opção de espanhol.
-- =====================================================================

ALTER TABLE exam_imports ADD COLUMN IF NOT EXISTS answer_key_shared boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN exam_imports.answer_key_shared IS
  'true quando o gabarito lido não fala em espanhol: uma letra por número, que vale para as duas línguas (fora do ENEM).';
