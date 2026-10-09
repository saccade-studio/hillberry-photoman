// ---------------------------------------------------------------------------------------------
// Crop model. Crops live in the *upright* pixel space of the photo (EXIF orientation already applied) and are
// always whole pixels. Ratio presets use exact integer multiples (e.g. 4:5 -> 3200 x 4000) so the aspect is exact.

const ASPECTS = {
  original: { kind: 'original', label: 'Original' },
  free: { kind: 'free', label: 'Free' },
  '1:1': { kind: 'ratio', s: 1, l: 1, label: '1:1', tag: '1x1' },
  '4:5': { kind: 'ratio', s: 4, l: 5, label: '4:5', tag: '4x5' },
  '3:2': { kind: 'ratio', s: 2, l: 3, label: '3:2', tag: '3x2' },
  '4:3': { kind: 'ratio', s: 3, l: 4, label: '4:3', tag: '4x3' },
  '16:9': { kind: 'ratio', s: 9, l: 16, label: '16:9', tag: '16x9' },
  'scott-8x10': { kind: 'ratio', s: 4, l: 5, label: '8 × 10', scott: true, print: { s: 8, l: 10 }, tag: '8x10' },
  'scott-13x19': { kind: 'ratio', s: 13, l: 19, label: '13 × 19', scott: true, print: { s: 13, l: 19 }, tag: '13x19' },
};

const aspectDef = () => ASPECTS[S.aspect];
const isLandscape = (item) => (item.W > item.H) !== !!item.flip;

/** Integer ratio for this photo (orientation-aware), or null for Original/Free. */
function ratioInts(item) {
  const a = aspectDef();
  if (a.kind !== 'ratio') return null;
  if (a.s === a.l) return { w: 1, h: 1 };
  return isLandscape(item) ? { w: a.l, h: a.s } : { w: a.s, h: a.l };
}
const fullCrop = (item) => ({ x: 0, y: 0, w: item.W, h: item.H });
const maxK = (item, r) => Math.floor(Math.min(item.W / r.w, item.H / r.h));
function minPx(item) { return Math.max(24, Math.round(0.04 * Math.min(item.W, item.H))); }
function minK(item, r) { return Math.max(1, Math.min(maxK(item, r), Math.ceil(minPx(item) / Math.min(r.w, r.h)))); }

function placeCrop(item, r, k, cx, cy) {
  const km = maxK(item, r);
  if (km < 1) return fullCrop(item);
  k = clamp(Math.round(k), 1, km);
  const w = r.w * k, h = r.h * k;
  const x = clamp(Math.round((cx == null ? item.W / 2 : cx) - w / 2), 0, item.W - w);
  const y = clamp(Math.round((cy == null ? item.H / 2 : cy) - h / 2), 0, item.H - h);
  return { x, y, w, h };
}
function autoCrop(item) {
  const r = ratioInts(item);
  return r ? placeCrop(item, r, maxK(item, r)) : fullCrop(item);
}
const getCrop = (item) => item.crop || autoCrop(item);
const isFullCrop = (item, c) => c.x === 0 && c.y === 0 && c.w === item.W && c.h === item.H;

function changeAspect(id) {
  const item = current();
  const old = item ? getCrop(item) : null;
  S.aspect = id;
  invalidateDone();
  for (const it of items) it.crop = null;
  const r = item && ratioInts(item);
  if (r) item.crop = placeCrop(item, r, maxK(item, r), old.x + old.w / 2, old.y + old.h / 2);
  saveSettings();
  syncCropUI();
  requestDraw();
}

function changeOrientation(want) {
  const item = current();
  if (!item) return;
  const r0 = ratioInts(item);
  if (!r0) return;
  const old = getCrop(item);
  invalidateDone();
  item.flip = (want === 'landscape') !== (item.W > item.H);
  const r = ratioInts(item);
  item.crop = placeCrop(item, r, maxK(item, r), old.x + old.w / 2, old.y + old.h / 2);
  syncCropUI();
  requestDraw();
}

