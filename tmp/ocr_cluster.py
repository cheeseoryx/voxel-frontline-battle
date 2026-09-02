from PIL import Image
import os
from collections import defaultdict

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


def components(binary, w, h):
    vis = [[False] * w for _ in range(h)]
    comps = []
    for y in range(h):
        for x in range(w):
            if binary[y][x] and not vis[y][x]:
                stack = [(x, y)]
                vis[y][x] = True
                pts = []
                while stack:
                    cx, cy = stack.pop()
                    pts.append((cx, cy))
                    for dx, dy in (
                        (1, 0),
                        (-1, 0),
                        (0, 1),
                        (0, -1),
                        (1, 1),
                        (1, -1),
                        (-1, 1),
                        (-1, -1),
                    ):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < w and 0 <= ny < h and binary[ny][nx] and not vis[ny][nx]:
                            vis[ny][nx] = True
                            stack.append((nx, ny))
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
                comps.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1, pts))
    comps.sort(key=lambda c: c[0])
    return comps


def glyph_bitmap(c, tw=12, th=16):
    x0, y0, x1, y1, pts = c
    bw = max(1, x1 - x0)
    bh = max(1, y1 - y0)
    grid = [[0] * tw for _ in range(th)]
    for x, y in pts:
        gx = min(tw - 1, int((x - x0) * tw / bw))
        gy = min(th - 1, int((y - y0) * th / bh))
        grid[gy][gx] = 1
    return tuple(tuple(row) for row in grid)


def ascii_bit(bit):
    return "\n".join("".join("#" if v else "." for v in row) for row in bit)


def extract_glyphs(path):
    im = Image.open(path).convert("L")
    boxes = find_right_clusters(im)
    rows = []
    for box in boxes:
        x0, y0, x1, y1 = box
        pad = 2
        crop = im.crop((max(0, x0 - pad), max(0, y0 - pad), x1 + pad, y1 + pad))
        cw, ch = crop.size
        binary = [[crop.getpixel((x, y)) > 80 for x in range(cw)] for y in range(ch)]
        comps = [c for c in components(binary, cw, ch) if len(c[4]) >= 4]
        glyphs = []
        for c in comps:
            bw = c[2] - c[0]
            bh = c[3] - c[1]
            if bh <= 8 and bw <= 8:
                kind = "dot"
            elif len(c[4]) < 15 and bh < 10:
                kind = "dot"
            else:
                kind = "digit"
            glyphs.append({"kind": kind, "bbox": c[0:4], "n": len(c[4]), "bit": glyph_bitmap(c) if kind == "digit" else None, "aspect": bw / max(1, bh)})
        rows.append(glyphs)
    return rows


# cluster digit bitmaps by exact/near match
def hamming(a, b):
    s = 0
    for ra, rb in zip(a, b):
        for va, vb in zip(ra, rb):
            if va != vb:
                s += 1
    return s


all_digits = []
for wpn in WEAPONS:
    rows = extract_glyphs(os.path.join(BASE, wpn + "-num.png"))
    for ri, glyphs in enumerate(rows):
        for gi, g in enumerate(glyphs):
            if g["kind"] == "digit":
                all_digits.append((wpn, ri, gi, g))

# greedy cluster
clusters = []  # list of (prototype, members)
for item in all_digits:
    bit = item[3]["bit"]
    best = None
    best_d = 999
    for i, (proto, members) in enumerate(clusters):
        d = hamming(bit, proto)
        if d < best_d:
            best_d = d
            best = i
    if best is not None and best_d <= 18:
        clusters[best][1].append(item)
    else:
        clusters.append([bit, [item]])

print("clusters", len(clusters), "digits", len(all_digits))
clusters.sort(key=lambda c: -len(c[1]))
for i, (proto, members) in enumerate(clusters):
    print("=" * 20, "cluster", i, "n=", len(members), "ex", members[0][:3], "aspect", members[0][3]["aspect"])
    print(ascii_bit(proto))
    print("members", [(m[0], m[1] + 1, m[2]) for m in members[:12]])
