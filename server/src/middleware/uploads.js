import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeExt(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  // allow common image extensions only
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext;
  return '';
}

export function createProductImageUpload() {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const productId = String(req.params.id || '').trim();
      const uploadsRoot = path.resolve(__dirname, '../../uploads/products');
      const dir = path.join(uploadsRoot, productId);
      ensureDirSync(dir);
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = safeExt(file?.originalname || '');
      const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      cb(null, `${id}${ext}`);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 10 },
    fileFilter: (_req, file, cb) => {
      const mime = String(file?.mimetype || '').toLowerCase();
      const ext = safeExt(file?.originalname || '');
      const ok = mime.startsWith('image/') && !!ext;
      cb(ok ? null : new Error('Разрешены только изображения (jpg/png/webp/gif).'), ok);
    }
  });

  return upload;
}

/** Загрузка .xlsx для импорта товаров (в память) */
export function createProductExcelImportUpload() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const n = String(file?.originalname || '').toLowerCase();
      const mime = String(file?.mimetype || '').toLowerCase();
      const ok =
        n.endsWith('.xlsx') ||
        mime.includes('spreadsheetml') ||
        mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      cb(ok ? null : new Error('Нужен файл Excel .xlsx'), ok);
    }
  });
}

export function createCertificatePhotoUpload() {
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const certificateId = String(req.params.id || '').trim();
      const uploadsRoot = path.resolve(__dirname, '../../uploads/certificates');
      const dir = path.join(uploadsRoot, certificateId);
      ensureDirSync(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = safeExt(file?.originalname || '');
      const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      cb(null, `${id}${ext}`);
    }
  });

  return multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const mime = String(file?.mimetype || '').toLowerCase();
      const ext = safeExt(file?.originalname || '');
      const ok = mime.startsWith('image/') && !!ext;
      cb(ok ? null : new Error('Разрешены только изображения (jpg/png/webp/gif).'), ok);
    }
  });
}

function inquiryMediaExt(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mov'].includes(ext)) return ext;
  return '';
}

/** Временная папка для файлов обращения; после INSERT строки файлы переносятся в uploads/inquiries/{id}/ */
export function createInquiryFilesUpload() {
  const uploadsRoot = path.resolve(__dirname, '../../uploads/inquiries');
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      if (!req.inquiryPendingDir) {
        req.inquiryPendingDir = crypto.randomUUID();
      }
      const dir = path.join(uploadsRoot, '_pending', req.inquiryPendingDir);
      ensureDirSync(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = inquiryMediaExt(file?.originalname || '');
      const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      cb(null, `${id}${ext}`);
    }
  });

  return multer({
    storage,
    limits: { fileSize: 80 * 1024 * 1024, files: 20 },
    fileFilter: (_req, file, cb) => {
      const mime = String(file?.mimetype || '').toLowerCase();
      const ext = inquiryMediaExt(file?.originalname || '');
      const ok =
        !!ext &&
        (mime.startsWith('image/') ||
          mime === 'video/mp4' ||
          mime === 'video/webm' ||
          mime === 'video/quicktime');
      cb(ok ? null : new Error('Разрешены фото и видео: jpg, png, webp, gif, mp4, webm, mov.'), ok);
    }
  });
}

