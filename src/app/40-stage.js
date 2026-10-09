// ---------------------------------------------------------------------------------------------
// Stage: draws the photo, the dimmed area outside the crop, and the watermarks exactly as they will be exported
// (same layout, Lanczos resampling and shadow code as the export engine), then positions the crop overlay.

const stageEl = $('stage'), viewCanvas = $('view'), cropEl = $('crop');
let vctx = null;
const V = { s: 1, ox: 0, oy: 0, cssW: 0, cssH: 0, dpr: 1 };
const resizeCache = new Map(), layerCache = new Map();
function lruSet(map, key, val, max) { map.delete(key); map.set(key, val); while (map.size > max) map.delete(map.keys().next().value); }

function ensureCanvas() {
  const r = stageEl.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (viewCanvas.width !== w || viewCanvas.height !== h) { viewCanvas.width = w; viewCanvas.height = h; }
  if (!vctx) vctx = viewCanvas.getContext('2d', CAPS.p3canvas ? { colorSpace: 'display-p3' } : undefined);
  return { cssW: r.width, cssH: r.height, dpr };
}

function previewLayer(m, dw, dh, st) {
  const rk = `${m.key}|${assetVersion}|${dw}x${dh}`;
  let small = resizeCache.get(rk);
  if (!small) { small = HB.marks.resize(m.prep.data, m.prep.w, m.prep.h, dw, dh); lruSet(resizeCache, rk, small, 6); }
  const sh = st.shadow;
  const lk = `${rk}|${st.opacity}|${sh.on}|${sh.strength}|${sh.blur}|${sh.distance}|${sh.angle}|${sh.color}`;
  let hit = layerCache.get(lk);
  if (hit) return hit;
  const sp = HB.marks.shadowPx(sh, Math.max(dw, dh), sh.color);
  const layer = HB.marks.buildLayer({ w: dw, h: dh, data: small }, { opacity: st.opacity, shadow: sp });
  const cv = canvasOf(layer.w, layer.h);
  cv.getContext('2d').putImageData(new ImageData(HB.marks.layerToRGBA8(layer), layer.w, layer.h), 0, 0);
  hit = { canvas: cv, ox: layer.ox, oy: layer.oy };
  lruSet(layerCache, lk, hit, 10);
  return hit;
}

function marksLayout(crop) {
  const marks = activeMarks();
  const st = styleSettings();
  const boxes = HB.marks.layout(crop.w, crop.h, marks.map((m) => ({ side: m.side, w: m.logo.w, h: m.logo.h, size: m.size })), st.margin);
  return { marks, boxes, st };
}

function computeView(item, crop, cssW, cssH, dpr) {
  const footH = $('stageFoot').offsetHeight || 0;
  const padX = cssW < 520 ? 12 : 28, padTop = 54, padBot = Math.max(46, footH + 24);
  const availW = Math.max(40, cssW - 2 * padX), availH = Math.max(40, cssH - padTop - padBot);
  let s, ox, oy;
  if (S.view === 'result') {
    s = Math.min(availW / crop.w, availH / crop.h);
    ox = padX + (availW - crop.w * s) / 2 - crop.x * s;
    oy = padTop + (availH - crop.h * s) / 2 - crop.y * s;
  } else {
    s = Math.min(availW / item.W, availH / item.H);
    ox = padX + (availW - item.W * s) / 2;
    oy = padTop + (availH - item.H * s) / 2;
  }
  return { s, ox, oy, cssW, cssH, dpr };
}

