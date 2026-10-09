/**
 * Загрузка классификатора ОКПД2 в таблицу okpd2_codes (полная замена).
 * Usage: npm run import-okpd2
 */
import { closePool } from '../src/config/database.js';
import okpd2DirectoryService from '../src/services/okpd2Directory.service.js';

try {
  const res = await okpd2DirectoryService.importDirectory();
  console.log(`ОКПД2: загружено ${res.count} кодов (источник: ${res.source})`);
} catch (e) {
  console.error('Ошибка импорта ОКПД2:', e?.message || e);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
