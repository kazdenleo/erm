-- Задачи сотрудникам (текст + автопроверка габаритов после обновления карточек МП)

CREATE TABLE IF NOT EXISTS employee_tasks (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  task_type VARCHAR(64) NOT NULL DEFAULT 'text',
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  assignee_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_by_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  marketplace VARCHAR(16),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_at TIMESTAMPTZ,
  completed_by_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employee_tasks_type_chk CHECK (task_type IN ('text', 'dimensions_check')),
  CONSTRAINT employee_tasks_status_chk CHECK (status IN ('open', 'done', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_employee_tasks_profile_status
  ON employee_tasks (profile_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_employee_tasks_assignee
  ON employee_tasks (assignee_id, status);

CREATE INDEX IF NOT EXISTS idx_employee_tasks_product_open
  ON employee_tasks (product_id, task_type)
  WHERE status = 'open' AND product_id IS NOT NULL;

COMMENT ON TABLE employee_tasks IS
  'Задачи сотрудникам: текстовые и автосозданные (проверка габаритов после обновления с МП).';
