/**
 * Шаблоны видеообложки Ozon по категориям / общий шаблон профиля
 */

import { query } from '../config/database.js';
import { normalizeVideoCoverSettings } from '../utils/videoCoverTemplate.js';

function rowToTemplate(row) {
  if (!row) return null;
  const shared = row.user_category_id == null;
  return {
    id: row.id,
    user_category_id: row.user_category_id,
    userCategoryId: row.user_category_id,
    profile_id: row.profile_id,
    profileId: row.profile_id,
    settings: normalizeVideoCoverSettings(row.settings),
    created_at: row.created_at,
    updated_at: row.updated_at,
    category_name: row.category_name,
    categoryName: row.category_name,
    shared,
  };
}

export const categoryVideoCoverTemplatesRepository = {
  async findAllByProfile(profileId) {
    const params = [];
    let where = '';
    if (profileId != null) {
      where = 'WHERE t.profile_id = $1::bigint';
      params.push(profileId);
    }
    const result = await query(
      `SELECT t.*, uc.name AS category_name
       FROM category_video_cover_templates t
       LEFT JOIN user_categories uc ON uc.id = t.user_category_id
       ${where}
       ORDER BY (t.user_category_id IS NULL) DESC, uc.name NULLS LAST`,
      params
    );
    return (result.rows || []).map(rowToTemplate);
  },

  async findByCategoryId(userCategoryId, profileId = null) {
    const params = [userCategoryId];
    let profileFilter = '';
    if (profileId != null) {
      profileFilter = ' AND t.profile_id = $2::bigint';
      params.push(profileId);
    }
    const result = await query(
      `SELECT t.*, uc.name AS category_name
       FROM category_video_cover_templates t
       JOIN user_categories uc ON uc.id = t.user_category_id
       WHERE t.user_category_id = $1::bigint${profileFilter}
       LIMIT 1`,
      params
    );
    const row = rowToTemplate(result.rows[0] || null);
    return row ? { ...row, source: 'category' } : null;
  },

  async findSharedByProfile(profileId) {
    if (profileId == null) return null;
    const result = await query(
      `SELECT t.*, NULL::text AS category_name
       FROM category_video_cover_templates t
       WHERE t.user_category_id IS NULL AND t.profile_id = $1::bigint
       LIMIT 1`,
      [profileId]
    );
    const row = rowToTemplate(result.rows[0] || null);
    return row ? { ...row, source: 'shared' } : null;
  },

  async findEffectiveForCategory(userCategoryId, profileId = null) {
    const own = userCategoryId
      ? await this.findByCategoryId(userCategoryId, profileId)
      : null;
    if (own) return own;
    return this.findSharedByProfile(profileId);
  },

  async upsert({ userCategoryId, profileId, settings }) {
    const result = await query(
      `INSERT INTO category_video_cover_templates (
         user_category_id, profile_id, settings, updated_at
       ) VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (user_category_id) WHERE user_category_id IS NOT NULL DO UPDATE SET
         profile_id = EXCLUDED.profile_id,
         settings = EXCLUDED.settings,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [userCategoryId, profileId, JSON.stringify(normalizeVideoCoverSettings(settings))]
    );
    const row = rowToTemplate(result.rows[0]);
    return row ? { ...row, source: 'category' } : null;
  },

  async upsertShared({ profileId, settings }) {
    const result = await query(
      `INSERT INTO category_video_cover_templates (
         user_category_id, profile_id, settings, updated_at
       ) VALUES (NULL, $1, $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (profile_id) WHERE user_category_id IS NULL DO UPDATE SET
         settings = EXCLUDED.settings,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [profileId, JSON.stringify(normalizeVideoCoverSettings(settings))]
    );
    const row = rowToTemplate(result.rows[0]);
    return row ? { ...row, source: 'shared' } : null;
  },

  async deleteByCategoryId(userCategoryId, profileId = null) {
    const params = [userCategoryId];
    let profileFilter = '';
    if (profileId != null) {
      profileFilter = ' AND profile_id = $2::bigint';
      params.push(profileId);
    }
    await query(
      `DELETE FROM category_video_cover_templates
       WHERE user_category_id = $1::bigint${profileFilter}`,
      params
    );
  },

  async deleteShared(profileId) {
    await query(
      `DELETE FROM category_video_cover_templates
       WHERE user_category_id IS NULL AND profile_id = $1::bigint`,
      [profileId]
    );
  },
};
