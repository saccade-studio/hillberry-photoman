// ---------------------------------------------------------------------------------------------
// Side panel: syncing the DOM to state, and wiring controls to state

const painters = [];
function onSettingChange() { invalidateDone(); saveSettings(); requestDraw(); }

function bindSlider(id, get, set, fmt) {
  const inp = $(id), out = $(id + 'Out');
  const paint = () => {
    const v = get();
    inp.value = v;
    out.textContent = fmt(v);
    const mn = parseFloat(inp.min), mx = parseFloat(inp.max);
    inp.style.setProperty('--p', ((v - mn) / (mx - mn) * 100) + '%');
  };
  inp.addEventListener('input', () => { set(parseFloat(inp.value)); paint(); onSettingChange(); syncAfterSlider(id); });
  inp.addEventListener('dblclick', () => { /* double-click resets to the default */
    const def = defaultFor(id);
    if (def !== undefined) { set(def); paint(); onSettingChange(); syncAfterSlider(id); }
  });
  painters.push(paint);
  return paint;
}
const pct = (v) => Math.round(v) + '%';
const pct1 = (v) => (Math.round(v * 10) / 10).toFixed(1) + '%';
function defaultFor(id) {
  return ({ hSize: DEFAULTS.hb.size, cSize: DEFAULTS.mine.size, margin: DEFAULTS.margin, opacity: DEFAULTS.opacity, shStrength: DEFAULTS.shadow.strength,
    shBlur: DEFAULTS.shadow.blur, shDistance: DEFAULTS.shadow.distance, shAngle: DEFAULTS.shadow.angle, quality: DEFAULTS.out.quality })[id];
}
function syncAfterSlider(id) { if (id === 'quality') syncExportUI(); }

bindSlider('hSize', () => S.hb.size, (v) => { S.hb.size = v; }, pct1);
bindSlider('cSize', () => S.mine.size, (v) => { S.mine.size = v; }, pct1);
bindSlider('margin', () => S.margin, (v) => { S.margin = v; }, pct1);
bindSlider('opacity', () => S.opacity, (v) => { S.opacity = v; }, pct);
bindSlider('shStrength', () => S.shadow.strength, (v) => { S.shadow.strength = v; }, pct);
bindSlider('shBlur', () => S.shadow.blur, (v) => { S.shadow.blur = v; }, (v) => Math.round(v));
bindSlider('shDistance', () => S.shadow.distance, (v) => { S.shadow.distance = v; }, (v) => Math.round(v));
bindSlider('shAngle', () => S.shadow.angle, (v) => { S.shadow.angle = v; }, (v) => Math.round(v) + '°');
bindSlider('quality', () => S.out.quality, (v) => { S.out.quality = v; }, (v) => (v >= 100 ? '100 · Maximum' : String(Math.round(v))));

// ---- crop -----------------------------------------------------------------------------------------
$$('#aspectChips .chip, .scott-card').forEach((b) => b.addEventListener('click', () => changeAspect(b.dataset.aspect)));
$$('#orientSeg button').forEach((b) => b.addEventListener('click', () => changeOrientation(b.dataset.orient)));
$('btnRecenter').addEventListener('click', recenterCrop);

function syncCropUI() {
  const item = current();
  $$('#aspectChips .chip, .scott-card').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aspect === S.aspect)));
  const a = aspectDef();
  const can = !!item && a.kind === 'ratio' && a.s !== a.l;
  $$('#orientSeg button').forEach((b) => {
    b.disabled = !can;
    b.setAttribute('aria-pressed', String(!!item && a.kind === 'ratio' && a.s !== a.l && (b.dataset.orient === 'landscape') === isLandscape(item)));
  });
  $('btnRecenter').disabled = !item || a.kind === 'original';
  syncCropReadout();
}

