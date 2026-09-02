# -*- coding: utf-8 -*-
"""OCR P90..SG550 number columns via P90-labeled template matching."""
from __future__ import annotations

import json
import os
from collections import defaultdict

import numpy as np
from PIL import Image

THRESH = 80
DIR = r"F:\voxel-frontline-battle\tmp\weapon-ocr"
OUT = r"F:\voxel-frontline-battle\tmp\ocr_p90pp_out"
os.makedirs(OUT, exist_ok=True)
TW, TH = 14, 20
MIN_X = 280

# P90 labels verified from glyph ASCII + fandom inspect-panel dump
P90_LABELS = {
    0: "28.00",
    1: "0.00",
    2: "8.00",
    3: "0.80",
    4: "1.40",
    5: "1.00",
    6: "390.00",
    7: "74.75",
    8: "800",
    9: "600",
    10: "0.84",
    11: "0.94",
    12: "0.20",
    13: "1.05",
    14: "3.83",
    15: "1.00",
}

NAMES = [
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


def load_gray(path):
    im = Image.open(path).convert("L")
    arr = np.array(im)
    return im, arr


def find_bands(arr, min_x=MIN_X, th=THRESH, min_h=12):
    h, w = arr.shape
    row_has = arr[:, min_x:].max(axis=1) > th
    bands = []
    on = False
    s = 0
    for i, v in enumerate(row_has):
        if v and not on:
            s = i
            on = True
        elif not v and on:
            if i - s >= min_h:
                bands.append((s, i))
            on = False
    if on and h - s >= min_h:
        bands.append((s, h))
    return bands


def _split_wide_run(sl, x0, x1, th=THRESH):
    """Split a wide blob on column-ink valleys (touching digits)."""
    width = x1 - x0
    if width < 22:
        return [(x0, x1)]
    ink = sl[:, x0:x1].sum(axis=0).astype(np.float32)
    # expected digit ~15px; how many digits?
    n = max(2, int(round(width / 16.0)))
    # search valleys near k*width/n
    cuts = [x0]
    for k in range(1, n):
        target = int(x0 + k * width / n)
        lo = max(x0 + 4, target - 5)
        hi = min(x1 - 4, target + 6)
        if hi <= lo:
            continue
        window = ink[lo - x0 : hi - x0]
        valley = lo + int(np.argmin(window))
        if valley > cuts[-1] + 6:
            cuts.append(valley)
    cuts.append(x1)
    out = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a >= 2:
            out.append((a, b))
    return out if out else [(x0, x1)]


def find_glyphs(arr, y0, y1, min_x=MIN_X, th=THRESH):
    h, w = arr.shape
    sl = arr[y0:y1, :]
    col_has = sl.max(axis=0) > th
    runs = []
    on = False
    s = 0
    for x, v in enumerate(col_has):
        if x < min_x:
            continue
        if v and not on:
            s = x
            on = True
        elif not v and on:
            if x - s >= 1:
                runs.append((s, x))
            on = False
    if on:
        runs.append((s, w))
    split_runs = []
    for a, b in runs:
        split_runs.extend(_split_wide_run(sl, a, b, th))
    glyphs = []
    for x0, x1 in split_runs:
        g = sl[:, x0:x1]
        ys = np.where(g.max(axis=1) > th)[0]
        if len(ys) == 0:
            continue
        gy0, gy1 = int(ys[0]), int(ys[-1]) + 1
        glyphs.append((x0, x1, y0 + gy0, y0 + gy1, g[gy0:gy1]))
    return glyphs


def raster(g, tw=TW, th=TH):
    g = (g > THRESH).astype(np.float32)
    # resize nearest
    h, w = g.shape
    out = np.zeros((th, tw), np.float32)
    for j in range(th):
        y = min(h - 1, int((j + 0.5) * h / th))
        for i in range(tw):
            x = min(w - 1, int((i + 0.5) * w / tw))
            out[j, i] = g[y, x]
    return out


def ncc(a, b):
    a = a.ravel()
    b = b.ravel()
    a = a - a.mean()
    b = b - b.mean()
    da = np.linalg.norm(a)
    db = np.linalg.norm(b)
    if da < 1e-6 or db < 1e-6:
        return 0.0
    return float(np.dot(a, b) / (da * db))


def ascii_g(g, th=THRESH, sx=1, sy=1):
    lines = []
    for y in range(0, g.shape[0], sy):
        lines.append("".join("#" if g[y, x] > th else "." for x in range(0, g.shape[1], sx)))
    return "\n".join(lines)


def build_templates(arr, bands):
    templates = defaultdict(list)
    for ri, text in P90_LABELS.items():
        y0, y1 = bands[ri]
        gs = find_glyphs(arr, y0, y1)
        chars = list(text)
        # glyphs should match chars including '.'
        if len(gs) != len(chars):
            raise SystemExit("P90 glyph/label mismatch row %d %s n=%d" % (ri, text, len(gs)))
        for ginfo, ch in zip(gs, chars):
            if ch == ".":
                continue
            templates[ch].append(raster(ginfo[4]))
    return templates


def match_glyph(ginfo, templates):
    x0, x1, gy0, gy1, g = ginfo
    w = x1 - x0
    h = gy1 - gy0
    if w <= 5 or (h <= 8 and w <= 8):
        return ".", 1.0, {}
    r = raster(g)
    scores = {}
    best, bests = "?", -1.0
    for lab, tlist in templates.items():
        sc = max(ncc(r, t) for t in tlist)
        scores[lab] = sc
        if sc > bests:
            bests = sc
            best = lab
    # width prior for 1
    if w <= 9 and scores.get("1", 0) > 0.75:
        return "1", scores["1"], scores
    return best, bests, scores


def parse_row(arr, y0, y1, templates):
    gs = find_glyphs(arr, y0, y1)
    chars = []
    scores = []
    all_scores = []
    for g in gs:
        lab, sc, scs = match_glyph(g, templates)
        chars.append(lab)
        scores.append(sc)
        all_scores.append(scs)
    return "".join(chars), chars, gs, scores, all_scores


def to_number(text):
    if not text or "?" in text or text == ".":
        return None
    if text.count(".") > 1:
        return None
    if "." in text:
        return float(text)
    return int(text)


def pick_bands(arr, name):
    bands = find_bands(arr)
    # drop tiny junk on the far left already excluded by MIN_X
    # snipers: 17 rows, last is bolt-action — keep first 16
    if len(bands) == 17:
        return bands[:16], bands, "drop-last-of-17"
    if len(bands) == 16:
        return bands, bands, "ok-16"
    if len(bands) == 15:
        return bands, bands, "only-15"
    return bands, bands, "unexpected-%d" % len(bands)


def main():
    p90_path = os.path.join(DIR, "P90-num.png")
    _, p90 = load_gray(p90_path)
    p90_bands = find_bands(p90)
    assert len(p90_bands) == 16, p90_bands
    templates = build_templates(p90, p90_bands)

    report = []
    out = {}
    for name in NAMES:
        path = os.path.join(DIR, name + "-num.png")
        _, arr = load_gray(path)
        use, raw_bands, note = pick_bands(arr, name)
        report.append("=" * 72)
        report.append("%s bands=%d note=%s raw=%s" % (name, len(raw_bands), note, raw_bands))
        nums = []
        for i, (y0, y1) in enumerate(use):
            text, chars, gs, scores, all_scores = parse_row(arr, y0, y1, templates)
            minsc = min(scores) if scores else 0.0
            n = to_number(text)
            nums.append(n)
            # second best
            seconds = []
            for scs in all_scores:
                if not scs:
                    seconds.append(None)
                    continue
                items = sorted(scs.items(), key=lambda kv: -kv[1])
                seconds.append(items[:3])
            flag = " LOW" if minsc < 0.88 else ""
            line = "[%02d] y=%d-%d %s min=%.3f%s n=%s" % (i + 1, y0, y1, text, minsc, flag, n)
            report.append(line)
            if minsc < 0.92 or "?" in text:
                for gi, g in enumerate(gs):
                    report.append("  glyph%d %dx%d -> %s sc=%.3f top=%s" % (
                        gi, g[1] - g[0], g[3] - g[2], chars[gi], scores[gi], seconds[gi]
                    ))
                    report.append(ascii_g(g[4]))
        out[name] = nums
        report.append("ARRAY " + json.dumps(nums))

    json_path = os.path.join(OUT, "result.json")
    txt_path = os.path.join(OUT, "report.txt")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(report))
    print("wrote", json_path, txt_path)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
