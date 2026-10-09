// ---------------------------------------------------------------------------------------------
// Export: runs the HB pipeline in a Web Worker (or on the main thread if workers are unavailable),
// falls back to the browser's own decoder for formats we don't decode ourselves, and packages the results.

const WORKER_GLUE = `
self.onmessage = async function (e) {
  const msg = e.data;
  if (msg.type === 'ping') { self.postMessage({ type: 'pong' }); return; }
  try {
    const res = await HB.pipeline.run(msg, function (m) { self.postMessage(m); });
    self.postMessage({ type: 'done', id: msg.id, result: res }, [res.bytes.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, code: (err && err.code) || 'error', message: (err && err.message) || String(err) });
  }
};`;

const engine = {
  worker: null, url: '', mode: 'main', pending: new Map(), seq: 1, starting: null,

  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.mode = 'main';
      if (!CAPS.worker) return;
      try {
        const src = document.getElementById('hb-core').textContent + '\n' + WORKER_GLUE;
        this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const w = new Worker(this.url);
        const ok = await new Promise((resolve) => {
          const t = setTimeout(() => resolve(false), 4000);
          w.onmessage = (e) => { if (e.data && e.data.type === 'pong') { clearTimeout(t); resolve(true); } };
          w.onerror = () => { clearTimeout(t); resolve(false); };
          w.postMessage({ type: 'ping' });
        });
        if (!ok) { w.terminate(); return; }
        w.onmessage = (e) => this.onMessage(e.data);
        w.onerror = (e) => {
          e.preventDefault && e.preventDefault();
          this.failAll('worker', 'The export engine stopped unexpectedly (the photo may be too large for this browser).');
          this.worker = null; this.starting = null; this.mode = 'main';
          this.start();
        };
        this.worker = w; this.mode = 'worker';
      } catch (e) { this.worker = null; this.mode = 'main'; }
    })();
    return this.starting;
  },

  onMessage(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') { if (p.onProgress) p.onProgress(m); }
    else if (m.type === 'done') { this.pending.delete(m.id); p.resolve(m.result); }
    else if (m.type === 'error') { this.pending.delete(m.id); const e = new Error(m.message); e.code = m.code; p.reject(e); }
  },

  failAll(code, message) {
    for (const [, p] of this.pending) { const e = new Error(message); e.code = code; p.reject(e); }
    this.pending.clear();
  },

  async run(req, transfer, onProgress) {
    await this.start();
    return new Promise((resolve, reject) => {
      const id = this.seq++;
      req.id = id;
      this.pending.set(id, { resolve, reject, onProgress });
      if (this.mode === 'worker') { this.worker.postMessage(req, transfer || []); return; }
      setTimeout(async () => {
        try {
          const res = await HB.pipeline.run(req, (m) => { if (onProgress) onProgress(m); });
          this.pending.delete(id); resolve(res);
        } catch (e) { this.pending.delete(id); reject(e); }
      }, 30);
    });
  },

  cancel() {
    this.failAll('cancelled', 'Cancelled');
    if (this.worker) { this.worker.terminate(); this.worker = null; this.starting = null; this.start(); }
  },
};

