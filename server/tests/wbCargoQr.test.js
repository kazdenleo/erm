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
  // Реальный скан с этикетки WB; номер в ЛК — 15655909
  const sample = '$Ts;DJU;m5mZ;1;7uPlJPl;TAS';
  const sampleNoTas = '$Ts;DJU;m5mZ;1;7uPlJPl';

  it('detects WB cargo QR payload (with or without TAS)', () => {
    assert.equal(isWbCargoQrPayload(sample), true);
    assert.equal(isWbCargoQrPayload(sampleNoTas), true);
    assert.equal(isWbCargoQrPayload('WB_48506'), false);
  });

  it('decodes box number from tech-code segment (matches WB portal list)', () => {
    assert.equal(decodeWbCargoTechCode(sample), '7uPlJPl');
    assert.equal(decodeWbCargoBoxNumber(sample), '15655909');
    assert.equal(decodeWbCargoBoxNumber(sampleNoTas), '15655909');
    // старый ошибочный сегмент m5mZ давал 10197401 — больше не используем
    assert.notEqual(decodeWbCargoBoxNumber(sample), '10197401');
  });

  it('formats UI label as WB portal box number', () => {
    assert.equal(formatCargoBarcodeLabel(sample), '15655909');
    assert.equal(formatCargoBarcodeLabel('WB_48506'), 'WB_48506');
    // Старый/чужой техкод BJm* — номер портала не извлекается
    assert.equal(formatCargoBarcodeLabel('$Ts;EqN;yKGq;1;BJmumHml;TAS'), 'BJmumHml');
  });

  it('normalizes doubled QR scan', async () => {
    const { normalizeWbCargoQrPayload } = await import('../src/utils/wbCargoQr.js');
    const doubled = `${sample}${sample}`;
    assert.equal(normalizeWbCargoQrPayload(doubled), sample);
  });

  it('splits Excel columns: box number + print payload', () => {
    assert.deepEqual(splitWbCargoBarcodeForExport(sample), {
      boxId: '15655909',
      printPayload: sample,
    });
  });
});
