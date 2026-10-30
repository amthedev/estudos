-- Capa da matéria: todas as aulas de uma matéria usam a mesma capa, então a
-- equipe envia a imagem uma vez na matéria em vez de aula por aula. A aula sem
-- miniatura própria recebe a capa da matéria ao ser cadastrada, e trocar a capa
-- da matéria troca a das aulas que estavam com a capa anterior.
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS cover_url text;