/** Decode with the browser and hand back raw RGB in Display P3 (or sRGB). Used for HEIC/WebP/TIFF/CMYK/LUT-profile files. */
async function nativeRaster(item) {
  const { img, url } = await decodeImageEl(item.file);
  try {
    const W = img.naturalWidth, H = img.naturalHeight;
    if (W * H > 268e6) throw new Error('This photo is too large for your browser to convert.');
    const p3 = CAPS.p3canvas;
    const c = canvasOf(W, H);
    const x = c.getContext('2d', { colorSpace: p3 ? 'display-p3' : 'srgb', willReadFrequently: true });
    x.drawImage(img, 0, 0);
    // Some browsers silently refuse very large canvases; make sure we really got pixels before trusting them.
    let seen = 0;
    for (const [px, py] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W >> 1, H >> 1]]) seen += x.getImageData(px, py, 1, 1).data[3];
    if (seen === 0) throw new Error('This browser could not decode the photo at full size. Try a smaller photo, or another browser.');
    const rgb = new Uint8Array(W * H * 3);
    const STRIP = 256;
    for (let y0 = 0; y0 < H; y0 += STRIP) {
      const n = Math.min(STRIP, H - y0);
      const d = x.getImageData(0, y0, W, n, p3 ? { colorSpace: 'display-p3' } : undefined).data;
      let o = y0 * W * 3;
      for (let i = 0, m = W * n * 4; i < m; i += 4) {
        const a = d[i + 3];
        if (a === 255) { rgb[o++] = d[i]; rgb[o++] = d[i + 1]; rgb[o++] = d[i + 2]; }
        else { const k = 255 - a; rgb[o++] = Math.round(d[i] * a / 255 + k); rgb[o++] = Math.round(d[i + 1] * a / 255 + k); rgb[o++] = Math.round(d[i + 2] * a / 255 + k); }
      }
    }
    return { width: W, height: H, buffer: rgb.buffer, space: p3 ? 'display-p3' : 'srgb' };
  } finally { URL.revokeObjectURL(url); }
}

function snapshotCommon() {
  return {
    marks: activeMarks().map((m) => ({ side: m.side, size: m.size, logo: { w: m.logo.w, h: m.logo.h, rgba: m.logo.rgba } })),
    style: styleSettings(),
    out: { quality: S.out.quality, chroma: S.out.chroma, optimize: S.out.optimize, metadata: S.out.metadata },
    suffix: S.out.suffix,
  };
}

function requestFor(item, common) {
  const crop = getCrop(item), pi = printInfo(item, crop);
  return {
    type: 'export', crop, marks: common.marks, style: common.style,
    out: Object.assign({ format: outputFormatFor(item), dpi: pi ? Math.round(pi.ppi) : null }, common.out),
    expect: { width: item.W, height: item.H },
  };
}

function outName(item, ext, suffix) {
  const base = item.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
  return `${base}${suffix || ''}${cropTag(item)}.${ext}`;
}

async function renderItem(item, common, onProgress) {
  const req = requestFor(item, common);
  if (item.insp && item.insp.rawCapable) {
    const buf = await item.file.arrayBuffer();
    req.source = { bytes: buf };
    try { return await engine.run(req, [buf], onProgress); }
    catch (e) { if (e.code !== 'unsupported' && e.code !== 'corrupt') throw e; }
  }
  const raster = await nativeRaster(item);
  const req2 = requestFor(item, common);
  req2.source = { raster };
  req2.expect = { width: raster.width, height: raster.height };
  return engine.run(req2, [raster.buffer], onProgress);
}

// ---- UI state while exporting -----------------------------------------------------------------------
let busy = false, cancelled = false;
function setBusy(on) {
  busy = on;
  $('btnExport').disabled = on || !items.length;
  $('btnExportAll').disabled = on;
  $('progressWrap').hidden = !on;
  if (!on) { $('progressFill').style.width = '0%'; }
  updateExportLabels();
}
function setProgress(label, f) {
  $('progressLabel').textContent = label;
  $('progressFill').style.width = Math.round(clamp(f, 0, 1) * 100) + '%';
  $('progressPct').textContent = Math.round(clamp(f, 0, 1) * 100) + '%';
}
window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

