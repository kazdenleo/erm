/**
 * Каталог интеграций для UI (вкладки + плашки).
 * ready: false — экран «В разработке» при открытии.
 */

export const INTEGRATION_TABS = [
  { id: 'marketplaces', label: 'Маркетплейсы' },
  { id: 'suppliers', label: 'Поставщики', requiresSupplierSync: true },
  { id: 'other', label: 'Остальное' },
];

export const INTEGRATION_CATALOG = {
  marketplaces: [
    { id: 'ozon', name: 'Ozon', ready: true },
    { id: 'wildberries', name: 'Wildberries', ready: true },
    { id: 'yandex', name: 'Яндекс Маркет', ready: true },
    { id: 'avito', name: 'Авито', ready: false },
  ],
  suppliers: [
    { id: 'mikado', name: 'Mikado', ready: true },
    { id: 'moskvorechie', name: 'Moskvorechie', ready: true },
    { id: 'mparts', name: 'М-Партс', ready: false },
    { id: 'partkom', name: 'ПартКом', ready: false },
    { id: 'forum_auto', name: 'Форум Авто', ready: false },
    { id: 'autopiter', name: 'АвтоПитер', ready: false },
    { id: 'ixora', name: 'IXORA', ready: false },
    { id: 'avtotrade', name: 'Автотрэйд', ready: false },
    { id: 'armtek', name: 'Армтек', ready: false },
    { id: 'rossko', name: 'Росско', ready: false },
  ],
  other: [
    { id: '1c', name: '1С', ready: false },
    { id: 'chestny_znak', name: 'Честный знак', ready: false },
  ],
};

export function findIntegration(tabId, integrationId) {
  const list = INTEGRATION_CATALOG[tabId] || [];
  return list.find((item) => item.id === integrationId) || null;
}
