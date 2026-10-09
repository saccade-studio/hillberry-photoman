// Loads the browser-side core modules into Node so they can be tested against reference tools.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(here, '..');
export function coreSource() {
  const dir = path.join(root, 'src', 'core');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}
export function loadCore() {
  return new Function(coreSource() + '\nreturn HB;')();
}
