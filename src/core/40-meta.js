'use strict';
/* Metadata: EXIF orientation, a sanitised EXIF rebuild, IPTC pass-through, and marker-segment builders.
 *
 * The exported file has the orientation baked into its pixels, a different size, and a different crop, so
 * copying the source EXIF verbatim would be wrong (double rotation, stale dimensions) and — worse — would drag
 * along the embedded thumbnail / MakerNote preview of the *original, un-watermarked, un-cropped* photo.
 * We therefore rebuild a clean EXIF block from a known-good set of tags instead of patching the old one. */
HB.exif = (function () {
  const { ascii, be16, be32 } = HB.util;
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function parseTIFF(b) {
    if (!b || b.length < 8) return null;
    const le = b[0] === 0x49 && b[1] === 0x49;
    if (!le && !(b[0] === 0x4D && b[1] === 0x4D)) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
    if (u16(2) !== 42) return null;
    function readIFD(off) {
      if (off < 8 || off + 2 > b.length) return null;
      const n = u16(off);
      const entries = [];
      for (let i = 0; i < n; i++) {
        const o = off + 2 + 12 * i;
        if (o + 12 > b.length) break;
        const tag = u16(o), type = u16(o + 2), count = u32(o + 4);
        const ts = TYPE_SIZE[type];
        if (!ts) continue;
        const sz = ts * count;
        if (sz === 0 || sz > b.length) continue;
        let vo = o + 8;
        if (sz > 4) { vo = u32(o + 8); if (vo < 8 || vo + sz > b.length) continue; }
        entries.push({ tag, type, count, bytes: b.slice(vo, vo + sz) });
      }
      return { entries };
    }
    return { le, u16, u32, readIFD, ifd0Offset: u32(4) };
  }

  function entryUint(e, le) {
    const dv = new DataView(e.bytes.buffer, e.bytes.byteOffset, e.bytes.byteLength);
    if (e.type === 3) return dv.getUint16(0, le);
    if (e.type === 4) return dv.getUint32(0, le);
    if (e.type === 1) return e.bytes[0];
    return null;
  }

  /** 1..8 (defaults to 1 when absent or invalid). */
  function orientation(exifBytes) {
    try {
      const t = parseTIFF(exifBytes);
      if (!t) return 1;
      const ifd0 = t.readIFD(t.ifd0Offset);
      const e = ifd0 && ifd0.entries.find((x) => x.tag === 0x0112);
      const v = e ? entryUint(e, t.le) : 1;
      return v >= 1 && v <= 8 ? v : 1;
    } catch (err) { return 1; }
  }

  /** Reads a few facts for the UI / pipeline without rebuilding anything. */
  function summarize(exifBytes) {
    const out = { orientation: 1, dpi: null, colorSpace: null, hasGPS: false, make: '', model: '' };
    try {
      const t = parseTIFF(exifBytes);
      if (!t) return out;
      const ifd0 = t.readIFD(t.ifd0Offset);
      if (!ifd0) return out;
      const g = (tag) => ifd0.entries.find((x) => x.tag === tag);
      out.orientation = orientation(exifBytes);
      const str = (e) => (e ? ascii(e.bytes, 0, e.bytes.length).replace(/\0.*$/, '').trim() : '');
      out.make = str(g(0x010F)); out.model = str(g(0x0110));
      out.hasGPS = !!g(0x8825);
      const xr = g(0x011A), ru = g(0x0128);
      if (xr && xr.type === 5) {
        const dv = new DataView(xr.bytes.buffer, xr.bytes.byteOffset, 8);
        const num = dv.getUint32(0, t.le), den = dv.getUint32(4, t.le);
        const unit = ru ? entryUint(ru, t.le) : 2;
        if (den && num && unit === 2) out.dpi = num / den;
      }
      const ep = g(0x8769);
      if (ep) {
        const ex = t.readIFD(entryUint(ep, t.le));
        const cs = ex && ex.entries.find((x) => x.tag === 0xA001);
        if (cs) out.colorSpace = entryUint(cs, t.le);
      }
    } catch (err) { /* best effort */ }
    return out;
  }

  const KEEP_IFD0 = new Set([0x010E, 0x010F, 0x0110, 0x0131, 0x0132, 0x013B, 0x0213, 0x8298, 0x9C9B, 0x9C9C, 0x9C9D, 0x9C9E, 0x9C9F]);
  // Exif sub-IFD tags we never carry over: MakerNote (may hold previews / serials), Interop pointer, unique id,
  // subject-area coordinates (they refer to the uncropped frame) and the tags we write ourselves.
  const DROP_EXIF = new Set([0x927C, 0xA005, 0xA420, 0x9214, 0xA214, 0xA001, 0xA002, 0xA003]);

  function build(le, ifd0Entries, exifEntries, gpsEntries) {
    const sortE = (a) => a.sort((x, y) => x.tag - y.tag);
    const mkPtr = (tag) => ({ tag, type: 4, count: 1, bytes: new Uint8Array(4), ptr: true });
    ifd0Entries = ifd0Entries.slice(); exifEntries = exifEntries.slice();
    const ex = exifEntries.length ? mkPtr(0x8769) : null;
    const gp = gpsEntries && gpsEntries.length ? mkPtr(0x8825) : null;
    if (ex) ifd0Entries.push(ex);
    if (gp) ifd0Entries.push(gp);
    sortE(ifd0Entries); sortE(exifEntries);
    const gps = gpsEntries ? sortE(gpsEntries.slice()) : [];
    const ifdSize = (arr) => 2 + 12 * arr.length + 4;
    const ifd0Off = 8;
    const exifOff = ifd0Off + ifdSize(ifd0Entries);
    const gpsOff = exifOff + (ex ? ifdSize(exifEntries) : 0);
    let dataOff = gpsOff + (gp ? ifdSize(gps) : 0);
    const all = [ifd0Entries].concat(ex ? [exifEntries] : [], gp ? [gps] : []);
    let total = dataOff;
    for (const arr of all) for (const e of arr) if (e.bytes.length > 4) total += e.bytes.length + (e.bytes.length & 1);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out[0] = out[1] = le ? 0x49 : 0x4D;
    dv.setUint16(2, 42, le); dv.setUint32(4, ifd0Off, le);
    let dp = dataOff;
    function write(off, entries, ptrs) {
      dv.setUint16(off, entries.length, le);
      entries.forEach((e, i) => {
        const o = off + 2 + 12 * i;
        dv.setUint16(o, e.tag, le); dv.setUint16(o + 2, e.type, le); dv.setUint32(o + 4, e.count, le);
        if (e.ptr) { dv.setUint32(o + 8, e.tag === 0x8769 ? exifOff : gpsOff, le); return; }
        if (e.bytes.length <= 4) out.set(e.bytes, o + 8);
        else { out.set(e.bytes, dp); dv.setUint32(o + 8, dp, le); dp += e.bytes.length + (e.bytes.length & 1); }
      });
      dv.setUint32(off + 2 + 12 * entries.length, 0, le);
    }
    write(ifd0Off, ifd0Entries);
    if (ex) write(exifOff, exifEntries);
    if (gp) write(gpsOff, gps);
    return out;
  }

  /**
   * Returns the APP1 payload ("Exif\0\0" + TIFF) or null.
   * opts: { width, height, colorSpaceTag (1 = sRGB, 0xFFFF = uncalibrated), dpi, stripGPS }
   */
  function rebuild(exifBytes, opts) {
    let t = null, ifd0 = null;
    try { t = parseTIFF(exifBytes); ifd0 = t && t.readIFD(t.ifd0Offset); } catch (e) { t = null; }
    const le = t ? t.le : false;
    const mk = (tag, type, count, writer, size) => {
      const bytes = new Uint8Array(size);
      writer(new DataView(bytes.buffer));
      return { tag, type, count, bytes };
    };
    const short = (tag, v) => mk(tag, 3, 1, (d) => d.setUint16(0, v, le), 2);
    const long = (tag, v) => mk(tag, 4, 1, (d) => d.setUint32(0, v, le), 4);
    const rational = (tag, n, dn) => mk(tag, 5, 1, (d) => { d.setUint32(0, n, le); d.setUint32(4, dn, le); }, 8);

    const ifd0Entries = [], exifEntries = [];
    let gpsEntries = null;
    if (ifd0) {
      for (const e of ifd0.entries) {
        if (KEEP_IFD0.has(e.tag)) ifd0Entries.push(e);
        if (e.tag === 0x011A || e.tag === 0x011B || e.tag === 0x0128) { if (!opts.dpi) ifd0Entries.push(e); }
      }
      const ep = ifd0.entries.find((e) => e.tag === 0x8769);
      if (ep) {
        const sub = t.readIFD(entryUint(ep, le));
        if (sub) for (const e of sub.entries) if (!DROP_EXIF.has(e.tag)) exifEntries.push(e);
      }
      const gp = ifd0.entries.find((e) => e.tag === 0x8825);
      if (gp && !opts.stripGPS) {
        const sub = t.readIFD(entryUint(gp, le));
        if (sub && sub.entries.length) gpsEntries = sub.entries;
      }
    }
    ifd0Entries.push(short(0x0112, 1)); // pixels are already upright
    if (opts.dpi) {
      const d = Math.max(1, Math.round(opts.dpi));
      ifd0Entries.push(rational(0x011A, d, 1), rational(0x011B, d, 1), short(0x0128, 2));
    }
    exifEntries.push(long(0xA002, opts.width), long(0xA003, opts.height), short(0xA001, opts.colorSpaceTag == null ? 1 : opts.colorSpaceTag));
    let tiff = build(le, ifd0Entries, exifEntries, gpsEntries);
    if (tiff.length > 65000) {
      // too big for one APP1: drop the large entries (long comments etc.) and retry
      const small = (arr) => arr.filter((e) => e.bytes.length <= 256);
      tiff = build(le, small(ifd0Entries), small(exifEntries), gpsEntries && small(gpsEntries));
    }
    const out = new Uint8Array(6 + tiff.length);
    out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0);
    out.set(tiff, 6);
    return out;
  }

  // ------------------------------------------------------------ IPTC (Photoshop 8BIM resource 0x0404 only)
  function extractIPTC(photoshopBlocks) {
    for (const b of photoshopBlocks || []) {
      let p = 0;
      while (p + 12 <= b.length) {
        if (ascii(b, p, 4) !== '8BIM') break;
        const id = be16(b, p + 4), nameLen = b[p + 6];
        let q = p + 7 + nameLen;
        if ((nameLen + 1) & 1) q++;
        if (q + 4 > b.length) break;
        const size = be32(b, q); q += 4;
        if (q + size > b.length) break;
        if (id === 0x0404) return b.slice(q, q + size);
        p = q + size + (size & 1);
      }
    }
    return null;
  }

  // ------------------------------------------------------------ marker segments
  function segment(marker, payload) {
    const out = new Uint8Array(4 + payload.length);
    out[0] = 0xFF; out[1] = marker;
    out[2] = (payload.length + 2) >> 8; out[3] = (payload.length + 2) & 255;
    out.set(payload, 4);
    return out;
  }
  const cstr = (s) => { const a = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };

  function exifSegment(payload) { return segment(0xE1, payload); }

  function iccSegments(profile) {
    const MAX = 65519, n = Math.ceil(profile.length / MAX), out = [];
    if (n > 255) return out;
    const head = cstr('ICC_PROFILE');
    for (let i = 0; i < n; i++) {
      const chunk = profile.subarray(i * MAX, Math.min(profile.length, (i + 1) * MAX));
      const p = new Uint8Array(head.length + 2 + chunk.length);
      p.set(head, 0); p[head.length] = i + 1; p[head.length + 1] = n; p.set(chunk, head.length + 2);
      out.push(segment(0xE2, p));
    }
    return out;
  }

  function iptcSegment(iim) {
    if (!iim || iim.length > 65000) return null;
    const h = cstr('Photoshop 3.0');
    const pad = iim.length & 1;
    const p = new Uint8Array(h.length + 4 + 2 + 2 + 4 + iim.length + pad);
    let o = 0;
    p.set(h, o); o += h.length;
    p.set([0x38, 0x42, 0x49, 0x4D, 0x04, 0x04, 0, 0], o); o += 8;
    p[o++] = iim.length >>> 24; p[o++] = (iim.length >>> 16) & 255; p[o++] = (iim.length >>> 8) & 255; p[o++] = iim.length & 255;
    p.set(iim, o);
    return segment(0xED, p);
  }

  return { parseTIFF, orientation, summarize, rebuild, extractIPTC, segment, exifSegment, iccSegments, iptcSegment };
})();
