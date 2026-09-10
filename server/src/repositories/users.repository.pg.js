/**
 * Users Repository (PostgreSQL)
 */

import { query } from '../config/database.js';
import { looksLikeEmail, normalizePhone } from '../utils/userPhone.js';

const USER_SELECT =
  'id, email, full_name, last_name, first_name, middle_name, phone, phone_normalized, birth_date::text AS birth_date, role, profile_id, is_profile_admin, account_role, must_change_password, created_at, updated_at';

class UsersRepositoryPG {
  async findAll(filters = {}) {
    const { profileId } = filters;
    if (profileId != null) {
      const result = await query(
        `SELECT ${USER_SELECT} FROM users
         WHERE profile_id = $1 AND role <> 'admin'
         ORDER BY phone NULLS LAST, email NULLS LAST`,
        [profileId]
      );
      return result.rows;
    }
    const result = await query(
      `SELECT ${USER_SELECT} FROM users ORDER BY phone NULLS LAST, email NULLS LAST`
    );
    return result.rows;
  }

  async findById(id) {
    const result = await query(
      `SELECT ${USER_SELECT} FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  async findAuthById(id) {
    const result = await query(
      `SELECT ${USER_SELECT}, password_hash FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  async findByEmail(email) {
    const em = String(email || '').trim();
    if (!em) return null;
    const result = await query(
      `SELECT ${USER_SELECT}, password_hash FROM users
       WHERE email IS NOT NULL AND LOWER(TRIM(email)) = LOWER(TRIM($1))`,
      [em]
    );
    return result.rows[0] || null;
  }

  async findByNormalizedPhone(phoneNormalized) {
    if (!phoneNormalized) return null;
    const result = await query(
      `SELECT ${USER_SELECT}, password_hash FROM users WHERE phone_normalized = $1`,
      [phoneNormalized]
    );
    return result.rows[0] || null;
  }

  async findByLogin(login) {
    const raw = String(login || '').trim();
    if (!raw) return null;
    if (looksLikeEmail(raw)) {
      return this.findByEmail(raw);
    }
    const parsed = normalizePhone(raw);
    if (parsed.value) {
      const byPhone = await this.findByNormalizedPhone(parsed.value);
      if (byPhone) return byPhone;
    }
    return this.findByEmail(raw);
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
      phoneNormalized,
      birthDate,
      role = 'user',
      profileId,
      isProfileAdmin = false,
      accountRole = null,
      mustChangePassword = false,
    } = data;
    const emailVal =
      email != null && String(email).trim() !== '' ? String(email).trim().toLowerCase() : null;
    const phoneVal =
      phone != null && phone !== '' && String(phone).trim() !== '' ? String(phone).trim() : null;
    const phoneNormVal =
      phoneNormalized != null && String(phoneNormalized).trim() !== ''
        ? String(phoneNormalized).trim()
        : null;
    const birthVal = birthDate != null && String(birthDate).trim() !== '' ? String(birthDate).trim() : null;
    const result = await query(
      `INSERT INTO users (email, password_hash, full_name, last_name, first_name, middle_name, phone, phone_normalized, birth_date, role, profile_id, is_profile_admin, account_role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${USER_SELECT}`,
      [
        emailVal,
        passwordHash,
        fullName || null,
        lastName || null,
        firstName || null,
        middleName || null,
        phoneVal,
        phoneNormVal,
        birthVal,
        role,
        profileId || null,
        isProfileAdmin,
        accountRole,
        !!mustChangePassword,
      ]
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
    if (updates.email !== undefined) {
      fields.push(`email = $${i++}`);
      params.push(updates.email === '' || updates.email == null ? null : String(updates.email).trim().toLowerCase());
    }
    if (updates.phone !== undefined) {
      fields.push(`phone = $${i++}`);
      params.push(updates.phone === '' || updates.phone == null ? null : String(updates.phone).trim());
    }
    if (updates.phone_normalized !== undefined) {
      fields.push(`phone_normalized = $${i++}`);
      params.push(
        updates.phone_normalized === '' || updates.phone_normalized == null
          ? null
          : String(updates.phone_normalized).trim()
      );
    }
    if (updates.birth_date !== undefined) {
      fields.push(`birth_date = $${i++}`);
      params.push(updates.birth_date === '' || updates.birth_date == null ? null : updates.birth_date);
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
    if (updates.account_role !== undefined) {
      fields.push(`account_role = $${i++}`);
      params.push(updates.account_role === '' ? null : updates.account_role);
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
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING ${USER_SELECT}`,
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
