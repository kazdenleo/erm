/**
 * КриптоПро ЭЦП Browser plug-in: загрузка API, диагностика, подпись CAdES-BES.
 */

const CADES_API_SRC = `${process.env.PUBLIC_URL || ''}/cadesplugin_api.js`;

function missingPluginError(message) {
  const err = new Error(message);
  err.code = 'CADES_MISSING';
  return err;
}

function loadCadesApiScript() {
  if (typeof window === 'undefined') {
    return Promise.reject(missingPluginError('КриптоПро доступен только в браузере'));
  }
  if (window.cadesplugin) return Promise.resolve();
  if (window.__cadesApiLoading) return window.__cadesApiLoading;

  window.__cadesApiLoading = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-cadesplugin-api], script[src*="cadesplugin_api.js"]');
    if (existing) {
      if (window.cadesplugin) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => {
        window.__cadesApiLoading = null;
        reject(missingPluginError('Не удалось загрузить скрипт API КриптоПро'));
      }, { once: true });
      setTimeout(() => {
        if (window.cadesplugin) resolve();
      }, 500);
      return;
    }
    const script = document.createElement('script');
    script.src = CADES_API_SRC;
    script.async = true;
    script.dataset.cadespluginApi = '1';
    script.onload = () => resolve();
    script.onerror = () => {
      window.__cadesApiLoading = null;
      reject(missingPluginError(
        'Не удалось загрузить скрипт API КриптоПро. Проверьте сеть и обновите страницу.'
      ));
    };
    document.head.appendChild(script);
  });
  return window.__cadesApiLoading;
}

