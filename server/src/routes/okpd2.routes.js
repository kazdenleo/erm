/**
 * OKPD2 Routes — справочник кодов ОКПД2
 */

import express from 'express';
import okpd2DirectoryService from '../services/okpd2Directory.service.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

const router = express.Router();

router.get(
  '/codes',
  wrapAsync(async (req, res) => {
    const tid = tenantListProfileId(req);
    const data = await okpd2DirectoryService.search({
      q: req.query.q ?? req.query.query ?? '',
      limit: req.query.limit,
      profileId: tid === TENANT_LIST_EMPTY ? null : tid,
    });
    res.status(200).json({ ok: true, data });
  })
);

router.get(
  '/codes/:code',
  wrapAsync(async (req, res) => {
    const data = await okpd2DirectoryService.getCode(req.params.code);
    res.status(200).json({ ok: true, data: data || null });
  })
);

export default router;
