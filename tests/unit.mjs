// Portable unit tests: pure Node, no external tools (so they run anywhere, including GitHub Actions).
//   node tests/unit.mjs          (expects dist/ to be built:  node build.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { loadCore, root } from '../tools/load-core.mjs';

const HB = loadCore();
let failures = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failures++; console.log('FAIL ' + msg); } };
const section = (name) => console.log('\n' + name);
const psnr = (a, b) => { let se = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; } return se === 0 ? 99 : 10 * Math.log10(255 * 255 / (se / a.length)); };

// ------------------------------------------------------------------ the built page
section('Built page (dist/index.html)');
{
  const file = path.join(root, 'dist', 'index.html');
  check(fs.existsSync(file), 'dist/index.html exists (run: node build.mjs)');
  const html = fs.readFileSync(file, 'utf8');
  check(fs.readFileSync(path.join(root, 'dist', 'Hillberry-PhotoMan.html'), 'utf8') === html, 'index.html and Hillberry-PhotoMan.html are identical');
  check(html.length < 2e6, `single file stays small (${(html.length / 1024).toFixed(0)} KB)`);
  check(/<meta http-equiv="Content-Security-Policy"[^>]*connect-src data: blob:/.test(html), 'a Content-Security-Policy that blocks all network access is present');
  const ext = [...html.matchAll(/(?:src|href|action)=["'](https?:)?\/\/[^"']+/g)].map((m) => m[0]);
  check(ext.length === 0, 'no external src/href/action URLs' + (ext.length ? ': ' + ext.join(', ') : ''));
  const urls = new Set([...html.matchAll(/https?:\/\/[^\s"'<>)\\]+/g)].map((m) => m[0]));
  const allowed = [/^http:\/\/www\.w3\.org\/2000\/svg$/, /^http:\/\/ns\.adobe\.com\/xap\/1\.0\//, /^https:\/\/[a-z0-9-]+\.github\.io\//];
  const stray = [...urls].filter((u) => !allowed.some((re) => re.test(u)));
  check(stray.length === 0, 'no URLs other than XML namespaces' + (stray.length ? ': ' + stray.join(', ') : ''));
  const ids = [...fs.readFileSync(path.join(root, 'src', 'index.template.html'), 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  check(dup.length === 0, 'element ids are unique' + (dup.length ? ': ' + dup.join(', ') : ''));
  const idset = new Set(ids);
  const missing = new Set();
  for (const f of fs.readdirSync(path.join(root, 'src', 'app')).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(root, 'src', 'app', f), 'utf8');
    for (const m of src.matchAll(/(?:\$|getElementById)\('([A-Za-z0-9_-]+)'\)/g)) if (!idset.has(m[1])) missing.add(`${m[1]} (${f})`);
  }
  check(missing.size === 0, 'every element the UI code looks up exists in the page' + (missing.size ? ': ' + [...missing].join(', ') : ''));
}

// ------------------------------------------------------------------ JPEG codec
section('JPEG encoder + decoder');
{
  // FDCT against a brute-force DCT
  const q1 = new Int32Array(64).fill(1), recip = HB.jpegEnc.reciprocals(q1);
  let maxErr = 0;
  for (let t = 0; t < 40; t++) {
    const f = Float64Array.from({ length: 64 }, () => Math.round(Math.random() * 255) - 128), ref = new Float64Array(64);
    for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) s += f[y * 8 + x] * Math.cos((2 * x + 1) * v * Math.PI / 16) * Math.cos((2 * y + 1) * u * Math.PI / 16);
      ref[u * 8 + v] = 0.25 * (u ? 1 : Math.SQRT1_2) * (v ? 1 : Math.SQRT1_2) * s;
    }
    const d = Float64Array.from(f); HB.jpegEnc.fdct(d);
    for (let i = 0; i < 64; i++) maxErr = Math.max(maxErr, Math.abs(d[i] * recip[i] - ref[i]));
  }
  check(maxErr < 1e-8, `forward DCT matches the reference (max error ${maxErr.toExponential(1)})`);

  const W = 123, H = 77, rgb = new Uint8Array(W * H * 3);
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    rgb[i] = 40 + x * 1.5 + rnd() * 6; rgb[i + 1] = 90 + y * 1.8 + rnd() * 6; rgb[i + 2] = 200 - x - y + rnd() * 6;
  }
  const getRows = (y0, n, out) => out.set(rgb.subarray(y0 * W * 3, (y0 + n) * W * 3));
  for (const [q, sub, opt, minDb] of [[100, '444', true, 48], [100, '444', false, 48], [92, '444', true, 38], [90, '420', true, 33]]) {
    const jpg = HB.jpegEnc.encode({ width: W, height: H, quality: q, subsampling: sub, optimize: opt, getRows });
    const dec = HB.jpeg.decode(jpg);
    check(dec.width === W && dec.height === H, `q${q} ${sub} ${opt ? 'optimised' : 'standard'} tables: decodes at the right size`);
    const db = psnr(rgb, dec.rgb);
    check(db > minDb, `q${q} ${sub} ${opt ? 'optimised' : 'standard'} tables: ${db.toFixed(1)} dB (needs > ${minDb})`);
  }
  const a = HB.jpegEnc.encode({ width: W, height: H, quality: 100, subsampling: '444', optimize: false, getRows });
  const b = HB.jpegEnc.encode({ width: W, height: H, quality: 100, subsampling: '444', optimize: true, getRows });
  check(b.length < a.length, `optimised Huffman tables make the file smaller (${a.length} → ${b.length} bytes)`);
  check(JSON.stringify(Array.from(HB.jpeg.decode(a).rgb)) === JSON.stringify(Array.from(HB.jpeg.decode(b).rgb)), 'optimised tables give identical pixels');
  // damaged input never hangs or throws anything but our own error type
  for (const cut of [10, 200, a.length >> 1, a.length - 5]) {
    try { HB.jpeg.decode(a.subarray(0, cut)); } catch (e) { check(e.name === 'HBError', `truncated file at ${cut} bytes fails cleanly`); }
  }
}

// ------------------------------------------------------------------ PNG
section('PNG codec');
{
  const W = 57, H = 33, rgb = Uint8Array.from({ length: W * H * 3 }, (_, i) => (i * 37 + (i >> 5) * 11) & 255);
  const icc = HB.icc.makeDisplayP3();
  const png = await HB.png.encode({ width: W, height: H, getRows: (y0, n, out) => out.set(rgb.subarray(y0 * W * 3, (y0 + n) * W * 3)), icc, dpi: 300 });
  const back = await HB.png.decode(png);
  check(back.width === W && back.height === H && back.rgb.every((v, i) => v === rgb[i]), 'round trip is bit-exact');
  check(back.icc && back.icc.length === icc.length && back.icc.every((v, i) => v === icc[i]), 'embedded ICC profile survives byte-for-byte');
}

// ------------------------------------------------------------------ colour management
section('ICC / colour');
{
  const srgb = HB.icc.parse(HB.icc.makeSRGB()), p3 = HB.icc.parse(HB.icc.makeDisplayP3());
  check(srgb && srgb.kind === 'matrix' && p3 && p3.kind === 'matrix', 'generated sRGB and Display P3 profiles parse');
  check(HB.icc.createSRGBConverter(srgb).identity, 'sRGB → sRGB is the identity');
  const red = HB.icc.createSRGBConverter(p3).convertColor([255, 0, 0]);
  check(Math.abs(red[0] - 234) <= 1 && Math.abs(red[1] - 51) <= 1.5 && Math.abs(red[2] - 35) <= 1.5, `sRGB red in Display P3 is about (234, 51, 35): got (${red.map((v) => v.toFixed(1))})`);
  const gamma = HB.icc.parse(new Uint8Array(fs.existsSync('/System/Library/ColorSync/Profiles/AdobeRGB1998.icc') ? fs.readFileSync('/System/Library/ColorSync/Profiles/AdobeRGB1998.icc') : HB.icc.makeSRGB()));
  check(gamma && gamma.kind === 'matrix', 'a real-world matrix profile parses');
}

// ------------------------------------------------------------------ EXIF
section('EXIF rebuild');
for (const le of [true, false]) {
  const u16 = (v) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]), u32 = (v) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const entry = (tag, type, count, val) => [...u16(tag), ...u16(type), ...u32(count), ...val];
  const make = [...Buffer.from('TESTCAM\0')], thumb = [0xFF, 0xD8, ...Buffer.from('SECRET-THUMB'), 0xFF, 0xD9];
  const ifd0 = 8, n0 = 4, s0 = 2 + 12 * n0 + 4, exifOff = ifd0 + s0, sE = 2 + 12 * 2 + 4, ifd1 = exifOff + sE, s1 = 2 + 12 * 2 + 4;
  const makeOff = ifd1 + s1, makerOff = makeOff + make.length, thumbOff = makerOff + 24;
  const bytes = [...(le ? [0x49, 0x49, 42, 0] : [0x4D, 0x4D, 0, 42]), ...u32(8),
    ...u16(n0), ...entry(0x010F, 2, make.length, u32(makeOff)), ...entry(0x0112, 3, 1, [...u16(6), 0, 0]), ...entry(0x8298, 2, 4, [0x28, 0x63, 0x29, 0]), ...entry(0x8769, 4, 1, u32(exifOff)), ...u32(ifd1),
    ...u16(2), ...entry(0x9003, 2, 4, [0x32, 0x30, 0x32, 0]), ...entry(0x927C, 7, 24, u32(makerOff)), ...u32(0),
    ...u16(2), ...entry(0x0201, 4, 1, u32(thumbOff)), ...entry(0x0202, 4, 1, u32(thumb.length)), ...u32(0),
    ...make, ...new Array(24).fill(0xAB), ...thumb];
  const exif = new Uint8Array(bytes);
  check(HB.exif.orientation(exif) === 6, `${le ? 'little' : 'big'}-endian: orientation read`);
  const out = HB.exif.rebuild(exif, { width: 300, height: 200, colorSpaceTag: 0xFFFF, dpi: 200 });
  const t = HB.exif.parseTIFF(out.subarray(6));
  const ifd0e = t.readIFD(t.ifd0Offset);
  const tags = ifd0e.entries.map((e) => e.tag);
  check(t.le === le, `${le ? 'little' : 'big'}-endian: byte order preserved`);
  check(HB.exif.orientation(out.subarray(6)) === 1, `${le ? 'little' : 'big'}-endian: orientation reset to 1`);
  check(tags.includes(0x010F) && tags.includes(0x8298), `${le ? 'little' : 'big'}-endian: camera make and copyright kept`);
  const hay = Buffer.from(out).toString('latin1');
  check(!hay.includes('SECRET-THUMB') && !out.includes(0xAB), `${le ? 'little' : 'big'}-endian: thumbnail and MakerNote removed`);
  const sub = t.readIFD(ifd0e.entries.find((e) => e.tag === 0x8769) && new DataView(ifd0e.entries.find((e) => e.tag === 0x8769).bytes.buffer, ifd0e.entries.find((e) => e.tag === 0x8769).bytes.byteOffset).getUint32(0, le));
  const dims = sub.entries.filter((e) => e.tag === 0xA002 || e.tag === 0xA003).map((e) => new DataView(e.bytes.buffer, e.bytes.byteOffset).getUint32(0, le));
  check(dims.length === 2 && dims[0] === 300 && dims[1] === 200, `${le ? 'little' : 'big'}-endian: pixel dimensions updated`);
}
for (const junk of [new Uint8Array(0), new Uint8Array([1, 2, 3]), new Uint8Array(100).fill(255)]) {
  let ok = true; try { HB.exif.rebuild(junk, { width: 1, height: 1 }); } catch (e) { ok = false; }
  check(ok, 'garbage EXIF input is tolerated');
}

// ------------------------------------------------------------------ ZIP
section('ZIP writer');
{
  const files = [['a.jpg', Uint8Array.from({ length: 1000 }, (_, i) => i & 255)], ['b é.jpg', Uint8Array.from({ length: 77 }, (_, i) => 255 - i)], ['a.jpg', new Uint8Array([1, 2, 3])]];
  const parts = HB.zip.build(files.map(([name, data]) => ({ name, size: data.length, crc: HB.util.crc32(data), data })));
  const zip = new Uint8Array(await new Blob(parts).arrayBuffer());
  const dv = new DataView(zip.buffer);
  const eocd = zip.length - 22;
  check(dv.getUint32(eocd, true) === 0x06054b50 && dv.getUint16(eocd + 10, true) === 3, 'end-of-central-directory record: 3 entries');
  let p = dv.getUint32(eocd + 16, true), names = [];
  for (let i = 0; i < 3; i++) {
    const nl = dv.getUint16(p + 28, true), lh = dv.getUint32(p + 42, true), size = dv.getUint32(p + 20, true), crc = dv.getUint32(p + 16, true);
    names.push(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nl)));
    const dataStart = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
    check(HB.util.crc32(zip.subarray(dataStart, dataStart + size)) === crc, `entry ${i + 1}: stored bytes match the CRC-32`);
    p += 46 + nl;
  }
  check(new Set(names.map((n) => n.toLowerCase())).size === 3, 'duplicate names are made unique: ' + names.join(', '));
}

// ------------------------------------------------------------------ watermark layout + export pipeline
section('Layout + export pipeline');
{
  for (const [w, h] of [[3000, 2000], [2000, 3000], [1600, 1600], [4812, 6015]]) {
    const box = HB.marks.layout(w, h, [{ side: 'left', w: 600, h: 300, size: 0.2 }, { side: 'right', w: 1465, h: 660, size: 0.25 }], 0.03);
    const [L, R] = box;
    check(L.x === L.margin && w - (R.x + R.w) === L.margin && h - (L.y + L.h) === L.margin && h - (R.y + R.h) === L.margin, `${w}×${h}: left, right and bottom margins are identical (${L.margin}px) and both marks share a baseline`);
  }
  // all 8 EXIF orientations come out upright (independent mapping written out from the EXIF definitions)
  const SW = 4, SH = 3, colors = Array.from({ length: SW * SH }, (_, i) => [(i * 67 + 30) & 255, (i * 121 + 90) & 255, (i * 29 + 200) & 255]);
  const grid = (w, h, f) => Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => f(x, y)));
  const stored = grid(SW, SH, (x, y) => colors[y * SW + x]);
  const transform = {
    1: (s) => grid(SW, SH, (x, y) => s[y][x]),
    2: (s) => grid(SW, SH, (x, y) => s[y][SW - 1 - x]),
    3: (s) => grid(SW, SH, (x, y) => s[SH - 1 - y][SW - 1 - x]),
    4: (s) => grid(SW, SH, (x, y) => s[SH - 1 - y][x]),
    5: (s) => grid(SH, SW, (x, y) => s[x][y]),
    6: (s) => grid(SH, SW, (x, y) => s[SH - 1 - x][y]),          // rotate 90° clockwise
    7: (s) => grid(SH, SW, (x, y) => s[SH - 1 - x][SW - 1 - y]),
    8: (s) => grid(SH, SW, (x, y) => s[x][SW - 1 - y]),          // rotate 90° counter-clockwise
  };
  const B = 16;                                                  // each source cell is a 16×16 flat block
  for (let o = 1; o <= 8; o++) {
    const W = SW * B, H = SH * B, px = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(stored[(y / B) | 0][(x / B) | 0], (y * W + x) * 3);
    const tiff = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0]);
    const seg = HB.exif.exifSegment(Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]));
    const jpg = HB.jpegEnc.encode({ width: W, height: H, quality: 100, subsampling: '444', optimize: false, segments: [seg], getRows: (y0, n, out) => out.set(px.subarray(y0 * W * 3, (y0 + n) * W * 3)) });
    const insp = await HB.pipeline.inspect(jpg);
    const res = await HB.pipeline.run({ id: 1, source: { bytes: jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.byteLength) }, crop: { x: 0, y: 0, w: insp.width, h: insp.height }, marks: [], style: { margin: 0.03, opacity: 1, shadow: { on: false, strength: 0, blur: 0, distance: 0, angle: 0, color: [0, 0, 0] } }, out: { format: 'jpeg', quality: 100, chroma: '444', optimize: false, metadata: 'none' } }, null);
    const out = HB.jpeg.decode(res.bytes), want = transform[o](stored);
    let worst = 0;
    for (let cy = 0; cy < want.length; cy++) for (let cx = 0; cx < want[0].length; cx++) {
      const x = cx * B + B / 2, y = cy * B + B / 2;
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out.rgb[(y * out.width + x) * 3 + k] - want[cy][cx][k]));
    }
    check(out.width === want[0].length * B && out.height === want.length * B && worst <= 4, `EXIF orientation ${o}: exported upright (${out.width}×${out.height}, worst colour error ${worst})`);
  }
  // colour profile + watermark placement end to end
  const W = 400, H = 300, flat = new Uint8Array(W * H * 3).fill(110), p3 = HB.icc.makeDisplayP3();
  const jpg = HB.jpegEnc.encode({ width: W, height: H, quality: 95, subsampling: '444', optimize: false, segments: HB.exif.iccSegments(p3), getRows: (y0, n, out) => out.set(flat.subarray(y0 * W * 3, (y0 + n) * W * 3)) });
  const white = { w: 100, h: 50, rgba: new Uint8Array(100 * 50 * 4).fill(255) };
  const res = await HB.pipeline.run({ id: 2, source: { bytes: jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.byteLength) }, crop: { x: 0, y: 0, w: W, h: H }, marks: [{ side: 'right', size: 0.4, logo: white }, { side: 'left', size: 0.25, logo: white }], style: { margin: 0.05, opacity: 1, shadow: { on: false, strength: 0, blur: 0, distance: 0, angle: 0, color: [0, 0, 0] } }, out: { format: 'jpeg', quality: 100, chroma: '444', optimize: true, metadata: 'all' } }, null);
  const dec = HB.jpeg.decode(res.bytes), icc = dec.meta.icc;
  check(icc && icc.length === p3.length && icc.every((v, i) => v === p3[i]), 'export keeps the original colour profile byte-for-byte');
  let x0 = W, x1 = -1, y1 = -1; const bright = (x, y) => dec.rgb[(y * W + x) * 3] > 200;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (bright(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const M = Math.round(0.05 * Math.min(W, H));
  check(x0 === M && W - 1 - x1 === M && H - 1 - y1 === M, `visible margins: left ${x0}, right ${W - 1 - x1}, bottom ${H - 1 - y1} (all expected ${M})`);
}

console.log(`\n${checks - failures}/${checks} checks passed` + (failures ? `, ${failures} FAILED` : ''));
process.exit(failures ? 1 : 0);