function syncCropReadout() {
  const el = $('cropReadout'), item = current();
  if (!item || !item.W) { el.innerHTML = 'Add a photo to start cropping.'; return; }
  const c = getCrop(item), a = aspectDef(), pi = printInfo(item, c);
  let html = `<div>${a.kind === 'original' ? 'Full frame' : 'Crop'}: <b>${fmtInt(c.w)} × ${fmtInt(c.h)} px</b> · ${fmtMP(c.w, c.h)} MP</div>`;
  if (pi) {
    html += `<div>Scott Print Size <b>${a.label} in</b> — prints at <b>${fmtInt(pi.ppi)} ppi</b></div><div class="q ${pi.q}">${pi.label}</div>`;
  } else if (a.kind === 'ratio') {
    html += `<div>Aspect ratio <b>${a.label}</b>${a.s === a.l ? '' : (isLandscape(item) ? ' · landscape' : ' · portrait')}</div>`;
  } else if (a.kind === 'free') html += '<div>Drag the corners or edges to crop freely.</div>';
  el.innerHTML = html;
}

// ---- watermarks -----------------------------------------------------------------------------------
$('hEnabled').addEventListener('change', (e) => { S.hb.enabled = e.target.checked; syncMarksUI(); onSettingChange(); });
$('cEnabled').addEventListener('change', (e) => { S.mine.enabled = e.target.checked; syncMarksUI(); onSettingChange(); });
$('btnSwap').addEventListener('click', () => { S.hb.side = S.hb.side === 'right' ? 'left' : 'right'; syncMarksUI(); onSettingChange(); });
$$('#cKindSeg button').forEach((b) => b.addEventListener('click', () => {
  S.mine.kind = b.dataset.kind;
  if (S.mine.kind === 'text') setAsset('mine', renderTextLogo(S.mine), S.mine.text);
  else setAsset('mine', keepImage.logo, keepImage.name);
  afterMarksChanged();
}));

$('btnCPick').addEventListener('click', () => $('markInput').click());
$('markInput').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const logo = await loadMarkFile(f);
    keepImage.logo = logo; keepImage.name = f.name.replace(/\.[^.]+$/, '');
    setAsset('mine', logo, keepImage.name);
    S.mine.kind = 'image'; S.mine.enabled = true;
    if (!storageSet(STORE_KEY + ':mine', logoToPNGDataURL(logo, 1600))) toast('Your watermark works now, but this browser would not remember it for next time.');
    storageSet(STORE_KEY + ':mine:name', assets.mine.name);
    afterMarksChanged();
  } catch (err) { toast(err.message || 'That file could not be used as a watermark.', 'err'); }
});
$('btnCClear').addEventListener('click', () => {
  keepImage.logo = null; keepImage.name = '';
  setAsset('mine', null, '');
  storageDel(STORE_KEY + ':mine'); storageDel(STORE_KEY + ':mine:name');
  S.mine.enabled = false;
  afterMarksChanged();
});

$('btnHReplace').addEventListener('click', () => $('hInput').click());
$('hInput').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const logo = await loadMarkFile(f);
    setAsset('hb', logo, f.name.replace(/\.[^.]+$/, ''));
    assets.hb.isDefault = false;
    storageSet(STORE_KEY + ':hb', logoToPNGDataURL(logo, 1800));
    storageSet(STORE_KEY + ':hb:name', assets.hb.name);
    afterMarksChanged();
  } catch (err) { toast(err.message || 'That file could not be used as a watermark.', 'err'); }
});
$('btnHReset').addEventListener('click', async () => {
  storageDel(STORE_KEY + ':hb'); storageDel(STORE_KEY + ':hb:name');
  await loadHillberryDefault();
  afterMarksChanged();
});

$('cText').addEventListener('input', (e) => { S.mine.text = e.target.value; if (S.mine.text.trim()) S.mine.enabled = true; rebuildTextMark(); syncMarksUI(); saveSettings(); });
$('cFont').addEventListener('change', (e) => { S.mine.font = e.target.value; rebuildTextMark(); saveSettings(); });
$('cBold').addEventListener('change', (e) => { S.mine.bold = e.target.checked; rebuildTextMark(); saveSettings(); });
$('cColor').addEventListener('input', (e) => { S.mine.color = e.target.value; rebuildTextMark(); saveSettings(); });

function afterMarksChanged() { invalidateDone(); syncMarksUI(); saveSettings(); requestDraw(); }

