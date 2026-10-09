'use strict';
/* PNG decode (all colour types / bit depths / Adam7) and encode (8-bit RGB, adaptive filters, ICC + DPI).
 * zlib is provided by the platform's CompressionStream / DecompressionStream. */
HB.png = (function () {
  const { ascii, be32, crc32, concat, HBError } = HB.util;

  async function inflate(parts) {
    if (typeof DecompressionStream === 'undefined') throw new HBError('unsupported', 'DecompressionStream is not available');
    const ds = new DecompressionStream('deflate');
    const result = new Response(ds.readable).arrayBuffer();
    const w = ds.writable.getWriter();
    const pending = (async () => { for (const p of parts) await w.write(p); await w.close(); })();
    const [buf] = await Promise.all([result, pending]);
    return new Uint8Array(buf);
  }

  function readChunks(bytes) {
    if (!(bytes.length > 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG')) throw new HBError('corrupt', 'Not a PNG file');
    const chunks = [];
    let p = 8;
    while (p + 8 <= bytes.length) {
      const len = be32(bytes, p), type = ascii(bytes, p + 4, 4);
      if (p + 12 + len > bytes.length) break;
      chunks.push({ type, data: bytes.subarray(p + 8, p + 8 + len) });
      p += 12 + len;
      if (type === 'IEND') break;
    }
    return chunks;
  }

  async function iccFrom(chunks) {
    const c = chunks.find((x) => x.type === 'iCCP');
    if (!c) return null;
    let z = 0;
    while (z < c.data.length && c.data[z] !== 0) z++;
    try { return await inflate([c.data.subarray(z + 2)]); } catch (e) { return null; }
  }

  /** Dimensions + colour info without decoding pixels. */
  async function probe(bytes) {
    const chunks = readChunks(bytes);
    const h = chunks.find((x) => x.type === 'IHDR');
    if (!h) throw new HBError('corrupt', 'PNG has no header');
    return {
      width: be32(h.data, 0), height: be32(h.data, 4), depth: h.data[8], colorType: h.data[9], interlace: h.data[12],
      icc: await iccFrom(chunks), srgb: chunks.some((x) => x.type === 'sRGB'),
      hasAlpha: h.data[9] === 4 || h.data[9] === 6 || chunks.some((x) => x.type === 'tRNS'),
    };
  }

  const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

  function unfilter(ft, cur, prev, n, bpp) {
    switch (ft) {
      case 0: return;
      case 1: for (let i = bpp; i < n; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255; return;
      case 2: for (let i = 0; i < n; i++) cur[i] = (cur[i] + prev[i]) & 255; return;
      case 3:
        for (let i = 0; i < n; i++) cur[i] = (cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255;
        return;
      case 4:
        for (let i = 0; i < n; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
        }
        return;
      default: throw new HBError('corrupt', 'Bad PNG filter type');
    }
  }

  async function decode(bytes) {
    const chunks = readChunks(bytes);
    const h = chunks.find((x) => x.type === 'IHDR');
    if (!h) throw new HBError('corrupt', 'PNG has no header');
    const W = be32(h.data, 0), H = be32(h.data, 4), depth = h.data[8], ct = h.data[9], interlace = h.data[12];
    if (h.data[10] !== 0 || h.data[11] !== 0) throw new HBError('corrupt', 'Unknown PNG compression/filter method');
    const chan = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    if (!chan || ![1, 2, 4, 8, 16].includes(depth)) throw new HBError('corrupt', 'Bad PNG header');
    const bpp = Math.max(1, (chan * depth) >> 3);
    const palette = chunks.find((x) => x.type === 'PLTE');
    const trns = chunks.find((x) => x.type === 'tRNS');
    if (ct === 3 && !palette) throw new HBError('corrupt', 'PNG palette missing');

    const raw = await inflate(chunks.filter((x) => x.type === 'IDAT').map((x) => x.data));
    let rgb;
    try { rgb = new Uint8Array(W * H * 3); } catch (e) { throw new HBError('memory', 'Image is too large to process in this browser'); }
    const maxv = (1 << depth) - 1;
    const sample = depth === 8 ? (r, i) => r[i] : depth === 16 ? (r, i) => (r[2 * i] << 8) | r[2 * i + 1]
      : (r, i) => { const bp = i * depth; return (r[bp >> 3] >> (8 - depth - (bp & 7))) & maxv; };
    const to8 = depth === 16 ? (v) => Math.min(255, (v + 128) >> 8) : depth === 8 ? (v) => v : (v) => Math.round(v * 255 / maxv);

    function passes() {
      return interlace ? ADAM7.map((a) => ({ xs: a[0], ys: a[1], dx: a[2], dy: a[3] })) : [{ xs: 0, ys: 0, dx: 1, dy: 1 }];
    }
    let pos = 0;
    for (const ps of passes()) {
      const pw = Math.ceil((W - ps.xs) / ps.dx), ph = Math.ceil((H - ps.ys) / ps.dy);
      if (pw <= 0 || ph <= 0) continue;
      const rowBytes = (pw * chan * depth + 7) >> 3;
      let prev = new Uint8Array(rowBytes);
      for (let y = 0; y < ph; y++) {
        if (pos + 1 + rowBytes > raw.length) throw new HBError('corrupt', 'PNG data is truncated');
        const ft = raw[pos];
        const cur = raw.subarray(pos + 1, pos + 1 + rowBytes);
        pos += 1 + rowBytes;
        unfilter(ft, cur, prev, rowBytes, bpp);
        const oy = ps.ys + y * ps.dy;
        let o = (oy * W + ps.xs) * 3;
        const ostep = ps.dx * 3;
        if (depth === 8 && ct === 2) {
          if (ps.dx === 1) rgb.set(cur.subarray(0, pw * 3), o);
          else for (let x = 0; x < pw; x++, o += ostep) { rgb[o] = cur[3 * x]; rgb[o + 1] = cur[3 * x + 1]; rgb[o + 2] = cur[3 * x + 2]; }
        } else if (depth === 8 && ct === 6) {
          for (let x = 0; x < pw; x++, o += ostep) {
            const a = cur[4 * x + 3];
            if (a === 255) { rgb[o] = cur[4 * x]; rgb[o + 1] = cur[4 * x + 1]; rgb[o + 2] = cur[4 * x + 2]; }
            else { const k = 255 - a; for (let c = 0; c < 3; c++) rgb[o + c] = Math.round(cur[4 * x + c] * a / 255 + k); }
          }
        } else {
          for (let x = 0; x < pw; x++, o += ostep) {
            let r, g, b, a = 255;
            if (ct === 0) { r = g = b = to8(sample(cur, x)); }
            else if (ct === 2) { r = to8(sample(cur, 3 * x)); g = to8(sample(cur, 3 * x + 1)); b = to8(sample(cur, 3 * x + 2)); }
            else if (ct === 3) {
              const idx = sample(cur, x);
              r = palette.data[3 * idx]; g = palette.data[3 * idx + 1]; b = palette.data[3 * idx + 2];
              if (trns && idx < trns.data.length) a = trns.data[idx];
            } else if (ct === 4) { r = g = b = to8(sample(cur, 2 * x)); a = to8(sample(cur, 2 * x + 1)); }
            else { r = to8(sample(cur, 4 * x)); g = to8(sample(cur, 4 * x + 1)); b = to8(sample(cur, 4 * x + 2)); a = to8(sample(cur, 4 * x + 3)); }
            if (a !== 255) { const k = 255 - a; r = Math.round(r * a / 255 + k); g = Math.round(g * a / 255 + k); b = Math.round(b * a / 255 + k); }
            rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
          }
        }
        prev = cur;
      }
    }
    return {
      width: W, height: H, rgb, icc: await iccFrom(chunks), srgb: chunks.some((x) => x.type === 'sRGB'),
      depth, hasAlpha: ct === 4 || ct === 6 || !!trns,
    };
  }

  // ------------------------------------------------------------------ encoder
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  async function deflateAll(parts) {
    const cs = new CompressionStream('deflate');
    const result = new Response(cs.readable).arrayBuffer();
    const w = cs.writable.getWriter();
    const pending = (async () => { for (const p of parts) await w.write(p); await w.close(); })();
    const [buf] = await Promise.all([result, pending]);
    return new Uint8Array(buf);
  }

  /** opts: { width, height, getRows(y0, n, out), icc: Uint8Array|null, dpi, onProgress(f) } -> Uint8Array */
  async function encode(opts) {
    if (typeof CompressionStream === 'undefined') throw new HBError('unsupported', 'CompressionStream is not available');
    const W = opts.width, H = opts.height, rowBytes = W * 3;
    const onProgress = opts.onProgress || function () {};
    const cs = new CompressionStream('deflate');
    const outParts = [];
    const reader = cs.readable.getReader();
    const reading = (async () => { for (;;) { const r = await reader.read(); if (r.done) break; outParts.push(r.value); } })();
    const writer = cs.writable.getWriter();

    const STRIP = 32;
    const strip = new Uint8Array(rowBytes * STRIP);
    let prev = new Uint8Array(rowBytes);
    let best = new Uint8Array(rowBytes + 1), tmp = new Uint8Array(rowBytes + 1);
    const abs8 = new Uint8Array(256);
    for (let i = 0; i < 256; i++) abs8[i] = i < 128 ? i : 256 - i;

    for (let y0 = 0; y0 < H; y0 += STRIP) {
      const n = Math.min(STRIP, H - y0);
      opts.getRows(y0, n, strip);
      const out = new Uint8Array((rowBytes + 1) * n);
      for (let r = 0; r < n; r++) {
        const cur = strip.subarray(r * rowBytes, (r + 1) * rowBytes);
        let bestScore = Infinity, bestType = 0;
        for (let ft = 0; ft < 5; ft++) {
          let score = 0;
          switch (ft) {
            case 0: for (let i = 0; i < rowBytes; i++) { const v = cur[i]; tmp[i + 1] = v; score += abs8[v]; } break;
            case 1:
              for (let i = 0; i < rowBytes; i++) { const v = (cur[i] - (i >= 3 ? cur[i - 3] : 0)) & 255; tmp[i + 1] = v; score += abs8[v]; }
              break;
            case 2: for (let i = 0; i < rowBytes; i++) { const v = (cur[i] - prev[i]) & 255; tmp[i + 1] = v; score += abs8[v]; } break;
            case 3:
              for (let i = 0; i < rowBytes; i++) { const v = (cur[i] - (((i >= 3 ? cur[i - 3] : 0) + prev[i]) >> 1)) & 255; tmp[i + 1] = v; score += abs8[v]; }
              break;
            default:
              for (let i = 0; i < rowBytes; i++) {
                const a = i >= 3 ? cur[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0;
                const p = a + b - c, pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
                const v = (cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
                tmp[i + 1] = v; score += abs8[v];
              }
          }
          if (score < bestScore) { bestScore = score; bestType = ft; const t = best; best = tmp; tmp = t; }
        }
        best[0] = bestType;
        out.set(best, r * (rowBytes + 1));
        prev.set(cur); // copy: the strip buffer is reused
      }
      await writer.write(out);
      onProgress(Math.min(1, (y0 + n) / H));
    }
    await writer.close();
    await reading;

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, W); dv.setUint32(4, H); ihdr[8] = 8; ihdr[9] = 2;
    const pieces = [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr)];
    if (opts.icc) {
      const z = await deflateAll([opts.icc]);
      const name = 'ICC';
      const body = new Uint8Array(name.length + 2 + z.length);
      for (let i = 0; i < name.length; i++) body[i] = name.charCodeAt(i);
      body[name.length] = 0; body[name.length + 1] = 0; body.set(z, name.length + 2);
      pieces.push(chunk('iCCP', body));
    }
    if (opts.dpi) {
      const ppm = Math.round(opts.dpi / 0.0254);
      const p = new Uint8Array(9);
      const d = new DataView(p.buffer);
      d.setUint32(0, ppm); d.setUint32(4, ppm); p[8] = 1;
      pieces.push(chunk('pHYs', p));
    }
    const all = concat(outParts);
    const IDAT = 1 << 20;
    for (let o = 0; o < all.length; o += IDAT) pieces.push(chunk('IDAT', all.subarray(o, Math.min(all.length, o + IDAT))));
    pieces.push(chunk('IEND', new Uint8Array(0)));
    return concat(pieces);
  }

  return { probe, decode, encode };
})();
