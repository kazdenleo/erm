/** Копия server/src/utils/attributeFormula.js — держать синхронно.
 * Подстановки: {cost}, cost, (cost)*4, {себестоимость}, {additional_expenses}, {attr:12}, {Имя атрибута}.
 */

export const COMPUTED_ATTR_TYPE = 'computed';

export const SYSTEM_ATTR_KEYS = {
  PRICE_BEFORE_DISCOUNT: 'price_before_discount',
  PRICE_AFTER_DISCOUNT: 'price_after_discount',
};

export const SYSTEM_ATTR_LABELS = {
  [SYSTEM_ATTR_KEYS.PRICE_BEFORE_DISCOUNT]: 'Цена до скидки',
  [SYSTEM_ATTR_KEYS.PRICE_AFTER_DISCOUNT]: 'Цена после скидки',
};

export const PRODUCT_FORMULA_FIELDS = [
  { key: 'cost', label: 'Себестоимость', aliases: ['cost', 'себестоимость'] },
  {
    key: 'additional_expenses',
    label: 'Доп. расходы',
    aliases: ['additional_expenses', 'additionalexpenses', 'доп_расходы', 'допрасходы'],
  },
  {
    key: 'min_price',
    label: 'Мин. наценка, ₽',
    aliases: ['min_price', 'minprice', 'мин_наценка'],
  },
  { key: 'weight', label: 'Вес, г', aliases: ['weight', 'вес'] },
  { key: 'length', label: 'Длина упаковки', aliases: ['length', 'длина'] },
  { key: 'width', label: 'Ширина упаковки', aliases: ['width', 'ширина'] },
  { key: 'height', label: 'Высота упаковки', aliases: ['height', 'высота'] },
  { key: 'volume', label: 'Объём, л', aliases: ['volume', 'объём', 'объем'] },
];

const FIELD_ALIAS_TO_KEY = (() => {
  const map = {};
  for (const field of PRODUCT_FORMULA_FIELDS) {
    for (const alias of field.aliases) {
      map[normalizeToken(alias)] = field.key;
    }
  }
  return map;
})();

const FUNC_NAMES = new Set(['round', 'min', 'max', 'abs', 'ceil', 'floor']);

export function isComputedAttrType(type) {
  return String(type || '').trim().toLowerCase() === COMPUTED_ATTR_TYPE;
}

export function isSystemPriceAttrKey(systemKey) {
  const key = String(systemKey || '').trim();
  return key === SYSTEM_ATTR_KEYS.PRICE_BEFORE_DISCOUNT || key === SYSTEM_ATTR_KEYS.PRICE_AFTER_DISCOUNT;
}

export function isSystemPriceAttr(attr) {
  return isSystemPriceAttrKey(attr?.system_key);
}

function normalizeToken(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/ё/g, 'е');
}

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number(String(value).replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function formatComputedValue(n) {
  if (n == null || !Number.isFinite(n)) return '';
  const rounded = Math.round(n * 10000) / 10000;
  if (Object.is(rounded, -0)) return '0';
  const asStr = rounded.toFixed(4).replace(/\.?0+$/, '');
  return asStr === '-0' ? '0' : asStr;
}

function readProductField(product, fieldKey) {
  if (!product || typeof product !== 'object') return null;
  if (fieldKey === 'cost') return toFiniteNumber(product.cost);
  if (fieldKey === 'additional_expenses') {
    return toFiniteNumber(product.additional_expenses ?? product.additionalExpenses);
  }
  if (fieldKey === 'min_price') {
    return toFiniteNumber(product.min_price ?? product.minPrice);
  }
  if (fieldKey === 'weight') return toFiniteNumber(product.weight);
  if (fieldKey === 'length') return toFiniteNumber(product.length);
  if (fieldKey === 'width') return toFiniteNumber(product.width);
  if (fieldKey === 'height') return toFiniteNumber(product.height);
  if (fieldKey === 'volume') return toFiniteNumber(product.volume);
  return null;
}

function parseAttrIdToken(token) {
  const raw = String(token || '').trim();
  const m = /^(?:attr|id|#)\s*[:#]?\s*(\d+)$/i.exec(raw);
  if (m) return m[1];
  if (/^\d+$/.test(raw)) return raw;
  return null;
}

export function parseFormulaRefs(formula) {
  const src = String(formula || '');
  const refs = [];
  const re = /\{([^{}]+)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1].trim();
    if (!raw) continue;
    const attrId = parseAttrIdToken(raw);
    if (attrId) {
      refs.push({ kind: 'attr', attrId, raw });
      continue;
    }
    const fieldKey = FIELD_ALIAS_TO_KEY[normalizeToken(raw)];
    if (fieldKey) {
      refs.push({ kind: 'field', key: fieldKey, raw });
      continue;
    }
    refs.push({ kind: 'attr', name: raw, raw });
  }
  return refs;
}

function findAttrByRef(ref, attributes) {
  const list = Array.isArray(attributes) ? attributes : [];
  if (ref.attrId) {
    return list.find((a) => String(a?.id) === String(ref.attrId)) || null;
  }
  const name = normalizeToken(ref.name || ref.raw);
  if (!name) return null;
  return (
    list.find((a) => normalizeToken(a?.name) === name) ||
    list.find((a) => isSystemPriceAttrKey(a?.system_key) && normalizeToken(SYSTEM_ATTR_LABELS[a.system_key]) === name) ||
    null
  );
}

function readAttrValue(attr, values) {
  if (!attr?.id) return null;
  const map = values && typeof values === 'object' ? values : {};
  return toFiniteNumber(map[String(attr.id)] ?? map[attr.id]);
}

function resolveRefValue(ref, { product, attributes, values }) {
  if (ref.kind === 'field') return readProductField(product, ref.key);
  const attr = findAttrByRef(ref, attributes);
  if (!attr) return null;
  return readAttrValue(attr, values);
}

function tokenizeMath(expr) {
  const tokens = [];
  let i = 0;
  const s = String(expr || '');
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if ('+-*/%(),'.includes(c)) {
      tokens.push({ t: c });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let num = '';
      let dots = 0;
      while (i < s.length && /[0-9.]/.test(s[i])) {
        if (s[i] === '.') dots += 1;
        num += s[i];
        i += 1;
      }
      if (!num || dots > 1 || num === '.') {
        throw new Error(`Некорректное число: ${num || c}`);
      }
      tokens.push({ t: 'num', v: Number(num) });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let id = '';
      while (i < s.length && /[A-Za-z_0-9]/.test(s[i])) {
        id += s[i];
        i += 1;
      }
      tokens.push({ t: 'id', v: id.toLowerCase() });
      continue;
    }
    throw new Error(`Недопустимый символ в формуле: «${c}»`);
  }
  return tokens;
}

