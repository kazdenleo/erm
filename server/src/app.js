/**
 * Express Application
 * Главный файл приложения Express с полной настройкой безопасности и middleware
 */

import express from 'express';
import config from './config/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import requestLogger from './middleware/requestLogger.js';
import { 
  helmetMiddleware, 
  corsMiddleware, 
  rateLimiter,
  jsonSizeLimit 
} from './middleware/security.js';
import { getHealth } from './controllers/healthController.js';
import { wrapAsync } from './middleware/errorHandler.js';
import path from 'path';
import { fileURLToPath } from 'url';

// API routes
import routes from './routes/index.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Trust proxy (для правильного определения IP за reverse proxy)
app.set('trust proxy', 1);

// Security middleware (должны быть первыми)
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(rateLimiter);

// Body parsing middleware с ограничением размера
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    // Пропускаем пустой body
    if (!buf || buf.length === 0) {
      return;
    }
    try {
      JSON.parse(buf);
    } catch (e) {
      // Логируем ошибку, но не выбрасываем (обработается в errorHandler)
      if (config.isDevelopment) {
        console.error('[JSON] Parse error:', e.message);
      }
    }
  },
  strict: false
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request logging (после body parsing)
app.use(requestLogger);

// Root endpoint (информация об API)
app.get('/', (req, res) => {
  res.json({
    name: 'ERP System API',
    version: '1.0.0',
    status: 'running',
    environment: config.nodeEnv,
    endpoints: {
      health: '/health',
      api: '/api',
      products: '/api/products',
      orders: '/api/orders',
      warehouses: '/api/warehouses',
      suppliers: '/api/suppliers',
      integrations: '/api/integrations',
    },
    documentation: 'See README.md for API documentation',
  });
});

// Health check endpoint (до основных роутов)
app.get('/health', wrapAsync(getHealth));

// Браузер всегда запрашивает favicon — без маршрута попадает в 404 и шумит errorHandler
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Static uploads (product images)
app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));

// API routes
app.use('/api', routes);

// 404 handler
app.use(notFoundHandler);

// Error handler (должен быть последним)
app.use(errorHandler);

export default app;
