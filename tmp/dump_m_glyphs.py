# -*- coding: utf-8 -*-
import cv2
import numpy as np
import os

BASE = r"F:\voxel-frontline-battle\tmp\weapon-ocr"
OUT = r"F:\voxel-frontline-battle\tmp\weapon-ocr-ascii"
os.makedirs(OUT, exist_ok=True)

IDS = [
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


def load_gray(wid):
    im = cv2.imread(os.path.join(BASE, wid + "-num.png"), cv2.IMREAD_COLOR)
    return cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)


def bands_of(gray, th=80):
    h = gray.shape[0]
    row_has = gray.max(axis=1) > th
    bands = []
    inb = False
    s = 0
    for i, v in enumerate(row_has):
        if v and not inb:
            s = i
            inb = True
        elif not v and inb:
            bands.append((s, i))
            inb = False
    if inb:
        bands.append((s, h))
    return [(a, b) for a, b in bands if b - a >= 10]


def crop_row(gray, y0, y1, th=80):
    h, w = gray.shape
    crop = gray[max(0, y0) : min(h, y1), :]
    xs = np.where(crop.max(axis=0) > th)[0]
    if len(xs) == 0:
        return crop
    return crop[:, max(0, int(xs[0]) - 2) : min(w, int(xs[-1]) + 3)]


def split_glyphs(crop, th=120):
    col_has = crop.max(axis=0) > th
    glyphs = []
    inb = False
    s = 0
    for i, v in enumerate(col_has):
        if v and not inb:
            s = i
            inb = True
        elif not v and inb:
            glyphs.append((s, i))
            inb = False
    if inb:
        glyphs.append((s, crop.shape[1]))
    merged = []
    for g in glyphs:
        if merged and g[0] - merged[-1][1] <= 1:
            merged[-1] = (merged[-1][0], g[1])
        else:
            merged.append(g)
    out = []
    for x0, x1 in merged:
        g = crop[:, x0:x1]
        ys = np.where(g.max(axis=1) > th)[0]
        if len(ys) == 0:
            continue
        out.append(g[ys[0] : ys[-1] + 1, :])
    return out


def ascii_g(g, th=140):
    lines = []
    for y in range(g.shape[0]):
        lines.append("".join("#" if g[y, x] > th else "." for x in range(g.shape[1])))
    return "\n".join(lines)


lines = []
for wid in IDS:
    gray = load_gray(wid)
    bands = bands_of(gray)
    lines.append("=" * 70)
    lines.append("%s n=%d" % (wid, len(bands)))
    for i, (y0, y1) in enumerate(bands):
        crop = crop_row(gray, y0 - 2, y1 + 2)
        glyphs = split_glyphs(crop)
        lines.append(
            "\n--- %s row %d y=%d ng=%d ws=%s ---"
            % (wid, i, y0, len(glyphs), [g.shape[1] for g in glyphs])
        )
        for gi, g in enumerate(glyphs):
            lines.append("  [%d] %dx%d" % (gi, g.shape[1], g.shape[0]))
            lines.append(ascii_g(g))
            lines.append("")

path = os.path.join(OUT, "batch_M_ascii.txt")
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print("wrote", path, "lines", len(lines))
