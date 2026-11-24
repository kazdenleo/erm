/**
 * Публичные заявки на демо-доступ.
 */
import { provisionDemoAccess } from '../services/demoProvisioning.service.js';
import logger from '../utils/logger.js';

export async function requestDemo(req, res) {
  try {
    const data = await provisionDemoAccess({
      ...(req.body || {}),
      ip: req.ip || req.headers['x-forwarded-for'],
    });
    return res.status(201).json({
      ok: true,
      message: data.mailSent
        ? 'Демо-кабинет создан. Данные для входа отправлены на email.'
        : 'Демо-кабинет создан. Письмо не удалось отправить — сохраните пароль с экрана.',
      data,
    });
  } catch (error) {
    const status = error?.statusCode || 500;
    if (status >= 500) {
      logger.error('[demo] request failed', { error: error?.message, stack: error?.stack });
    }
    return res.status(status).json({
      ok: false,
      code: error?.code || undefined,
      message: error?.message || 'Не удалось выдать демо',
    });
  }
}
