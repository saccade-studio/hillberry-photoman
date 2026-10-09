'use strict';
/* Baseline JPEG encoder built for maximum fidelity.
 *
 *  - RGB -> YCbCr stays in floating point right up to the DCT (no intermediate 8-bit rounding), which matters at q=100.
 *  - Default is 4:4:4 (no chroma subsampling); 4:2:0 is available for smaller files.
 *  - Optional two-pass optimised Huffman tables (smaller file, identical pixels).
 *  - Streams MCU rows through a callback, so the full-size image never needs a second copy.
 *  - Writes caller-supplied APPn segments (ICC profile, EXIF, ...). */
HB.jpegEnc = (function () {
  const { HBError } = HB.util;
  const ZZ = HB.jpeg.ZZ;

  const STD_LUM_Q = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
  const STD_CHR_Q = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];

  const STD_DC_LUM = { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
  const STD_DC_CHR = { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
  const STD_AC_LUM = {
    counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
    vals: [
      0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
      0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
      0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
      0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
      0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
      0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
      0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
  };
  const STD_AC_CHR = {
    counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
    vals: [
      0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
      0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
      0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
      0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
      0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
      0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
      0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
  };

  /** libjpeg's quality -> quantization table scaling. Returns natural-order table. */
  function scaledQuant(base, quality) {
    quality = Math.max(1, Math.min(100, Math.round(quality)));
    const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
    const t = new Int32Array(64);
    for (let i = 0; i < 64; i++) {
      let v = Math.floor((base[i] * scale + 50) / 100);
      t[i] = v < 1 ? 1 : v > 255 ? 255 : v;
    }
    return t;
  }

  const AAN = [1.0, 1, 2, 3, 4, 5, 6, 7].map((k, i) => (i === 0 ? 1 : Math.cos(i * Math.PI / 16) * Math.SQRT2)); // exact AAN scale factors
  function reciprocals(q) {
    const r = new Float64Array(64);
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const i = row * 8 + col;
      r[i] = 1 / (q[i] * AAN[row] * AAN[col] * 8);
    }
    return r;
  }

  /** In-place AAN forward DCT on 64 doubles (jfdctflt). Output is AAN-scaled; `reciprocals` undoes that. */
  function fdct(d) {
    let t0, t1, t2, t3, t4, t5, t6, t7, t10, t11, t12, t13, z1, z2, z3, z4, z5, z11, z13;
    for (let i = 0; i < 64; i += 8) {
      t0 = d[i] + d[i + 7]; t7 = d[i] - d[i + 7];
      t1 = d[i + 1] + d[i + 6]; t6 = d[i + 1] - d[i + 6];
      t2 = d[i + 2] + d[i + 5]; t5 = d[i + 2] - d[i + 5];
      t3 = d[i + 3] + d[i + 4]; t4 = d[i + 3] - d[i + 4];
      t10 = t0 + t3; t13 = t0 - t3; t11 = t1 + t2; t12 = t1 - t2;
      d[i] = t10 + t11; d[i + 4] = t10 - t11;
      z1 = (t12 + t13) * 0.7071067811865476;
      d[i + 2] = t13 + z1; d[i + 6] = t13 - z1;
      t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
      z5 = (t10 - t12) * 0.3826834323650898;
      z2 = 0.5411961001461970 * t10 + z5;
      z4 = 1.3065629648763766 * t12 + z5;
      z3 = t11 * 0.7071067811865476;
      z11 = t7 + z3; z13 = t7 - z3;
      d[i + 5] = z13 + z2; d[i + 3] = z13 - z2; d[i + 1] = z11 + z4; d[i + 7] = z11 - z4;
    }
    for (let i = 0; i < 8; i++) {
      t0 = d[i] + d[i + 56]; t7 = d[i] - d[i + 56];
      t1 = d[i + 8] + d[i + 48]; t6 = d[i + 8] - d[i + 48];
      t2 = d[i + 16] + d[i + 40]; t5 = d[i + 16] - d[i + 40];
      t3 = d[i + 24] + d[i + 32]; t4 = d[i + 24] - d[i + 32];
      t10 = t0 + t3; t13 = t0 - t3; t11 = t1 + t2; t12 = t1 - t2;
      d[i] = t10 + t11; d[i + 32] = t10 - t11;
      z1 = (t12 + t13) * 0.7071067811865476;
      d[i + 16] = t13 + z1; d[i + 48] = t13 - z1;
      t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
      z5 = (t10 - t12) * 0.3826834323650898;
      z2 = 0.5411961001461970 * t10 + z5;
      z4 = 1.3065629648763766 * t12 + z5;
      z3 = t11 * 0.7071067811865476;
      z11 = t7 + z3; z13 = t7 - z3;
      d[i + 40] = z13 + z2; d[i + 24] = z13 - z2; d[i + 8] = z11 + z4; d[i + 56] = z11 - z4;
    }
  }

  // ---------------------------------------------------------------- Huffman helpers
  function makeEncTable(counts, vals) {
    const code = new Uint16Array(256), size = new Uint8Array(256);
    let c = 0, k = 0;
    for (let l = 1; l <= 16; l++) {
      for (let i = 0; i < counts[l - 1]; i++) { code[vals[k]] = c; size[vals[k]] = l; c++; k++; }
      c <<= 1;
    }
    return { code, size, counts: Uint8Array.from(counts), vals: Uint8Array.from(vals) };
  }

  /** JPEG Annex K.2 optimal table from symbol frequencies (freq has 257 entries; [256] is the reserved pseudo-symbol). */
  function optimalTable(freqIn) {
    const freq = new Float64Array(257);
    for (let i = 0; i < 256; i++) freq[i] = freqIn[i];
    freq[256] = 1;
    const codesize = new Int32Array(257), others = new Int32Array(257).fill(-1);
    for (;;) {
      let c1 = -1, v = 1e18;
      for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
      let c2 = -1; v = 1e18;
      for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
      if (c2 < 0) break;
      freq[c1] += freq[c2]; freq[c2] = 0;
      codesize[c1]++;
      while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
      others[c1] = c2;
      codesize[c2]++;
      while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
    }
    const bits = new Int32Array(33);
    for (let i = 0; i <= 256; i++) if (codesize[i]) { if (codesize[i] > 32) throw new HBError('internal', 'Huffman code too long'); bits[codesize[i]]++; }
    for (let i = 32; i > 16; i--) {
      while (bits[i] > 0) {
        let j = i - 2;
        while (bits[j] === 0) j--;
        bits[i] -= 2; bits[i - 1]++; bits[j + 1] += 2; bits[j]--;
      }
    }
    let i = 16;
    while (bits[i] === 0) i--;
    bits[i]--; // drop the reserved pseudo-symbol's code
    const vals = [];
    for (let len = 1; len <= 32; len++) for (let j = 0; j < 256; j++) if (codesize[j] === len) vals.push(j);
    return { counts: Array.from(bits.subarray(1, 17)), vals };
  }

  // ---------------------------------------------------------------- the encoder
  function seg(marker, payload) {
    const out = new Uint8Array(4 + payload.length);
    out[0] = 0xFF; out[1] = marker;
    out[2] = (payload.length + 2) >> 8; out[3] = (payload.length + 2) & 255;
    out.set(payload, 4);
    return out;
  }

  /**
   * opts: { width, height, getRows(y0, n, out), quality=100, subsampling='444'|'420', optimize=true,
   *         segments=[Uint8Array (complete marker segments incl. FF xx len)], jfif={units,xd,yd}|null, onProgress(f) }
   */
  function encode(opts) {
    const W = opts.width | 0, H = opts.height | 0;
    if (W < 1 || H < 1 || W > 65535 || H > 65535) throw new HBError('unsupported', 'JPEG dimensions must be 1..65535 pixels');
    const quality = opts.quality == null ? 100 : opts.quality;
    const s420 = opts.subsampling === '420';
    const optimize = opts.optimize !== false;
    const getRows = opts.getRows;
    const onProgress = opts.onProgress || function () {};

    const qL = scaledQuant(STD_LUM_Q, quality), qC = scaledQuant(STD_CHR_Q, quality);
    const rL = reciprocals(qL), rC = reciprocals(qC);
    const recips = [rL, rC, rC];

    const mcuW = s420 ? 16 : 8, mcuH = s420 ? 16 : 8;
    const mcusX = Math.ceil(W / mcuW), mcusY = Math.ceil(H / mcuH);
    const pw = mcusX * mcuW;
    const cw = s420 ? pw >> 1 : pw;

    const rgb = new Uint8Array(W * mcuH * 3);
    const Yp = new Float64Array(pw * mcuH), Cbp = new Float64Array(pw * mcuH), Crp = new Float64Array(pw * mcuH);
    const Cb2 = s420 ? new Float64Array(cw * 8) : null, Cr2 = s420 ? new Float64Array(cw * 8) : null;
    const ws = new Float64Array(64);
    const blk = new Int32Array(64);
    const pred = new Int32Array(3);

    // ---- entropy coder state (emit pass)
    let tables = null;
    let outBuf = new Uint8Array(1 << 20), outPos = 0;
    const chunks = [];
    let acc = 0, accBits = 0;

    function flushOut() { chunks.push(outBuf.subarray(0, outPos)); outBuf = new Uint8Array(1 << 20); outPos = 0; }
    function putBits(code, size) {
      acc = (acc << size) | code;
      accBits += size;
      while (accBits >= 8) {
        accBits -= 8;
        const b = (acc >>> accBits) & 0xFF;
        if (outPos > outBuf.length - 2) flushOut();
        outBuf[outPos++] = b;
        if (b === 0xFF) outBuf[outPos++] = 0;
      }
      acc &= (1 << accBits) - 1;
    }

    // ---- statistics (optimise pass)
    const dcFreq = [new Int32Array(257), new Int32Array(257)], acFreq = [new Int32Array(257), new Int32Array(257)];

    function statsBlock(ci) {
      const t = ci === 0 ? 0 : 1;
      let diff = blk[0] - pred[ci]; pred[ci] = blk[0];
      if (diff < 0) diff = -diff;
      dcFreq[t][32 - Math.clz32(diff)]++;
      const f = acFreq[t];
      let r = 0;
      for (let k = 1; k < 64; k++) {
        const v = blk[k];
        if (v === 0) { r++; continue; }
        while (r > 15) { f[0xF0]++; r -= 16; }
        const a = v < 0 ? -v : v;
        f[(r << 4) | (32 - Math.clz32(a))]++;
        r = 0;
      }
      if (r > 0) f[0]++;
    }

    function emitBlock(ci) {
      const t = ci === 0 ? 0 : 1;
      const dcT = tables.dc[t], acT = tables.ac[t];
      let diff = blk[0] - pred[ci]; pred[ci] = blk[0];
      let a = diff < 0 ? -diff : diff;
      let nb = 32 - Math.clz32(a);
      putBits(dcT.code[nb], dcT.size[nb]);
      if (nb) putBits((diff < 0 ? diff - 1 : diff) & ((1 << nb) - 1), nb);
      const acCode = acT.code, acSize = acT.size;
      let r = 0;
      for (let k = 1; k < 64; k++) {
        const v = blk[k];
        if (v === 0) { r++; continue; }
        while (r > 15) { putBits(acCode[0xF0], acSize[0xF0]); r -= 16; }
        a = v < 0 ? -v : v;
        nb = 32 - Math.clz32(a);
        const sym = (r << 4) | nb;
        putBits(acCode[sym], acSize[sym]);
        putBits((v < 0 ? v - 1 : v) & ((1 << nb) - 1), nb);
        r = 0;
      }
      if (r > 0) putBits(acCode[0], acSize[0]);
    }

    /** Loads an 8x8 block from a plane, runs DCT + quantisation into `blk` (zig-zag order). */
    function transform(plane, stride, x0, y0, recip) {
      let i = 0;
      for (let y = 0; y < 8; y++) {
        const base = (y0 + y) * stride + x0;
        for (let x = 0; x < 8; x++) ws[i++] = plane[base + x];
      }
      fdct(ws);
      for (let k = 0; k < 64; k++) {
        const n = ZZ[k];
        let v = ((ws[n] * recip[n] + 16384.5) | 0) - 16384;
        if (k > 0) { if (v > 1023) v = 1023; else if (v < -1023) v = -1023; }
        blk[k] = v;
      }
    }

    function runPass(blockFn, label, passIndex, passCount) {
      pred[0] = pred[1] = pred[2] = 0;
      const rowBytes = W * 3;
      for (let my = 0; my < mcusY; my++) {
        const y0 = my * mcuH, rows = Math.min(mcuH, H - y0);
        getRows(y0, rows, rgb);
        for (let r = rows; r < mcuH; r++) rgb.copyWithin(r * rowBytes, (rows - 1) * rowBytes, rows * rowBytes);
        // RGB -> centred YCbCr (floating point), edge-replicated out to the MCU grid
        for (let r = 0; r < mcuH; r++) {
          let si = r * rowBytes, di = r * pw;
          for (let x = 0; x < W; x++, si += 3, di++) {
            const R = rgb[si], G = rgb[si + 1], B = rgb[si + 2];
            Yp[di] = 0.299 * R + 0.587 * G + 0.114 * B - 128;
            Cbp[di] = -0.168736 * R - 0.331264 * G + 0.5 * B;
            Crp[di] = 0.5 * R - 0.418688 * G - 0.081312 * B;
          }
          for (let x = W; x < pw; x++, di++) { Yp[di] = Yp[di - 1]; Cbp[di] = Cbp[di - 1]; Crp[di] = Crp[di - 1]; }
        }
        if (s420) {
          for (let r = 0; r < 8; r++) {
            const a = 2 * r * pw, b = a + pw;
            for (let c = 0; c < cw; c++) {
              const i0 = a + 2 * c, i1 = b + 2 * c;
              Cb2[r * cw + c] = (Cbp[i0] + Cbp[i0 + 1] + Cbp[i1] + Cbp[i1 + 1]) * 0.25;
              Cr2[r * cw + c] = (Crp[i0] + Crp[i0 + 1] + Crp[i1] + Crp[i1 + 1]) * 0.25;
            }
          }
        }
        for (let mx = 0; mx < mcusX; mx++) {
          if (s420) {
            for (let by = 0; by < 2; by++) for (let bx = 0; bx < 2; bx++) {
              transform(Yp, pw, mx * 16 + bx * 8, by * 8, recips[0]); blockFn(0);
            }
            transform(Cb2, cw, mx * 8, 0, recips[1]); blockFn(1);
            transform(Cr2, cw, mx * 8, 0, recips[2]); blockFn(2);
          } else {
            transform(Yp, pw, mx * 8, 0, recips[0]); blockFn(0);
            transform(Cbp, pw, mx * 8, 0, recips[1]); blockFn(1);
            transform(Crp, pw, mx * 8, 0, recips[2]); blockFn(2);
          }
        }
        if ((my & 7) === 7 || my === mcusY - 1) onProgress((passIndex + (my + 1) / mcusY) / passCount);
      }
    }

    // ---- choose tables
    const passCount = optimize ? 2 : 1;
    let dcTabs, acTabs;
    if (optimize) {
      runPass(statsBlock, 'stats', 0, passCount);
      dcTabs = dcFreq.map(optimalTable);
      acTabs = acFreq.map(optimalTable);
    } else {
      dcTabs = [STD_DC_LUM, STD_DC_CHR];
      acTabs = [STD_AC_LUM, STD_AC_CHR];
    }
    tables = { dc: dcTabs.map((t) => makeEncTable(t.counts, t.vals)), ac: acTabs.map((t) => makeEncTable(t.counts, t.vals)) };

    // ---- header
    const head = [];
    head.push(new Uint8Array([0xFF, 0xD8]));
    if (opts.jfif !== null) {
      const j = opts.jfif || { units: 0, xd: 1, yd: 1 };
      head.push(seg(0xE0, new Uint8Array([0x4A, 0x46, 0x49, 0x46, 0, 1, 1, j.units, j.xd >> 8, j.xd & 255, j.yd >> 8, j.yd & 255, 0, 0])));
    }
    for (const s of (opts.segments || [])) head.push(s);
    const dqt = (id, q) => {
      const p = new Uint8Array(65);
      p[0] = id;
      for (let i = 0; i < 64; i++) p[1 + i] = q[ZZ[i]];
      return seg(0xDB, p);
    };
    head.push(dqt(0, qL), dqt(1, qC));
    head.push(seg(0xC0, new Uint8Array([8, H >> 8, H & 255, W >> 8, W & 255, 3, 1, s420 ? 0x22 : 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])));
    const dht = (tc, th, t) => {
      const p = new Uint8Array(17 + t.vals.length);
      p[0] = (tc << 4) | th;
      for (let i = 0; i < 16; i++) p[1 + i] = t.counts[i];
      p.set(t.vals, 17);
      return seg(0xC4, p);
    };
    head.push(dht(0, 0, tables.dc[0]), dht(1, 0, tables.ac[0]), dht(0, 1, tables.dc[1]), dht(1, 1, tables.ac[1]));
    head.push(seg(0xDA, new Uint8Array([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0])));

    // ---- scan
    runPass(emitBlock, 'emit', passCount - 1, passCount);
    if (accBits > 0) putBits((1 << (8 - accBits)) - 1, 8 - accBits); // pad with 1-bits
    if (outPos > outBuf.length - 2) flushOut();
    outBuf[outPos++] = 0xFF; outBuf[outPos++] = 0xD9;
    chunks.push(outBuf.subarray(0, outPos));
    return HB.util.concat(head.concat(chunks));
  }

  return {
    encode, scaledQuant, optimalTable, fdct, reciprocals, makeEncTable,
    STD: { STD_LUM_Q, STD_CHR_Q, STD_DC_LUM, STD_DC_CHR, STD_AC_LUM, STD_AC_CHR },
  };
})();
