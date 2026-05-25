-- Включение синхронизации остатков поставщиков (Микадо, Москворечье) по аккаунту.
-- false: скрыты настройки интеграций с поставщиками, колонка «Поставщики» в остатках, фоновая синхронизация не запускается.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS supplier_sync_enabled boolean NOT NULL DEFAULT true;
