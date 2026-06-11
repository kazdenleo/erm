-- Комплекты и раздел «Производство» можно отключить на уровне аккаунта.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS kits_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS production_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN profiles.kits_enabled IS
  'false — комплекты отключены: только простое движение по SKU, нельзя создавать комплекты';

COMMENT ON COLUMN profiles.production_enabled IS
  'false — раздел «Производство» (сборка комплектов) недоступен';
