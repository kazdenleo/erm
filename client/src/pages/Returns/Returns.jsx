/**
 * Возвраты с маркетплейсов — редирект в раздел «Склад → Возвраты».
 */

import { Navigate } from 'react-router-dom';

export function Returns() {
  return <Navigate to="/stock-levels/warehouse?op=return_customer" replace />;
}

/** @deprecated используйте Returns */
export { Returns as WbReturns };
