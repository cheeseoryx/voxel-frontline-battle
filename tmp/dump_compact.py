# -*- coding: utf-8 -*-
import cv2
import numpy as np
import os

BASE = r"F:\voxel-frontline-battle\tmp\weapon-ocr"
OUT = r"F:\voxel-frontline-battle\tmp\weapon-ocr-ascii\compact_M.txt"
IDS = ["M249","M4A1","M9","MG36","MK14EBR","MK20","MP443","MP5","MP7","MSR"]


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
    crop = gray[max(0, y0):min(h, y1), :]
    xs = np.where(crop.max(axis=0) > th)[0]
    if len(xs) == 0:
        return crop
    return crop[:, max(0, int(xs[0]) - 2):min(w, int(xs[-1]) + 3)]


def ascii_row(crop, th=140, xstep=1, ystep=1):
    lines = []
    for y in range(0, crop.shape[0], ystep):
        lines.append("".join("#" if crop[y, x] > th else " " for x in range(0, crop.shape[1], xstep)).rstrip())
    return "\n".join(lines)

out = []
for wid in IDS:
    gray = load_gray(wid)
    bands = bands_of(gray)
    out.append("=" * 72)
    out.append(wid)
    for i, (y0, y1) in enumerate(bands):
        crop = crop_row(gray, y0 - 2, y1 + 2)
        out.append("\n-- %s[%d] y=%d %dx%d --" % (wid, i, y0, crop.shape[1], crop.shape[0]))
        out.append(ascii_row(crop, ystep=1, xstep=1))

with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(out))
print("wrote", OUT, "chars", sum(len(x) for x in out))