async function waitCadesPlugin(timeoutMs = 12000) {
  await loadCadesApiScript();
  const started = Date.now();
  while (!window.cadesplugin && Date.now() - started < 4000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!window.cadesplugin) {
    throw missingPluginError(
      'Не найден плагин «КриптоПро ЭЦП Browser plug-in». Установите расширение в браузере и разрешите работу на этом сайте, затем обновите страницу.'
    );
  }
  const plugin = window.cadesplugin;
  let timer;
  try {
    await Promise.race([
      Promise.resolve(plugin),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(
            'Плагин КриптоПро не ответил. Разрешите доступ для этого сайта в расширении и перезагрузите вкладку.'
          );
          err.code = 'CADES_TIMEOUT';
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return window.cadesplugin;
}

function parseCn(subjectName) {
  const s = String(subjectName || '');
  const m = s.match(/(?:^|[,/])\s*CN=([^,/]+)/i);
  return m ? m[1].trim() : s || 'Сертификат';
}

export function normalizeThumbprint(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

async function readAbout(cadesplugin) {
  try {
    const about = await cadesplugin.CreateObjectAsync('CAdESCOM.About');
    let pluginVersion = '';
    let csp = '';
    try {
      const ver = await about.PluginVersion;
      pluginVersion = ver ? String(await ver.toString()) : '';
    } catch {
      try {
        pluginVersion = String(await about.Version);
      } catch {
        pluginVersion = '';
      }
    }
    try {
      csp = String(await about.CSPName());
    } catch {
      try {
        csp = String(await about.CSPVersion());
      } catch {
        csp = '';
      }
    }
    return { pluginVersion, csp };
  } catch {
    return { pluginVersion: '', csp: '' };
  }
}

async function listCertificatesFromPlugin(cadesplugin) {
  const store = await cadesplugin.CreateObjectAsync('CAdESCOM.Store');
  await store.Open(
    cadesplugin.CAPICOM_CURRENT_USER_STORE,
    'My',
    cadesplugin.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED
  );
  try {
    const certsObj = await store.Certificates;
    const count = await certsObj.Count;
    const list = [];
    for (let i = 1; i <= count; i += 1) {
      const cert = await certsObj.Item(i);
      let hasPrivate = false;
      try {
        hasPrivate = Boolean(await cert.HasPrivateKey());
      } catch {
        hasPrivate = false;
      }
      if (!hasPrivate) continue;
      const subject = await cert.SubjectName;
      const thumbprint = normalizeThumbprint(await cert.Thumbprint);
      const validFrom = await cert.ValidFromDate;
      const validTo = await cert.ValidToDate;
      const validToDate = new Date(validTo);
      list.push({
        thumbprint,
        subject,
        name: parseCn(subject),
        validFrom: new Date(validFrom).toISOString(),
        validTo: validToDate.toISOString(),
        expired: Number.isFinite(validToDate.getTime()) && validToDate.getTime() < Date.now(),
      });
    }
    list.sort((a, b) => Number(a.expired) - Number(b.expired) || String(a.name).localeCompare(String(b.name), 'ru'));
    return list;
  } finally {
    try {
      await store.Close();
    } catch {
      /* ignore */
    }
  }
}

export async function isCryptoProAvailable() {
  try {
    await waitCadesPlugin(8000);
    return true;
  } catch {
    return false;
  }
}

/** Пошаговая проверка рабочего места для УКЭП. */
export async function diagnoseCryptoProSetup() {
  const httpsOk = typeof window !== 'undefined' && window.location?.protocol === 'https:';
  const items = [
    {
      id: 'https',
      ok: httpsOk,
      title: 'Сайт открыт по HTTPS',
      hint: httpsOk
        ? 'Соединение защищено — плагин может работать.'
        : 'Откройте систему по https (например dttrade.ru). В обычном http плагин браузер блокирует.',
    },
  ];

  let pluginReady = false;
  let certificates = [];
  let about = { pluginVersion: '', csp: '' };
  let error = '';

  try {
    await loadCadesApiScript();
    items.push({
      id: 'api',
      ok: true,
      title: 'Скрипт API КриптоПро загружен',
      hint: 'cadesplugin_api.js подключён на странице.',
    });
  } catch (err) {
    items.push({
      id: 'api',
      ok: false,
      title: 'Скрипт API КриптоПро не загрузился',
      hint: err?.message || 'Обновите страницу или проверьте блокировщик рекламы.',
    });
    return { items, pluginReady, certificates, about, error: err?.message || '' };
  }

  try {
    const cadesplugin = await waitCadesPlugin(12000);
    pluginReady = true;
    about = await readAbout(cadesplugin);
    const verBits = [about.pluginVersion, about.csp].filter(Boolean).join(', ');
    items.push({
      id: 'plugin',
      ok: true,
      title: 'Плагин и расширение отвечают',
      hint: verBits
        ? `КриптоПро: ${verBits}`
        : 'Расширение браузера и КриптоПро CSP доступны этой странице.',
    });
    try {
      certificates = await listCertificatesFromPlugin(cadesplugin);
      const valid = certificates.filter((c) => !c.expired);
      items.push({
        id: 'certs',
        ok: valid.length > 0,
        title: valid.length > 0 ? `Сертификаты УКЭП: ${valid.length} действующих` : 'Нет действующих сертификатов с закрытым ключом',
        hint: valid.length > 0
          ? certificates.map((c) => `${c.name}${c.expired ? ' (истёк)' : ''}`).join('; ')
          : 'Установите сертификат в хранилище «Текущий пользователь» через КриптоПро CSP → Сервис → Установить сертификат.',
      });
    } catch (err) {
      items.push({
        id: 'certs',
        ok: false,
        title: 'Не удалось прочитать хранилище сертификатов',
        hint: err?.message || 'Разрешите доступ к сертификатам, когда браузер спросит.',
      });
    }
  } catch (err) {
    error = err?.message || String(err);
    items.push({
      id: 'plugin',
      ok: false,
      title: 'Плагин на этом сайте не отвечает',
      hint: error,
    });
    items.push({
      id: 'certs',
      ok: false,
      title: 'Сертификаты не проверены',
      hint: 'Сначала нужно, чтобы плагин ответил на этой странице.',
    });
  }

  return { items, pluginReady, certificates, about, error };
}

export async function listCryptoProCertificates() {
  const cadesplugin = await waitCadesPlugin();
  return listCertificatesFromPlugin(cadesplugin);
}

export async function createAttachedCadesBes(thumbprint, data) {
  const cadesplugin = await waitCadesPlugin();
  const needle = normalizeThumbprint(thumbprint);
  if (!needle) {
    throw new Error('Выберите сертификат УКЭП');
  }
  const store = await cadesplugin.CreateObjectAsync('CAdESCOM.Store');
  await store.Open(
    cadesplugin.CAPICOM_CURRENT_USER_STORE,
    'My',
    cadesplugin.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED
  );
  try {
    const certs = await store.Certificates;
    const found = await certs.Find(cadesplugin.CAPICOM_CERTIFICATE_FIND_SHA1_HASH, needle);
    const count = await found.Count;
    if (!count) {
      throw new Error('Сертификат не найден в хранилище текущего пользователя');
    }
    const cert = await found.Item(1);
    const signer = await cadesplugin.CreateObjectAsync('CAdESCOM.CPSigner');
    await signer.propset_Certificate(cert);
    try {
      await signer.propset_CheckCertificate(false);
    } catch {
      /* старые версии плагина */
    }
    const signedData = await cadesplugin.CreateObjectAsync('CAdESCOM.CadesSignedData');
    await signedData.propset_Content(String(data ?? ''));
    return signedData.SignCades(signer, cadesplugin.CADESCOM_CADES_BES);
  } finally {
    try {
      await store.Close();
    } catch {
      /* ignore */
    }
  }
}
