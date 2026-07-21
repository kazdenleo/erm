/**
 * Разбор сумм строк reportDetailByPeriod Wildberries.
 */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** @param {object} row — строка WB API / raw_json */
export function extractWbFinanceAmounts(row) {
  const oper = String(row?.supplier_oper_name || row?.doc_type_name || '').toLowerCase();
  const qty = toNum(row?.quantity);
  const retail = toNum(row?.retail_amount);
  const commission =
    retail > 0 && row?.commission_percent != null
      ? (retail * toNum(row.commission_percent)) / 100
      : toNum(row?.ppvz_sales_commission);
  let logistics = toNum(row?.delivery_rub ?? row?.delivery_amount);
  const storage = toNum(row?.storage_fee);
  const penalty = toNum(row?.penalty);
  const acquiring = toNum(row?.acquiring_fee);
  let other = toNum(row?.deduction) + toNum(row?.additional_payment);

  const acceptance = Math.abs(toNum(row?.acceptance));
  const rebill = Math.abs(toNum(row?.rebill_logistic_cost));
  const ppvzReward = Math.abs(toNum(row?.ppvz_reward));

  if (oper.includes('логист')) {
    logistics = Math.abs(logistics) || rebill || ppvzReward;
  } else if (oper.includes('обработка')) {
    logistics = acceptance || logistics;
  } else if (oper.includes('возмещение') && oper.includes('перевозк')) {
    logistics = rebill || logistics;
  } else if (oper.includes('пвз')) {
    logistics = ppvzReward || logistics;
  } else if (oper.includes('продаж') || oper.includes('возврат')) {
    // commission/logistics on sale/return rows from standard fields
  } else if (oper.includes('штраф')) {
    // penalty handled below
  } else {
    if (rebill > 0) logistics += rebill;
    if (acceptance > 0) logistics += acceptance;
    if (ppvzReward > 0) logistics += ppvzReward;
  }

  const payout = toNum(row?.ppvz_for_pay ?? row?.for_pay);

  return {
    quantity: qty,
    retail_amount: oper.includes('продаж') ? retail : oper.includes('возврат') ? retail : 0,
    commission_amount: Math.abs(commission),
    logistics_amount: Math.abs(logistics),
    storage_amount: Math.abs(storage),
    penalty_amount: Math.abs(oper.includes('штраф') ? penalty || retail : penalty),
    acquiring_amount: Math.abs(acquiring),
    other_deductions: Math.abs(other),
    payout_amount: payout,
  };
}
