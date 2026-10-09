/* ---------------------------------------------------------------------------------------------
 * Hillberry PhotoMan — UI layer (runs on the main thread; the heavy lifting lives in HB.* / the worker)
 * ------------------------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const nf = new Intl.NumberFormat('en-US');
const fmtInt = (n) => nf.format(Math.round(n));
const fmtMP = (w, h) => (w * h / 1e6).toFixed(1);
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
}
function debounce(fn, ms) { let t = 0; return function () { const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); }; }
function frameOnce(fn) {
  let queued = false;
  return function () { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(); }); };
}
function idle(fn) { if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: 1500 }); else setTimeout(fn, 30); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(message, kind, ms) {
  const box = $('toasts');
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  const span = document.createElement('span');
  span.textContent = message;
  const x = document.createElement('button');
  x.type = 'button'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
  t.append(span, x);
  const remove = () => { if (t.parentNode) t.parentNode.removeChild(t); };
  x.addEventListener('click', remove);
  box.appendChild(t);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(remove, ms || (kind === 'err' ? 9000 : 4500));
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function canvasOf(w, h, p3) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
function ctx2d(c, opts) {
  const o = Object.assign({}, opts || {});
  if (o.p3 && CAPS.p3canvas) o.colorSpace = 'display-p3';
  delete o.p3;
  return c.getContext('2d', o);
}

// ---------------------------------------------------------------------------------------------
// Capabilities
const CAPS = (function () {
  const caps = { worker: false, p3canvas: false, compression: typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined', autoOrient: true };
  try { caps.worker = typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && !!(window.URL && URL.createObjectURL); } catch (e) { /* ignore */ }
  try {
    const x = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
    caps.p3canvas = !!(x && x.getContextAttributes && x.getContextAttributes().colorSpace === 'display-p3');
  } catch (e) { /* ignore */ }
  return caps;
})();

/** Some browsers still ignore EXIF orientation when decoding <img>. We test with a tiny JPEG tagged "rotate 90°". */
async function probeAutoOrient() {
  try {
    const tiff = new Uint8Array([0x49, 0x49, 0x2A, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
    const payload = new Uint8Array(6 + tiff.length);
    payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]); payload.set(tiff, 6);
    const jpg = HB.jpegEnc.encode({
      width: 2, height: 1, quality: 90, optimize: false, jfif: null,
      segments: [HB.exif.exifSegment(payload)],
      getRows(y0, n, out) { out.fill(128); },
    });
    const url = URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
    const img = new Image();
    img.src = url;
    await img.decode();
    URL.revokeObjectURL(url);
    CAPS.autoOrient = img.naturalWidth === 1 && img.naturalHeight === 2;
  } catch (e) { CAPS.autoOrient = true; }
}
