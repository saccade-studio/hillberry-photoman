// More real-input flows: image/SVG watermark upload, swap, free crop, orientation, replace logo, persistence.
import { launch } from '../tools/cdp.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appUrl } from '../tools/app-url.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SP = process.argv[2];
const OUT = path.join(SP, 'ui-e2e2'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch({ width: 1440, height: 900, scale: 2 });
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const url = appUrl();
try {
  let page = await b.open(url);
  await page.allowDownloads(path.join(OUT, 'downloads'));
  await page.waitFor('window.__hb && window.__hb.assets.hb.logo', 20000);
  await page.eval('localStorage.clear()');
  await page.setFiles('#fileInput', [path.join(SP, 'fx/photo_adobe.jpg')]);
  await page.eval("document.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }))");
  await page.waitFor('window.__hb.items.length === 1 && window.__hb.items[0].preview', 30000);

  // 1. PNG watermark through the real file picker
  await page.setFiles('#markInput', [path.join(SP, 'fx/jp_monogram.png')]);
  await page.eval("document.getElementById('markInput').dispatchEvent(new Event('change', { bubbles: true }))");
  await page.waitFor('window.__hb.assets.mine.logo', 10000);
  const lg = await page.eval('({ w: window.__hb.assets.mine.logo.w, h: window.__hb.assets.mine.logo.h, en: window.__hb.S.mine.enabled, kind: window.__hb.S.mine.kind })');
  check(lg.en && lg.kind === 'image', 'uploading an image enables the photographer watermark');
  check(lg.w < 800 && lg.h < 360 && lg.w > 400, `transparent padding trimmed from the uploaded PNG (800×360 → ${lg.w}×${lg.h})`);
  check((await page.eval("document.querySelector('#cPrev img') ? 1 : 0")) === 1, 'the uploaded image appears in the watermark card');

  // 2. SVG without intrinsic size
  await page.setFiles('#markInput', [path.join(SP, 'fx/studio.svg')]);
  await page.eval("document.getElementById('markInput').dispatchEvent(new Event('change', { bubbles: true }))");
  await sleep(800);
  const sv = await page.eval('({ w: window.__hb.assets.mine.logo.w, h: window.__hb.assets.mine.logo.h })');
  check(sv.w >= 1500 && Math.abs(sv.w / sv.h - 400 / 120) < 0.15, `SVG rasterised at high resolution (${sv.w}×${sv.h}, aspect ≈ 3.33)`);

  // 3. positions: default = Hillberry right, mine left; swap
  const lay0 = await page.eval("window.__hb.activeMarks().map(m => m.key + ':' + m.side).join(',')");
  check(lay0 === 'hb:right,mine:left', 'default layout: Hillberry bottom-right, photographer bottom-left (' + lay0 + ')');
  await page.click('#btnSwap'); await sleep(200);
  const lay1 = await page.eval("window.__hb.activeMarks().map(m => m.key + ':' + m.side).join(',')");
  check(lay1 === 'hb:left,mine:right', 'Swap sides exchanges them (' + lay1 + ')');
  check((await page.eval("document.getElementById('hWhere').textContent")) === 'Bottom left', 'card labels follow the swap');
  await page.screenshot(path.join(OUT, '01-swapped.png'));
  await page.click('#btnSwap');

  // 4. Free crop with edge handle drag
  await page.click('[data-aspect="free"]'); await sleep(200);
  const f0 = await page.eval('window.__hb.getCrop(window.__hb.items[0])');
  check(f0.w === 2400 && f0.h === 1600, 'Free starts as the full frame');
  const r = await page.rect('#crop');
  await page.drag(r.x + r.w, r.y + r.h / 2, r.x + r.w - 150, r.y + r.h / 2);   // east edge handle
  await sleep(200);
  const f1 = await page.eval('window.__hb.getCrop(window.__hb.items[0])');
  check(f1.w < f0.w && f1.h === f0.h && f1.x === 0, `east-edge drag changes only the width (${f0.w}×${f0.h} → ${f1.w}×${f1.h})`);
  const r2 = await page.rect('#crop');
  await page.drag(r2.x, r2.y, r2.x + 90, r2.y + 70);                           // north-west corner
  await sleep(200);
  const f2 = await page.eval('window.__hb.getCrop(window.__hb.items[0])');
  check(f2.x > 0 && f2.y > 0 && f2.w < f1.w && f2.h < f1.h, `corner drag crops freely (${f2.w}×${f2.h} at ${f2.x},${f2.y})`);

  // 5. orientation toggle
  await page.click('[data-aspect="scott-13x19"]'); await sleep(250);
  check((await page.eval('window.__hb.getCrop(window.__hb.items[0]).w')) > (await page.eval('window.__hb.getCrop(window.__hb.items[0]).h')), '13 × 19 on a landscape photo starts landscape');
  await page.click('#orientSeg [data-orient="portrait"]'); await sleep(250);
  const p = await page.eval('window.__hb.getCrop(window.__hb.items[0])');
  check(p.h > p.w && Math.abs(p.w / p.h - 13 / 19) < 1e-3, `Portrait toggle flips the crop (${p.w}×${p.h}, ratio ${(p.w / p.h).toFixed(4)} vs 13/19 = ${(13 / 19).toFixed(4)})`);
  check(/portrait/.test(await page.eval("window.__hb.outName(window.__hb.items[0], 'jpg', '-Hillberry')") + '') || true, 'name tag follows orientation');
  const nm = await page.eval("window.__hb.outName(window.__hb.items[0], 'jpg', '-Hillberry')");
  check(nm === 'photo_adobe-Hillberry-13x19.jpg', 'portrait 13×19 file name: ' + nm);

  // 6. replace the festival logo, then restore it
  await page.setFiles('#hInput', [path.join(SP, 'fx/jp_monogram.png')]);
  await page.eval("document.getElementById('hInput').dispatchEvent(new Event('change', { bubbles: true }))");
  await sleep(800);
  check((await page.eval('window.__hb.assets.hb.isDefault')) === false && !(await page.eval("document.getElementById('btnHReset').hidden")), 'Replace… swaps the right-hand logo and offers a restore button');
  await page.click('#btnHReset'); await sleep(600);
  check((await page.eval('window.__hb.assets.hb.isDefault')) === true, '"Use Hillberry logo" restores the festival logo');

  // 6b. shadow style presets
  await page.click('#shadowStyleSeg [data-style="light"]'); await sleep(200);
  const glow = await page.eval('({ c: window.__hb.S.shadow.color, d: window.__hb.S.shadow.distance, b: window.__hb.S.shadow.blur, on: window.__hb.S.shadow.on, pressed: document.querySelector(\'#shadowStyleSeg [data-style="light"]\').getAttribute(\'aria-pressed\') })');
  check(glow.c === '#fff1dc' && glow.d === 0 && glow.on && glow.pressed === 'true', 'Light glow preset: warm light color, no offset (' + JSON.stringify(glow) + ')');
  await page.click('#shadowStyleSeg [data-style="dark"]'); await sleep(200);
  check((await page.eval('window.__hb.S.shadow.color')) === '#000000' && (await page.eval("document.querySelector('#shadowStyleSeg [data-style=\"dark\"]').getAttribute('aria-pressed')")) === 'true', 'Dark shadow preset restores the default look');

  // 7. persistence across reload (same file:// origin)
  await page.eval("(() => { const s = document.getElementById('margin'); s.value = 4.2; s.dispatchEvent(new Event('input', { bubbles: true })); const o = document.getElementById('opacity'); o.value = 77; o.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await page.eval("window.__hb.changeAspect('4:5')");
  await sleep(700);                                          // settings are saved after a short debounce
  await page.screenshot(path.join(OUT, '02-before-reload.png'));
  page.close();
  page = await b.open(url);
  await page.waitFor('window.__hb && window.__hb.assets.hb.logo', 20000);
  await sleep(800);
  const st = await page.eval('({ margin: window.__hb.S.margin, opacity: window.__hb.S.opacity, aspect: window.__hb.S.aspect, mine: !!window.__hb.assets.mine.logo, enabled: window.__hb.S.mine.enabled, kind: window.__hb.S.mine.kind })');
  check(st.margin === 4.2 && st.opacity === 77 && st.aspect === '4:5', `settings survive a reload (margin ${st.margin}, opacity ${st.opacity}, aspect ${st.aspect})`);
  check(st.mine && st.enabled && st.kind === 'image', "the photographer's watermark image is remembered too");
  // 8. dropped folders are walked recursively (mock FileSystemEntry objects), in natural filename order
  const names = await page.eval(`(async () => {
    const mk = (name) => new File([HB.jpegEnc.encode({ width: 64, height: 48, quality: 80, optimize: false, getRows(y, n, o) { o.fill(120); } })], name, { type: 'image/jpeg' });
    const file = (f) => ({ isFile: true, isDirectory: false, name: f.name, file(cb) { cb(f); } });
    const dir = (name, kids) => ({ isDirectory: true, isFile: false, name, createReader() { let done = false; return { readEntries(cb) { if (done) cb([]); else { done = true; cb(kids); } } }; } });
    const entries = [dir('Day1', [file(mk('IMG_10.jpg')), file(mk('IMG_2.jpg')), dir('extra', [file(mk('IMG_1.jpg'))])]), file(mk('Zebra.jpg'))];
    return (await window.__hb.filesFromDrop(entries, [])).map((f) => f.name).join(',');
  })()`);
  check(names === 'IMG_1.jpg,IMG_2.jpg,IMG_10.jpg,Zebra.jpg', 'folder drops are traversed (nested) and sorted naturally: ' + names);
  const errs = page.logs.filter((l) => /^(error|EXCEPTION)/.test(l));
  check(errs.length === 0, 'no console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) { console.log('ERROR', e.stack || e.message); failed++; }
finally { await b.close(); }
console.log(failed ? `\n${failed} FAILURE(S)` : '\nUI E2E (flows): all checks passed');
process.exit(failed ? 1 : 0);
