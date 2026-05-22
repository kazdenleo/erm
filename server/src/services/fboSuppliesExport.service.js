/**
 * Шаблон Excel для импорта поставок FBO.
 */

import ExcelJS from 'exceljs';

const SUPPLIES_HEADERS = [
  ['Маркетплейс', 'Название', 'Дата готовности', 'Склад маркетплейса', 'Номер отгрузки', 'Склад списания (ID)', 'Организация', 'Списать остатки'],
  ['marketplace', 'name', 'ready_at', 'marketplace_warehouse', 'external_shipment_number', 'deduction_warehouse_id', 'organization', 'deduct_stock'],
];

const ITEMS_HEADERS = [
  ['Номер отгрузки', 'Артикул', 'Штрихкод', 'Количество', 'Название'],
  ['external_shipment_number', 'sku', 'barcode', 'quantity', 'name'],
];

const EXAMPLE_SUPPLIES = [
  ['ozon', 'новая Москва', '2026-06-01', 'МО Пушкино 1 РЦ', '2000033134343', '', 'ИП Пример', 'нет'],
  ['wb', 'Поставка WB', '2026-06-05', 'Коледино', 'WB-GI-123456', '1', 'ИП Пример', 'да'],
];

const EXAMPLE_ITEMS = [
  ['2000033134343', 'ART-001', '4600000000001', 10, 'Товар пример 1'],
  ['2000033134343', 'ART-002', '', 5, 'Товар пример 2'],
  ['WB-GI-123456', 'ART-001', '4600000000001', 3, ''],
];

function fillSheet(ws, headerRows, examples) {
  headerRows.forEach((row, i) => {
    ws.getRow(i + 1).values = row;
    ws.getRow(i + 1).font = i === 0 ? { bold: true } : { italic: true, color: { argb: 'FF666666' } };
  });
  examples.forEach((row, i) => {
    ws.getRow(headerRows.length + 1 + i).values = row;
  });
  ws.columns.forEach((col, idx) => {
    const maxLen = Math.max(
      12,
      ...headerRows.map((r) => String(r[idx] || '').length),
      ...examples.map((r) => String(r[idx] || '').length)
    );
    col.width = Math.min(44, maxLen + 2);
  });
}

class FboSuppliesExportService {
  async buildImportTemplateBuffer() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ERM';
    const suppliesWs = wb.addWorksheet('Поставки');
    const itemsWs = wb.addWorksheet('Товары');
    const hintWs = wb.addWorksheet('Подсказки');

    fillSheet(suppliesWs, SUPPLIES_HEADERS, EXAMPLE_SUPPLIES);
    fillSheet(itemsWs, ITEMS_HEADERS, EXAMPLE_ITEMS);

    hintWs.getColumn(1).width = 90;
    const hints = [
      'Маркетплейс: ozon, wb (Wildberries), ym (Яндекс Маркет)',
      'Дата готовности: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ',
      'Номер отгрузки — уникальный идентификатор поставки на МП (связывает листы)',
      'Склад списания — ID склада из раздела «Склады» (тип warehouse)',
      'Списать остатки: да/нет — фактическое списание при статусе «Отгружен»',
      'Товары: артикул или штрихкод должны совпадать с карточкой в ERM',
    ];
    hints.forEach((t, i) => {
      hintWs.getCell(i + 1, 1).value = t;
    });

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}

export default new FboSuppliesExportService();
