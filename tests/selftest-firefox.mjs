import { launchFirefox } from '../tools/marionette.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appUrl } from '../tools/app-url.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ff = await launchFirefox();
try {
  await ff.navigate(appUrl() + '#selftest');
  await ff.waitFor("!!document.getElementById('selftest-result')", 90000);
  console.log(await ff.eval("document.getElementById('selftest-result').textContent"));
} finally { await ff.close(); }
