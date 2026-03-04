CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9_-]{3,64}$'),
  label TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL REFERENCES promo_codes(code) ON DELETE RESTRICT,
  session_id CHAR(16) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  credits_applied INTEGER NOT NULL CHECK (credits_applied > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, session_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_session_created_at
  ON promo_redemptions (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code_created_at
  ON promo_redemptions (code, created_at DESC);

CREATE OR REPLACE FUNCTION set_promo_codes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_promo_codes_updated_at ON promo_codes;

CREATE TRIGGER trg_promo_codes_updated_at
BEFORE UPDATE ON promo_codes
FOR EACH ROW
EXECUTE FUNCTION set_promo_codes_updated_at();

INSERT INTO promo_codes (code, label, credits, max_uses, used_count, active)
VALUES ('FLOW26', 'Promo FLOW26', 200, 1500, 0, true)
ON CONFLICT (code) DO NOTHING;
