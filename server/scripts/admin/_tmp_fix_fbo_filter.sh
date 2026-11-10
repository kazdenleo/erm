#!/bin/bash
set -e
cd /opt/erm

echo "=== prod FboSupplies dir ==="
ls client/src/pages/FboSupplies/ | head -40

echo "=== reserve file ==="
if [ -f client/src/pages/FboSupplies/fboSupplyItemReserve.js ]; then
  grep -n "export function" client/src/pages/FboSupplies/fboSupplyItemReserve.js || true
else
  echo "MISSING fboSupplyItemReserve.js"
fi

echo "=== current defaults ==="
grep -n "FBO_LIST_DEFAULT\|packed\|collecting" client/src/pages/FboSupplies/FboSupplies.jsx | head -20

echo "=== git status client FBO ==="
cd /opt/erm && git status --short client/src/pages/FboSupplies/FboSupplies.jsx client/src/constants/fboSupplyStatuses.js 2>/dev/null || true
