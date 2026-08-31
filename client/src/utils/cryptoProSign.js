/**
 * КриптоПро ЭЦП Browser plug-in: список сертификатов и CAdES-BES подпись.
 * Плагин должен быть установлен в браузере пользователя.
 */

function getCadesPlugin() {
  if (typeof window === 'undefined' || !window.cadesplugin) {
    const err = new Error(
      'Не найден плагин «КриптоПро ЭЦП Browser plug-in». Установите его с cryptopro.ru и разрешите работу на этом сайте.'
    );
    err.code = 'CADES_MISSING';
    throw err;
  }
  return window.cadesplugin;
}

async function waitCadesPlugin(timeoutMs = 8000) {
  const plugin = getCadesPlugin();
  let timer;
  try {
    await Promise.race([
      Promise.resolve(plugin),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('Плагин КриптоПро не ответил. Проверьте, что он включён для этого сайта.');
          err.code = 'CADES_TIMEOUT';
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return plugin;
}

function parseCn(subjectName) {
  const s = String(subjectName || '');
  const m = s.match(/(?:^|[,/])\s*CN=([^,/]+)/i);
  return m ? m[1].trim() : s || 'Сертификат';
}

export function normalizeThumbprint(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

export async function isCryptoProAvailable() {
  try {
    await waitCadesPlugin(2500);
    return true;
  } catch {
    return false;
  }
}

export async function listCryptoProCertificates() {
  const cadesplugin = await waitCadesPlugin();
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
