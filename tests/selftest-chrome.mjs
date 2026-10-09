// Opens the built app straight from disk (file://) in real headless Chrome and runs the built-in browser check.
import { launch } from '../tools/cdp.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appUrl } from '../tools/app-url.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const b = await launch();
try {
  const page = await b.open(appUrl() + '#selftest');
  await page.waitFor("!!document.getElementById('selftest-result')", 60000);
  console.log(await page.eval("document.getElementById('selftest-result').textContent"));
  console.log('console:', page.logs.filter((l) => !/^log:/.test(l)).join(' | ') || '(no warnings or errors)');
} finally { await b.close(); }
