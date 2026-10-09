import sys, json, io
import numpy as np
from PIL import Image, ImageOps, ImageCms
SP = sys.argv[1]
FX, OUT = SP + "/fx", SP + "/out"
cases = json.load(open(OUT + "/cases.json"))
fails = 0
def fail(msg):
    global fails; fails += 1; print("   FAIL:", msg)
def psnr(a, b):
    mse = np.mean((a.astype(float) - b.astype(float)) ** 2)
    return 99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse)
srgb = ImageCms.createProfile("sRGB")

print(f"{'case':26} {'size':>11}  checks")
for c in cases:
    name = c["name"]
    out = Image.open(f"{OUT}/{c['out']}")
    out.load()
    msgs = []
    o = np.array(out.convert("RGB"))
    if out.size != (c["w"], c["h"]): fail(f"{name}: size {out.size} != {(c['w'], c['h'])}")
    src = Image.open(f"{FX}/{c['src']}")
    src_icc = src.info.get("icc_profile")
    out_icc = out.info.get("icc_profile")
    # ---- colour space: embedded profile preserved byte-for-byte
    if src_icc:
        if out_icc != src_icc: fail(f"{name}: ICC profile not preserved byte-for-byte")
        else: msgs.append("ICC identical")
    else:
        d = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(out_icc))).strip() if out_icc else None
        if not out_icc: fail(f"{name}: no profile written for untagged source")
        else: msgs.append(f"tagged '{d}'")
    # ---- background fidelity outside the watermark boxes
    s = np.array(ImageOps.exif_transpose(src).convert("RGB"))
    cr = c["crop"]
    ref = s[cr["y"]:cr["y"] + cr["h"], cr["x"]:cr["x"] + cr["w"]]
    mask = np.ones(ref.shape[:2], bool)
    for b in c["boxes"]:
        pad = int(max(b["w"], b["h"]) * 0.2) + 4
        mask[max(0, b["y"] - pad):b["y"] + b["h"] + pad, max(0, b["x"] - pad):b["x"] + b["w"] + pad] = False
    if ref.shape != o.shape:
        fail(f"{name}: crop shape {ref.shape} vs output {o.shape}")
    else:
        bg_o, bg_r = o[mask], ref[mask]
        p = psnr(bg_o, bg_r)
        mx = int(np.abs(bg_o.astype(int) - bg_r.astype(int)).max())
        if c["out"].endswith(".png"):
            if mx != 0: fail(f"{name}: PNG background must be bit-exact, max diff {mx}")
            else: msgs.append("PNG background bit-exact")
        elif c["src"].startswith("orient"):
            pass
        else:
            if p < 44: fail(f"{name}: background PSNR {p:.1f} dB too low")
            msgs.append(f"bg {p:.1f} dB (max {mx})")
    # ---- orientation
    if c.get("orient"):
        up = np.array(Image.open(f"{FX}/upright.png").convert("RGB"))
        if up.shape != o.shape: fail(f"{name}: not upright (shape {o.shape} vs {up.shape})")
        else:
            p = psnr(up, o)
            if p < 33: fail(f"{name}: orientation wrong, PSNR vs upright {p:.1f}")
            else: msgs.append(f"upright {p:.0f} dB")
    # ---- exact colour of an opaque logo, judged in sRGB by littleCMS
    for sc in c.get("solid", []):
        b = next(b for b in c["boxes"] if b["side"] == sc["side"])
        cx, cy = b["x"] + b["w"] // 2, b["y"] + b["h"] // 2
        px = o[cy - 2:cy + 3, cx - 2:cx + 3].reshape(-1, 3)
        if (px != px[0]).any(): fail(f"{name}: logo interior not uniform")
        px1 = Image.fromarray(px[:1].reshape(1, 1, 3).astype(np.uint8))
        if out_icc:
            prof = ImageCms.ImageCmsProfile(io.BytesIO(out_icc))
            # ideal 8-bit encoding of the logo colour in the photo's space, according to littleCMS
            fwd = ImageCms.buildTransform(srgb, prof, "RGB", "RGB", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
            ideal = np.array(ImageCms.applyTransform(Image.fromarray(np.array([[sc["rgb"]]], np.uint8)), fwd))[0, 0]
            # what you would get if the logo were pasted WITHOUT converting into the photo's colour space
            back = ImageCms.buildTransform(prof, srgb, "RGB", "RGB", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
            nseen = np.array(ImageCms.applyTransform(Image.fromarray(np.array([[sc["rgb"]]], np.uint8)), back))[0, 0]
        else:
            ideal = np.array(sc["rgb"]); nseen = ideal
        err = int(np.abs(px[0].astype(int) - ideal.astype(int)).max())
        nerr = int(np.abs(nseen.astype(int) - np.array(sc["rgb"])).max())
        if err > 1: fail(f"{name}: {sc['side']} logo encoded {tuple(int(v) for v in px[0])}, littleCMS ideal {tuple(int(v) for v in ideal)}")
        msgs.append(f"{sc['side']} logo within {err} code value of ideal (a naive paste would shift sRGB colour by {nerr})")
    # ---- opacity
    if c.get("opacity"):
        b = c["boxes"][0]; cx, cy = b["x"] + b["w"] // 2, b["y"] + b["h"] // 2
        want = 0.5 * ref[cy, cx].astype(float) + 0.5 * 255
        got = o[cy, cx].astype(float)
        e = np.abs(got - want).max()
        if e > 2.5: fail(f"{name}: opacity blend off by {e:.1f}")
        msgs.append(f"50% blend err {e:.1f}")
    # ---- shadow darkens the area next to the logo
    if name == "shadow_on":
        b = next(b for b in c["boxes"] if b["side"] == "right")
        below = o[b["y"] + b["h"]: b["y"] + b["h"] + 6, b["x"] + b["w"] // 2: b["x"] + b["w"] // 2 + 40].astype(float).mean()
        refb = ref[b["y"] + b["h"]: b["y"] + b["h"] + 6, b["x"] + b["w"] // 2: b["x"] + b["w"] // 2 + 40].astype(float).mean()
        if not below < refb - 3: fail(f"{name}: no visible shadow ({below:.1f} vs {refb:.1f})")
        msgs.append(f"shadow darkens neighbourhood {refb:.0f}->{below:.0f}")
    # ---- metadata
    if c.get("meta"):
        raw = open(f"{OUT}/{c['out']}", "rb").read()
        m = c["meta"]
        ex = out.getexif()
        sub = ex.get_ifd(0x8769)
        gps = ex.get_ifd(0x8825)
        for secret in (b"MAKERNOTE-SECRET", b"UNIQUE-ID-OF-ORIGINAL"):
            if secret in raw: fail(f"{name}: leaked original metadata {secret!r}")
        if m == "none":
            if len(ex) or sub: fail(f"{name}: EXIF should be absent, found {dict(ex)}")
            else: msgs.append("no EXIF")
        else:
            checks = {"Make": ex.get(0x010F) == "HillberryCam", "Model": ex.get(0x0110) == "HB-1 Mark II", "Artist": ex.get(0x013B) == "Jane Photographer",
                      "Copyright": ex.get(0x8298) == "(c) 2026 Jane Photographer", "Orientation=1": ex.get(0x0112) == 1,
                      "PixelX": sub.get(0xA002) == c["w"], "PixelY": sub.get(0xA003) == c["h"], "DateTimeOriginal": sub.get(0x9003) == "2026:07:11 19:42:07",
                      "ISO": sub.get(0x8827) == 400, "ExposureTime": abs(float(sub.get(0x829A, 0)) - 0.004) < 1e-6,
                      "no MakerNote": 0x927C not in sub, "no SubjectArea": 0x9214 not in sub, "no UniqueID": 0xA420 not in sub,
                      "XRes=300": float(ex.get(0x011A, 0)) == 300.0}
            bad = [k for k, v in checks.items() if not v]
            if bad: fail(f"{name}: EXIF problems: {bad}")
            has_gps = bool(gps)
            if (m == "all") != has_gps: fail(f"{name}: GPS presence {has_gps} wrong for mode {m}")
            if m == "all" and gps.get(2) != (38.0, 37.0, 28.0): fail(f"{name}: GPS value changed {gps}")
            msgs.append(f"EXIF ok ({len(checks)} fields), GPS {'kept' if has_gps else 'removed'}")
        if out.info.get("dpi") and round(out.info["dpi"][0]) != 300: fail(f"{name}: JFIF dpi {out.info.get('dpi')}")
    print(f"{name:26} {out.size[0]:>5}x{out.size[1]:<5}  " + "; ".join(msgs))
print("\n" + ("ALL PIPELINE CHECKS PASSED" if not fails else f"{fails} FAILURE(S)"))
sys.exit(1 if fails else 0)
