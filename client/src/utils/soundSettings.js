const STORAGE_KEY = 'erm_sound_settings_v1';

export const SOUND_EVENTS = {
  scan_ok: 'scan_ok',
  scan_error: 'scan_error',
  new_order: 'new_order',
};

export const BUILTIN_SOUNDS = [
  { id: 'beep_1', label: 'Пик (короткий)' },
  { id: 'beep_2', label: 'Двойной пик' },
  { id: 'beep_3', label: 'Тройной пик' },
];

export function getDefaultSoundSettings() {
  return {
    enabled: true,
    [SOUND_EVENTS.scan_ok]: { kind: 'builtin', id: 'beep_1' },
    [SOUND_EVENTS.scan_error]: { kind: 'builtin', id: 'beep_2' },
    [SOUND_EVENTS.new_order]: { kind: 'builtin', id: 'beep_3' },
    custom: {
      [SOUND_EVENTS.scan_ok]: null,
      [SOUND_EVENTS.scan_error]: null,
      [SOUND_EVENTS.new_order]: null,
    },
  };
}

export function loadSoundSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultSoundSettings();
    const parsed = JSON.parse(raw);
    const def = getDefaultSoundSettings();
    const merged = {
      ...def,
      ...parsed,
      custom: { ...def.custom, ...(parsed.custom || {}) },
    };
    // миграция: раньше custom[event] был строкой dataUrl
    for (const k of Object.values(SOUND_EVENTS)) {
      const v = merged.custom?.[k];
      if (typeof v === 'string' && v.trim()) {
        merged.custom[k] = { dataUrl: v, name: 'загруженный файл' };
      }
    }
    return merged;
  } catch {
    return getDefaultSoundSettings();
  }
}

export function saveSoundSettings(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function playAudioDataUrl(dataUrl) {
  try {
    const a = new Audio(String(dataUrl || ''));
    a.volume = 1.0;
    void a.play().catch(() => {});
  } catch {
    // ignore
  }
}

function wavDataUrlFromPattern(pattern, { sampleRate = 44100 } = {}) {
  // pattern: [{ at: seconds, dur: seconds, freq: Hz }]
  const totalSec = Math.max(...pattern.map((p) => p.at + p.dur)) + 0.12;
  const totalSamples = Math.max(1, Math.ceil(totalSec * sampleRate));
  const pcm = new Int16Array(totalSamples);

  const writeTone = (startS, durS, freq) => {
    const start = Math.max(0, Math.floor(startS * sampleRate));
    const end = Math.min(totalSamples, Math.ceil((startS + durS) * sampleRate));
    const fade = Math.max(1, Math.floor(sampleRate * 0.006));
    for (let i = start; i < end; i++) {
      const t = (i - start) / sampleRate;
      const s = Math.sin(2 * Math.PI * freq * t);
      // simple fade in/out to avoid click
      const rel = i - start;
      const relEnd = end - i;
      const f = Math.min(1, rel / fade, relEnd / fade);
      const amp = 0.35 * f;
      const v = Math.max(-1, Math.min(1, s * amp));
      const x = (v * 32767) | 0;
      // mix (clamp)
      const mixed = pcm[i] + x;
      pcm[i] = mixed > 32767 ? 32767 : mixed < -32768 ? -32768 : mixed;
    }
  };

  for (const p of pattern) writeTone(p.at, p.dur, p.freq);

  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let off = 0;

  const w4 = (s) => {
    for (let i = 0; i < 4; i++) view.setUint8(off + i, s.charCodeAt(i));
    off += 4;
  };
  const w2 = (v) => { view.setUint16(off, v, true); off += 2; };
  const w4u = (v) => { view.setUint32(off, v, true); off += 4; };

  w4('RIFF');
  w4u(36 + dataSize);
  w4('WAVE');
  w4('fmt ');
  w4u(16); // PCM
  w2(1); // PCM
  w2(numChannels);
  w4u(sampleRate);
  w4u(byteRate);
  w2(blockAlign);
  w2(bitsPerSample);
  w4('data');
  w4u(dataSize);

  for (let i = 0; i < pcm.length; i++, off += 2) {
    view.setInt16(off, pcm[i], true);
  }

  // base64
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return `data:audio/wav;base64,${b64}`;
}

function builtinWav(id) {
  if (!window.__ermBuiltinWav) window.__ermBuiltinWav = {};
  const cache = window.__ermBuiltinWav;
  if (cache[id]) return cache[id];
  const mk = (pattern) => wavDataUrlFromPattern(pattern);
  if (id === 'beep_1') cache[id] = mk([{ at: 0.0, dur: 0.09, freq: 880 }]);
  else if (id === 'beep_2') cache[id] = mk([{ at: 0.0, dur: 0.08, freq: 660 }, { at: 0.12, dur: 0.08, freq: 880 }]);
  else cache[id] = mk([{ at: 0.0, dur: 0.07, freq: 660 }, { at: 0.10, dur: 0.07, freq: 740 }, { at: 0.20, dur: 0.08, freq: 880 }]);
  return cache[id];
}

// Встроенные звуки проигрываются как WAV через Audio().

// playBeepPattern оставляли как fallback для отладки, но в проде используем Audio(dataUrl).

export function playBuiltinSound(id) {
  // Надёжнее через Audio(dataUrl), чем Oscillator (в Chrome бывают "тихие" случаи).
  playAudioDataUrl(builtinWav(id || 'beep_1'));
}

export function playEventSound(eventKey) {
  const cfg = loadSoundSettings();
  if (cfg?.enabled === false) return;
  const sel = cfg?.[eventKey];
  if (!sel || sel.kind === 'none') return;

  if (sel.kind === 'custom') {
    const rec = cfg?.custom?.[eventKey];
    const dataUrl = typeof rec === 'string' ? rec : rec?.dataUrl;
    if (!dataUrl) return;
    playAudioDataUrl(dataUrl);
    return;
  }

  playBuiltinSound(sel.id || 'beep_1');
}

export async function readAudioFileAsDataUrl(file) {
  if (!file) return null;
  const maxBytes = 600 * 1024; // короткие звуки, чтобы не раздувать localStorage
  if (file.size > maxBytes) {
    throw new Error('Файл слишком большой. Загрузите короткий звук до 600 КБ.');
  }
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Не удалось прочитать файл'));
    fr.onload = () => resolve(String(fr.result || ''));
    fr.readAsDataURL(file);
  });
}

