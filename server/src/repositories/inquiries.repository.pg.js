/**
 * Обращения в поддержку (PostgreSQL)
 */

import { query } from '../config/database.js';

class InquiriesRepositoryPG {
  /**
   * @param {{ profileId?: number|string, authorUserId?: number|string }} filters
   */
  async findAll(filters = {}) {
    const { profileId, authorUserId } = filters;
    let sql = `
      SELECT
        si.id,
        si.profile_id,
        si.author_user_id,
        si.body_text,
        si.status,
        si.created_at,
        si.updated_at,
        p.name AS profile_name,
        u.email AS author_email,
        u.full_name AS author_full_name
      FROM support_inquiries si
      LEFT JOIN profiles p ON p.id = si.profile_id
      LEFT JOIN users u ON u.id = si.author_user_id
    `;
    const params = [];
    const where = [];
    if (profileId != null && profileId !== '') {
      params.push(Number(profileId));
      where.push(`si.profile_id = $${params.length}`);
    }
    if (authorUserId != null && authorUserId !== '') {
      params.push(Number(authorUserId));
      where.push(`si.author_user_id = $${params.length}`);
    }
    if (where.length > 0) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
    sql += ' ORDER BY si.created_at DESC';
    const result = await query(sql, params);
    return result.rows;
  }

  async findById(id) {
    const result = await query(
      `SELECT
        si.id,
        si.profile_id,
        si.author_user_id,
        si.body_text,
        si.status,
        si.created_at,
        si.updated_at,
        p.name AS profile_name,
        u.email AS author_email,
        u.full_name AS author_full_name
      FROM support_inquiries si
      LEFT JOIN profiles p ON p.id = si.profile_id
      LEFT JOIN users u ON u.id = si.author_user_id
      WHERE si.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  async create({ profileId, authorUserId, bodyText, status = 'new' }) {
    const result = await query(
      `INSERT INTO support_inquiries (profile_id, author_user_id, body_text, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, profile_id, author_user_id, body_text, status, created_at, updated_at`,
      [profileId, authorUserId, bodyText || '', status]
    );
    return result.rows[0];
  }

  async updateStatus(id, status) {
    const result = await query(
      `UPDATE support_inquiries
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, profile_id, author_user_id, body_text, status, created_at, updated_at`,
      [status, id]
    );
    return result.rows[0] || null;
  }

  async listAttachments(inquiryId) {
    const result = await query(
      `SELECT id, inquiry_id, stored_name, original_name, mime_type, created_at
       FROM support_inquiry_attachments
       WHERE inquiry_id = $1
       ORDER BY id ASC`,
      [inquiryId]
    );
    return result.rows;
  }

  async findAttachmentById(attachmentId) {
    const result = await query(
      `SELECT id, inquiry_id, stored_name, original_name, mime_type
       FROM support_inquiry_attachments
       WHERE id = $1`,
      [attachmentId]
    );
    return result.rows[0] || null;
  }

  async addAttachment({ inquiryId, storedName, originalName, mimeType }) {
    const result = await query(
      `INSERT INTO support_inquiry_attachments (inquiry_id, stored_name, original_name, mime_type)
       VALUES ($1, $2, $3, $4)
       RETURNING id, inquiry_id, stored_name, original_name, mime_type, created_at`,
      [inquiryId, storedName, originalName || null, mimeType || null]
    );
    return result.rows[0];
  }
}

export default new InquiriesRepositoryPG();
