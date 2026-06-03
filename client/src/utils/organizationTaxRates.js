/**
 * Ставки НДС и налога по организации (синхронно с server/src/utils/organizationTaxRates.js).
 */

export const TAX_SYSTEM_OPTIONS = [
  { value: '', label: '— Не указано —' },
  { value: 'USN_INCOME_OUTCOME', label: 'УСН (доходы − расходы) — 15%' },
  { value: 'USN_INCOME', label: 'УСН (доходы) — 6%' },
  { value: 'OSN', label: 'ОСН (общая) — 20% с прибыли' },
  { value: 'PSN', label: 'ПСН' },
  { value: 'ESHN', label: 'ЕСХН' },
  { value: 'OTHER', label: 'Иное' },
];

export function normalizeTaxSystemCode(taxSystem) {
  const raw = String(taxSystem || '').trim();
  if (!raw) return '';
  const u = raw.toUpperCase().replace(/\s+/g, '_');
  if (u === 'USN_INCOME' || u === 'USN_6') return 'USN_INCOME';
  if (u === 'USN_INCOME_OUTCOME' || u === 'USN_15') return 'USN_INCOME_OUTCOME';
  if (u === 'OSN') return 'OSN';
  if (/ДОХОД.*(МИНУС|РАСХОД)|РАСХОД.*ДОХОД|INCOME.*OUTCOME/i.test(raw)) return 'USN_INCOME_OUTCOME';
  if (/УСН|USN/.test(raw) && /ДОХОД|INCOME/.test(raw) && !/РАСХОД|OUTCOME|МИНУС/i.test(raw)) return 'USN_INCOME';
  if (/ОСН|OSN/.test(raw)) return 'OSN';
  return u;
}

export function vatRateFromOrganizationCode(vatCode) {
  const c = String(vatCode || '').trim().toUpperCase();
  if (!c || c === 'NO_VAT') return 0;
  const map = {
    VAT_22: 0.22,
    VAT_20: 0.2,
    VAT_10: 0.1,
    VAT_7: 0.07,
    VAT_5: 0.05,
  };
  return map[c] ?? 0;
}

export function incomeTaxFromOrganization(taxSystem) {
  const ts = normalizeTaxSystemCode(taxSystem);
  if (!ts) return { rate: 0, onRevenue: false, code: '' };
  if (ts === 'USN_INCOME') return { rate: 0.06, onRevenue: true, code: 'USN_INCOME' };
  if (ts === 'USN_INCOME_OUTCOME') return { rate: 0.15, onRevenue: false, code: 'USN_INCOME_OUTCOME' };
  if (ts === 'OSN') return { rate: 0.2, onRevenue: false, code: 'OSN' };
  return { rate: 0, onRevenue: false, code: ts };
}

export function resolveOrganizationTaxProfile(org) {
  const income = incomeTaxFromOrganization(org?.tax_system ?? org?.taxSystem);
  return {
    vatRate: vatRateFromOrganizationCode(org?.vat),
    incomeTaxRate: income.rate,
    incomeTaxOnRevenue: income.onRevenue,
    taxSystemCode: income.code,
  };
}

/** НДС = минимальная цена × ставка из настроек организации. */
export function vatAmountFromPrice(price, vatRate) {
  const rate = Number(vatRate) || 0;
  if (rate <= 0) return 0;
  return (Number(price) || 0) * rate;
}

export function vatAmountFromGrossPrice(price, vatRate) {
  return vatAmountFromPrice(price, vatRate);
}

export function computeTaxesAndNetProfit({ price, totalExpenses, taxProfile }) {
  const profile = taxProfile || resolveOrganizationTaxProfile(null);
  const priceNum = Number(price) || 0;
  const expenses = Number(totalExpenses) || 0;
  const vat = vatAmountFromPrice(priceNum, profile.vatRate);
  const profitBeforeIncomeTax = priceNum - expenses - vat;
  let incomeTax = 0;
  if (profile.incomeTaxRate > 0) {
    if (profile.incomeTaxOnRevenue) {
      incomeTax = Math.max(0, priceNum * profile.incomeTaxRate);
    } else {
      incomeTax = Math.max(0, profitBeforeIncomeTax * profile.incomeTaxRate);
    }
  }
  const netProfit = profitBeforeIncomeTax - incomeTax;
  return { vat, incomeTax, netProfit, profitBeforeIncomeTax };
}

export function taxProfileForProduct(organizations, product) {
  const orgId = product?.organizationId ?? product?.organization_id;
  if (orgId == null || orgId === '' || !Array.isArray(organizations)) {
    return resolveOrganizationTaxProfile(null);
  }
  const org = organizations.find((o) => String(o.id) === String(orgId));
  return resolveOrganizationTaxProfile(org);
}

export function formatVatLabel(vatCode) {
  const c = String(vatCode || '').trim().toUpperCase();
  const map = {
    NO_VAT: 'Без НДС',
    VAT_22: 'НДС 22%',
    VAT_20: 'НДС 20%',
    VAT_10: 'НДС 10%',
    VAT_7: 'НДС 7%',
    VAT_5: 'НДС 5%',
  };
  return map[c] || (c ? c : '—');
}

export function formatTaxSystemLabel(taxSystem) {
  const code = normalizeTaxSystemCode(taxSystem);
  const opt = TAX_SYSTEM_OPTIONS.find((o) => o.value === code);
  return opt?.label || (code || '—');
}

export function formatIncomeTaxLabel(taxSystem) {
  const income = incomeTaxFromOrganization(taxSystem);
  if (!income.code || income.rate <= 0) return 'не указан';
  if (income.onRevenue) return `УСН ${(income.rate * 100).toFixed(0)}% с выручки`;
  return `УСН ${(income.rate * 100).toFixed(0)}% с прибыли`;
}
