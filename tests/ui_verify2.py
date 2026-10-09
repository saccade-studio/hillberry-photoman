"""Content checks for the export-options test: JPEG q92 + 4:2:0 + no metadata, and PNG."""
import sys, io
from PIL import Image, JpegImagePlugin, ImageCms
work = sys.argv[1]
fails = 0
def check(c, m):
    global fails
    print(("ok   " if c else "FAIL ") + m)
    if not c: fails += 1
j = Image.open(f"{work}/ui-e2e3/options.jpg"); j.load()
check(JpegImagePlugin.get_sampling(j) == 2, "chroma subsampling is 4:2:0 as selected")
# libjpeg's quality scaling of the standard luminance / chrominance tables, quality 92
LUM = [16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99]
CHR = [17,18,24,47,99,99,99,99,18,21,26,66,99,99,99,99,24,26,56,99,99,99,99,99,47,66,99,99,99,99,99,99] + [99] * 32
scale = 200 - 2 * 92
exp = lambda base: sorted(max(1, min(255, (v * scale + 50) // 100)) for v in base)
check(sorted(j.quantization[0]) == exp(LUM) and sorted(j.quantization[1]) == exp(CHR), "both quantisation tables are exactly libjpeg's quality-92 tables")
check(len(j.getexif()) == 0, "metadata removed as selected")
check("icc_profile" in j.info and "sRGB" in ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(j.info["icc_profile"]))), "color profile is still embedded (sRGB) even with metadata removed")
p = Image.open(f"{work}/ui-e2e3/options.png"); p.load()
check(p.format == "PNG" and p.size == j.size and "icc_profile" in p.info, f"PNG export: {p.size}, profile embedded")
sys.exit(1 if fails else 0)
