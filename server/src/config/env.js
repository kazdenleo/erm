/**
 * Environment Configuration
 * Загрузка и проверка переменных окружения
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Загружаем переменные окружения (ищем .env в корне проекта)
const projectRoot = process.cwd();
dotenv.config({ path: join(projectRoot, '.env') });

export const config = {
  // Server Configuration
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Client Configuration
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  
  // API Configuration
  apiTimeout: parseInt(process.env.API_TIMEOUT) || 30000,
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'debug',
  
  // Data Directory (относительно корня проекта)
  dataDir: join(projectRoot, 'data'),
  
  // Database Configuration
  dbHost: process.env.DB_HOST || 'localhost',
  dbPort: parseInt(process.env.DB_PORT) || 5432,
  dbName: process.env.DB_NAME || 'erp_system',
  dbUser: process.env.DB_USER || 'postgres',
  dbPassword: process.env.DB_PASSWORD || 'postgres',
  
  // Redis Configuration (optional)
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT) || 6379,
  redisPassword: process.env.REDIS_PASSWORD || null
};

// Проверка обязательных переменных окружения
const requiredEnvVars = ['PORT', 'CLIENT_URL'];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0 && process.env.NODE_ENV === 'production') {
  console.error('Missing required environment variables:', missingVars.join(', '));
  process.exit(1);
}

/**
 * Получить переменную окружения с значением по умолчанию
 */
export function getEnv(name, defaultValue = null) {
  return process.env[name] || defaultValue;
}

export default config;

