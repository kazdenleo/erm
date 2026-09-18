-- Комментарий к порогу высокого ДРР в price_push_settings (поле highDrrPercent).
COMMENT ON COLUMN profiles.price_push_settings IS
  'JSON: scope, categoryIds, productIds, excludeProductIds, pushFbs/pushFbo, minMarkupRules, highDrrPercent (порог ДРР % для «Работа с карточками»)';
