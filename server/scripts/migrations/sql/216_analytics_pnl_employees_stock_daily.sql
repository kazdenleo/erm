-- Migration: 216_analytics_pnl_employees_stock_daily.sql
-- Description: Постоянные расходы для ОПиУ, журнал действий сотрудников (скан, ошибки),
--              ежедневный снимок наличия товара (свой склад + поставщики) для упущенной выручки и прогноза.

BEGIN;

CREATE TABLE IF NOT EXISTS company_expenses (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  organization_id BIGINT NULL REFERENCES organizations(id) ON DELETE SET NULL,
  marketplace VARCHAR(10) NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  start_date DATE NOT NULL,
  recurrence VARCHAR(10) NOT NULL DEFAULT 'once',
  end_date DATE NULL,
  created_by_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_company_expenses_recurrence CHECK (recurrence IN ('once', 'monthly')),
  CONSTRAINT chk_company_expenses_marketplace CHECK (marketplace IS NULL OR marketplace IN ('ozon', 'wb', 'ym')),
  CONSTRAINT chk_company_expenses_dates CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_company_expenses_profile_start
  ON company_expenses (profile_id, start_date);

COMMENT ON TABLE company_expenses IS 'Постоянные и разовые расходы компании (аренда, зарплаты, подписки) для ОПиУ';
COMMENT ON COLUMN company_expenses.recurrence IS 'once — разовый в месяце start_date; monthly — каждый месяц с start_date до end_date (или бессрочно)';
COMMENT ON COLUMN company_expenses.marketplace IS 'NULL — общий расход (распределяется по выручке при фильтре по МП)';

CREATE TABLE IF NOT EXISTS employee_activity_events (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(40) NOT NULL,
  is_error BOOLEAN NOT NULL DEFAULT FALSE,
  entity_type VARCHAR(40) NULL,
  entity_id TEXT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  meta JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_activity_events_profile_created
  ON employee_activity_events (profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_employee_activity_events_user_type
  ON employee_activity_events (user_id, event_type, created_at DESC);

COMMENT ON TABLE employee_activity_events IS 'Действия сотрудников (скан при сборке и приёмке, ошибки) для показателей сотрудников';

CREATE TABLE IF NOT EXISTS product_stock_daily (
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  own_qty INTEGER NOT NULL DEFAULT 0,
  supplier_qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, day, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_stock_daily_product_day
  ON product_stock_daily (product_id, day);

COMMENT ON TABLE product_stock_daily IS 'Ежедневный снимок наличия: свои склады и остатки поставщиков (для дней без остатка)';

COMMIT;
