import assert from 'node:assert/strict';
import { yandexExtractLinePriceRub } from '../src/services/orders.sync.service.js';

// Кабинет «Цена за шт. до скидки» — Campaign OrderDTO
assert.equal(
  yandexExtractLinePriceRub(
    {
      count: 1,
      price: 117,
      buyerPrice: 117,
      buyerPriceBeforeDiscount: 461,
      priceBeforeDiscount: 461,
    },
    { buyerItemsTotalBeforeDiscount: 461 },
    null
  ),
  461
);

// Business API: payment + subsidy + cashback
assert.equal(
  yandexExtractLinePriceRub(
    {
      count: 1,
      prices: {
        payment: { value: 117 },
        subsidy: { value: 256 },
        cashback: { value: 88 },
      },
    },
    {},
    null
  ),
  461
);

// Не брать один только subsidy как цену
assert.equal(
  yandexExtractLinePriceRub(
    {
      count: 1,
      prices: {
        payment: { value: 1 },
        subsidy: { value: 400 },
        cashback: { value: 460 },
      },
    },
    {},
    null
  ),
  861
);

console.log('yandexExtractLinePriceRub: ok');
