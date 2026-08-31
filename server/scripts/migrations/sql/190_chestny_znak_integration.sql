-- Migration: 190_chestny_znak_integration.sql
-- Description: Тип интеграции «other» для Честного знака (True API)

BEGIN;

ALTER TABLE integrations DROP CONSTRAINT IF EXISTS chk_integration_type;

ALTER TABLE integrations
  ADD CONSTRAINT chk_integration_type
  CHECK (type IN ('marketplace', 'supplier', 'other'));

COMMENT ON CONSTRAINT chk_integration_type ON integrations IS
  'marketplace — МП, supplier — поставщики, other — прочие сервисы (Честный знак и т.п.)';

COMMIT;
