/**
 * Jest Setup
 * Настройка тестового окружения
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Загружаем тестовые переменные окружения
dotenv.config({ path: join(__dirname, '../.env.test') });

// Устанавливаем NODE_ENV для тестов
process.env.NODE_ENV = 'test';

