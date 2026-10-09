# Reference conversions from littleCMS (via PIL): sRGB -> target profile, relative colorimetric.
import json, sys, itertools
from PIL import Image, ImageCms
PROFILES = {
  "AdobeRGB": "/System/Library/ColorSync/Profiles/AdobeRGB1998.icc",
  "DisplayP3": "/System/Library/ColorSync/Profiles/Display P3.icc",
  "ProPhoto": "/System/Library/ColorSync/Profiles/ROMM RGB.icc",
  "Rec2020": "/System/Library/ColorSync/Profiles/ITU-2020.icc",
  "GenericRGB": "/System/Library/ColorSync/Profiles/Generic RGB Profile.icc",
}
srgb = ImageCms.createProfile("sRGB")
vals = [0, 8, 32, 64, 96, 128, 160, 192, 224, 248, 255]
cols = list(itertools.product(vals, repeat=3))
im = Image.new("RGB", (len(cols), 1))
im.putdata(cols)
out = {}
for name, path in PROFILES.items():
    dst = ImageCms.getOpenProfile(path)
    t = ImageCms.buildTransform(srgb, dst, "RGB", "RGB", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
    res = ImageCms.applyTransform(im, t)
    out[name] = {"path": path, "in": cols, "out": list(res.getdata())}
json.dump(out, open(sys.argv[1], "w"))
print("wrote", sys.argv[1], len(cols), "colors x", len(out), "profiles")
