// КОД ДЛЯ КОНСОЛИ БРАУЗЕРА - МИГРАЦИЯ ДАННЫХ НА СЕРВЕР
// Скопируйте и вставьте этот код в консоль браузера на странице http://localhost:3001

async function migrateFromBrowser() {
  console.log("=== МИГРАЦИЯ ДАННЫХ ИЗ LOCALSTORAGE НА СЕРВЕР ===");

  const migrationMap = {
    "mp:ozon": "ozon",
    "mp:wildberries": "wildberries", 
    "mp:yandex": "yandex",
    "supplier:mikado": "mikado",
    "supplier:moskvorechie": "moskvorechie",
    "categories": "categories",
    "brands": "brands",
    "products": "products",
    "warehouse_suppliers": "warehouse_suppliers"
  };

  let migratedCount = 0;
  let errorCount = 0;

  for (const [localKey, serverType] of Object.entries(migrationMap)) {
    const localData = localStorage.getItem(localKey);

    if (localData) {
      try {
        const parsed = JSON.parse(localData);
        console.log(`Мигрируем ${localKey} → ${serverType}:`, parsed);

        const response = await fetch(`http://localhost:3001/api/data/${serverType}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed)
        });

        const result = await response.json();
        if (result.ok) {
          console.log(`✅ ${localKey} успешно перенесен на сервер`);
          migratedCount++;
        } else {
          console.log(`❌ Ошибка переноса ${localKey}:`, result.message);
          errorCount++;
        }

      } catch (e) {
        console.log(`❌ Ошибка парсинга ${localKey}:`, e.message);
        errorCount++;
      }
    } else {
      console.log(`⏭️ ${localKey}: Пусто (пропускаем)`);
    }
  }

  console.log(`📊 Результат миграции: ${migratedCount} успешно, ${errorCount} ошибок`);

  // Проверяем результат на сервере
  try {
    const response = await fetch("http://localhost:3001/api/data");
    const result = await response.json();

    if (result.ok) {
      console.log("📋 Данные на сервере после миграции:");
      for (const [type, data] of Object.entries(result.data)) {
        if (Object.keys(data).length > 0) {
          console.log(`${type.toUpperCase()}:`, data);
        }
      }
    }
  } catch (error) {
    console.error("Ошибка проверки сервера:", error);
  }
}

// Запускаем миграцию
migrateFromBrowser();
