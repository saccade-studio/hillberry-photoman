'use strict';
/* Minimal ZIP writer (STORE only — JPEG/PNG data is already compressed). Produces Blob parts so large batches
 * never have to be copied into one big array. */
HB.zip = (function () {
  const LIMIT = 0xFFFFFFFF - 1024 * 1024;

  function dosTime(d) { return (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); }
  function dosDate(d) { return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(); }
  function utf8(s) { return new TextEncoder().encode(s); }

  /** entries: [{ name, size, crc, data }] where data is anything Blob accepts as a part. Returns an array of parts. */
  function build(entries, when) {
    const d = when || new Date();
    const time = dosTime(d), date = dosDate(d);
    const parts = [], central = [];
    let offset = 0;
    const used = new Set();
    for (const e of entries) {
      let name = e.name, n = 1;
      while (used.has(name.toLowerCase())) {
        const dot = e.name.lastIndexOf('.');
        name = dot > 0 ? `${e.name.slice(0, dot)}-${++n}${e.name.slice(dot)}` : `${e.name}-${++n}`;
      }
      used.add(name.toLowerCase());
      const nb = utf8(name);
      const lh = new Uint8Array(30 + nb.length);
      const l = new DataView(lh.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint16(8, 0, true);
      l.setUint16(10, time, true); l.setUint16(12, date, true); l.setUint32(14, e.crc >>> 0, true);
      l.setUint32(18, e.size, true); l.setUint32(22, e.size, true); l.setUint16(26, nb.length, true); l.setUint16(28, 0, true);
      lh.set(nb, 30);
      const ch = new Uint8Array(46 + nb.length);
      const c = new DataView(ch.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, e.crc >>> 0, true);
      c.setUint32(20, e.size, true); c.setUint32(24, e.size, true); c.setUint16(28, nb.length, true);
      c.setUint32(42, offset, true);
      ch.set(nb, 46);
      central.push(ch);
      parts.push(lh, e.data);
      offset += lh.length + e.size;
      if (offset > LIMIT) throw new Error('ZIP too large');
    }
    let cdSize = 0;
    for (const c of central) { parts.push(c); cdSize += c.length; }
    const eocd = new Uint8Array(22);
    const v = new DataView(eocd.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true);
    v.setUint32(12, cdSize, true); v.setUint32(16, offset, true);
    parts.push(eocd);
    return parts;
  }

  return { build, LIMIT };
})();
