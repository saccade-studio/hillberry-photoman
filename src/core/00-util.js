'use strict';
/* Hillberry PhotoMan core.
 * Pure-compute modules shared by the UI thread and the export worker.
 * Nothing in here touches the DOM. */
var HB = {};

HB.util = (function () {
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, prev) {
    let c = ((prev === undefined ? 0 : prev) ^ 0xFFFFFFFF) | 0;
    for (let i = 0, n = bytes.length; i < n; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function ascii(bytes, off, len) {
    let s = '';
    const end = Math.min(bytes.length, off + len);
    for (let i = off; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function concat(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  function startsWith(bytes, str, off) {
    off = off || 0;
    if (off + str.length > bytes.length) return false;
    for (let i = 0; i < str.length; i++) if (bytes[off + i] !== str.charCodeAt(i)) return false;
    return true;
  }

  /** Error with a machine-readable code so the UI can pick a fallback.
   *  'unsupported' -> the browser's own decoder should be used instead. */
  class HBError extends Error {
    constructor(code, message) { super(message); this.code = code; this.name = 'HBError'; }
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function be16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

  function sniffFormat(bytes) {
    if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
    if (bytes.length > 12 && startsWith(bytes, 'RIFF') && startsWith(bytes, 'WEBP', 8)) return 'webp';
    if (bytes.length > 12 && startsWith(bytes, 'ftyp', 4)) return 'isobmff'; // HEIC / AVIF
    if (bytes.length > 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A) || (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[3] === 0x2A))) return 'tiff';
    if (bytes.length > 3 && startsWith(bytes, 'GIF')) return 'gif';
    if (bytes.length > 2 && startsWith(bytes, 'BM')) return 'bmp';
    return 'unknown';
  }

  return { crc32, ascii, concat, startsWith, HBError, clamp, be16, be32, sniffFormat };
})();
