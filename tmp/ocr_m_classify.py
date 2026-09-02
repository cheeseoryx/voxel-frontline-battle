# -*- coding: utf-8 -*-
import cv2
import numpy as np
import os
import json

BASE = r"F:\voxel-frontline-battle\tmp\weapon-ocr"
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


def norm_bit(g, tw=12, th=16, t=120):
    bw = (g > t).astype(np.uint8)
    if bw.max() == 0:
        return np.zeros((th, tw), np.uint8)
    ys, xs = np.where(bw > 0)
    g2 = bw[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    return cv2.resize(g2, (tw, th), interpolation=cv2.INTER_NEAREST)


def holes(g, t=120):
    bw = (g > t).astype(np.uint8)
    bw = np.pad(bw, 1)
    h, w = bw.shape
    ff = bw.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(ff, mask, (0, 0), 2)
    inv = (ff == 0).astype(np.uint8)
    n, _ = cv2.connectedComponents(inv)
    return max(0, n - 1)


def classify(g, t=120):
    h, w = g.shape
    if h < 8 and w < 8:
        return "."
    aspect = w / max(h, 1)
    n_holes = holes(g, t)
    bw = (g > t).astype(np.uint8)
    fill = bw.mean()
    ys = [0, h // 3, 2 * h // 3, h]
    xs = [0, w // 3, 2 * w // 3, w]
    cells = []
    for i in range(3):
        row = []
        for j in range(3):
            cell = bw[ys[i] : ys[i + 1], xs[j] : xs[j + 1]]
            row.append(float(cell.mean()) if cell.size else 0.0)
        cells.append(row)
    top = bw[: max(h // 5, 1), :].mean()
    bot = bw[-max(h // 5, 1) :, :].mean()
    left = bw[:, : max(w // 4, 1)].mean()
    right = bw[:, -max(w // 4, 1) :].mean()
    ul, um, ur = cells[0]
    ml, mm, mr = cells[1]
    ll, lm, lr = cells[2]

    if aspect < 0.42:
        return "1"

    if n_holes >= 2:
        return "8"

    if n_holes == 1:
        hole_mask = None
        bw2 = np.pad((g > t).astype(np.uint8), 1)
        ff = bw2.copy()
        mask = np.zeros((bw2.shape[0] + 2, bw2.shape[1] + 2), np.uint8)
        cv2.floodFill(ff, mask, (0, 0), 2)
        inv = (ff == 0).astype(np.uint8)
        ys_h, xs_h = np.where(inv > 0)
        cy = ys_h.mean() / inv.shape[0] if len(ys_h) else 0.5
        # 4: empty upper-left, crossbar, right stem
        if ul < 0.28 and mm > 0.35 and right > 0.4 and ll > 0.2:
            return "4"
        if cy < 0.45:
            if ll < 0.30:
                return "9"
            return "0"
        if cy > 0.55:
            if ur < 0.40:
                return "6"
            return "0"
        if ul < 0.25 and mm > 0.35:
            return "4"
        if left > 0.45 and right > 0.45 and mm < 0.35:
            return "0"
        if ll < 0.28:
            return "9"
        if ur < 0.35:
            return "6"
        return "0"

    # no holes
    if top > 0.50 and ll < 0.22 and ml < 0.28 and bot < 0.42:
        return "7"
    if ul < 0.22 and right > 0.45 and mm > 0.30:
        return "4"
    if ml < 0.28 and right > 0.35 and top > 0.38 and bot > 0.38:
        if ll > 0.40:
            return "2"
        return "3"
    if top > 0.38 and bot > 0.38 and ml < 0.32 and ll > 0.35:
        return "2"
    if top > 0.40 and ul > 0.30 and mm > 0.28 and ll < 0.32 and bot > 0.35:
        return "5"
    if left > 0.4 and bot > 0.4 and ur < 0.32:
        return "6"
    if right > 0.4 and top > 0.4 and ll < 0.28:
        return "9"
    if left > 0.4 and right > 0.4 and top > 0.35 and bot > 0.35:
        return "0"
    return "?"


def parse_row(glyphs):
    chars = [classify(g) for g in glyphs]
    return "".join(chars), chars


for wid in IDS:
    gray = load_gray(wid)
    bands = bands_of(gray)
    print("====", wid, "n", len(bands))
    for i, (y0, y1) in enumerate(bands):
        crop = crop_row(gray, y0 - 2, y1 + 2)
        glyphs = split_glyphs(crop)
        s, chars = parse_row(glyphs)
        ws = [g.shape[1] for g in glyphs]
        hs = [g.shape[0] for g in glyphs]
        nh = [holes(g) for g in glyphs]
        print("  [%2d] y=%4d %8s  chars=%s ws=%s holes=%s" % (i, y0, s, chars, ws, nh))
