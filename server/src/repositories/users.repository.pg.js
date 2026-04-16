/**
 * Users Repository (PostgreSQL)
 */

import { query } from '../config/database.js';

class UsersRepositoryPG {
  async findAll(filters = {}) {
    const { profileId } = filters;
    if (profileId != null) {
      const result = await query(
        `SELECT id, email, full_name, last_name, first_name, middle_name, phone, role, profile_id, is_profile_admin, must_change_password, created_at, updated_at FROM users
         WHERE profile_id = $1 AND role <> 'admin'
         ORDER BY email`,
        [profileId]
      );
      return result.rows;
    }
    const result = await query(
      'SELECT id, email, full_name, last_name, first_name, middle_name, phone, role, profile_id, is_profile_admin, must_change_password, created_at, updated_at FROM users ORDER BY email'
    );
    return result.rows;
  }

  async findById(id) {
    const result = await query(
      'SELECT id, email, full_name, last_name, first_name, middle_name, phone, role, profile_id, is_profile_admin, must_change_password, created_at, updated_at FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async findByEmail(email) {
    const result = await query(
      'SELECT * FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))',
      [email]
    );
    return result.rows[0] || null;
  }

  async create(data) {
    const {
      email,
      passwordHash,
      fullName,
      lastName,
      firstName,
      middleName,
      phone,
      role = 'user',
      profileId,
      isProfileAdmin = false,
      mustChangePassword = false,
    } = data;
    const phoneVal =
      phone != null && phone !== '' && String(phone).trim() !== '' ? String(phone).trim() : null;
    const result = await query(
      `INSERT INTO users (email, password_hash, full_name, last_name, first_name, middle_name, phone, role, profile_id, is_profile_admin, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, email, full_name, last_name, first_name, middle_name, phone, role, profile_id, is_profile_admin, must_change_password, created_at, updated_at`,
      [email, passwordHash, fullName || null, lastName || null, firstName || null, middleName || null, phoneVal, role, profileId || null, isProfileAdmin, !!mustChangePassword]
    );
    return result.rows[0];
  }

  async update(id, data) {
    const updates = { ...data };
    if (updates.fullName !== undefined && updates.full_name === undefined) {
      updates.full_name = updates.fullName;
    }
    const fields = [];
    const params = [];
    let i = 1;
    if (updates.full_name !== undefined) {
      fields.push(`full_name = $${i++}`);
      params.push(updates.full_name === '' ? null : updates.full_name);
    }
    if (updates.last_name !== undefined) {
      fields.push(`last_name = $${i++}`);
      params.push(updates.last_name === '' ? null : updates.last_name);
    }
    if (updates.first_name !== undefined) {
      fields.push(`first_name = $${i++}`);
      params.push(updates.first_name === '' ? null : updates.first_name);
    }
    if (updates.middle_name !== undefined) {
      fields.push(`middle_name = $${i++}`);
      params.push(updates.middle_name === '' ? null : updates.middle_name);
    }
    if (updates.phone !== undefined) {
      fields.push(`phone = $${i++}`);
      params.push(updates.phone === '' || updates.phone == null ? null : String(updates.phone).trim());
    }
    if (updates.role !== undefined) {
      fields.push(`role = $${i++}`);
      params.push(updates.role);
    }
    if (updates.profile_id !== undefined) {
      fields.push(`profile_id = $${i++}`);
      params.push(updates.profile_id);
    }
    if (updates.is_profile_admin !== undefined) {
      fields.push(`is_profile_admin = $${i++}`);
      params.push(!!updates.is_profile_admin);
    }
    if (updates.password_hash !== undefined) {
      fields.push(`password_hash = $${i++}`);
      params.push(updates.password_hash);
    }
    if (updates.must_change_password !== undefined) {
      fields.push(`must_change_password = $${i++}`);
      params.push(!!updates.must_change_password);
    } else if (updates.mustChangePassword !== undefined) {
      fields.push(`must_change_password = $${i++}`);
      params.push(!!updates.mustChangePassword);
    }
    if (fields.length === 0) return await this.findById(id);
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    const result = await query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, email, full_name, last_name, first_name, middle_name, phone, role, profile_id, is_profile_admin, must_change_password, created_at, updated_at`,
      params
    );
    return result.rows[0] || null;
  }

  async delete(id) {
    const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
}

export default new UsersRepositoryPG();
