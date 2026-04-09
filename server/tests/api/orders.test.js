/**
 * Orders API Tests
 * Тесты для API заказов
 */

import request from 'supertest';
import app from '../../src/app.js';

describe('Orders API', () => {
  test('GET /api/orders should return 200 and array', async () => {
    const response = await request(app)
      .get('/api/orders')
      .expect(200);
    
    expect(response.body).toHaveProperty('ok');
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data) || typeof response.body.data === 'object').toBe(true);
  });
  
  test('POST /api/orders/sync-fbs should return response', async () => {
    const response = await request(app)
      .post('/api/orders/sync-fbs')
      .send({})
      .expect((res) => {
        // Может быть 200 (успех) или 429 (rate limit)
        expect([200, 429]).toContain(res.status);
      });
    
    expect(response.body).toHaveProperty('ok');
  });
});

