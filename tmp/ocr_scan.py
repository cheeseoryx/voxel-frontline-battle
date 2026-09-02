from PIL import Image
import os

BASE = r"F:\voxel-frontline-battle\tmp\weapon-ocr"


def scan(name, min_x=0, thresh=40, min_h=8):
    im = Image.open(os.path.join(BASE, name)).convert("L")
    w, h = im.size
    ys = []
    for y in range(h):
        bright = [x for x in range(min_x, w) if im.getpixel((x, y)) > thresh]
        if bright:
            ys.append((y, min(bright), max(bright), len(bright), max(im.getpixel((x, y)) for x in range(min_x, w))))
    clusters = []
    cur = []
    prev = None
    for row in ys:
        y = row[0]
        if prev is None or y == prev + 1:
            cur.append(row)
        else:
            clusters.append(cur)
            cur = [row]
        prev = y
    if cur:
        clusters.append(cur)
    print("====", name, "min_x", min_x, "thresh", thresh)
    for i, c in enumerate(clusters):
        y0, y1 = c[0][0], c[-1][0]
        xmin = min(t[1] for t in c)
        xmax = max(t[2] for t in c)
        nmax = max(t[4] for t in c)
        if (y1 - y0 + 1) >= min_h:
            print(f"  {i:2d} y={y0:4d}-{y1:4d} h={y1-y0+1:2d} x={xmin:3d}-{xmax:3d} maxv={nmax}")


for name in ["M9-num.png", "MP443-num.png", "MP5-num.png", "MP7-num.png", "MSR-num.png", "M4A1-num.png"]:
    scan(name, min_x=250, thresh=50)
