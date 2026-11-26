-- Изображение категории для витрины интернет-магазина
BEGIN;

ALTER TABLE user_categories
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN user_categories.image_url IS
  'URL картинки категории (локальный /uploads/categories/... или внешний) для витрины ИМ';

COMMIT;
