/**
 * Ставки НДС и налога по организации (дублирует server/src/utils/organizationTaxRates.js).
 */

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

export function vatAmountFromGrossPrice(grossPrice, vatRate) {
  const rate = Number(vatRate) || 0;
  if (rate <= 0) return 0;
  const p = Number(grossPrice) || 0;
  return (p * rate) / (1 + rate);
}

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

export function formatIncomeTaxLabel(taxSystem) {
  const ts = String(taxSystem || '').trim().toUpperCase();
  const map = {
    OSN: 'ОСН',
    USN_INCOME: 'УСН 6%',
    USN_INCOME_OUTCOME: 'УСН 15%',
    PSN: 'ПСН',
    ESHN: 'ЕСХН',
  };
  return map[ts] || (ts ? ts : 'УСН 15% (по умолчанию)');
}
