import {
  normalizeWbSalesReportRow,
  FIELD_MAP,
} from '../src/utils/wbSalesReportsDetailed.js';
import { extractWbFinanceAmounts } from '../src/utils/wbFinanceReportAmounts.js';

describe('normalizeWbSalesReportRow', () => {
  test('maps camelCase money and ids to legacy snake_case numbers', () => {
    const row = normalizeWbSalesReportRow({
      sellerOperName: 'Продажа',
      vendorCode: 'AN1048',
      nmId: 357074182,
      retailPrice: '742.00',
      retailAmount: '640.00',
      commissionPercent: 50,
      forPay: '345.40',
      acquiringFee: '25.60',
      deliveryService: '0',
      paidStorage: '12.5',
      officeName: 'ПВЗ',
      deliveryMethod: 'FBS',
      rrdId: 1001,
      orderId: 555,
      srid: 'abc',
      title: 'Фильтр масляный',
    });

    expect(row.supplier_oper_name).toBe('Продажа');
    expect(row.sa_name).toBe('AN1048');
    expect(row.nm_id).toBe(357074182);
    expect(row.retail_price).toBe(742);
    expect(row.retail_amount).toBe(640);
    expect(row.ppvz_for_pay).toBe(345.4);
    expect(row.acquiring_fee).toBe(25.6);
    expect(row.delivery_rub).toBe(0);
    expect(row.storage_fee).toBe(12.5);
    expect(row.office_name).toBe('ПВЗ');
    expect(row.delivery_method).toBe('FBS');
    expect(row.rrd_id).toBe(1001);
    expect(row.assembly_id).toBe(555);
    expect(row.subject_name).toBe('Фильтр масляный');

    const amounts = extractWbFinanceAmounts(row);
    expect(amounts.retail_amount).toBe(742);
    expect(amounts.commission_amount).toBe(371);
    expect(amounts.payout_amount).toBe(345.4);
    expect(amounts.acquiring_amount).toBe(25.6);
  });

  test('FIELD_MAP covers payout rename', () => {
    expect(FIELD_MAP.forPay).toBe('ppvz_for_pay');
    expect(FIELD_MAP.sellerOperName).toBe('supplier_oper_name');
    expect(FIELD_MAP.vendorCode).toBe('sa_name');
  });
});
