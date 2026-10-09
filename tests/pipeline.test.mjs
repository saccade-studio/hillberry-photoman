import fs from 'node:fs';
import { loadCore } from '../tools/load-core.mjs';
const HB = loadCore();
const SP = process.argv[2];
const FX = SP + '/fx', OUT = SP + '/out';
fs.mkdirSync(OUT, { recursive: true });

const lj = JSON.parse(fs.readFileSync(SP + '/logo.json', 'utf8'));
const logoRGBA = new Uint8Array(fs.readFileSync(SP + '/logo.rgba'));
const trimmed = HB.marks.trim(logoRGBA, lj.w, lj.h, 4);
console.log(`logo ${lj.w}x${lj.h} -> visible artwork ${trimmed.w}x${trimmed.h}`);

function solidLogo(w, h, rgb) {
  const a = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { a[i * 4] = rgb[0]; a[i * 4 + 1] = rgb[1]; a[i * 4 + 2] = rgb[2]; a[i * 4 + 3] = 255; }
  return { w, h, rgba: a };
}
const noShadow = { on: false, strength: 0.6, blur: 0.2, distance: 0.2, angle: 45, color: [0, 0, 0] };
const withShadow = { on: true, strength: 0.6, blur: 0.2, distance: 0.2, angle: 45, color: [0, 0, 0] };
const cases = [];

async function runCase(name, file, o) {
  const bytes = new Uint8Array(fs.readFileSync(`${FX}/${file}`));
  const insp = await HB.pipeline.inspect(bytes);
  const crop = o.crop || { x: 0, y: 0, w: insp.width, h: insp.height };
  const style = Object.assign({ margin: 0.03, opacity: 1, shadow: noShadow }, o.style || {});
  const marks = o.marks === undefined ? [{ side: 'right', logo: trimmed, size: 0.3 }] : o.marks;
  const req = { id: name, source: { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteLength + bytes.byteOffset) }, crop, marks, style, out: Object.assign({ format: 'jpeg', quality: 100, chroma: '444', optimize: true, metadata: 'all', dpi: null }, o.out || {}) };
  const t0 = Date.now();
  const res = await HB.pipeline.run(req, null);
  const ext = res.mime === 'image/png' ? 'png' : 'jpg';
  fs.writeFileSync(`${OUT}/${name}.${ext}`, res.bytes);
  const boxes = HB.marks.layout(crop.w, crop.h, marks.map((m) => ({ side: m.side, w: m.logo.w, h: m.logo.h, size: m.size })), style.margin);
  cases.push({ name, src: file, out: `${name}.${ext}`, crop, boxes, w: res.width, h: res.height, profile: res.info.profile, ...(o.check || {}) });
  console.log(`${name.padEnd(28)} ${String(res.width).padStart(5)}x${String(res.height).padEnd(5)} ${(res.bytes.length / 1024).toFixed(0).padStart(6)} KB  ${String(Date.now() - t0).padStart(5)} ms   profile: ${res.info.profile}`);
  return res;
}

// 1. colour-space preservation, with the real logo
for (const f of ['photo_srgb.jpg', 'photo_srgb_icc.jpg', 'photo_adobe.jpg', 'photo_p3.jpg', 'photo_prophoto.jpg']) {
  await runCase('wm_' + f.replace('.jpg', ''), f, { crop: { x: 300, y: 0, w: 1920, h: 1600 }, style: { shadow: withShadow } });
}
// 2. exact colour test: opaque solid logo, no shadow, 100% opacity
for (const f of ['photo_srgb.jpg', 'photo_adobe.jpg', 'photo_p3.jpg', 'photo_prophoto.jpg']) {
  await runCase('solid_' + f.replace('.jpg', ''), f, { marks: [{ side: 'right', logo: solidLogo(400, 200, [245, 138, 60]), size: 0.3 }, { side: 'left', logo: solidLogo(300, 300, [107, 15, 69]), size: 0.2 }], check: { solid: [{ side: 'right', rgb: [245, 138, 60] }, { side: 'left', rgb: [107, 15, 69] }] } });
}
// 3. PNG sources / outputs
await runCase('png_in_p3_jpg_out', 'photo_p3.png', { crop: { x: 0, y: 0, w: 1500, h: 1200 } });
await runCase('png_in_p3_png_out', 'photo_p3.png', { crop: { x: 0, y: 0, w: 1200, h: 900 }, out: { format: 'png' } });
// 4. orientation (full frame, no watermark) — must come out upright
for (let o = 1; o <= 8; o++) await runCase('orient_' + o, `orient_${o}.jpg`, { marks: [], check: { orient: true } });
// 5. crop + orientation + watermark on an oriented image
await runCase('orient_6_crop', 'orient_6.jpg', { crop: { x: 20, y: 30, w: 150, h: 120 }, marks: [{ side: 'right', logo: trimmed, size: 0.3 }] });
// 6. metadata
for (const m of ['all', 'nogps', 'none']) await runCase('meta_' + m, 'rich_exif.jpg', { marks: [], out: { metadata: m, dpi: 300 }, check: { meta: m } });
// 7. opacity + shadow
await runCase('opacity50', 'photo_srgb.jpg', { crop: { x: 0, y: 0, w: 2000, h: 1600 }, marks: [{ side: 'right', logo: solidLogo(400, 200, [255, 255, 255]), size: 0.3 }], style: { opacity: 0.5 }, check: { opacity: 0.5, solidWhite: true } });
await runCase('shadow_on', 'photo_srgb.jpg', { crop: { x: 0, y: 0, w: 2000, h: 1600 }, marks: [{ side: 'right', logo: trimmed, size: 0.3 }, { side: 'left', logo: trimmed, size: 0.2 }], style: { shadow: withShadow } });
// 8. quality / chroma options
await runCase('q92_420', 'photo_srgb.jpg', { marks: [{ side: 'right', logo: trimmed, size: 0.3 }], out: { quality: 92, chroma: '420' } });

fs.writeFileSync(OUT + '/cases.json', JSON.stringify(cases));
console.log('\n' + cases.length + ' cases written');
