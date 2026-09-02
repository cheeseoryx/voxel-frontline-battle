# -*- coding: utf-8 -*-
import importlib
import json
import os

import cv2
import numpy as np

import ocr_batch_p90pp2 as m

TH = 100
IDS = [
    "P90",
    "PP19",
    "PP2000",
    "REM700",
    "RPK16",
    "RSH12",
    "SCARH",
    "SCORPIONEVO",
    "SG550",
]


def holes(g, th=TH):
    bw = (g > th).astype(np.uint8)
    bw = np.pad(bw, 1)
    ff = bw.copy()
    mask = np.zeros((bw.shape[0] + 2, bw.shape[1] + 2), np.uint8)
    cv2.floodFill(ff, mask, (0, 0), 2)
    inv = (ff == 0).astype(np.uint8)
    n, lab = cv2.connectedComponents(inv)
    centers = []
    for i in range(1, n):
        ys, xs = np.where(lab == i)
        if len(ys):
            centers.append(float(ys.mean() / bw.shape[0]))
    return n - 1, centers


_, g3 = m.load_gray("G3")
_, gl = m.load_gray("GLOCK18")
templates = {
    "0": m.norm_glyph(m.get_glyph(g3, 1, 0)),
    "1": m.norm_glyph(m.get_glyph(g3, 3, 0)),
    "2": m.norm_glyph(m.get_glyph(g3, 4, 2)),
    "3": m.norm_glyph(m.get_glyph(g3, 0, 0)),
    "4": m.norm_glyph(m.get_glyph(g3, 14, 0)),
    "5": m.norm_glyph(m.get_glyph(g3, 8, 0)),
    "6": m.norm_glyph(m.get_glyph(g3, 9, 0)),
    "7": m.norm_glyph(m.get_glyph(g3, 0, 1)),
    "8": m.norm_glyph(m.get_glyph(g3, 2, 0)),
    "9": m.norm_glyph(m.get_glyph(gl, 0, 1)),
}


def classify(g):
    if g.shape[0] <= 8 and g.shape[1] <= 8:
        return ".", 1.0
    ng = m.norm_glyph(g)
    best, bs = "?", -1.0
    for k, t in templates.items():
        a, b = ng.ravel(), t.ravel()
        d = float(np.linalg.norm(a) * np.linalg.norm(b))
        sc = float(np.dot(a, b) / d) if d else 0.0
        if sc > bs:
            bs, best = sc, k
    if g.shape[1] <= 10 and g.shape[0] > 14:
        if float((g > TH)[:, : max(1, g.shape[1] // 2)].mean()) < 0.35:
            return "1", max(0.9, bs)
    return best, bs


def hole_adj(c, nh, cy):
    if nh >= 2:
        return "8"
    if nh == 1:
        cy0 = cy[0] if cy else 0.5
        if cy0 < 0.40:
            return "9"
        if cy0 > 0.58:
            return "6"
        return "0"
    if nh == 0 and c in ("6", "8", "0", "9"):
        # open digits: 5/3/2 already classified; 6 without hole is 5
        if c == "6":
            return "5"
        if c == "9":
            return "3"
        if c == "0":
            return "0"
    return c


def to_number(text):
    if not text or "?" in text:
        return None
    if "." in text:
        return float(text)
    return int(text)


out = {}
for wid in IDS:
    full, gray = m.load_gray(wid)
    bs = m.bands_of(gray)
    use = bs[:16] if len(bs) == 17 else bs
    print("====", wid, "n", len(bs))
    parsed = []
    for i, (y0, y1) in enumerate(use):
        gs = m.glyphs_in_row(gray, y0, y1)
        chars = []
        for g in gs:
            c, sc = classify(g)
            nh, cy = holes(g)
            adj = hole_adj(c, nh, cy)
            mark = "*" if adj != c else ""
            chars.append(adj)
            if mark:
                print(
                    "  row",
                    i,
                    "change",
                    c,
                    "->",
                    adj,
                    "nh",
                    nh,
                    "cy",
                    [round(x, 2) for x in cy],
                    "sc",
                    round(sc, 3),
                )
        raw = "".join(chars)
        parsed.append(to_number(raw))
        print(" ", i, raw)
    if len(bs) == 15 and parsed[2] is not None and parsed[2] < 3:
        parsed = parsed[:2] + [0.0] + parsed[2:]
        print("  inserted light 0")
    out[wid] = parsed

print(json.dumps(out, indent=2))
with open(r"F:\voxel-frontline-battle\tmp\ocr_p90pp_out\result3.json", "w") as f:
    json.dump(out, f, indent=2)
