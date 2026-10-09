import sys, json, os
from PIL import Image
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
im = Image.open(os.path.join(root, "assets", "hillberry-logo.webp")).convert("RGBA")
open(sys.argv[1] + "/logo.rgba", "wb").write(im.tobytes())
json.dump({"w": im.size[0], "h": im.size[1]}, open(sys.argv[1] + "/logo.json", "w"))
print("logo", im.size)
