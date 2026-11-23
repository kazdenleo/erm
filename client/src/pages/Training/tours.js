/**
 * Интерактивные туры: шаги с data-tour селекторами и маршрутами.
 */

export const TRAINING_TOURS = {
  'tour-settings-org': {
    id: 'tour-settings-org',
    title: 'Организации и склады',
    steps: [
      {
        route: '/organizations',
        selector: '[data-tour="nav-organizations"]',
        title: 'Организации',
        body: 'Здесь создают и правят организации аккаунта. Без организации нельзя нормально работать со складом и МП.',
      },
      {
        route: '/warehouses',
        selector: '[data-tour="nav-warehouses"]',
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
        selector: '[data-tour="nav-integrations"]',
        title: 'Пункт «Интеграции»',
        body: 'Откройте интеграции в меню настроек.',
      },
      {
        route: '/integrations',
        selector: '[data-tour="page-integrations"]',
        title: 'Ключи API',
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
        selector: '[data-tour="nav-settings-users"]',
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
        selector: '[data-tour="nav-settings-labels"]',
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
        selector: '[data-tour="nav-products"]',
        title: 'Каталог',
        body: 'Здесь весь каталог: поиск, фильтры, создание и печать этикеток.',
      },
      {
        route: '/products',
        selector: '[data-tour="page-products"]',
        title: 'Список товаров',
        body: 'Откройте карточку или создайте новый товар. Привяжите offer_id / артикулы маркетплейсов.',
      },
    ],
  },
  'tour-orders': {
    id: 'tour-orders',
    title: 'Заказы',
    steps: [
      {
        route: '/orders',
        selector: '[data-tour="nav-orders"]',
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
        selector: '[data-tour="nav-warehouse"]',
        title: 'Меню склада',
        body: 'Раскройте «Склад»: остатки, закупка, приёмка, перемещения и другие операции.',
      },
      {
        route: '/stock-levels/warehouse',
        selector: '[data-tour="page-warehouse"]',
        title: 'Остатки',
        body: 'Таблица остатков — точка входа в ежедневный контроль склада.',
      },
    ],
  },
  'tour-address': {
    id: 'tour-address',
    title: 'Адресное хранение',
    steps: [
      {
        route: '/stock-levels/address-storage',
        selector: '[data-tour="nav-address-storage"]',
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
        selector: '[data-tour="nav-fbo"]',
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
        selector: '[data-tour="nav-prices"]',
        title: 'Цены',
        body: 'Минимальные цены, стратегии и акции — в этом разделе меню.',
      },
    ],
  },
  'tour-analytics': {
    id: 'tour-analytics',
    title: 'Аналитика',
    steps: [
      {
        route: '/analytics/sales',
        selector: '[data-tour="nav-analytics"]',
        title: 'Аналитика',
        body: 'Продажи, юнит-экономика и операционные отчёты — раскройте подменю.',
      },
    ],
  },
  'tour-questions': {
    id: 'tour-questions',
    title: 'Вопросы',
    steps: [
      {
        route: '/questions',
        selector: '[data-tour="nav-questions"]',
        title: 'Вопросы покупателей',
        body: 'Отвечайте на вопросы с маркетплейсов из одного окна.',
      },
    ],
  },
};

export function getTrainingTour(id) {
  return TRAINING_TOURS[String(id || '')] || null;
}
