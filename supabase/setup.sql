-- Almabrands Presentaciones — schema Supabase
-- Ejecutar en el SQL Editor del proyecto Supabase.

-- Presentaciones y plantillas
CREATE TABLE IF NOT EXISTS decks (
  id          BIGSERIAL PRIMARY KEY,
  dir         TEXT    NOT NULL,          -- 'presentaciones' | 'plantillas'
  filename    TEXT    NOT NULL,          -- 'mi-deck.html'
  html        TEXT    NOT NULL,
  title       TEXT,
  template    TEXT,
  slides_count INT    DEFAULT 0,
  ficha       JSONB   DEFAULT '{}',
  outline     TEXT[]  DEFAULT '{}',
  byte_size   INT     DEFAULT 0,
  mtime       BIGINT  NOT NULL,          -- ms timestamp (compatible con Date.now())
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(dir, filename)
);
CREATE INDEX IF NOT EXISTS decks_dir_mtime ON decks (dir, mtime DESC);

-- Historial de versiones (últimas 25 por archivo)
CREATE TABLE IF NOT EXISTS deck_versions (
  id          BIGSERIAL PRIMARY KEY,
  dir         TEXT    NOT NULL,
  filename    TEXT    NOT NULL,
  html        TEXT    NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deck_versions_lookup ON deck_versions (dir, filename, created_at DESC);

-- Papelera
CREATE TABLE IF NOT EXISTS deck_trash (
  id          BIGSERIAL PRIMARY KEY,
  dir         TEXT    NOT NULL,
  filename    TEXT    NOT NULL,
  html        TEXT    NOT NULL,
  ficha       JSONB,
  deleted_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Storage bucket "media" ──
-- Crear manualmente en Supabase → Storage → New bucket:
--   Name: media
--   Public: ON  (las imágenes se sirven con URL pública)
--   File size limit: 50 MB
--   Allowed MIME types: image/*

-- ── RLS (habilitar cuando se agregue autenticación) ──
-- ALTER TABLE decks ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE deck_versions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE deck_trash ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Acceso autenticado" ON decks FOR ALL USING (auth.role() = 'authenticated');
