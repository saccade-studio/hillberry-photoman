import fs from 'node:fs';
import { loadCore } from '../tools/load-core.mjs';
import { readPNM } from './pnm.mjs';
const HB = loadCore();
const dir = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(dir + '/manifest.json', 'utf8'));
let bad = 0, exact = 0, maxAll = 0;
const t0 = Date.now();
for (const c of manifest) {
  const bytes = new Uint8Array(fs.readFileSync(c.jpg));
  const ref = readPNM(c.ref);
  let res;
  try { res = HB.jpeg.decode(bytes); } catch (e) { console.log('THROW', c.name, c.w + 'x' + c.h, e.message); bad++; continue; }
  if (res.width !== ref.width || res.height !== ref.height) { console.log('DIM MISMATCH', c.jpg); bad++; continue; }
  let maxd = 0, nd = 0;
  const n = ref.width * ref.height;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const mine = res.rgb[i * 3 + k];
      const theirs = ref.channels === 3 ? ref.data[i * 3 + k] : ref.data[i];
      const d = Math.abs(mine - theirs);
      if (d) { nd++; if (d > maxd) maxd = d; }
    }
  }
  maxAll = Math.max(maxAll, maxd);
  if (maxd === 0) exact++;
  else { bad++; console.log(`DIFF  ${c.name.padEnd(9)} ${c.w}x${c.h}  max ${maxd}  differing samples ${nd}/${n * 3}`); }
}
console.log(`\n${manifest.length} cases: ${exact} bit-exact vs djpeg, ${bad} not. max diff ${maxAll}. (${Date.now() - t0} ms)`);
process.exit(bad ? 1 : 0);
