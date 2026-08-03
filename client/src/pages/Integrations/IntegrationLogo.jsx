/**
 * Логотипы интеграций (упрощённые брендовые знаки для плашек).
 */

export function IntegrationLogo({ type, size = 56 }) {
  const style = { width: size, height: size };

  switch (type) {
    case 'ozon':
      return (
        <div className="int-logo int-logo--ozon" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#005BFF" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="700" fontFamily="system-ui,sans-serif">
              OZ
            </text>
          </svg>
        </div>
      );
    case 'wildberries':
      return (
        <div className="int-logo int-logo--wb" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#CB11AB" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="15" fontWeight="700" fontFamily="system-ui,sans-serif">
              WB
            </text>
          </svg>
        </div>
      );
    case 'yandex':
      return (
        <div className="int-logo int-logo--ym" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#FC0" />
            <text x="28" y="34" textAnchor="middle" fill="#000" fontSize="15" fontWeight="700" fontFamily="system-ui,sans-serif">
              YM
            </text>
          </svg>
        </div>
      );
    case 'avito':
      return (
        <div className="int-logo int-logo--avito" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#00AAFF" />
            <circle cx="18" cy="22" r="5" fill="#97CF26" />
            <circle cx="30" cy="18" r="5" fill="#FF6163" />
            <circle cx="38" cy="28" r="5" fill="#A169F7" />
            <circle cx="26" cy="34" r="5" fill="#FFB800" />
          </svg>
        </div>
      );
    case 'mikado':
      return (
        <div className="int-logo int-logo--mikado" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#1B4F72" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="18" fontWeight="700" fontFamily="system-ui,sans-serif">
              M
            </text>
          </svg>
        </div>
      );
    case 'moskvorechie':
      return (
        <div className="int-logo int-logo--moskvorechie" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#C0392B" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="700" fontFamily="system-ui,sans-serif">
              МСК
            </text>
          </svg>
        </div>
      );
    case 'mparts':
      return (
        <div className="int-logo int-logo--mparts" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#2C3E50" />
            <text x="28" y="34" textAnchor="middle" fill="#F39C12" fontSize="13" fontWeight="800" fontFamily="system-ui,sans-serif">
              М-П
            </text>
          </svg>
        </div>
      );
    case 'partkom':
      return (
        <div className="int-logo int-logo--partkom" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#E67E22" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="700" fontFamily="system-ui,sans-serif">
              ПК
            </text>
          </svg>
        </div>
      );
    case 'forum_auto':
      return (
        <div className="int-logo int-logo--forum-auto" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#1A5276" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="12" fontWeight="700" fontFamily="system-ui,sans-serif">
              ФА
            </text>
          </svg>
        </div>
      );
    case 'autopiter':
      return (
        <div className="int-logo int-logo--autopiter" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#117A65" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="12" fontWeight="700" fontFamily="system-ui,sans-serif">
              АП
            </text>
          </svg>
        </div>
      );
    case 'ixora':
      return (
        <div className="int-logo int-logo--ixora" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#6C3483" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="11" fontWeight="700" fontFamily="system-ui,sans-serif">
              IX
            </text>
          </svg>
        </div>
      );
    case 'avtotrade':
      return (
        <div className="int-logo int-logo--avtotrade" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#922B21" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="12" fontWeight="700" fontFamily="system-ui,sans-serif">
              АТ
            </text>
          </svg>
        </div>
      );
    case 'armtek':
      return (
        <div className="int-logo int-logo--armtek" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#1F618D" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="11" fontWeight="700" fontFamily="system-ui,sans-serif">
              АРМ
            </text>
          </svg>
        </div>
      );
    case 'rossko':
      return (
        <div className="int-logo int-logo--rossko" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#B03A2E" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="11" fontWeight="700" fontFamily="system-ui,sans-serif">
              РСК
            </text>
          </svg>
        </div>
      );
    case '1c':
      return (
        <div className="int-logo int-logo--1c" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#FFDB4D" />
            <text x="28" y="35" textAnchor="middle" fill="#E35205" fontSize="18" fontWeight="800" fontFamily="system-ui,sans-serif">
              1С
            </text>
          </svg>
        </div>
      );
    case 'chestny_znak':
      return (
        <div className="int-logo int-logo--chestny" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#00A651" />
            <path
              d="M16 28 l8 8 16-18"
              fill="none"
              stroke="#fff"
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      );
    default:
      return (
        <div className="int-logo int-logo--default" style={style} aria-hidden>
          <svg viewBox="0 0 56 56" width={size} height={size}>
            <rect width="56" height="56" rx="12" fill="#6c757d" />
            <text x="28" y="34" textAnchor="middle" fill="#fff" fontSize="18" fontWeight="700" fontFamily="system-ui,sans-serif">
              ?
            </text>
          </svg>
        </div>
      );
  }
}
