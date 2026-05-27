/**
 * Проверка готовности БД и API списка поставок FBO (запуск на сервере: node scripts/admin/check_fbo_supplies.mjs).
 */

import fboSuppliesService from '../../src/services/fboSupplies.service.js';
import { query } from '../../src/config/database.js';

const TABLES = [
  'fbo_supplies',
  'fbo_supply_items',
  'fbo_supply_cargo_units',
  'fbo_supply_cargo_contents',
];

async function tableExists(name) {
  const r = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name]
  );
  return (r.rows?.length ?? 0) > 0;
}

async function main() {
  console.log('Проверка таблиц FBO…');
  for (const t of TABLES) {
    const ok = await tableExists(t);
    console.log(`  ${ok ? 'OK' : 'НЕТ'}  ${t}`);
  }
  try {
    const list = await fboSuppliesService.list({ profileId: null, limit: 3 });
    console.log(`list(): OK, записей: ${list.length}`);
  } catch (e) {
    console.error('list(): ОШИБКА', e.message);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
