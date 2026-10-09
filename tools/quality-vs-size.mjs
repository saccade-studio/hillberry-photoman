import fs from 'node:fs';
import { loadCore } from './load-core.mjs';
const HB = loadCore();
const file = process.argv[2];
const bytes = new Uint8Array(fs.readFileSync(file));
const src = HB.jpeg.decode(bytes);
const W = 3000, H = 3000, x0 = 1500, y0 = 1500;            // 9 MP centre crop keeps the run short
const crop = new Uint8Array(W * H * 3);
for (let y = 0; y < H; y++) crop.set(src.rgb.subarray(((y0 + y) * src.width + x0) * 3, ((y0 + y) * src.width + x0 + W) * 3), y * W * 3);
console.log(`source ${(bytes.length / 1e6).toFixed(1)} MB for ${src.width}x${src.height} (${(bytes.length * 8 / (src.width * src.height)).toFixed(2)} bits/px); test crop ${W}x${H}`);
console.log('quality chroma  size(MB)  bits/px   vs source JPEG size   PSNR(dB)  maxErr');
const base = bytes.length * (W * H) / (src.width * src.height);
for (const [q, ch] of [[100, '444'], [98, '444'], [95, '444'], [92, '444'], [90, '444'], [100, '420'], [95, '420']]) {
  const out = HB.jpegEnc.encode({ width: W, height: H, quality: q, subsampling: ch, optimize: true, getRows(y, n, o) { o.set(crop.subarray(y * W * 3, (y + n) * W * 3)); } });
  const dec = HB.jpeg.decode(out);
  let se = 0, mx = 0;
  for (let i = 0; i < crop.length; i++) { const d = crop[i] - dec.rgb[i]; se += d * d; if (Math.abs(d) > mx) mx = Math.abs(d); }
  const psnr = 10 * Math.log10(255 * 255 / (se / crop.length));
  console.log(`${String(q).padStart(5)}   ${ch}    ${(out.length / 1e6).toFixed(2).padStart(6)}   ${(out.length * 8 / (W * H)).toFixed(2).padStart(6)}      ${(out.length / base).toFixed(2).padStart(5)}x            ${psnr.toFixed(1).padStart(6)}   ${mx}`);
}
