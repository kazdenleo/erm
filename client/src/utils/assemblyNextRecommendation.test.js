import {
  buildAssemblyNextRecommendation,
  pickAssemblyStageGroups,
  assemblyStageLabel,
} from './assemblyNextRecommendation.js';

function grp(key, orderId) {
  const primary = { orderId, marketplace: 'wildberries', productName: orderId };
  return { key, rows: [primary], primary };
}

describe('pickAssemblyStageGroups', () => {
  const a = grp('a', 'A');
  const b = grp('b', 'B');
  const c = grp('c', 'C');

  test('без сессии: слева текущий (первый), справа следующий', () => {
    const stage = pickAssemblyStageGroups({ assemblyGroups: [a, b, c] });
    expect(stage.currentGroup.key).toBe('a');
    expect(stage.currentRole).toBe('current');
    expect(stage.sideGroup.key).toBe('b');
    expect(stage.sideRole).toBe('next');
  });

  test('идёт сборка: слева текущий, справа следующий из очереди', () => {
    const stage = pickAssemblyStageGroups({
      assemblyGroups: [a, b, c],
      currentOrderKey: 'a',
    });
    expect(stage.currentGroup.key).toBe('a');
    expect(stage.currentRole).toBe('current');
    expect(stage.sideGroup.key).toBe('b');
    expect(stage.sideRole).toBe('next');
  });

  test('после сборки: на месте текущего — следующий, справа — предыдущий собранный', () => {
    const stage = pickAssemblyStageGroups({
      assemblyGroups: [b, c],
      collectedGroups: [a],
      currentOrderKey: 'a',
      currentOrderAssembled: true,
    });
    expect(stage.currentGroup.key).toBe('b');
    expect(stage.currentRole).toBe('current');
    expect(stage.sideGroup.key).toBe('a');
    expect(stage.sideRole).toBe('previous');
  });

  test('собрали последний: слева предыдущий собранный', () => {
    const stage = pickAssemblyStageGroups({
      assemblyGroups: [],
      collectedGroups: [a],
      currentOrderKey: 'a',
      currentOrderAssembled: true,
    });
    expect(stage.currentGroup.key).toBe('a');
    expect(stage.currentRole).toBe('previous');
    expect(stage.sideRole).toBe('empty');
  });

  test('один в очереди и есть собранный: справа предыдущий', () => {
    const stage = pickAssemblyStageGroups({
      assemblyGroups: [a],
      collectedGroups: [c],
    });
    expect(stage.currentGroup.key).toBe('a');
    expect(stage.sideGroup.key).toBe('c');
    expect(stage.sideRole).toBe('previous');
  });

  test('подписи ролей', () => {
    expect(assemblyStageLabel('current')).toBe('Текущий заказ');
    expect(assemblyStageLabel('next')).toBe('Следующий к сборке');
    expect(assemblyStageLabel('previous')).toBe('Предыдущий собранный');
  });
});


describe('buildAssemblyNextRecommendation', () => {
  test('берёт первый заказ группы: комплект и упаковка', () => {
    const order = {
      id: 42,
      orderId: '1',
      marketplace: 'ozon',
      productId: 10,
      productName: 'Набор фильтров',
      offerId: 'KIT-1',
      quantity: 1,
      warehouseId: 5,
      isKit: true,
      packingDisplayValue: 'Пакет zip',
      assemblyCompositionLines: [
        { article: 'A1', quantity: 1, name: 'Фильтр A', displayAttributeValue: '' },
        { article: 'B2', quantity: 2, name: 'Фильтр B', displayAttributeValue: '' },
      ],
    };
    const hint = buildAssemblyNextRecommendation({
      key: 'ozon|o:1',
      rows: [order],
      primary: order,
    });
    expect(hint.isKit).toBe(true);
    expect(hint.productName).toBe('Набор фильтров');
    expect(hint.warehouseId).toBe(5);
    expect(hint.packingDisplayValue).toBe('Пакет zip');
    expect(hint.orderDbId).toBe(42);
    expect(hint.orderDbIds).toEqual([42]);
    expect(hint.marketplaceOrderId).toBe('1');
    expect(hint.components).toEqual([
      { article: 'A1', quantity: 1, productId: null, name: 'Фильтр A', displayAttributeValue: '' },
      { article: 'B2', quantity: 2, productId: null, name: 'Фильтр B', displayAttributeValue: '' },
    ]);
  });

  test('обычный товар без состава', () => {
    const order = {
      orderId: '2',
      marketplace: 'wildberries',
      productId: 20,
      productName: 'Фильтр',
      productSku: 'CN1115',
      quantity: 1,
      isKit: false,
    };
    const hint = buildAssemblyNextRecommendation({
      key: 'wb|o:2',
      rows: [order],
      primary: order,
    });
    expect(hint.isKit).toBe(false);
    expect(hint.article).toBe('CN1115');
    expect(hint.components.length).toBe(1);
  });

  test('упаковка с комплектующих, если у комплекта пусто', () => {
    const order = {
      orderId: '3',
      marketplace: 'wildberries',
      productId: 30,
      productName: 'Комплект',
      offerId: 'KIT-2',
      isKit: true,
      assemblyCompositionLines: [
        { article: 'A', quantity: 1, name: 'A', displayAttributeValue: 'Пакет zip' },
        { article: 'B', quantity: 1, name: 'B', displayAttributeValue: 'Пакет zip' },
      ],
    };
    const hint = buildAssemblyNextRecommendation({
      key: 'wb|o:3',
      rows: [order],
      primary: order,
    });
    expect(hint.packingDisplayValue).toBe('Пакет zip');
  });

  test('пустая группа — null', () => {
    expect(buildAssemblyNextRecommendation(null)).toBeNull();
  });
});
