'use strict';
/* ICC profile handling.
 *
 * Why this exists: to export "in the same color space" we composite the (sRGB) watermark directly
 * into the photo's own encoded values and re-embed the photo's original profile. For that we need to
 * convert the watermark's colors from sRGB into whatever space the photo is in (Adobe RGB, Display P3,
 * ProPhoto ...). Photo profiles are almost always matrix/TRC profiles, which is what we support. */
HB.icc = (function () {
  const { ascii, HBError } = HB.util;

  // ---------- 3x3 helpers (row-major arrays of 9) ----------
  function mul3(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
    return r;
  }
  function inv3(m) {
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const id = 1 / (a * A + b * B + c * C);
    return [A * id, -(b * i - c * h) * id, (b * f - c * e) * id,
      B * id, (a * i - c * g) * id, -(a * f - c * d) * id,
      C * id, -(a * h - b * g) * id, (a * e - b * d) * id];
  }
  function mulv3(m, v) {
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  }

  const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  function adaptWhite(srcW, dstW) {
    const s = mulv3(BRADFORD, srcW), d = mulv3(BRADFORD, dstW);
    const D = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]];
    return mul3(mul3(inv3(BRADFORD), D), BRADFORD);
  }
  function xyzFromXY(xy) { return [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]]; }
  function rgbToXYZ(r, g, b, w) {
    const R = xyzFromXY(r), G = xyzFromXY(g), B = xyzFromXY(b), W = xyzFromXY(w);
    const P = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
    const S = mulv3(inv3(P), W);
    return [P[0] * S[0], P[1] * S[1], P[2] * S[2], P[3] * S[0], P[4] * S[1], P[5] * S[2], P[6] * S[0], P[7] * S[1], P[8] * S[2]];
  }

  const D65_XY = [0.3127, 0.3290];
  const D65 = xyzFromXY(D65_XY);
  const D50 = [0.9642, 1.0, 0.8249]; // ICC PCS illuminant
  const D65_TO_D50 = adaptWhite(D65, D50);
  const SRGB_TO_XYZ_D50 = mul3(D65_TO_D50, rgbToXYZ([0.64, 0.33], [0.30, 0.60], [0.15, 0.06], D65_XY));
  const P3_TO_XYZ_D50 = mul3(D65_TO_D50, rgbToXYZ([0.680, 0.320], [0.265, 0.690], [0.150, 0.060], D65_XY));

  function srgbDecode(e) { return e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4); }

  // ---------- parsing ----------
  function s15f16(dv, o) { return dv.getInt32(o) / 65536; }

  function readXYZ(dv, b, off) {
    if (ascii(b, off, 4) !== 'XYZ ') throw new HBError('unsupported', 'bad XYZ tag');
    return [s15f16(dv, off + 8), s15f16(dv, off + 12), s15f16(dv, off + 16)];
  }

  function readCurve(dv, b, off) {
    const type = ascii(b, off, 4);
    if (type === 'curv') {
      const n = dv.getUint32(off + 8);
      if (n === 0) return { kind: 'identity', f: (e) => e };
      if (n === 1) {
        const g = dv.getUint16(off + 12) / 256;
        return { kind: 'gamma', gamma: g, f: (e) => Math.pow(e, g) };
      }
      if (off + 12 + 2 * n > b.length) throw new HBError('unsupported', 'truncated curve');
      const t = new Float64Array(n);
      for (let i = 0; i < n; i++) t[i] = dv.getUint16(off + 12 + 2 * i) / 65535;
      return {
        kind: 'table',
        f: (e) => {
          if (e <= 0) return t[0];
          if (e >= 1) return t[n - 1];
          const p = e * (n - 1), i = p | 0;
          return t[i] + (t[i + 1] - t[i]) * (p - i);
        },
      };
    }
    if (type === 'para') {
      const ft = dv.getUint16(off + 8);
      const counts = [1, 3, 4, 5, 7];
      if (ft > 4) throw new HBError('unsupported', 'unknown parametric curve');
      const p = [];
      for (let i = 0; i < counts[ft]; i++) p.push(s15f16(dv, off + 12 + 4 * i));
      const g = p[0], a = p[1], bb = p[2], c = p[3], d = p[4], e2 = p[5], f2 = p[6];
      let f;
      switch (ft) {
        case 0: f = (x) => Math.pow(x, g); break;
        case 1: f = (x) => (x >= -bb / a ? Math.pow(a * x + bb, g) : 0); break;
        case 2: f = (x) => (x >= -bb / a ? Math.pow(a * x + bb, g) + c : c); break;
        case 3: f = (x) => (x >= d ? Math.pow(a * x + bb, g) : c * x); break;
        default: f = (x) => (x >= d ? Math.pow(a * x + bb, g) + e2 : c * x + f2);
      }
      return { kind: 'parametric', f: (e) => Math.max(0, f(e)) };
    }
    throw new HBError('unsupported', 'unknown curve type ' + type);
  }

  function readText(dv, b, off, size) {
    const type = ascii(b, off, 4);
    try {
      if (type === 'desc') {
        const n = dv.getUint32(off + 8);
        return ascii(b, off + 12, Math.max(0, n - 1));
      }
      if (type === 'mluc') {
        const count = dv.getUint32(off + 8);
        if (count < 1) return '';
        const len = dv.getUint32(off + 20), o = dv.getUint32(off + 24);
        let s = '';
        for (let i = 0; i < len; i += 2) s += String.fromCharCode(dv.getUint16(off + o + i));
        return s;
      }
      if (type === 'text') return ascii(b, off + 8, size - 9);
    } catch (e) { /* fall through */ }
    return '';
  }

  /** Parse an ICC profile. Returns null if it isn't one. `kind` says whether we can treat it as matrix/TRC. */
  function parse(bytes) {
    try {
      if (!bytes || bytes.length < 132) return null;
      if (ascii(bytes, 36, 4) !== 'acsp') return null;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const info = {
        size: bytes.length,
        version: bytes[8],
        cls: ascii(bytes, 12, 4),
        space: ascii(bytes, 16, 4),
        pcs: ascii(bytes, 20, 4),
        description: '',
        kind: 'unsupported',
        matrix: null,
        trc: null,
      };
      const n = Math.min(dv.getUint32(128), 200);
      const tags = {};
      for (let i = 0; i < n; i++) {
        const o = 132 + 12 * i;
        if (o + 12 > bytes.length) break;
        const off = dv.getUint32(o + 4), size = dv.getUint32(o + 8);
        if (off + size > bytes.length || off < 128) continue;
        tags[ascii(bytes, o, 4)] = { off, size };
      }
      if (tags.desc) info.description = readText(dv, bytes, tags.desc.off, tags.desc.size);
      const hasLut = !!(tags.A2B0 || tags.A2B1 || tags.A2B2);
      if (info.space === 'GRAY') { info.kind = 'gray'; return info; }
      if (info.space !== 'RGB ') return info;
      if (hasLut) { info.kind = 'lut'; return info; }
      if (info.pcs === 'XYZ ' && tags.rXYZ && tags.gXYZ && tags.bXYZ && tags.rTRC && tags.gTRC && tags.bTRC) {
        const r = readXYZ(dv, bytes, tags.rXYZ.off), g = readXYZ(dv, bytes, tags.gXYZ.off), b = readXYZ(dv, bytes, tags.bXYZ.off);
        info.matrix = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
        info.trc = [readCurve(dv, bytes, tags.rTRC.off), readCurve(dv, bytes, tags.gTRC.off), readCurve(dv, bytes, tags.bTRC.off)];
        info.kind = 'matrix';
      }
      return info;
    } catch (e) {
      return null;
    }
  }

  // ---------- sRGB -> photo space conversion ----------
  const LUT_N = 16384, INV_N = 65535;

  /** For a monotone curve f: encoded[0..1] -> linear[0..1], build linear -> encoded(0..255) lookup. */
  function inverseLut(curve) {
    const F = new Float64Array(LUT_N + 1);
    for (let i = 0; i <= LUT_N; i++) F[i] = curve.f(i / LUT_N);
    for (let i = 1; i <= LUT_N; i++) if (F[i] < F[i - 1]) F[i] = F[i - 1];
    const out = new Float32Array(INV_N + 1);
    let i = 0;
    for (let j = 0; j <= INV_N; j++) {
      const lin = j / INV_N;
      while (i < LUT_N - 1 && F[i + 1] < lin) i++;
      const f0 = F[i], f1 = F[i + 1];
      let t = f1 > f0 ? (lin - f0) / (f1 - f0) : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      out[j] = ((i + t) / LUT_N) * 255;
    }
    return out;
  }

  const SRGB_DEC = (function () {
    const t = new Float32Array(256);
    for (let i = 0; i < 256; i++) t[i] = srgbDecode(i / 255);
    return t;
  })();

  /** Returns { identity, convertRGBA(arr), convertColor([r,g,b]) } mapping sRGB-encoded 8-bit values
   *  to the 8-bit encoding of `info` (a parsed matrix profile). */
  function createSRGBConverter(info) {
    if (!info || info.kind !== 'matrix') throw new HBError('unsupported', 'no matrix profile');
    const M = mul3(inv3(info.matrix), SRGB_TO_XYZ_D50);
    const lut = info.trc.map(inverseLut);

    function enc(table, lin) {
      if (lin <= 0) return table[0];
      if (lin >= 1) return table[INV_N];
      const v = lin * INV_N, j = v | 0, fr = v - j;
      return table[j] + (table[j + 1] - table[j]) * fr;
    }
    function convertColor(c) {
      const lr = SRGB_DEC[c[0] | 0], lg = SRGB_DEC[c[1] | 0], lb = SRGB_DEC[c[2] | 0];
      return [
        enc(lut[0], M[0] * lr + M[1] * lg + M[2] * lb),
        enc(lut[1], M[3] * lr + M[4] * lg + M[5] * lb),
        enc(lut[2], M[6] * lr + M[7] * lg + M[8] * lb),
      ];
    }
    // Is this effectively sRGB already? (then skip the work and avoid any rounding noise)
    let maxDiff = 0;
    for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
      const o = convertColor([r, g, b]);
      maxDiff = Math.max(maxDiff, Math.abs(o[0] - r), Math.abs(o[1] - g), Math.abs(o[2] - b));
    }
    const identity = maxDiff < 0.6;

    /** px: Uint8 RGBA (sRGB, straight alpha). out: Float32Array(px.length) receiving colour in the target space
     *  (unrounded, 0..255) and the untouched alpha (0..255). */
    function convertRGBA(px, out) {
      const n = px.length;
      if (identity) { for (let i = 0; i < n; i++) out[i] = px[i]; return out; }
      for (let i = 0; i < n; i += 4) {
        out[i + 3] = px[i + 3];
        if (px[i + 3] === 0) { out[i] = out[i + 1] = out[i + 2] = 0; continue; }
        const lr = SRGB_DEC[px[i]], lg = SRGB_DEC[px[i + 1]], lb = SRGB_DEC[px[i + 2]];
        out[i] = enc(lut[0], M[0] * lr + M[1] * lg + M[2] * lb);
        out[i + 1] = enc(lut[1], M[3] * lr + M[4] * lg + M[5] * lb);
        out[i + 2] = enc(lut[2], M[6] * lr + M[7] * lg + M[8] * lb);
      }
      return out;
    }
    return { identity, maxDiff, convertRGBA, convertColor };
  }

  // ---------- generating clean profiles (used to tag outputs that need an explicit sRGB / P3 profile) ----------
  function buildMatrixProfile(description, toXYZ) {
    const CURVE_N = 1024;
    const descBytes = description.length + 1;
    const descSize = 12 + descBytes + 4 + 4 + 2 + 1 + 67;
    const cprt = 'No copyright, use freely';
    const sizes = {
      desc: pad4(descSize), cprt: pad4(8 + cprt.length + 1), wtpt: 20, rXYZ: 20, gXYZ: 20, bXYZ: 20, curv: 12 + 2 * CURVE_N,
    };
    const tagCount = 9;
    let off = 128 + 4 + tagCount * 12;
    const offs = {};
    for (const k of ['desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'curv']) { offs[k] = off; off += sizes[k]; }
    const total = off;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    const put4 = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
    const putF = (o, v) => dv.setInt32(o, Math.round(v * 65536));

    dv.setUint32(0, total);
    dv.setUint32(8, 0x02100000); // v2.1
    put4(12, 'mntr'); put4(16, 'RGB '); put4(20, 'XYZ ');
    dv.setUint16(24, 2024); dv.setUint16(26, 1); dv.setUint16(28, 1);
    put4(36, 'acsp');
    putF(68, D50[0]); putF(72, D50[1]); putF(76, D50[2]);

    dv.setUint32(128, tagCount);
    const tagList = [['desc', 'desc'], ['cprt', 'cprt'], ['wtpt', 'wtpt'], ['rXYZ', 'rXYZ'], ['gXYZ', 'gXYZ'], ['bXYZ', 'bXYZ'], ['rTRC', 'curv'], ['gTRC', 'curv'], ['bTRC', 'curv']];
    tagList.forEach((t, i) => {
      const o = 132 + 12 * i;
      put4(o, t[0]);
      dv.setUint32(o + 4, offs[t[1]]);
      dv.setUint32(o + 8, t[1] === 'curv' ? sizes.curv : (t[1] === 'desc' ? descSize : t[1] === 'cprt' ? 8 + cprt.length + 1 : 20));
    });

    // desc (v2 textDescriptionType)
    put4(offs.desc, 'desc'); dv.setUint32(offs.desc + 8, descBytes);
    for (let i = 0; i < description.length; i++) out[offs.desc + 12 + i] = description.charCodeAt(i);
    // cprt
    put4(offs.cprt, 'text');
    for (let i = 0; i < cprt.length; i++) out[offs.cprt + 8 + i] = cprt.charCodeAt(i);
    // wtpt + colorants
    const xyz = (o, x, y, z) => { put4(o, 'XYZ '); putF(o + 8, x); putF(o + 12, y); putF(o + 16, z); };
    xyz(offs.wtpt, D50[0], D50[1], D50[2]);
    xyz(offs.rXYZ, toXYZ[0], toXYZ[3], toXYZ[6]);
    xyz(offs.gXYZ, toXYZ[1], toXYZ[4], toXYZ[7]);
    xyz(offs.bXYZ, toXYZ[2], toXYZ[5], toXYZ[8]);
    // sRGB transfer curve, 1024 entries
    put4(offs.curv, 'curv'); dv.setUint32(offs.curv + 8, CURVE_N);
    for (let i = 0; i < CURVE_N; i++) dv.setUint16(offs.curv + 12 + 2 * i, Math.round(65535 * srgbDecode(i / (CURVE_N - 1))));
    return out;
  }
  function pad4(n) { return (n + 3) & ~3; }

  let cache = {};
  function makeSRGB() { return cache.srgb || (cache.srgb = buildMatrixProfile('sRGB IEC61966-2.1', SRGB_TO_XYZ_D50)); }
  function makeDisplayP3() { return cache.p3 || (cache.p3 = buildMatrixProfile('Display P3', P3_TO_XYZ_D50)); }

  /** Friendly label for the UI. */
  function label(info, bytes) {
    if (!bytes) return 'No profile (treated as sRGB)';
    if (!info) return 'Unreadable profile';
    return info.description || 'Embedded profile';
  }

  return {
    parse, createSRGBConverter, makeSRGB, makeDisplayP3, label,
    _internal: { mul3, inv3, mulv3, SRGB_TO_XYZ_D50, P3_TO_XYZ_D50, srgbDecode, inverseLut },
  };
})();
