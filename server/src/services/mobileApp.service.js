/**
 * Мобильное приложение (APK): метаданные, скачивание, QR.
 * Файлы: data/mobile-app/latest.apk + meta.json
 */

import fs from 'fs';
import { join } from 'path';
import bwipjs from 'bwip-js';
import { DATA_DIR } from '../utils/storage.js';

const APP_DIR = join(DATA_DIR, 'mobile-app');
const APK_PATH = join(APP_DIR, 'latest.apk');
const META_PATH = join(APP_DIR, 'meta.json');

function readMetaFile() {
  try {
    if (!fs.existsSync(META_PATH)) return null;
    // PowerShell UTF-8 часто пишет BOM — снимаем перед parse.
    const text = fs.readFileSync(META_PATH, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

export function ensureAppDir() {
  if (!fs.existsSync(APP_DIR)) fs.mkdirSync(APP_DIR, { recursive: true });
  return APP_DIR;
}

export function getApkPath() {
  return APK_PATH;
}

export function apkAvailable() {
  try {
    return fs.existsSync(APK_PATH) && fs.statSync(APK_PATH).isFile() && fs.statSync(APK_PATH).size > 0;
  } catch {
    return false;
  }
}

/** Публичный origin из запроса (за прокси). */
export function publicOriginFromReq(req) {
  const xfProto = String(req.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim();
  const proto = xfProto || req.protocol || 'https';
  const xfHost = String(req.get('x-forwarded-host') || '')
    .split(',')[0]
    .trim();
  const host = xfHost || req.get('host') || 'localhost';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

export function getReleaseInfo(req) {
  const available = apkAvailable();
  const meta = readMetaFile() || {};
  const origin = publicOriginFromReq(req);
  const downloadPath = '/api/mobile-app/download';
  const qrPath = '/api/mobile-app/qr.png';
  let sizeBytes = null;
  if (available) {
    try {
      sizeBytes = fs.statSync(APK_PATH).size;
    } catch {
      sizeBytes = null;
    }
  }
  return {
    available,
    name: 'ERM Склад',
    version: meta.version != null ? String(meta.version) : null,
    versionCode: meta.versionCode != null ? Number(meta.versionCode) : null,
    updatedAt: meta.updatedAt || null,
    sizeBytes,
    downloadUrl: `${origin}${downloadPath}`,
    qrUrl: `${origin}${qrPath}`,
    downloadPath,
    qrPath,
  };
}

export async function buildQrPng(downloadUrl) {
  const text = String(downloadUrl || '').trim();
  if (!text) {
    const err = new Error('Нет URL для QR');
    err.statusCode = 400;
    throw err;
  }
  return bwipjs.toBuffer({
    bcid: 'qrcode',
    text,
    scale: 6,
    includetext: false,
    eclevel: 'M',
    paddingwidth: 12,
    paddingheight: 12,
    backgroundcolor: 'FFFFFF',
  });
}

/** Записать meta после размещения APK (скрипт/деплой). */
export function writeMeta({ version, versionCode, updatedAt = new Date().toISOString() } = {}) {
  ensureAppDir();
  const payload = {
    version: version != null ? String(version) : null,
    versionCode: versionCode != null ? Number(versionCode) : null,
    updatedAt,
    fileName: 'latest.apk',
  };
  fs.writeFileSync(META_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export default {
  ensureAppDir,
  getApkPath,
  apkAvailable,
  publicOriginFromReq,
  getReleaseInfo,
  buildQrPng,
  writeMeta,
};
