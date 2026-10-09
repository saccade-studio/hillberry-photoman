// Minimal Chrome DevTools Protocol driver (no dependencies) for testing the built app in a real browser.
//   const b = await launch(); const p = await b.open(url); await p.eval('1+1'); await b.close();
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else if (m.method) (this.handlers.get(m.method) || []).forEach((h) => h(m.params));
    };
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(method, fn) { this.handlers.set(method, (this.handlers.get(method) || []).concat(fn)); }
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async setFiles(selector, files) {
    const doc = await this.send('DOM.getDocument');
    const q = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    await this.send('DOM.setFileInputFiles', { files, nodeId: q.nodeId });
  }
  async screenshot(file, opts = {}) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', ...opts });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  async waitFor(expr, ms = 30000, step = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await this.eval(expr).catch(() => false)) return true; await sleep(step); }
    throw new Error('timeout waiting for: ' + expr);
  }
  async rect(selector) {
    const r = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    if (!r) throw new Error('no element: ' + selector);
    return r;
  }
  async mouse(type, x, y, extra = {}) { await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }); }
  async click(selector) {
    const r = await this.rect(selector); const x = r.x + r.w / 2, y = r.y + r.h / 2;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.mouse('mousePressed', x, y); await this.mouse('mouseReleased', x, y);
  }
  async drag(x0, y0, x1, y1, steps = 12) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
    await this.mouse('mousePressed', x0, y0);
    for (let i = 1; i <= steps; i++) await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, button: 'left', buttons: 1 });
    await this.mouse('mouseReleased', x1, y1);
  }
  async type(text) { for (const ch of text) { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); } }
  async key(key, code, vk) { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk }); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); }
  async allowDownloads(dir) { fs.mkdirSync(dir, { recursive: true }); await this.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }); }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

export async function launch({ port = 9333 + Math.floor(Math.random() * 500), width = 1440, height = 900, scale = 1 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-chrome-'));
  if (!CHROME) throw new Error('Chrome/Chromium not found. Set the CHROME environment variable to its path.');
  const linux = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];   // CI containers
  const proc = spawn(CHROME, [...linux, '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', `--window-size=${width},${height}`, `--force-device-scale-factor=${scale}`, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch (e) { /* not up yet */ } await sleep(100); }
  return {
    async open(url) {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = t.find((x) => x.type === 'page');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      const s = new Session(ws);
      await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('DOM.enable');
      const logs = []; s.logs = logs;
      s.on('Runtime.consoleAPICalled', (p) => logs.push(p.type + ': ' + p.args.map((a) => a.value ?? a.description).join(' ')));
      s.on('Runtime.exceptionThrown', (p) => logs.push('EXCEPTION: ' + (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text)));
      await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      const loaded = new Promise((r) => s.on('Page.loadEventFired', r));
      await s.send('Page.navigate', { url });
      await loaded;
      return s;
    },
    async close() { try { await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).then((v) => { const w = new WebSocket(v.webSocketDebuggerUrl); w.onopen = () => { w.send(JSON.stringify({ id: 1, method: 'Browser.close' })); }; }); } catch (e) { /* ignore */ } await sleep(300); proc.kill('SIGKILL'); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ } },
  };
}