function syncMarksUI() {
  const rightIsHB = S.hb.side === 'right';
  $('hWhere').textContent = rightIsHB ? 'Bottom right' : 'Bottom left';
  $('cWhere').textContent = rightIsHB ? 'Bottom left' : 'Bottom right';
  $('hName').textContent = assets.hb.name || 'Watermark';
  $('hEnabled').checked = S.hb.enabled;
  $('cardH').classList.toggle('off', !S.hb.enabled);
  $('hPrev').innerHTML = assets.hb.url ? `<img alt="" src="${assets.hb.url}">` : '';
  $('btnHReset').hidden = assets.hb.isDefault;

  const m = S.mine, hasLogo = !!assets.mine.logo;
  $('cEnabled').checked = m.enabled;
  $('cardC').classList.toggle('off', !m.enabled || !hasLogo);
  $$('#cKindSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === m.kind)));
  $('cImageBox').hidden = m.kind !== 'image';
  $('cImageHint').hidden = m.kind !== 'image';
  $('cTextBox').hidden = m.kind !== 'text';
  const prev = $('cPrev');
  if (hasLogo) { prev.className = 'logo-preview'; prev.innerHTML = `<img alt="" src="${assets.mine.url}">`; }
  else { prev.className = 'logo-preview none'; prev.textContent = m.kind === 'text' ? 'Type text' : 'No image'; }
  $('btnCClear').hidden = !(m.kind === 'image' && hasLogo);
  $('btnCPick').lastChild.textContent = hasLogo && m.kind === 'image' ? 'Change image…' : 'Choose image…';
  if (document.activeElement !== $('cText')) $('cText').value = m.text;
  $('cFont').value = m.font; $('cBold').checked = m.bold; $('cColor').value = m.color;
  painters.forEach((p) => p());
}

// ---- look -----------------------------------------------------------------------------------------
$('shadowOn').addEventListener('change', (e) => { S.shadow.on = e.target.checked; syncLookUI(); onSettingChange(); });
$('shColor').addEventListener('input', (e) => { S.shadow.color = e.target.value; onSettingChange(); });
const SHADOW_STYLES = {
  dark: { strength: 55, blur: 22, distance: 20, angle: 50, color: '#000000' },    // the default: a soft drop shadow
  light: { strength: 78, blur: 46, distance: 0, angle: 50, color: '#fff1dc' },    // a warm glow: keeps the dark-plum logo readable at night
};
$$('#shadowStyleSeg button').forEach((b) => b.addEventListener('click', () => {
  Object.assign(S.shadow, SHADOW_STYLES[b.dataset.style], { on: true });
  syncLookUI(); onSettingChange();
}));
function shadowStyleNow() {
  const hex = S.shadow.color || '#000000';
  const lum = (0.2126 * parseInt(hex.slice(1, 3), 16) + 0.7152 * parseInt(hex.slice(3, 5), 16) + 0.0722 * parseInt(hex.slice(5, 7), 16)) / 255;
  return lum < 0.35 ? 'dark' : lum > 0.65 ? 'light' : '';
}
$('btnLookReset').addEventListener('click', () => {
  S.opacity = DEFAULTS.opacity; Object.assign(S.shadow, DEFAULTS.shadow); S.margin = DEFAULTS.margin;
  syncLookUI(); syncMarksUI(); onSettingChange();
});
function syncLookUI() {
  $('shadowOn').checked = S.shadow.on;
  $('shColor').value = S.shadow.color;
  $$('#shadowStyleSeg button').forEach((b) => b.setAttribute('aria-pressed', String(S.shadow.on && b.dataset.style === shadowStyleNow())));
  $('shadowCtl').style.opacity = S.shadow.on ? '1' : '.45';
  $('shadowCtl').style.pointerEvents = S.shadow.on ? '' : 'none';
  painters.forEach((p) => p());
}

// ---- export options -----------------------------------------------------------------------------
$$('#fmtSeg button').forEach((b) => b.addEventListener('click', () => { S.out.format = b.dataset.fmt; syncExportUI(); saveSettings(); }));
$$('#chromaSeg button').forEach((b) => b.addEventListener('click', () => { S.out.chroma = b.dataset.chroma; syncExportUI(); saveSettings(); }));
$('optimize').addEventListener('change', (e) => { S.out.optimize = e.target.checked; saveSettings(); });
$('metaSelect').addEventListener('change', (e) => { S.out.metadata = e.target.value; saveSettings(); });
$('suffix').addEventListener('input', (e) => { S.out.suffix = e.target.value.replace(/[\\/:*?"<>|]/g, ''); saveSettings(); });
$('zipCheck').addEventListener('change', (e) => { S.out.zip = e.target.checked; saveSettings(); });

function outputFormatFor(item) {
  if (S.out.format === 'jpeg') return 'jpeg';
  if (S.out.format === 'png') return 'png';
  return item && item.insp && item.insp.format === 'png' ? 'png' : 'jpeg';
}

function syncExportUI() {
  const item = current();
  $$('#fmtSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fmt === S.out.format)));
  $$('#chromaSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.chroma === S.out.chroma)));
  $('optimize').checked = S.out.optimize;
  $('metaSelect').value = S.out.metadata;
  $('suffix').value = S.out.suffix;
  $('zipCheck').checked = S.out.zip;
  $('zipRow').hidden = items.length < 2;
  $('jpegCtl').hidden = outputFormatFor(item) === 'png';
  const q = S.out.quality;
  $('qualityHint').textContent = q >= 100 ? 'Maximum: no detail is lost. Files are typically 2–4× larger than a camera JPEG.'
    : q >= 98 ? 'Visually lossless. Roughly 2× the size of a camera JPEG.'
    : q >= 95 ? 'Looks identical to the original, at about the original file size.'
    : q >= 90 ? 'Very high quality, smaller than a camera JPEG.'
    : 'Smaller files; very fine detail can soften.';
  const pngBtn = document.querySelector('#fmtSeg [data-fmt="png"]');
  pngBtn.disabled = !CAPS.compression;
  if (!CAPS.compression && S.out.format === 'png') S.out.format = 'auto';
  painters.forEach((p) => p());
  syncColorInfo();
}

function syncColorInfo() {
  const box = $('colorInfo'), item = current();
  if (!item || !item.insp) { box.className = 'colorinfo'; box.innerHTML = '<svg><use href="#i-shield"/></svg><div>Add a photo to see how its color profile is handled.</div>'; return; }
  const i = item.insp, png = outputFormatFor(item) === 'png';
  let title, body, warn = false;
  if (i.rawCapable) {
    if (i.profile) {
      title = escapeHTML(i.profile.description || 'Embedded profile');
      body = 'This profile is read without any conversion and embedded again in the export, so the file stays in the same color space. The watermark’s colors are converted into it.';
    } else {
      title = 'No embedded profile';
      body = 'Treated as sRGB (the standard for untagged photos) and tagged sRGB in the export, so every app shows the same colors.';
    }
  } else {
    warn = true;
    const fmt = (i.format || 'this file').toUpperCase();
    title = 'Converted by your browser';
    body = i.profile && i.profile.kind === 'lut'
      ? 'This photo’s profile can’t be passed through directly, so your browser converts it to ' + (CAPS.p3canvas ? 'Display P3' : 'sRGB') + ' (wide-gamut colors are kept as far as that space allows) and the export is tagged accordingly.'
      : fmt + ' files are decoded by your browser and exported in ' + (CAPS.p3canvas ? 'Display P3' : 'sRGB') + ', tagged with that profile.';
  }
  box.className = 'colorinfo' + (warn ? ' warn' : '');
  box.innerHTML = `<svg><use href="#i-shield"/></svg><div><b>${title}</b><br>${body}${png ? ' Output is lossless PNG.' : ''}</div>`;
}

// ---- everything ------------------------------------------------------------------------------------
function syncAll() {
  syncCropUI();
  syncMarksUI();
  syncLookUI();
  syncExportUI();
  $$('#viewSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === S.view)));
  updateExportLabels();
  requestDraw();
}

function updateExportLabels() {
  const item = current();
  const label = $('btnExport').querySelector('span');
  label.textContent = item && item.status === 'busy' ? 'Exporting…' : 'Export this photo';
  $('btnExportAll').querySelector('span').textContent = `Export all ${items.length} photos`;
}
