/**
 * Импорт классификатора ТН ВЭД ЕАЭС из справочника ФНС в таблицу tn_ved_codes.
 * Usage:
 *   npm run import-tnved                 — скачать https://data.nalog.ru/files/tnved/tnved.zip
 *   npm run import-tnved -- path/to.zip  — локальный архив
 */
import { closePool } from '../src/config/database.js';
import tnVedDirectoryService from '../src/services/tnVedDirectory.service.js';

const file = process.argv[2] || null;

try {
  const res = await tnVedDirectoryService.importFromFns(file ? { file } : {});
  console.log(`ТН ВЭД: загружено ${res.count} кодов (версия ФНС ${res.version})`);
} catch (e) {
  console.error('Ошибка импорта ТН ВЭД:', e?.message || e);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
