import React from 'react';

export function AmountCell({ value, format, tooltip, className = 'sales-analytics__num' }) {
  const formatted = format(value);
  if (!tooltip) {
    return <td className={className}>{formatted}</td>;
  }
  return (
    <td className={`${className} sales-analytics__num--hint`} title={tooltip}>
      {formatted}
    </td>
  );
}

export function otherDeductionsTotal(row) {
  return (row.penaltyAmount || 0) + (row.acquiringAmount || 0) + (row.otherDeductions || 0);
}
