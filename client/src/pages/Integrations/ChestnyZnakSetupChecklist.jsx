import React from 'react';
import { Button } from '../../components/common/Button/Button';

const INSTALL_STEPS = [
  {
    title: 'КриптоПро CSP',
    text: 'Установите КриптоПро CSP 5.0 с сайта cryptopro.ru (нужна лицензия). Без CSP плагин не подпишет данные.',
    href: 'https://www.cryptopro.ru/products/csp/downloads',
    hrefLabel: 'Скачать CSP',
  },
  {
    title: 'КриптоПро ЭЦП Browser plug-in',
    text: 'Поставьте сам плагин и расширение браузера. В Яндекс.Браузере расширение ставится из Opera Add-ons.',
    href: 'https://www.cryptopro.ru/products/cades/plugin',
    hrefLabel: 'Скачать плагин',
  },
  {
    title: 'Разрешить этот сайт',
    text: 'Откройте эту страницу заново. Если расширение спросит доступ — нажмите «Разрешить». В настройках расширения dttrade.ru должен быть в списке доверенных сайтов. Если скрипт загружен, а сертификаты не читаются — полностью закройте браузер и запустите КриптоПро CSP.',
  },
  {
    title: 'Проверка на сайте КриптоПро',
    text: 'Сначала убедитесь, что диагностика КриптоПро видит сертификаты. Если там всё зелёное, а здесь нет — обновите эту вкладку после разрешения сайта.',
    href: 'https://www.cryptopro.ru/sites/default/files/products/cades/demopage/simple.html',
    hrefLabel: 'Открыть диагностику КриптоПро',
  },
  {
    title: 'Сертификат УКЭП',
    text: 'Сертификат должен быть в хранилище «Текущий пользователь». Руководитель — подпись ФНС; сотрудник — подпись физлица плюс МЧД в ЛК ГИС МТ.',
  },
  {
    title: 'Личный кабинет Честного знака',
    text: 'Организация зарегистрирована на markirovka.crpt.ru, товарная группа активирована, этим сертификатом можно войти в кабинет.',
    href: 'https://markirovka.crpt.ru/',
    hrefLabel: 'Открыть ЛК ГИС МТ',
  },
];

export function ChestnyZnakSetupChecklist({
  setup,
  checking,
  onCheck,
  pluginOk,
}) {
  const items = setup?.items || [];
  return (
    <div className="chestny-setup">
      <h3>Проверка рабочего места</h3>
      <p className="chestny-hint">
        Плагин может быть установлен, но браузер не отдаёт его этой странице, пока не подключён API
        КриптоПро и сайт не разрешён в расширении.
      </p>

      <ol className="chestny-setup-steps">
        {INSTALL_STEPS.map((step, idx) => (
          <li key={step.title}>
            <strong>{idx + 1}. {step.title}</strong>
            <span>{step.text}</span>
            {step.href && (
              <a href={step.href} target="_blank" rel="noopener noreferrer">{step.hrefLabel}</a>
            )}
          </li>
        ))}
      </ol>

      <div className="form-actions" style={{ marginTop: 12 }}>
        <Button type="button" variant="secondary" onClick={onCheck} disabled={checking}>
          {checking ? 'Проверка…' : 'Проверить установку'}
        </Button>
      </div>

      {items.length > 0 && (
        <ul className="chestny-setup-live">
          {items.map((item) => (
            <li key={item.id} className={item.ok ? 'is-ok' : 'is-fail'}>
              <span className="chestny-setup-dot" aria-hidden />
              <div>
                <strong>{item.title}</strong>
                {item.hint && <span className="chestny-hint">{item.hint}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pluginOk === false && setup && (
        <p className="chestny-hint">
          Пока плагин не отвечает, можно сохранить настройки и вставить токен вручную — вход по УКЭП станет доступен после зелёных пунктов выше.
        </p>
      )}
    </div>
  );
}
