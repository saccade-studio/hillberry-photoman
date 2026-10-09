import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadCore } from '../tools/load-core.mjs';
const HB = loadCore();
const SP = process.argv[2];
let bad = 0;
const check = (c, m) => { if (!c) { bad++; console.log('  FAIL:', m); } };

// ---- 1. FDCT vs brute-force orthonormal DCT-II (JPEG normalisation)
{
  const E = HB.jpegEnc;
  const q1 = new Int32Array(64).fill(1);
  const recip = E.reciprocals(q1);
  let maxErr = 0;
  for (let trial = 0; trial < 200; trial++) {
    const f = new Float64Array(64);
    for (let i = 0; i < 64; i++) f[i] = (trial % 3 === 0 ? (Math.random() * 256 - 128) : Math.round(Math.random() * 255) - 128);
    const ref = new Float64Array(64);
    for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) s += f[y * 8 + x] * Math.cos((2 * x + 1) * v * Math.PI / 16) * Math.cos((2 * y + 1) * u * Math.PI / 16);
      const cu = u === 0 ? Math.SQRT1_2 : 1, cv = v === 0 ? Math.SQRT1_2 : 1;
      ref[u * 8 + v] = 0.25 * cu * cv * s;
    }
    const d = Float64Array.from(f);
    E.fdct(d);
    for (let i = 0; i < 64; i++) maxErr = Math.max(maxErr, Math.abs(d[i] * recip[i] - ref[i]));
  }
  console.log('FDCT max abs error vs brute force:', maxErr.toExponential(2));
  check(maxErr < 1e-9, 'FDCT must match the reference DCT');
}

// ---- 2. constants vs libjpeg: pull DQT/DHT out of a real cjpeg file
function segments(buf) {
  const out = []; let p = 2;
  while (p < buf.length) {
    if (buf[p] !== 0xFF) { p++; continue; }
    const m = buf[p + 1]; p += 2;
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) continue;
    const len = (buf[p] << 8) | buf[p + 1];
    out.push({ m, data: buf.subarray(p + 2, p + len) });
    if (m === 0xDA) break;
    p += len;
  }
  return out;
}
{
  const ppm = SP + '/corpus/src_64x48.ppm';
  for (const q of [100, 90, 75, 50, 20]) {
    const jpg = `${SP}/ref_q${q}.jpg`;
    execFileSync('cjpeg', ['-baseline', '-quality', String(q), '-sample', '2x2', '-outfile', jpg, ppm]);
    const segs = segments(new Uint8Array(fs.readFileSync(jpg)));
    const dqts = segs.filter((s) => s.m === 0xDB).flatMap((s) => {
      const r = []; for (let o = 0; o < s.data.length; o += 65) r.push({ id: s.data[o] & 15, t: s.data.subarray(o + 1, o + 65) }); return r;
    });
    const lum = HB.jpegEnc.scaledQuant(HB.jpegEnc.STD.STD_LUM_Q, q), chr = HB.jpegEnc.scaledQuant(HB.jpegEnc.STD.STD_CHR_Q, q);
    for (const d of dqts) {
      const mine = d.id === 0 ? lum : chr;
      let same = true;
      for (let i = 0; i < 64; i++) if (d.t[i] !== mine[HB.jpeg.ZZ[i]]) same = false;
      check(same, `quant table ${d.id} at q=${q} must equal libjpeg's`);
    }
  }
  console.log('quantisation tables match libjpeg at q = 100, 90, 75, 50, 20');
  const jpg = SP + '/ref_q75.jpg';
  const segs = segments(new Uint8Array(fs.readFileSync(jpg)));
  const S = HB.jpegEnc.STD;
  const want = { '0:0': S.STD_DC_LUM, '1:0': S.STD_AC_LUM, '0:1': S.STD_DC_CHR, '1:1': S.STD_AC_CHR };
  let seen = 0;
  for (const s of segs.filter((x) => x.m === 0xC4)) {
    let o = 0;
    while (o < s.data.length) {
      const tc = s.data[o] >> 4, th = s.data[o] & 15; o++;
      const counts = Array.from(s.data.subarray(o, o + 16)); o += 16;
      const n = counts.reduce((a, b) => a + b, 0);
      const vals = Array.from(s.data.subarray(o, o + n)); o += n;
      const mine = want[tc + ':' + th];
      check(JSON.stringify(counts) === JSON.stringify(mine.counts) && JSON.stringify(vals) === JSON.stringify(mine.vals), `Huffman table ${tc}:${th} must equal libjpeg's standard table`);
      seen++;
    }
  }
  check(seen === 4, 'found 4 DHT tables');
  console.log('standard Huffman tables match libjpeg (' + seen + ' tables)');
}
console.log(bad ? `${bad} FAILURE(S)` : 'encoder unit checks passed');
process.exit(bad ? 1 : 0);
