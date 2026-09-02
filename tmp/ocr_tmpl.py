# -*- coding: utf-8 -*-
import cv2
import numpy as np
import os
import json

BASE = r"F:\voxel-frontline-battle\tmp\weapon-ocr"
OUT = r"F:\voxel-frontline-battle\tmp\weapon-ocr-ascii"
IDS = [
    "G3", "G36C", "GLOCK18", "GROZA", "HK419",
    "HONEYBADGER", "L86A1", "L96", "M110", "M200",
]
TH = 100
TW, THGT = 16, 24


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


def split_x(crop, th=TH):
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
    return merged


def trim(g, th=TH):
    ys = np.where(g.max(axis=1) > th)[0]
    xs = np.where(g.max(axis=0) > th)[0]
    if len(ys) == 0 or len(xs) == 0:
        return g
    return g[ys[0]:ys[-1] + 1, xs[0]:xs[-1] + 1]


def maybe_split_wide(g, th=TH):
    """Split a merged two-digit blob on a column-sum valley."""
    g = trim(g, th)
    if g.shape[1] < 22:
        return [g]
    col = (g > th).sum(axis=0).astype(np.float64)
    # ignore margins
    m = 4
    if g.shape[1] <= 2 * m + 3:
        return [g]
    mid = col[m:-m]
    # prefer valley near center
    idx = int(np.argmin(mid)) + m
    if col[idx] <= max(2, col.max() * 0.25) and 6 <= idx <= g.shape[1] - 6:
        left = trim(g[:, :idx], th)
        right = trim(g[:, idx + 1 :], th)
        if left.size and right.size and left.shape[1] >= 4 and right.shape[1] >= 4:
            return [left, right]
    return [g]


def glyphs_in_row(gray, y0, y1):
    crop = crop_row(gray, y0 - 2, y1 + 2)
    boxes = split_x(crop)
    out = []
    for x0, x1 in boxes:
        g = trim(crop[:, x0:x1])
        if g.size == 0:
            continue
        if g.shape[0] <= 8 and g.shape[1] <= 8:
            out.append(g)
            continue
        out.extend(maybe_split_wide(g))
    return out


def norm_glyph(g):
    bw = (g > TH).astype(np.float32)
    return cv2.resize(bw, (TW, THGT), interpolation=cv2.INTER_AREA)


def get_glyph(gray, row_i, glyph_i):
    bs = bands_of(gray)
    y0, y1 = bs[row_i]
    gs = glyphs_in_row(gray, y0, y1)
    return gs[glyph_i]


def main():
    g3 = load_gray("G3")
    gl = load_gray("GLOCK18")
    templates = {
        "0": norm_glyph(get_glyph(g3, 1, 0)),
        "1": norm_glyph(get_glyph(g3, 3, 0)),
        "2": norm_glyph(get_glyph(g3, 4, 2)),
        "3": norm_glyph(get_glyph(g3, 0, 0)),
        "4": norm_glyph(get_glyph(g3, 14, 0)),
        "5": norm_glyph(get_glyph(g3, 8, 0)),
        "6": norm_glyph(get_glyph(g3, 9, 0)),
        "7": norm_glyph(get_glyph(g3, 0, 1)),
        "8": norm_glyph(get_glyph(g3, 2, 0)),
        "9": norm_glyph(get_glyph(gl, 0, 1)),  # 19.00
    }

    def classify(g):
        if g.shape[0] <= 8 and g.shape[1] <= 8:
            return ".", 1.0
        if g.shape[1] <= 10 and g.shape[0] > 14:
            # thin -> 1, but 7 is wider
            pass
        ng = norm_glyph(g)
        best, bs = "?", -1
        for k, t in templates.items():
            # cosine similarity
            a = ng.ravel()
            b = t.ravel()
            denom = np.linalg.norm(a) * np.linalg.norm(b)
            sc = float(np.dot(a, b) / denom) if denom else 0
            if sc > bs:
                bs = sc
                best = k
        # aspect override for 1
        if g.shape[1] <= 10 and best in ("1", "7"):
            if g.shape[1] <= 10 and (g > TH)[:, : g.shape[1] // 2].mean() < 0.35:
                best = "1"
        return best, bs

    results = {}
    lines = []
    for wid in IDS:
        gray = load_gray(wid)
        bs = bands_of(gray)
        rows = []
        lines.append("=" * 50 + " " + wid + " n=" + str(len(bs)))
        for i, (y0, y1) in enumerate(bs):
            gs = glyphs_in_row(gray, y0, y1)
            chars = []
            scores = []
            for g in gs:
                c, sc = classify(g)
                chars.append(c)
                scores.append(round(sc, 3))
            raw = "".join(chars)
            rows.append({"i": i, "y": y0, "raw": raw, "chars": chars, "scores": scores, "ws": [int(g.shape[1]) for g in gs]})
            flag = ""
            if any(s < 0.88 for s in scores if s < 1):
                flag = " LOW"
            lines.append("[%d] y=%d %s %s ws=%s sc=%s%s" % (i, y0, raw, chars, [int(g.shape[1]) for g in gs], scores, flag))
        results[wid] = rows

    with open(os.path.join(OUT, "tmpl.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    with open(os.path.join(OUT, "tmpl.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
