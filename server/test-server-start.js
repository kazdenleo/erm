// Тестовый скрипт для проверки запуска сервера
import app from './src/app.js';
import config from './src/config/index.js';
import { testConnection } from './src/config/database.js';

const PORT = config.port || 5000;

console.log('========================================');
console.log('  Testing Server Startup');
console.log('========================================');
console.log(`Port: ${PORT}`);
console.log(`Environment: ${config.nodeEnv}`);
console.log('');

// Проверяем подключение к БД
if (config.database.usePostgreSQL) {
  console.log('Testing database connection...');
  try {
    const dbConnected = await testConnection();
    if (dbConnected) {
      console.log('✓ Database connection: OK');
    } else {
      console.log('⚠ Database connection: FAILED (but continuing...)');
    }
  } catch (error) {
    console.log('⚠ Database connection error:', error.message);
  }
  console.log('');
}

// Пытаемся запустить сервер
console.log('Starting HTTP server...');
try {
  const server = app.listen(PORT, () => {
    console.log('========================================');
    console.log('  ✓ Server Started Successfully!');
    console.log('========================================');
    console.log(`Listening on http://localhost:${PORT}`);
    console.log(`API available at http://localhost:${PORT}/api`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log('========================================');
    console.log('');
    console.log('Server is running. Press Ctrl+C to stop.');
  });
  
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`✗ ERROR: Port ${PORT} is already in use`);
      console.error('  Please stop the process using this port or change PORT in .env');
    } else {
      console.error('✗ Server error:', error.message);
      console.error(error.stack);
    }
    process.exit(1);
  });
  
} catch (error) {
  console.error('✗ Failed to start server:');
  console.error('  Error:', error.message);
  console.error('  Stack:', error.stack);
  process.exit(1);
}

