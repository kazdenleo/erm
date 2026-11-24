/**
 * Векторный линейный ШК в PDF (pdf-lib).
 * Растр при печати через Sumatra/драйвер размывает модули — лазер молчит, телефон ещё читает.
 * Прямоугольники в PDF растеризуются уже на DPI принтера с целыми точками.
 */

import bwipjs from 'bwip-js';
import { rgb } from 'pdf-lib';

const PT_PER_MM = 72 / 25.4;

/** Целевой модуль ~0.5 мм (4 точки @ 203 dpi); не ниже 0.375 мм. */
const TARGET_MODULE_MM = 0.5;
const MIN_MODULE_MM = 0.375;
const QUIET_MODULES = 10;

/**
 * @param {import('pdf-lib').PDFPage} page
 * @param {{ text: string, xPt: number, yPt: number, widthPt: number, heightPt: number }} box
 *   xPt/yPt — левый нижний угол области ШК в координатах PDF; heightPt — высота полосок.
 */
export function drawVectorLinearBarcode(page, box) {
  const text = String(box?.text || '').trim();
  if (!text || !page) return false;

  const widthPt = Math.max(1, Number(box.widthPt) || 0);
  const heightPt = Math.max(1, Number(box.heightPt) || 0);
  const x0 = Number(box.xPt) || 0;
  const y0 = Number(box.yPt) || 0;

  let sbs = null;
  for (const bcid of ['code128', 'code39']) {
    try {
      const payload =
        bcid === 'code39'
          ? text.toUpperCase().replace(/[^0-9A-Z\-.$\/+%\s]/g, '')
          : text;
      if (!payload) continue;
      const raw = bwipjs.raw({ bcid, text: payload });
      const row = Array.isArray(raw) ? raw[0] : raw;
      if (row?.sbs?.length) {
        sbs = row.sbs;
        break;
      }
    } catch {
      /* next symbology */
    }
  }
  if (!sbs?.length) return false;

  const symbolModules = sbs.reduce((a, b) => a + Number(b) || 0, 0);
  const totalModules = symbolModules + QUIET_MODULES * 2;
  if (totalModules <= 0) return false;

  let modulePt = TARGET_MODULE_MM * PT_PER_MM;
  const minModulePt = MIN_MODULE_MM * PT_PER_MM;
  if (totalModules * modulePt > widthPt) {
    modulePt = widthPt / totalModules;
  }
  if (modulePt < minModulePt * 0.98) {
    // Всё равно рисуем равномерно — лучше чуть тоньше, чем разные доли после fit.
    modulePt = Math.max(widthPt / totalModules, minModulePt * 0.85);
  }

  const usedWidth = totalModules * modulePt;
  let x = x0 + Math.max(0, (widthPt - usedWidth) / 2) + QUIET_MODULES * modulePt;

  // Белый фон под ШК (перекрывает растр/дыры)
  page.drawRectangle({
    x: x0,
    y: y0,
    width: widthPt,
    height: heightPt,
    color: rgb(1, 1, 1),
    borderWidth: 0,
  });

  let isBar = true;
  for (const w of sbs) {
    const wPt = Number(w) * modulePt;
    if (wPt <= 0) {
      isBar = !isBar;
      continue;
    }
    if (isBar) {
      page.drawRectangle({
        x,
        y: y0,
        width: wPt,
        height: heightPt,
        color: rgb(0, 0, 0),
        borderWidth: 0,
      });
    }
    x += wPt;
    isBar = !isBar;
  }
  return true;
}

/**
 * Пиксели этикетки (origin top-left) → PDF (origin bottom-left), мм→pt.
 */
export function barcodePlacementToPdfBox(placement, pageHeightPt) {
  const mmToPx = Number(placement.mmToPx) || 8;
  const xPt = (Number(placement.xPx) / mmToPx) * PT_PER_MM;
  const wPt = (Number(placement.wPx) / mmToPx) * PT_PER_MM;
  const hPt = (Number(placement.hPx) / mmToPx) * PT_PER_MM;
  const topPt = (Number(placement.yPx) / mmToPx) * PT_PER_MM;
  const yPt = pageHeightPt - topPt - hPt;
  return {
    text: placement.text,
    xPt,
    yPt,
    widthPt: wPt,
    heightPt: hPt,
  };
}
