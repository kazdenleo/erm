ALTER TABLE employee_tasks
  DROP CONSTRAINT IF EXISTS employee_tasks_type_chk;

ALTER TABLE employee_tasks
  ADD CONSTRAINT employee_tasks_type_chk
  CHECK (task_type IN ('text', 'dimensions_check', 'product_create'));
