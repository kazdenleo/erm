import React from 'react';
import { MarketplaceToggle } from '../MarketplaceToggle/MarketplaceToggle.jsx';
import {
  MP_FIELD_LINK_TITLES,
  MP_FIELD_LINK_TOGGLES,
  MP_FIELD_LINK_PEER_SYNC,
  isAttrMpFieldLinkKey,
  isMpFieldLinked,
  supportedMpsForFieldKey,
} from '../../../utils/productMpFieldLinks.js';

/**
 * Значки OZ/WB/ЯМ рядом с подписью поля: включённый = поле связано с МП.
 */
export function MpFieldLinkToggles({ fieldKey, links, onToggle, size = 22, supportedMps, style }) {
  const supported = supportedMpsForFieldKey(fieldKey, supportedMps);
  const baseTitle = isAttrMpFieldLinkKey(fieldKey)
    ? 'Связать с основным атрибутом (не с другими МП)'
    : MP_FIELD_LINK_TITLES[fieldKey] || 'Связать с маркетплейсом';

  return (
    <span
      className="mp-field-link-toggles"
      style={{
        display: 'inline-flex',
        gap: 4,
        alignItems: 'center',
        marginLeft: 8,
        verticalAlign: 'middle',
        ...style,
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {MP_FIELD_LINK_TOGGLES.filter((mp) => supported.includes(mp.code)).map((mp) => {
        const active = isMpFieldLinked(links, fieldKey, mp.code);
        return (
          <MarketplaceToggle
            key={mp.code}
            active={active}
            size={size}
            color={mp.color}
            title={
              MP_FIELD_LINK_PEER_SYNC[fieldKey]
                ? active
                  ? `${baseTitle}: ${mp.title} — включено, генерация заполнит и этот МП`
                  : `${baseTitle}: ${mp.title} — выключено, свой Rich-контент`
                : active
                  ? `${baseTitle}: ${mp.title} — связано с «Основным»`
                  : `${baseTitle}: ${mp.title} — своё значение (не с другими МП)`
            }
            onToggle={() => onToggle?.(fieldKey, mp.code)}
          >
            {mp.label}
          </MarketplaceToggle>
        );
      })}
    </span>
  );
}

/** Значки OZ/WB/ЯМ у атрибута, связанного в категории. Только индикатор, не тумблер. */
export function MpMappedMpBadges({ mps, size = 18 }) {
  const codes = (Array.isArray(mps) ? mps : [])
    .map((m) => String(m || '').toLowerCase())
    .filter((m) => MP_FIELD_LINK_TOGGLES.some((t) => t.code === m));
  if (!codes.length) return null;
  return (
    <span
      className="mp-field-link-toggles"
      style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 8, verticalAlign: 'middle' }}
    >
      {MP_FIELD_LINK_TOGGLES.filter((mp) => codes.includes(mp.code)).map((mp) => (
        <MarketplaceToggle
          key={mp.code}
          active
          readOnly
          size={size}
          color={mp.color}
          title={`${mp.title}: сопоставлено в настройках категории`}
        >
          {mp.label}
        </MarketplaceToggle>
      ))}
    </span>
  );
}

/** Иконка на поле МП: значение берётся с вкладки «Основное». */
export function MpFromMainLinkIcon({ linked = false, title }) {
  return (
    <span
      className={`mp-from-main-link${linked ? ' is-linked' : ''}`}
      title={
        title ||
        (linked
          ? 'Значение берётся с вкладки «Основное»'
          : 'Связь с «Основным» выключена — своё значение на МП')
      }
      aria-label={linked ? 'Связь с Основным включена' : 'Связь с Основным выключена'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 6,
        width: 18,
        height: 18,
        borderRadius: 4,
        background: linked ? '#eef2ff' : 'rgba(0,0,0,0.04)',
        color: linked ? '#4338ca' : '#94a3b8',
        verticalAlign: 'middle',
        flexShrink: 0,
        opacity: linked ? 1 : 0.55,
      }}
    >
      <i className="pe-7s-link" aria-hidden style={{ fontSize: 14, fontWeight: 700, lineHeight: 1 }} />
    </span>
  );
}

/**
 * Подпись поля + значки связи.
 * @param {{ mp: string, label: string, title: string }[]} [diffs] — МП, где значение ≠ Основному
 */
export function MpFieldLabel({ htmlFor, fieldKey, links, onToggle, children, required, diffs, supportedMps, readOnly = false }) {
  return (
    <label
      className="form-label"
      htmlFor={htmlFor}
      style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 0' }}
    >
      <span>
        {children}
        {required ? <span style={{ color: '#ef4444' }}> *</span> : null}
      </span>
      {readOnly ? (
        <MpMappedMpBadges mps={links?.[fieldKey]} />
      ) : (
        <MpFieldLinkToggles
          fieldKey={fieldKey}
          links={links}
          onToggle={onToggle}
          supportedMps={supportedMps}
        />
      )}
      <MpValueDiffBadges diffs={diffs} />
    </label>
  );
}

/** Компактные OZ/WB/ЯМ + «!», если значение на МП отличается от Основного. */
export function MpValueDiffBadges({ diffs }) {
  if (!Array.isArray(diffs) || diffs.length === 0) return null;
  return (
    <span className="mp-attr-diff-badges" aria-label="Отличается от маркетплейса">
      <span className="mp-attr-diff-warn" title="Значение на маркетплейсе отличается от «Основного»">
        !
      </span>
      {diffs.map((d) => (
        <span
          key={d.mp}
          className={`mp-badge ${d.mp} mp-badge--diff`}
          title={d.title || `Отличается на ${d.label}`}
        >
          {d.label}
        </span>
      ))}
    </span>
  );
}
