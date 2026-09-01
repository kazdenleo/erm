/**
 * КриптоПро ЭЦП Browser plug-in: загрузка API, диагностика, подпись CAdES-BES.
 *
 * Важно: cadesplugin — это Promise. Расширение часто вызывает plugin_loaded()
 * раньше, чем cadesplugin.set(nativeObject). Поэтому нельзя считать плагин
 * готовым сразу после then(): нужно дождаться рабочего CreateObjectAsync.
 * Вызовы COM идут через async_spawn, как в примерах КриптоПро.
 */

const CADES_API_SRC = `${process.env.PUBLIC_URL || ''}/cadesplugin_api.js`;
const PLUGIN_OBJECT_HINT = 'Расширение КриптоПро отвечает, но не создало объект CAdESCOM. Закройте все окна браузера, убедитесь что КриптоПро CSP установлен и запущен, разрешите этот сайт в расширении и откройте страницу заново.';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function missingPluginError(message) {
  const err = new Error(message);
  err.code = 'CADES_MISSING';
  return err;
}

function asErrorMessage(err, plugin) {
  try {
    if (plugin && typeof plugin.getLastError === 'function') {
      const last = plugin.getLastError(err);
      if (last) return String(last);
    }
  } catch {
    /* ignore */
  }
  if (err == null) return '';
  if (typeof err === 'string') return err;
  return String(err.message || err);
}

function isPluginObjectMissing(message) {
  return /undefined/i.test(message) && /(CreateObjectAsync|async_spawn)/i.test(message);
}

function wrapCadesError(err, plugin) {
  const message = asErrorMessage(err, plugin);
  if (isPluginObjectMissing(message)) {
    return missingPluginError(PLUGIN_OBJECT_HINT);
  }
  const wrapped = new Error(message || 'Ошибка КриптоПро');
  wrapped.code = 'CADES_COM';
  return wrapped;
}

