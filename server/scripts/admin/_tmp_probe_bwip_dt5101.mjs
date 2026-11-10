import bwipjs from '@bwip-js/node';
import { writeFileSync } from 'fs';

for (const text of ['DT-5101', 'DTTG5101x2', '000051002', 'DT-100181']) {
  try {
    const buf = await bwipjs.toBuffer({
      bcid: 'code128',
      text,
      scale: 3,
      height: 12,
      includetext: false,
    });
    console.log(text, 'OK', buf.length);
    writeFileSync(`/tmp/bc_${text.replace(/[^a-zA-Z0-9]/g, '_')}.png`, buf);
  } catch (e) {
    console.log(text, 'FAIL', e.message);
  }
}
