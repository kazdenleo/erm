/**
 * Интерактивные туры: шаги с маршрутом и data-tour на странице (не только в меню).
 */

export const TRAINING_TOURS = {
  'tour-settings-org': {
    id: 'tour-settings-org',
    title: 'Организации и склады',
    steps: [
      {
        route: '/organizations',
        selector: '[data-tour="page-organizations"]',
        fallbackSelectors: ['[data-tour="nav-organizations"]'],
        openNavGroup: '/settings',
        title: 'Организации',
        body: 'Здесь создают и правят организации аккаунта. Без организации нельзя нормально работать со складом и МП.',
      },
      {
        route: '/warehouses',
        selector: '[data-tour="page-warehouses"]',
        fallbackSelectors: ['[data-tour="nav-warehouses"]'],
        openNavGroup: '/settings',
        title: 'Склады',
        body: 'После организации создайте хотя бы один склад — на него пойдут приёмки и остатки.',
      },
    ],
  },
  'tour-integrations': {
    id: 'tour-integrations',
    title: 'Интеграции',
    steps: [
      {
        route: '/integrations',
        selector: '[data-tour="page-integrations"]',
        fallbackSelectors: ['[data-tour="nav-integrations"]'],
        openNavGroup: '/settings',
        title: 'Интеграции',
        body: 'Добавьте кабинеты Ozon, Wildberries или Яндекс Маркет и сохраните ключи. Дождитесь статуса подключения.',
      },
    ],
  },
  'tour-users': {
    id: 'tour-users',
    title: 'Пользователи',
    steps: [
      {
        route: '/settings/users',
        selector: '[data-tour="page-users"]',
        fallbackSelectors: ['[data-tour="nav-settings-users"]'],
        openNavGroup: '/settings',
        title: 'Пользователи',
        body: 'Приглашайте сотрудников и назначайте роли с нужным набором разделов.',
      },
    ],
  },
  'tour-labels': {
    id: 'tour-labels',
    title: 'Этикетки',
    steps: [
      {
        route: '/settings/labels',
        selector: '[data-tour="page-labels"]',
        fallbackSelectors: ['[data-tour="nav-settings-labels"]'],
        openNavGroup: '/settings',
        title: 'Этикетки',
        body: 'Скачайте Print Helper, назначьте принтеры по типам стикеров и проверьте статус подключения.',
      },
    ],
  },
  'tour-products': {
    id: 'tour-products',
    title: 'Товары',
    steps: [
      {
        route: '/products',
        selector: '[data-tour="page-products"]',
        fallbackSelectors: ['[data-tour="nav-products"]'],
        title: 'Каталог товаров',
        body: 'Здесь весь каталог: поиск, фильтры, создание и печать этикеток. Откройте карточку или создайте новый товар.',
      },
    ],
  },
  'tour-orders': {
    id: 'tour-orders',
    title: 'Заказы',
    steps: [
      {
        route: '/orders',
        selector: '[data-tour="page-orders"]',
        fallbackSelectors: ['[data-tour="nav-orders"]'],
        title: 'Заказы FBS',
        body: 'Лента заказов с площадок. Фильтруйте по статусу и переходите к сборке.',
      },
    ],
  },
  'tour-assembly': {
    id: 'tour-assembly',
    title: 'Сборка',
    steps: [
      {
        route: '/assembly',
        selector: '[data-tour="page-assembly"]',
        title: 'Рабочее место сборки',
        body: 'Сканируйте заказ и товары, печатайте этикетку через Print Helper, отмечайте сборку завершённой.',
      },
    ],
  },
  'tour-warehouse': {
    id: 'tour-warehouse',
    title: 'Склад',
    steps: [
      {
        route: '/stock-levels/warehouse',
        selector: '[data-tour="page-warehouse"]',
        fallbackSelectors: ['[data-tour="nav-warehouse"]'],
        openNavGroup: '/stock-levels/warehouse',
        title: 'Остатки на складе',
        body: 'Таблица остатков — точка входа в ежедневный контроль склада. Справа в меню — приёмка, перемещения и другие операции.',
      },
    ],
  },
  'tour-address': {
    id: 'tour-address',
    title: 'Адресное хранение',
    steps: [
      {
        route: '/stock-levels/address-storage',
        selector: '[data-tour="page-address-storage"]',
        fallbackSelectors: ['[data-tour="nav-address-storage"]'],
        openNavGroup: '/stock-levels/warehouse',
        title: 'Адресное хранение',
        body: 'Настройте ячейки, разложите товар и печатайте этикетки ячеек.',
      },
    ],
  },
  'tour-fbo': {
    id: 'tour-fbo',
    title: 'Поставки FBO',
    steps: [
      {
        route: '/stock-levels/fbo-supplies',
        selector: '[data-tour="page-fbo"]',
        fallbackSelectors: ['[data-tour="nav-fbo"]'],
        title: 'Поставки FBO',
        body: 'Импорт, резерв, упаковка и отправка поставок на склады маркетплейсов.',
      },
    ],
  },
  'tour-prices': {
    id: 'tour-prices',
    title: 'Цены',
    steps: [
      {
        route: '/prices',
        selector: '[data-tour="page-prices"]',
        fallbackSelectors: ['[data-tour="nav-prices"]'],
        openNavGroup: '/prices',
        title: 'Цены',
        body: 'Минимальные цены, стратегии и акции — в этом разделе.',
      },
    ],
  },
  'tour-analytics': {
    id: 'tour-analytics',
    title: 'Аналитика',
    steps: [
      {
        route: '/analytics/sales',
        selector: '[data-tour="page-analytics-sales"]',
        fallbackSelectors: ['[data-tour="nav-analytics"]'],
        openNavGroup: '/analytics/sales',
        title: 'Аналитика продаж',
        body: 'Продажи FBS, юнит-экономика и операционные отчёты — в подменю аналитики.',
      },
    ],
  },
  'tour-questions': {
    id: 'tour-questions',
    title: 'Вопросы',
    steps: [
      {
        route: '/questions',
        selector: '[data-tour="page-questions"]',
        fallbackSelectors: ['[data-tour="nav-questions"]'],
        title: 'Вопросы покупателей',
        body: 'Отвечайте на вопросы с маркетплейсов из одного окна.',
      },
    ],
  },
};

export function getTrainingTour(id) {
  return TRAINING_TOURS[String(id || '')] || null;
}
