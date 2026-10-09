// CMYK JPEG through the real UI (browser-decoder fallback), real file picker and real download.
import { launch } from '../tools/cdp.mjs';
import path from 'node:path'; import fs from 'node:fs'; import { fileURLToPath } from 'node:url';
import { appUrl } from '../tools/app-url.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); const SP = process.argv[2];
const OUT = path.join(SP, 'ui-cmyk'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch({ width: 1440, height: 900, scale: 1 });
let failed = 0; const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failed++; };
try {
  const page = await b.open(appUrl());
  await page.allowDownloads(path.join(OUT, 'dl'));
  await page.waitFor('window.__hb && window.__hb.assets.hb.logo', 20000);
  await page.setFiles('#fileInput', [path.join(SP, 'fx/cmyk.jpg')]);
  await page.eval("document.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }))");
  await page.waitFor('window.__hb.items.length === 1 && window.__hb.items[0].preview', 30000);
  check((await page.eval('window.__hb.items[0].insp.rawCapable')) === false, 'CMYK JPEG is routed to the browser decoder');
  check((await page.eval("document.getElementById('colorInfo').innerText")).includes('Converted by your browser'), 'the Export panel explains the color handling for this file');
  await page.click('#btnExport');
  await page.waitFor("window.__hb.items[0].status === 'done'", 30000); await sleep(800);
  const f = fs.readdirSync(path.join(OUT, 'dl'))[0];
  check(!!f, 'file downloaded: ' + f);
  const errs = page.logs.filter((l) => /^(error|EXCEPTION)/.test(l)); check(errs.length === 0, 'no console errors');
} catch (e) { console.log('ERROR', e.stack || e.message); failed++; } finally { await b.close(); }
process.exit(failed ? 1 : 0);
