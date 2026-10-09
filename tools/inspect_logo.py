import sys
from PIL import Image
import numpy as np
src = sys.argv[1]
im = Image.open(src)
print("mode", im.mode, "size", im.size, "format", im.format, "info keys", list(im.info.keys()))
print("lossless?", im.info.get("lossless"), "icc:", "yes" if im.info.get("icc_profile") else "no")
im = im.convert("RGBA")
a = np.array(im)
alpha = a[..., 3]
print("alpha min/max", alpha.min(), alpha.max(), "fully transparent px %", round(100*(alpha==0).mean(),1), "partial %", round(100*((alpha>0)&(alpha<255)).mean(),1))
ys, xs = np.where(alpha > 4)
print("alpha>4 bbox: x", xs.min(), xs.max(), " y", ys.min(), ys.max(), " => content size", xs.max()-xs.min()+1, "x", ys.max()-ys.min()+1)
ys, xs = np.where(alpha > 0)
print("alpha>0 bbox: x", xs.min(), xs.max(), " y", ys.min(), ys.max())
# padding
H, W = alpha.shape
print("padding L/R/T/B:", xs.min(), W-1-xs.max(), ys.min(), H-1-ys.max())
# dominant opaque colors
op = a[alpha > 250][:, :3]
from collections import Counter
q = (op // 16) * 16 + 8
c = Counter(map(tuple, q.tolist()))
print("top colors (quantized):")
for col, n in c.most_common(8):
    print("  #%02x%02x%02x" % col, n)
# average of top-vs-bottom
print("mean color top 30% rows:", op.mean(axis=0).round(1))
im.save(sys.argv[2], optimize=True)
import os
print("png bytes:", os.path.getsize(sys.argv[2]))
# composite over mid-gray and white for visual check
for name, bg in (("gray", (128,128,128,255)), ("photo-ish", (60,90,60,255))):
    base = Image.new("RGBA", im.size, bg)
    base.alpha_composite(im)
    base.convert("RGB").save(f"/tmp/_logo_on_{name}.png")
