// ---------------------------------------------------------------------------------------------
// Watermark assets: the festival logo, the photographer's own image, or typed text.
// Every asset is kept as a trimmed (transparent borders removed) straight-alpha sRGB RGBA bitmap, so margins are
// measured from the visible artwork, not from the file's empty padding.

const assets = {
  hb: { logo: null, prep: null, url: '', name: 'Hillberry 2026', isDefault: true },
  mine: { logo: null, prep: null, url: '', name: '' },
};
let assetVersion = 0; // bumps whenever any watermark bitmap changes (invalidates preview caches)
const keepImage = { logo: null, name: '' }; // the user's image watermark, remembered while they try the Text tab

async function decodeImageEl(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw new Error('This file could not be read as an image.'); }
  return { img, url };
}

/** Decode an image file to RGBA through the browser (vectors are rasterised at high resolution). */
async function decodeLogoBlob(blob, maxEdge, isSVG) {
  const { img, url } = await decodeImageEl(blob);
  try {
    let nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) { nw = 1000; nh = 500; }
    const scale = isSVG ? 2400 / Math.max(nw, nh) : Math.min(1, maxEdge / Math.max(nw, nh));
    const w = Math.max(1, Math.round(nw * scale)), h = Math.max(1, Math.round(nh * scale));
    const c = canvasOf(w, h);
    const x = ctx2d(c, { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, w, h);
    return { w, h, data: x.getImageData(0, 0, w, h).data };
  } finally { URL.revokeObjectURL(url); }
}

function logoThumbURL(logo, maxW, maxH) {
  const s = Math.min(maxW / logo.w, maxH / logo.h, 1);
  const w = Math.max(1, Math.round(logo.w * s)), h = Math.max(1, Math.round(logo.h * s));
  const full = canvasOf(logo.w, logo.h);
  full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(logo.rgba.buffer.slice(logo.rgba.byteOffset, logo.rgba.byteOffset + logo.rgba.byteLength)), logo.w, logo.h), 0, 0);
  const c = canvasOf(w, h);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(full, 0, 0, w, h);
  return c.toDataURL('image/png');
}

function setAsset(slot, logo, name) {
  const a = assets[slot];
  a.logo = logo;
  a.prep = logo ? HB.marks.prepareLogo(logo, null) : null;
  a.url = logo ? logoThumbURL(logo, 152, 96) : '';
  if (name !== undefined) a.name = name;
  assetVersion++;
}

async function loadHillberryDefault() {
  const blob = new Blob([b64ToBytes(HILLBERRY_WEBP_B64)], { type: 'image/webp' });
  const px = await decodeLogoBlob(blob, 3200, false);
  const logo = HB.marks.trim(px.data, px.w, px.h, 4);
  if (!logo) throw new Error('The built-in logo could not be decoded.');
  setAsset('hb', logo, 'Hillberry 2026');
  assets.hb.isDefault = true;
}

// ---- text watermark
const FONT_STACKS = {
  sans: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  slab: 'Rockwell, "Roboto Slab", "Courier New", Courier, serif',
  condensed: '"Arial Narrow", "Avenir Next Condensed", "Helvetica Neue Condensed", Impact, sans-serif',
  script: '"Snell Roundhand", "Brush Script MT", "Segoe Script", cursive',
  mono: 'ui-monospace, Menlo, Consolas, "Courier New", monospace',
};

function renderTextLogo(o) {
  const text = (o.text || '').trim();
  if (!text) return null;
  let size = 240;
  const c = canvasOf(8, 8);
  let x = c.getContext('2d');
  const font = (px) => `${o.bold ? '700' : '400'} ${px}px ${FONT_STACKS[o.font] || FONT_STACKS.sans}`;
  x.font = font(size);
  let width = x.measureText(text).width;
  if (width > 3600) { size = Math.floor(size * 3600 / width); x.font = font(size); width = x.measureText(text).width; }
  const pad = Math.ceil(size * 0.35);
  c.width = Math.ceil(width) + pad * 2; c.height = Math.ceil(size * 1.6);
  x = c.getContext('2d', { willReadFrequently: true });
  x.font = font(size);
  x.textBaseline = 'alphabetic';
  x.fillStyle = o.color || '#ffffff';
  x.fillText(text, pad, Math.round(size * 1.15));
  const id = x.getImageData(0, 0, c.width, c.height);
  return HB.marks.trim(id.data, c.width, c.height, 4);
}

const rebuildTextMark = debounce(() => {
  if (S.mine.kind !== 'text') return;
  const logo = renderTextLogo(S.mine);
  setAsset('mine', logo, S.mine.text);
  afterMarksChanged();
}, 120);

// ---- user image watermark
async function loadMarkFile(file) {
  const isSVG = /svg/i.test(file.type) || /\.svg$/i.test(file.name);
  const px = await decodeLogoBlob(file, 3000, isSVG);
  const logo = HB.marks.trim(px.data, px.w, px.h, 4);
  if (!logo) throw new Error('That image is completely transparent.');
  return logo;
}

function logoToPNGDataURL(logo, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(logo.w, logo.h));
  const full = canvasOf(logo.w, logo.h);
  full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(logo.rgba.buffer.slice(logo.rgba.byteOffset, logo.rgba.byteOffset + logo.rgba.byteLength)), logo.w, logo.h), 0, 0);
  if (s >= 1) return full.toDataURL('image/png');
  const c = canvasOf(logo.w * s, logo.h * s);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(full, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

async function restoreSavedImages() {
  for (const [slot, key] of [['mine', STORE_KEY + ':mine'], ['hb', STORE_KEY + ':hb']]) {
    const url = storageGet(key);
    if (!url) continue;
    try {
      const blob = await (await fetch(url)).blob();
      const px = await decodeLogoBlob(blob, 3000, false);
      const logo = HB.marks.trim(px.data, px.w, px.h, 4);
      if (!logo) continue;
      const name = storageGet(key + ':name');
      if (slot === 'mine') { keepImage.logo = logo; keepImage.name = name || 'Your watermark'; }
      else { setAsset('hb', logo, name || 'Custom watermark'); assets.hb.isDefault = false; }
    } catch (e) { storageDel(key); }
  }
  if (S.mine.kind === 'text') setAsset('mine', renderTextLogo(S.mine), S.mine.text);
  else setAsset('mine', keepImage.logo, keepImage.name);
}

/** The watermarks that are switched on and have artwork, with the side each sits on. */
function activeMarks() {
  const out = [];
  const hbSide = S.hb.side, mineSide = hbSide === 'right' ? 'left' : 'right';
  if (S.hb.enabled && assets.hb.logo) out.push({ key: 'hb', side: hbSide, logo: assets.hb.logo, prep: assets.hb.prep, size: S.hb.size / 100 });
  if (S.mine.enabled && assets.mine.logo) out.push({ key: 'mine', side: mineSide, logo: assets.mine.logo, prep: assets.mine.prep, size: S.mine.size / 100 });
  return out;
}

function shadowSettings() {
  const sh = S.shadow;
  const hex = sh.color || '#000000';
  return {
    on: !!sh.on, strength: sh.strength / 100, blur: sh.blur / 100, distance: sh.distance / 100, angle: sh.angle,
    color: [parseInt(hex.slice(1, 3), 16) || 0, parseInt(hex.slice(3, 5), 16) || 0, parseInt(hex.slice(5, 7), 16) || 0],
  };
}
function styleSettings() {
  return { margin: S.margin / 100, opacity: S.opacity / 100, shadow: shadowSettings() };
}
