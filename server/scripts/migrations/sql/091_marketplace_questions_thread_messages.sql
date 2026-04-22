-- Ветка сообщений по вопросу (покупатель / продавец) для UI и фильтра «нужен ответ»
BEGIN;

ALTER TABLE marketplace_questions
  ADD COLUMN IF NOT EXISTS thread_messages JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN marketplace_questions.thread_messages IS
  'Хронология сообщений: [{role: buyer|seller, text, at, externalId?}] — из API при синхронизации';

COMMIT;
