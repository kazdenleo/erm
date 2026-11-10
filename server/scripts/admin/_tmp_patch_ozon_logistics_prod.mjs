/**
 * Накатывает патч learned FBS logistics на prices.service.js на проде
 * (без локального ads.service import).
 */
import fs from 'fs';

const path = process.argv[2] || '/opt/erm/server/src/services/prices.service.js';
let src = fs.readFileSync(path, 'utf8');

const importNeedle = `} from '../utils/ozonCommissionTiersLearning.js';
`;
const importPatch = `} from '../utils/ozonCommissionTiersLearning.js';
import {
  enrichOzonCalculatorWithLearnedLogistics,
  loadOzonFbsLogisticsLearned,
} from '../utils/ozonLogisticsLearning.js';
`;

if (!src.includes("from '../utils/ozonLogisticsLearning.js'")) {
  if (!src.includes(importNeedle)) throw new Error('import anchor missing');
  src = src.replace(importNeedle, importPatch);
}

const enrichNeedle = `      } catch (e) {
        logger.warn('[Prices Service] attach learned Ozon tier rates failed', {
          error: e?.message || e,
        });
      }
    }
    calc = await this._enrichOzonCalculatorBrandPromotion(calc, { productId, brandId });
`;

const enrichPatch = `      } catch (e) {
        logger.warn('[Prices Service] attach learned Ozon tier rates failed', {
          error: e?.message || e,
        });
      }
      try {
        const learnedLog = await loadOzonFbsLogisticsLearned();
        calc = enrichOzonCalculatorWithLearnedLogistics(calc, learnedLog, { productId });
      } catch (e) {
        logger.warn('[Prices Service] attach learned Ozon FBS logistics failed', {
          error: e?.message || e,
        });
      }
    }
    calc = await this._enrichOzonCalculatorBrandPromotion(calc, { productId, brandId });
`;

if (!src.includes('attach learned Ozon FBS logistics failed')) {
  if (!src.includes(enrichNeedle)) throw new Error('enrich anchor missing');
  src = src.replace(enrichNeedle, enrichPatch);
}

const sanitizeNeedle = `    if (calc.logistics_cost_fbo_max != null && Number.isFinite(Number(calc.logistics_cost_fbo_max))) {
      out.logistics_cost_fbo_max = Number(calc.logistics_cost_fbo_max);
    }
    if (calc.brand_promotion_percent != null && !isNaN(Number(calc.brand_promotion_percent))) {
      out.brand_promotion_percent = Number(calc.brand_promotion_percent);
    }
`;

const sanitizePatch = `    if (calc.logistics_cost_fbo_max != null && Number.isFinite(Number(calc.logistics_cost_fbo_max))) {
      out.logistics_cost_fbo_max = Number(calc.logistics_cost_fbo_max);
    }
    if (calc.logistics_cost_api != null && Number.isFinite(Number(calc.logistics_cost_api))) {
      out.logistics_cost_api = Number(calc.logistics_cost_api);
    }
    if (calc.logistics_learned && typeof calc.logistics_learned === 'object') {
      out.logistics_learned = cloneObj(calc.logistics_learned);
    }
    if (calc.brand_promotion_percent != null && !isNaN(Number(calc.brand_promotion_percent))) {
      out.brand_promotion_percent = Number(calc.brand_promotion_percent);
    }
`;

if (!src.includes('logistics_cost_api')) {
  if (!src.includes(sanitizeNeedle)) throw new Error('sanitize anchor missing');
  src = src.replace(sanitizeNeedle, sanitizePatch);
}

fs.writeFileSync(path, src);
console.log('patched', path);
console.log({
  hasImport: src.includes('ozonLogisticsLearning.js'),
  hasEnrich: src.includes('attach learned Ozon FBS logistics failed'),
  hasSanitize: src.includes('logistics_cost_api'),
  hasAdsImport: src.includes("from './ads/ads.service.js'"),
});
