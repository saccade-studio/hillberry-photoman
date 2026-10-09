"""Independent checks (PIL + littleCMS) on the files that the UI end-to-end test really downloaded from Chrome."""
import sys, os, io, glob, zipfile
import numpy as np
from PIL import Image
work = sys.argv[1]
D = f"{work}/ui-e2e/downloads"
fails = 0
def check(c, m):
    global fails
    print(("ok   " if c else "FAIL ") + m)
    if not c: fails += 1

out = Image.open(f"{D}/photo_p3-Hillberry-10x8.jpg"); out.load()
src = Image.open(f"{work}/fx/photo_p3.jpg"); src.load()
check(out.size == (2000, 1600), f"Scott Print Size 8x10 (landscape) export is exactly 2000x1600: {out.size}")
check(out.size[0] * 4 == out.size[1] * 5, "aspect ratio is exactly 5:4")
check(out.info.get("icc_profile") == src.info.get("icc_profile"), "Display P3 profile is byte-identical to the original's")
check(out.info.get("dpi") and round(out.info["dpi"][0]) == 200, f"resolution tag = 200 dpi (so it measures 10 x 8 in): {out.info.get('dpi')}")
# the crop the UI used was centred (x=200): background must match the source outside the watermark bands
s = np.array(src.convert("RGB"))[0:1600, 200:2200].astype(int); o = np.array(out.convert("RGB")).astype(int)
d = np.abs(o - s).max(axis=2)
check(d[:int(1600 * .6)].max() <= 4, f"upper 60% of the frame matches the original to within re-encode noise (max {d[:int(1600*.6)].max()})")
band = d[int(1600 * .68):]
check((band[:, :1000] > 25).sum() > 300 and (band[:, 1000:] > 25).sum() > 2000, "both watermarks are present (festival logo right, text left)")
ys, xs = np.where(d > 25)
m = {"left": int(xs.min()), "right": 2000 - 1 - int(xs.max()), "bottom": 1600 - 1 - int(ys.max())}
check(all(abs(v - 40) <= 6 for v in m.values()), f"visible margins equal on left/right/bottom (expected ~40 px): {m}")
z = glob.glob(f"{D}/*.zip")
check(len(z) == 1, "Export all produced one zip")
with zipfile.ZipFile(z[0]) as zf:
    check(zf.testzip() is None, "zip CRCs verify")
    check(len(zf.namelist()) == 3, "zip holds all three photos: " + ", ".join(zf.namelist()))
    for n in zf.namelist():
        im = Image.open(io.BytesIO(zf.read(n))); im.load()
        check(im.format == "JPEG" and im.size[0] > 0, f"{n}: opens as JPEG {im.size}, profile {len(im.info.get('icc_profile', b''))} bytes")
sys.exit(1 if fails else 0)
