import sys, os, io, json, struct
import numpy as np
from PIL import Image, ImageDraw, ImageCms, ImageOps, ImageFont
from PIL.TiffImagePlugin import IFDRational as R
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
PROF = {
  "adobe": "/System/Library/ColorSync/Profiles/AdobeRGB1998.icc",
  "p3": "/System/Library/ColorSync/Profiles/Display P3.icc",
  "prophoto": "/System/Library/ColorSync/Profiles/ROMM RGB.icc",
}
srgb_prof = ImageCms.createProfile("sRGB")

def scene(w, h, seed=7):
    r = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    # smooth, saturated, photo-like scene: sky gradient, hills, noise
    sky = np.stack([40 + 60 * (y / h), 90 + 90 * (y / h), 200 - 60 * (y / h)], -1)
    hills = (np.sin(x / 180.0) * 60 + h * 0.62)
    ground = np.stack([70 + 40 * np.sin(x / 90.0), 130 + 50 * np.cos(x / 130.0 + y / 80.0), 60 + 20 * np.sin(y / 40.0)], -1)
    img = np.where((y > hills)[..., None], ground, sky)
    img += r.normal(0, 3.0, img.shape)
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    d.rectangle([w * 0.1, h * 0.15, w * 0.3, h * 0.35], fill=(230, 40, 40))     # saturated red
    d.rectangle([w * 0.4, h * 0.15, w * 0.6, h * 0.35], fill=(20, 220, 60))     # saturated green
    d.rectangle([w * 0.7, h * 0.15, w * 0.9, h * 0.35], fill=(30, 60, 240))     # saturated blue
    d.ellipse([w * 0.4, h * 0.75, w * 0.6, h * 0.95], fill=(250, 190, 20))
    return im

base = scene(2400, 1600)
base.save(f"{out}/photo_srgb.jpg", quality=92, subsampling=2)                    # no profile
base.save(f"{out}/photo_srgb_icc.jpg", quality=92, subsampling=2, icc_profile=ImageCms.ImageCmsProfile(srgb_prof).tobytes())
base.save(f"{out}/photo_srgb.png")
for name, path in PROF.items():
    dst = ImageCms.getOpenProfile(path)
    conv = ImageCms.profileToProfile(base, srgb_prof, dst, renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, outputMode="RGB")
    icc = open(path, "rb").read()
    conv.save(f"{out}/photo_{name}.jpg", quality=92, subsampling=2, icc_profile=icc)
    conv.save(f"{out}/photo_{name}.png", icc_profile=icc)

# ---- orientation fixtures: stored pixels + EXIF tag such that the *displayed* image is `upright`
upright = Image.new("RGB", (300, 200), (30, 30, 30))
d = ImageDraw.Draw(upright)
d.rectangle([0, 0, 149, 99], fill=(255, 0, 0))        # top-left red
d.rectangle([150, 0, 299, 99], fill=(0, 255, 0))      # top-right green
d.rectangle([0, 100, 149, 199], fill=(0, 0, 255))     # bottom-left blue
d.rectangle([150, 100, 299, 199], fill=(255, 255, 0)) # bottom-right yellow
d.polygon([(40, 150), (110, 150), (40, 60)], fill=(255, 255, 255))   # asymmetric marker
upright.save(f"{out}/upright.png")
inverse = {1: None, 2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180, 4: Image.Transpose.FLIP_TOP_BOTTOM,
           5: Image.Transpose.TRANSPOSE, 6: Image.Transpose.ROTATE_90, 7: Image.Transpose.TRANSVERSE, 8: Image.Transpose.ROTATE_270}
for o in range(1, 9):
    stored = upright if inverse[o] is None else upright.transpose(inverse[o])
    ex = Image.Exif(); ex[0x0112] = o
    stored.save(f"{out}/orient_{o}.jpg", quality=98, subsampling=0, exif=ex)
    # sanity: PIL's own interpretation must give back the upright image
    back = ImageOps.exif_transpose(Image.open(f"{out}/orient_{o}.jpg"))
    diff = np.abs(np.array(back).astype(int) - np.array(upright).astype(int)).mean()
    assert diff < 6, (o, diff)

