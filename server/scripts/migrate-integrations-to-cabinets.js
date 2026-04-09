/**
 * One-time: copy legacy marketplace integrations into marketplace_cabinets for an organization.
 * Usage: node scripts/migrate-integrations-to-cabinets.js [organizationNamePattern]
 * Example: node scripts/migrate-integrations-to-cabinets.js "Зеленоград"
 * If no pattern given, uses first organization.
 */

import { query } from '../src/config/database.js';

async function main() {
  const pattern = process.argv[2] || null;

  const orgResult = pattern
    ? await query(
        "SELECT id, name FROM organizations WHERE name ILIKE $1 ORDER BY id LIMIT 1",
        ['%' + pattern + '%']
      )
    : await query('SELECT id, name FROM organizations ORDER BY id LIMIT 1');

  if (!orgResult.rows.length) {
    console.log('Организация не найдена.');
    process.exit(1);
  }
  const org = orgResult.rows[0];
  console.log('Организация:', org.name, '(id=' + org.id + ')');

  const legacy = await query(
    "SELECT code, name, config FROM integrations WHERE type = 'marketplace' AND code IN ('ozon', 'wildberries', 'yandex')"
  );

  if (!legacy.rows.length) {
    console.log('Нет старых настроек маркетплейсов в таблице integrations.');
    process.exit(0);
  }

  for (const row of legacy.rows) {
    const existing = await query(
      'SELECT id FROM marketplace_cabinets WHERE organization_id = $1 AND marketplace_type = $2',
      [org.id, row.code]
    );
    if (existing.rows.length) {
      console.log('  Уже есть кабинет', row.code, '- пропуск');
      continue;
    }
    await query(
      `INSERT INTO marketplace_cabinets (organization_id, marketplace_type, name, config, is_active, sort_order)
       VALUES ($1, $2, $3, $4::jsonb, true, 0)`,
      [org.id, row.code, row.name || row.code, JSON.stringify(row.config || {})]
    );
    console.log('  Добавлен кабинет:', row.code, row.name);
  }

  console.log('Готово.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