function recenterCrop() {
  const item = current();
  if (!item) return;
  invalidateDone();
  item.crop = null;
  syncCropUI();
  requestDraw();
}

/** Print resolution for the Scott Print Sizes. */
function printInfo(item, crop) {
  const a = aspectDef();
  if (!a.scott) return null;
  const land = isLandscape(item);
  const pw = land ? a.print.l : a.print.s, ph = land ? a.print.s : a.print.l;
  const ppi = crop.w / pw;
  let q = 'bad', label = 'Low resolution for this print size';
  if (ppi >= 300) { q = 'ok'; label = 'Excellent'; }
  else if (ppi >= 200) { q = 'ok'; label = 'Good'; }
  else if (ppi >= 150) { q = 'warn'; label = 'Fair — may look slightly soft'; }
  return { pw, ph, ppi, q, label };
}

function cropTag(item) {
  const a = aspectDef();
  if (a.kind !== 'ratio') return '';
  if (a.scott) {
    const land = isLandscape(item);
    return '-' + (land ? a.print.l + 'x' + a.print.s : a.print.s + 'x' + a.print.l);
  }
  return '-' + a.tag;
}

// ---- dragging maths ---------------------------------------------------------------------------
function computeDrag(item, d, p) {
  const W = item.W, H = item.H, c0 = d.crop0, r = ratioInts(item), mp = minPx(item);
  if (d.mode === 'move') {
    return {
      x: clamp(Math.round(c0.x + p.x - d.start.x), 0, W - c0.w), y: clamp(Math.round(c0.y + p.y - d.start.y), 0, H - c0.h), w: c0.w, h: c0.h,
    };
  }
  const west = d.mode.includes('w'), east = d.mode.includes('e'), north = d.mode.includes('n'), south = d.mode.includes('s');
  if (r) {
    const sx = east ? 1 : -1, sy = south ? 1 : -1;
    const ax = east ? c0.x : c0.x + c0.w, ay = south ? c0.y : c0.y + c0.h;
    const availW = sx > 0 ? W - ax : ax, availH = sy > 0 ? H - ay : ay;
    const wantW = Math.max((p.x - ax) * sx, 0), wantH = Math.max((p.y - ay) * sy, 0);
    const w = Math.max(wantW, wantH * r.w / r.h);
    const kMax = Math.max(1, Math.floor(Math.min(availW / r.w, availH / r.h)));
    const k = clamp(Math.round(w / r.w), Math.min(minK(item, r), kMax), kMax);
    const nw = r.w * k, nh = r.h * k;
    return { x: sx > 0 ? ax : ax - nw, y: sy > 0 ? ay : ay - nh, w: nw, h: nh };
  }
  let x1 = c0.x, y1 = c0.y, x2 = c0.x + c0.w, y2 = c0.y + c0.h;
  if (west) x1 = clamp(p.x, 0, x2 - mp);
  if (east) x2 = clamp(p.x, x1 + mp, W);
  if (north) y1 = clamp(p.y, 0, y2 - mp);
  if (south) y2 = clamp(p.y, y1 + mp, H);
  return { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
}

function nudgeCrop(item, dx, dy, grow) {
  const c = getCrop(item), r = ratioInts(item);
  if (grow) {
    if (r) {
      const k = c.w / r.w, kn = clamp(k + Math.sign(grow) * Math.max(1, Math.round(Math.abs(grow) / Math.max(r.w, 1))), Math.min(minK(item, r), maxK(item, r)), maxK(item, r));
      return placeCrop(item, r, kn, c.x + c.w / 2, c.y + c.h / 2);
    }
    const g = grow, mp = minPx(item);
    const x1 = clamp(c.x - g, 0, c.x + c.w - mp), y1 = clamp(c.y - g, 0, c.y + c.h - mp);
    const x2 = clamp(c.x + c.w + g, x1 + mp, item.W), y2 = clamp(c.y + c.h + g, y1 + mp, item.H);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  return { x: clamp(c.x + dx, 0, item.W - c.w), y: clamp(c.y + dy, 0, item.H - c.h), w: c.w, h: c.h };
}
