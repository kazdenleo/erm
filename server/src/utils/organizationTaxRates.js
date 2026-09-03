/**
 * Ставки НДС и налога по карточке организации (минимальные цены МП).
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

/** Нормализация кода из БД (в т.ч. старые текстовые значения). */
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

/** УСН 6% — с выручки (мин. цена); УСН 15% — с прибыли до налога. */
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

/** НДС = минимальная цена × ставка НДС из настроек организации. */
export function vatAmountFromPrice(price, vatRate) {
  const rate = Number(vatRate) || 0;
  if (rate <= 0) return 0;
  return (Number(price) || 0) * rate;
}

/** @deprecated используйте vatAmountFromPrice */
export function vatAmountFromGrossPrice(price, vatRate) {
  return vatAmountFromPrice(price, vatRate);
}

/** Минимальный налог УСН (доходы − расходы): 1% от выручки. */
export const USN_MIN_TAX_RATE_ON_REVENUE = 0.01;

export function computeTaxesAndNetProfit({ price, totalExpenses, taxProfile }) {
  const profile = taxProfile || resolveOrganizationTaxProfile(null);
  const priceNum = Number(price) || 0;
  const expenses = Number(totalExpenses) || 0;
  const vat = vatAmountFromPrice(priceNum, profile.vatRate);
  const profitBeforeIncomeTax = priceNum - expenses - vat;
  let incomeTax = 0;
  let incomeTaxIsMinimum = false;
  if (profile.incomeTaxRate > 0) {
    if (profile.incomeTaxOnRevenue) {
      incomeTax = Math.max(0, priceNum * profile.incomeTaxRate);
    } else {
      const fromProfit = Math.max(0, profitBeforeIncomeTax * profile.incomeTaxRate);
      // УСН «доходы − расходы»: не ниже 1% от выручки
      if (profile.taxSystemCode === 'USN_INCOME_OUTCOME' && priceNum > 0) {
        const minTax = priceNum * USN_MIN_TAX_RATE_ON_REVENUE;
        incomeTax = Math.max(fromProfit, minTax);
        incomeTaxIsMinimum = incomeTax > fromProfit + 1e-9;
      } else {
        incomeTax = fromProfit;
      }
    }
  }
  const netProfit = profitBeforeIncomeTax - incomeTax;
  return { vat, incomeTax, netProfit, profitBeforeIncomeTax, incomeTaxIsMinimum };
}

export function formatTaxSystemLabel(taxSystem) {
  const code = normalizeTaxSystemCode(taxSystem);
  const opt = TAX_SYSTEM_OPTIONS.find((o) => o.value === code);
  return opt?.label || (code || '—');
}
