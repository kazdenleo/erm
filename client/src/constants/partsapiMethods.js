/** Методы PartsAPI для UI настроек аккаунта (локальные ключи). */
export const PARTSAPI_ENRICHMENT_METHODS = [
  'searchArticles',
  'getArticleCriteria',
  'getArticleMedia',
  'getPartnameByBrandNumber',
  'getPartWeight',
  'FindEAN13',
  'getArticle',
];

export const PARTSAPI_METHOD_LABELS = {
  searchArticles: 'Поиск по артикулу — searchArticles',
  getArticleCriteria: 'Характеристики — getArticleCriteria',
  getArticleMedia: 'Фото / медиа — getArticleMedia',
  getPartnameByBrandNumber: 'Название — getPartnameByBrandNumber',
  getPartWeight: 'Вес — getPartWeight',
  FindEAN13: 'Штрихкод EAN — FindEAN13',
  getArticle: 'Полная карточка — getArticle (опционально)',
};

export function emptyPartsApiKeysForm() {
  const out = {};
  for (const m of PARTSAPI_ENRICHMENT_METHODS) out[m] = '';
  return out;
}

export function partsApiKeysFromProfile(raw) {
  const base = emptyPartsApiKeysForm();
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return base;
    }
  }
  if (!obj || typeof obj !== 'object') return base;
  for (const m of PARTSAPI_ENRICHMENT_METHODS) {
    if (obj[m] != null && String(obj[m]).trim()) base[m] = String(obj[m]).trim();
  }
  return base;
}
