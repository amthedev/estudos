-- Em que bloco de "Resultados" o depoimento em imagem aparece na landing:
--   'foto'     → Aprovados (foto do aluno aprovado)
--   'conversa' → Mensagens recebidas (print da conversa)
-- Antes a landing adivinhava pelo caminho do arquivo, e toda imagem enviada pelo
-- painel caía em "Mensagens recebidas", inclusive as fotos dos aprovados.
-- Depoimento só em texto ou em vídeo fica com NULL.
ALTER TABLE testimonials ADD COLUMN IF NOT EXISTS kind text;

ALTER TABLE testimonials DROP CONSTRAINT IF EXISTS testimonials_kind_check;
ALTER TABLE testimonials
  ADD CONSTRAINT testimonials_kind_check CHECK (kind IS NULL OR kind IN ('foto', 'conversa'));

-- Os prints curados ficam em /assets/results/messages/; o resto das imagens é foto.
UPDATE testimonials SET kind = 'conversa'
 WHERE kind IS NULL AND image_url LIKE '%/results/messages/%';
UPDATE testimonials SET kind = 'foto'
 WHERE kind IS NULL AND image_url IS NOT NULL;
