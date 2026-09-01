import productHypothesesService from '../services/productHypotheses.service.js';

export async function list(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { status, productId } = req.query || {};
  const data = await productHypothesesService.list({ profileId, status, productId });
  return res.json({ ok: true, data });
}

export async function create(req, res) {
  const profileId = req.user?.profileId ?? null;
  const data = await productHypothesesService.create({
    profileId,
    createdById: req.user?.id ?? null,
    body: req.body || {},
  });
  return res.status(201).json({ ok: true, data });
}

export async function update(req, res) {
  const profileId = req.user?.profileId ?? null;
  const data = await productHypothesesService.update({
    profileId,
    id: req.params?.id,
    body: req.body || {},
  });
  return res.json({ ok: true, data });
}

export async function remove(req, res) {
  const profileId = req.user?.profileId ?? null;
  const data = await productHypothesesService.remove({
    profileId,
    id: req.params?.id,
  });
  return res.json({ ok: true, data });
}
