/**
 * Подсказка бренда WB — обёртка над общим справочником МП.
 */

import React from 'react';
import { MpBrandSuggest } from '../MpBrandSuggest/MpBrandSuggest.jsx';

export function WbBrandSuggest(props) {
  return <MpBrandSuggest marketplace="wb" {...props} />;
}
