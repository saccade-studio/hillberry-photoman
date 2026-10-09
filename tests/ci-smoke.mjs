// Chrome smoke test of the BUILT site, portable enough for GitHub Actions (no Pillow / libjpeg / macOS profiles).
//   node build.mjs && node tests/ci-smoke.mjs
// Live mode:  HOSTED_URL=https://owner.github.io/repo/ [EXPECT_SHA=abc1234] node tests/ci-smoke.mjs   checks the deployed site itself.
// Covers: the shared offline file (file://), the hosted site (served under a sub-path like a Pages project site),
// the "download offline copy" link, and proof that the Content-Security-Policy really blocks all network access.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../tools/cdp.mjs';
import { root } from '../tools/app-url.mjs';

const dist = path.join(root, 'dist');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failed++; };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// a local stand-in for https://<owner>.github.io/<repo>/  (or, in live mode, the real deployed site)
const live = !!process.env.HOSTED_URL;
let server = null, hosted;
if (live) hosted = process.env.HOSTED_URL.replace(/\/?$/, '/');
else {
  const port = 8800 + Math.floor(Math.random() * 150), base = '/hillberry-photoman/';
  server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), dist, String(port), base], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { server.stdout.on('data', (d) => /serving/.test(String(d)) && res()); server.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server did not start')), 8000); });
  hosted = `http://127.0.0.1:${port}${base}`;
}
const b = await launch({ width: 1280, height: 800, scale: 1 });

async function selfTest(url, label) {
  const page = await b.open(url + '#selftest');
  await page.waitFor("!!document.getElementById('selftest-result')", 60000);
  const text = await page.eval("document.getElementById('selftest-result').textContent");
  console.log(text.split('\n').map((l) => '       ' + l).slice(0, 10).join('\n'));
  check(text.startsWith('SELFTEST PASS'), `${label}: built-in browser check passes`);
  const errs = page.logs.filter((l) => /^(error|EXCEPTION)/.test(l));
  check(errs.length === 0, `${label}: no console errors${errs.length ? ' → ' + errs.join(' | ') : ''}`);
  return page;
}

try {
  let page;
  if (!live) {
    // ---- 1. the offline file, opened straight from disk
    page = await selfTest('file://' + path.join(dist, 'Hillberry-PhotoMan.html'), 'offline copy (file://)');
    check(await page.eval("document.getElementById('aboutHosted').hidden && document.getElementById('offlineLinkRow').hidden && !document.getElementById('aboutOffline').hidden"),
      'offline copy: no "download" prompt, says it is an offline copy');
    page.close();
  }

  // ---- 2. the hosted site
  page = await selfTest(hosted, live ? 'LIVE site' : 'hosted site');
  check(await page.eval("!document.getElementById('aboutHosted').hidden && !document.getElementById('offlineLinkRow').hidden && document.getElementById('aboutOffline').hidden"),
    'hosted site: offers the offline copy for download');
  check(/Hillberry PhotoMan \d+\.\d+\.\d+, built \d{4}-\d{2}-\d{2}/.test(await page.eval("document.getElementById('aboutBuild').textContent")), 'version and build date are shown');

  if (live) {
    check(await page.eval("document.querySelector('link[rel=canonical]') && document.querySelector('link[rel=canonical]').href") === hosted, 'canonical link points at the live URL');
    const text = await page.eval("document.getElementById('aboutBuild').textContent");
    console.log('       ' + text);
    if (process.env.EXPECT_SHA) check(text.includes('(' + process.env.EXPECT_SHA + ')'), `the deployed build is commit ${process.env.EXPECT_SHA}`);
    const a = Buffer.from(await (await fetch(hosted)).arrayBuffer()), c = Buffer.from(await (await fetch(hosted + 'Hillberry-PhotoMan.html')).arrayBuffer());
    check(sha(a) === sha(c) && a.length > 300000, `index.html and Hillberry-PhotoMan.html are served identically (${(a.length / 1024).toFixed(0)} KB)`);
    check((await fetch(hosted + 'does-not-exist')).status === 404, 'unknown paths return 404');
  }

  // ---- 3. the download link delivers the exact offline file
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-dl-'));
  await page.allowDownloads(dl);
  await page.eval("document.getElementById('aboutDownload').click()");
  let got = null;
  for (let i = 0; i < 60 && !got; i++) { await sleep(250); got = fs.readdirSync(dl).find((f) => !f.endsWith('.crdownload')); }
  check(got === 'Hillberry-PhotoMan.html', 'download link saves "Hillberry-PhotoMan.html"');
  const expected = live ? Buffer.from(await (await fetch(hosted + 'Hillberry-PhotoMan.html')).arrayBuffer()) : fs.readFileSync(path.join(dist, 'Hillberry-PhotoMan.html'));
  check(got && sha(fs.readFileSync(path.join(dl, got))) === sha(expected), 'the downloaded file is byte-identical to the offline copy the site serves');
  fs.rmSync(dl, { recursive: true, force: true });

  // ---- 4. the Content-Security-Policy really blocks every way out.
  // Each probe uses its own URL; the browser must report a policy violation for every one of them.
  const probes = await page.eval(`(async () => {
    const seen = [];
    document.addEventListener('securitypolicyviolation', (e) => seen.push({ uri: e.blockedURI, dir: e.violatedDirective }));
    const tries = {
      fetch: () => fetch('https://example.com/probe-fetch').then(() => 'ALLOWED', () => 'blocked'),
      fetchLocal: () => fetch('http://127.0.0.1:1/probe-local').then(() => 'ALLOWED', () => 'blocked'),
      image: () => new Promise((res) => { const i = new Image(); i.onload = () => res('ALLOWED'); i.onerror = () => res('blocked'); i.src = 'https://example.com/probe-image.png'; }),
      script: () => new Promise((res) => { const s = document.createElement('script'); s.onload = () => res('ALLOWED'); s.onerror = () => res('blocked'); s.src = 'https://example.com/probe-script.js'; document.head.appendChild(s); }),
      websocket: () => new Promise((res) => { try { const w = new WebSocket('wss://example.com/probe-ws'); w.onopen = () => res('ALLOWED'); w.onerror = () => res('blocked'); w.onclose = () => res('blocked'); } catch (e) { res('blocked'); } }),
      beacon: async () => { try { navigator.sendBeacon('https://example.com/probe-beacon', 'x'); } catch (e) { /* ignore */ } return 'queued'; },
    };
    const out = {};
    for (const [k, f] of Object.entries(tries)) out[k] = await f();
    await new Promise((res) => setTimeout(res, 500));
    return { out, seen };
  })()`);
  console.log('       ', JSON.stringify(probes.out));
  for (const [k, needle] of [['fetch', 'probe-fetch'], ['fetchLocal', 'probe-local'], ['image', 'probe-image'], ['script', 'probe-script'], ['websocket', 'probe-ws'], ['beacon', 'probe-beacon']]) {
    const v = probes.seen.find((x) => x.uri.includes(needle));
    check(!!v, `${k}: refused by the browser (${v ? v.dir : 'NO VIOLATION RECORDED'})`);
  }
  check(!Object.values(probes.out).includes('ALLOWED'), 'no probe was allowed through');
  page.close();
} catch (e) { console.log('ERROR', e.stack || e.message); failed++; }
finally { await b.close(); if (server) server.kill(); }
console.log(failed ? `\n${failed} FAILURE(S)` : '\nsmoke test: all checks passed');
process.exit(failed ? 1 : 0);
