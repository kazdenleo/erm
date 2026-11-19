import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeWbCargoBoxNumber,
  decodeWbCargoTechCode,
  formatCargoBarcodeLabel,
  isWbCargoQrPayload,
  splitWbCargoBarcodeForExport,
} from '../src/utils/wbCargoQr.js';

describe('wbCargoQr', () => {
  const sample = '$Ts;EqN;yKGq;1;BJmumHmI;TAS';

  it('detects WB cargo QR payload', () => {
    assert.equal(isWbCargoQrPayload(sample), true);
    assert.equal(isWbCargoQrPayload('WB_48506'), false);
    assert.equal(isWbCargoQrPayload('13148586'), false);
  });

  it('decodes numeric box id from base64 segment', () => {
    assert.equal(decodeWbCargoBoxNumber(sample), '13148586');
    assert.equal(decodeWbCargoTechCode(sample), 'BJmumHmI');
  });

  it('formats UI label as box number', () => {
    assert.equal(formatCargoBarcodeLabel(sample), '13148586');
    assert.equal(formatCargoBarcodeLabel('WB_48506'), 'WB_48506');
  });

  it('splits Excel columns: number + print payload', () => {
    assert.deepEqual(splitWbCargoBarcodeForExport(sample), {
      boxId: '13148586',
      printPayload: sample,
    });
    assert.deepEqual(splitWbCargoBarcodeForExport('WB_48506'), {
      boxId: 'WB_48506',
      printPayload: 'WB_48506',
    });
  });
});
