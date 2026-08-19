import {
  buildOzonRichContentJson,
  buildOzonRichContentFromResolved,
  stringifyOzonRichContent,
  buildWbStructuredDescription,
  buildYmStructuredDescription,
  isOzonRichContentAttrId,
  shouldSkipOzonAttrForRichTable,
  OZON_RICH_CONTENT_ATTR_ID,
} from '../src/utils/marketplaceRichContent.js';
import {
  defaultRichContentModules,
  normalizeRichContentModules,
  resolveRichModulesForRender,
  fillRichPlaceholders,
  syncCharacteristicsFields,
  parseStoredRichContentModules,
} from '../src/utils/richContentTemplate.js';

describe('marketplaceRichContent', () => {
  test('Ozon JSON: заголовок, таблица характеристик, описание, без localhost-фото', () => {
    const json = buildOzonRichContentJson({
      name: 'Стойка стабилизатора',
      brand: 'Zekkert',
      sku: 'SS-1234',
      description: 'Передняя стойка стабилизатора для легковых авто.',
      characteristics: [
        { name: 'OEM', value: '1K0411303' },
        { name: 'Rich-контент JSON', value: '{}' },
        { name: 'Бренд', value: 'Zekkert->85' },
      ],
      imageUrls: [
        'http://cdn.example/a.jpg',
        'https://localhost/uploads/x.jpg',
        'https://cdn.example/a.jpg',
        'https://cdn.example/b.jpg',
      ],
    });

    expect(json.version).toBe(0.3);
    expect(Array.isArray(json.content)).toBe(true);
    const names = json.content.map((w) => w.widgetName);
    expect(names).toContain('raText');
    expect(names).toContain('raTable');
    expect(names).toContain('raShowcase');

    const table = json.content.find((w) => w.widgetName === 'raTable');
    const cells = table.body.flat().map((c) => c.content[0]);
    expect(cells).toContain('OEM');
    expect(cells).toContain('1K0411303');
    expect(cells.join(' ')).not.toMatch(/Rich-контент/);
    expect(cells).toContain('Zekkert');

    const showcase = json.content.find((w) => w.widgetName === 'raShowcase');
    expect(showcase.blocks).toHaveLength(2);
    expect(showcase.blocks[0].img.src).toBe('https://cdn.example/a.jpg');

    const raw = stringifyOzonRichContent(json);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).toContain('"version":0.3');
  });

  test('WB/YM: структурированное описание из тех же полей', () => {
    const input = {
      name: 'Фильтр масляный',
      brand: 'MANN',
      sku: 'W712',
      description: 'Оригинальный фильтр.',
      characteristics: [{ name: 'Высота', value: 'товар 80' }],
    };
    const wb = buildWbStructuredDescription(input);
    const ym = buildYmStructuredDescription(input);
    expect(wb).toContain('Фильтр масляный');
    expect(wb).toContain('• Бренд: MANN');
    expect(wb).toContain('Оригинальный фильтр.');
    expect(ym).toBe(wb);
  });

  test('служебные id Ozon Rich не попадают в таблицу', () => {
    expect(isOzonRichContentAttrId(OZON_RICH_CONTENT_ATTR_ID)).toBe(true);
    expect(shouldSkipOzonAttrForRichTable(11254, 'x')).toBe(true);
    expect(shouldSkipOzonAttrForRichTable(85, 'Бренд')).toBe(false);
  });
});

describe('richContentTemplate', () => {
  test('плейсхолдеры и авто-характеристики', () => {
    const ctx = {
      name: 'Стойка',
      brand: 'Zekkert',
      sku: 'SS-1',
      description: 'Текст',
      characteristics: [{ id: '85', name: 'OEM', value: '1K0' }],
      attrsById: new Map([['85', { name: 'OEM', value: '1K0' }]]),
      attrsByName: new Map([['oem', { name: 'OEM', value: '1K0' }]]),
      imageUrls: ['https://cdn.example/a.jpg'],
    };
    expect(fillRichPlaceholders('{{brand}} {{attr:85}}', ctx)).toBe('Zekkert 1K0');
    const blocks = resolveRichModulesForRender(defaultRichContentModules(), ctx);
    const types = blocks.map((b) => b.type);
    expect(types).toContain('heading');
    expect(types).toContain('characteristics');
    expect(types).toContain('text');
    expect(types).toContain('images');
    const json = buildOzonRichContentFromResolved(blocks);
    expect(json.content.some((w) => w.widgetName === 'raTable')).toBe(true);
  });

  test('sync добавляет новые поля, не затирая выбранные', () => {
    const modules = [
      {
        type: 'characteristics',
        mode: 'selected',
        fields: [{ key: '85', label: 'Бренд' }],
      },
    ];
    const next = syncCharacteristicsFields(modules, [
      { key: '85', label: 'Бренд Ozon' },
      { key: '8229', label: 'Тип' },
    ]);
    expect(next[0].fields.map((f) => f.key)).toEqual(['85', '8229']);
    expect(next[0].fields[0].label).toBe('Бренд Ozon');
  });

  test('оформление модуля попадает в токены Ozon', () => {
    const ctx = {
      name: 'Стойка',
      brand: 'Zekkert',
      sku: 'SS-1',
      description: 'Текст',
      characteristics: [{ id: '85', name: 'OEM', value: '1K0' }],
      attrsById: new Map(),
      attrsByName: new Map(),
      imageUrls: [],
    };
    const modules = defaultRichContentModules();
    modules[0].style = {
      align: 'center',
      titleSize: 'xl',
      titleColor: '#cccccc',
      background: '#111827',
    };
    const blocks = resolveRichModulesForRender(modules, ctx);
    expect(blocks[0].style.align).toBe('center');
    expect(blocks[0].style.background).toBe('#111827');
    const json = buildOzonRichContentFromResolved(blocks);
    const heading = json.content.find((w) => w.widgetName === 'raText');
    expect(heading.title.align).toBe('center');
    expect(heading.title.size).toBe('size5');
    expect(heading.title.color).toBe('color2');
  });

  test('фон-картинка сохраняется в стиле модуля', () => {
    const next = normalizeRichContentModules([
      {
        type: 'heading',
        style: {
          backgroundImage: 'https://cdn.example/bg.jpg',
          backgroundFit: 'contain',
        },
      },
    ]);
    expect(next[0].style.backgroundImage).toBe('https://cdn.example/bg.jpg');
    expect(next[0].style.backgroundFit).toBe('contain');
  });

  test('parseStoredRichContentModules: пустое — нет шаблона товара', () => {
    expect(parseStoredRichContentModules(null)).toBeNull();
    expect(parseStoredRichContentModules([])).toBeNull();
    const parsed = parseStoredRichContentModules([{ type: 'heading', source: 'name' }]);
    expect(parsed[0].type).toBe('heading');
  });
});
