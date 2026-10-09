import sys, os, zlib, struct, json
import numpy as np
from PIL import Image
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(5)
W, H = 37, 29   # odd sizes exercise Adam7 edge cases
base = np.stack([np.linspace(0, 255, W)[None, :].repeat(H, 0), np.linspace(255, 0, H)[:, None].repeat(W, 1), rng.integers(0, 256, (H, W))], -1).astype(np.uint8)
cases = {}
def save(name, im, **kw):
    im.save(f"{out}/{name}.png", **kw); cases[name] = f"{name}.png"
save("rgb8", Image.fromarray(base))
save("gray8", Image.fromarray(base[..., 0]))
save("gray1", Image.fromarray(base[..., 0]).convert("1"))
a = np.dstack([base, rng.integers(0, 256, (H, W)).astype(np.uint8)])
save("rgba8", Image.fromarray(a))
save("la8", Image.fromarray(np.dstack([base[..., 0], a[..., 3]]), "LA"))
save("pal8", Image.fromarray(base).convert("P", palette=Image.ADAPTIVE, colors=40))
g16 = (base[..., 0].astype(np.uint16) * 257)
Image.fromarray(g16).save(f"{out}/gray16.png"); cases["gray16"] = "gray16.png"
# hand-written Adam7 interlaced RGB8
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
passes = [(0,0,8,8),(4,0,8,8),(0,4,4,8),(2,0,4,4),(0,2,2,4),(1,0,2,2),(0,1,1,2)]
raw = b""
for xs, ys, dx, dy in passes:
    sub = base[ys::dy, xs::dx]
    if sub.size == 0: continue
    for row in sub:
        filt = 1  # Sub filter exercised too
        r = row.reshape(-1).astype(np.int32)
        f = r.copy(); f[3:] = (r[3:] - r[:-3]) & 255
        raw += bytes([filt]) + f.astype(np.uint8).tobytes()
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 1)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open(f"{out}/rgb8_adam7.png", "wb").write(png); cases["rgb8_adam7"] = "rgb8_adam7.png"
# expected RGB (flatten on white like the decoder)
exp = {}
for n, f in cases.items():
    im = Image.open(f"{out}/{f}")
    if n == "rgb8_adam7": arr = base
    elif n == "gray16": arr = np.stack([np.round(g16 / 257.0).astype(np.uint8)] * 3, -1)
    else:
        im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255)); bg.alpha_composite(im); arr = np.array(bg.convert("RGB"))
    exp[n] = {"w": arr.shape[1], "h": arr.shape[0], "rgb": arr.reshape(-1).tolist()}
json.dump({"files": cases, "expected": exp}, open(f"{out}/png_cases.json", "w"))
print(len(cases), "png cases")
