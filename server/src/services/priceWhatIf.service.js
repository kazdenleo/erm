/**
 * What-if цены: прибыль при заданной/текущей продажной цене vs пол (мин. цена).
 */
import { query } from '../config/database.js';
import { attachPromoEconomics } from './marketplacePromotions.service.js';

const MPS = ['ozon', 'wb', 'ym'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fakeRow(marketplace, productId, salePrice) {
  const base = { our_product_id: productId };
  if (marketplace === 'ozon') return { ...base, action_price: salePrice };
  if (marketplace === 'wb') return { ...base, plan_price: salePrice };
  return { ...base, promo_price: salePrice };
}

class PriceWhatIfService {
  /**
   * @param {{ productId: number, marketplace?: string, salePrice?: number|null, profileId?: number|null }} opts
   */
  async preview({ productId, marketplace = 'all', salePrice = null, profileId = null } = {}) {
    const id = Number(productId);
    if (!Number.isFinite(id) || id < 1) {
      const err = new Error('Некорректный ID товара');
      err.statusCode = 400;
      throw err;
    }

    const prodRes = await query(
      `SELECT id, profile_id, sku, name FROM products WHERE id = $1 LIMIT 1`,
      [id]
    );
    const product = prodRes.rows?.[0];
    if (!product) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }
    if (profileId != null && Number(product.profile_id) !== Number(profileId)) {
      const err = new Error('Товар другого профиля');
      err.statusCode = 403;
      throw err;
    }

    const pricesRes = await query(
      `SELECT marketplace, selling_price, min_price, min_price_fbs, min_price_fbo
         FROM product_marketplace_prices
        WHERE product_id = $1`,
      [id]
    );
    const priceByMp = new Map(
      (pricesRes.rows || []).map((r) => [String(r.marketplace).toLowerCase(), r])
    );

    const mpFilter = String(marketplace || 'all').toLowerCase();
    const list = mpFilter === 'all' || mpFilter === '' ? MPS : [mpFilter];
    const override = salePrice != null && salePrice !== '' ? num(salePrice) : null;

    const items = [];
    for (const mp of list) {
      if (!MPS.includes(mp)) continue;
      const row = priceByMp.get(mp);
      const currentSelling = num(row?.selling_price);
      const price = override != null ? override : currentSelling;
      if (price == null || price <= 0) {
        items.push({
          marketplace: mp,
          skipped: true,
          reason: 'no_selling_price',
          floor: null,
          salePrice: null,
          profitRub: null,
          belowFloor: false,
          profitNegative: false,
          allowPush: false,
        });
        continue;
      }
      const [enriched] = await attachPromoEconomics([fakeProps(mp, id, price)], mp, {
        profileId: product.profile_id,
      });
      const floor = num(enriched?.floor);
      const profitRub = num(enriched?.profit_rub);
      const belowFloor = Boolean(enriched?.below_floor) || (floor != null && price < floor);
      const profitNegative = profitRub != null && profitRub < 0;
      const markupRub = num(enriched?.markup_rub);
      const profitBelowMarkup =
        profitRub != null && markupRub != null && markupRub > 0 && profitRub < markupRub;
      items.push({
        marketplace: mp,
        skipped: false,
        floor,
        sellingCurrent: currentSelling,
        salePrice: price,
        profitRub,
        markupRub,
        belowFloor,
        profitNegative,
        profitBelowMarkup,
        allowPush: !belowFloor,
        warnings: [
          belowFloor ? 'Цена ниже минимальной (пола)' : null,
          profitNegative ? 'Прогноз прибыли отрицательный' : null,
          profitBelowMarkup ? 'Прибыль ниже минимальной наценки' : null,
        ].filter(Boolean),
      });
    }

    const blockers = items.filter((i) => !i.skipped && i.belowFloor);
    const warnings = items.filter((i) => !i.skipped && (i.profitNegative || i.profitBelowMarkup));
    return {
      productId: id,
      sku: product.sku,
      name: product.name,
      salePriceOverride: override,
      items,
      hasBlockers: blockers.length > 0,
      hasWarnings: warnings.length > 0,
      summary: {
        marketplacesChecked: items.filter((i) => !i.skipped).length,
        negativeProfitCount: warnings.filter((i) => i.profitNegative).length,
        belowFloorCount: blockers.length,
      },
    };
  }
}

export default new PriceWhatIfService();
