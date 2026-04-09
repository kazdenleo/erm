/**
 * Configuration Module
 * Централизованная конфигурация с валидацией через Zod
 */

import dotenv from 'dotenv';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Определяем корень проекта (папка на уровень выше от server/src/config/)
// Если запускаем из server/, то поднимаемся на уровень выше
const projectRoot = __dirname.includes('server/src/config') 
  ? join(__dirname, '../../../') 
  : process.cwd();

// Загружаем переменные окружения (ищем .env в корне проекта)
const envPath = join(projectRoot, '.env');
const envLoaded = dotenv.config({ path: envPath });

// Логируем загрузку .env (только в development)
if (process.env.NODE_ENV === 'development') {
  if (envLoaded.error) {
    console.warn(`[Config] .env file not found at: ${envPath}`);
  } else {
    console.log(`[Config] Loaded .env from: ${envPath}`);
    console.log(`[Config] DB_USER: ${process.env.DB_USER || 'not set'}`);
    console.log(`[Config] USE_POSTGRESQL: ${process.env.USE_POSTGRESQL || 'not set'}`);
  }
}

// Схема валидации конфигурации
const configSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.string().regex(/^\d+$/).transform(Number).default('3001'),
  CLIENT_URL: z.string().url().default('http://localhost:3000'),
  
  // Database
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().regex(/^\d+$/).transform(Number).default('5432'),
  DB_NAME: z.string().min(1).default('erp_system'),
  DB_USER: z.string().default('admin'),
  DB_PASSWORD: z.string().default(''),
  USE_POSTGRESQL: z.string().transform(val => val === 'true').default('false'),
  
  // Redis (optional)
  REDIS_HOST: z.string().optional().default('localhost'),
  REDIS_PORT: z.string().regex(/^\d+$/).transform(Number).optional().default('6379'),
  REDIS_PASSWORD: z.string().optional(),
  
  // API Configuration
  API_TIMEOUT: z.string().regex(/^\d+$/).transform(Number).default('30000'),
  /** Макс. запросов с одного IP за окно (массовый пересчёт цен даёт сотни запросов подряд) */
  API_RATE_LIMIT_MAX: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .optional(),
  /** Окно rate limit в минутах */
  API_RATE_LIMIT_WINDOW_MINUTES: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  
  // JWT (for future use)
  JWT_SECRET: z.string().min(32).optional(),
  JWT_EXPIRES_IN: z.string().default('24h'),

  // Auth
  DISABLE_AUTH: z.string().optional(),
  
  // API Keys (marketplaces and suppliers)
  OZON_CLIENT_ID: z.string().optional(),
  OZON_API_KEY: z.string().optional(),
  WB_API_KEY: z.string().optional(),
  YANDEX_API_KEY: z.string().optional(),
  YANDEX_CAMPAIGN_ID: z.string().optional(),
  MIKADO_USER_ID: z.string().optional(),
  MIKADO_PASSWORD: z.string().optional(),
  MOSKVORECHIE_USER_ID: z.string().optional(),
  MOSKVORECHIE_API_KEY: z.string().optional(),

  // Тихая печать: URL локального Print Helper для клиентов (обычно http://127.0.0.1:9100)
  PRINT_HELPER_URL: z.string().optional().default(''),

  // SMTP (регистрация аккаунтов: пароль на почту)
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 587;
    }),
  SMTP_SECURE: z.string().optional().default('false'),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  /** From: "Имя <email@domain.com>" или просто email */
  MAIL_FROM: z.string().optional().default(''),
});

// Валидация и парсинг конфигурации
let config;

try {
  const parsed = configSchema.parse(process.env);
  
  config = {
    // Server
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    clientUrl: parsed.CLIENT_URL,
    isDevelopment: parsed.NODE_ENV === 'development',
    isProduction: parsed.NODE_ENV === 'production',
    isTest: parsed.NODE_ENV === 'test',
    
    // Database
    database: {
      host: parsed.DB_HOST,
      port: parsed.DB_PORT,
      name: parsed.DB_NAME,
      user: parsed.DB_USER,
      password: parsed.DB_PASSWORD || undefined,
      usePostgreSQL: parsed.USE_POSTGRESQL,
      // Connection string (если пароль пустой, не указываем его в URL)
      connectionString: parsed.DB_PASSWORD 
        ? `postgresql://${parsed.DB_USER}:${parsed.DB_PASSWORD}@${parsed.DB_HOST}:${parsed.DB_PORT}/${parsed.DB_NAME}`
        : `postgresql://${parsed.DB_USER}@${parsed.DB_HOST}:${parsed.DB_PORT}/${parsed.DB_NAME}`,
      // Pool configuration
      pool: {
        min: 2,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      }
    },
    
    // Redis
    redis: {
      host: parsed.REDIS_HOST,
      port: parsed.REDIS_PORT,
      password: parsed.REDIS_PASSWORD || undefined,
    },
    
    // API
    api: {
      timeout: parsed.API_TIMEOUT,
      rateLimit: {
        max:
          parsed.API_RATE_LIMIT_MAX ??
          (parsed.NODE_ENV === 'development' ? 12000 : 8000),
        windowMs:
          (parsed.API_RATE_LIMIT_WINDOW_MINUTES ?? 15) * 60 * 1000,
      },
    },
    
    // Logging
    logging: {
      level: parsed.LOG_LEVEL,
    },
    
    // JWT
    jwt: {
      secret: parsed.JWT_SECRET || 'change-this-secret-in-production',
      expiresIn: parsed.JWT_EXPIRES_IN,
    },

    // Auth
    auth: {
      disabled: String(parsed.DISABLE_AUTH || '').toLowerCase() === '1' || String(parsed.DISABLE_AUTH || '').toLowerCase() === 'true',
    },
    
    // API Keys
    apiKeys: {
      ozon: {
        clientId: parsed.OZON_CLIENT_ID,
        apiKey: parsed.OZON_API_KEY,
      },
      wildberries: {
        apiKey: parsed.WB_API_KEY,
      },
      yandex: {
        apiKey: parsed.YANDEX_API_KEY,
        campaignId: parsed.YANDEX_CAMPAIGN_ID,
      },
      mikado: {
        userId: parsed.MIKADO_USER_ID,
        password: parsed.MIKADO_PASSWORD,
      },
      moskvorechie: {
        userId: parsed.MOSKVORECHIE_USER_ID,
        apiKey: parsed.MOSKVORECHIE_API_KEY,
      },
    },
    
    // Paths (относительно корня проекта)
    paths: {
      dataDir: join(projectRoot, 'data'),
      logsDir: join(projectRoot, 'logs'),
    },

    // Тихая печать: один билд для всех — клиент запрашивает GET /api/config и использует этот URL
    printHelperUrl: (parsed.PRINT_HELPER_URL || '').trim(),

    mail: {
      enabled:
        !!(String(parsed.SMTP_HOST || '').trim() && String(parsed.MAIL_FROM || '').trim()),
      host: String(parsed.SMTP_HOST || '').trim(),
      port: parsed.SMTP_PORT,
      secure: String(parsed.SMTP_SECURE || '').toLowerCase() === 'true',
      user: String(parsed.SMTP_USER || '').trim(),
      pass: String(parsed.SMTP_PASS || '').trim(),
      from: String(parsed.MAIL_FROM || '').trim(),
    },
  };
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('❌ Configuration validation failed:');
    error.errors.forEach((err) => {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
  }
  throw error;
}

export default config;

