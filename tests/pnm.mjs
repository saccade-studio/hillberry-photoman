import fs from 'node:fs';
// Minimal PPM(P6)/PGM(P5) reader -> {width,height,channels,data}
export function readPNM(path) {
  const b = fs.readFileSync(path);
  let p = 0;
  const tok = () => {
    while (b[p] === 0x20 || b[p] === 0x0a || b[p] === 0x0d || b[p] === 0x09) p++;
    if (b[p] === 0x23) { while (b[p] !== 0x0a) p++; return tok(); }
    let s = '';
    while (!(b[p] === 0x20 || b[p] === 0x0a || b[p] === 0x0d || b[p] === 0x09)) s += String.fromCharCode(b[p++]);
    return s;
  };
  const magic = tok(), w = +tok(), h = +tok(); tok(); p++;
  const channels = magic === 'P6' ? 3 : 1;
  return { width: w, height: h, channels, data: new Uint8Array(b.buffer, b.byteOffset + p, w * h * channels) };
}
