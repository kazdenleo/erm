/**
 * Вкладка «Экспресс»: тот же UI, что «Упаковка», но скан = приёмка + сборка + упаковка + этикетка.
 */

import React from 'react';
import { FboSupplyPacking } from './FboSupplyPacking.jsx';

export function FboSupplyExpress(props) {
  return <FboSupplyPacking {...props} mode="express" />;
}

export default FboSupplyExpress;