# ---- metadata-rich fixture (EXIF incl. GPS + a fake MakerNote + stale dimensions)
ex = Image.Exif()
ex[0x010F] = "HillberryCam"; ex[0x0110] = "HB-1 Mark II"; ex[0x0112] = 6
ex[0x0131] = "UnitTest 1.0"; ex[0x013B] = "Jane Photographer"; ex[0x8298] = "(c) 2026 Jane Photographer"
ex[0x011A] = R(300, 1); ex[0x011B] = R(300, 1); ex[0x0128] = 2
sub = ex.get_ifd(0x8769)
sub[0x829A] = R(1, 250); sub[0x829D] = R(28, 10); sub[0x8827] = 400; sub[0x9003] = "2026:07:11 19:42:07"
sub[0x920A] = R(85, 1); sub[0xA002] = 9999; sub[0xA003] = 8888; sub[0xA001] = 1
sub[0x927C] = b"MAKERNOTE-SECRET-PREVIEW-BYTES" * 20
sub[0xA420] = "UNIQUE-ID-OF-ORIGINAL"
sub[0x9214] = (10, 20, 30, 40)
gps = ex.get_ifd(0x8825)
gps[1] = "N"; gps[2] = (R(38, 1), R(37, 1), R(28, 1)); gps[3] = "W"; gps[4] = (R(90, 1), R(11, 1), R(15, 1))
stored = upright.transpose(inverse[6])
stored.save(f"{out}/rich_exif.jpg", quality=95, subsampling=0, exif=ex, icc_profile=open(PROF["p3"], "rb").read())
print("fixtures written to", out)

# ---- extras for UI / fallback tests
import subprocess
base.save(f"{out}/photo_srgb.webp", quality=95)
base.convert("CMYK").save(f"{out}/cmyk.jpg", quality=90)
base.save(f"{out}/_tmp.ppm")
try:
    subprocess.run(["cjpeg", "-arithmetic", "-quality", "85", "-outfile", f"{out}/arith.jpg", f"{out}/_tmp.ppm"], check=True, capture_output=True)
except Exception as e:
    print("note: cjpeg has no arithmetic support;", e)
os.remove(f"{out}/_tmp.ppm")
mark = Image.new("RGBA", (800, 360), (0, 0, 0, 0))
d = ImageDraw.Draw(mark)
try: f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia Bold.ttf", 230)
except Exception: f = ImageFont.load_default()
d.text((60, 20), "JP", font=f, fill=(255, 255, 255, 255))
d.rounded_rectangle([60, 300, 740, 318], radius=9, fill=(255, 214, 10, 255))
mark.save(f"{out}/jp_monogram.png")
open(f"{out}/studio.svg", "w").write('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120"><rect x="4" y="4" width="392" height="112" rx="16" fill="none" stroke="#ffffff" stroke-width="6"/><text x="200" y="76" font-family="Helvetica, Arial, sans-serif" font-size="52" font-weight="700" text-anchor="middle" fill="#ffffff">STUDIO JP</text></svg>''')
print("extras written")

# ---- big + broken files for the batch / cancel tests
rng = np.random.default_rng(9)
W, H = 6000, 4000
y, x = np.mgrid[0:H, 0:W].astype(np.float32)
big = np.stack([128 + 100 * np.sin(x / 300), 128 + 90 * np.cos(y / 250), 128 + 80 * np.sin((x - y) / 400)], -1) + rng.normal(0, 4, (H, W, 3)).astype(np.float32)
Image.fromarray(np.clip(big, 0, 255).astype(np.uint8)).save(f"{out}/big_24mp.jpg", quality=92, subsampling=2, icc_profile=open(PROF["adobe"], "rb").read())
good = open(f"{out}/photo_srgb.jpg", "rb").read()
sos = good.find(b"\xff\xda")
open(f"{out}/broken.jpg", "wb").write(good[:sos])          # valid headers, no image data at all
open(f"{out}/truncated.jpg", "wb").write(good[: int(len(good) * 0.4)])   # cut off part-way through
print("big + broken written")
