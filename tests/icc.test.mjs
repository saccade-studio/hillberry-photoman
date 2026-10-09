import fs from 'node:fs';
import { loadCore } from '../tools/load-core.mjs';
const HB = loadCore();
const SP = process.argv[2];
const ref = JSON.parse(fs.readFileSync(SP + '/icc_ref.json', 'utf8'));
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log('  FAIL:', msg); } };

console.log('sRGB D50 matrix (expect ~ .4361 .3851 .1431 / .2225 .7169 .0606 / .0139 .0971 .7142):');
console.log('  ', HB.icc._internal.SRGB_TO_XYZ_D50.map((x) => x.toFixed(4)).join(' '));
console.log('P3 D50 matrix (Apple: .5151 .2919 .1572 / .2412 .6923 .0666 / -.0011 .0419 .7841):');
console.log('  ', HB.icc._internal.P3_TO_XYZ_D50.map((x) => x.toFixed(4)).join(' '));

for (const [name, r] of Object.entries(ref)) {
  const bytes = new Uint8Array(fs.readFileSync(r.path));
  const info = HB.icc.parse(bytes);
  console.log(`\n${name}: kind=${info && info.kind} desc="${info && info.description}" v${info && info.version} (${bytes.length} bytes)`);
  check(info && info.kind === 'matrix', 'should be matrix profile');
  if (!info || info.kind !== 'matrix') continue;
  const conv = HB.icc.createSRGBConverter(info);
  let maxd = 0, sum = 0, n = 0, worst = null;
  for (let i = 0; i < r.in.length; i++) {
    const o = conv.convertColor(r.in[i]);
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(Math.round(o[c]) - r.out[i][c]);
      sum += d; n++;
      if (d > maxd) { maxd = d; worst = { in: r.in[i], mine: o.map(Math.round), lcms: r.out[i] }; }
    }
  }
  console.log(`  vs littleCMS over ${r.in.length} colors: max diff ${maxd}, mean ${(sum / n).toFixed(3)}   worst:`, JSON.stringify(worst));
  check(maxd <= 2, 'max diff should be <= 2 levels');
}

// generated profiles must be readable by littleCMS and parse back identically
for (const [nm, bytes] of [['sRGB', HB.icc.makeSRGB()], ['P3', HB.icc.makeDisplayP3()]]) {
  fs.writeFileSync(`${SP}/gen_${nm}.icc`, bytes);
  const info = HB.icc.parse(bytes);
  console.log(`\ngenerated ${nm}: ${bytes.length} bytes, parse kind=${info.kind} desc="${info.description}"`);
  check(info.kind === 'matrix', 'generated profile should parse as matrix');
}
const sconv = HB.icc.createSRGBConverter(HB.icc.parse(HB.icc.makeSRGB()));
console.log('generated sRGB profile as converter target: identity =', sconv.identity, 'maxDiff', sconv.maxDiff.toFixed(3));
check(sconv.identity, 'sRGB -> generated sRGB must be identity');
console.log(failures ? `\n${failures} FAILURE(S)` : '\nICC: all checks passed');
process.exit(failures ? 1 : 0);
