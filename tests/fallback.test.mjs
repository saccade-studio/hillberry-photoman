// Files we can't pass through directly must be detected and routed to the browser's decoder, never mangled.
import fs from 'node:fs';
import { loadCore } from '../tools/load-core.mjs';
const HB = loadCore();
let bad = 0;
const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };

// a real matrix profile with an A2B0 (LUT) tag added -> must be classified as LUT, not matrix
function withA2B0(profile) {
  const n = new DataView(profile.buffer, profile.byteOffset).getUint32(128);
  const tableEnd = 132 + 12 * n, grow = 12;
  const out = new Uint8Array(profile.length + grow + 32);
  out.set(profile.subarray(0, 128), 0);
  new DataView(out.buffer).setUint32(128, n + 1);
  out.set(profile.subarray(132, tableEnd), 132);
  // shift data by `grow` bytes: rewrite offsets
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) dv.setUint32(132 + 12 * i + 4, new DataView(profile.buffer, profile.byteOffset).getUint32(132 + 12 * i + 4) + grow);
  const a = tableEnd;
  out.set([0x41, 0x32, 0x42, 0x30], a); dv.setUint32(a + 4, profile.length + grow); dv.setUint32(a + 8, 32);
  out.set(profile.subarray(tableEnd), tableEnd + grow);
  out.set([0x6D, 0x66, 0x74, 0x31], profile.length + grow);   // 'mft1' stub data at the end
  dv.setUint32(0, out.length);
  return out;
}
const lutProfile = withA2B0(HB.icc.makeSRGB());
const info = HB.icc.parse(lutProfile);
check(info && info.kind === 'lut', 'a profile with an A2B0 table is classified "lut" (not matrix)');

const jpg = HB.jpegEnc.encode({ width: 200, height: 100, quality: 90, optimize: false, segments: HB.exif.iccSegments(lutProfile), getRows(y, n, o) { o.fill(100); } });
const insp = await HB.pipeline.inspect(jpg);
check(insp.rawCapable === false && insp.profile.kind === 'lut', 'inspect() marks it as needing the browser decoder');
const logo = { w: 20, h: 10, rgba: new Uint8Array(20 * 10 * 4).fill(255) };
const req = { id: 1, source: { bytes: jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.byteLength) }, crop: { x: 0, y: 0, w: 200, h: 100 }, marks: [{ side: 'right', size: 0.3, logo }], style: { margin: 0.03, opacity: 1, shadow: { on: false, strength: 0, blur: 0, distance: 0, angle: 0, color: [0, 0, 0] } }, out: { format: 'jpeg' } };
try { await HB.pipeline.run(req, null); check(false, 'run() should refuse a LUT profile'); }
catch (e) { check(e.code === 'unsupported', 'run() throws code "unsupported" so the app falls back to the browser decoder (' + e.code + ')'); }

// a mismatch between decoded size and the preview must also bounce to the fallback
const g = HB.jpegEnc.encode({ width: 200, height: 100, quality: 90, optimize: false, getRows(y, n, o) { o.fill(100); } });
try { await HB.pipeline.run({ ...req, source: { bytes: g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength) }, expect: { width: 100, height: 200 } }, null); check(false, 'size mismatch should bounce'); }
catch (e) { check(e.code === 'unsupported', 'a size/orientation mismatch with the preview is bounced to the fallback too'); }
console.log(bad ? bad + ' FAILURE(S)' : 'fallback routing: all checks passed');
process.exit(bad ? 1 : 0);
