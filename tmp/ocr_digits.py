# -*- coding: utf-8 -*-
import cv2
import numpy as np
import os
import json

BASE = r"F:\voxel-frontline-battle\tmp\weapon-ocr"
OUT = r"F:\voxel-frontline-battle\tmp\weapon-ocr-ascii"
os.makedirs(OUT, exist_ok=True)

IDS = [
    "G3",
    "G36C",
    "GLOCK18",
    "GROZA",
    "HK419",
    "HONEYBADGER",
    "L86A1",
    "L96",
    "M110",
    "M200",
]

# Canonical 16-row starts for the common (non-sniper) crop
CANON_Y = [473, 517, 561, 619, 663, 707, 765, 823, 867, 911, 955, 1013, 1057, 1101, 1145, 1189]


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
    return bands


def crop_row(gray, y0, y1, th=80):
    h, w = gray.shape
    y0 = max(0, y0)
    y1 = min(h, y1)
    crop = gray[y0:y1, :]
    if crop.size == 0:
        return crop
    xs = np.where(crop.max(axis=0) > th)[0]
    if len(xs) == 0:
        return crop
    x0 = max(0, int(xs[0]) - 2)
    x1 = min(w, int(xs[-1]) + 3)
    return crop[:, x0:x1]


def split_glyphs(crop, th=120):
    """Split a row crop into glyph images by x-gaps in bright pixels."""
    if crop.size == 0 or crop.max() < th:
        return []
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
    # merge tiny gaps (1px) that split a digit
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
        g = g[ys[0] : ys[-1] + 1, :]
        out.append(g)
    return out


