-- Доступ пользователя к организациям и складам аккаунта.
-- Пустой набор строк = полный доступ (обратная совместимость).
-- Администратор аккаунта всегда имеет полный доступ (на уровне приложения).

CREATE TABLE IF NOT EXISTS user_organizations (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_user_organizations_org
  ON user_organizations (organization_id);

CREATE TABLE IF NOT EXISTS user_warehouses (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_user_warehouses_wh
  ON user_warehouses (warehouse_id);
