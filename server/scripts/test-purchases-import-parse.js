/**
 * node scripts/test-purchases-import-parse.js
 */

import ExcelJS from 'exceljs';
import purchasesImportService, {
  PURCHASE_IMPORT_PARSER_VERSION,
  normalizeSupplierPrefixes,
} from '../src/services/purchasesImport.service.js';

async function buildBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  rows.forEach((r, i) => {
    const row = ws.getRow(i + 1);
    row.getCell(1).value = r[0];
    row.getCell(2).value = r[1];
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function main() {
  const prefixes = normalizeSupplierPrefixes(['xnfl', 'xmil']);
  const buffer = await buildBuffer([
    ['xmil-e400058', 1],
    ['xnfl-kn1034k', 3],
    ['xnfl-kn1034k', '4'],
  ]);

  const result = await purchasesImportService.parseWorksheetOnly(buffer, prefixes);
  console.log('parser:', PURCHASE_IMPORT_PARSER_VERSION, result.parserVersion);
  console.log('sourceRows 1034k:', result.sourceRows.filter((s) => s.rawArticle.includes('1034k')));
  console.log('preview:', result.preview.filter((p) => String(p.cleanSku).includes('1034')));

  const kn = result.preview.find((p) => String(p.cleanSku).toLowerCase().includes('1034'));
  if (!kn || kn.quantity !== 7) {
    console.error('FAIL: expected kn1034k qty 7 (3+4), got', kn);
    process.exit(1);
  }
  console.log('OK: duplicate rows summed to', kn.quantity);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
