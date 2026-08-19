/**
 * Локальные ключи PartsAPI (только системный админ).
 */

import {
  getPartsApiKeysAdminView,
  saveLocalPartsApiKeys,
  PARTSAPI_ENRICHMENT_METHODS,
} from '../config/partsapi.config.js';

export async function getPartsApiKeys(req, res, next) {
  try {
    res.json({ success: true, data: getPartsApiKeysAdminView() });
  } catch (error) {
    next(error);
  }
}

export async function putPartsApiKeys(req, res, next) {
  try {
    const body = req.body || {};
    const keysInput = body.keys && typeof body.keys === 'object' ? body.keys : body;
    const cleaned = {};
    for (const method of PARTSAPI_ENRICHMENT_METHODS) {
      if (Object.prototype.hasOwnProperty.call(keysInput, method)) {
        cleaned[method] = keysInput[method];
      }
    }
    saveLocalPartsApiKeys(cleaned);
    res.json({
      success: true,
      data: getPartsApiKeysAdminView(),
      message: 'Ключи сохранены локально',
    });
  } catch (error) {
    next(error);
  }
}
