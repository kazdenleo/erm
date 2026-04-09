/**
 * CORS Configuration
 * Настройки Cross-Origin Resource Sharing для API
 */

export const corsOptions = {
  origin: function (origin, callback) {
    // Список разрешенных источников
    const allowedOrigins = [
      process.env.CLIENT_URL || 'http://localhost:3000',
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    ];
    
    // В development разрешаем все источники
    if (process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    
    // В production проверяем список
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Account-Id',
    'X-Organization-Id',
  ],
  exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Per-Page'],
  maxAge: 86400 // 24 часа
};

