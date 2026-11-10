import 'dotenv/config';
import fboSuppliesService from '../../src/services/fboSupplies.service.js';

try {
  const list = await fboSuppliesService.list({
    profileId: 6,
    limit: 50,
    statuses: ['new', 'collecting', 'packing', 'ready_for_supply'],
    skipReserveTotals: true,
  });
  console.log('list_ok', list.length, list.map((s) => ({ id: s.id, status: s.status, ship: s.externalShipmentNumber })));
} catch (e) {
  console.error('list_fail', e.message, e.stack?.split('\n').slice(0, 8).join('\n'));
}

try {
  const list2 = await fboSuppliesService.list({
    profileId: 6,
    limit: 50,
    statuses: ['new', 'collecting', 'packing', 'ready_for_supply'],
    skipReserveTotals: false,
  });
  console.log('list_reserve_ok', list2.length);
} catch (e) {
  console.error('list_reserve_fail', e.message, e.stack?.split('\n').slice(0, 12).join('\n'));
}

try {
  const all = await fboSuppliesService.list({ profileId: null, limit: 20, skipReserveTotals: true });
  console.log('list_all_profiles', all.length, all.slice(0, 5).map((s) => ({ id: s.id, status: s.status, profileId: s.profileId })));
} catch (e) {
  console.error('list_all_fail', e.message);
}

process.exit(0);
