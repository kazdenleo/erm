/**
 * Даты сертификата для характеристик Wildberries: ДД.ММ.ГГГГ.
 * Одиночные цифры (3, 2) не считаем датой.
 * @param {unknown} raw
 * @returns {string}
 */
export function formatWbCertDate(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (dmy) return `${dmy[1].padStart(2, '0')}.${dmy[2].padStart(2, '0')}.${dmy[3]}`;
  return '';
}
