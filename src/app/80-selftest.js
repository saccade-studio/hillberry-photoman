// ---------------------------------------------------------------------------------------------
// "Browser check": a real export round-trip on a built-in test image. Shown in Help, and run automatically
// when the page is opened with #selftest (used to verify the shared file in different browsers).

function makeTestPhoto() {
  const W = 640, H = 480, rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    rgb[i] = 40 + 180 * x / W; rgb[i + 1] = 70 + 120 * Math.sin(x / 55) * Math.cos(y / 70) + 60; rgb[i + 2] = 200 - 150 * y / H;
  }
  const p3 = HB.icc.makeDisplayP3();
  const jpg = HB.jpegEnc.encode({
    width: W, height: H, quality: 92, subsampling: '420', optimize: false, segments: HB.exif.iccSegments(p3),
    getRows(y0, n, out) { out.set(rgb.subarray(y0 * W * 3, (y0 + n) * W * 3)); },
  });
  return { jpg, W, H, p3, rgb };
}

async function runSelfTest() {
  const results = [];
  const add = (name, ok, detail, info) => results.push({ name, ok: !!ok, detail: detail || '', info: !!info });

  let storageOK = false;
  try { localStorage.setItem('hb-test', '1'); storageOK = localStorage.getItem('hb-test') === '1'; localStorage.removeItem('hb-test'); } catch (e) { /* ignore */ }
  add('Remembers your settings', storageOK, storageOK ? 'saved in this browser' : 'unavailable here (settings reset each time; everything else works)', true);

  await engine.start();
  add('Background export engine', engine.mode === 'worker', engine.mode === 'worker' ? 'Web Worker (the page stays responsive)' : 'main thread (works, but the page pauses while exporting)', true);
  add('Wide-gamut preview', CAPS.p3canvas, CAPS.p3canvas ? 'Display P3 canvas' : 'previews are shown in sRGB (exports are unaffected)', true);
  add('PNG export available', CAPS.compression, CAPS.compression ? 'yes' : 'not supported by this browser version (JPEG works)', true);
  add('EXIF rotation handled by the browser', true, CAPS.autoOrient ? 'yes' : 'no, handled by PhotoMan', true);

  try {
    const t = makeTestPhoto();
    const logo = assets.hb.logo || { w: 40, h: 20, rgba: new Uint8Array(40 * 20 * 4).fill(255) };
    const style = { margin: 0.03, opacity: 1, shadow: { on: true, strength: 0.6, blur: 0.2, distance: 0.2, angle: 45, color: [0, 0, 0] } };
    const base = { type: 'export', crop: { x: 40, y: 0, w: 480, h: 480 }, marks: [{ side: 'right', size: 0.4, logo: { w: logo.w, h: logo.h, rgba: logo.rgba } }], style, expect: { width: t.W, height: t.H } };
    const t0 = performance.now();
    const buf = t.jpg.buffer.slice(t.jpg.byteOffset, t.jpg.byteOffset + t.jpg.byteLength);
    const res = await engine.run(Object.assign({ source: { bytes: buf }, out: { format: 'jpeg', quality: 100, chroma: '444', optimize: true, metadata: 'all', dpi: null } }, base), [buf]);
    const dec = HB.jpeg.decode(res.bytes);
    const icc = dec.meta.icc;
    const sameICC = !!icc && icc.length === t.p3.length && icc.every((v, i) => v === t.p3[i]);
    add('JPEG export keeps the color profile', dec.width === 480 && dec.height === 480 && sameICC, `${dec.width}×${dec.height}, profile ${sameICC ? 'identical to the original' : 'CHANGED'}, ${Math.round(performance.now() - t0)} ms`);
    // watermark present in the bottom-right corner, photo untouched at top-left
    let topDiff = 0, cornerDiff = 0;
    for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) topDiff = Math.max(topDiff, Math.abs(dec.rgb[(y * 480 + x) * 3] - t.rgb[(y * t.W + x + 40) * 3]));
    for (let y = 400; y < 470; y++) for (let x = 330; x < 470; x++) cornerDiff = Math.max(cornerDiff, Math.abs(dec.rgb[(y * 480 + x) * 3] - t.rgb[(y * t.W + x + 40) * 3]));
    add('Watermark placed, photo otherwise untouched', topDiff <= 4 && cornerDiff > 30, `top-left change ${topDiff}, watermark change ${cornerDiff}`);
    const bmp = await createImageBitmap(new Blob([res.bytes], { type: 'image/jpeg' }));
    add('Browser can open the exported file', bmp.width === 480 && bmp.height === 480, `${bmp.width}×${bmp.height}`);
    if (CAPS.compression) {
      const buf2 = t.jpg.buffer.slice(t.jpg.byteOffset, t.jpg.byteOffset + t.jpg.byteLength);
      const png = await engine.run(Object.assign({ source: { bytes: buf2 }, out: { format: 'png', dpi: null } }, base), [buf2]);
      const sig = [0x89, 0x50, 0x4E, 0x47].every((v, i) => png.bytes[i] === v);
      const p = await HB.png.decode(png.bytes);
      add('PNG export', sig && p.width === 480 && p.height === 480 && !!p.icc, `${p.width}×${p.height}, profile embedded`);
    }
  } catch (e) { add('Export round-trip', false, (e && e.message) || String(e)); }
  return results;
}

function renderSelfTest(results) {
  const box = $('selfTestOut');
  box.textContent = '';
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'check-row ' + (r.ok ? 'ok' : (r.info ? 'note' : 'bad'));
    const b = document.createElement('b'); b.textContent = (r.ok ? '✓ ' : (r.info ? '○ ' : '✗ ')) + r.name;
    const s = document.createElement('span'); s.textContent = r.detail;
    row.append(b, s);
    box.appendChild(row);
  }
}
$('btnSelfTest').addEventListener('click', async () => {
  const btn = $('btnSelfTest');
  btn.disabled = true; btn.textContent = 'Checking…';
  try { renderSelfTest(await runSelfTest()); } finally { btn.disabled = false; btn.textContent = 'Run browser check again'; }
});

if (/selftest/.test(location.hash)) {
  window.addEventListener('load', async () => {
    const results = await runSelfTest();
    const pre = document.createElement('pre');
    pre.id = 'selftest-result';
    pre.textContent = (results.every((r) => r.ok || r.info) ? 'SELFTEST PASS' : 'SELFTEST FAIL') + '\n' + results.map((r) => `${r.ok ? 'ok  ' : (r.info ? 'note' : 'FAIL')} ${r.name} — ${r.detail}`).join('\n') + `\nUA: ${navigator.userAgent}\norigin: ${location.protocol}`;
    pre.style.cssText = 'position:fixed;inset:0;z-index:9999;margin:0;padding:24px;background:#000;color:#9f9;font:14px/1.5 monospace;white-space:pre-wrap;overflow:auto';
    document.body.appendChild(pre);
    document.title = pre.textContent.split('\n')[0];
  });
}
