-- Категории автоответа создаёт пользователь (без готовой сетки 5×2)
BEGIN;

ALTER TABLE review_auto_reply_rules
  DROP CONSTRAINT IF EXISTS review_auto_reply_rules_profile_id_rating_has_text_key;

ALTER TABLE review_auto_reply_rules
  ADD COLUMN IF NOT EXISTS title VARCHAR(120) NOT NULL DEFAULT '';

ALTER TABLE review_auto_reply_rules
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- NULL rating / has_text = «любой» в условии
ALTER TABLE review_auto_reply_rules
  ALTER COLUMN rating DROP NOT NULL;

ALTER TABLE review_auto_reply_rules
  ALTER COLUMN has_text DROP NOT NULL;

COMMENT ON COLUMN review_auto_reply_rules.title IS 'Название категории, заданное пользователем';
COMMENT ON COLUMN review_auto_reply_rules.rating IS '1–5 или NULL = любой рейтинг';
COMMENT ON COLUMN review_auto_reply_rules.has_text IS 'true/false или NULL = любой отзыв по тексту';

COMMIT;
