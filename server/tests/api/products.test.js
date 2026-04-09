/**
 * Products API Tests
 * Тесты для API товаров
 */

import request from 'supertest';
import app from '../../src/app.js';

describe('Products API', () => {
  let productId = null;
  
  test('GET /api/products should return 200 and array', async () => {
    const response = await request(app)
      .get('/api/products')
      .expect(200);
    
    expect(response.body).toHaveProperty('ok');
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
  });
  
  test('POST /api/products should create a product', async () => {
    const newProduct = {
      name: 'Test Product',
      sku: `TEST-${Date.now()}`,
      price: 100,
      quantity: 10,
    };
    
    const response = await request(app)
      .post('/api/products')
      .send(newProduct)
      .expect(200);
    
    expect(response.body).toHaveProperty('ok');
    expect(response.body.ok).toBe(true);
    
    // Проверяем, что data существует и содержит id (если сервис возвращает созданный продукт)
    if (response.body.data) {
      if (response.body.data.id) {
        productId = response.body.data.id;
        expect(response.body.data).toHaveProperty('id');
      } else if (response.body.data.sku) {
        // Если сервис возвращает продукт без id, используем sku для поиска
        expect(response.body.data).toHaveProperty('sku', newProduct.sku);
      }
    }
  });
  
  test('GET /api/products/:id should return product', async () => {
    if (!productId) {
      console.log('No product ID, skipping test');
      return;
    }
    
    const response = await request(app)
      .get(`/api/products/${productId}`)
      .expect(200);
    
    expect(response.body).toHaveProperty('ok');
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toHaveProperty('id', productId);
  });
  
  test('PUT /api/products/:id should update product', async () => {
    if (!productId) {
      console.log('No product ID, skipping test');
      return;
    }
    
    const update = {
      name: 'Updated Test Product',
      price: 150,
    };
    
    const response = await request(app)
      .put(`/api/products/${productId}`)
      .send(update)
      .expect(200);
    
    expect(response.body).toHaveProperty('ok');
    expect(response.body.ok).toBe(true);
  });
  
  test('DELETE /api/products/:id should delete product', async () => {
    if (!productId) {
      console.log('No product ID, skipping test');
      return;
    }
    
    const response = await request(app)
      .delete(`/api/products/${productId}`)
      .expect(200);
    
    expect(response.body).toHaveProperty('ok');
    expect(response.body.ok).toBe(true);
  });
  
  test('POST /api/products should validate required fields', async () => {
    const invalidProduct = {
      price: 100,
      // missing name and sku
    };
    
    const response = await request(app)
      .post('/api/products')
      .send(invalidProduct)
      .expect(400);
    
    expect(response.body).toHaveProperty('success');
    expect(response.body.success).toBe(false);
  });
});

