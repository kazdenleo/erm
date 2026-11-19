import { PDFDocument } from 'pdf-lib';
import {
  buildLocationLabelsPdf,
  resolveCellPrintTemplate,
} from '../src/services/addressStorageLabels.service.js';
import { defaultCellTemplate } from '../src/services/productLabels.service.js';

const PT_PER_MM = 72 / 25.4;

const loc = {
  id: 7,
  code: 'A-01-3-2',
  parts: ['A', '01', '3', '2'],
  barcode: null,
};

const settings = {
  levels: [
    { key: 'rack', label: 'Стеллаж' },
    { key: 'row', label: 'Ряд' },
    { key: 'shelf', label: 'Полка' },
    { key: 'cell', label: 'Ячейка' },
  ],
  labelWidthMm: 100,
  labelHeightMm: 80,
};

describe('resolveCellPrintTemplate', () => {
  test('без шаблона — пресет 58x40 и состав по умолчанию', () => {
    const tpl = resolveCellPrintTemplate(null);
    expect(tpl.size_preset).toBe('58x40');
    expect(tpl.elements.map((el) => el.type)).toEqual(['code', 'legend', 'barcode']);
  });

  test('сохранённый пресет не берёт мм со склада', () => {
    const tpl = resolveCellPrintTemplate({
      saved: true,
      id: 3,
      size_preset: '75x120',
      elements: [{ id: 'code', type: 'code', enabled: true, fontSize: 18 }],
    });
    expect(tpl.size_preset).toBe('75x120');
    expect(tpl.elements).toHaveLength(1);
    expect(tpl.elements[0].type).toBe('code');
  });
});

describe('buildLocationLabelsPdf', () => {
  test('размер страницы PDF — пресет конструктора, не мм склада', async () => {
    const unsaved = { ...defaultCellTemplate(), saved: false };
    const buf = await buildLocationLabelsPdf([loc], settings, {
      template: unsaved,
      warehouseName: 'Основной',
    });
    const pdf = await PDFDocument.load(buf);
    expect(pdf.getPageCount()).toBe(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect(width).toBeCloseTo(58 * PT_PER_MM, 1);
    expect(height).toBeCloseTo(40 * PT_PER_MM, 1);
  }, 20000);

  test('сохранённый 75x120 задаёт страницу даже при 58x40 на складе', async () => {
    const saved = {
      ...defaultCellTemplate(),
      size_preset: '75x120',
      saved: true,
      id: 1,
    };
    const buf = await buildLocationLabelsPdf([loc], { ...settings, labelWidthMm: 58, labelHeightMm: 40 }, {
      template: saved,
    });
    const pdf = await PDFDocument.load(buf);
    const { width, height } = pdf.getPage(0).getSize();
    expect(width).toBeCloseTo(75 * PT_PER_MM, 1);
    expect(height).toBeCloseTo(120 * PT_PER_MM, 1);
  }, 20000);
});
