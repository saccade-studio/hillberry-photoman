// Screenshots of the app at several viewport sizes (for visual review).
import { launch } from '../tools/cdp.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appUrl } from '../tools/app-url.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SP = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [name, w, h, scale] of [['phone', 390, 844, 2], ['tablet', 820, 1180, 2]]) {
  const b = await launch({ width: w, height: h, scale });
  try {
    const page = await b.open(appUrl());
    await page.waitFor('window.__hb && window.__hb.assets.hb.logo', 20000);
    await page.screenshot(path.join(SP, `shot-${name}-empty.png`));
    await page.setFiles('#fileInput', [path.join(SP, 'fx/photo_p3.jpg'), path.join(SP, 'fx/photo_adobe.jpg')]);
    await page.eval("document.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }))");
    await page.waitFor('window.__hb.items.length === 2 && window.__hb.items[0].preview', 30000);
    await page.click('.scott-card[data-aspect="scott-13x19"]'); await sleep(400);
    await page.eval("window.__hb.S.mine.kind='text'; window.__hb.S.mine.text='© Jane Photographer'; window.__hb.S.mine.enabled=true; window.__hb.setAsset('mine', window.__hb.renderTextLogo(window.__hb.S.mine), 'x'); window.__hb.afterMarksChanged();");
    await sleep(500);
    await page.eval('window.scrollTo(0,0)'); await sleep(300);
    await page.screenshot(path.join(SP, `shot-${name}-editor.png`));
    console.log(name, 'done', await page.eval('innerWidth + "x" + innerHeight'));
  } finally { await b.close(); }
}
