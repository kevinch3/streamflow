-- Keep only the earliest redemption per promo code (if duplicates already exist)
DELETE FROM promo_redemptions pr
USING promo_redemptions newer
WHERE pr.code = newer.code
  AND (
    pr.created_at > newer.created_at
    OR (pr.created_at = newer.created_at AND pr.id > newer.id)
  );

-- Switch from per-session redemption uniqueness to global single-use per code
ALTER TABLE promo_redemptions
  DROP CONSTRAINT IF EXISTS promo_redemptions_code_session_id_key;

ALTER TABLE promo_redemptions
  ADD CONSTRAINT promo_redemptions_code_key UNIQUE (code);

-- Promo codes are now globally single-use
UPDATE promo_codes
   SET max_uses = 1;

-- Reconcile used_count with persisted redemptions and disable already-used codes
WITH usage AS (
  SELECT code, COUNT(*)::int AS used
  FROM promo_redemptions
  GROUP BY code
)
UPDATE promo_codes pc
   SET used_count = COALESCE(usage.used, 0),
       active = CASE WHEN COALESCE(usage.used, 0) >= 1 THEN false ELSE pc.active END
  FROM usage
 WHERE pc.code = usage.code;

UPDATE promo_codes pc
   SET used_count = 0
 WHERE NOT EXISTS (SELECT 1 FROM promo_redemptions pr WHERE pr.code = pc.code);
