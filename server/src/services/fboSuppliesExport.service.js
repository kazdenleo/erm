/**
 * Шаблон Excel для импорта поставок FBO и выгрузка состава по грузоместам.
 */

import ExcelJS from 'exceljs';
import fboSuppliesPackingService from './fboSuppliesPacking.service.js';
import fboSuppliesPurchaseCalcService from './fboSuppliesPurchaseCalc.service.js';

const SHEET_NAME = 'Товары';

const HEADERS = [
  ['Артикул', 'Количество'],
  ['sku', 'quantity'],
];

const EXAMPLES = [
  ['ART-001', 10],
  ['ART-002', 5],
];

function writeRow(ws, rowIndex, values, font) {
  const row = ws.getRow(rowIndex);
  values.forEach((val, colIndex) => {
    row.getCell(colIndex + 1).value = val;
  });
  if (font) row.font = font;
}

function formatExpiryYmd(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function normalizeMp(marketplace) {
  const m = String(marketplace || 'ozon').toLowerCase();
  if (m === 'wb' || m === 'wildberries') return 'wb';
  return 'ozon';
}

const OZON_PACKING_HEADERS = [
  'ШК товара',
  'Артикул товара',
  'Кол-во товаров',
  'Зона размещения',
  'Срок годности ДО в формате YYYY-MM-DD (не более 1 СГ на 1 SKU в 1 ГМ)',
  'ШК ГМ',
  'Тип ГМ (не обязательно)',
];

const WB_PACKING_HEADERS = [
  'Баркод товара',
  'Кол-во товаров',
  'ШК короба',
  'Срок годности',
];

function purchaseRowDisplayName(row) {
  const raw = String(row?.productName ?? '').trim();
  if (!raw) return '—';
  const first = raw.split(/\r?\n/)[0].trim() || '—';
  if (row?.rowType === 'kit' || row?.isKitHeader) return `[комплект] ${first}`;
  if (row?.rowType === 'component') return `  ↳ ${first}`;
  return first;
}

function formatPurchaseToPurchaseCell(row) {
  if (row?.rowType === 'kit' || row?.isKitHeader) return '';
  const qty = Number(row?.remainingToPurchase ?? row?.toPurchase) || 0;
  if (row?.isKitComponentRow && Number(row?.perKit) > 1) {
    return `${qty} (${row.perKit} шт./компл.)`;
  }
  return qty;
}

class FboSuppliesExportService {
  async buildPackingExportBuffer(supplyId, { profileId } = {}) {
    const { marketplace, rows } = await fboSuppliesPackingService.getPackingExportRows(supplyId, {
      profileId,
    });
    if (!rows.length) {
      const err = new Error('Нет упакованных товаров в грузоместах для выгрузки');
      err.statusCode = 400;
      throw err;
    }

    const mp = normalizeMp(marketplace);
    const headers = mp === 'wb' ? WB_PACKING_HEADERS : OZON_PACKING_HEADERS;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ERM';
    const ws = wb.addWorksheet('Состав по грузоместам');

    writeRow(ws, 1, headers, { bold: true });

    rows.forEach((row, i) => {
      const expiry = formatExpiryYmd(row.expiresAt);
      const values =
        mp === 'wb'
          ? [row.productBarcode || '', row.quantity, row.cargoBarcode || '', expiry]
          : [
              row.productBarcode || '',
              row.article || '',
              row.isEmptyCargo ? '' : row.quantity,
              row.placementZoneLabel || row.placementZone || '',
              expiry,
              row.cargoBarcode || '',
              row.cargoTypeLabel || '',
            ];
      writeRow(ws, i + 2, values);
    });

    const ozonColWidths = [18, 18, 14, 22, 36, 18, 18];
    headers.forEach((_, colIndex) => {
      ws.getColumn(colIndex + 1).width = mp === 'wb' ? (colIndex === 0 ? 22 : 16) : (ozonColWidths[colIndex] || 16);
    });

    const buffer = await wb.xlsx.writeBuffer();
    return {
      buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
      marketplace: mp,
    };
  }

  async buildImportTemplateBuffer() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ERM';
    const ws = wb.addWorksheet(SHEET_NAME);

    HEADERS.forEach((row, i) => {
      writeRow(ws, i + 1, row, i === 0 ? { bold: true } : { italic: true, color: { argb: 'FF666666' } });
    });
    EXAMPLES.forEach((row, i) => {
      writeRow(ws, HEADERS.length + 1 + i, row);
    });

    ws.getColumn(1).width = 24;
    ws.getColumn(2).width = 14;

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  }

  async buildPurchaseCalcExportBuffer(supplyIds, calcPayload, { profileId } = {}) {
    let data = calcPayload;
    const hasClientRows = Array.isArray(calcPayload?.rows) && calcPayload.rows.length > 0;
    if (hasClientRows) {
      await fboSuppliesPurchaseCalcService.assertSuppliesAccessible(supplyIds, { profileId });
    } else {
      data = await fboSuppliesPurchaseCalcService.calculate(supplyIds, { profileId });
    }

    const supplies = Array.isArray(data?.supplies) ? data.supplies : [];
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    if (!rows.length) {
      const err = new Error('Нет данных для выгрузки');
      err.statusCode = 400;
      throw err;
    }

    const totals = data?.totals || { toPurchaseQty: 0, costSum: 0 };
    const fboWarehouse = data?.fboWarehouse;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ERM';
    const ws = wb.addWorksheet('Расчёт закупки');

    let rowIndex = 1;
    if (fboWarehouse?.label) {
      writeRow(ws, rowIndex, [`Склад FBO: ${fboWarehouse.label}`]);
      rowIndex += 1;
    }
    if (supplies.length) {
      writeRow(ws, rowIndex, [`Поставки: ${supplies.map((s) => s.label).join(', ')}`]);
      rowIndex += 1;
    }
    if (rowIndex > 1) rowIndex += 1;

    const headers = [
      'Товар',
      'Артикул',
      'К закупке',
      'Наличие',
      'В пути',
      ...supplies.map((s) => s.label || `Поставка #${s.id}`),
      'Себест.',
      'Итого себест.',
    ];
    writeRow(ws, rowIndex, headers, { bold: true });
    const headerRow = rowIndex;
    rowIndex += 1;

    for (const row of rows) {
      const isKitHeader = row.rowType === 'kit' || row.isKitHeader;
      const supplyValues = supplies.map((s) => {
        const v = row.supplyQty?.[s.id] ?? row.supplyQty?.[String(s.id)];
        return v != null && v !== '' ? Number(v) || 0 : '';
      });
      writeRow(ws, rowIndex, [
        purchaseRowDisplayName(row),
        row.sku || '',
        formatPurchaseToPurchaseCell(row),
        isKitHeader ? '' : Number(row.onHand) || 0,
        isKitHeader ? '' : Number(row.incoming) || 0,
        ...supplyValues,
        isKitHeader ? '' : Number(row.cost) || 0,
        isKitHeader ? '' : Number(row.lineCostTotal) || 0,
      ]);
      rowIndex += 1;
    }

    const totalLabelSpan = 2;
    const totalRow = ws.getRow(rowIndex);
    totalRow.getCell(1).value = 'Итого';
    totalRow.getCell(1).font = { bold: true };
    if (totalLabelSpan > 1) {
      ws.mergeCells(rowIndex, 1, rowIndex, totalLabelSpan);
    }
    totalRow.getCell(3).value = Number(totals.toPurchaseQty) || 0;
    totalRow.getCell(3).font = { bold: true };
    const lastCol = headers.length;
    totalRow.getCell(lastCol).value = Number(totals.costSum) || 0;
    totalRow.getCell(lastCol).font = { bold: true };

    ws.getColumn(1).width = 36;
    ws.getColumn(2).width = 18;
    ws.getColumn(3).width = 14;
    ws.getColumn(4).width = 10;
    ws.getColumn(5).width = 10;
    for (let c = 6; c <= 5 + supplies.length; c += 1) {
      ws.getColumn(c).width = 14;
    }
    ws.getColumn(lastCol - 1).width = 12;
    ws.getColumn(lastCol).width = 14;

    if (headerRow > 1) {
      ws.views = [{ state: 'frozen', ySplit: headerRow }];
    }

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  }
}

export default new FboSuppliesExportService();
