// Captures assets/screenshot.png for the README:   node tools/make_readme_screenshot.mjs <photo.jpg> [out.png]
// The photo is only used to render the picture; keep licensed source images out of the repository.
import path from 'node:path';
import { launch } from './cdp.mjs';
import { appUrl, root } from './app-url.mjs';
const photo = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3] || path.join(root, 'assets', 'screenshot.png'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch({ width: 1440, height: 900, scale: 1 });
try {
  const page = await b.open(appUrl());
  await page.waitFor('window.__hb && window.__hb.assets.hb.logo', 20000);
  await page.setFiles('#fileInput', [photo]);
  await page.eval("document.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }))");
  await page.waitFor('window.__hb.items.length === 1 && window.__hb.items[0].preview', 40000);
  await page.click('.scott-card[data-aspect="scott-8x10"]'); await sleep(300);
  await page.click('#shadowStyleSeg [data-style="light"]'); await sleep(200);          // a warm glow keeps the dark-plum logo readable over the treeline
  await page.click('#cKindSeg [data-kind="text"]'); await sleep(150);
  await page.click('#cText'); await page.type('© Jane Photographer'); await sleep(600);
  await page.eval("document.activeElement && document.activeElement.blur(); document.getElementById('panelScroll').scrollTop = 0; window.scrollTo(0, 0)");
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 40 });   // park the pointer away from the crop frame
  await sleep(500);
  await page.screenshot(out);
  console.log('wrote', out);
} finally { await b.close(); }
