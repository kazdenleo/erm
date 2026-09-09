-- Атрибуты товаров: привязка к аккаунту (profile_id), изоляция между кабинетами.
-- Системные (system_key) остаются общими.

BEGIN;

ALTER TABLE product_attributes
  ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE CASCADE;

-- Один профиль по значениям на товарах
UPDATE product_attributes pa
SET profile_id = x.profile_id
FROM (
  SELECT pav.attribute_id AS id, MIN(p.profile_id)::bigint AS profile_id
  FROM product_attribute_values pav
  JOIN products p ON p.id = pav.product_id
  WHERE p.profile_id IS NOT NULL
  GROUP BY pav.attribute_id
  HAVING COUNT(DISTINCT p.profile_id) = 1
) x
WHERE pa.profile_id IS NULL
  AND pa.id = x.id
  AND (pa.system_key IS NULL OR btrim(pa.system_key) = '');

-- Один профиль по привязке к категориям
UPDATE product_attributes pa
SET profile_id = x.profile_id
FROM (
  SELECT ca.attribute_id AS id, MIN(uc.profile_id)::bigint AS profile_id
  FROM category_attributes ca
  JOIN user_categories uc ON uc.id = ca.user_category_id
  WHERE uc.profile_id IS NOT NULL
  GROUP BY ca.attribute_id
  HAVING COUNT(DISTINCT uc.profile_id) = 1
) x
WHERE pa.profile_id IS NULL
  AND pa.id = x.id
  AND (pa.system_key IS NULL OR btrim(pa.system_key) = '');

-- Атрибут использовали несколько аккаунтов: оставляем оригинал одному, остальным — копии
DO $$
DECLARE
  rec RECORD;
  pid BIGINT;
  new_id BIGINT;
  keep_pid BIGINT;
BEGIN
  FOR rec IN
    SELECT pa.id AS attr_id
    FROM product_attributes pa
    WHERE (pa.system_key IS NULL OR btrim(pa.system_key) = '')
      AND (
        pa.profile_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM product_attribute_values pav
          JOIN products p ON p.id = pav.product_id
          WHERE pav.attribute_id = pa.id
            AND p.profile_id IS NOT NULL
            AND p.profile_id IS DISTINCT FROM pa.profile_id
        )
        OR EXISTS (
          SELECT 1
          FROM category_attributes ca
          JOIN user_categories uc ON uc.id = ca.user_category_id
          WHERE ca.attribute_id = pa.id
            AND uc.profile_id IS NOT NULL
            AND uc.profile_id IS DISTINCT FROM pa.profile_id
        )
      )
  LOOP
    SELECT MIN(t.pid) INTO keep_pid
    FROM (
      SELECT p.profile_id AS pid
      FROM product_attribute_values pav
      JOIN products p ON p.id = pav.product_id
      WHERE pav.attribute_id = rec.attr_id AND p.profile_id IS NOT NULL
      UNION
      SELECT uc.profile_id
      FROM category_attributes ca
      JOIN user_categories uc ON uc.id = ca.user_category_id
      WHERE ca.attribute_id = rec.attr_id AND uc.profile_id IS NOT NULL
    ) t;

    IF keep_pid IS NULL THEN
      CONTINUE;
    END IF;

    UPDATE product_attributes
    SET profile_id = keep_pid
    WHERE id = rec.attr_id
      AND (profile_id IS NULL OR profile_id = keep_pid);

    FOR pid IN
      SELECT DISTINCT x.pid
      FROM (
        SELECT p.profile_id AS pid
        FROM product_attribute_values pav
        JOIN products p ON p.id = pav.product_id
        WHERE pav.attribute_id = rec.attr_id AND p.profile_id IS NOT NULL
        UNION
        SELECT uc.profile_id
        FROM category_attributes ca
        JOIN user_categories uc ON uc.id = ca.user_category_id
        WHERE ca.attribute_id = rec.attr_id AND uc.profile_id IS NOT NULL
      ) x
      WHERE x.pid IS DISTINCT FROM keep_pid
    LOOP
      INSERT INTO product_attributes (
        name, type, dictionary_values, mp_links, formula, show_related_fields, ai_chat_enabled, profile_id
      )
      SELECT
        name, type, dictionary_values, mp_links, formula, show_related_fields, ai_chat_enabled, pid
      FROM product_attributes
      WHERE id = rec.attr_id
      RETURNING id INTO new_id;

      UPDATE product_attribute_values pav
      SET attribute_id = new_id
      FROM products p
      WHERE pav.product_id = p.id
        AND pav.attribute_id = rec.attr_id
        AND p.profile_id = pid
        AND NOT EXISTS (
          SELECT 1 FROM product_attribute_values pav2
          WHERE pav2.product_id = pav.product_id AND pav2.attribute_id = new_id
        );

      DELETE FROM product_attribute_values pav
      USING products p
      WHERE pav.product_id = p.id
        AND pav.attribute_id = rec.attr_id
        AND p.profile_id = pid;

      UPDATE category_attributes ca
      SET attribute_id = new_id
      FROM user_categories uc
      WHERE ca.user_category_id = uc.id
        AND ca.attribute_id = rec.attr_id
        AND uc.profile_id = pid
        AND NOT EXISTS (
          SELECT 1 FROM category_attributes ca2
          WHERE ca2.user_category_id = ca.user_category_id AND ca2.attribute_id = new_id
        );

      DELETE FROM category_attributes ca
      USING user_categories uc
      WHERE ca.user_category_id = uc.id
        AND ca.attribute_id = rec.attr_id
        AND uc.profile_id = pid;
    END LOOP;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_product_attributes_profile_id
  ON product_attributes(profile_id);

COMMENT ON COLUMN product_attributes.profile_id IS
  'Аккаунт (кабинет). NULL у системных атрибутов (system_key) — они общие.';

COMMIT;
