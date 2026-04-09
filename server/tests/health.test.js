/**
 * Health Check Tests
 * Тесты для health check endpoint
 */

import request from 'supertest';
import app from '../src/app.js';

describe('Health Check Endpoint', () => {
  test('GET /health should return 200 and health status', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);
    
    expect(response.body).toHaveProperty('status');
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('environment');
    expect(response.body).toHaveProperty('version');
    expect(response.body).toHaveProperty('services');
    expect(response.body.status).toBe('ok');
  });
  
  test('GET /health should include database status', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);
    
    expect(response.body.services).toHaveProperty('database');
    expect(response.body.services.database).toHaveProperty('status');
  });
});

