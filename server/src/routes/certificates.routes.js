/**
 * Certificates Routes
 */

import express from 'express';
import certificatesController from '../controllers/certificates.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { createCertificatePhotoUpload } from '../middleware/uploads.js';

const router = express.Router();
const uploadPhoto = createCertificatePhotoUpload();

router.get('/', wrapAsync(certificatesController.getAll.bind(certificatesController)));
router.get('/:id', wrapAsync(certificatesController.getById.bind(certificatesController)));
router.post('/', wrapAsync(certificatesController.create.bind(certificatesController)));
router.put('/:id', wrapAsync(certificatesController.update.bind(certificatesController)));
router.delete('/:id', wrapAsync(certificatesController.delete.bind(certificatesController)));

router.post(
  '/:id/photo',
  uploadPhoto.single('photo'),
  wrapAsync(certificatesController.uploadPhoto.bind(certificatesController))
);

router.delete('/:id/photo', wrapAsync(certificatesController.deletePhoto.bind(certificatesController)));

export default router;
