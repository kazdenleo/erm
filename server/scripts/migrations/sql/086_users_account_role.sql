BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_role VARCHAR(50);

UPDATE users
SET account_role = 'admin'
WHERE account_role IS NULL
  AND role <> 'admin'
  AND is_profile_admin = true;

UPDATE users
SET account_role = 'editor'
WHERE account_role IS NULL
  AND role <> 'admin';

ALTER TABLE users
  ALTER COLUMN account_role SET DEFAULT 'editor';

ALTER TABLE users
  ADD CONSTRAINT users_account_role_check
  CHECK (account_role IS NULL OR account_role IN ('admin', 'picker', 'warehouse_manager', 'editor'));

COMMIT;
