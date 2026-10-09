// Truncated / corrupted / exotic files must fail gracefully (HBError) or decode partially. Never hang, never crash weirdly.
import fs from 'node:fs';
import { loadCore } from '../tools/load-core.mjs';
const HB = loadCore();
const SP = process.argv[2];
const corpus = JSON.parse(fs.readFileSync(SP + '/corpus/manifest.json', 'utf8'));
let bad = 0;
const fail = (m) => { bad++; console.log('FAIL', m); };

// 1. unsupported formats are reported as 'unsupported' so the UI can fall back to the browser's decoder
for (const [file, label] of [['cmyk.jpg', 'CMYK'], ['arith.jpg', 'arithmetic-coded']]) {
  const p = `${SP}/fx/${file}`;
  if (!fs.existsSync(p)) { console.log('skip', label, '(no sample)'); continue; }
  try { HB.jpeg.decode(new Uint8Array(fs.readFileSync(p))); fail(label + ' should have been rejected'); }
  catch (e) { console.log(e.code === 'unsupported' ? 'ok  ' : 'FAIL', label, '->', e.code, '-', e.message); if (e.code !== 'unsupported') bad++; }
}

// 2. truncation at many positions: decodes what it can, correct dimensions, never throws a non-HBError
const picks = corpus.filter((c) => c.w === 255 && ['420', '444prog', '420prog', '420rst', 'gray', 'rst_prog', 'scans_seq'].includes(c.name));
let partial = 0, errs = 0;
for (const c of picks) {
  const full = new Uint8Array(fs.readFileSync(c.jpg));
  for (const frac of [0.02, 0.1, 0.3, 0.5, 0.8, 0.95, 0.999]) {
    const cut = full.subarray(0, Math.max(4, Math.floor(full.length * frac)));
    try { const r = HB.jpeg.decode(cut); if (r.width !== c.w || r.height !== c.h) fail(`${c.name} cut ${frac}: wrong dims`); partial++; }
    catch (e) { if (!(e && e.name === 'HBError')) fail(`${c.name} cut ${frac}: ${e && e.stack}`); else errs++; }
  }
}
console.log(`truncation: ${partial} partial decodes, ${errs} clean HBErrors, no crashes`);

// 3. random corruption (fuzz) with a time budget per file
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let ok = 0, hb = 0, slowest = 0;
for (let n = 0; n < 400; n++) {
  const c = picks[Math.floor(rnd() * picks.length)];
  const data = new Uint8Array(fs.readFileSync(c.jpg));
  const flips = 1 + Math.floor(rnd() * 8);
  for (let i = 0; i < flips; i++) data[Math.floor(rnd() * data.length)] = Math.floor(rnd() * 256);
  const t0 = Date.now();
  try { HB.jpeg.decode(data); ok++; }
  catch (e) { if (!(e && e.name === 'HBError')) fail(`fuzz ${n} (${c.name}): ${e && e.stack}`); else hb++; }
  slowest = Math.max(slowest, Date.now() - t0);
}
console.log(`fuzz: 400 corrupted files -> ${ok} decoded, ${hb} rejected cleanly; slowest ${slowest} ms`);
if (slowest > 5000) fail('a corrupted file took too long');
console.log(bad ? bad + ' FAILURE(S)' : 'robustness: all checks passed');
process.exit(bad ? 1 : 0);
