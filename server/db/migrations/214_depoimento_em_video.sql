-- Depoimento em vídeo na landing: aluno falando em vídeo, além do print (image_url)
-- e do texto (content). O vídeo é enviado ao Blob e a URL pública fica aqui.
ALTER TABLE testimonials ADD COLUMN IF NOT EXISTS video_url text;

-- A regra antiga exigia texto OU imagem. Agora o vídeo também basta por si só.
ALTER TABLE testimonials DROP CONSTRAINT IF EXISTS testimonials_content_check;
ALTER TABLE testimonials DROP CONSTRAINT IF EXISTS testimonials_check;
ALTER TABLE testimonials
  ADD CONSTRAINT testimonials_tem_conteudo
  CHECK (content IS NOT NULL OR image_url IS NOT NULL OR video_url IS NOT NULL);
