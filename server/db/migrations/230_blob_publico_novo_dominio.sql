-- A Square Cloud desligou public-blob.squarecloud.dev em 25/10/2026: todo link
-- salvo com esse domínio passou a redirecionar para um aviso em JSON, e vídeos
-- (aulas, depoimentos, apresentação) ficavam carregando para sempre e a
-- leitura de prova dizia que o arquivo não era PDF. Os arquivos continuam lá,
-- no endereço novo: https://blob.squarecloud.dev/pub/<mesmo caminho>.
-- Troca em toda coluna de texto e jsonb. Rodar de novo não muda nada.
DO $$
DECLARE
  col record;
BEGIN
  FOR col IN
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('text', 'character varying', 'jsonb')
       AND table_name IN (SELECT table_name FROM information_schema.tables
                           WHERE table_schema = 'public' AND table_type = 'BASE TABLE')
  LOOP
    IF col.data_type = 'jsonb' THEN
      EXECUTE format(
        'UPDATE %I SET %I = replace(%I::text, %L, %L)::jsonb WHERE %I::text LIKE %L',
        col.table_name, col.column_name, col.column_name,
        'https://public-blob.squarecloud.dev/', 'https://blob.squarecloud.dev/pub/',
        col.column_name, '%public-blob.squarecloud.dev/%'
      );
    ELSE
      EXECUTE format(
        'UPDATE %I SET %I = replace(%I, %L, %L) WHERE %I LIKE %L',
        col.table_name, col.column_name, col.column_name,
        'https://public-blob.squarecloud.dev/', 'https://blob.squarecloud.dev/pub/',
        col.column_name, '%public-blob.squarecloud.dev/%'
      );
    END IF;
  END LOOP;
END $$;
