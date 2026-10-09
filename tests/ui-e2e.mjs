// Real-input UI test in headless Chrome: real file picker, real mouse + keyboard, real downloads.
import { launch } from '../tools/cdp.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appUrl } from '../tools/app-url.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SP = process.argv[2];
const OUT = path.join(SP, 'ui-e2e'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch({ width: 1440, height: 900, scale: 2 });
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
try {
  const page = await b.open(appUrl());
  await page.allowDownloads(path.join(OUT, 'downloads'));
  await page.waitFor("window.__hb && window.__hb.assets.hb.logo", 20000);
  await page.screenshot(path.join(OUT, '01-empty.png'));

  // 1. real file picker with real files from disk
  await page.setFiles('#fileInput', [path.join(SP, 'fx/photo_p3.jpg'), path.join(SP, 'fx/photo_adobe.jpg'), path.join(SP, 'fx/orient_6.jpg')]);
  await page.eval("document.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }))");
  await page.waitFor("window.__hb.items.length === 3 && window.__hb.items[0].preview", 30000);
  check(await page.eval("window.__hb.items.length") === 3, 'three photos added through the file picker');
  check(await page.eval("document.getElementById('app').dataset.empty") === 'false', 'empty state replaced by the editor');

  // 2. real click on the Scott Print Size 8x10 card
  await page.click('.scott-card[data-aspect="scott-8x10"]');
  await sleep(300);
  check(await page.eval("window.__hb.S.aspect") === 'scott-8x10', 'clicking the Scott Print Size 8 × 10 card selects it');
  const c1 = await page.eval("window.__hb.getCrop(window.__hb.items[0])");
  check(c1.w * 4 === c1.h * 5, `crop is exactly 5:4 landscape = 10 × 8 in (${c1.w} × ${c1.h})`);
  check((await page.eval("document.getElementById('stageFoot').innerText")).includes('Scott Print Size'), 'the stage shows the "Scott Print Size" pill with the print resolution');

  // 3. real mouse drag on a landscape photo (select it with a real click on its thumbnail, then use a 1:1 crop that has room to move)
  await page.click('.thumb:nth-child(2)'); await page.waitFor("window.__hb.items[1].preview && window.__hb.items[1].id === Number(document.querySelector('.thumb[aria-selected=true]').dataset.id)", 15000);
  await page.click('[data-aspect="1:1"]'); await sleep(250);
  const before = await page.eval("window.__hb.getCrop(window.__hb.items[1])");
  const r = await page.rect('#crop');
  await page.drag(r.x + r.w / 2, r.y + r.h / 2, r.x + r.w / 2 + 70, r.y + r.h / 2);
  await sleep(250);
  const after = await page.eval("window.__hb.getCrop(window.__hb.items[1])");
  check(after.x !== before.x && after.w === before.w && after.h === before.h && after.y === before.y, `dragging the crop frame moves it without resizing (x ${before.x} → ${after.x})`);
  const r2 = await page.rect('#crop');
  await page.drag(r2.x + r2.w, r2.y + r2.h, r2.x + r2.w - 80, r2.y + r2.h - 80);
  await sleep(250);
  const c3 = await page.eval("window.__hb.getCrop(window.__hb.items[1])");
  check(c3.w === c3.h && c3.w < after.w, `corner-drag resizes the crop and keeps it exactly square (${c3.w} × ${c3.h})`);
  // keyboard: arrow key nudges the focused crop frame
  await page.eval("document.getElementById('crop').focus()");
  const kx = c3.x; await page.key('ArrowLeft', 'ArrowLeft', 37); await sleep(150);
  check((await page.eval("window.__hb.getCrop(window.__hb.items[1]).x")) < kx, 'arrow key nudges the crop frame');
  // back to the first photo for the export steps
  await page.click('.thumb:nth-child(1)'); await page.waitFor("window.__hb.items[0].preview", 15000); await sleep(300);

  // 4. back to 8x10, add a text watermark with the real keyboard
  await page.click('.scott-card[data-aspect="scott-8x10"]'); await sleep(250);
  await page.click('#cKindSeg [data-kind="text"]'); await sleep(150);
  await page.click('#cText'); await page.type('© Jane Photographer'); await sleep(500);
  check(await page.eval("window.__hb.S.mine.text") === '© Jane Photographer' && await page.eval("window.__hb.S.mine.enabled") === true, 'typed watermark text enables the left watermark');
  check(await page.eval("window.__hb.activeMarks().length") === 2, 'two watermarks active (festival logo + the photographer\'s)');
  // slider by keyboard
  await page.eval("document.getElementById('hSize').focus()");
  const sz0 = await page.eval("window.__hb.S.hb.size");
  for (let i = 0; i < 6; i++) await page.key('ArrowRight', 'ArrowRight', 39);
  check(await page.eval("window.__hb.S.hb.size") > sz0, 'keyboard moves the logo size slider');
  await page.eval("document.getElementById('hSize').value = " + sz0 + "; document.getElementById('hSize').dispatchEvent(new Event('input', {bubbles:true}))");
  // opacity + shadow via sliders
  await page.eval("(() => { const o = document.getElementById('opacity'); o.value = 85; o.dispatchEvent(new Event('input', {bubbles:true})); const s = document.getElementById('shStrength'); s.value = 70; s.dispatchEvent(new Event('input', {bubbles:true})); })()");
  check(await page.eval("window.__hb.S.opacity") === 85, 'opacity slider updates settings');
  await page.eval("window.scrollTo(0,0); document.getElementById('panelScroll').scrollTop = 0");
  await sleep(300);
  await page.screenshot(path.join(OUT, '02-editor.png'));

  // 5. real click on the Export button; the browser downloads a real file
  await page.click('#btnExport');
  await page.waitFor("window.__hb.items[0].status === 'done'", 60000);
  await sleep(1200);
  const dl = fs.readdirSync(path.join(OUT, 'downloads')).filter((f) => !f.endsWith('.crdownload'));
  check(dl.length === 1, 'one file downloaded: ' + dl.join(', '));
  check(/^photo_p3-Hillberry-10x8\.jpg$/.test(dl[0] || ''), 'file name is "<name>-Hillberry-10x8.jpg" (' + dl[0] + ')');
  fs.writeFileSync(path.join(OUT, 'dl_name.txt'), dl[0] || '');

  // 6. Export all -> zip
  await page.click('#btnExportAll');
  await page.waitFor("window.__hb.items.every((i) => i.status === 'done') && !document.getElementById('btnExport').disabled", 90000);
  await sleep(1500);
  const dl2 = fs.readdirSync(path.join(OUT, 'downloads')).filter((f) => !f.endsWith('.crdownload'));
  check(dl2.some((f) => f.endsWith('.zip')), 'Export all produced a .zip: ' + dl2.join(', '));
  await page.screenshot(path.join(OUT, '03-after-export.png'));
  // 7. help dialog + browser check
  await page.click('#btnHelp'); await sleep(300);
  await page.click('#btnSelfTest'); await page.waitFor("document.querySelectorAll('#selfTestOut .check-row').length >= 8", 30000);
  check(await page.eval("document.querySelectorAll('#selfTestOut .check-row.bad').length") === 0, 'Help → Browser check reports no failures');
  await page.screenshot(path.join(OUT, '04-help.png'));
  const errs = page.logs.filter((l) => /^(error|EXCEPTION)/.test(l));
  check(errs.length === 0, 'no console errors or exceptions' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) { console.log('ERROR', e.stack || e.message); failed++; }
finally { await b.close(); }
console.log(failed ? `\n${failed} FAILURE(S)` : '\nUI E2E: all checks passed');
process.exit(failed ? 1 : 0);
