/** Уроки: склад */

export const LESSONS_WAREHOUSE = [
  {
    id: 'wh-stocks',
    categoryId: 'warehouse',
    title: 'Остатки на складе',
    summary: 'Таблица остатков, резервы и быстрый переход к операциям.',
    durationMin: 7,
    relatedPath: '/stock-levels/warehouse',
    tourId: 'tour-warehouse',
    tags: ['остатки', 'склад'],
    sections: [
      {
        title: 'Таблица остатков',
        paragraphs: [
          '«Склад → Остатки» показывает доступное количество по товарам и складам, с учётом резервов под сборку и FBO.',
        ],
        steps: [
          {
            title: 'Откройте остатки',
            text: 'В меню «Склад» выберите «Остатки». Ищите по артикулу/ШК, смотрите колонки доступно / резерв.',
            visual: 'stocks',
          },
        ],
        callout: {
          type: 'tip',
          text: 'Расхождения с МП часто лечатся приёмкой, инвентаризацией или проверкой синхронизации остатков в интеграциях.',
        },
      },
    ],
  },
  {
    id: 'wh-receipts-transfer',
    categoryId: 'warehouse',
    title: 'Приёмка и перемещение',
    summary: 'Как оприходовать товар и переместить между складами или зонами.',
    durationMin: 10,
    relatedPath: '/stock-levels/warehouse?op=receipts_list',
    tourId: null,
    tags: ['приёмка', 'перемещение', 'сканер'],
    sections: [
      {
        title: 'Приёмка',
        steps: [
          {
            title: 'Откройте «Приёмка»',
            text: 'Склад → Приёмка. Создайте документ, сканируйте или добавляйте позиции, подтвердите поступление на склад.',
            visual: 'receipt',
          },
        ],
      },
      {
        title: 'Перемещение',
        steps: [
          {
            title: 'Откройте «Перемещение»',
            text: 'Укажите склад/ячейку источника и назначения, проведите документ. При адресном хранении удобно работать со сканером.',
            visual: 'transfer',
          },
        ],
      },
    ],
  },
  {
    id: 'wh-inventory-writeoff-returns',
    categoryId: 'warehouse',
    title: 'Инвентаризация, списание и возвраты',
    summary: 'Сверка факта с учётом, списание брака, возвраты поставщику и от клиентов.',
    durationMin: 10,
    relatedPath: '/stock-levels/warehouse?op=inventory',
    tourId: null,
    tags: ['инвентаризация', 'списание', 'возвраты'],
    sections: [
      {
        title: 'Операции контроля',
        steps: [
          {
            title: 'Инвентаризация',
            text: 'Создайте документ, внесите фактические количества — система скорректирует остатки.',
            visual: 'inventory',
          },
          {
            title: 'Списание',
            text: 'Списывайте брак и потери с указанием причины.',
            visual: 'writeoff',
          },
          {
            title: 'Возврат поставщику',
            text: 'Оформляйте возврат по закупке или остатку — количество уйдёт со склада.',
            visual: 'return-supplier',
          },
          {
            title: 'Возвраты от клиентов',
            text: 'Принимайте возвраты с МП/покупателей обратно на склад (или в брак — по процессу компании).',
            visual: 'return-customer',
          },
        ],
      },
    ],
  },
  {
    id: 'wh-purchases',
    categoryId: 'warehouse',
    title: 'Закупки и прогноз',
    summary: 'Заказы поставщикам, приёмка по закупке и прогноз потребности.',
    durationMin: 9,
    relatedPath: '/stock-levels/purchases',
    tourId: null,
    tags: ['закупка', 'поставщик', 'прогноз'],
    sections: [
      {
        title: 'Цикл закупки',
        steps: [
          {
            title: 'Создайте закупку',
            text: 'Склад → Закупка: выберите поставщика, добавьте позиции и количество, сохраните.',
            visual: 'purchase',
          },
          {
            title: 'Примите товар',
            text: 'Когда груз приехал — оформите приёмку по закупке (в т.ч. частичную).',
            visual: 'purchase-receipt',
          },
          {
            title: 'Прогноз',
            text: 'В прогнозе закупок система подсказывает, что пора докупить, опираясь на продажи и остатки.',
            visual: 'procurement-forecast',
          },
        ],
      },
    ],
  },
  {
    id: 'wh-address-storage',
    categoryId: 'warehouse',
    title: 'Адресное хранение',
    summary: 'Зоны, стеллажи, ячейки, перемещения по ячейкам и печать этикеток ячеек.',
    durationMin: 11,
    relatedPath: '/stock-levels/address-storage',
    tourId: 'tour-address',
    tags: ['адресное', 'ячейки', 'стеллажи'],
    sections: [
      {
        title: 'Как выстроить адресный склад',
        steps: [
          {
            title: 'Создайте структуру',
            text: 'Задайте зоны, ряды, стеллажи и ячейки. Распечатайте этикетки ячеек через Print Helper (принтер ячеек).',
            visual: 'address-layout',
          },
          {
            title: 'Разложите товар',
            text: 'Перемещайте остатки в ячейки. На сборке подсказки «где лежит» ускоряют поиск.',
            visual: 'address-move',
          },
          {
            title: 'Вид стеллажа',
            text: 'Во вкладке плана/стеллажа контролируйте заполненность и содержимое ячеек.',
            visual: 'rack-view',
          },
        ],
      },
    ],
  },
  {
    id: 'wh-production-marking',
    categoryId: 'warehouse',
    title: 'Производство и маркировка (ЧЗ)',
    summary: 'Если включены в аккаунте: производственные операции и Честный знак.',
    durationMin: 6,
    relatedPath: '/production',
    tourId: null,
    tags: ['производство', 'честный знак', 'маркировка'],
    sections: [
      {
        title: 'Производство',
        paragraphs: [
          'Раздел «Производство» доступен при включённом флаге в аккаунте. Используется для выпуска из комплектующих.',
        ],
      },
      {
        title: 'Маркировка',
        paragraphs: [
          '«Склад → Маркировка» — работа с кодами «Честного знака», если модуль включён. Следуйте чеклисту настройки в самом разделе.',
        ],
        relatedHint: '/stock-levels/marking',
      },
    ],
  },
];
