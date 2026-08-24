-- ========================================
-- MIGRATION: PRICING DAY-TYPE MODEL
-- ========================================
-- Run this in the Supabase SQL Editor (or any Postgres client
-- connected to the project database).
--
-- Why: `pricing.duration_hours` is UNIQUE, but the day-type model
-- needs one rate per (duration_hours, day_type) — e.g. 1 hour costs
-- ₱500 on weekdays and ₱600 on weekends. The old UNIQUE constraint
-- silently dropped the weekend rows from the seed data.
--
-- What this does:
--   1. Drops the old UNIQUE constraint on duration_hours.
--   2. Adds a composite UNIQUE constraint on (duration_hours, day_type).
--   3. Re-inserts the weekday + weekend rates (idempotent).

-- 1. Drop the old single-column unique constraint
ALTER TABLE pricing DROP CONSTRAINT IF EXISTS pricing_duration_hours_key;

-- 2. Add the composite unique constraint (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pricing_duration_hours_day_type_key'
  ) THEN
    ALTER TABLE pricing
      ADD CONSTRAINT pricing_duration_hours_day_type_key
      UNIQUE (duration_hours, day_type);
  END IF;
END $$;

-- 3. Re-insert weekday + weekend rates (weekend rows were previously skipped)
INSERT INTO pricing (duration_hours, price_amount, day_type, description, is_active)
VALUES
  (1, 500,  'weekday', 'One hour weekday rate',     true),
  (2, 900,  'weekday', 'Two hour weekday rate',     true),
  (3, 1200, 'weekday', 'Three hour weekday rate',   true),
  (1, 600,  'weekend', 'One hour weekend rate',     true),
  (2, 1100, 'weekend', 'Two hour weekend rate',     true),
  (3, 1500, 'weekend', 'Three hour weekend rate',   true)
ON CONFLICT (duration_hours, day_type) DO NOTHING;

-- Verification:
-- SELECT duration_hours, price_amount, day_type FROM pricing ORDER BY day_type, duration_hours;
-- Expect 6 rows: 3 weekday + 3 weekend.
