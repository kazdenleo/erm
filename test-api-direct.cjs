// Используем встроенный fetch (Node.js 18+)

async function testOzonAPI() {
    console.log('=== ТЕСТ OZON API ДЛЯ AN1048 ===');
    
    try {
        const response = await fetch('http://localhost:3001/product/prices/ozon?offer_id=AN1048', {
            method: 'GET'
        });
        
        const data = await response.json();
        
        console.log('=== ПОЛНЫЙ ОТВЕТ ОТ СЕРВЕРА ===');
        console.log(JSON.stringify(data, null, 2));
        
        if (data.ok && data.data) {
            console.log('\n=== ДАННЫЕ ТОВАРА ===');
            console.log('Found:', data.data.found);
            
            if (data.data.calculator) {
                console.log('\n=== КАЛЬКУЛЯТОР ДАННЫЕ ===');
                console.log(JSON.stringify(data.data.calculator, null, 2));
            }
            
            if (data.data.items && data.data.items[0]) {
                console.log('\n=== СЫРЫЕ ДАННЫЕ ИЗ API ===');
                console.log(JSON.stringify(data.data.items[0], null, 2));
                
                if (data.data.items[0].commissions) {
                    console.log('\n=== КОМИССИИ ===');
                    console.log(JSON.stringify(data.data.items[0].commissions, null, 2));
                }
            }
        } else {
            console.log('\n=== ОШИБКА ===');
            console.log(data.error || 'Неизвестная ошибка');
        }
        
    } catch (error) {
        console.error('Ошибка:', error.message);
    }
}

testOzonAPI();
