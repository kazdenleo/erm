import React from 'react';
import { MarketplaceToggle } from '../MarketplaceToggle/MarketplaceToggle.jsx';
import {
  MP_FIELD_LINK_SUPPORT,
  MP_FIELD_LINK_TITLES,
  MP_FIELD_LINK_TOGGLES,
  isMpFieldLinked,
} from '../../../utils/productMpFieldLinks.js';

/**
 * Значки OZ/WB/ЯМ рядом с подписью поля: включённый = поле связано с МП.
 */
export function MpFieldLinkToggles({ fieldKey, links, onToggle, size = 22 }) {
  const supported = MP_FIELD_LINK_SUPPORT[fieldKey] || [];
  const baseTitle = MP_FIELD_LINK_TITLES[fieldKey] || 'Связать с маркетплейсом';

  return (
    <span
      className="mp-field-link-toggles"
      style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 8, verticalAlign: 'middle' }}
      onClick={(e) => e.preventDefault()}
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
              active
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

/**
 * Подпись поля + значки связи.
 */
export function MpFieldLabel({ htmlFor, fieldKey, links, onToggle, children, required }) {
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
      <MpFieldLinkToggles fieldKey={fieldKey} links={links} onToggle={onToggle} />
    </label>
  );
}
