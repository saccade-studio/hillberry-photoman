import fs from 'node:fs';
import { loadCore } from '../tools/load-core.mjs';
const HB = loadCore();
const SP = process.argv[2];
const file = process.argv[3];
const lj = JSON.parse(fs.readFileSync(SP + '/logo.json', 'utf8'));
const trimmed = HB.marks.trim(new Uint8Array(fs.readFileSync(SP + '/logo.rgba')), lj.w, lj.h, 4);
const bytes = new Uint8Array(fs.readFileSync(file));
const insp = await HB.pipeline.inspect(bytes);
console.log(`${file.split('/').pop()}  ${insp.width}x${insp.height} = ${(insp.width * insp.height / 1e6).toFixed(1)} MP, ${(bytes.length / 1e6).toFixed(1)} MB, profile: ${insp.profile && insp.profile.description}`);
const crop = { x: 0, y: 0, w: Math.floor(insp.height * 4 / 5), h: insp.height }; // 4:5 portrait crop, as large as possible
const style = { margin: 0.03, opacity: 1, shadow: { on: true, strength: 0.6, blur: 0.2, distance: 0.2, angle: 45, color: [0, 0, 0] } };
const marks = [{ side: 'right', logo: trimmed, size: 0.3 }, { side: 'left', logo: trimmed, size: 0.2 }];
let peak = 0;
const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
const stages = {};
const t0 = Date.now();
const res = await HB.pipeline.run({ id: 1, source: { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }, crop, marks, style, out: { format: 'jpeg', quality: 100, chroma: '444', optimize: true, metadata: 'all' } },
  (m) => { if (!stages[m.stage]) stages[m.stage] = Date.now() - t0; });
clearInterval(iv);
console.log(`export ${res.width}x${res.height} (${(res.width * res.height / 1e6).toFixed(1)} MP): ${((Date.now() - t0) / 1000).toFixed(1)} s total, output ${(res.bytes.length / 1e6).toFixed(1)} MB, peak RSS ${(peak / 1e6).toFixed(0)} MB`);
console.log('  decode finished at', stages.encode, 'ms (encode started)');
fs.writeFileSync(SP + '/big_out.jpg', res.bytes);
