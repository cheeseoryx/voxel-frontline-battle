from PIL import Image
import os

BASE = r"F:\voxel-frontline-battle\tmp\weapon-ocr"
WEAPONS = [
    "M249",
    "M4A1",
    "M9",
    "MG36",
    "MK14EBR",
    "MK20",
    "MP443",
    "MP5",
    "MP7",
    "MSR",
]


def find_right_clusters(im, thresh=80, min_h=10, min_x=300):
    w, h = im.size
    ys = []
    for y in range(h):
        bright = [x for x in range(min_x, w) if im.getpixel((x, y)) > thresh]
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
    out = []
    for c in clusters:
        y0, y1 = c[0][0], c[-1][0]
        xmin = min(t[1] for t in c)
        xmax = max(t[2] for t in c)
        if (y1 - y0 + 1) >= min_h:
            out.append((xmin, y0, xmax + 1, y1 + 1))
    return out


for wpn in WEAPONS:
    im = Image.open(os.path.join(BASE, wpn + "-num.png")).convert("L")
    boxes = find_right_clusters(im)
    print(wpn, "n=", len(boxes), [(b[1], b[3], b[2] - b[0]) for b in boxes])
