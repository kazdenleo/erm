-- Migration: 262_users_base_salary_absences.sql
-- Description: Оклад сотрудника и дни пропусков для расчёта зарплаты.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS base_salary NUMERIC(12, 2);

COMMENT ON COLUMN users.base_salary IS 'Месячный оклад сотрудника, ₽';

CREATE TABLE IF NOT EXISTS employee_absence_days (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  absence_date DATE NOT NULL,
  note TEXT NULL,
  created_by_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_employee_absence_days_user_date UNIQUE (user_id, absence_date)
);

CREATE INDEX IF NOT EXISTS idx_employee_absence_days_profile_date
  ON employee_absence_days (profile_id, absence_date);

CREATE INDEX IF NOT EXISTS idx_employee_absence_days_user_date
  ON employee_absence_days (user_id, absence_date);

COMMENT ON TABLE employee_absence_days IS 'Пропущенные рабочие дни сотрудника (для расчёта зарплаты от оклада)';

COMMIT;
