-- Единицы отображения габаритов/веса в UI (хранение в БД всегда мм / г).
-- На маркетплейсы уходят в единицах МП (Ozon мм/г, WB см + weightBrutto г, YM см/кг).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS display_length_unit text NOT NULL DEFAULT 'mm',
  ADD COLUMN IF NOT EXISTS display_weight_unit text NOT NULL DEFAULT 'g';

UPDATE profiles
SET display_length_unit = 'mm'
WHERE display_length_unit IS NULL
   OR lower(trim(display_length_unit)) NOT IN ('mm', 'cm');

UPDATE profiles
SET display_weight_unit = 'g'
WHERE display_weight_unit IS NULL
   OR lower(trim(display_weight_unit)) NOT IN ('g', 'kg');

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_display_length_unit_chk;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_display_length_unit_chk
  CHECK (lower(display_length_unit) IN ('mm', 'cm'));

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_display_weight_unit_chk;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_display_weight_unit_chk
  CHECK (lower(display_weight_unit) IN ('g', 'kg'));

COMMENT ON COLUMN profiles.display_length_unit IS
  'Единица длины в интерфейсе: mm или cm. В products всегда мм; на МП — по правилам маркетплейса.';
COMMENT ON COLUMN profiles.display_weight_unit IS
  'Единица веса в интерфейсе: g или kg. В products всегда г; на МП — по правилам маркетплейса.';
