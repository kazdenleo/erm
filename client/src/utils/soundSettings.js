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
    return {
      ...def,
      ...parsed,
      custom: { ...def.custom, ...(parsed.custom || {}) },
    };
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

function ensureAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  // singleton per tab
  if (!window.__ermAudioCtx) window.__ermAudioCtx = new Ctx();
  return window.__ermAudioCtx;
}

function playBeepPattern(pattern) {
  const ctx = ensureAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.connect(ctx.destination);

  // быстрый "пик" без клика
  const beep = (t, dur, freq) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  };

  for (const p of pattern) {
    beep(now + p.at, p.dur, p.freq);
  }

  // авто-стоп мастера
  const end = Math.max(...pattern.map((p) => p.at + p.dur)) + 0.1;
  master.gain.exponentialRampToValueAtTime(0.0001, now + end);
  setTimeout(() => {
    try {
      master.disconnect();
    } catch {}
  }, Math.ceil((end + 0.2) * 1000));
}

export function playBuiltinSound(id) {
  if (id === 'beep_1') {
    playBeepPattern([{ at: 0.0, dur: 0.08, freq: 880 }]);
    return;
  }
  if (id === 'beep_2') {
    playBeepPattern([
      { at: 0.0, dur: 0.07, freq: 660 },
      { at: 0.11, dur: 0.07, freq: 880 },
    ]);
    return;
  }
  // beep_3
  playBeepPattern([
    { at: 0.0, dur: 0.06, freq: 660 },
    { at: 0.09, dur: 0.06, freq: 740 },
    { at: 0.18, dur: 0.06, freq: 880 },
  ]);
}

export function playEventSound(eventKey) {
  const cfg = loadSoundSettings();
  const sel = cfg?.[eventKey];
  if (!sel || sel.kind === 'none') return;

  if (sel.kind === 'custom') {
    const dataUrl = cfg?.custom?.[eventKey];
    if (!dataUrl) return;
    try {
      const a = new Audio(dataUrl);
      a.volume = 1.0;
      void a.play();
    } catch {
      // ignore
    }
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

