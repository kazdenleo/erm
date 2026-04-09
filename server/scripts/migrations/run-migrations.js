/**
 * Migration Runner
 * Скрипт для выполнения миграций PostgreSQL
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, transaction, closePool } from '../../src/config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, 'sql');

// Таблица для отслеживания выполненных миграций
async function createMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      version VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(500) NOT NULL,
      executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Получить список выполненных миграций
async function getExecutedMigrations() {
  const result = await query('SELECT version FROM schema_migrations ORDER BY version');
  return result.rows.map(row => row.version);
}

// Выполнить миграцию
async function runMigration(version, name, sql) {
  console.log(`[Migration] Running ${version}: ${name}`);
  
  try {
    await transaction(async (client) => {
      // Выполняем SQL миграции
      await client.query(sql);
      
      // Записываем в таблицу миграций
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [version, name]
      );
    });
    
    console.log(`[Migration] ✓ ${version}: ${name} completed`);
    return true;
  } catch (error) {
    console.error(`[Migration] ✗ ${version}: ${name} failed:`, error.message);
    throw error;
  }
}

// Откатить миграцию
async function rollbackMigration(version) {
  console.log(`[Migration] Rolling back ${version}`);
  
  try {
    await transaction(async (client) => {
      // Удаляем запись о миграции
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    });
    
    console.log(`[Migration] ✓ ${version} rolled back`);
    return true;
  } catch (error) {
    console.error(`[Migration] ✗ ${version} rollback failed:`, error.message);
    throw error;
  }
}

// Получить список файлов миграций
function getMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(file => file.endsWith('.sql'))
    .sort();
  
  return files.map(file => {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Invalid migration file name: ${file}`);
    }
    return {
      version: match[1],
      name: match[2],
      file: file,
      path: path.join(MIGRATIONS_DIR, file)
    };
  });
}

// Выполнить все миграции
async function runAllMigrations() {
  console.log('[Migration] Starting migrations...');
  
  await createMigrationsTable();
  const executed = await getExecutedMigrations();
  const files = getMigrationFiles();
  
  const pending = files.filter(f => !executed.includes(f.version));
  
  if (pending.length === 0) {
    console.log('[Migration] No pending migrations');
    return;
  }
  
  console.log(`[Migration] Found ${pending.length} pending migrations`);
  
  for (const migration of pending) {
    const sql = fs.readFileSync(migration.path, 'utf8');
    await runMigration(migration.version, migration.name, sql);
  }
  
  console.log('[Migration] All migrations completed');
}

// Главная функция
async function main() {
  const command = process.argv[2];
  
  try {
    if (command === 'up') {
      await runAllMigrations();
    } else if (command === 'status') {
      const executed = await getExecutedMigrations();
      const files = getMigrationFiles();
      
      console.log('\n[Migration] Status:');
      console.log('Executed:', executed.length);
      console.log('Total:', files.length);
      console.log('Pending:', files.length - executed.length);
      
      files.forEach(f => {
        const status = executed.includes(f.version) ? '✓' : '○';
        console.log(`  ${status} ${f.version}: ${f.name}`);
      });
    } else {
      console.log('Usage: node run-migrations.js [up|status]');
      process.exit(1);
    }
  } catch (error) {
    console.error('[Migration] Error:', error);
    process.exit(1);
  } finally {
    // Важно: закрываем пул, иначе процесс на Windows может "висеть"
    try {
      await closePool();
    } catch (_) {}
  }
}

main().then(() => process.exit(0));

