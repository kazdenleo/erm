/**
 * Построение объекта calculator из одной записи ответа Ozon v5/product/info/prices.
 * Вынесено для батч-загрузки (до 100 offer за запрос) и единичного getOzonPrices.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import { extractOzonBrandPromotionPercent } from '../utils/ozonBrandPromotion.js';
import { resolveMarketplaceVolumeLiters } from '../utils/productVolume.js';

/** Минимальный тариф Ozon; при отсутствии — fallback на max (старые ответы API). */
function pickOzonMinTariff(minVal, maxVal) {
  if (minVal !== null && minVal !== undefined && minVal !== '') return parseFloat(minVal);
  if (maxVal !== null && maxVal !== undefined && maxVal !== '') return parseFloat(maxVal);
  return null;
}

/**
 * Ozon v5 отдаёт `acquiring` в рублях от marketing_seller_price (≈1%), а не от price.price.
 * Деление на price.price занижает % при скидке (например 19₽ / 2250 → 0.8% вместо 19₽ / 1900 → 1%).
 */
function resolveOzonAcquiringPercent(acquiringValue, priceObj) {
  const amount = parseFloat(acquiringValue);
  if (!Number.isFinite(amount)) return null;
  const marketing = parseFloat(priceObj?.marketing_seller_price);
  const price = parseFloat(priceObj?.price);
  const base =
    Number.isFinite(marketing) && marketing > 0
      ? marketing
      : Number.isFinite(price) && price > 0
        ? price
        : null;
  if (!base) return null;
  return Math.round(((amount / base) * 100) * 10) / 10;
}

/**
 * @param {object} item — элемент из data.items ответа v5
 * @param {string} offer_id — идентификатор оффера (для логов и fallback volume в БД)
 * @param {string} client_id
 * @param {string} api_key
 * @param {{ preloadVolume?: number|null }} [options]
 * @returns {Promise<{ found: boolean, calculator?: object, fullCommissions?: object, rawCommissions?: object, error?: string, missingData?: string[] }>}
 */
