# Builds a JPEG test corpus with libjpeg-turbo's cjpeg and reference decodes with djpeg.
import sys, os, json, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
SCANS_SEQ = os.path.join(out, 'scans_seq.txt')
open(SCANS_SEQ, 'w').write('0;\n1;\n2;\n')
rng = np.random.default_rng(1234)

def photo_like(w, h, seed):
    r = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    base = np.stack([
        128 + 100 * np.sin(x / 37.0 + seed) * np.cos(y / 53.0),
        128 + 90 * np.sin((x + y) / 71.0 + seed * 2),
        128 + 110 * np.cos(x / 29.0 - y / 41.0),
    ], axis=-1)
    base += r.normal(0, 6, base.shape)           # sensor-like noise
    im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    for i in range(12):                           # hard edges + saturated colors stress chroma handling
        x0, y0 = int(r.integers(0, max(1, w))), int(r.integers(0, max(1, h)))
        d.rectangle([x0, y0, x0 + int(r.integers(2, 80)), y0 + int(r.integers(2, 60))], fill=tuple(int(v) for v in r.integers(0, 256, 3)))
        d.ellipse([y0 % max(1, w), x0 % max(1, h), y0 % max(1, w) + 40, x0 % max(1, h) + 40], outline=(255, 0, 0), width=2)
    d.text((5, 5), "Hillberry 2026 Aa", fill=(255, 255, 255))
    return im

sizes = [(1, 1), (7, 5), (16, 16), (17, 33), (64, 48), (255, 129), (640, 480), (1001, 777)]
variants = [
    ("444", ["-sample", "1x1"]),
    ("422", ["-sample", "2x1"]),
    ("420", ["-sample", "2x2"]),
    ("440", ["-sample", "1x2"]),
    ("420prog", ["-sample", "2x2", "-progressive"]),
    ("444prog", ["-sample", "1x1", "-progressive"]),
    ("420rst", ["-sample", "2x2", "-restart", "3"]),
    ("420opt", ["-sample", "2x2", "-optimize"]),
    ("gray", ["-grayscale"]),
    ("grayprog", ["-grayscale", "-progressive"]),
    ("q100_444", ["-sample", "1x1", "-quality", "100"]),
    ("q30_420", ["-sample", "2x2", "-quality", "30"]),
    ("rst5b_420", ["-sample", "2x2", "-restart", "5B"]),          # restart markers in the middle of MCU rows
    ("rst1b_444", ["-sample", "1x1", "-restart", "1B"]),          # a restart after every single MCU
    ("rst_prog", ["-sample", "2x2", "-progressive", "-restart", "7B"]),
    ("rgbspace", ["-rgb", "-sample", "1x1"]),                      # JPEG stored as RGB (Adobe marker, no YCC)
    ("q1_16bitq", ["-sample", "2x2", "-quality", "1"]),            # >255 quantiser values -> 16-bit DQT
    ("scans_seq", ["-sample", "1x1", "-scans", SCANS_SEQ]),        # sequential, one component per scan
    ("gray_rst", ["-grayscale", "-restart", "9B"]),
]
manifest = []
for (w, h) in sizes:
    im = photo_like(w, h, w * 31 + h)
    ppm = f"{out}/src_{w}x{h}.ppm"
    im.save(ppm)
    for name, args in variants:
        if name.startswith("gray") and (w, h) == (1, 1):
            pass
        jpg = f"{out}/c_{w}x{h}_{name}.jpg"
        ref = f"{out}/c_{w}x{h}_{name}.ref.ppm"
        q = ["-quality", "88"] if "-quality" not in args else []
        subprocess.run(["cjpeg", *q, *args, "-outfile", jpg, ppm], check=True)
        subprocess.run(["djpeg", "-ppm", "-outfile", ref, jpg], check=True)
        manifest.append({"jpg": jpg, "ref": ref, "w": w, "h": h, "name": name})
json.dump(manifest, open(f"{out}/manifest.json", "w"))
print(len(manifest), "cases")