function drawStage() {
  const { cssW, cssH, dpr } = ensureCanvas();
  const ctx = vctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#121214';
  ctx.fillRect(0, 0, viewCanvas.width, viewCanvas.height);
  const item = current();
  if (!item || !item.W) { cropEl.hidden = true; return; }
  const crop = getCrop(item);
  updateStageInfo(item, crop);
  Object.assign(V, computeView(item, crop, cssW, cssH, dpr));
  const d = dpr, s = V.s;
  const imgX = V.ox * d, imgY = V.oy * d, imgW = item.W * s * d, imgH = item.H * s * d;
  const result = S.view === 'result';
  const cx = (V.ox + crop.x * s) * d, cy = (V.oy + crop.y * s) * d, cw = crop.w * s * d, ch = crop.h * s * d;

  const pv = item.preview;
  if (!pv) {
    if (item.thumbImg && item.thumbImg.complete && item.thumbImg.naturalWidth) {
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(item.thumbImg, imgX, imgY, imgW, imgH);
      ctx.restore();
    }
    cropEl.hidden = true;
    return;
  }

  // soft depth shadow behind the photo
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 28 * d; ctx.shadowOffsetY = 6 * d;
  ctx.fillStyle = '#000';
  if (result) ctx.fillRect(cx, cy, cw, ch); else ctx.fillRect(imgX, imgY, imgW, imgH);
  ctx.restore();

  ctx.save();
  if (result) { ctx.beginPath(); ctx.rect(cx, cy, cw, ch); ctx.clip(); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(pv.canvas, 0, 0, pv.canvas.width, pv.canvas.height, imgX, imgY, imgW, imgH);
  ctx.restore();

  const cropped = !isFullCrop(item, crop);
  if (!result && cropped) {
    ctx.save();
    ctx.fillStyle = 'rgba(8,7,10,.64)';
    ctx.beginPath(); ctx.rect(imgX, imgY, imgW, imgH); ctx.rect(cx, cy, cw, ch);
    ctx.fill('evenodd');
    ctx.restore();
  }

  // watermarks, positioned relative to the crop's bottom corners
  const { marks, boxes, st } = marksLayout(crop);
  const k = s * d;
  ctx.save();
  if (result) { ctx.beginPath(); ctx.rect(cx, cy, cw, ch); ctx.clip(); }
  marks.forEach((m, i) => {
    const b = boxes[i];
    const dw = Math.max(1, Math.round(b.w * k)), dh = Math.max(1, Math.round(b.h * k));
    const layer = previewLayer(m, dw, dh, st);
    ctx.drawImage(layer.canvas, Math.round(cx + b.x * k) + layer.ox, Math.round(cy + b.y * k) + layer.oy);
  });
  ctx.restore();

  // crop overlay
  const ratioMode = aspectDef().kind === 'ratio';
  const showOverlay = !result && aspectDef().kind !== 'original';
  cropEl.hidden = !showOverlay;
  if (showOverlay) {
    cropEl.style.left = (V.ox + crop.x * s) + 'px'; cropEl.style.top = (V.oy + crop.y * s) + 'px';
    cropEl.style.width = crop.w * s + 'px'; cropEl.style.height = crop.h * s + 'px';
    cropEl.classList.toggle('locked', ratioMode);
  }
  updateOverlapNotice(crop, boxes);
}

const requestDraw = frameOnce(drawStage);

let lastInfoHTML = '';
function profileLabel(item) {
  const i = item.insp || {};
  if (i.rawCapable) {
    if (i.profile) return i.profile.description || 'Embedded profile';
    return 'sRGB';
  }
  return CAPS.p3canvas ? 'Display P3 (browser-converted)' : 'sRGB (browser-converted)';
}
function updateStageInfo(item, crop) {
  const a = aspectDef(), pi = printInfo(item, crop);
  let html = `<span class="pill"><b>${fmtInt(crop.w)} × ${fmtInt(crop.h)}</b> px · ${fmtMP(crop.w, crop.h)} MP</span>`;
  if (pi) {
    html += `<span class="pill scott ${pi.q}"><span class="dot"></span>Scott Print Size <b>${a.label}</b> in · <b>${fmtInt(pi.ppi)}</b> ppi</span>`;
  }
  const preserved = item.insp && item.insp.rawCapable;
  html += `<span class="pill ${preserved ? 'ok' : 'warn'}"><span class="dot"></span>Color: ${escapeHTML(profileLabel(item))}</span>`;
  if (html !== lastInfoHTML) { $('stageFoot').innerHTML = html; lastInfoHTML = html; }
}
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function updateOverlapNotice(crop, boxes) {
  const n = $('overlapNotice');
  let overlap = false;
  if (boxes.length === 2) {
    const L = boxes.find((b) => b.side === 'left'), R = boxes.find((b) => b.side === 'right');
    if (L && R) overlap = L.x + L.w + Math.round(0.01 * Math.min(crop.w, crop.h)) > R.x;
  }
  n.hidden = !overlap;
}

// ---- pointer interaction ------------------------------------------------------------------------
let drag = null;
function pointToImage(e) {
  const r = stageEl.getBoundingClientRect();
  return { x: (e.clientX - r.left - V.ox) / V.s, y: (e.clientY - r.top - V.oy) / V.s };
}
cropEl.addEventListener('pointerdown', (e) => {
  const item = current();
  if (!item || S.view !== 'frame' || aspectDef().kind === 'original' || e.button > 0) return;
  const h = e.target.closest('.handle');
  drag = { id: e.pointerId, mode: h ? h.dataset.h : 'move', start: pointToImage(e), crop0: Object.assign({}, getCrop(item)) };
  try { cropEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  cropEl.classList.add('active');
  cropEl.focus({ preventScroll: true });
  e.preventDefault();
});
cropEl.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const item = current();
  if (!item) return;
  item.crop = computeDrag(item, drag, pointToImage(e));
  invalidateDone();
  syncCropReadout();
  requestDraw();
});
function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  drag = null;
  cropEl.classList.remove('active');
  syncCropUI();
}
cropEl.addEventListener('pointerup', endDrag);
cropEl.addEventListener('pointercancel', endDrag);
cropEl.addEventListener('keydown', (e) => {
  const item = current();
  if (!item) return;
  const step = Math.max(1, Math.round(1 / V.s)) * (e.shiftKey ? 10 : 1);
  let next = null;
  switch (e.key) {
    case 'ArrowLeft': next = nudgeCrop(item, -step, 0); break;
    case 'ArrowRight': next = nudgeCrop(item, step, 0); break;
    case 'ArrowUp': next = nudgeCrop(item, 0, -step); break;
    case 'ArrowDown': next = nudgeCrop(item, 0, step); break;
    case '+': case '=': next = nudgeCrop(item, 0, 0, step * 2); break;
    case '-': case '_': next = nudgeCrop(item, 0, 0, -step * 2); break;
    default: return;
  }
  e.preventDefault(); e.stopPropagation();
  invalidateDone();
  item.crop = next;
  syncCropUI();
  requestDraw();
});

function setView(v) {
  S.view = v;
  $$('#viewSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  saveSettings();
  requestDraw();
}
$$('#viewSeg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

if (window.ResizeObserver) new ResizeObserver(() => requestDraw()).observe(stageEl);
else window.addEventListener('resize', requestDraw);
