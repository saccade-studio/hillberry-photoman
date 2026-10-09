// ---------------------------------------------------------------------------------------------
// Photo list: add / inspect / preview / thumbnails / selection
const PREVIEW_EDGE = 3200;
const MAX_PIXELS = 400e6;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|tiff?|gif|bmp|avif)$/i;

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => (f.type && f.type.startsWith('image/')) || IMAGE_EXT.test(f.name));
  if (!files.length) { toast('No image files found in what you dropped.', 'err'); return; }
  let first = null, failed = 0;
  for (const file of files) {
    const item = { id: nextId++, file, name: file.name, size: file.size, status: 'idle', crop: null, flip: false, W: 0, H: 0, insp: null, preview: null, thumb: '', thumbImg: null, result: null };
    try { await inspectItem(item); }
    catch (e) { failed++; toast(`${file.name}: ${e.message || 'could not be read'}`, 'err'); continue; }
    items.push(item);
    if (!first) first = item;
    renderFilmstrip();
    syncShell();
  }
  if (failed && !first) return;
  if (first && (!current() || files.length >= 1)) selectItem(first.id);
  queueThumbs();
}

async function inspectItem(item) {
  const f = item.file;
  let insp;
  const headLen = Math.min(f.size, 1.5 * 1048576);
  try { insp = await HB.pipeline.inspect(new Uint8Array(await f.slice(0, headLen).arrayBuffer())); }
  catch (e) {
    if (f.size > headLen) insp = await HB.pipeline.inspect(new Uint8Array(await f.arrayBuffer()));
    else throw new Error('this file looks damaged');
  }
  if (insp.width * insp.height > MAX_PIXELS) throw new Error(`too large (${fmtMP(insp.width, insp.height)} MP)`);
  if ((insp.format === 'jpeg' || insp.format === 'png') && !CAPS.compression && insp.format === 'png') insp.rawCapable = false;
  item.insp = insp;
  item.W = insp.width; item.H = insp.height;
}

// ---- scaling helpers ------------------------------------------------------------------------------
function downscale(src, sw, sh, dw, dh, p3) {
  let cur = src, cw = sw, ch = sh;
  while (cw > dw * 2 || ch > dh * 2) {
    const nw = Math.max(dw, Math.ceil(cw / 2)), nh = Math.max(dh, Math.ceil(ch / 2));
    const c = canvasOf(nw, nh);
    const x = ctx2d(c, { p3 });
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  const out = canvasOf(dw, dh);
  const x = ctx2d(out, { p3 });
  x.imageSmoothingQuality = 'high';
  x.drawImage(cur, 0, 0, cw, ch, 0, 0, dw, dh);
  return out;
}

function orientTransform(ctx, o, w, h) { // raw w x h image -> upright
  switch (o) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    default: break;
  }
}

// ---- preview --------------------------------------------------------------------------------------
async function buildPreview(item) {
  const { img, url } = await decodeImageEl(item.file);
  try {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const o = item.insp.format === 'jpeg' ? (item.insp.orientation || 1) : 1;
    const manual = !CAPS.autoOrient && o > 1;          // an old browser that ignores EXIF orientation
    const rawW = manual ? nw : (o >= 5 ? nh : nw), rawH = manual ? nh : (o >= 5 ? nw : nh);
    let W = manual ? (o >= 5 ? nh : nw) : nw, H = manual ? (o >= 5 ? nw : nh) : nh;
    if (item.W && (item.W !== W || item.H !== H)) {
      // The browser disagrees with our reading of the file's size/orientation: trust the browser everywhere
      // (preview and export both then go through its decoder, so they can never disagree with each other).
      item.insp.rawCapable = false;
    }
    item.W = W; item.H = H;
    const sc = Math.min(1, PREVIEW_EDGE / Math.max(W, H));
    const pw = Math.max(1, Math.round(W * sc)), ph = Math.max(1, Math.round(H * sc));
    let canvas;
    if (manual) {
      const rs = Math.min(1, PREVIEW_EDGE / Math.max(rawW, rawH));
      const small = downscale(img, rawW, rawH, Math.max(1, Math.round(rawW * rs)), Math.max(1, Math.round(rawH * rs)), true);
      canvas = canvasOf(pw, ph);
      const x = ctx2d(canvas, { p3: true });
      x.imageSmoothingQuality = 'high';
      x.save();
      x.scale(pw / (o >= 5 ? small.height : small.width), ph / (o >= 5 ? small.width : small.height));
      orientTransform(x, o, small.width, small.height);
      x.drawImage(small, 0, 0);
      x.restore();
    } else {
      canvas = downscale(img, nw, nh, pw, ph, true);
    }
    return { canvas, w: pw, h: ph };
  } finally { URL.revokeObjectURL(url); }
}

function makeThumb(item, canvas) {
  const tw = 200, th = Math.max(1, Math.round(200 * canvas.height / canvas.width));
  const t = downscale(canvas, canvas.width, canvas.height, tw, Math.min(th, 400), false);
  item.thumb = t.toDataURL('image/jpeg', 0.8);
  item.thumbImg = new Image();
  item.thumbImg.src = item.thumb;
  const el = document.querySelector(`.thumb[data-id="${item.id}"] img`);
  if (el) el.src = item.thumb;
}

async function ensurePreview(item) {
  if (item.preview) return item.preview;
  if (!item.previewPromise) {
    item.previewPromise = buildPreview(item).then((pv) => { item.preview = pv; if (!item.thumb) makeThumb(item, pv.canvas); return pv; })
      .finally(() => { item.previewPromise = null; });
  }
  return item.previewPromise;
}

function evictPreviews(keepId) {
  const withPv = items.filter((i) => i.preview && i.id !== keepId);
  while (withPv.length > 2) { const old = withPv.shift(); old.preview = null; }
}

