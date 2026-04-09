/**
 * Обращения в поддержку
 */

import express from 'express';
import { optionalAuth, requireAuth, requireAdmin, requireProfile } from '../middleware/auth.js';
import { createInquiryFilesUpload } from '../middleware/uploads.js';
import { inquiriesController } from '../controllers/inquiries.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();
const upload = createInquiryFilesUpload();

router.use(optionalAuth);
router.use(requireAuth);

router.get('/', wrapAsync(inquiriesController.list));
router.get(
  '/:id/attachments/:attachmentId/file',
  wrapAsync(inquiriesController.downloadAttachment)
);
router.get('/:id', wrapAsync(inquiriesController.getById));
router.patch('/:id', requireAdmin, wrapAsync(inquiriesController.updateStatus));
router.post(
  '/',
  requireProfile,
  (req, res, next) => {
    upload.array('files', 20)(req, res, (err) => {
      if (err) {
        return res.status(400).json({ ok: false, message: err.message || 'Ошибка загрузки файлов' });
      }
      next();
    });
  },
  wrapAsync(inquiriesController.create)
);

export default router;
