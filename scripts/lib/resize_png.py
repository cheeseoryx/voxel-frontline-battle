"""resize_png.py <in.png> <out.png> <size> — 等比缩放到 size×size。

仅供 scripts/bake-roles.js 调用；依赖 Pillow（pip install pillow）。
"""
import sys
from PIL import Image

src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src)
im.resize((size, size), Image.LANCZOS).save(dst, optimize=True)
