/**
 * Целевая чистая прибыль (₽) для расчёта мин. цены МП (синхронно с server).
 */

import {
  computeTaxesAndNetProfit,
  resolveOrganizationTaxProfile,
} from './organizationTaxRates.js';

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function resolveMarketplaceMinProfit(product, marketplace, fallback = 50) {
  if (!product) return fallback;
  const mp = String(marketplace || '').toLowerCase();
  let specific = null;
  if (mp === 'ozon') {
    specific = numOrNull(product.min_profit_ozon ?? product.minProfitOzon);
  } else if (mp === 'wb' || mp === 'wildberries') {
    specific = numOrNull(product.min_profit_wb ?? product.minProfitWb);
  } else if (mp === 'ym' || mp === 'yandex') {
    specific = numOrNull(product.min_profit_ym ?? product.minProfitYm);
  }
  if (specific != null && specific >= 0) return specific;
  const general = numOrNull(product.min_price ?? product.minPrice);
  if (general != null && general >= 0) return general;
  return fallback;
}

/**
 * Мин. цена для частного клиента с учётом налогов организации.
 * Цель: чистая прибыль после НДС и налога ≥ мин. наценки (частные).
 */
export function privateClientPriceParts(product, taxProfile = null) {
  if (!product) return null;
  const cost = numOrNull(product.cost ?? product.price ?? product.base_price) ?? 0;
  const add = numOrNull(product.additional_expenses ?? product.additionalExpenses) ?? 0;
  const targetProfit = numOrNull(product.min_price ?? product.minPrice);
  if (targetProfit == null || targetProfit < 0) return null;

  const expenses = cost + add;
  const profile = taxProfile || resolveOrganizationTaxProfile(null);

  const netAt = (price) =>
    computeTaxesAndNetProfit({
      price,
      totalExpenses: expenses,
      taxProfile: profile,
    }).netProfit;

  const vatR = Number(profile.vatRate) || 0;
  const incR = Number(profile.incomeTaxRate) || 0;
  let denom;
  let numerator;
  if (profile.incomeTaxOnRevenue) {
    // net = price*(1 - vat - inc) - expenses
    denom = 1 - vatR - incR;
    numerator = expenses + Number(targetProfit);
  } else {
    // net = (price*(1-vat) - expenses)*(1-inc) = price*denom - expenses*(1-inc)
    denom = (1 - vatR) * (1 - incR);
    numerator = Number(targetProfit) + expenses * (1 - incR);
  }
  if (!(denom > 0.01)) denom = 0.01;

  let price = Math.max(1, Math.ceil(numerator / denom));
  // Если оценка чуть завышена — опускаем до минимальной цены с нужной чистой прибылью
  while (price > 1 && netAt(price - 1) >= Number(targetProfit)) {
    price -= 1;
  }
  let guard = 0;
  while (netAt(price) < Number(targetProfit) && guard < 20000) {
    price += 1;
    guard += 1;
    if (price > (expenses + Number(targetProfit)) * 20 + 1000) break;
  }

  const taxes = computeTaxesAndNetProfit({
    price,
    totalExpenses: expenses,
    taxProfile: profile,
  });

  return {
    cost,
    additionalExpenses: add,
    expenses,
    minMarkup: targetProfit,
    total: Math.round(price),
    vat: taxes.vat,
    incomeTax: taxes.incomeTax,
    netProfit: taxes.netProfit,
    profitBeforeIncomeTax: taxes.profitBeforeIncomeTax,
    taxProfile: profile,
  };
}

/** Мин. цена для частного клиента: с налогами организации (если профиль передан). */
export function privateClientMinPrice(product, taxProfile = null) {
  return privateClientPriceParts(product, taxProfile)?.total ?? null;
}
