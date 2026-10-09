'use strict';
/* Watermark engine: trimming, high-quality resampling, drop shadow, layout and compositing.
 *
 * Conventions
 *  - A "prepared logo" is premultiplied RGBA in Float32: colour channels 0..255 (already multiplied by alpha),
 *    alpha 0..1. Colours are in the *destination* colour space (converted from sRGB by HB.icc when needed).
 *  - A "layer" is a prepared logo plus its drop shadow and group opacity, ready to be blended onto RGB rows.
 *  - Sizes and margins are fractions of the SHORT side of the final (cropped) image, so a watermark has the same
 *    physical size on a landscape and a portrait print of the same paper. */
HB.marks = (function () {
  /** Crops transparent borders; returns { w, h, rgba } or null when nothing is visible. */
  function trim(rgba, w, h, threshold) {
    const thr = threshold == null ? 4 : threshold;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (rgba[row + x * 4 + 3] > thr) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
    const out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) out.set(rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + nw) * 4), y * nw * 4);
    return { w: nw, h: nh, rgba: out };
  }

  // ---------------------------------------------------------------- Lanczos-3 resampling (premultiplied floats)
  function lanczos3(x) {
    if (x === 0) return 1;
    x = Math.abs(x);
    if (x >= 3) return 0;
    const px = Math.PI * x;
    return 3 * Math.sin(px) * Math.sin(px / 3) / (px * px);
  }
  function makeWeights(srcLen, dstLen) {
    const scale = srcLen / dstLen;
    const fscale = Math.max(scale, 1);
    const support = 3 * fscale;
    const taps = Math.ceil(2 * support) + 2;
    const starts = new Int32Array(dstLen), counts = new Int32Array(dstLen);
    const weights = new Float32Array(dstLen * taps);
    for (let i = 0; i < dstLen; i++) {
      const center = (i + 0.5) * scale;
      const lo = Math.max(0, Math.floor(center - support + 0.5)), hi = Math.min(srcLen, Math.floor(center + support + 0.5));
      let sum = 0;
      for (let j = lo; j < hi; j++) { const w = lanczos3((j + 0.5 - center) / fscale); weights[i * taps + (j - lo)] = w; sum += w; }
      if (sum !== 0) for (let j = lo; j < hi; j++) weights[i * taps + (j - lo)] /= sum;
      starts[i] = lo; counts[i] = hi - lo;
    }
    return { starts, counts, weights, taps };
  }
  function resize(src, sw, sh, dw, dh) {
    if (sw === dw && sh === dh) return src;
    const wx = makeWeights(sw, dw), wy = makeWeights(sh, dh);
    const tmp = new Float32Array(dw * sh * 4);
    for (let y = 0; y < sh; y++) {
      const ro = y * sw * 4, oo = y * dw * 4;
      for (let x = 0; x < dw; x++) {
        const st = wx.starts[x], cnt = wx.counts[x], wo = x * wx.taps;
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < cnt; k++) {
          const w = wx.weights[wo + k], si = ro + (st + k) * 4;
          r += src[si] * w; g += src[si + 1] * w; b += src[si + 2] * w; a += src[si + 3] * w;
        }
        const oi = oo + x * 4;
        tmp[oi] = r; tmp[oi + 1] = g; tmp[oi + 2] = b; tmp[oi + 3] = a;
      }
    }
    const out = new Float32Array(dw * dh * 4);
    const rowLen = dw * 4;
    for (let y = 0; y < dh; y++) {
      const st = wy.starts[y], cnt = wy.counts[y], wo = y * wy.taps, oo = y * rowLen;
      for (let k = 0; k < cnt; k++) {
        const w = wy.weights[wo + k], so = (st + k) * rowLen;
        for (let x = 0; x < rowLen; x++) out[oo + x] += tmp[so + x] * w;
      }
    }
    for (let i = 0; i < out.length; i += 4) { // Lanczos overshoots: keep premultiplied values physically valid
      let a = out[i + 3];
      a = a < 0 ? 0 : a > 1 ? 1 : a; out[i + 3] = a;
      const m = 255 * a;
      for (let c = 0; c < 3; c++) { const v = out[i + c]; out[i + c] = v < 0 ? 0 : v > m ? m : v; }
    }
    return out;
  }

  // ---------------------------------------------------------------- Gaussian-like blur (3 box passes)
  function boxSizes(sigma, n) {
    const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    const sizes = [];
    for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
    return sizes;
  }
  function boxH(src, dst, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = 0; x < r && x < w; x++) sum += src[row + x];
      for (let x = 0; x < w; x++) {
        sum += (x + r < w ? src[row + x + r] : 0) - (x - r - 1 >= 0 ? src[row + x - r - 1] : 0);
        dst[row + x] = sum * inv;
      }
    }
  }
  function boxV(src, dst, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = 0; y < r && y < h; y++) sum += src[y * w + x];
      for (let y = 0; y < h; y++) {
        sum += (y + r < h ? src[(y + r) * w + x] : 0) - (y - r - 1 >= 0 ? src[(y - r - 1) * w + x] : 0);
        dst[y * w + x] = sum * inv;
      }
    }
  }
  function blurPlane(a, w, h, sigma) {
    if (sigma < 0.45) return a;
    const tmp = new Float32Array(w * h);
    for (const size of boxSizes(sigma, 3)) {
      const r = (size - 1) >> 1;
      if (r < 1) continue;
      boxH(a, tmp, w, h, r);
      boxV(tmp, a, w, h, r);
    }
    return a;
  }

  // ---------------------------------------------------------------- logos and layers
  /** straight-alpha sRGB Uint8 RGBA -> premultiplied float in the destination space. conv may be null. */
  function prepareLogo(logo, conv) {
    const n = logo.w * logo.h;
    const f = new Float32Array(n * 4);
    if (conv && !conv.identity) conv.convertRGBA(logo.rgba, f);
    else for (let i = 0; i < n * 4; i++) f[i] = logo.rgba[i];
    for (let i = 0; i < n * 4; i += 4) {
      const a = f[i + 3] / 255;
      f[i] *= a; f[i + 1] *= a; f[i + 2] *= a; f[i + 3] = a;
    }
    return { w: logo.w, h: logo.h, data: f };
  }

  /**
   * prep: { w, h, data } premultiplied float logo already at its final pixel size.
   * o: { opacity 0..1, shadow: { strength 0..1, sigma, dx, dy, color:[r,g,b] 0..255 } | null }
   * Returns { w, h, data, ox, oy } where (ox, oy) is the layer's offset from the logo's top-left.
   */
  function buildLayer(prep, o) {
    const sh = o.shadow && o.shadow.strength > 0.002 ? o.shadow : null;
    const dx = sh ? Math.round(sh.dx) : 0, dy = sh ? Math.round(sh.dy) : 0;
    const pad = sh ? Math.ceil(3.3 * sh.sigma) + 2 : 0;
    const padL = pad + Math.max(0, -dx), padR = pad + Math.max(0, dx), padT = pad + Math.max(0, -dy), padB = pad + Math.max(0, dy);
    const W = prep.w + padL + padR, H = prep.h + padT + padB;
    const out = new Float32Array(W * H * 4);
    const op = o.opacity;
    let A = null;
    if (sh) {
      A = new Float32Array(W * H);
      for (let y = 0; y < prep.h; y++) {
        const so = y * prep.w * 4, dO = (y + padT + dy) * W + padL + dx;
        for (let x = 0; x < prep.w; x++) A[dO + x] = prep.data[so + x * 4 + 3];
      }
      blurPlane(A, W, H, sh.sigma);
    }
    const sc = sh ? sh.color : [0, 0, 0], k = sh ? sh.strength : 0;
    const d = prep.data;
    for (let y = 0; y < H; y++) {
      const ly = y - padT, inY = ly >= 0 && ly < prep.h;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const sa = A ? A[i] * k : 0;
        let r = sa * sc[0], g = sa * sc[1], b = sa * sc[2], a = sa;
        const lx = x - padL;
        if (inY && lx >= 0 && lx < prep.w) {
          const li = (ly * prep.w + lx) * 4, la = d[li + 3], inv = 1 - la;
          r = d[li] + r * inv; g = d[li + 1] + g * inv; b = d[li + 2] + b * inv; a = la + a * inv;
        }
        const oi = i * 4;
        out[oi] = r * op; out[oi + 1] = g * op; out[oi + 2] = b * op; out[oi + 3] = a * op;
      }
    }
    return { w: W, h: H, data: out, ox: -padL, oy: -padT };
  }

  /** Blend a layer onto rows [stripY0, stripY0+stripRows) of an RGB buffer whose rows are dstW pixels wide. */
  function compositeLayer(dst, dstW, stripY0, stripRows, layer, lx, ly) {
    const x0 = Math.max(0, lx), x1 = Math.min(dstW, lx + layer.w);
    const y0 = Math.max(stripY0, ly), y1 = Math.min(stripY0 + stripRows, ly + layer.h);
    if (x0 >= x1 || y0 >= y1) return;
    const data = layer.data;
    for (let y = y0; y < y1; y++) {
      let di = ((y - stripY0) * dstW + x0) * 3;
      let si = ((y - ly) * layer.w + (x0 - lx)) * 4;
      for (let x = x0; x < x1; x++, di += 3, si += 4) {
        const a = data[si + 3];
        if (a <= 0.0004) continue;
        const inv = 1 - a;
        dst[di] = dst[di] * inv + data[si] + 0.5;
        dst[di + 1] = dst[di + 1] * inv + data[si + 1] + 0.5;
        dst[di + 2] = dst[di + 2] * inv + data[si + 2] + 0.5;
      }
    }
  }

  /** Premultiplied float layer -> straight 8-bit RGBA (for drawing in the preview). */
  function layerToRGBA8(layer) {
    const n = layer.w * layer.h, d = layer.data, out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const a = d[i * 4 + 3];
      if (a <= 0) continue;
      const k = 1 / a;
      out[i * 4] = d[i * 4] * k; out[i * 4 + 1] = d[i * 4 + 1] * k; out[i * 4 + 2] = d[i * 4 + 2] * k; out[i * 4 + 3] = a * 255;
    }
    return out;
  }

  // ---------------------------------------------------------------- layout
  /**
   * marks: [{ side: 'left'|'right', w, h, size }] with w/h the trimmed logo size and `size` the logo's long edge as a
   * fraction of the short side. Margin is also a fraction of the short side, so all four gaps are identical.
   */
  function layout(outW, outH, marks, marginFrac) {
    const short = Math.min(outW, outH);
    const M = Math.round(marginFrac * short);
    return marks.map((m) => {
      const L = Math.max(2, Math.round(m.size * short));
      const sc = L / Math.max(m.w, m.h);
      const w = Math.max(1, Math.round(m.w * sc)), h = Math.max(1, Math.round(m.h * sc));
      return { side: m.side, x: m.side === 'left' ? M : outW - M - w, y: outH - M - h, w, h, margin: M };
    });
  }

  /** Shadow settings (all 0..1 sliders) -> pixel values for a logo whose long edge is `longEdgePx`. */
  function shadowPx(style, longEdgePx, color) {
    if (!style || !style.on || style.strength <= 0) return null;
    const rad = style.angle * Math.PI / 180, dist = style.distance * 0.06 * longEdgePx;
    return {
      strength: style.strength,
      sigma: style.blur * 0.05 * longEdgePx,
      dx: Math.cos(rad) * dist, dy: Math.sin(rad) * dist,
      color: color || [0, 0, 0],
    };
  }

  return { trim, resize, blurPlane, prepareLogo, buildLayer, compositeLayer, layerToRGBA8, layout, shadowPx, _boxSizes: boxSizes };
})();
