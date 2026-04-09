/**
 * Apply Migration
 * Применение миграции SQL
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../src/config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationFile = process.argv[2] || '016_create_user_categories.sql';

async function applyMigration() {
  try {
    const sqlPath = path.join(__dirname, 'migrations/sql', migrationFile);
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Разбиваем SQL на отдельные команды
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--') && !s.startsWith('COMMENT'));
    
    for (const stmt of statements) {
      if (stmt) {
        await query(stmt + ';');
      }
    }
    
    console.log(`✓ Миграция ${migrationFile} применена успешно`);
    process.exit(0);
  } catch (error) {
    console.error('Ошибка применения миграции:', error);
    process.exit(1);
  }
}

applyMigration();

