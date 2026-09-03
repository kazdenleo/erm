-- Оценка качества карточек МП: показывать в «Работе с карточками» и пороги по площадкам.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS card_quality_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.card_quality_settings IS
  'Качество карточек МП: { showInCardWork: bool, thresholds: { ozon, wb, ym } }. Балл ниже порога — в очереди «Работа с карточками».';
