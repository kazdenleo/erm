/**
 * Шаблон этикетки ШК упаковки (один на профиль)
 */

import { query } from '../config/database.js';

function parseElements(raw) {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

function rowToTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    profile_id: row.profile_id,
    profileId: row.profile_id,
    size_preset: row.size_preset,
    sizePreset: row.size_preset,
    width_mm: row.width_mm != null ? Number(row.width_mm) : null,
    widthMm: row.width_mm != null ? Number(row.width_mm) : null,
    height_mm: row.height_mm != null ? Number(row.height_mm) : null,
    heightMm: row.height_mm != null ? Number(row.height_mm) : null,
    margin_top_mm: Number(row.margin_top_mm),
    marginTopMm: Number(row.margin_top_mm),
    margin_right_mm: Number(row.margin_right_mm),
    marginRightMm: Number(row.margin_right_mm),
    margin_bottom_mm: Number(row.margin_bottom_mm),
    marginBottomMm: Number(row.margin_bottom_mm),
    margin_left_mm: Number(row.margin_left_mm),
    marginLeftMm: Number(row.margin_left_mm),
    line_gap_mm: Number(row.line_gap_mm ?? 1),
    lineGapMm: Number(row.line_gap_mm ?? 1),
    elements: parseElements(row.elements),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const packagingLabelTemplatesRepository = {
  async findByProfileId(profileId) {
    if (profileId == null || profileId === '') return null;
    const result = await query(
      `SELECT t.* FROM packaging_label_templates t
       WHERE t.profile_id = $1::bigint
       LIMIT 1`,
      [profileId]
    );
    return rowToTemplate(result.rows[0] || null);
  },

  async upsert(data) {
    const {
      profileId,
      sizePreset = '58x40',
      widthMm = null,
      heightMm = null,
      marginTopMm = 2,
      marginRightMm = 2,
      marginBottomMm = 2,
      marginLeftMm = 2,
      lineGapMm = 1,
      elements = [],
    } = data;
    if (profileId == null || profileId === '') {
      const err = new Error('Нужен профиль для шаблона этикетки упаковки');
      err.statusCode = 400;
      throw err;
    }
    const result = await query(
      `INSERT INTO packaging_label_templates (
         profile_id, size_preset, width_mm, height_mm,
         margin_top_mm, margin_right_mm, margin_bottom_mm, margin_left_mm, line_gap_mm, elements, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (profile_id) DO UPDATE SET
         size_preset = EXCLUDED.size_preset,
         width_mm = EXCLUDED.width_mm,
         height_mm = EXCLUDED.height_mm,
         margin_top_mm = EXCLUDED.margin_top_mm,
         margin_right_mm = EXCLUDED.margin_right_mm,
         margin_bottom_mm = EXCLUDED.margin_bottom_mm,
         margin_left_mm = EXCLUDED.margin_left_mm,
         line_gap_mm = EXCLUDED.line_gap_mm,
         elements = EXCLUDED.elements,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        profileId,
        sizePreset,
        widthMm,
        heightMm,
        marginTopMm,
        marginRightMm,
        marginBottomMm,
        marginLeftMm,
        lineGapMm,
        JSON.stringify(Array.isArray(elements) ? elements : []),
      ]
    );
    return rowToTemplate(result.rows[0]);
  },

  async deleteByProfileId(profileId) {
    if (profileId == null || profileId === '') return false;
    const result = await query(
      `DELETE FROM packaging_label_templates
       WHERE profile_id = $1::bigint
       RETURNING id`,
      [profileId]
    );
    return (result.rows || []).length > 0;
  },
};
