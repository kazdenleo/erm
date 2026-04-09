import { spawn } from 'child_process';
import http from 'http';

// Проверяем, запущен ли сервер
function checkServer() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:5000/health', (res) => {
      resolve(true);
    });
    
    req.on('error', () => {
      resolve(false);
    });
    
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Запускаем сервер
async function main() {
  console.log('Checking if server is running...');
  const isRunning = await checkServer();
  
  if (isRunning) {
    console.log('✓ Server is already running on port 5000');
    process.exit(0);
  }
  
  console.log('✗ Server is not running. Starting server...');
  console.log('');
  
  // Запускаем сервер
  const serverProcess = spawn('node', ['server.js'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true
  });
  
  serverProcess.on('error', (error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
  
  // Ждем немного и проверяем снова
  setTimeout(async () => {
    const isRunning = await checkServer();
    if (isRunning) {
      console.log('');
      console.log('✓ Server started successfully!');
      console.log('  Available at: http://localhost:5000');
    } else {
      console.log('');
      console.log('⚠ Server process started but not responding yet.');
      console.log('  Check the output above for errors.');
    }
  }, 5000);
}

main();

