# Документация: Откуда берутся данные для расчета логистики Ozon

## API Endpoint

**URL:** `https://api-seller.ozon.ru/v5/product/info/prices`  
**Метод:** `POST`  
**Версия API:** v5

## Запрос к API

```javascript
const response = await fetch('https://api-seller.ozon.ru/v5/product/info/prices', {
  method: 'POST',
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Client-Id': String(client_id),
    'Api-Key': String(api_key)
  },
  body: JSON.stringify({
    filter: {
      offer_id: [offer_id],  // SKU товара на Ozon
      product_id: [],
      visibility: 'ALL'
    },
    last_id: '',
    limit: 100
  })
});
```

## Ответ API - Поля для логистики

Из ответа API Ozon v5 извлекаются следующие поля для расчета логистики:

### 1. Объем товара (volume_weight)
**Путь в ответе:** `item.volume_weight`  
**Описание:** Объем товара в литрах  
**Приоритет источников:**
1. `item.volume_weight` из API Ozon v5
2. `products.volume` из базы данных (если нет в API)
3. Если отсутствует - возвращается ошибка

**Код:**
```javascript
// Строка 133
volume_weight: item.volume_weight || null

// Строки 264-286
let productVolume = calculatorData.volume_weight || null;
if (!productVolume && offer_id) {
  // Пытаемся получить из базы данных
  const productResult = await query(
    'SELECT volume FROM products WHERE sku_ozon = $1 OR sku = $1 LIMIT 1',
    [offer_id]
  );
  if (productResult.rows && productResult.rows.length > 0 && productResult.rows[0].volume) {
    productVolume = parseFloat(productResult.rows[0].volume);
  }
}
```

### 2. Стоимость первого литра логистики (fbs_first_mile_max_amount)
**Путь в ответе:** `item.commissions.fbs_first_mile_max_amount`  
**Описание:** Стоимость логистики за первый литр товара (FBS схема)  
**Использование:** Используется как базовая стоимость логистики

**Код:**
```javascript
// Строки 144, 163, 199, 294
first_mile_amount: parseFloat(commissions.fbs_first_mile_max_amount || 0)

// Строка 294
const firstLiterCost = calculatorData.commissions.FBS?.first_mile_amount;
```

### 3. Стоимость дополнительного литра логистики (fbs_direct_flow_trans_max_amount)
**Путь в ответе:** `item.commissions.fbs_direct_flow_trans_max_amount`  
**Описание:** Стоимость магистрали за каждый дополнительный литр сверх первого (FBS схема)  
**Использование:** Умножается на (объем - 1) для расчета стоимости дополнительных литров

**Код:**
```javascript
// Строки 145, 165, 200, 295
direct_flow_trans_amount: parseFloat(commissions.fbs_direct_flow_trans_max_amount || 0)

// Строка 295
const additionalLiterCost = calculatorData.commissions.FBS?.direct_flow_trans_amount;
```

## Структура ответа API (пример)

**Примечание:** Это пример с вымышленными данными. Для просмотра реального ответа API для конкретного товара:

1. **Через логи сервера:** При запросе цены товара на Ozon, в консоли сервера выводится полный ответ API (строка 116 в `prices.service.js`):
   ```
   [Prices Service] Ozon API v5 response for {offer_id}: {полный JSON ответ}
   ```

2. **Через консоль браузера:** Откройте страницу "Цены", нажмите F12 → Console, и при расчете цен вы увидите логи с данными API.

3. **Прямой запрос:** Используйте endpoint `/api/product/prices/ozon?offer_id={SKU_товара}` для получения данных конкретного товара.

**Пример структуры ответа (вымышленные данные):**
```json
{
  "items": [
    {
      "offer_id": "12345",  // ← SKU товара на Ozon
      "product_id": 67890,
      "volume_weight": 2.5,  // ← Объем товара в литрах
      "commissions": {
        "sales_percent_fbs": 15.0,
        "fbs_deliv_to_customer_amount": 25.0,  // ← Доставка до места выдачи
        "fbs_first_mile_max_amount": 30.0,  // ← Стоимость обработки отправления
        "fbs_direct_flow_trans_max_amount": 214.0,  // ← Итоговая стоимость логистики
        "fbs_return_flow_amount": 139.0  // ← Возвратная логистика
      },
      "price": {
        "price": 1000.0
      }
    }
  ]
}
```

