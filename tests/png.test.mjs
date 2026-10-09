import fs from 'node:fs';
import { loadCore } from '../tools/load-core.mjs';
const HB = loadCore();
const dir = process.argv[2] + '/png';
const m = JSON.parse(fs.readFileSync(dir + '/png_cases.json', 'utf8'));
let bad = 0;
for (const [name, file] of Object.entries(m.files)) {
  const bytes = new Uint8Array(fs.readFileSync(`${dir}/${file}`));
  const d = await HB.png.decode(bytes);
  const e = m.expected[name];
  let maxd = 0;
  if (d.width !== e.w || d.height !== e.h) { bad++; console.log('FAIL dims', name); continue; }
  for (let i = 0; i < e.rgb.length; i++) maxd = Math.max(maxd, Math.abs(d.rgb[i] - e.rgb[i]));
  const ok = maxd <= 1;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(12)} ${d.width}x${d.height}  max diff vs PIL: ${maxd}`);
}
// encoder round trip through PIL
import { execFileSync } from 'node:child_process';
const rgb = new Uint8Array(m.expected.rgb8.rgb), w = m.expected.rgb8.w, h = m.expected.rgb8.h;
const enc = await HB.png.encode({ width: w, height: h, getRows(y0, n, out) { out.set(rgb.subarray(y0 * w * 3, (y0 + n) * w * 3)); }, icc: HB.icc.makeDisplayP3(), dpi: 300 });
fs.writeFileSync(dir + '/enc_test.png', enc);
const chk = execFileSync('python3', ['-c', `
from PIL import Image; import numpy as np, json
im = Image.open("${dir}/enc_test.png"); im.load()
e = json.load(open("${dir}/png_cases.json"))["expected"]["rgb8"]
arr = np.array(im.convert("RGB")).reshape(-1)
print("exact" if (arr == np.array(e["rgb"], np.uint8)).all() else "MISMATCH", "| icc:", len(im.info.get("icc_profile", b"")), "bytes | dpi:", tuple(round(x) for x in im.info.get("dpi", (0, 0))))
`]).toString().trim();
console.log('PNG encoder -> PIL:', chk);
if (!chk.startsWith('exact')) bad++;
console.log(bad ? bad + ' FAILURE(S)' : 'PNG: all checks passed');
process.exit(bad ? 1 : 0);
