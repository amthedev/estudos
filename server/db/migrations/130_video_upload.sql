-- =====================================================================
-- Vídeo hospedado pela própria plataforma
--
-- A equipe deixou de usar link do YouTube: as videoaulas passam a ser
-- enviadas em MP4 pelo painel. O arquivo fica no armazenamento da
-- plataforma (uploads/aulas) e o registro dele vive aqui, junto da aula.
--
-- O provedor 'upload' identifica a aula com arquivo próprio. Os antigos
-- continuam válidos para não invalidar o que já estiver cadastrado.
-- =====================================================================

ALTER TABLE lessons DROP CONSTRAINT IF EXISTS lessons_video_provider_check;
ALTER TABLE lessons ADD CONSTRAINT lessons_video_provider_check
  CHECK (video_provider IN ('upload', 'youtube', 'vimeo', 'external', 'none'));

-- dados do arquivo enviado, para o painel mostrar tamanho e formato
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_bytes bigint;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_mime text;
-- duração exata em segundos quando conhecida; duration_min segue sendo o
-- número que o cronograma usa para montar o dia de estudo
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_seconds integer;

COMMENT ON COLUMN lessons.video_url IS
  'Caminho do arquivo servido pela plataforma (/uploads/aulas/...) quando video_provider = upload.';
