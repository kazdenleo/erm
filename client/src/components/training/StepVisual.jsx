import React from 'react';
import './StepVisual.css';

const VISUALS = {
  login: {
    label: 'Вход',
    bars: ['email', 'пароль', 'Войти'],
  },
  password: {
    label: 'Смена пароля',
    bars: ['новый пароль', 'повтор', 'Сохранить'],
  },
  onboarding: {
    label: 'Онбординг',
    bars: ['1. Организация', '2. Склад', '3. Маркетплейсы', 'Готово'],
  },
  'org-list': {
    label: 'Организации',
    bars: ['Название · ИНН', '+ Создать', 'Список организаций'],
  },
  'warehouse-form': {
    label: 'Склад',
    bars: ['Название склада', 'Адрес', 'Сохранить'],
  },
  integrations: {
    label: 'Интеграции',
    bars: ['Ozon', 'Wildberries', 'Яндекс Маркет'],
  },
  'api-keys': {
    label: 'Ключи API',
    bars: ['Client ID / API Key', 'Проверить', 'Статус: OK'],
  },
  sync: {
    label: 'Синхронизация',
    bars: ['Заказы', 'Товары', 'Остатки'],
  },
  users: {
    label: 'Пользователи',
    bars: ['ФИО · email', 'Роль', 'Пригласить'],
  },
  roles: {
    label: 'Роли',
    bars: ['Сборщик', 'Кладовщик', 'Разделы меню ✓/✗'],
  },
  'print-helper': {
    label: 'Print Helper',
    bars: ['Скачать setup.exe', 'Запуск в трее', '127.0.0.1:9100'],
  },
  printers: {
    label: 'Принтеры',
    bars: ['Обновить список', 'Стикеры заказов', 'Стикеры товаров'],
  },
  'label-types': {
    label: 'Типы этикеток',
    bars: ['Заказы', 'Товары', 'Ячейки', 'Упаковки'],
  },
  categories: { label: 'Категории', bars: ['Дерево', '+ Категория'] },
  suppliers: { label: 'Поставщики', bars: ['Контрагент', 'Реквизиты'] },
  attributes: { label: 'Атрибуты', bars: ['Поле', 'Связь с МП'] },
  certificates: { label: 'Сертификаты', bars: ['Документ', 'Привязка'] },
  'products-list': {
    label: 'Товары',
    bars: ['Поиск / фильтры', 'Артикул · название · ШК', '+ Товар'],
  },
  'product-form': {
    label: 'Новый товар',
    bars: ['Название', 'Артикул / ШК', 'Фото', 'Сохранить'],
  },
  'product-label': {
    label: 'Этикетка',
    bars: ['Штрихкод', 'Печать → Print Helper'],
  },
  'product-card': {
    label: 'Карточка',
    bars: ['Медиа', 'Атрибуты', 'МП-привязки'],
  },
  'bulk-edit': { label: 'Массовое', bars: ['Выбор товаров', 'Поля', 'Применить'] },
  enrichment: { label: 'Обогащение', bars: ['Источник', 'Сопоставить', 'Записать'] },
  'card-work': { label: 'Карточки МП', bars: ['Проблемы', 'Исправить'] },
  hypotheses: { label: 'Гипотезы', bars: ['Идея', 'Статус', 'Результат'] },
  'orders-list': {
    label: 'Заказы',
    bars: ['Фильтры МП/статус', 'Список заказов', 'Открыть'],
  },
  'orders-to-assembly': {
    label: 'К сборке',
    bars: ['Заказ', '→ Сборка'],
  },
  assembly: {
    label: 'Сборка',
    bars: ['Поле сканера', 'Состав заказа', 'Печать этикетки'],
  },
  'assembly-scan': {
    label: 'Сканирование',
    bars: ['ШК товара', '1/3 собрано', 'Подсказка ячейки'],
  },
  'assembly-print': {
    label: 'Печать',
    bars: ['Этикетка отправления', 'Собран ✓'],
  },
  shipments: { label: 'Отгрузки', bars: ['Партия', 'Статус', 'Передано'] },
  customers: { label: 'Клиенты', bars: ['Поиск', 'Карточка', 'Заказы'] },
  stocks: { label: 'Остатки', bars: ['Склад', 'Доступно / резерв', 'Поиск'] },
  receipt: { label: 'Приёмка', bars: ['Документ', 'Сканер', 'Провести'] },
  transfer: { label: 'Перемещение', bars: ['Откуда', 'Куда', 'Провести'] },
  inventory: { label: 'Инвентаризация', bars: ['Факт', 'Расхождение', 'Провести'] },
  writeoff: { label: 'Списание', bars: ['Причина', 'Кол-во', 'Провести'] },
  'return-supplier': { label: 'Возврат поставщику', bars: ['Позиции', 'Провести'] },
  'return-customer': { label: 'Возврат от клиента', bars: ['Приём', 'На склад'] },
  purchase: { label: 'Закупка', bars: ['Поставщик', 'Позиции', 'Сохранить'] },
  'purchase-receipt': { label: 'Приёмка закупки', bars: ['План / факт', 'Оприходовать'] },
  'procurement-forecast': { label: 'Прогноз', bars: ['Дефицит', 'К заказу'] },
  'address-layout': { label: 'Ячейки', bars: ['Зона / стеллаж', 'Ячейка', 'Этикетка'] },
  'address-move': { label: 'В ячейку', bars: ['Товар', 'Ячейка', 'Переместить'] },
  'rack-view': { label: 'Стеллаж', bars: ['План', 'Заполненность'] },
  'fbo-list': { label: 'FBO', bars: ['Импорт', 'Список поставок'] },
  'fbo-pack': { label: 'Сборка FBO', bars: ['Резерв', 'План / факт'] },
  'fbo-labels': { label: 'Этикетки FBO', bars: ['Товар', 'Грузоместо'] },
  'fbo-send': { label: 'Отправка', bars: ['Состав → МП', 'Готово'] },
  prices: { label: 'Цены', bars: ['Мин. цена', 'МП', 'Себестоимость'] },
  'price-strategies': { label: 'Стратегии', bars: ['Правило', 'Наценка', 'Пуш'] },
  'price-history': { label: 'История цен', bars: ['Кто', 'Когда', 'Было → стало'] },
  promotions: { label: 'Акции', bars: ['Промо МП', 'Участие', 'Маржа'] },
  'analytics-sales': { label: 'Продажи', bars: ['Период', 'Выручка', 'Срезы'] },
  'analytics-ue': { label: 'Юнит-экономика', bars: ['SKU', 'Маржа', 'P&L'] },
  'analytics-ops': { label: 'Операционка', bars: ['Штрафы', 'Dead stock', 'Возвраты'] },
  'ads-dash': { label: 'Реклама', bars: ['Расход', 'ДРР', 'Эффект'] },
  'ads-campaigns': { label: 'Кампании', bars: ['Список', 'Статус'] },
  'ads-auto': { label: 'Авто', bars: ['Правила', 'Ставки'] },
  questions: { label: 'Вопросы', bars: ['Входящие', 'Ответ', 'Готово'] },
  reviews: { label: 'Отзывы', bars: ['Оценка', 'Комментарий'] },
  tasks: { label: 'Задачи', bars: ['Создать', 'Исполнитель', 'Закрыть'] },
};

export function StepVisual({ id, caption }) {
  const spec = VISUALS[id] || { label: 'Экран', bars: ['Шаг 1', 'Шаг 2', 'Шаг 3'] };
  return (
    <figure className="step-visual" aria-label={caption || spec.label}>
      <div className="step-visual__frame">
        <div className="step-visual__chrome">
          <span />
          <span />
          <span />
          <em>{spec.label}</em>
        </div>
        <div className="step-visual__body">
          {spec.bars.map((b) => (
            <div key={b} className="step-visual__bar">
              {b}
            </div>
          ))}
        </div>
      </div>
      {caption ? <figcaption className="step-visual__caption">{caption}</figcaption> : null}
    </figure>
  );
}