async function runOne(item, index, total, common) {
  item.status = 'busy'; item.error = ''; updateThumb(item); updateExportLabels();
  const label = total > 1 ? `${index + 1}/${total} · ${item.name}` : item.name;
  setProgress(label, index / total);
  try {
    const res = await renderItem(item, common, (m) => {
      const frac = m.stage === 'decode' ? 0.35 * m.fraction : 0.35 + 0.65 * m.fraction;
      setProgress(label, (index + frac) / total);
    });
    const ext = res.mime === 'image/png' ? 'png' : 'jpg';
    const blob = new Blob([res.bytes], { type: res.mime });
    item.status = 'done';
    item.result = { size: blob.size, width: res.width, height: res.height, note: res.info && res.info.note };
    if (res.info && res.info.damaged) toast(`${item.name} looks damaged or incomplete, so parts of the exported image may be missing.`, 'err', 12000);
    updateThumb(item);
    return { item, blob, crc: res.crc, name: outName(item, ext, common.suffix), res };
  } catch (e) {
    item.status = e.code === 'cancelled' ? 'idle' : 'error';
    item.error = friendlyError(e);
    updateThumb(item);
    throw e;
  }
}

function friendlyError(e) {
  if (e && e.code === 'memory') return 'This photo is too large for your browser’s memory. Try a smaller crop or a desktop browser.';
  if (e && e.code === 'cancelled') return 'Cancelled';
  return (e && e.message) || 'Export failed';
}

function saveBlob(blob, name) {
  if (window.__hb && typeof window.__hb.onSave === 'function') { window.__hb.onSave(blob, name); return; } // test seam
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
}

function describe(r) {
  return `${fmtInt(r.res.width)} × ${fmtInt(r.res.height)} px · ${fmtBytes(r.blob.size)}`;
}

async function exportCurrent() {
  const item = current();
  if (!item || busy) return;
  cancelled = false;
  setBusy(true);
  try {
    const r = await runOne(item, 0, 1, snapshotCommon());
    saveBlob(r.blob, r.name);
    toast(`Saved ${r.name} — ${describe(r)}`, 'ok');
  } catch (e) {
    if (e.code !== 'cancelled') toast(`${item.name}: ${friendlyError(e)}`, 'err');
  } finally { setBusy(false); syncColorInfo(); }
}

async function exportAll() {
  if (busy || !items.length) return;
  cancelled = false;
  setBusy(true);
  const common = snapshotCommon();
  const list = items.slice();
  const done = [], failed = [];
  try {
    for (let i = 0; i < list.length; i++) {
      if (cancelled) break;
      try { done.push(await runOne(list[i], i, list.length, common)); }
      catch (e) { if (e.code === 'cancelled') break; failed.push(list[i]); }
    }
    if (done.length) {
      if (S.out.zip && done.length > 1) {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
        let part = [], size = 0, n = 1;
        const flush = (last) => {
          if (!part.length) return;
          const parts = HB.zip.build(part.map((r) => ({ name: r.name, size: r.blob.size, crc: r.crc, data: r.blob })));
          saveBlob(new Blob(parts, { type: 'application/zip' }), `Hillberry-PhotoMan-${stamp}${last && n === 1 ? '' : '-' + n}.zip`);
          n++; part = []; size = 0;
        };
        for (const r of done) {
          if (size + r.blob.size > 1.5 * 1024 * 1024 * 1024) flush(false);
          part.push(r); size += r.blob.size;
        }
        flush(true);
      } else {
        for (const r of done) { saveBlob(r.blob, r.name); await sleep(450); }
      }
    }
    const total = done.reduce((a, r) => a + r.blob.size, 0);
    if (cancelled) toast(`Cancelled. ${done.length} photo${done.length === 1 ? '' : 's'} finished and ${done.length ? 'saved' : 'none saved'}.`);
    else if (failed.length) toast(`${done.length} exported (${fmtBytes(total)}). ${failed.length} failed: ${failed.map((f) => f.name).join(', ')}`, 'err');
    else toast(`Exported ${done.length} photos (${fmtBytes(total)}).`, 'ok');
  } finally { setBusy(false); }
}

$('btnExport').addEventListener('click', exportCurrent);
$('btnExportAll').addEventListener('click', exportAll);
$('btnCancel').addEventListener('click', () => { cancelled = true; engine.cancel(); });
