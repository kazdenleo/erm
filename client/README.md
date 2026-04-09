# ERP Client

Frontend приложение для ERP системы управления товарами и заказами (React).

## 🚀 Быстрый старт

### Установка зависимостей

```bash
npm install
```

### Запуск приложения

**Development режим:**
```bash
npm start
# или
npm run client
```

Приложение откроется на http://localhost:3000

### Сборка для production

```bash
npm run build
```

## 📁 Структура проекта

```
client/
├── public/
│   └── index.html          # HTML шаблон
├── src/
│   ├── components/         # React компоненты
│   │   ├── common/         # Общие компоненты
│   │   └── layout/         # Компоненты layout
│   ├── pages/              # Страницы приложения
│   ├── services/           # API сервисы
│   ├── hooks/              # Custom React Hooks
│   ├── contexts/           # React Context
│   ├── utils/              # Утилиты
│   ├── styles/             # Стили
│   ├── App.js              # Главный компонент
│   └── index.js            # Точка входа
├── package.json
└── README.md
```

## 🔧 API Configuration

API URL настраивается через переменные окружения:

```env
REACT_APP_API_URL=http://localhost:3001/api
PORT=3000
```

## 📝 Переменные окружения

Создайте файл `.env` в корне проекта:

```env
REACT_APP_API_URL=http://localhost:3001/api
PORT=3000
```

## 🛠️ Разработка

### Скрипты

- `npm start` - Запуск приложения в режиме разработки
- `npm run build` - Сборка для production
- `npm test` - Запуск тестов
- `npm run client` - Алиас для `npm start`

## 📦 Зависимости

- **react** - React библиотека
- **react-dom** - React DOM
- **react-router-dom** - Роутинг
- **axios** - HTTP клиент

## 🔄 Миграция

Этот проект является частью миграции монолитного приложения на раздельную архитектуру.

**Текущий статус:** В разработке  
**Версия:** 1.0.0

## 📝 Страницы

- `/` - Главная
- `/products` - Управление товарами
- `/warehouses` - Управление складами
- `/suppliers` - Управление поставщиками
- `/orders` - Управление заказами (с фильтрами и синхронизацией)
- `/stock-levels` - Остатки (основной склад + поставщики)
- `/integrations` - Настройки интеграций (маркетплейсы + поставщики)

## 🚀 Следующие шаги

1. ⏳ Создание форм для редактирования товаров, складов, поставщиков
2. ⏳ Доработка логики этикеток заказов
3. ⏳ Добавление обработки ошибок и валидации
4. ⏳ Улучшение UI/UX

