# -*- coding: utf-8 -*-
"""OCR P90-SG550 using G3/GLOCK18 digit templates."""
from __future__ import annotations

import json
import os

import cv2
import numpy as np

BASE = r"F:\voxel-frontline-battle\tmp\weapon-ocr"
OUT = r"F:\voxel-frontline-battle\tmp\ocr_p90pp_out"
os.makedirs(OUT, exist_ok=True)

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
TH = 100
TW, THGT = 16, 24
MIN_X = 300


def load_gray(wid):
    im = cv2.imread(os.path.join(BASE, wid + "-num.png"), cv2.IMREAD_COLOR)
    gray = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    # ignore left UI chrome
    g = gray.copy()
    g[:, :MIN_X] = 0
    return gray, g


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
    return g[ys[0] : ys[-1] + 1, xs[0] : xs[-1] + 1]


def maybe_split_wide(g, th=TH):
    g = trim(g, th)
    if g.shape[1] < 22:
        return [g]
    col = (g > th).sum(axis=0).astype(np.float64)
    m = 4
    if g.shape[1] <= 2 * m + 3:
        return [g]
    mid = col[m:-m]
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


def ascii_g(g, th=TH):
    lines = []
    for y in range(g.shape[0]):
        lines.append("".join("#" if g[y, x] > th else "." for x in range(g.shape[1])))
    return "\n".join(lines)


def get_glyph(gray, row_i, glyph_i):
    bs = bands_of(gray)
    y0, y1 = bs[row_i]
    gs = glyphs_in_row(gray, y0, y1)
    return gs[glyph_i]


def to_number(text):
    if not text or "?" in text:
        return None
    if text.count(".") > 1:
        return None
    if "." in text:
        return float(text)
    return int(text)


def main():
    _, g3 = load_gray("G3")
    _, gl = load_gray("GLOCK18")
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
        "9": norm_glyph(get_glyph(gl, 0, 1)),
    }

    def classify(g):
        if g.shape[0] <= 8 and g.shape[1] <= 8:
            return ".", 1.0, {}
        ng = norm_glyph(g)
        scores = {}
        best, bs = "?", -1.0
        for k, t in templates.items():
            a = ng.ravel()
            b = t.ravel()
            denom = float(np.linalg.norm(a) * np.linalg.norm(b))
            sc = float(np.dot(a, b) / denom) if denom else 0.0
            scores[k] = sc
            if sc > bs:
                bs = sc
                best = k
        if g.shape[1] <= 10 and g.shape[0] > 14:
            leftfill = float((g > TH)[:, : max(1, g.shape[1] // 2)].mean())
            if leftfill < 0.35:
                return "1", max(scores.get("1", 0), 0.9), scores
        return best, bs, scores

    report = []
    out = {}
    for wid in IDS:
        full, gray = load_gray(wid)
        bs = bands_of(gray)
        note = "n=%d" % len(bs)
        use = bs
        if len(bs) == 17:
            use = bs[:16]
            note += " drop-last-bolt"
        report.append("=" * 60 + " " + wid + " " + note + " " + str(bs))
        parsed = []
        for i, (y0, y1) in enumerate(use):
            gs = glyphs_in_row(gray, y0, y1)
            chars = []
            scores = []
            tops = []
            for g in gs:
                c, sc, scs = classify(g)
                chars.append(c)
                scores.append(sc)
                tops.append(sorted(scs.items(), key=lambda kv: -kv[1])[:3] if scs else None)
            raw = "".join(chars)
            n = to_number(raw)
            parsed.append(n)
            minsc = min(scores) if scores else 0
            flag = " LOW" if minsc < 0.88 else ""
            report.append(
                "[%d] y=%d %s n=%s min=%.3f ws=%s sc=%s%s"
                % (
                    i,
                    y0,
                    raw,
                    n,
                    minsc,
                    [int(g.shape[1]) for g in gs],
                    [round(s, 3) for s in scores],
                    flag,
                )
            )
            if minsc < 0.90 or "?" in raw:
                for gi, g in enumerate(gs):
                    report.append(
                        "  g%d %dx%d -> %s %.3f top=%s"
                        % (gi, g.shape[1], g.shape[0], chars[gi], scores[gi], tops[gi])
                    )
                    report.append(ascii_g(g))
        if len(bs) == 15:
            # SMG/pistol crops miss lightArmor row; values match damage, armor, then recoil...
            # Insert 0.00 at index 2 only when slot3 looks like recoil (<3) not armor damage.
            if parsed and parsed[2] is not None and parsed[2] < 3:
                parsed = parsed[:2] + [0.0] + parsed[2:]
                report.append("INSERTED lightArmor 0.00 -> 16")
            else:
                report.append("15 rows but slot3>=3, NOT inserting")
        out[wid] = parsed
        report.append("ARRAY " + json.dumps(parsed))

    with open(os.path.join(OUT, "result2.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    with open(os.path.join(OUT, "report2.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(report))
    print("\n".join(line for line in report if not line.startswith(" ") or "INSERTED" in line))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
