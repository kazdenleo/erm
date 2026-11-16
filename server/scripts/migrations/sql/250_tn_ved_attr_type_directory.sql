-- ТН ВЭД: тип атрибута — справочник (не свободный текст и не dictionary_values).
-- Значения берутся из tn_ved_codes через TnVedCodePicker.

ALTER TABLE product_attributes DROP CONSTRAINT IF EXISTS product_attributes_type_check;

ALTER TABLE product_attributes
  ADD CONSTRAINT product_attributes_type_check
  CHECK (
    (type)::text = ANY (
      ARRAY[
        ('text'::character varying)::text,
        ('checkbox'::character varying)::text,
        ('number'::character varying)::text,
        ('date'::character varying)::text,
        ('dictionary'::character varying)::text,
        ('computed'::character varying)::text,
        ('editable'::character varying)::text,
        ('tn_ved'::character varying)::text
      ]
    )
  );

UPDATE product_attributes
SET type = 'tn_ved'
WHERE system_key = 'tn_ved'
  AND COALESCE(type, '') <> 'tn_ved';
