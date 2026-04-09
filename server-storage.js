// Серверное хранилище данных для ERP системы
// Заменяет localStorage на серверное API

class ServerStorage {
  constructor(baseUrl = 'http://localhost:3001') {
    this.baseUrl = baseUrl;
  }

  // Получить данные по типу
  async getData(type) {
    try {
      const response = await fetch(`${this.baseUrl}/api/data/${type}`);
      const result = await response.json();
      
      if (result.ok) {
        return result.data;
      } else {
        console.error(`Error getting ${type} data:`, result.message);
        return {};
      }
    } catch (error) {
      console.error(`Network error getting ${type} data:`, error);
      return {};
    }
  }

  // Сохранить данные по типу
  async setData(type, data) {
    try {
      const response = await fetch(`${this.baseUrl}/api/data/${type}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });
      
      const result = await response.json();
      
      if (result.ok) {
        console.log(`${type} data saved successfully`);
        return true;
      } else {
        console.error(`Error saving ${type} data:`, result.message);
        return false;
      }
    } catch (error) {
      console.error(`Network error saving ${type} data:`, error);
      return false;
    }
  }

  // Получить все данные
  async getAllData() {
    try {
      const response = await fetch(`${this.baseUrl}/api/data`);
      const result = await response.json();
      
      if (result.ok) {
        return result.data;
      } else {
        console.error('Error getting all data:', result.message);
        return {};
      }
    } catch (error) {
      console.error('Network error getting all data:', error);
      return {};
    }
  }

  // Очистить все данные
  async clearAllData() {
    try {
      const response = await fetch(`${this.baseUrl}/api/data`, {
        method: 'DELETE',
      });
      
      const result = await response.json();
      
      if (result.ok) {
        console.log('All data cleared successfully');
        return true;
      } else {
        console.error('Error clearing data:', result.message);
        return false;
      }
    } catch (error) {
      console.error('Network error clearing data:', error);
      return false;
    }
  }

  // Специальные методы для маркетплейсов
  async getMarketplaceConfig(marketplace) {
    const configs = {
      ozon: 'ozon',
      wb: 'wildberries',
      ym: 'yandex'
    };
    
    const type = configs[marketplace];
    if (!type) {
      console.error(`Unknown marketplace: ${marketplace}`);
      return {};
    }
    
    return await this.getData(type);
  }

  async setMarketplaceConfig(marketplace, config) {
    const configs = {
      ozon: 'ozon',
      wb: 'wildberries',
      ym: 'yandex'
    };
    
    const type = configs[marketplace];
    if (!type) {
      console.error(`Unknown marketplace: ${marketplace}`);
      return false;
    }
    
    return await this.setData(type, config);
  }

  // Специальные методы для поставщиков
  async getSupplierConfig(supplier) {
    const configs = {
      mikado: 'mikado',
      moskvorechie: 'moskvorechie'
    };
    
    const type = configs[supplier];
    if (!type) {
      console.error(`Unknown supplier: ${supplier}`);
      return {};
    }
    
    return await this.getData(type);
  }

  async setSupplierConfig(supplier, config) {
    const configs = {
      mikado: 'mikado',
      moskvorechie: 'moskvorechie'
    };
    
    const type = configs[supplier];
    if (!type) {
      console.error(`Unknown supplier: ${supplier}`);
      return false;
    }
    
    return await this.setData(type, config);
  }

  // Методы для других данных
  async getCategories() {
    return await this.getData('categories');
  }

  async setCategories(categories) {
    return await this.setData('categories', categories);
  }

  async getBrands() {
    return await this.getData('brands');
  }

  async setBrands(brands) {
    return await this.setData('brands', brands);
  }

  async getProducts() {
    return await this.getData('products');
  }

  async setProducts(products) {
    return await this.setData('products', products);
  }

  async getWarehouseSuppliers() {
    return await this.getData('warehouse_suppliers');
  }

  async setWarehouseSuppliers(products) {
    return await this.setData('warehouse_suppliers', products);
  }
}

// Создаем глобальный экземпляр
window.serverStorage = new ServerStorage();

// Экспортируем для использования в модулях
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ServerStorage;
}