async function selectItem(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  currentId = id;
  renderSelection();
  syncAll();
  $('loadingPill').hidden = !!item.preview;
  if (!item.preview) {
    try { await ensurePreview(item); }
    catch (e) {
      if (currentId === id) { $('loadingPill').hidden = true; toast(`${item.name} can't be displayed by this browser. ${/heic|heif/i.test(item.name) ? 'Try Safari, or export it as JPEG first.' : ''}`, 'err'); }
      item.status = 'error';
      updateThumb(item);
      return;
    }
  }
  if (currentId !== id) return;
  $('loadingPill').hidden = true;
  evictPreviews(id);
  syncAll();
}

function removeItem(id) {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return;
  items.splice(i, 1);
  if (currentId === id) {
    currentId = null;
    const next = items[Math.min(i, items.length - 1)];
    if (next) selectItem(next.id);
  }
  renderFilmstrip();
  syncShell();
  syncAll();
}

function clearAll() {
  items.length = 0;
  currentId = null;
  renderFilmstrip();
  syncShell();
  syncAll();
}

// ---- thumbnails for photos that are not selected -------------------------------------------------
let thumbBusy = false;
async function queueThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    for (;;) {
      const it = items.find((i) => !i.thumb && i.status !== 'error' && !i.thumbTried);
      if (!it) break;
      it.thumbTried = true;
      await new Promise((r) => idle(r));
      if (it.preview) { makeThumb(it, it.preview.canvas); continue; }
      try {
        const { img, url } = await decodeImageEl(it.file);
        try {
          const nw = img.naturalWidth, nh = img.naturalHeight;
          const tw = 200, th = Math.max(1, Math.round(200 * nh / nw));
          const t = downscale(img, nw, nh, tw, Math.min(th, 400), false);
          it.thumb = t.toDataURL('image/jpeg', 0.8);
          it.thumbImg = new Image(); it.thumbImg.src = it.thumb;
          if (!it.W) { it.W = nw; it.H = nh; }
          const el = document.querySelector(`.thumb[data-id="${it.id}"] img`);
          if (el) el.src = it.thumb;
        } finally { URL.revokeObjectURL(url); }
      } catch (e) { it.status = 'error'; it.error = 'This browser cannot open this file.'; updateThumb(it); }
    }
  } finally { thumbBusy = false; }
}

// ---- filmstrip ------------------------------------------------------------------------------------
function badgeFor(it) {
  if (it.status === 'busy') return ['busy', '…'];
  if (it.status === 'done') return ['ok', '✓'];
  if (it.status === 'error') return ['err', '!'];
  return null;
}
function renderFilmstrip() {
  const fs = $('filmstrip');
  fs.textContent = '';
  items.forEach((it, idx) => {
    const b = document.createElement('div');
    b.className = 'thumb'; b.dataset.id = it.id; b.tabIndex = 0;
    b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(it.id === currentId));
    b.title = it.name;
    const img = new Image();
    img.alt = ''; img.draggable = false;
    if (it.thumb) img.src = it.thumb;
    const tn = document.createElement('span'); tn.className = 'tn'; tn.textContent = it.name;
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'rm'; rm.setAttribute('aria-label', 'Remove ' + it.name); rm.title = 'Remove';
    rm.innerHTML = '<svg width="12" height="12"><use href="#i-x"/></svg>';
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeItem(it.id); });
    b.append(img, tn, rm);
    const bd = badgeFor(it);
    if (bd) { const s = document.createElement('span'); s.className = 'badge ' + bd[0]; s.textContent = bd[1]; b.appendChild(s); }
    b.addEventListener('click', () => selectItem(it.id));
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectItem(it.id); } });
    fs.appendChild(b);
  });
  const add = document.createElement('button');
  add.type = 'button'; add.className = 'film-add'; add.textContent = '+ Add';
  add.addEventListener('click', () => $('fileInput').click());
  fs.appendChild(add);
  if (items.length > 1) {
    const meta = document.createElement('div');
    meta.className = 'film-meta';
    meta.innerHTML = `<span>${items.length} photos</span>`;
    const clr = document.createElement('button');
    clr.type = 'button'; clr.className = 'btn sm ghost danger'; clr.textContent = 'Clear all';
    clr.addEventListener('click', () => { if (confirm('Remove all photos from the list? (Your original files are not touched.)')) clearAll(); });
    meta.appendChild(clr);
    fs.appendChild(meta);
  }
}
function renderSelection() {
  $$('#filmstrip .thumb').forEach((t) => {
    const sel = Number(t.dataset.id) === currentId;
    t.setAttribute('aria-selected', String(sel));
    if (sel) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}
/** A ✓ means "exported with the settings you see now"; any change makes it stale. */
function invalidateDone() {
  for (const it of items) if (it.status === 'done') { it.status = 'idle'; updateThumb(it); }
}
function updateThumb(it) {
  const t = document.querySelector(`.thumb[data-id="${it.id}"]`);
  if (!t) return;
  const old = t.querySelector('.badge');
  if (old) old.remove();
  const bd = badgeFor(it);
  if (bd) { const s = document.createElement('span'); s.className = 'badge ' + bd[0]; s.textContent = bd[1]; if (it.error) s.title = it.error; t.appendChild(s); }
}

/** Empty-state vs editor shell */
function syncShell() {
  const empty = items.length === 0;
  $('app').dataset.empty = String(empty);
  $('empty').hidden = !empty;
  $('stageBar').hidden = empty;
  $('stageFoot').hidden = empty;
  if (empty) { cropEl.hidden = true; lastInfoHTML = ''; }
  $('btnExport').disabled = empty;
  $('btnExportAll').hidden = items.length < 2;
  updateExportLabels();
}
