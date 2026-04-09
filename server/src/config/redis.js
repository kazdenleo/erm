/**
 * Redis Configuration
 * Подключение к Redis для кэширования
 */

import { createClient } from 'redis';
import { getEnv } from './env.js';

let redisClient = null;
let connectionAttempted = false;
let connectionFailed = false;

/**
 * Получить клиент Redis
 */
export async function getRedisClient() {
  // Если уже есть открытое соединение, возвращаем его
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  // Если уже пытались подключиться и не удалось, не пытаемся снова
  if (connectionFailed) {
    return null;
  }

  // Если уже пытаемся подключиться, ждем
  if (connectionAttempted && !connectionFailed) {
    // Ждем немного и проверяем снова
    await new Promise(resolve => setTimeout(resolve, 100));
    if (redisClient && redisClient.isOpen) {
      return redisClient;
    }
    if (connectionFailed) {
      return null;
    }
  }

  connectionAttempted = true;
  const redisHost = getEnv('REDIS_HOST', 'localhost');
  const redisPort = parseInt(getEnv('REDIS_PORT', '6379'));
  const redisPassword = getEnv('REDIS_PASSWORD', null);

  try {
    redisClient = createClient({
      socket: {
        host: redisHost,
        port: redisPort,
        reconnectStrategy: false // Отключаем автоматическое переподключение
      },
      password: redisPassword || undefined
    });

    redisClient.on('error', (err) => {
      // Логируем только первую ошибку
      if (!connectionFailed) {
        console.error('[Redis] Connection error:', err.message);
        connectionFailed = true;
      }
    });

    redisClient.on('connect', () => {
      console.log('[Redis] Connected to Redis');
      connectionFailed = false;
    });

    // Устанавливаем таймаут для подключения
    const connectPromise = redisClient.connect();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout')), 2000);
    });

    await Promise.race([connectPromise, timeoutPromise]);
    connectionFailed = false;
    return redisClient;
  } catch (error) {
    connectionFailed = true;
    // Логируем только первую ошибку
    if (!connectionAttempted || error.message !== 'Connection timeout') {
      // Не логируем, так как Redis опционален
    }
    // Возвращаем null, если Redis недоступен - приложение продолжит работу без кэша
    return null;
  }
}

/**
 * Проверить доступность Redis
 */
export async function isRedisAvailable() {
  try {
    const client = await getRedisClient();
    if (!client) return false;
    // Используем таймаут для ping
    const pingPromise = client.ping();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Ping timeout')), 1000);
    });
    await Promise.race([pingPromise, timeoutPromise]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Получить значение из кэша
 */
export async function getCache(key) {
  try {
    const client = await getRedisClient();
    if (!client) return null;
    
    const value = await client.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.error('[Redis] Get cache error:', error.message);
    return null;
  }
}

/**
 * Установить значение в кэш
 */
export async function setCache(key, value, ttlSeconds = 3600) {
  try {
    const client = await getRedisClient();
    if (!client) return false;
    
    await client.setEx(key, ttlSeconds, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error('[Redis] Set cache error:', error.message);
    return false;
  }
}

/**
 * Удалить значение из кэша
 */
export async function deleteCache(key) {
  try {
    const client = await getRedisClient();
    if (!client) return false;
    
    await client.del(key);
    return true;
  } catch (error) {
    console.error('[Redis] Delete cache error:', error.message);
    return false;
  }
}

/**
 * Удалить все ключи по паттерну
 */
export async function deleteCachePattern(pattern) {
  try {
    const client = await getRedisClient();
    if (!client) return false;
    
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(keys);
    }
    return true;
  } catch (error) {
    console.error('[Redis] Delete cache pattern error:', error.message);
    return false;
  }
}

/**
 * Закрыть соединение с Redis
 */
export async function closeRedis() {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    redisClient = null;
  }
}

export default {
  getRedisClient,
  isRedisAvailable,
  getCache,
  setCache,
  deleteCache,
  deleteCachePattern,
  closeRedis
};