function loadCadesApiScript() {
  if (typeof window === 'undefined') {
    return Promise.reject(missingPluginError('КриптоПро доступен только в браузере'));
  }
  // Не показывать штатную модалку КриптоПро («Скачать расширение») —
  // диагностика и чеклист Честного знака сами подскажут, что установить.
  window.cadesplugin_skip_extension_install = true;
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

function awaitPluginThen(plugin) {
  if (plugin && typeof plugin.then === 'function') {
    return new Promise((resolve, reject) => {
      plugin.then(() => resolve(true), reject);
    });
  }
  return Promise.resolve(plugin);
}

function getCadesPlugin() {
  const plugin = typeof window !== 'undefined' ? window.cadesplugin : null;
  if (!plugin) {
    throw missingPluginError(
      'Не найден плагин «КриптоПро ЭЦП Browser plug-in». Установите расширение в браузере и разрешите работу на этом сайте, затем обновите страницу.'
    );
  }
  return plugin;
}

function createAboutObject(plugin) {
  if (!plugin) {
    return Promise.reject(new Error('Плагин КриптоПро не инициализирован'));
  }
  if (typeof plugin.CreateObjectAsync === 'function' && typeof plugin.async_spawn === 'function') {
    return plugin.async_spawn(function* () {
      return yield plugin.CreateObjectAsync('CAdESCOM.About');
    });
  }
  if (typeof plugin.CreateObject === 'function') {
    return Promise.resolve(plugin.CreateObject('CAdESCOM.About'));
  }
  return Promise.reject(new Error('CreateObjectAsync отсутствует'));
}

/**
 * Ждёт готовности плагина. Не возвращает сам cadesplugin: это Promise,
 * и async-функция разворачивает его в undefined (plugin_resolve() без аргумента).
 */
async function waitCadesPlugin(timeoutMs = 20000) {
  await loadCadesApiScript();
  const started = Date.now();
  while (!window.cadesplugin && Date.now() - started < 4000) {
    await delay(100);
  }
  const plugin = getCadesPlugin();

  let timer;
  try {
    await Promise.race([
      awaitPluginThen(plugin),
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
  } catch (err) {
    if (err?.code === 'CADES_TIMEOUT') throw err;
    throw missingPluginError(asErrorMessage(err, plugin) || 'Плагин КриптоПро не загрузился');
  } finally {
    if (timer) clearTimeout(timer);
  }

  const bindDeadline = Date.now() + 8000;
  let lastErr = '';
  while (Date.now() < bindDeadline) {
    try {
      const about = await createAboutObject(plugin);
      if (about) return;
    } catch (err) {
      lastErr = asErrorMessage(err, plugin);
      if (
        typeof plugin.CreateObjectAsync === 'function'
        && typeof plugin.async_spawn === 'function'
        && lastErr
        && !isPluginObjectMissing(lastErr)
      ) {
        return;
      }
    }
    await delay(150);
  }

  throw missingPluginError(lastErr && isPluginObjectMissing(lastErr)
    ? PLUGIN_OBJECT_HINT
    : (lastErr || PLUGIN_OBJECT_HINT));
}

function runCades(generatorFn) {
  return waitCadesPlugin().then(() => {
    const plugin = getCadesPlugin();
    if (typeof plugin.async_spawn !== 'function') {
      throw missingPluginError(PLUGIN_OBJECT_HINT);
    }
    return Promise.resolve(plugin.async_spawn(function* () {
      return yield* generatorFn(plugin);
    })).catch((err) => {
      throw wrapCadesError(err, plugin);
    });
  });
}

function parseCn(subjectName) {
  const s = String(subjectName || '');
  const m = s.match(/(?:^|[,/])\s*CN=([^,/]+)/i);
  return m ? m[1].trim() : s || 'Сертификат';
}

export function normalizeThumbprint(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function readAboutFromObject(about) {
  return (async () => {
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
  })();
}

async function readAbout(cadesplugin) {
  try {
    const about = await createAboutObject(cadesplugin);
    return await readAboutFromObject(about);
  } catch {
    return { pluginVersion: '', csp: '' };
  }
}

function* listCertificatesGenerator(cadesplugin) {
  const store = yield cadesplugin.CreateObjectAsync('CAdESCOM.Store');
  yield store.Open(
    cadesplugin.CAPICOM_CURRENT_USER_STORE,
    cadesplugin.CAPICOM_MY_STORE || 'My',
    cadesplugin.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED
  );
  try {
    const certsObj = yield store.Certificates;
    const count = yield certsObj.Count;
    const list = [];
    for (let i = 1; i <= count; i += 1) {
      const cert = yield certsObj.Item(i);
      let hasPrivate = false;
      try {
        hasPrivate = Boolean(yield cert.HasPrivateKey());
      } catch {
        hasPrivate = false;
      }
      if (!hasPrivate) continue;
      const subject = yield cert.SubjectName;
      const thumbprint = normalizeThumbprint(yield cert.Thumbprint);
      const validFrom = yield cert.ValidFromDate;
      const validTo = yield cert.ValidToDate;
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
      yield store.Close();
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
    await waitCadesPlugin(20000);
    const cadesplugin = getCadesPlugin();
    pluginReady = true;
    about = await readAbout(cadesplugin);
    const verBits = [about.pluginVersion, about.csp].filter(Boolean).join(', ');
    items.push({
      id: 'plugin',
      ok: true,
      title: 'Плагин и расширение отвечают',
      hint: verBits
        ? `КриптоПро: ${verBits}`
        : 'Расширение браузера связано с КриптоПро CSP — объект CAdESCOM создан.',
    });
    try {
      certificates = await runCades(listCertificatesGenerator);
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
      hint: 'Сначала нужно, чтобы плагин создал объект CAdESCOM на этой странице.',
    });
  }

  return { items, pluginReady, certificates, about, error };
}

export async function listCryptoProCertificates() {
  return runCades(listCertificatesGenerator);
}

export async function createAttachedCadesBes(thumbprint, data) {
  const needle = normalizeThumbprint(thumbprint);
  if (!needle) {
    throw new Error('Выберите сертификат УКЭП');
  }
  return runCades(function* (cadesplugin) {
    const store = yield cadesplugin.CreateObjectAsync('CAdESCOM.Store');
    yield store.Open(
      cadesplugin.CAPICOM_CURRENT_USER_STORE,
      cadesplugin.CAPICOM_MY_STORE || 'My',
      cadesplugin.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED
    );
    try {
      const certs = yield store.Certificates;
      const found = yield certs.Find(cadesplugin.CAPICOM_CERTIFICATE_FIND_SHA1_HASH, needle);
      const count = yield found.Count;
      if (!count) {
        throw new Error('Сертификат не найден в хранилище текущего пользователя');
      }
      const cert = yield found.Item(1);
      const signer = yield cadesplugin.CreateObjectAsync('CAdESCOM.CPSigner');
      yield signer.propset_Certificate(cert);
      try {
        yield signer.propset_CheckCertificate(false);
      } catch {
        /* старые версии плагина */
      }
      const signedData = yield cadesplugin.CreateObjectAsync('CAdESCOM.CadesSignedData');
      yield signedData.propset_Content(String(data ?? ''));
      return yield signedData.SignCades(signer, cadesplugin.CADESCOM_CADES_BES);
    } finally {
      try {
        yield store.Close();
      } catch {
        /* ignore */
      }
    }
  });
}

/** Откреплённая CAdES-BES — для документов True API (product_document). */
export async function createDetachedCadesBes(thumbprint, data) {
  const needle = normalizeThumbprint(thumbprint);
  if (!needle) {
    throw new Error('Выберите сертификат УКЭП');
  }
  return runCades(function* (cadesplugin) {
    const store = yield cadesplugin.CreateObjectAsync('CAdESCOM.Store');
    yield store.Open(
      cadesplugin.CAPICOM_CURRENT_USER_STORE,
      cadesplugin.CAPICOM_MY_STORE || 'My',
      cadesplugin.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED
    );
    try {
      const certs = yield store.Certificates;
      const found = yield certs.Find(cadesplugin.CAPICOM_CERTIFICATE_FIND_SHA1_HASH, needle);
      const count = yield found.Count;
      if (!count) {
        throw new Error('Сертификат не найден в хранилище текущего пользователя');
      }
      const cert = yield found.Item(1);
      const signer = yield cadesplugin.CreateObjectAsync('CAdESCOM.CPSigner');
      yield signer.propset_Certificate(cert);
      try {
        yield signer.propset_CheckCertificate(false);
      } catch {
        /* старые версии плагина */
      }
      const signedData = yield cadesplugin.CreateObjectAsync('CAdESCOM.CadesSignedData');
      yield signedData.propset_Content(String(data ?? ''));
      return yield signedData.SignCades(signer, cadesplugin.CADESCOM_CADES_BES, true);
    } finally {
      try {
        yield store.Close();
      } catch {
        /* ignore */
      }
    }
  });
}
