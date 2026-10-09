// EXIF rebuild with a big-endian ("MM", Nikon/Canon-style) block containing a MakerNote, thumbnail IFD and GPS.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadCore } from '../tools/load-core.mjs';
const HB = loadCore();
const SP = process.argv[2];
let bad = 0;
const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };

// --- hand-build a big-endian TIFF: IFD0 (Make, Orientation=8, ExifIFD ptr, GPS ptr, next->IFD1), ExifIFD (ExposureTime, MakerNote), GPS, IFD1 (thumbnail)
function buildBE() {
  const parts = [];
  const u16 = (v) => [(v >> 8) & 255, v & 255], u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const entry = (tag, type, count, valOrOff) => [...u16(tag), ...u16(type), ...u32(count), ...valOrOff];
  const ascii = (s) => [...Buffer.from(s + '\0')];
  // layout plan (offsets from TIFF start)
  const make = ascii('NIKON CORPORATION');                   // 18 bytes
  const maker = Array.from({ length: 40 }, (_, i) => 0xAB);   // MakerNote junk
  const thumb = [0xFF, 0xD8, ...ascii('SECRET-THUMBNAIL-OF-ORIGINAL'), 0xFF, 0xD9];
  const ifd0Off = 8, nIfd0 = 5, ifd0Size = 2 + 12 * nIfd0 + 4;
  const exifOff = ifd0Off + ifd0Size, nExif = 2, exifSize = 2 + 12 * nExif + 4;
  const gpsOff = exifOff + exifSize, nGps = 2, gpsSize = 2 + 12 * nGps + 4;
  const ifd1Off = gpsOff + gpsSize, nIfd1 = 2, ifd1Size = 2 + 12 * nIfd1 + 4;
  let dataOff = ifd1Off + ifd1Size;
  const makeOff = dataOff; dataOff += make.length + (make.length & 1);
  const expOff = dataOff; dataOff += 8;
  const makerOff = dataOff; dataOff += maker.length;
  const latOff = dataOff; dataOff += 24;
  const thumbOff = dataOff; dataOff += thumb.length;
  const out = [0x4D, 0x4D, 0, 42, ...u32(8)];
  out.push(...u16(nIfd0),
    ...entry(0x010F, 2, make.length, u32(makeOff)),
    ...entry(0x0112, 3, 1, [...u16(8), 0, 0]),
    ...entry(0x0131, 2, 4, [...ascii('ab').concat([0]), 0].slice(0, 4)),
    ...entry(0x8769, 4, 1, u32(exifOff)),
    ...entry(0x8825, 4, 1, u32(gpsOff)), ...u32(ifd1Off));
  out.push(...u16(nExif), ...entry(0x829A, 5, 1, u32(expOff)), ...entry(0x927C, 7, maker.length, u32(makerOff)), ...u32(0));
  out.push(...u16(nGps), ...entry(0x0001, 2, 2, [0x4E, 0, 0, 0]), ...entry(0x0002, 5, 3, u32(latOff)), ...u32(0));
  out.push(...u16(nIfd1), ...entry(0x0201, 4, 1, u32(thumbOff)), ...entry(0x0202, 4, 1, u32(thumb.length)), ...u32(0));
  out.push(...make, ...(make.length & 1 ? [0] : []));
  out.push(...u32(1), ...u32(500));                                                    // ExposureTime 1/500
  out.push(...maker);
  out.push(...u32(38), ...u32(1), ...u32(37), ...u32(1), ...u32(28), ...u32(1));      // GPS latitude 38 37 28
  out.push(...thumb);
  return new Uint8Array(out);
}
const tiff = buildBE();
const payload = new Uint8Array(6 + tiff.length); payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]); payload.set(tiff, 6);
const exif = payload.subarray(6);
check(HB.exif.orientation(exif) === 8, 'big-endian orientation parsed (8)');
const rebuilt = HB.exif.rebuild(exif, { width: 1234, height: 987, colorSpaceTag: 0xFFFF, dpi: 300, stripGPS: false });
const hay = Buffer.from(rebuilt).toString('latin1');
check(!hay.includes('SECRET-THUMBNAIL'), 'embedded thumbnail removed');
check(![...rebuilt].some((v, i, a) => v === 0xAB && a[i + 1] === 0xAB && a[i + 2] === 0xAB && a[i + 3] === 0xAB), 'MakerNote removed');
check(hay.includes('NIKON CORPORATION'), 'camera make kept');
check(rebuilt[6] === 0x4D && rebuilt[7] === 0x4D, 'byte order preserved (big-endian)');
check(HB.exif.orientation(rebuilt.subarray(6)) === 1, 'orientation reset to 1');
// feed it into a real JPEG and let PIL + sips read it
const jpg = HB.jpegEnc.encode({ width: 64, height: 48, quality: 90, optimize: false, segments: [HB.exif.exifSegment(rebuilt)], getRows(y, n, o) { o.fill(120); } });
fs.writeFileSync(SP + '/fx/be_exif.jpg', jpg);
const out = execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open("${SP}/fx/be_exif.jpg"); ex = im.getexif(); sub = ex.get_ifd(0x8769); gps = ex.get_ifd(0x8825)
print(ex.get(0x010F), ex.get(0x0112), sub.get(0xA002), sub.get(0xA003), sub.get(0xA001), float(sub.get(0x829A)), gps.get(1), gps.get(2), ex.get(0x011A), im.info.get("dpi"))
`]).toString().trim();
console.log('PIL reads:', out);
check(out === 'NIKON CORPORATION 1 1234 987 65535 0.002 N (38.0, 37.0, 28.0) 300.0 (300.0, 300.0)', 'PIL reads every rebuilt big-endian value correctly');
const sips = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'make', SP + '/fx/be_exif.jpg']).toString();
check(/NIKON/.test(sips), 'Apple ImageIO reads the rebuilt EXIF too');
// garbage / truncated input must not throw
for (const junk of [new Uint8Array([1, 2, 3]), new Uint8Array(0), tiff.subarray(0, 30), new Uint8Array(200).fill(0xFF)]) {
  try { const r = HB.exif.rebuild(junk, { width: 10, height: 10 }); if (!r || r.length < 8) throw new Error('empty'); }
  catch (e) { check(false, 'rebuild must tolerate garbage: ' + e.message); }
}
check(true, 'garbage/truncated EXIF handled without throwing');
console.log(bad ? bad + ' FAILURE(S)' : 'EXIF: all checks passed');
process.exit(bad ? 1 : 0);
