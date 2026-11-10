import fs from 'fs';

const t = fs.readFileSync('/tmp/mm3.json', 'utf8');
const objs = [];
let depth = 0;
let start = -1;
for (let i = 0; i < t.length; i++) {
  const ch = t[i];
  if (ch === '{') {
    if (depth === 0) start = i;
    depth += 1;
  } else if (ch === '}') {
    depth -= 1;
    if (depth === 0 && start >= 0) {
      try {
        objs.push(JSON.parse(t.slice(start, i + 1)));
      } catch {
        /* ignore */
      }
      start = -1;
    }
  }
}

for (const j of objs) {
  if (j.code) {
    console.log(
      [
        j.code,
        j.sku,
        `claim=${j.claim}`,
        `wh6_on=${j.wh6?.on}`,
        `wh6_res=${j.wh6?.res}`,
        `wh6_free=${j.wh6?.free}`,
        `wh5_on=${j.wh5?.on}`,
        `fbo_need=${j.open_fbo_need}`,
        `on6-need=${j.system_on6_minus_fbo_need}`,
        `open_purch_pending=${j.open_purchase_pending}`,
        `kits=${(j.kits || []).join(',')}`,
        `purch=${JSON.stringify(j.purchases || [])}`,
        `inv=${JSON.stringify(j.inventory || [])}`,
      ].join(' | ')
    );
  } else if (j.kit) {
    console.log(`KIT ${j.kit} open=${j.open_fbo_kits} comps=${JSON.stringify(j.components)}`);
  }
}