**Для просмотра реального ответа для вашего товара:**
- Найдите `offer_id` (SKU Ozon) товара в базе данных или на странице "Цены"
- Откройте консоль сервера при расчете цены этого товара
- Или сделайте запрос: `GET /api/product/prices/ozon?offer_id={ваш_offer_id}`

## Расчет логистики

**Важно:** Логистика уже рассчитана Ozon и передается в поле `fbs_direct_flow_trans_max_amount`. Не нужно рассчитывать ее самостоятельно!

```javascript
// Строка ~294
// Логистика берется напрямую из API - это уже итоговая стоимость
const logisticsCost = calculatorData.commissions.FBS?.direct_flow_trans_amount;

// Обработка отправления берется из API или используется фиксированная
const shipmentProcessingCost = calculatorData.commissions.FBS?.first_mile_amount;
const processingCost = shipmentProcessingCost && shipmentProcessingCost > 0 
  ? shipmentProcessingCost 
  : 30; // Фиксированная, если не указана в API
```

**Пример:**
- `fbs_direct_flow_trans_max_amount`: 214 ₽ - это уже итоговая стоимость логистики
- `fbs_first_mile_max_amount`: 30 ₽ - стоимость обработки отправления
- **Итого логистика:** 214 ₽ (берется напрямую из API)

## Fallback: API v3 (если v5 не вернул комиссии)

Если API v5 не вернул данные о комиссиях, делается дополнительный запрос к API v3:

**URL:** `https://api-seller.ozon.ru/v3/product/info/list`  
**Метод:** `POST`

**Код (строки 209-254):**
```javascript
const v3Response = await fetch('https://api-seller.ozon.ru/v3/product/info/list', {
  method: 'POST',
  headers: {
    'Client-Id': String(client_id),
    'Api-Key': String(api_key)
  },
  body: JSON.stringify({
    product_id: [item.product_id],
    sku: [],
    offer_id: []
  })
});

// Из ответа v3 извлекаются те же поля:
// - first_mile_amount
// - direct_flow_trans_amount
```

## Проверка наличия данных

Перед использованием проверяется наличие необходимых данных (строки ~256-314):

1. ✅ Итоговая стоимость логистики (`fbs_direct_flow_trans_max_amount`) - **обязательно**
2. ⚠️ Стоимость обработки отправления (`fbs_first_mile_max_amount`) - опционально (если нет, используется 30 ₽)
3. ℹ️ Объем товара (`volume_weight`) - опционально (только для отображения, не влияет на расчет)

Если отсутствует итоговая стоимость логистики, возвращается ошибка с указанием недостающих данных.

## Логирование

Все данные логируются для отладки (строки 332-343):

```javascript
console.log(`[Prices Service] Logistics calculation for ${offer_id}:`, {
  volume: productVolume,
  volumeSource: volumeSource,  // 'API Ozon' или 'база данных'
  firstLiterCost,
  additionalLiterCost,
  logisticsCost,
  dataSource: {
    volume: volumeSource || 'не указан',
    firstLiterCost: 'API Ozon',
    additionalLiterCost: 'API Ozon'
  }
});
```

## Итоговые данные в калькуляторе

После обработки все данные сохраняются в объекте `calculatorData`:

```javascript
calculatorData.volume_weight = productVolume;        // Объем товара (для отображения)
calculatorData.processing_cost = processingCost;     // Обработка отправления (из API или 30 ₽)
calculatorData.logistics_cost = logisticsCost;       // Итоговая стоимость логистики (из API)
calculatorData.commissions.FBS.first_mile_amount;    // Обработка отправления (из API)
calculatorData.commissions.FBS.direct_flow_trans_amount; // Итоговая стоимость логистики (из API)
calculatorData.commissions.FBS.return_amount;        // Возвратная логистика (из API)
calculatorData.commissions.FBS.delivery_amount;      // Доставка до места выдачи (из API)
```

Эти данные передаются на фронтенд для отображения в модальном окне расчета цены.

