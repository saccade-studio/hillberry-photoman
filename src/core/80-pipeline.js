'use strict';
/* The export pipeline:  decode (raw, no colour conversion) -> orient + crop -> composite watermarks in the photo's own
 * colour space -> encode at native resolution -> embed the original ICC profile (and sanitised metadata).
 *
 * The same code runs inside the Web Worker and (as a fallback) on the main thread. */
HB.pipeline = (function () {
  const { HBError, sniffFormat } = HB.util;

  // ------------------------------------------------------------------ inspecting a file (cheap, no pixel decode)
  /** Reads only headers. Used when a photo is added, to learn its size, orientation and colour profile. */
  async function inspect(bytes) {
    const fmt = sniffFormat(bytes);
    const out = {
      format: fmt, width: 0, height: 0, orientation: 1, icc: null, profile: null, rawCapable: false,
      exif: null, hasGPS: false, note: '',
    };
    if (fmt === 'jpeg') {
      const m = HB.jpeg.probe(bytes);
      const ex = m.exif ? HB.exif.summarize(m.exif) : null;
      out.orientation = ex ? ex.orientation : 1;
      out.rawWidth = m.width; out.rawHeight = m.height;
      const swap = out.orientation >= 5;
      out.width = swap ? m.height : m.width; out.height = swap ? m.width : m.height;
      out.icc = m.icc; out.exif = ex; out.hasGPS = !!(ex && ex.hasGPS);
      out.ncomp = m.comps.length;
      out.rawCapable = m.sofType <= 2 && !m.arithmetic && m.precision === 8 && (m.comps.length === 1 || m.comps.length === 3);
    } else if (fmt === 'png') {
      const p = await HB.png.probe(bytes);
      out.width = p.width; out.height = p.height; out.icc = p.icc; out.rawCapable = true;
      out.rawWidth = p.width; out.rawHeight = p.height;
    }
    if (out.icc) {
      const info = HB.icc.parse(out.icc);
      out.profile = info ? { description: info.description, kind: info.kind, space: info.space } : { description: 'Unreadable profile', kind: 'unsupported' };
      if (!info || (info.kind !== 'matrix' && info.kind !== 'gray')) out.rawCapable = false;
    }
    return out;
  }

  // ------------------------------------------------------------------ decoding
  async function decodeSource(source) {
    if (source.raster) {
      const r = source.raster;
      return { width: r.width, height: r.height, rgb: new Uint8Array(r.buffer), orientation: 1, icc: null, native: r.space || 'srgb', kind: 'native' };
    }
    const bytes = new Uint8Array(source.bytes);
    const fmt = sniffFormat(bytes);
    if (fmt === 'jpeg') {
      const d = HB.jpeg.decode(bytes);
      const m = d.meta;
      return {
        width: d.width, height: d.height, rgb: d.rgb, orientation: m.exif ? HB.exif.orientation(m.exif) : 1, icc: m.icc,
        exif: m.exif, iptc: HB.exif.extractIPTC(m.photoshop), jfif: m.jfif, kind: 'jpeg', ncomp: d.ncomp, warnings: d.warnings,
      };
    }
    if (fmt === 'png') {
      const d = await HB.png.decode(bytes);
      return { width: d.width, height: d.height, rgb: d.rgb, orientation: 1, icc: d.icc, kind: 'png' };
    }
    throw new HBError('unsupported', 'This file type needs the browser decoder');
  }

  // ------------------------------------------------------------------ colour plan
  function planColor(src) {
    if (src.kind === 'native') {
      if (src.native === 'display-p3') {
        const prof = HB.icc.makeDisplayP3();
        return { iccOut: prof, converter: HB.icc.createSRGBConverter(HB.icc.parse(prof)), label: 'Display P3', preserved: false, srgb: false, note: 'Converted by the browser to Display P3' };
      }
      return { iccOut: HB.icc.makeSRGB(), converter: null, label: 'sRGB', preserved: false, srgb: true, note: 'Converted by the browser to sRGB' };
    }
    if (!src.icc) return { iccOut: HB.icc.makeSRGB(), converter: null, label: 'sRGB (no profile in the original)', preserved: true, srgb: true, note: '' };
    const info = HB.icc.parse(src.icc);
    if (info && info.kind === 'matrix') {
      const conv = HB.icc.createSRGBConverter(info);
      return { iccOut: src.icc, converter: conv.identity ? null : conv, label: info.description || 'Embedded profile', preserved: true, srgb: conv.identity, note: '' };
    }
    if (info && info.kind === 'gray') {
      return { iccOut: HB.icc.makeSRGB(), converter: null, label: 'sRGB (gray profile)', preserved: true, srgb: true, note: '' };
    }
    throw new HBError('unsupported', 'ICC profile type is not supported for direct pass-through');
  }

  // ------------------------------------------------------------------ oriented crop reader
  function transformFor(o, Ws, Hs) {
    switch (o) {
      case 2: return { ax: -1, bx: 0, cx: Ws - 1, ay: 0, by: 1, cy: 0 };
      case 3: return { ax: -1, bx: 0, cx: Ws - 1, ay: 0, by: -1, cy: Hs - 1 };
      case 4: return { ax: 1, bx: 0, cx: 0, ay: 0, by: -1, cy: Hs - 1 };
      case 5: return { ax: 0, bx: 1, cx: 0, ay: 1, by: 0, cy: 0 };
      case 6: return { ax: 0, bx: 1, cx: 0, ay: -1, by: 0, cy: Hs - 1 };
      case 7: return { ax: 0, bx: -1, cx: Ws - 1, ay: -1, by: 0, cy: Hs - 1 };
      case 8: return { ax: 0, bx: -1, cx: Ws - 1, ay: 1, by: 0, cy: 0 };
      default: return { ax: 1, bx: 0, cx: 0, ay: 0, by: 1, cy: 0 };
    }
  }

  /** Returns read(y0, n, out): fills `out` with RGB rows y0..y0+n-1 of the oriented, cropped image. */
  function makeReader(rgb, Ws, Hs, orientation, crop) {
    const T = transformFor(orientation, Ws, Hs);
    const w = crop.w, step = (T.ay * Ws + T.ax) * 3, contiguous = T.ax === 1 && T.ay === 0;
    return function read(y0, n, out) {
      for (let r = 0; r < n; r++) {
        const yd = crop.y + y0 + r;
        const xs = T.ax * crop.x + T.bx * yd + T.cx, ys = T.ay * crop.x + T.by * yd + T.cy;
        let idx = (ys * Ws + xs) * 3, o = r * w * 3;
        if (contiguous) { out.set(rgb.subarray(idx, idx + w * 3), o); continue; }
        for (let x = 0; x < w; x++, idx += step, o += 3) { out[o] = rgb[idx]; out[o + 1] = rgb[idx + 1]; out[o + 2] = rgb[idx + 2]; }
      }
    };
  }

  // ------------------------------------------------------------------ the export
  /**
   * req: {
   *   id, source: { bytes } | { raster: { width, height, buffer, space } },
   *   crop: { x, y, w, h }                      // in the upright (display) orientation, integer pixels
   *   marks: [{ side, logo: { w, h, rgba }, size }]
   *   style: { margin, opacity, shadow: { on, strength, blur, distance, angle, color:[r,g,b] } }
   *   out:   { format: 'jpeg'|'png', quality, chroma, optimize, metadata: 'all'|'nogps'|'none', dpi }
   * }
   */
  async function run(req, post) {
    const t0 = Date.now();
    const progress = (stage, f) => post && post({ type: 'progress', id: req.id, stage, fraction: f });
    progress('decode', 0);
    let src = await decodeSource(req.source);
    progress('decode', 1);

    const plan = planColor(src);
    const Ws = src.width, Hs = src.height, o = src.orientation;
    const Wd = o >= 5 ? Hs : Ws, Hd = o >= 5 ? Ws : Hs;
    const c = req.crop || { x: 0, y: 0, w: Wd, h: Hd };
    const crop = {
      x: Math.max(0, Math.min(Wd - 1, Math.round(c.x))), y: Math.max(0, Math.min(Hd - 1, Math.round(c.y))), w: 0, h: 0,
    };
    crop.w = Math.max(1, Math.min(Wd - crop.x, Math.round(c.w)));
    crop.h = Math.max(1, Math.min(Hd - crop.y, Math.round(c.h)));
    if (req.expect && (req.expect.width !== Wd || req.expect.height !== Hd)) {
      throw new HBError('unsupported', `Decoded size ${Wd}x${Hd} differs from the preview ${req.expect.width}x${req.expect.height}`);
    }

    // watermark layers, built at the exact output resolution
    const style = req.style;
    const marks = (req.marks || []).filter((m) => m.logo && m.logo.w > 0);
    const boxes = HB.marks.layout(crop.w, crop.h, marks.map((m) => ({ side: m.side, w: m.logo.w, h: m.logo.h, size: m.size })), style.margin);
    const shadowColor = plan.converter ? plan.converter.convertColor(style.shadow.color) : style.shadow.color;
    const layers = boxes.map((box, i) => {
      const prep = HB.marks.prepareLogo(marks[i].logo, plan.converter);
      const small = HB.marks.resize(prep.data, prep.w, prep.h, box.w, box.h);
      const sh = HB.marks.shadowPx(style.shadow, Math.max(box.w, box.h), shadowColor);
      const layer = HB.marks.buildLayer({ w: box.w, h: box.h, data: small }, { opacity: style.opacity, shadow: sh });
      return { layer, x: box.x + layer.ox, y: box.y + layer.oy };
    });

    const read = makeReader(src.rgb, Ws, Hs, o, crop);
    const getRows = (y0, n, buf) => {
      read(y0, n, buf);
      for (const L of layers) HB.marks.compositeLayer(buf, crop.w, y0, n, L.layer, L.x, L.y);
    };

    const out = req.out || {};
    const summ = src.exif ? HB.exif.summarize(src.exif) : null;
    let dpi = out.dpi || (summ && summ.dpi) || (src.jfif && src.jfif.units === 1 && src.jfif.xd) || 72;
    dpi = Math.max(1, Math.min(65535, Math.round(dpi)));

    let bytes, mime;
    if (out.format === 'png') {
      bytes = await HB.png.encode({
        width: crop.w, height: crop.h, getRows, icc: plan.iccOut, dpi, onProgress: (f) => progress('encode', f),
      });
      mime = 'image/png';
    } else {
      const segs = [];
      const keep = out.metadata !== 'none';
      if (keep && src.exif) {
        const payload = HB.exif.rebuild(src.exif, {
          width: crop.w, height: crop.h, colorSpaceTag: plan.srgb ? 1 : 0xFFFF, dpi: out.dpi || null, stripGPS: out.metadata === 'nogps',
        });
        if (payload) segs.push(HB.exif.exifSegment(payload));
      }
      for (const s of HB.exif.iccSegments(plan.iccOut)) segs.push(s);
      if (keep && src.iptc) { const s = HB.exif.iptcSegment(src.iptc); if (s) segs.push(s); }
      bytes = HB.jpegEnc.encode({
        width: crop.w, height: crop.h, quality: out.quality == null ? 100 : out.quality, subsampling: out.chroma === '420' ? '420' : '444',
        optimize: out.optimize !== false, segments: segs, jfif: { units: 1, xd: dpi, yd: dpi }, getRows,
        onProgress: (f) => progress('encode', f),
      });
      mime = 'image/jpeg';
    }
    const damaged = !!(src.warnings && src.warnings.some((w) => /truncated|huffman/.test(w)));
    src = null;
    return {
      bytes, mime, width: crop.w, height: crop.h, crc: HB.util.crc32(bytes), ms: Date.now() - t0,
      info: { profile: plan.label, preserved: plan.preserved, note: plan.note, dpi, damaged },
    };
  }

  return { inspect, run, planColor, makeReader, decodeSource };
})();
