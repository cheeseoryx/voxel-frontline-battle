from PIL import Image
import os

BASE = r"F:\voxel-frontline-battle\tmp\weapon-ocr"


def ascii_region(im, x0, y0, x1, y1, sx=2, sy=1):
    lines = []
    for y in range(y0, y1, sy):
        row = ""
        for x in range(x0, x1, sx):
            row += "#" if im.getpixel((x, y)) > 60 else "."
        lines.append(row)
    return "\n".join(lines)


def scan_all(name):
    im = Image.open(os.path.join(BASE, name)).convert("L")
    w, h = im.size
    ys = []
    for y in range(h):
        bright = [x for x in range(w) if im.getpixel((x, y)) > 50]
        if bright:
            ys.append((y, min(bright), max(bright)))
    clusters = []
    cur = []
    prev = None
    for y, mn, mx in ys:
        if prev is None or y == prev + 1:
            cur.append((y, mn, mx))
        else:
            clusters.append(cur)
            cur = [(y, mn, mx)]
        prev = y
    if cur:
        clusters.append(cur)
    print("====", name, "ALL x")
    for i, c in enumerate(clusters):
        y0, y1 = c[0][0], c[-1][0]
        xmin = min(t[1] for t in c)
        xmax = max(t[2] for t in c)
        if y1 - y0 >= 6:
            print(f"  y={y0:4d}-{y1:4d} x={xmin:3d}-{xmax:3d} h={y1-y0+1}")


for name in ["M9-num.png", "MP5-num.png", "MSR-num.png", "M249-num.png"]:
    scan_all(name)
