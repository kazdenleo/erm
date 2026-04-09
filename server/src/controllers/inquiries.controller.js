/**
 * Обращения в поддержку
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import repositoryFactory from '../config/repository-factory.js';
import { resolveEffectiveProfileId } from '../utils/effectiveProfile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_INQUIRIES = path.resolve(__dirname, '../../uploads/inquiries');

const inquiriesRepo = repositoryFactory.getInquiriesRepository();
const usersRepo = repositoryFactory.getUsersRepository();

const STATUSES = new Set(['new', 'in_progress', 'completed']);

function canViewInquiry(req, row) {
  if (!row) return false;
  if (req.user.role === 'admin') return true;
  if (req.user.isProfileAdmin && Number(row.profile_id) === Number(req.user.profileId)) return true;
  if (Number(row.author_user_id) === Number(req.user.id)) return true;
  return false;
}

async function movePendingFilesToInquiry(inquiryId, pendingDirId, files) {
  if (!files?.length || !pendingDirId) return;
  const destDir = path.join(UPLOADS_INQUIRIES, String(inquiryId));
  await fs.mkdir(destDir, { recursive: true });
  const pendingBase = path.join(UPLOADS_INQUIRIES, '_pending', pendingDirId);
  for (const f of files) {
    const from = f.path;
    const to = path.join(destDir, f.filename);
    await fs.rename(from, to);
  }
  try {
    await fs.rm(pendingBase, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export const inquiriesController = {
  async list(req, res, next) {
    try {
      const u = req.user;
      let rows;
      if (u.role === 'admin') {
        const pid = req.query.profile_id;
        rows = await inquiriesRepo.findAll(
          pid != null && pid !== '' ? { profileId: pid } : {}
        );
      } else if (u.isProfileAdmin && u.profileId != null) {
        rows = await inquiriesRepo.findAll({ profileId: u.profileId });
      } else {
        rows = await inquiriesRepo.findAll({ authorUserId: u.id });
      }
      res.json({ ok: true, data: rows });
    } catch (e) {
      next(e);
    }
  },

  async getById(req, res, next) {
    try {
      const row = await inquiriesRepo.findById(req.params.id);
      if (!row) {
        return res.status(404).json({ ok: false, message: 'Обращение не найдено' });
      }
      if (!canViewInquiry(req, row)) {
        return res.status(403).json({ ok: false, message: 'Нет доступа' });
      }
      const attachments = await inquiriesRepo.listAttachments(row.id);
      res.json({ ok: true, data: { ...row, attachments } });
    } catch (e) {
      next(e);
    }
  },

  async create(req, res, next) {
    const pendingDirId = req.inquiryPendingDir;
    try {
      const bodyText = String(req.body?.body ?? req.body?.body_text ?? '').trim();
      if (!bodyText && !(req.files?.length > 0)) {
        return res.status(400).json({ ok: false, message: 'Укажите текст или прикрепите файл' });
      }
      const userRow = await usersRepo.findById(req.user.id);
      const profileId = await resolveEffectiveProfileId(req, userRow);
      if (profileId == null) {
        return res.status(400).json({
          ok: false,
          message:
            'Не удалось определить аккаунт для обращения. Укажите организацию в интерфейсе или попросите администратора привязать вашу учётную запись к аккаунту в «Настройки → Пользователи».',
        });
      }
      const authorUserId = req.user.id;
      const created = await inquiriesRepo.create({
        profileId,
        authorUserId,
        bodyText,
        status: 'new',
      });
      await movePendingFilesToInquiry(created.id, pendingDirId, req.files || []);
      for (const f of req.files || []) {
        await inquiriesRepo.addAttachment({
          inquiryId: created.id,
          storedName: f.filename,
          originalName: f.originalname,
          mimeType: f.mimetype,
        });
      }
      const full = await inquiriesRepo.findById(created.id);
      const attachments = await inquiriesRepo.listAttachments(created.id);
      res.status(201).json({ ok: true, data: { ...full, attachments } });
    } catch (e) {
      if (pendingDirId) {
        try {
          await fs.rm(path.join(UPLOADS_INQUIRIES, '_pending', pendingDirId), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      next(e);
    }
  },

  async updateStatus(req, res, next) {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ ok: false, message: 'Только администратор продукта может менять статус' });
      }
      const status = req.body?.status;
      if (!STATUSES.has(status)) {
        return res.status(400).json({ ok: false, message: 'Недопустимый статус' });
      }
      const updated = await inquiriesRepo.updateStatus(req.params.id, status);
      if (!updated) {
        return res.status(404).json({ ok: false, message: 'Обращение не найдено' });
      }
      res.json({ ok: true, data: updated });
    } catch (e) {
      next(e);
    }
  },

  async downloadAttachment(req, res, next) {
    try {
      const { id, attachmentId } = req.params;
      const inquiry = await inquiriesRepo.findById(id);
      if (!inquiry || !canViewInquiry(req, inquiry)) {
        return res.status(403).json({ ok: false, message: 'Нет доступа' });
      }
      const att = await inquiriesRepo.findAttachmentById(attachmentId);
      if (!att || Number(att.inquiry_id) !== Number(id)) {
        return res.status(404).json({ ok: false, message: 'Вложение не найдено' });
      }
      const filePath = path.join(UPLOADS_INQUIRIES, String(id), att.stored_name);
      try {
        await fs.access(filePath);
      } catch {
        return res.status(404).json({ ok: false, message: 'Файл не найден на диске' });
      }
      const downloadName = att.original_name || att.stored_name;
      const abs = path.resolve(filePath);
      res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
      res.sendFile(abs, (err) => {
        if (err) next(err);
      });
    } catch (e) {
      next(e);
    }
  },
};
