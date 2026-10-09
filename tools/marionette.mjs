// Minimal Firefox Marionette driver (dependency-free) for testing the built app in real Firefox.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const FIREFOX = process.env.FIREFOX || '/Applications/Firefox.app/Contents/MacOS/firefox';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchFirefox({ port = 2828 + Math.floor(Math.random() * 400), width = 1440, height = 900 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ff-'));
  fs.writeFileSync(path.join(profile, 'user.js'), `user_pref("marionette.port", ${port});\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("datareporting.policy.dataSubmissionEnabled", false);\n`);
  const proc = spawn(FIREFOX, ['--headless', '--marionette', '--no-remote', '--profile', profile, `--width=${width}`, `--height=${height}`, 'about:blank'], { stdio: 'ignore' });
  const sock = new net.Socket();
  let buf = Buffer.alloc(0), id = 0;
  const msgs = [], waiters = [], pending = new Map();
  const deliver = (msg) => {
    if (Array.isArray(msg)) { const p = pending.get(msg[1]); if (p) { pending.delete(msg[1]); msg[2] ? p.reject(new Error(msg[2].message || JSON.stringify(msg[2]))) : p.resolve(msg[3]); } }
    else if (waiters.length) waiters.shift()(msg); else msgs.push(msg);
  };
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const colon = buf.indexOf(0x3A); if (colon < 1) return;
      const len = Number(buf.slice(0, colon).toString()); if (!Number.isFinite(len)) return;
      if (buf.length < colon + 1 + len) return;
      const body = buf.slice(colon + 1, colon + 1 + len).toString('utf8'); buf = buf.slice(colon + 1 + len);
      deliver(JSON.parse(body));
    }
  });
  let connected = false;
  for (let i = 0; i < 150 && !connected; i++) {
    connected = await new Promise((res) => { const onErr = () => res(false); sock.once('error', onErr); sock.connect(port, '127.0.0.1', () => { sock.off('error', onErr); res(true); }); });
    if (!connected) { sock.destroy(); await sleep(200); }
  }
  if (!connected) { proc.kill('SIGKILL'); throw new Error('could not connect to Firefox Marionette on port ' + port); }
  await (msgs.length ? Promise.resolve() : new Promise((r) => waiters.push(r))); // greeting
  const cmd = (name, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); const j = JSON.stringify([0, i, name, params]); sock.write(`${Buffer.byteLength(j)}:${j}`); });
  await cmd('WebDriver:NewSession', { capabilities: {} });
  return {
    async navigate(url) { await cmd('WebDriver:Navigate', { url }); },
    async eval(script) { const r = await cmd('WebDriver:ExecuteScript', { script: `return (${script});`, args: [] }); return r.value; },
    async waitFor(expr, ms = 60000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await this.eval(expr)) return true; } catch (e) { /* page not ready */ } await sleep(200); } throw new Error('timeout waiting for ' + expr); },
    async screenshot(file) { const r = await cmd('WebDriver:TakeScreenshot', { full: false }); fs.writeFileSync(file, Buffer.from(r.value, 'base64')); },
    async close() { try { await cmd('Marionette:Quit'); } catch (e) { /* ignore */ } await sleep(300); proc.kill('SIGKILL'); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ } },
  };
}
