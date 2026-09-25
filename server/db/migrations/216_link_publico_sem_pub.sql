-- Links do Blob salvos com "pub/" não abrem: a chave do objeto começa com
-- "pub/", mas o domínio público serve sem esse trecho (com ele, 404). A
-- videoaula subia inteira e o player ficava cinza. O código novo já monta o
-- link certo (storage/squarecloud.js → publicUrl); aqui corrigimos o que ficou
-- gravado, em qualquer coluna de texto (vídeo, miniatura, foto, depoimento...).
-- Rodar de novo não muda nada: um link já corrigido não casa com o padrão.
DO $$
DECLARE
  col record;
BEGIN
  FOR col IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('text', 'character varying')
  LOOP
    EXECUTE format(
      'UPDATE %I SET %I = replace(%I, %L, %L) WHERE %I LIKE %L',
      col.table_name, col.column_name, col.column_name,
      'public-blob.squarecloud.dev/pub/', 'public-blob.squarecloud.dev/',
      col.column_name, '%public-blob.squarecloud.dev/pub/%'
    );
  END LOOP;
END $$;
