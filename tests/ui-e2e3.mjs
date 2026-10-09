// Export options, a batch containing a broken file, and cancelling mid-export — all with real input in Chrome.
import { launch } from '../tools/cdp.mjs';
import path from 'node:path'; import fs from 'node:fs'; import { fileURLToPath } from 'node:url';
import { appUrl } from '../tools/app-url.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); const SP = process.argv[2];
const OUT = path.join(SP, 'ui-e2e3'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch({ width: 1440, height: 900, scale: 1 });
let failed = 0; const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failed++; };
const addFiles = async (page, files) => { await page.setFiles('#fileInput', files); await page.eval("document.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }))"); };
const listDl = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => !f.endsWith('.crdownload')) : []);
try {
  const page = await b.open(appUrl());
  const DL = path.join(OUT, 'dl'); await page.allowDownloads(DL);
  await page.waitFor('window.__hb && window.__hb.assets.hb.logo', 20000);
  await page.eval('localStorage.clear()');

  // ---- 1. export options through the real controls
  await addFiles(page, [path.join(SP, 'fx/photo_srgb.jpg')]);
  await page.waitFor('window.__hb.items.length === 1 && window.__hb.items[0].preview', 30000);
  await page.eval("(() => { const q = document.getElementById('quality'); q.value = 92; q.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await page.click('#chromaSeg [data-chroma="420"]');
  await page.eval("(() => { const m = document.getElementById('metaSelect'); m.value = 'none'; m.dispatchEvent(new Event('change', { bubbles: true })); const s = document.getElementById('suffix'); s.value = '_web'; s.dispatchEvent(new Event('input', { bubbles: true })); })()");
  check((await page.eval("document.getElementById('qualityHint').textContent")).startsWith('Very high quality'), 'quality hint describes the chosen level');
  await page.click('#btnExport'); await page.waitFor("window.__hb.items[0].status === 'done'", 30000); await sleep(800);
  let dl = listDl(DL); check(dl.length === 1 && dl[0] === 'photo_srgb_web.jpg', 'suffix honoured: ' + dl.join(','));
  fs.copyFileSync(path.join(DL, 'photo_srgb_web.jpg'), path.join(OUT, 'options.jpg'));
  // PNG
  await page.click('#fmtSeg [data-fmt="png"]'); await sleep(200);
  check(await page.eval("document.getElementById('jpegCtl').hidden"), 'JPEG-only controls hide when PNG is chosen');
  await page.click('#btnExport'); await page.waitFor("window.__hb.items[0].status === 'done'", 30000); await sleep(800);
  dl = listDl(DL); check(dl.includes('photo_srgb_web.png'), 'PNG downloaded: ' + dl.join(','));
  fs.copyFileSync(path.join(DL, 'photo_srgb_web.png'), path.join(OUT, 'options.png'));

  // ---- 2. batch with a broken file in the middle + a truncated one
  await page.eval('window.__hb.clearAll()'); await page.eval("window.__hb.S.out.format = 'jpeg'; window.__hb.S.out.suffix = '-HB'; window.__hb.S.out.chroma = '444'; window.__hb.S.out.metadata = 'all'; window.__hb.S.out.zip = true; window.__hb.syncAll()");
  fs.rmSync(DL, { recursive: true, force: true }); await page.allowDownloads(DL);
  await addFiles(page, [path.join(SP, 'fx/photo_srgb.jpg'), path.join(SP, 'fx/broken.jpg'), path.join(SP, 'fx/truncated.jpg'), path.join(SP, 'fx/photo_p3.jpg')]);
  await page.waitFor('window.__hb.items.length >= 3', 30000); await sleep(2500);
  const nItems = await page.eval('window.__hb.items.length');
  await page.click('#btnExportAll');
  await page.waitFor("document.getElementById('btnExport').disabled === false && window.__hb.items.some((i) => i.status === 'done')", 60000); await sleep(1800);
  const st = await page.eval("window.__hb.items.map((i) => i.name + ':' + i.status).join(' ')");
  console.log('   statuses:', st);
  const z = listDl(DL).filter((f) => f.endsWith('.zip'));
  check(z.length === 1, 'batch still produced a zip even though a file was broken');
  check((await page.eval("window.__hb.items.filter((i) => i.status === 'done').length")) >= 2, 'the good photos exported');
  check((await page.eval("document.getElementById('toasts').innerText")).length > 0, 'the user was told about the problem file(s)');

  // ---- 3. cancel in the middle of a large export
  await page.eval('window.__hb.clearAll()'); fs.rmSync(DL, { recursive: true, force: true }); await page.allowDownloads(DL);
  await addFiles(page, [path.join(SP, 'fx/big_24mp.jpg')]);
  await page.waitFor('window.__hb.items.length === 1 && window.__hb.items[0].preview', 40000);
  // start, wait until it is really running, then press Cancel (inside the page, so timing doesn't depend on CDP latency)
  const res = await page.eval(`(async () => {
    window.__saved = []; window.__hb.onSave = (blob, name) => window.__saved.push(name);
    const p = window.__hb.exportCurrent();
    await new Promise((r) => setTimeout(r, 350));
    const shown = !document.getElementById('progressWrap').hidden;
    document.getElementById('btnCancel').click();
    await p;
    await new Promise((r) => setTimeout(r, 600));
    return { shown, saved: window.__saved.length, hidden: document.getElementById('progressWrap').hidden, status: window.__hb.items[0].status };
  })()`);
  check(res.shown, 'progress bar is shown while exporting');
  check(res.hidden && res.status !== 'busy', 'Cancel stops the export and resets the UI (status: ' + res.status + ')');
  check(res.saved === 0, 'cancelled export produced no download');
  await page.eval('window.__hb.onSave = null');
  await page.click('#btnExport'); await page.waitFor("window.__hb.items[0].status === 'done'", 90000); await sleep(1500);
  check(listDl(DL).length === 1, 'exporting again after a cancel works (the engine restarted): ' + listDl(DL));
  const errs = page.logs.filter((l) => /^(error|EXCEPTION)/.test(l));
  check(errs.length === 0, 'no console errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
} catch (e) { console.log('ERROR', e.stack || e.message); failed++; } finally { await b.close(); }
console.log(failed ? `\n${failed} FAILURE(S)` : '\nUI E2E (options/batch/cancel): all checks passed');
process.exit(failed ? 1 : 0);
