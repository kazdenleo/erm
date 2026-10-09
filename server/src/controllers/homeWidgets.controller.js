/**
 * Виджеты главной страницы: личная раскладка текущего пользователя.
 */

import { query } from '../config/database.js';

const MAX_ITEMS = 40;
const SIZES = new Set(['sm', 'md', 'lg']);
const KEY_RE = /^[a-z0-9_-]{1,40}$/i;
const MAX_SETTINGS_JSON = 4000;

function sanitizeItems(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const items = [];
  for (const it of raw.slice(0, MAX_ITEMS)) {
    if (!it || typeof it !== 'object') continue;
    const type = String(it.type || '');
    const uid = String(it.uid || '');
    if (!KEY_RE.test(type) || !KEY_RE.test(uid) || seen.has(uid)) continue;
    seen.add(uid);
    let settings = it.settings && typeof it.settings === 'object' && !Array.isArray(it.settings) ? it.settings : {};
    if (JSON.stringify(settings).length > MAX_SETTINGS_JSON) settings = {};
    items.push({ uid, type, size: SIZES.has(it.size) ? it.size : 'md', settings });
  }
  return items;
}

export const homeWidgetsController = {
  async get(req, res) {
    const r = await query('SELECT home_widgets FROM users WHERE id = $1', [req.user.id]);
    const stored = r.rows?.[0]?.home_widgets;
    const items = sanitizeItems(stored?.items);
    res.json({ ok: true, data: { items } });
  },

  async update(req, res) {
    const body = req.body || {};
    if (body.reset === true) {
      await query('UPDATE users SET home_widgets = NULL WHERE id = $1', [req.user.id]);
      return res.json({ ok: true, data: { items: null } });
    }
    const items = sanitizeItems(body.items);
    if (!items) {
      return res.status(400).json({ ok: false, message: 'Ожидается список виджетов' });
    }
    await query('UPDATE users SET home_widgets = $2::jsonb WHERE id = $1', [
      req.user.id,
      JSON.stringify({ items }),
    ]);
    return res.json({ ok: true, data: { items } });
  },
};
