-- Служебный ШК ячейки: L{id} → внутренний EAN-13 (префикс 28), как на этикетке.
-- Явно заданный пользователем barcode (не L{id} и не адрес) не трогаем.

UPDATE storage_locations sl
SET barcode = sub.ean,
    updated_at = CURRENT_TIMESTAMP
FROM (
  SELECT
    id,
    body
      || (
        (
          10
          - (
            (
              (substr(body, 1, 1)::int) * 1
              + (substr(body, 2, 1)::int) * 3
              + (substr(body, 3, 1)::int) * 1
              + (substr(body, 4, 1)::int) * 3
              + (substr(body, 5, 1)::int) * 1
              + (substr(body, 6, 1)::int) * 3
              + (substr(body, 7, 1)::int) * 1
              + (substr(body, 8, 1)::int) * 3
              + (substr(body, 9, 1)::int) * 1
              + (substr(body, 10, 1)::int) * 3
              + (substr(body, 11, 1)::int) * 1
              + (substr(body, 12, 1)::int) * 3
            )
            % 10
          )
        )
        % 10
      )::text AS ean
  FROM (
    SELECT id, ('28' || lpad(id::text, 10, '0')) AS body
    FROM storage_locations
    WHERE barcode IS NULL
       OR btrim(barcode) = ''
       OR btrim(barcode) ~* '^L[0-9]+$'
       OR btrim(barcode) = btrim(code)
  ) t
) sub
WHERE sl.id = sub.id;
