// ---------------------------------------------------------------------------------------------
// Wiring: file pickers, drag & drop, shortcuts, help, start-up

$('btnAdd').addEventListener('click', () => $('fileInput').click());
$('btnPick').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files;
  if (f && f.length) addFiles(f);
  e.target.value = '';
});

let dragDepth = 0;
const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('app').classList.add('dragging'); });
window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('app').classList.remove('dragging'); });
/** Files from a drop, including everything inside dropped folders (Chromium, Safari, Firefox expose these as "entries"). */
async function filesFromDrop(entries, fallback) {
  const out = [];
  async function walk(entry, depth) {
    if (entry.isFile) await new Promise((res) => entry.file((f) => { out.push(f); res(); }, res));
    else if (entry.isDirectory && depth < 5) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const child of batch) await walk(child, depth + 1);
      }
    }
  }
  for (const en of entries) await walk(en, 0);
  const files = out.length ? out : Array.from(fallback || []);
  return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('app').classList.remove('dragging');
  const dt = e.dataTransfer;
  // entries must be grabbed synchronously, before the event ends
  const entries = dt.items && dt.items.length && dt.items[0].webkitGetAsEntry ? Array.from(dt.items).map((i) => i.webkitGetAsEntry()).filter(Boolean) : [];
  const loose = Array.from(dt.files || []);
  if (entries.some((en) => en.isDirectory)) filesFromDrop(entries, loose).then(addFiles);
  else addFiles(loose);
});
window.addEventListener('paste', (e) => {
  const f = e.clipboardData && e.clipboardData.files;
  if (f && f.length && !(e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName))) addFiles(f);
});

window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  const tag = t && t.tagName;
  const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox', 'color'].includes(t.type)) || (t && t.isContentEditable);
  if (typing) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (t === cropEl || (tag === 'INPUT' && t.type === 'range')) return;
    const i = items.findIndex((x) => x.id === currentId);
    const n = items[i + (e.key === 'ArrowRight' ? 1 : -1)];
    if (n) { e.preventDefault(); selectItem(n.id); }
  } else if ((e.key === 'v' || e.key === 'V') && current()) {
    setView(S.view === 'frame' ? 'result' : 'frame');
  }
});

$('btnHelp').addEventListener('click', () => { const d = $('help'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); });
$('btnHelpClose').addEventListener('click', () => $('help').close());
$('btnResetAll').addEventListener('click', async () => {
  if (!confirm('Reset every setting to its default? Your photos and your own watermark image stay as they are.')) return;
  const mine = { kind: S.mine.kind, text: S.mine.text, font: S.mine.font, bold: S.mine.bold, color: S.mine.color };
  Object.assign(S, clone(DEFAULTS));
  Object.assign(S.mine, mine, { enabled: !!assets.mine.logo });
  S.aspect = 'original'; S.view = 'frame';
  for (const it of items) { it.crop = null; it.flip = false; }
  storageDel(STORE_KEY + ':hb'); storageDel(STORE_KEY + ':hb:name');
  await loadHillberryDefault();
  saveSettings(); invalidateDone(); syncAll();
  toast('Settings reset.', 'ok');
});
$('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').close(); });

async function init() {
  loadSettings();
  syncAll();
  syncShell();
  try { await loadHillberryDefault(); }
  catch (e) { toast('The built-in logo could not be loaded: ' + e.message, 'err'); }
  if (assets.hb.logo) {
    const brand = logoThumbURL(assets.hb.logo, 340, 170);
    $('brandLogo').src = brand; $('brandPlate').hidden = false;
    $('emptyLogo').src = brand; $('emptyPlate').hidden = false;
    syncMarksUI();   // show the logo thumbnail in the watermark card right away, not after the rest of start-up
  }
  await restoreSavedImages();
  await probeAutoOrient();
  syncAll();
  engine.start();
}

// Test/debug hook (harmless): lets automated checks drive the app.
window.__hb = { S, items, assets, engine, addFiles, selectItem, exportCurrent, exportAll, getCrop, changeAspect, setView, syncAll, requestDraw, V, CAPS, drawStage, activeMarks, nativeRaster, renderItem, snapshotCommon, requestFor, outName, printInfo, clearAll, removeItem, setAsset, renderTextLogo, afterMarksChanged, outputFormatFor, filesFromDrop, onSave: null };

init().catch((e) => { console.error(e); toast('Something went wrong while starting: ' + (e && e.message), 'err'); });
