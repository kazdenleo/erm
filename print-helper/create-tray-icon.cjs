/**
 * Создаёт минимальную иконку 16x16 для трея (assets/tray.ico).
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'assets');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'tray.ico');

// ICO: заголовок 6 + запись 16 + BITMAPINFOHEADER 40 + 16*16*4 = 1086 байт
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const size = 40 + 16 * 16 * 4;
const entry = Buffer.alloc(16);
entry[0] = 16;
entry[1] = 16;
entry[2] = 0;
entry[3] = 0;
entry[4] = 1;
entry[5] = 0;
entry[6] = 32;
entry[7] = 0;
entry.writeUInt32LE(size, 8);
entry.writeUInt32LE(22, 12);

const dib = Buffer.alloc(40);
dib.writeUInt32LE(40, 0);
dib.writeInt32LE(16, 4);
dib.writeInt32LE(32, 8);
dib.writeUInt16LE(1, 12);
dib.writeUInt16LE(32, 14);

const pixels = Buffer.alloc(16 * 16 * 4);
for (let i = 0; i < 16 * 16 * 4; i += 4) {
  pixels[i] = 0x4a;
  pixels[i + 1] = 0x90;
  pixels[i + 2] = 0xe8;
  pixels[i + 3] = 255;
}

const ico = Buffer.concat([header, entry, dib, pixels]);
fs.writeFileSync(out, ico);
console.log('Создан', out);
