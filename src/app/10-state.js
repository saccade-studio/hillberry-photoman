// ---------------------------------------------------------------------------------------------
// Settings (persisted) and the photo list
const STORE_KEY = 'hillberry-photoman:v1';

const DEFAULTS = {
  aspect: 'original',
  view: 'frame',
  margin: 2.5,                 // % of the short side of the exported image — same gap left, right and bottom
  opacity: 100,                // applies to each watermark and its shadow together
  shadow: { on: true, strength: 55, blur: 22, distance: 20, angle: 50, color: '#000000' },
  hb: { enabled: true, size: 22, side: 'right' },      // the festival logo (bottom right by default)
  mine: { enabled: false, size: 15, kind: 'image', text: '', font: 'sans', bold: true, color: '#ffffff' },
  out: { format: 'auto', quality: 100, chroma: '444', optimize: true, metadata: 'all', suffix: '-Hillberry', zip: true },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function mergeInto(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const k of Object.keys(target)) {
    if (!(k in src)) continue;
    if (target[k] && typeof target[k] === 'object') mergeInto(target[k], src[k]);
    else if (typeof src[k] === typeof target[k]) target[k] = src[k];
  }
  return target;
}

const S = clone(DEFAULTS);

function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storageSet(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } }
function storageDel(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

function loadSettings() {
  const raw = storageGet(STORE_KEY);
  if (!raw) return;
  try { mergeInto(S, JSON.parse(raw)); } catch (e) { /* ignore corrupt settings */ }
  S.hb.side = S.hb.side === 'left' ? 'left' : 'right';
  if (!['frame', 'result'].includes(S.view)) S.view = 'frame';
  if (!ASPECTS[S.aspect]) S.aspect = 'original';
}
const saveSettings = debounce(() => { storageSet(STORE_KEY, JSON.stringify(S)); }, 350);

// ---------------------------------------------------------------------------------------------
// Photos
const items = [];
let nextId = 1;
let currentId = null;
const current = () => items.find((i) => i.id === currentId) || null;
