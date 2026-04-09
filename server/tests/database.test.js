/**
 * Database Connection Tests
 * Тесты подключения к PostgreSQL
 */

import { testConnection, query, closePool } from '../src/config/database.js';
import config from '../src/config/index.js';

describe('Database Connection', () => {
  test('should connect to PostgreSQL', async () => {
    if (!config.database.usePostgreSQL) {
      console.log('PostgreSQL is disabled, skipping test');
      return;
    }
    
    const connected = await testConnection();
    expect(connected).toBe(true);
  });
  
  test('should execute a simple query', async () => {
    if (!config.database.usePostgreSQL) {
      console.log('PostgreSQL is disabled, skipping test');
      return;
    }
    
    const result = await query('SELECT 1 as test');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].test).toBe(1);
  });
  
  afterAll(async () => {
    if (config.database.usePostgreSQL) {
      await closePool();
    }
  });
});