export async function applyOzonV5ItemToCalculator(item, offer_id, client_id, api_key, options = {}) {
  const rawCommissionsData = item.commissions || {};

  let acquiringPercent = null;
  let acquiringValue = null;

  if (item.acquiring !== undefined && item.acquiring !== null) {
    acquiringValue = parseFloat(item.acquiring);
    acquiringPercent = resolveOzonAcquiringPercent(acquiringValue, item.price);
  } else if (item.price?.acquiring !== undefined && item.price?.acquiring !== null) {
    acquiringValue = parseFloat(item.price.acquiring);
    acquiringPercent = resolveOzonAcquiringPercent(acquiringValue, item.price);
  } else if (rawCommissionsData.acquiring !== undefined && rawCommissionsData.acquiring !== null) {
    acquiringValue = parseFloat(rawCommissionsData.acquiring);
    acquiringPercent = resolveOzonAcquiringPercent(acquiringValue, item.price);
  } else if (rawCommissionsData.acquiring_percent !== undefined && rawCommissionsData.acquiring_percent !== null) {
    acquiringPercent = parseFloat(rawCommissionsData.acquiring_percent);
  } else if (rawCommissionsData.acquiringPercent !== undefined && rawCommissionsData.acquiringPercent != null) {
    acquiringPercent = parseFloat(rawCommissionsData.acquiringPercent);
  }

  if (acquiringPercent === null) {
    acquiringPercent = 0;
    logger.warn('[Ozon v5 calc] Acquiring not found in API response, using 0%');
  }

  let calculatorData = {
    offer_id: item.offer_id,
    product_id: item.product_id,
    price: parseFloat(item.price?.price || 0),
    old_price: parseFloat(item.price?.old_price || 0),
    marketing_price: parseFloat(item.price?.marketing_price || 0),
    min_price: parseFloat(item.price?.min_price || 0),
    currency_code: item.price?.currency_code || 'RUB',
    commissions: {},
    fullCommissions: rawCommissionsData,
    rawCommissions: rawCommissionsData,
    acquiring: acquiringPercent,
    vat: item.price?.vat || 0,
    volume_weight: null
  };

  if (item.commissions) {
    const commissions = item.commissions;
    const fbsPercent =
      commissions.sales_percent_fbs !== undefined
        ? commissions.sales_percent_fbs
        : commissions.fbs_sales_percent !== undefined
          ? commissions.fbs_sales_percent
          : commissions.fbs_percent !== undefined
            ? commissions.fbs_percent
            : null;

    if (
      fbsPercent !== null ||
      commissions.fbs_deliv_to_customer_amount !== undefined ||
      commissions.fbs_first_mile_min_amount !== undefined ||
      commissions.fbs_first_mile_max_amount !== undefined ||
      commissions.fbs_direct_flow_trans_min_amount !== undefined ||
      commissions.fbs_direct_flow_trans_max_amount !== undefined
    ) {
      const directFlowTransAmount = pickOzonMinTariff(
        commissions.fbs_direct_flow_trans_min_amount,
        commissions.fbs_direct_flow_trans_max_amount
      );
      const firstMileAmount = pickOzonMinTariff(
        commissions.fbs_first_mile_min_amount,
        commissions.fbs_first_mile_max_amount
      );

      calculatorData.commissions.FBS = {
        percent: fbsPercent !== null ? parseFloat(fbsPercent) : 0,
        value: 0,
        delivery_amount: parseFloat(commissions.fbs_deliv_to_customer_amount || 0),
        return_amount: parseFloat(commissions.fbs_return_flow_amount || 0),
        first_mile_amount: firstMileAmount !== null ? firstMileAmount : 0,
        direct_flow_trans_amount: directFlowTransAmount !== null ? directFlowTransAmount : 0
      };
    }

    const fboPercent =
      commissions.sales_percent_fbo || commissions.fbo_sales_percent || commissions.fbo_percent || 0;

    if (fboPercent > 0 || commissions.fbo_deliv_to_customer_amount) {
      const fboDirectFlow = pickOzonMinTariff(
        commissions.fbo_direct_flow_trans_min_amount,
        commissions.fbo_direct_flow_trans_max_amount
      );
      calculatorData.commissions.FBO = {
        percent: parseFloat(fboPercent || 0),
        value: 0,
        delivery_amount: parseFloat(commissions.fbo_deliv_to_customer_amount || 0),
        return_amount: parseFloat(commissions.fbo_return_flow_amount || 0),
        direct_flow_trans_amount: fboDirectFlow !== null ? fboDirectFlow : 0,
      };
      if (fboDirectFlow != null && fboDirectFlow > 0) {
        calculatorData.logistics_cost_fbo = fboDirectFlow;
      }
    }

    if (!calculatorData.commissions.FBS && !calculatorData.commissions.FBO && Object.keys(commissions).length > 0) {
      for (const key of Object.keys(commissions)) {
        if (key.includes('percent') && typeof commissions[key] === 'number' && commissions[key] > 0) {
          calculatorData.commissions.FBS = {
            percent: parseFloat(commissions[key] || 0),
            value: 0,
            delivery_amount: parseFloat(commissions.fbs_deliv_to_customer_amount || commissions.deliv_to_customer_amount || 0),
            return_amount: 0,
            first_mile_amount:
              pickOzonMinTariff(
                commissions.fbs_first_mile_min_amount,
                commissions.fbs_first_mile_max_amount
              ) || 0,
            direct_flow_trans_amount:
              pickOzonMinTariff(
                commissions.fbs_direct_flow_trans_min_amount,
                commissions.fbs_direct_flow_trans_max_amount
              ) || 0
          };
          break;
        }
      }
    }
  }

  if (!calculatorData.commissions.FBS && !calculatorData.commissions.FBO && item.product_id) {
    try {
      const v3Response = await fetch('https://api-seller.ozon.ru/v3/product/info/list', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Client-Id': String(client_id),
          'Api-Key': String(api_key)
        },
        body: JSON.stringify({
          product_id: [item.product_id],
          sku: [],
          offer_id: []
        })
      });

      if (v3Response.ok) {
        const v3Data = await v3Response.json();
        if (v3Data.result?.items?.length > 0) {
          const v3Item = v3Data.result.items[0];
          if (v3Item.commissions && Array.isArray(v3Item.commissions)) {
            v3Item.commissions.forEach((comm) => {
              const schema = comm.sale_schema || 'FBS';
              const commissionPercent = comm.percent !== undefined && comm.percent !== null ? parseFloat(comm.percent) : 0;
              calculatorData.commissions[schema] = {
                percent: commissionPercent,
                value: parseFloat(comm.value || 0),
                delivery_amount: parseFloat(comm.delivery_amount || 0),
                return_amount: parseFloat(comm.return_amount || 0),
                first_mile_amount: parseFloat(comm.first_mile_amount || 0),
                direct_flow_trans_amount: parseFloat(comm.direct_flow_trans_amount || 0)
              };
            });
          }
        }
      }
    } catch (v3Error) {
      logger.warn('[Ozon v5 calc] v3 fallback failed:', v3Error.message);
    }
  }

  const missingData = [];
  const hasFBSCommission = calculatorData.commissions.FBS && calculatorData.commissions.FBS.percent !== undefined;
  const hasFBOCommission = calculatorData.commissions.FBO && calculatorData.commissions.FBO.percent !== undefined;

  if (!hasFBSCommission && !hasFBOCommission) {
    missingData.push('комиссия маркетплейса (sales_percent_fbs/fbo)');
  }

  let productVolume = options.preloadVolume != null ? options.preloadVolume : null;

  if (productVolume == null && offer_id) {
    try {
      let productResult = await query(
        `SELECT p.volume, p.length, p.width, p.height, p.ozon_attributes, p.ozon_draft, p.ym_draft, p.mp_field_links
         FROM products p
         JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'ozon'
         WHERE ps.sku = $1 LIMIT 1`,
        [offer_id]
      );
      if (!productResult.rows?.length) {
        productResult = await query(
          'SELECT volume, length, width, height, ozon_attributes, ozon_draft, ym_draft, mp_field_links FROM products WHERE sku = $1 LIMIT 1',
          [offer_id]
        );
      }
      if (productResult.rows?.length) {
        productVolume = resolveMarketplaceVolumeLiters(productResult.rows[0], 'ozon');
      }
    } catch (dbError) {
      logger.warn('[Ozon v5 calc] volume DB lookup failed:', dbError.message);
    }
  }

  let logisticsCost = calculatorData.commissions.FBS?.direct_flow_trans_amount;
  const shipmentProcessingCost = calculatorData.commissions.FBS?.first_mile_amount;

  if (!logisticsCost || logisticsCost === 0) {
    if (productVolume && productVolume > 0) {
      const baseLogisticsRate = 139;
      const additionalLiterRate = 139;
      if (productVolume <= 1) {
        logisticsCost = baseLogisticsRate;
      } else {
        logisticsCost = baseLogisticsRate + (productVolume - 1) * additionalLiterRate;
      }
    } else {
      missingData.push('итоговая стоимость логистики (fbs_direct_flow_trans_min_amount) и объем товара');
    }
  }

  if ((!logisticsCost || logisticsCost === 0) && missingData.length > 0) {
    return {
      found: false,
      error: `Недостаточно данных для расчета логистики Ozon. Отсутствуют: ${missingData.join(', ')}.`,
      missingData,
      calculator: calculatorData
    };
  }

  const processingCost =
    shipmentProcessingCost !== undefined && shipmentProcessingCost !== null ? shipmentProcessingCost : 0;

  calculatorData.volume_weight = productVolume;
  calculatorData.marketplace = 'ozon';
  calculatorData.processing_cost = processingCost;
  calculatorData.logistics_cost = logisticsCost;

  const apiBrandPromotionPercent = extractOzonBrandPromotionPercent(item);
  if (apiBrandPromotionPercent != null) {
    calculatorData.brand_promotion_percent = apiBrandPromotionPercent;
    calculatorData.brand_promotion_source = 'api';
  }

  return {
    found: true,
    calculator: calculatorData,
    fullCommissions: rawCommissionsData,
    rawCommissions: rawCommissionsData
  };
}
