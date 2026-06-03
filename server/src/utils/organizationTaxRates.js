/**
 * Ставки НДС и налога на прибыль/доход по карточке организации.
 */

/** Доля НДС в цене продажи (цена на МП считается с НДС). */
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

/** УСН 6% — с дохода; УСН 15% и ОСН (упрощённо) — с прибыли. */
export function incomeTaxFromOrganization(taxSystem) {
  const ts = String(taxSystem || '').trim().toUpperCase();
  if (ts === 'USN_INCOME') return { rate: 0.06, onRevenue: true };
  if (ts === 'USN_INCOME_OUTCOME') return { rate: 0.15, onRevenue: false };
  if (ts === 'OSN') return { rate: 0.2, onRevenue: false };
  return { rate: 0.15, onRevenue: false };
}

export function resolveOrganizationTaxProfile(org) {
  const income = incomeTaxFromOrganization(org?.tax_system ?? org?.taxSystem);
  return {
    vatRate: vatRateFromOrganizationCode(org?.vat),
    incomeTaxRate: income.rate,
    incomeTaxOnRevenue: income.onRevenue,
  };
}

/** НДС к уплате из цены с НДС. */
export function vatAmountFromGrossPrice(grossPrice, vatRate) {
  const rate = Number(vatRate) || 0;
  if (rate <= 0) return 0;
  const p = Number(grossPrice) || 0;
  return (p * rate) / (1 + rate);
}

/**
 * Налоги и чистая прибыль при заданной цене продажи (с НДС).
 * @returns {{ vat: number, incomeTax: number, netProfit: number }}
 */
export function computeTaxesAndNetProfit({ price, totalExpenses, taxProfile }) {
  const profile = taxProfile || resolveOrganizationTaxProfile(null);
  const priceNum = Number(price) || 0;
  const expenses = Number(totalExpenses) || 0;
  const vat = vatAmountFromGrossPrice(priceNum, profile.vatRate);
  const profitBeforeIncomeTax = priceNum - expenses - vat;
  let incomeTax = 0;
  if (profile.incomeTaxOnRevenue) {
    incomeTax = Math.max(0, priceNum * profile.incomeTaxRate);
  } else {
    incomeTax = Math.max(0, profitBeforeIncomeTax * profile.incomeTaxRate);
  }
  const netProfit = profitBeforeIncomeTax - incomeTax;
  return { vat, incomeTax, netProfit, profitBeforeIncomeTax };
}
