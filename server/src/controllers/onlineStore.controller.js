import onlineStoreService from '../services/onlineStore.service.js';
import { profileIdFromDb } from '../utils/profileId.js';

function requireProfile(req, res) {
  const pid = profileIdFromDb(req.user?.profileId ?? req.user?.profile_id);
  if (pid == null) {
    res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту.' });
    return null;
  }
  return pid;
}

export async function getTemplates(_req, res) {
  return res.json({ ok: true, data: onlineStoreService.listTemplates() });
}

export async function getMine(req, res) {
  const pid = requireProfile(req, res);
  if (pid == null) return undefined;
  const data = await onlineStoreService.getAdminStore(pid);
  return res.json({ ok: true, data });
}

export async function saveMine(req, res) {
  const pid = requireProfile(req, res);
  if (pid == null) return undefined;
  const data = await onlineStoreService.saveAdminStore(pid, req.body || {});
  return res.json({ ok: true, data });
}

export async function publicGetStore(req, res) {
  const data = await onlineStoreService.getPublicStore(req.params.slug);
  return res.json({ ok: true, data });
}

export async function publicGetStoreByHost(req, res) {
  const host = req.query?.host || req.headers['x-forwarded-host'] || req.headers.host || '';
  const data = await onlineStoreService.getPublicStoreByHost(host);
  return res.json({ ok: true, data });
}

export async function publicListProducts(req, res) {
  const data = await onlineStoreService.listPublicProducts(req.params.slug, {
    q: req.query?.q || '',
    categoryId: req.query?.categoryId || req.query?.category_id || '',
  });
  return res.json({ ok: true, data });
}

export async function publicGetProduct(req, res) {
  const data = await onlineStoreService.getPublicProduct(req.params.slug, req.params.productId);
  return res.json({ ok: true, data });
}

export async function publicCheckout(req, res) {
  const data = await onlineStoreService.checkout(req.params.slug, req.body || {});
  return res.status(201).json({ ok: true, data, message: 'Заказ принят' });
}
