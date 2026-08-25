import {
  applyComputedAttributeValues,
  evaluateFormula,
  formatComputedValue,
  parseFormulaRefs,
  validateFormula,
} from '../src/utils/attributeFormula.js';

describe('attributeFormula', () => {
  test('evaluates product field refs and math', () => {
    const r = evaluateFormula('{cost} * 1.5 + {additional_expenses}', {
      product: { cost: 100, additional_expenses: 20 },
      attributes: [],
      values: {},
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(170);
  });

  test('supports Russian alias for cost', () => {
    const r = evaluateFormula('{себестоимость} * 2', {
      product: { cost: 40 },
      attributes: [],
      values: {},
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(80);
  });

  test('reads other attributes by name and id', () => {
    const attributes = [
      { id: 11, name: 'Наценка', type: 'number' },
      { id: 12, name: 'Итог', type: 'computed', formula: '{cost} + {Наценка}' },
    ];
    const byName = evaluateFormula('{cost} + {Наценка}', {
      product: { cost: 50 },
      attributes,
      values: { 11: '15' },
    });
    const byId = evaluateFormula('{attr:11} * 2', {
      product: {},
      attributes,
      values: { 11: '15' },
    });
    expect(byName.ok).toBe(true);
    expect(byName.value).toBe(65);
    expect(byId.ok).toBe(true);
    expect(byId.value).toBe(30);
  });

  test('missing dependency returns error', () => {
    const r = evaluateFormula('{cost} * 2', { product: {}, attributes: [], values: {} });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('cost');
  });

  test('accepts bare cost identifier and parentheses', () => {
    const ctx = { product: { cost: 515 }, attributes: [], values: {} };
    const a = evaluateFormula('(cost)*4', ctx);
    const b = evaluateFormula('cost * 4', ctx);
    const c = evaluateFormula('round(cost * 2, 0)', ctx);
    expect(a.ok).toBe(true);
    expect(a.value).toBe(2060);
    expect(b.ok).toBe(true);
    expect(b.value).toBe(2060);
    expect(c.ok).toBe(true);
    expect(c.value).toBe(1030);
    expect(validateFormula('(cost)*4')).toBeNull();
  });

  test('rejects unknown identifiers after substitution', () => {
    expect(validateFormula('{cost} * foo')).toBeTruthy();
  });

  test('round min max functions', () => {
    const r = evaluateFormula('round(min({cost} * 1.333, 200), 2)', {
      product: { cost: 100 },
      attributes: [],
      values: {},
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(133.3);
  });

  test('applyComputedAttributeValues skips manual and fills others', () => {
    const attributes = [
      { id: 1, name: 'Себест. копия', type: 'computed', formula: '{cost}' },
      { id: 2, name: 'Цена', type: 'computed', formula: '{cost} * 2' },
    ];
    const { values, errors } = applyComputedAttributeValues({
      product: { cost: 80 },
      attributes,
      values: { 1: '1', 2: '1' },
      manual: { 1: true },
    });
    expect(values['1']).toBe('1');
    expect(values['2']).toBe('160');
    expect(errors['1']).toBeUndefined();
  });

  test('formatComputedValue trims zeros', () => {
    expect(formatComputedValue(10)).toBe('10');
    expect(formatComputedValue(10.5)).toBe('10.5');
    expect(formatComputedValue(10.12345)).toBe('10.1235');
  });

  test('parseFormulaRefs classifies tokens', () => {
    const refs = parseFormulaRefs('{cost} + {attr:9} + {Цвет}');
    expect(refs.map((r) => r.kind)).toEqual(['field', 'attr', 'attr']);
    expect(refs[0].key).toBe('cost');
    expect(refs[1].attrId).toBe('9');
    expect(refs[2].name).toBe('Цвет');
  });
});
