-- Сохранённые настройки ИИ на атрибут (поля, контекст, промпт).

ALTER TABLE product_attributes
  ADD COLUMN IF NOT EXISTS ai_chat_settings JSONB;

COMMENT ON COLUMN product_attributes.ai_chat_settings IS
  'Черновик ИИ для атрибута: outputKeys, contextKeys, fillEmptyOnly, prompt.';
