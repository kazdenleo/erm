import { boostAtPrice, elasticBoostLevels, elasticBoostScale } from '../src/utils/ozonElasticBoost.js';

describe('ozonElasticBoost', () => {
  const an1217 = {
    action_price: 926,
    price_min_elastic: { amount: '927', currency: '' },
    price_max_elastic: { amount: '725', currency: '' },
    min_boost: 15,
    max_boost: 55,
  };

  test('края: 927 ₽ это 15%, 725 ₽ это 55%', () => {
    const levels = elasticBoostLevels(an1217);
    expect(levels[0]).toMatchObject({ boost: 15, price: 927, current: true });
    expect(levels[levels.length - 1]).toMatchObject({ boost: 55, price: 725, current: false });
    expect(levels.map((level) => level.boost)).toEqual([15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  test('текущая цена 926 ₽ даёт 15.2%, как в ответе Ozon', () => {
    const scale = elasticBoostScale(an1217);
    expect(boostAtPrice(scale, 926)).toBe(15.2);
  });

  test('без краёв шкалы уровней нет', () => {
    expect(elasticBoostLevels({ min_boost: 10, max_boost: 20 })).toEqual([]);
  });
});
