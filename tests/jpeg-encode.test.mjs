import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadCore } from '../tools/load-core.mjs';
import { readPNM } from './pnm.mjs';
const HB = loadCore();
const SP = process.argv[2];
let bad = 0;

function psnr(a, b) {
  let se = 0, max = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; if (Math.abs(d) > max) max = Math.abs(d); }
  const mse = se / a.length;
  return { psnr: mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse), max };
}
function myEncode(img, o) {
  return HB.jpegEnc.encode(Object.assign({
    width: img.width, height: img.height,
    getRows(y0, n, out) { out.set(img.data.subarray(y0 * img.width * 3, (y0 + n) * img.width * 3)); },
  }, o));
}
function viaDjpeg(bytes, tag) {
  const j = `${SP}/tmp_${tag}.jpg`, p = `${SP}/tmp_${tag}.ppm`;
  fs.writeFileSync(j, bytes);
  execFileSync('djpeg', ['-ppm', '-outfile', p, j]);
  return readPNM(p);
}

const sizes = ['64x48', '255x129', '640x480', '1001x777', '17x33', '7x5', '1x1', '16x16'];
const configs = [
  { name: 'q100 4:4:4 optimized', o: { quality: 100, subsampling: '444', optimize: true }, c: ['-quality', '100', '-sample', '1x1', '-optimize'] },
  { name: 'q100 4:4:4 std tables', o: { quality: 100, subsampling: '444', optimize: false }, c: ['-quality', '100', '-sample', '1x1'] },
  { name: 'q90  4:2:0 optimized', o: { quality: 90, subsampling: '420', optimize: true }, c: ['-quality', '90', '-sample', '2x2', '-optimize'] },
  { name: 'q75  4:2:0 std tables', o: { quality: 75, subsampling: '420', optimize: false }, c: ['-quality', '75', '-sample', '2x2'] },
];
console.log('config                     size        mine PSNR / maxErr     cjpeg PSNR / maxErr    bytes mine vs cjpeg');
for (const cfg of configs) {
  for (const sz of ['255x129', '640x480', '1001x777']) {
    const src = readPNM(`${SP}/corpus/src_${sz}.ppm`);
    const mine = myEncode(src, cfg.o);
    const dm = viaDjpeg(mine, 'mine');
    const cj = `${SP}/tmp_c.jpg`;
    execFileSync('cjpeg', [...cfg.c, '-outfile', cj, `${SP}/corpus/src_${sz}.ppm`]);
    const cbytes = new Uint8Array(fs.readFileSync(cj));
    const dc = viaDjpeg(cbytes, 'c');
    const a = psnr(src.data, dm.data), b = psnr(src.data, dc.data);
    // my decoder must agree with djpeg on my own output (also validates my optimised tables)
    const mydec = HB.jpeg.decode(mine);
    let same = mydec.rgb.length === dm.data.length;
    for (let i = 0; same && i < dm.data.length; i++) if (mydec.rgb[i] !== dm.data[i]) same = false;
    if (!same) { bad++; console.log('  FAIL: my decoder disagrees with djpeg on my output'); }
    console.log(`${cfg.name.padEnd(26)} ${sz.padEnd(10)}  ${a.psnr.toFixed(2).padStart(6)} dB / ${String(a.max).padStart(2)}      ${b.psnr.toFixed(2).padStart(6)} dB / ${String(b.max).padStart(2)}      ${String(mine.length).padStart(7)} vs ${String(cbytes.length).padStart(7)}  (${(100 * mine.length / cbytes.length).toFixed(1)}%)`);
    if (a.psnr < b.psnr - 0.5) { bad++; console.log('  FAIL: quality below libjpeg'); }
  }
}
// edge dimensions: every size must produce a file libjpeg decodes to the right dimensions, at least as good as cjpeg
for (const sz of sizes) {
  const src = readPNM(`${SP}/corpus/src_${sz}.ppm`);
  for (const [sub, sample] of [['444', '1x1'], ['420', '2x2']]) {
    const j = myEncode(src, { quality: 95, subsampling: sub, optimize: true });
    const d = viaDjpeg(j, 'edge');
    execFileSync('cjpeg', ['-quality', '95', '-sample', sample, '-optimize', '-outfile', `${SP}/tmp_e.jpg`, `${SP}/corpus/src_${sz}.ppm`]);
    const c = viaDjpeg(new Uint8Array(fs.readFileSync(`${SP}/tmp_e.jpg`)), 'edgec');
    const r = psnr(src.data, d.data), rc = psnr(src.data, c.data);
    if (d.width !== src.width || d.height !== src.height) { bad++; console.log('  FAIL: dims', sz, sub); }
    else if (r.psnr < rc.psnr - 0.3) { bad++; console.log('  FAIL: worse than cjpeg for', sz, sub, r.psnr, rc.psnr); }
  }
}
console.log('edge sizes (1x1 ... 1001x777) decode correctly via libjpeg for 4:4:4 and 4:2:0');
console.log(bad ? `${bad} FAILURE(S)` : 'JPEG encoder: all checks passed');
process.exit(bad ? 1 : 0);