def classify_digit(g, th=120):
    """Classify a glyph as 0-9 or '.' using geometry."""
    h, w = g.shape
    if h < 6 or w <= 3:
        # decimal point or noise
        if h <= 8 and w <= 8:
            return "."
        # thin 1
    bw = (g > th).astype(np.uint8)
    # pad
    bw = np.pad(bw, ((1, 1), (1, 1)))
    h, w = bw.shape
    aspect = w / max(h, 1)
    fill = bw.mean()
    # split into 3 vertical thirds and 3 horizontal thirds
    ys = [0, h // 3, 2 * h // 3, h]
    xs = [0, w // 3, 2 * w // 3, w]
    cells = []
    for i in range(3):
        row = []
        for j in range(3):
            cell = bw[ys[i] : ys[i + 1], xs[j] : xs[j + 1]]
            row.append(cell.mean() if cell.size else 0)
        cells.append(row)
    # holes via flood fill from border
    holes = bw.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    ff = holes.copy()
    cv2.floodFill(ff, mask, (0, 0), 2)
    n_holes = 0
    inv = (ff == 0).astype(np.uint8)
    n_labels, _ = cv2.connectedComponents(inv)
    n_holes = max(0, n_labels - 1)

    # projections
    top = bw[: max(h // 5, 1), :].mean()
    bot = bw[-max(h // 5, 1) :, :].mean()
    mid_y = bw[h // 2 - 1 : h // 2 + 2, :].mean() if h > 4 else 0
    left = bw[:, : max(w // 4, 1)].mean()
    right = bw[:, -max(w // 4, 1) :].mean()
    mid_x = bw[:, w // 2 - 1 : w // 2 + 2].mean() if w > 4 else 0
    upper_left = cells[0][0]
    upper_right = cells[0][2]
    mid_left = cells[1][0]
    mid_right = cells[1][2]
    lower_left = cells[2][0]
    lower_right = cells[2][2]
    upper_mid = cells[0][1]
    mid_mid = cells[1][1]
    lower_mid = cells[2][1]

    # decimal
    if h < 10 and w < 10:
        return "."

    # 1: very thin
    if aspect < 0.38 and right > 0.3 and left < 0.55:
        # could still be 7 if top bar is wide - but thin overall
        if top < 0.55 or w < 12:
            return "1"

    # 8: two holes
    if n_holes >= 2:
        return "8"

    # 0: one hole, little mid bar (mid_mid not too high relative to sides), left and right strong all the way
    # 4: one hole in upper-right-ish, open top, strong right, mid bar
    # 6: one hole in bottom, left strong, upper right weaker
    # 9: one hole in top, right strong, lower left weaker
    # 4 sometimes no hole if the triangle isn't closed

    if n_holes == 1:
        # location of hole
        hole_mask = inv
        ys_h, xs_h = np.where(hole_mask > 0)
        cy = ys_h.mean() / h if len(ys_h) else 0.5
        # 0: hole centered, left & right both strong top-to-bottom, mid_mid low-ish
        if 0.35 < cy < 0.65 and left > 0.45 and right > 0.45 and mid_left > 0.35 and mid_right > 0.35:
            # 8 already handled; 0 vs 4: 4 has empty upper-left
            if upper_left < 0.25 and mid_mid > 0.4:
                return "4"
            return "0"
        if cy < 0.48:
            # hole on top: 9 or 4 or 0
            if lower_left < 0.28 and right > 0.4:
                return "9"
            if upper_left < 0.28:
                return "4"
            return "9" if lower_left < lower_right else "0"
        else:
            # hole on bottom: 6 or 0
            if upper_right < 0.35 or mid_right < 0.28:
                return "6"
            return "6" if upper_right < 0.45 else "0"

    # no holes: 1,2,3,4,5,7 (sometimes 4/6/9/0 if open)
    # 7: strong top, diagonal, weak left, weak bottom
    # 2: strong top, weak mid-left, strong lower-left, strong bottom, weak lower-right-upper
    # 3: strong top, weak left, strong right, two bumps, strong bottom
    # 5: strong top, strong upper-left, strong mid, weak lower-left, strong bottom
    # 4: strong right, mid bar, weak top-mid, weak upper-left maybe

    # 4 open: right stem + crossbar, often wide
    if right > 0.5 and mid_mid > 0.35 and upper_mid < 0.35 and lower_left > 0.25 and top < 0.45:
        return "4"

    # 7
    if top > 0.45 and lower_left < 0.22 and mid_left < 0.25 and bot < 0.4 and right > 0.25:
        return "7"

    # 3: weak left, strong right, strong top and bottom
    if mid_left < 0.28 and right > 0.35 and top > 0.4 and bot > 0.4 and lower_left < 0.4:
        # 3 vs 7 vs 2: 2 has strong lower_left
        if lower_left > 0.42 and mid_mid < 0.45:
            return "2"
        return "3"

    # 2: top bar, open upper-left after top (upper_left medium), open mid-left, strong lower-left, strong bottom, weak lower-right in mid
    if top > 0.4 and bot > 0.4 and mid_left < 0.3 and lower_left > 0.35:
        return "2"

    # 5: top, upper left, mid bar, open lower left, bottom
    if top > 0.4 and upper_left > 0.3 and mid_mid > 0.3 and lower_left < 0.3 and bot > 0.35:
        return "5"

    # 4 fallback: left of upper empty, crossbar, right stem
    if upper_left < 0.22 and right > 0.4 and (mid_mid > 0.3 or cells[1][1] > 0.3):
        return "4"

    # 6 fallback no hole: left strong, bottom strong, upper right weak
    if left > 0.4 and bot > 0.4 and upper_right < 0.3 and lower_right > 0.3:
        return "6"

    # 9 fallback
    if right > 0.4 and top > 0.4 and lower_left < 0.28 and upper_left > 0.3:
        return "9"

    # 0 fallback
    if left > 0.4 and right > 0.4 and top > 0.35 and bot > 0.35:
        return "0"

    # 1 fallback
    if aspect < 0.5:
        return "1"

    # dump features for unknown
    return "?"


def glyphs_to_number(glyphs):
    chars = [classify_digit(g) for g in glyphs]
    # merge: if a tiny glyph classified as 1 next to others, keep
    s = "".join(chars)
    return s, chars


def ascii_glyph(g, th=140, xstep=1):
    lines = []
    for y in range(g.shape[0]):
        row = "".join("#" if g[y, x] > th else "." for x in range(0, g.shape[1], xstep))
        lines.append(row)
    return "\n".join(lines)


def main():
    report = []
    results = {}
    for wid in IDS:
        gray = load_gray(wid)
        report.append("=" * 60)
        report.append(wid + " shape=%s max=%d" % (gray.shape, int(gray.max())))
        # GLOCK top
        if wid == "GLOCK18":
            report.append("GLOCK y0-520 max-per-20:")
            for y0 in range(0, 530, 20):
                sl = gray[y0 : y0 + 20]
                report.append("  y=%d max=%d mean=%.1f" % (y0, int(sl.max()), float(sl.mean())))
        bands = [(a, b) for a, b in bands_of(gray) if b - a >= 10]
        report.append("bands ge10: %s" % [(a, b) for a, b in bands])

        # choose rows
        if wid in ("L96", "M200"):
            row_bands = bands  # may be 17
        elif wid == "GLOCK18":
            row_bands = bands
        else:
            row_bands = bands

        parsed = []
        for i, (y0, y1) in enumerate(row_bands):
            crop = crop_row(gray, y0 - 2, y1 + 2)
            glyphs = split_glyphs(crop)
            s, chars = glyphs_to_number(glyphs)
            parsed.append({"i": i, "y": y0, "raw": s, "chars": chars, "n": len(glyphs), "ws": [g.shape[1] for g in glyphs], "hs": [g.shape[0] for g in glyphs]})
            report.append("[%d] y=%d n=%d raw=%s ws=%s" % (i, y0, len(glyphs), s, [g.shape[1] for g in glyphs]))
            # small ascii of each glyph header
            for gi, g in enumerate(glyphs):
                report.append("  glyph%d %dx%d -> %s" % (gi, g.shape[1], g.shape[0], chars[gi]))
        results[wid] = parsed

        # also parse using CANON_Y for non-snipers
        if wid not in ("L96", "M200"):
            report.append("-- canon y --")
            for i, y in enumerate(CANON_Y):
                crop = crop_row(gray, y - 2, y + 24)
                glyphs = split_glyphs(crop)
                s, chars = glyphs_to_number(glyphs)
                report.append("  canon[%d] y=%d n=%d raw=%s ws=%s chars=%s" % (i, y, len(glyphs), s, [g.shape[1] for g in glyphs], chars))

    with open(os.path.join(OUT, "ocr_report.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(report))
    with open(os.path.join(OUT, "ocr_raw.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print("wrote report", len(report), "lines")


if __name__ == "__main__":
    main()
