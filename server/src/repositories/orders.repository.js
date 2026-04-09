/**
 * Orders Repository
 * Слой доступа к данным для заказов
 */

import { readData, writeData } from '../utils/storage.js';

class OrdersRepository {
  async findAll() {
    const ordersData = await readData('orders');
    const orders = ordersData && Array.isArray(ordersData.orders)
      ? ordersData.orders
      : (Array.isArray(ordersData) ? ordersData : []);
    return orders;
  }

  async saveAll(orders) {
    // Обертка для будущего использования (синхронизация и т.п.)
    await writeData('orders', { orders });
    return true;
  }
}

export default new OrdersRepository();


