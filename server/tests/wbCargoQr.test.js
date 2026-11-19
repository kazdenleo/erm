import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeWbCargoBoxNumber,
  decodeWbCargoTechCode,
  formatCargoBarcodeLabel,
  isWbCargoQrPayload,
  parseWbCargoQr,
  splitWbCargoBarcodeForExport,
} from '../src/utils/wbCargoQr.js';

describe('wbCargoQr', () => {
  const sample = '$Ts;EqN;yKGq;1;BJmumHmI;TAS';

  it('detects WB cargo QR payload', () => {
    assert.equal(isWbCargoQrPayload(sample), true);
    assert.equal(isWbCargoQrPayload('Ts;EqN;yKGq;1;BJmumHmI;TAS'), true);
    assert.equal(isWbCargoQrPayload('WB_48506'), false);
    assert.equal(isWbCargoQrPayload('13148586'), false);
  });

  it('parses sequential box number and tech code (not base64 guess)', () => {
    assert.deepEqual(parseWbCargoQr(sample), {
      boxNo: '1',
      tech: 'BJmumHmI',
      parts: ['$Ts', 'EqN', 'yKGq', '1', 'BJmumHmI', 'TAS'],
    });
    assert.equal(decodeWbCargoBoxNumber(sample), '1');
    assert.equal(decodeWbCargoTechCode(sample), 'BJmumHmI');
  });

  it('formats UI label as box № + tech code', () => {
    assert.equal(formatCargoBarcodeLabel(sample), '№ 1 · BJmumHmI');
    assert.equal(formatCargoBarcodeLabel('WB_48506'), 'WB_48506');
  });

  it('splits Excel columns: box number + print payload', () => {
    assert.deepEqual(splitWbCargoBarcodeForExport(sample), {
      boxId: '1',
      printPayload: sample,
    });
    assert.deepEqual(splitWbCargoBarcodeForExport('WB_48506'), {
      boxId: 'WB_48506',
      printPayload: 'WB_48506',
    });
  });
});