function evalMath(expr) {
  const tokens = tokenizeMath(expr);
  let pos = 0;
  const peek = () => tokens[pos] || { t: 'eof' };
  const eat = (t) => {
    const cur = peek();
    if (t && cur.t !== t) throw new Error('Ошибка разбора формулы');
    pos += 1;
    return cur;
  };

  function parseArgs() {
    eat('(');
    if (peek().t === ')') {
      eat(')');
      return [];
    }
    const args = [parseExpr()];
    while (peek().t === ',') {
      eat(',');
      args.push(parseExpr());
    }
    eat(')');
    return args;
  }

  function parsePrimary() {
    const cur = peek();
    if (cur.t === 'num') {
      eat();
      return cur.v;
    }
    if (cur.t === 'id') {
      eat();
      if (!FUNC_NAMES.has(cur.v)) {
        throw new Error(`Неизвестная функция: ${cur.v}`);
      }
      const args = parseArgs();
      if (cur.v === 'abs') {
        if (args.length !== 1) throw new Error('abs() принимает 1 аргумент');
        return Math.abs(args[0]);
      }
      if (cur.v === 'ceil') {
        if (args.length !== 1) throw new Error('ceil() принимает 1 аргумент');
        return Math.ceil(args[0]);
      }
      if (cur.v === 'floor') {
        if (args.length !== 1) throw new Error('floor() принимает 1 аргумент');
        return Math.floor(args[0]);
      }
      if (cur.v === 'round') {
        if (args.length < 1 || args.length > 2) throw new Error('round() принимает 1 или 2 аргумента');
        const digits = args.length === 2 ? Math.max(0, Math.min(8, Math.trunc(args[1]))) : 0;
        const f = 10 ** digits;
        return Math.round(args[0] * f) / f;
      }
      if (cur.v === 'min') {
        if (!args.length) throw new Error('min() нужен хотя бы 1 аргумент');
        return Math.min(...args);
      }
      if (cur.v === 'max') {
        if (!args.length) throw new Error('max() нужен хотя бы 1 аргумент');
        return Math.max(...args);
      }
    }
    if (cur.t === '(') {
      eat('(');
      const v = parseExpr();
      eat(')');
      return v;
    }
    throw new Error('Ожидалось число или скобка');
  }

  function parseUnary() {
    if (peek().t === '+') {
      eat('+');
      return parseUnary();
    }
    if (peek().t === '-') {
      eat('-');
      return -parseUnary();
    }
    return parsePrimary();
  }

  function parseMul() {
    let v = parseUnary();
    while (peek().t === '*' || peek().t === '/' || peek().t === '%') {
      const op = eat().t;
      const r = parseUnary();
      if (op === '*') v *= r;
      else if (op === '/') {
        if (r === 0) throw new Error('Деление на ноль');
        v /= r;
      } else {
        if (r === 0) throw new Error('Деление на ноль');
        v %= r;
      }
    }
    return v;
  }

  function parseExpr() {
    let v = parseMul();
    while (peek().t === '+' || peek().t === '-') {
      const op = eat().t;
      const r = parseMul();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  if (!tokens.length) throw new Error('Пустая формула');
  const value = parseExpr();
  if (peek().t !== 'eof') throw new Error('Лишние символы в формуле');
  if (!Number.isFinite(value)) throw new Error('Результат не является числом');
  return value;
}

function substituteRefs(formula, ctx) {
  const missing = [];
  let replaced = String(formula || '').replace(/\{([^{}]+)\}/g, (_, inner) => {
    const ref = parseFormulaRefs(`{${inner}}`)[0];
    if (!ref) {
      missing.push(inner);
      return '0';
    }
    const value = resolveRefValue(ref, ctx);
    if (value == null) {
      missing.push(inner.trim());
      return '0';
    }
    return String(value);
  });
  replaced = replaced.replace(/[\p{L}_][\p{L}0-9_]*/gu, (id) => {
    const lower = id.toLowerCase();
    if (FUNC_NAMES.has(lower)) return id;
    const fieldKey = FIELD_ALIAS_TO_KEY[normalizeToken(id)];
    if (!fieldKey) return id;
    const value = readProductField(ctx.product, fieldKey);
    if (value == null) {
      missing.push(id);
      return '0';
    }
    return String(value);
  });
  return { replaced, missing };
}

export function evaluateFormula(formula, ctx = {}) {
  const src = String(formula || '').trim();
  if (!src) return { ok: false, error: 'Формула пуста' };
  if (/[{}]/.test(src.replace(/\{[^{}]+\}/g, ''))) {
    return { ok: false, error: 'Некорректные фигурные скобки' };
  }
  try {
    const { replaced, missing } = substituteRefs(src, ctx);
    if (missing.length) {
      return { ok: false, error: `Нет значения: ${missing.join(', ')}`, missing };
    }
    const value = evalMath(replaced);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err?.message || 'Ошибка формулы' };
  }
}

export function validateFormula(formula) {
  const src = String(formula || '').trim();
  if (!src) return 'Введите формулу';
  try {
    const { replaced } = substituteRefs(src, {
      product: {
        cost: 1,
        additional_expenses: 1,
        min_price: 1,
        weight: 1,
        length: 1,
        width: 1,
        height: 1,
        volume: 1,
      },
      attributes: [],
      values: {},
    });
    evalMath(replaced.replace(/\{[^{}]+\}/g, '1'));
    return null;
  } catch (err) {
    return err?.message || 'Ошибка формулы';
  }
}

function topoSortComputed(computedAttrs, attributes) {
  const ids = computedAttrs.map((a) => String(a.id));
  const idSet = new Set(ids);
  const deps = new Map(ids.map((id) => [id, new Set()]));
  for (const attr of computedAttrs) {
    const id = String(attr.id);
    for (const ref of parseFormulaRefs(attr.formula)) {
      const target = findAttrByRef(ref, attributes);
      if (target && idSet.has(String(target.id)) && String(target.id) !== id) {
        deps.get(id).add(String(target.id));
      }
    }
  }
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const [id, set] of deps) {
    incoming.set(id, set.size);
  }
  const queue = ids.filter((id) => (incoming.get(id) || 0) === 0);
  const ordered = [];
  while (queue.length) {
    const id = queue.shift();
    ordered.push(id);
    for (const [other, set] of deps) {
      if (!set.has(id)) continue;
      set.delete(id);
      incoming.set(other, (incoming.get(other) || 0) - 1);
      if ((incoming.get(other) || 0) === 0) queue.push(other);
    }
  }
  return { ordered, cyclic: ordered.length !== ids.length };
}

function isManualFlag(manual, attrId) {
  const map = manual && typeof manual === 'object' ? manual : {};
  const v = map[String(attrId)] ?? map[attrId];
  return v === true || v === 'true' || v === 1 || v === '1';
}

export function applyComputedAttributeValues({
  product,
  attributes,
  values,
  manual,
} = {}) {
  const list = Array.isArray(attributes) ? attributes : [];
  const next = { ...(values && typeof values === 'object' ? values : {}) };
  const errors = {};
  const computed = list.filter((a) => a && a.id != null && isComputedAttrType(a.type) && String(a.formula || '').trim());
  if (!computed.length) return { values: next, errors };

  const { ordered, cyclic } = topoSortComputed(computed, list);
  const byId = new Map(computed.map((a) => [String(a.id), a]));
  const visit = cyclic ? computed.map((a) => String(a.id)) : ordered;

  for (const id of visit) {
    const attr = byId.get(id);
    if (!attr) continue;
    if (isManualFlag(manual, id)) continue;
    const result = evaluateFormula(attr.formula, { product, attributes: list, values: next });
    if (!result.ok) {
      errors[id] = result.error;
      continue;
    }
    next[id] = formatComputedValue(result.value);
  }
  return { values: next, errors };
}
