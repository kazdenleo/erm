/**
 * Шаблоны этикеток по пользовательским категориям
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
    user_category_id: row.user_category_id,
    userCategoryId: row.user_category_id,
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

export const categoryLabelTemplatesRepository = {
  async findAllByProfile(profileId) {
    const params = [];
    let where = '';
    if (profileId != null) {
      where = 'WHERE t.profile_id = $1::bigint';
      params.push(profileId);
    }
    const result = await query(
      `SELECT t.*, uc.name AS category_name
       FROM category_label_templates t
       JOIN user_categories uc ON uc.id = t.user_category_id
       ${where}
       ORDER BY uc.name`,
      params
    );
    return (result.rows || []).map((row) => ({
      ...rowToTemplate(row),
      category_name: row.category_name,
      categoryName: row.category_name,
    }));
  },

  async findByCategoryId(userCategoryId, profileId = null) {
    const params = [userCategoryId];
    let profileFilter = '';
    if (profileId != null) {
      profileFilter = ' AND t.profile_id = $2::bigint';
      params.push(profileId);
    }
    const result = await query(
      `SELECT t.* FROM category_label_templates t
       WHERE t.user_category_id = $1::bigint${profileFilter}
       LIMIT 1`,
      params
    );
    return rowToTemplate(result.rows[0] || null);
  },

  async upsert(data) {
    const {
      userCategoryId,
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
    const result = await query(
      `INSERT INTO category_label_templates (
         user_category_id, profile_id, size_preset, width_mm, height_mm,
         margin_top_mm, margin_right_mm, margin_bottom_mm, margin_left_mm, line_gap_mm, elements, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (user_category_id) DO UPDATE SET
         profile_id = EXCLUDED.profile_id,
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
        userCategoryId,
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

  async deleteByCategoryId(userCategoryId, profileId = null) {
    const params = [userCategoryId];
    let profileFilter = '';
    if (profileId != null) {
      profileFilter = ' AND profile_id = $2::bigint';
      params.push(profileId);
    }
    const result = await query(
      `DELETE FROM category_label_templates
       WHERE user_category_id = $1::bigint${profileFilter}
       RETURNING id`,
      params
    );
    return (result.rows || []).length > 0;
  },
};
