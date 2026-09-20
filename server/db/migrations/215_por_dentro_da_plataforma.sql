-- "Por dentro da plataforma": galeria de telas reais que a landing mostra logo
-- após o hero, para o visitante ver como é a plataforma antes de comprar.
-- As imagens ficam em public/assets/platform-tour e são servidas estaticamente.
CREATE TABLE IF NOT EXISTS platform_tour (
  id          serial PRIMARY KEY,
  title       text NOT NULL,
  caption     text,
  image_url   text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_tour_ordem ON platform_tour (active, sort_order);
