/**
 * Кнопка-переключатель маркетплейса (Ozon / WB / ЯМ).
 */
export function MarketplaceToggle({
  active,
  title,
  color,
  textColor = '#fff',
  children,
  onToggle,
  size = 28,
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={title}
      title={title}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle?.();
      }}
      style={{
        width: size,
        height: size,
        borderRadius: '6px',
        border: active ? `2px solid ${color}` : '1px solid #d1d5db',
        cursor: 'pointer',
        fontSize: size <= 24 ? '7px' : '8px',
        fontWeight: 800,
        letterSpacing: '-0.02em',
        lineHeight: 1,
        color: active ? textColor : '#374151',
        background: active ? color : '#f3f4f6',
        opacity: active ? 1 : 0.75,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}
