/**
 * Certificates Routes
 */

import express from 'express';
import certificatesController from '../controllers/certificates.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { createCertificatePhotoUpload } from '../middleware/uploads.js';
import certificatesService from '../services/certificates.service.js';

const router = express.Router();
const uploadPhoto = createCertificatePhotoUpload();

router.get('/', wrapAsync(certificatesController.getAll.bind(certificatesController)));
router.get('/:id', wrapAsync(certificatesController.getById.bind(certificatesController)));
router.post('/', wrapAsync(certificatesController.create.bind(certificatesController)));
router.put('/:id', wrapAsync(certificatesController.update.bind(certificatesController)));
router.delete('/:id', wrapAsync(certificatesController.delete.bind(certificatesController)));

// upload photo (multipart field "photo")
router.post(
  '/:id/photo',
  uploadPhoto.single('photo'),
  wrapAsync(async (req, res) => {
    const { id } = req.params;
    const filename = req.file?.filename || '';
    if (!filename) return res.status(400).json({ ok: false, message: 'Файл не получен. Отправьте multipart с полем photo.' });
    const rel = `/uploads/certificates/${String(id)}/${filename}`;
    const updated = await certificatesService.update(id, { photo_url: rel });
    return res.status(200).json({ ok: true, data: updated });
  })
);

router.delete('/:id/photo', wrapAsync(certificatesController.deletePhoto.bind(certificatesController)));

export default router;

