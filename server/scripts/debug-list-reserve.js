import stockMovementsService from '../src/services/stockMovements.service.js';

const pid = Number(process.argv[2] || 182);
const list = await stockMovementsService.listReservedOrdersForProduct(pid, {});
console.log(JSON.stringify(list, null, 2));
process.exit(0);
