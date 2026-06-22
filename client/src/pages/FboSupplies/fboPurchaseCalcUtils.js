/**
 * К закупке = max(0, сумма по поставкам − наличие − в пути)
 */

export function sumSupplyQty(supplyQty = {}) {
  return Object.values(supplyQty).reduce((s, v) => s + (Number(v) || 0), 0);
}

/** Сумма потребности в штуках комплектующего (не в комплектах). */
export function computeSupplyComponentQtyTotal(row) {
  const supplyQty = row.supplyQty || {};
  const supplyCells = row.supplyCells || {};
  let total = 0;
  for (const [supplyId, raw] of Object.entries(supplyQty)) {
    const cell = supplyCells[supplyId];
    if (cell?.isKitComponent) {
      const perKit = Math.max(1, Number(cell.perKit) || 1);
      const kitUnits = Number(cell.quantity) || 0;
      const componentFromKit = kitUnits * perKit;
      const stored = Number(raw) || 0;
      if (perKit > 1 && stored > 0 && stored === kitUnits) {
        total += componentFromKit;
      } else {
        total += stored > 0 ? stored : componentFromKit;
      }
    } else {
      total += Number(raw) || 0;
    }
  }
  return total;
}

export function recalcPurchaseRow(row) {
  if (row.rowType === 'kit' || row.isKitHeader) {
    const supplyQtyTotal = Object.values(row.supplyQty || {}).reduce(
      (s, v) => s + (Number(v) || 0),
      0
    );
    return {
      ...row,
      supplyQtyTotal,
      toPurchase: 0,
      lineCostTotal: 0,
    };
  }
  const supplyQty = { ...(row.supplyQty || {}) };
  const supplyQtyTotal = computeSupplyComponentQtyTotal({ ...row, supplyQty });
  const onHand = Number(row.onHand) || 0;
  const incoming = Number(row.incoming) || 0;
  const cost = Number(row.cost) || 0;
  const toPurchase = Math.max(0, supplyQtyTotal - onHand - incoming);
  const lineCostTotal = Math.round(toPurchase * cost * 100) / 100;
  return {
    ...row,
    supplyQty,
    supplyQtyTotal,
    toPurchase,
    lineCostTotal,
  };
}

export function recalcPurchaseRows(rows) {
  return rows.map(recalcPurchaseRow);
}

export function isPurchasablePurchaseRow(row) {
  return row?.rowType !== 'kit' && !row?.isKitHeader;
}

export function calcPurchaseTotals(rows) {
  return rows.filter(isPurchasablePurchaseRow).reduce(
    (acc, r) => {
      const rem = Number(r.remainingToPurchase ?? r.toPurchase) || 0;
      acc.toPurchaseQty += rem;
      acc.costSum += r.lineCostTotal || 0;
      if (r.purchasedQty != null) acc.purchasedQty += Number(r.purchasedQty) || 0;
      return acc;
    },
    { toPurchaseQty: 0, costSum: 0, purchasedQty: 0 }
  );
}

/** После пересчёта потребности сохранить прогресс закупок по сессии. */
export function mergePurchasedProgress(rows, prevRows = []) {
  const purchasedByKey = new Map(
    (prevRows || []).map((r) => [r.key, Math.max(0, Number(r.purchasedQty) || 0)])
  );
  return rows.map((row) => {
    if (!isPurchasablePurchaseRow(row)) {
      return {
        ...row,
        purchasedQty: 0,
        remainingToPurchase: 0,
        lineCostTotal: 0,
        purchaseComplete: true,
      };
    }
    const purchasedQty = Math.max(
      0,
      Number(purchasedByKey.get(row.key) ?? row.purchasedQty) || 0
    );
    const needQty = Math.max(0, Number(row.toPurchase) || 0);
    const remainingToPurchase = Math.max(0, needQty - purchasedQty);
    const cost = Number(row.cost) || 0;
    return {
      ...row,
      purchasedQty,
      remainingToPurchase,
      lineCostTotal: Math.round(remainingToPurchase * cost * 100) / 100,
      purchaseComplete: needQty === 0 || remainingToPurchase === 0,
    };
  });
}

function groupPurchaseComplete(group) {
  if (group.header) {
    return (group.components || []).every(
      (r) => r.purchaseComplete ?? (Number(r.toPurchase) || 0) === 0
    );
  }
  const row = group.components?.[0];
  return row ? row.purchaseComplete ?? (Number(row.toPurchase) || 0) === 0 : true;
}

export function sortPurchaseRowsWithProgress(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (row.rowType === 'kit' || row.isKitHeader) {
      current = { header: row, components: [] };
      groups.push(current);
      continue;
    }
    if (row.rowType === 'component' && current) {
      current.components.push(row);
      continue;
    }
    current = null;
    groups.push({ header: null, components: [row] });
  }

  groups.sort((a, b) => {
    const aDone = groupPurchaseComplete(a);
    const bDone = groupPurchaseComplete(b);
    if (aDone !== bDone) return aDone ? 1 : -1;
    const aName = a.header?.productName || a.components[0]?.productName || '';
    const bName = b.header?.productName || b.components[0]?.productName || '';
    return String(aName).localeCompare(String(bName), 'ru');
  });

  const out = [];
  for (const g of groups) {
    if (g.header) out.push(g.header);
    out.push(...g.components);
  }
  return out;
}

/** Количество комплектов в поставке по введённому количеству комплектующего. */
export function componentQtyToKitUnits(componentQty, perKit) {
  const per = Math.max(1, Number(perKit) || 1);
  const q = Math.max(0, Number(componentQty) || 0);
  if (q === 0) return 0;
  return Math.ceil(q / per);
}

export function kitUnitsToComponentQty(kitQty, perKit) {
  return Math.max(0, Number(kitQty) || 0) * Math.max(1, Number(perKit) || 1);
}

export function getPurchaseRowDisplayName(row) {
  const raw = String(row?.productName ?? '').trim();
  if (!raw) return '—';
  const first = raw.split(/\r?\n/)[0].trim() || '—';
  if (row?.rowType === 'kit' || row?.isKitHeader) {
    return first;
  }
  if (row?.rowType === 'component') {
    return first;
  }
  return first;
}

export function sortPurchaseRows(rows) {
  return [...rows].sort((a, b) => {
    const aDone = a.toPurchase === 0;
    const bDone = b.toPurchase === 0;
    if (aDone !== bDone) return aDone ? 1 : -1;
    return String(a.productName || a.sku || '').localeCompare(
      String(b.productName || b.sku || ''),
      'ru'
    );
  });
}
