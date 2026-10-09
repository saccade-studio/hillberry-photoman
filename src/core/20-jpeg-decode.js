'use strict';
/* JPEG header probing and a full decoder (baseline, extended sequential and progressive Huffman, 8-bit).
 *
 * Why not just let the browser decode? Browsers colour-convert embedded profiles to sRGB while decoding
 * (and not all of them can be told not to). We need the *raw encoded values* so that we can write the
 * result back out in the photo's original colour space. The arithmetic follows libjpeg's defaults
 * (integer "islow" IDCT, fancy chroma upsampling), so decoded pixels match what other viewers show. */
HB.jpeg = (function () {
  const { HBError, ascii, startsWith, be16 } = HB.util;

  const ZZ = new Uint8Array([
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
  ]);

  // ------------------------------------------------------------------ header probe
  /** Walks the marker segments up to the first scan and collects everything we need to know without decoding. */
  function probe(bytes) {
    if (!(bytes.length > 4 && bytes[0] === 0xFF && bytes[1] === 0xD8)) throw new HBError('corrupt', 'Not a JPEG file');
    const meta = {
      width: 0, height: 0, precision: 8, sofType: -1, progressive: false, arithmetic: false, comps: [],
      jfif: null, adobe: null, exif: null, xmp: null, photoshop: [], icc: null, restartInterval: 0, sosOffset: -1,
    };
    const iccChunks = [];
    let iccCount = 0;
    const n = bytes.length;
    let p = 2;
    while (p < n) {
      if (bytes[p] !== 0xFF) { p++; continue; }
      const m = bytes[p + 1];
      if (m === undefined) break;
      if (m === 0xFF) { p++; continue; }
      p += 2;
      if (m === 0x00 || m === 0x01 || (m >= 0xD0 && m <= 0xD8)) continue;
      if (m === 0xD9) break;
      if (p + 2 > n) break;
      const len = be16(bytes, p);
      const s = p + 2, e = p + len;
      if (len < 2 || e > n) break;

      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        meta.sofType = m - 0xC0;
        meta.progressive = m === 0xC2 || m === 0xC6 || m === 0xCA || m === 0xCE;
        meta.arithmetic = m >= 0xC9;
        meta.precision = bytes[s];
        meta.height = be16(bytes, s + 1);
        meta.width = be16(bytes, s + 3);
        const nc = bytes[s + 5];
        for (let i = 0; i < nc; i++) {
          const o = s + 6 + 3 * i;
          meta.comps.push({ id: bytes[o], h: bytes[o + 1] >> 4, v: bytes[o + 1] & 15, tq: bytes[o + 2] });
        }
      } else if (m === 0xE0 && startsWith(bytes, 'JFIF\0', s)) {
        meta.jfif = { units: bytes[s + 7], xd: be16(bytes, s + 8), yd: be16(bytes, s + 10) };
      } else if (m === 0xE1) {
        if (startsWith(bytes, 'Exif\0\0', s)) { if (!meta.exif) meta.exif = bytes.subarray(s + 6, e); }
        else if (startsWith(bytes, 'http://ns.adobe.com/xap/1.0/\0', s)) { if (!meta.xmp) meta.xmp = bytes.subarray(s + 29, e); }
      } else if (m === 0xE2 && startsWith(bytes, 'ICC_PROFILE\0', s)) {
        const seq = bytes[s + 12], cnt = bytes[s + 13];
        iccChunks[seq] = bytes.subarray(s + 14, e);
        iccCount = Math.max(iccCount, cnt);
      } else if (m === 0xED && startsWith(bytes, 'Photoshop 3.0\0', s)) {
        meta.photoshop.push(bytes.subarray(s + 14, e));
      } else if (m === 0xEE && startsWith(bytes, 'Adobe', s) && len >= 14) {
        meta.adobe = { transform: bytes[s + 11] };
      } else if (m === 0xDD) {
        meta.restartInterval = be16(bytes, s);
      } else if (m === 0xDA) {
        meta.sosOffset = p - 2;
        break;
      }
      p = e;
    }
    if (iccCount > 0) {
      const parts = [];
      let ok = true;
      for (let i = 1; i <= iccCount; i++) { if (!iccChunks[i]) { ok = false; break; } parts.push(iccChunks[i]); }
      if (ok) meta.icc = HB.util.concat(parts);
    }
    if (!meta.width || !meta.height || !meta.comps.length) throw new HBError('corrupt', 'JPEG has no frame header');
    return meta;
  }

  // ------------------------------------------------------------------ Huffman tables
  function buildHuffman(counts, symbols) {
    const maxcode = new Int32Array(18).fill(-1);
    const mincode = new Int32Array(17);
    const valptr = new Int32Array(17);
    const look = new Uint16Array(256);
    let code = 0, k = 0;
    for (let l = 1; l <= 16; l++) {
      const cnt = counts[l - 1];
      valptr[l] = k;
      mincode[l] = code;
      if (cnt > 0) {
        maxcode[l] = code + cnt - 1;
        if (l <= 8) {
          for (let i = 0; i < cnt; i++) {
            const c = (code + i) << (8 - l);
            const fill = 1 << (8 - l);
            for (let j = 0; j < fill; j++) look[c + j] = (l << 8) | symbols[k + i];
          }
        }
      }
      code = (code + cnt) << 1;
      k += cnt;
    }
    maxcode[17] = 0x7FFFFFFF;
    return { maxcode, mincode, valptr, look, vals: symbols };
  }

  // ------------------------------------------------------------------ IDCT (libjpeg jidctint "islow")
  const CB = 13, P1 = 2;
  const F_0_298 = 2446, F_0_390 = 3196, F_0_541 = 4433, F_0_765 = 6270, F_0_899 = 7373, F_1_175 = 9633;
  const F_1_501 = 12299, F_1_847 = 15137, F_1_961 = 16069, F_2_053 = 16819, F_2_562 = 20995, F_3_072 = 25172;
  const S1 = CB - P1, R1 = 1 << (S1 - 1);
  const S2 = CB + P1 + 3, R2 = 1 << (S2 - 1);
  const S3 = P1 + 3, R3 = 1 << (S3 - 1);

  function idctBlock(coefs, off, q, out, oo, stride, ws) {
    for (let c = 0; c < 8; c++) {
      const i = off + c;
      if (coefs[i + 8] === 0 && coefs[i + 16] === 0 && coefs[i + 24] === 0 && coefs[i + 32] === 0 &&
          coefs[i + 40] === 0 && coefs[i + 48] === 0 && coefs[i + 56] === 0) {
        const dc = (coefs[i] * q[c]) << P1;
        ws[c] = dc; ws[c + 8] = dc; ws[c + 16] = dc; ws[c + 24] = dc; ws[c + 32] = dc; ws[c + 40] = dc; ws[c + 48] = dc; ws[c + 56] = dc;
        continue;
      }
      let z2 = coefs[i + 16] * q[c + 16], z3 = coefs[i + 48] * q[c + 48];
      let z1 = (z2 + z3) * F_0_541;
      let tmp2 = z1 - z3 * F_1_847;
      let tmp3 = z1 + z2 * F_0_765;
      z2 = coefs[i] * q[c]; z3 = coefs[i + 32] * q[c + 32];
      let tmp0 = (z2 + z3) << CB;
      let tmp1 = (z2 - z3) << CB;
      const t10 = tmp0 + tmp3, t13 = tmp0 - tmp3, t11 = tmp1 + tmp2, t12 = tmp1 - tmp2;
      tmp0 = coefs[i + 56] * q[c + 56]; tmp1 = coefs[i + 40] * q[c + 40];
      tmp2 = coefs[i + 24] * q[c + 24]; tmp3 = coefs[i + 8] * q[c + 8];
      z1 = tmp0 + tmp3; z2 = tmp1 + tmp2; z3 = tmp0 + tmp2; let z4 = tmp1 + tmp3;
      const z5 = (z3 + z4) * F_1_175;
      tmp0 *= F_0_298; tmp1 *= F_2_053; tmp2 *= F_3_072; tmp3 *= F_1_501;
      z1 *= -F_0_899; z2 *= -F_2_562; z3 *= -F_1_961; z4 *= -F_0_390;
      z3 += z5; z4 += z5;
      tmp0 += z1 + z3; tmp1 += z2 + z4; tmp2 += z2 + z3; tmp3 += z1 + z4;
      ws[c] = (t10 + tmp3 + R1) >> S1; ws[c + 56] = (t10 - tmp3 + R1) >> S1;
      ws[c + 8] = (t11 + tmp2 + R1) >> S1; ws[c + 48] = (t11 - tmp2 + R1) >> S1;
      ws[c + 16] = (t12 + tmp1 + R1) >> S1; ws[c + 40] = (t12 - tmp1 + R1) >> S1;
      ws[c + 24] = (t13 + tmp0 + R1) >> S1; ws[c + 32] = (t13 - tmp0 + R1) >> S1;
    }
    for (let r = 0; r < 8; r++) {
      const w = r * 8, o = oo + r * stride;
      if (ws[w + 1] === 0 && ws[w + 2] === 0 && ws[w + 3] === 0 && ws[w + 4] === 0 && ws[w + 5] === 0 && ws[w + 6] === 0 && ws[w + 7] === 0) {
        let v = ((ws[w] + R3) >> S3) + 128;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = v; out[o + 4] = v; out[o + 5] = v; out[o + 6] = v; out[o + 7] = v;
        continue;
      }
      let z2 = ws[w + 2], z3 = ws[w + 6];
      let z1 = (z2 + z3) * F_0_541;
      let tmp2 = z1 - z3 * F_1_847;
      let tmp3 = z1 + z2 * F_0_765;
      let tmp0 = (ws[w] + ws[w + 4]) << CB;
      let tmp1 = (ws[w] - ws[w + 4]) << CB;
      const t10 = tmp0 + tmp3, t13 = tmp0 - tmp3, t11 = tmp1 + tmp2, t12 = tmp1 - tmp2;
      tmp0 = ws[w + 7]; tmp1 = ws[w + 5]; tmp2 = ws[w + 3]; tmp3 = ws[w + 1];
      z1 = tmp0 + tmp3; z2 = tmp1 + tmp2; z3 = tmp0 + tmp2; let z4 = tmp1 + tmp3;
      const z5 = (z3 + z4) * F_1_175;
      tmp0 *= F_0_298; tmp1 *= F_2_053; tmp2 *= F_3_072; tmp3 *= F_1_501;
      z1 *= -F_0_899; z2 *= -F_2_562; z3 *= -F_1_961; z4 *= -F_0_390;
      z3 += z5; z4 += z5;
      tmp0 += z1 + z3; tmp1 += z2 + z4; tmp2 += z2 + z3; tmp3 += z1 + z4;
      let v;
      v = ((t10 + tmp3 + R2) >> S2) + 128; out[o] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = ((t10 - tmp3 + R2) >> S2) + 128; out[o + 7] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = ((t11 + tmp2 + R2) >> S2) + 128; out[o + 1] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = ((t11 - tmp2 + R2) >> S2) + 128; out[o + 6] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = ((t12 + tmp1 + R2) >> S2) + 128; out[o + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = ((t12 - tmp1 + R2) >> S2) + 128; out[o + 5] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = ((t13 + tmp0 + R2) >> S2) + 128; out[o + 3] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = ((t13 - tmp0 + R2) >> S2) + 128; out[o + 4] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  // ------------------------------------------------------------------ colour conversion tables (libjpeg fixed point)
  const CR_R = new Int32Array(256), CB_B = new Int32Array(256), CR_G = new Int32Array(256), CB_G = new Int32Array(256);
  (function () {
    const FIX = (x) => Math.floor(x * 65536 + 0.5), HALF = 1 << 15;
    for (let i = 0; i < 256; i++) {
      const x = i - 128;
      CR_R[i] = (FIX(1.40200) * x + HALF) >> 16;
      CB_B[i] = (FIX(1.77200) * x + HALF) >> 16;
      CR_G[i] = -FIX(0.71414) * x;
      CB_G[i] = -FIX(0.34414) * x + HALF;
    }
  })();

  // ------------------------------------------------------------------ chroma upsampling (libjpeg "fancy")
  function h2v1(plane, base, cw, out) {
    if (cw === 1) { out[0] = out[1] = plane[base]; return; }
    let v = plane[base];
    out[0] = v;
    out[1] = (v * 3 + plane[base + 1] + 2) >> 2;
    for (let i = 1; i < cw - 1; i++) {
      v = plane[base + i] * 3;
      out[2 * i] = (v + plane[base + i - 1] + 1) >> 2;
      out[2 * i + 1] = (v + plane[base + i + 1] + 2) >> 2;
    }
    v = plane[base + cw - 1];
    out[2 * cw - 2] = (v * 3 + plane[base + cw - 2] + 1) >> 2;
    out[2 * cw - 1] = v;
  }
  function h2v2(plane, b0, b1, cw, out) {
    let thiscol = plane[b0] * 3 + plane[b1];
    if (cw === 1) { out[0] = (thiscol * 4 + 8) >> 4; out[1] = (thiscol * 4 + 7) >> 4; return; }
    let nextcol = plane[b0 + 1] * 3 + plane[b1 + 1];
    out[0] = (thiscol * 4 + 8) >> 4;
    out[1] = (thiscol * 3 + nextcol + 7) >> 4;
    let lastcol = thiscol; thiscol = nextcol;
    for (let i = 2; i < cw; i++) {
      nextcol = plane[b0 + i] * 3 + plane[b1 + i];
      out[2 * i - 2] = (thiscol * 3 + lastcol + 8) >> 4;
      out[2 * i - 1] = (thiscol * 3 + nextcol + 7) >> 4;
      lastcol = thiscol; thiscol = nextcol;
    }
    out[2 * cw - 2] = (thiscol * 3 + lastcol + 8) >> 4;
    out[2 * cw - 1] = (thiscol * 4 + 7) >> 4;
  }

  function makeRowSource(comp, W, hmax, vmax) {
    const hr = hmax / comp.h, vr = vmax / comp.v;
    const plane = comp.plane, stride = comp.stride, cw = comp.compW, ch = comp.compH;
    if (hr === 1 && vr === 1) return (y) => plane.subarray(y * stride, y * stride + W);
    if (hr === 2 && vr === 1) {
      const tmp = new Uint8Array(cw * 2);
      return (y) => { h2v1(plane, y * stride, cw, tmp); return tmp; };
    }
    if (hr === 2 && vr === 2) {
      const tmp = new Uint8Array(cw * 2);
      return (y) => {
        const r = y >> 1;
        let o = (y & 1) ? r + 1 : r - 1;
        if (o < 0) o = 0; else if (o > ch - 1) o = ch - 1;
        h2v2(plane, r * stride, o * stride, cw, tmp);
        return tmp;
      };
    }
    if (hr === 1 && vr === 2) {
      const tmp = new Uint8Array(cw);
      return (y) => {
        const r = y >> 1;
        let o = (y & 1) ? r + 1 : r - 1;
        if (o < 0) o = 0; else if (o > ch - 1) o = ch - 1;
        const bias = (y & 1) ? 2 : 1, b0 = r * stride, b1 = o * stride;
        for (let i = 0; i < cw; i++) tmp[i] = (plane[b0 + i] * 3 + plane[b1 + i] + bias) >> 2;
        return tmp;
      };
    }
    const tmp = new Uint8Array(W);
    return (y) => {
      let r = (y / vr) | 0; if (r > ch - 1) r = ch - 1;
      const base = r * stride;
      for (let x = 0; x < W; x++) tmp[x] = plane[base + ((x / hr) | 0)];
      return tmp;
    };
  }

  // ------------------------------------------------------------------ the decoder
  function decode(bytes, opts) {
    opts = opts || {};
    const meta = probe(bytes);
    if (meta.arithmetic) throw new HBError('unsupported', 'Arithmetic-coded JPEG');
    if (meta.sofType > 2) throw new HBError('unsupported', 'Unsupported JPEG type (SOF' + meta.sofType + ')');
    if (meta.precision !== 8) throw new HBError('unsupported', meta.precision + '-bit JPEG');
    const nc = meta.comps.length;
    if (nc !== 1 && nc !== 3) throw new HBError('unsupported', nc + '-component (CMYK) JPEG');

    const W = meta.width, H = meta.height;
    if (W * H > 700e6) throw new HBError('unsupported', 'Image is larger than this tool can process');
    const comps = meta.comps.map((c) => Object.assign({}, c));
    let hmax = 1, vmax = 1;
    for (const c of comps) {
      if (c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4) throw new HBError('corrupt', 'Bad sampling factors');
      hmax = Math.max(hmax, c.h); vmax = Math.max(vmax, c.v);
    }
    for (const c of comps) {
      if (hmax % c.h || vmax % c.v) throw new HBError('unsupported', 'Non-integer chroma subsampling');
    }
    const mcusX = Math.ceil(W / (8 * hmax)), mcusY = Math.ceil(H / (8 * vmax));
    const progressive = meta.progressive;
    const byId = {};
    for (const c of comps) {
      c.blocksPerLine = mcusX * c.h;
      c.blocksPerCol = mcusY * c.v;
      c.compW = Math.ceil(W * c.h / hmax);
      c.compH = Math.ceil(H * c.v / vmax);
      c.blocksWide = Math.ceil(c.compW / 8);
      c.blocksHigh = Math.ceil(c.compH / 8);
      c.stride = c.blocksPerLine * 8;
      c.pred = 0;
      byId[c.id] = c;
    }

    const qts = [null, null, null, null];
    const dcTables = [null, null, null, null], acTables = [null, null, null, null];
    let restartInterval = 0;
    let streaming = false, scansDone = 0;
    const ws = new Int32Array(64);
    const warnings = [];

    try {
      for (const c of comps) c.plane = new Uint8Array(c.stride * c.blocksPerCol * 8);
    } catch (e) { throw new HBError('memory', 'Image is too large to process in this browser'); }

    const n = bytes.length;
    let p = 2;

    function allocCoefs(rowsPerComp) {
      for (const c of comps) {
        try { c.coefs = new Int16Array((rowsPerComp ? c.v : c.blocksPerCol) * c.blocksPerLine * 64); }
        catch (e) { throw new HBError('memory', 'Image is too large to process in this browser'); }
      }
    }

    function idctRows(c, blockRowFrom, blockRowTo, coefRowBase) {
      const q = qts[c.tq];
      if (!q) throw new HBError('corrupt', 'Missing quantization table');
      for (let by = blockRowFrom; by < blockRowTo; by++) {
        for (let bx = 0; bx < c.blocksPerLine; bx++) {
          const off = ((by - coefRowBase) * c.blocksPerLine + bx) * 64;
          idctBlock(c.coefs, off, q, c.plane, by * 8 * c.stride + bx * 8, c.stride, ws);
        }
      }
    }

    // ---- one entropy-coded scan
    function decodeScan(start, sc, ss, se, ah, al) {
      let pos = start, bitBuf = 0, bitCnt = 0, marker = 0, fake = 0, eobrun = 0;

      function fill() {
        while (bitCnt <= 24) {
          let b = 0;
          if (marker === 0 && pos < n) {
            b = bytes[pos++];
            if (b === 0xFF) {
              let b2 = bytes[pos];
              while (b2 === 0xFF) { pos++; b2 = bytes[pos]; }
              if (b2 === 0) pos++;
              else { marker = b2 === undefined ? 0xD9 : b2; pos--; b = 0; fake++; }
            }
          } else { fake++; }
          bitBuf = (bitBuf << 8) | b;
          bitCnt += 8;
        }
      }
      function receive(nb) {
        if (bitCnt < nb) fill();
        bitCnt -= nb;
        return (bitBuf >>> bitCnt) & ((1 << nb) - 1);
      }
      function decodeHuff(t) {
        if (bitCnt < 16) fill();
        const lk = t.look[(bitBuf >>> (bitCnt - 8)) & 0xFF];
        if (lk !== 0) { bitCnt -= lk >> 8; return lk & 0xFF; }
        let l = 9, code = (bitBuf >>> (bitCnt - 9)) & 0x1FF;
        const mc = t.maxcode;
        while (l <= 16 && code > mc[l]) { l++; code = (bitBuf >>> (bitCnt - l)) & ((1 << l) - 1); }
        if (l > 16) { bitCnt -= 16; warnings.push('bad huffman code'); return 0; }
        bitCnt -= l;
        return t.vals[t.valptr[l] + code - t.mincode[l]];
      }
      const extend = (v, t) => (v < (1 << (t - 1)) ? v - (1 << t) + 1 : v);

      const single = sc.length === 1;
      const total = single ? sc[0].comp.blocksWide * sc[0].comp.blocksHigh : mcusX * mcusY;
      const perRow = single ? sc[0].comp.blocksWide : mcusX;
      let mcuCount = 0;
      const mode = !progressive ? 0 : (ss === 0 ? (ah === 0 ? 1 : 2) : (ah === 0 ? 3 : 4));

      function decodeBlock(s, off) {
        const coefs = s.comp.coefs;
        switch (mode) {
          case 0: {
            const t = decodeHuff(s.dc);
            const c = s.comp;
            c.pred += t === 0 ? 0 : extend(receive(t), t);
            coefs[off] = c.pred;
            const ac = s.ac;
            let k = 1;
            while (k < 64) {
              const rs = decodeHuff(ac), sz = rs & 15, r = rs >> 4;
              if (sz === 0) { if (r < 15) break; k += 16; continue; }
              k += r;
              if (k > 63) break;
              coefs[off + ZZ[k]] = extend(receive(sz), sz);
              k++;
            }
            return;
          }
          case 1: {
            const t = decodeHuff(s.dc);
            const c = s.comp;
            c.pred += t === 0 ? 0 : extend(receive(t), t);
            coefs[off] = c.pred * (1 << al);
            return;
          }
          case 2:
            if (receive(1)) coefs[off] |= (1 << al);
            return;
          case 3: {
            if (eobrun > 0) { eobrun--; return; }
            const ac = s.ac;
            let k = ss;
            while (k <= se) {
              const rs = decodeHuff(ac), sz = rs & 15, r = rs >> 4;
              if (sz === 0) {
                if (r < 15) { eobrun = (1 << r) - 1; if (r) eobrun += receive(r); break; }
                k += 16; continue;
              }
              k += r;
              if (k > 63) break;
              coefs[off + ZZ[k]] = extend(receive(sz), sz) * (1 << al);
              k++;
            }
            return;
          }
          default: {
            const ac = s.ac;
            const p1 = 1 << al, m1 = -(1 << al);
            let k = ss;
            if (eobrun <= 0) {
              for (; k <= se; k++) {
                const rs = decodeHuff(ac);
                let sz = rs & 15, r = rs >> 4;
                if (sz !== 0) {
                  sz = receive(1) ? p1 : m1;
                } else if (r !== 15) {
                  eobrun = 1 << r;
                  if (r) eobrun += receive(r);
                  break;
                }
                do {
                  const idx = off + ZZ[k];
                  const cv = coefs[idx];
                  if (cv !== 0) {
                    if (receive(1) && (cv & p1) === 0) coefs[idx] = cv >= 0 ? cv + p1 : cv + m1;
                  } else if (--r < 0) break;
                  k++;
                } while (k <= se);
                if (sz !== 0 && k <= se) coefs[off + ZZ[k]] = sz;
              }
            }
            if (eobrun > 0) {
              for (; k <= se; k++) {
                const idx = off + ZZ[k];
                const cv = coefs[idx];
                if (cv !== 0 && receive(1) && (cv & p1) === 0) coefs[idx] = cv >= 0 ? cv + p1 : cv + m1;
              }
              eobrun--;
            }
          }
        }
      }

      function restart() {
        bitCnt = 0; bitBuf = 0; fake = 0;
        if (marker === 0) {
          while (pos < n - 1 && !(bytes[pos] === 0xFF && bytes[pos + 1] >= 0xD0 && bytes[pos + 1] <= 0xD7)) pos++;
          if (pos < n - 1) marker = bytes[pos + 1];
        }
        if (marker >= 0xD0 && marker <= 0xD7) { pos += 2; marker = 0; for (const s of sc) s.comp.pred = 0; eobrun = 0; return true; }
        return false;
      }

      for (const s of sc) s.comp.pred = 0;
      let aborted = false;
      for (let my = 0; my * perRow < total && !aborted; my++) {
        const rowEnd = Math.min(perRow, total - my * perRow);
        for (let mx = 0; mx < rowEnd; mx++) {
          if (restartInterval && mcuCount > 0 && mcuCount % restartInterval === 0) {
            if (!restart()) { aborted = true; break; }
          }
          // Out of real data? (A pending EOB run is legitimate: those blocks cost zero bits.)
          if (fake > 0 && bitCnt <= fake * 8 && eobrun <= 0) { aborted = true; warnings.push('truncated scan'); break; }
          if (single) {
            const s = sc[0], c = s.comp;
            decodeBlock(s, ((my) * c.blocksPerLine + mx) * 64);
          } else {
            for (let i = 0; i < sc.length; i++) {
              const s = sc[i], c = s.comp;
              for (let v = 0; v < c.v; v++) {
                for (let h = 0; h < c.h; h++) {
                  const bx = mx * c.h + h, by = (streaming ? 0 : my * c.v) + v;
                  decodeBlock(s, (by * c.blocksPerLine + bx) * 64);
                }
              }
            }
          }
          mcuCount++;
        }
        if (streaming && !single) {
          for (const c of comps) {
            idctRows(c, my * c.v, (my + 1) * c.v, my * c.v);
            c.coefs.fill(0);
          }
        }
      }
      // find the next marker
      if (marker !== 0) {
        // pos points at the FF of the marker
      } else {
        while (pos < n - 1 && !(bytes[pos] === 0xFF && bytes[pos + 1] !== 0 && bytes[pos + 1] !== 0xFF && !(bytes[pos + 1] >= 0xD0 && bytes[pos + 1] <= 0xD7))) pos++;
      }
      return pos;
    }

    // ---- marker loop
    while (p < n) {
      if (bytes[p] !== 0xFF) { p++; continue; }
      const m = bytes[p + 1];
      if (m === undefined) break;
      if (m === 0xFF) { p++; continue; }
      p += 2;
      if (m === 0x00 || m === 0x01 || (m >= 0xD0 && m <= 0xD8)) continue;
      if (m === 0xD9) break;
      if (p + 2 > n) break;
      const len = be16(bytes, p);
      const s = p + 2, e = Math.min(n, p + len);
      if (len < 2) break;

      if (m === 0xDB) {
        let o = s;
        while (o < e) {
          const pq = bytes[o] >> 4, tq = bytes[o] & 15; o++;
          const t = new Int32Array(64);
          for (let i = 0; i < 64; i++) {
            if (pq) { t[ZZ[i]] = be16(bytes, o); o += 2; } else { t[ZZ[i]] = bytes[o++]; }
          }
          if (tq < 4) qts[tq] = t;
        }
      } else if (m === 0xC4) {
        let o = s;
        while (o + 17 <= e) {
          const tc = bytes[o] >> 4, th = bytes[o] & 15; o++;
          const counts = bytes.subarray(o, o + 16); o += 16;
          let total = 0;
          for (let i = 0; i < 16; i++) total += counts[i];
          const syms = bytes.slice(o, o + total); o += total;
          if (th < 4) (tc === 0 ? dcTables : acTables)[th] = buildHuffman(counts, syms);
        }
      } else if (m === 0xDD) {
        restartInterval = be16(bytes, s);
      } else if (m === 0xDA) {
        const ns = bytes[s];
        const sc = [];
        for (let i = 0; i < ns; i++) {
          const c = byId[bytes[s + 1 + 2 * i]];
          if (!c) throw new HBError('corrupt', 'Scan references unknown component');
          const t = bytes[s + 2 + 2 * i];
          sc.push({ comp: c, dc: dcTables[t >> 4], ac: acTables[t & 15] });
        }
        const ss = bytes[s + 1 + 2 * ns], se = bytes[s + 2 + 2 * ns], ahal = bytes[s + 3 + 2 * ns];
        const ah = ahal >> 4, al = ahal & 15;
        if (scansDone === 0) {
          streaming = !progressive && ns === nc && nc > 1;
          allocCoefs(streaming);
        }
        if (!progressive) {
          for (const x of sc) if (!x.dc || !x.ac) throw new HBError('corrupt', 'Missing Huffman table');
        } else {
          for (const x of sc) if ((ss === 0 && ah === 0 && !x.dc) || (ss > 0 && !x.ac)) throw new HBError('corrupt', 'Missing Huffman table');
        }
        p = decodeScan(e, sc, progressive ? ss : 0, progressive ? se : 63, ah, al);
        scansDone++;
        if (streaming) break; // single-scan baseline: everything is decoded
        continue;
      }
      p = e;
    }
    if (scansDone === 0) throw new HBError('corrupt', 'JPEG contains no image data');

    if (!streaming) {
      for (const c of comps) {
        idctRows(c, 0, c.blocksPerCol, 0);
        c.coefs = null;
      }
    } else {
      for (const c of comps) c.coefs = null;
    }

    // ---- assemble RGB
    let rgb;
    try { rgb = new Uint8Array(W * H * 3); } catch (e) { throw new HBError('memory', 'Image is too large to process in this browser'); }
    let colorTransform = 'gray';
    if (nc === 1) {
      const pl = comps[0].plane, st = comps[0].stride;
      let o = 0;
      for (let y = 0; y < H; y++) {
        const b = y * st;
        for (let x = 0; x < W; x++) { const v = pl[b + x]; rgb[o++] = v; rgb[o++] = v; rgb[o++] = v; }
      }
    } else {
      let ycc = true;
      if (meta.adobe) ycc = meta.adobe.transform !== 0;
      else if (!meta.jfif && comps[0].id === 0x52 && comps[1].id === 0x47 && comps[2].id === 0x42) ycc = false;
      colorTransform = ycc ? 'ycc' : 'rgb';
      const s0 = makeRowSource(comps[0], W, hmax, vmax), s1 = makeRowSource(comps[1], W, hmax, vmax), s2 = makeRowSource(comps[2], W, hmax, vmax);
      let o = 0;
      for (let y = 0; y < H; y++) {
        const r0 = s0(y), r1 = s1(y), r2 = s2(y);
        if (ycc) {
          for (let x = 0; x < W; x++) {
            const Y = r0[x], cb = r1[x], cr = r2[x];
            let r = Y + CR_R[cr], g = Y + ((CB_G[cb] + CR_G[cr]) >> 16), b = Y + CB_B[cb];
            rgb[o++] = r < 0 ? 0 : r > 255 ? 255 : r;
            rgb[o++] = g < 0 ? 0 : g > 255 ? 255 : g;
            rgb[o++] = b < 0 ? 0 : b > 255 ? 255 : b;
          }
        } else {
          for (let x = 0; x < W; x++) { rgb[o++] = r0[x]; rgb[o++] = r1[x]; rgb[o++] = r2[x]; }
        }
      }
    }
    for (const c of comps) c.plane = null;
    return { width: W, height: H, rgb, ncomp: nc, colorTransform, progressive, warnings, meta };
  }

  return { probe, decode, ZZ, _internal: { idctBlock, buildHuffman } };
})();
