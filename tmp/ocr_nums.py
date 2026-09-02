"""OCR BattleBit inspect-panel number columns."""
from __future__ import annotations

import json
import os
from collections import defaultdict

from PIL import Image

THR = 80
X0 = 360
GW, GH = 8, 12
BASE = r"F:\voxel-frontline-battle\tmp\weapon-ocr"
WEAPONS = ["ACR", "SSG69", "SV98", "SVD", "ULTIMAX100", "UMP45", "UNICA", "USP", "VECTOR"]


def load_gray(name: str) -> Image.Image:
    return Image.open(os.path.join(BASE, name + "-num.png")).convert("L")


def text_bands(im: Image.Image, min_h: int = 10):
    w, h = im.size
    px = im.load()
    on = []
    for y in range(h):
        hit = False
        for x in range(X0, w):
            if px[x, y] > THR:
                hit = True
                break
        on.append(hit)
    out = []
    i = 0
    while i < h:
        if not on[i]:
            i += 1
            continue
        j = i
        while j < h and on[j]:
            j += 1
        if j - i >= min_h:
            out.append((i, j))
        i = j
    return out


def glyph_boxes(im: Image.Image, y0: int, y1: int):
    w, h = im.size
    px = im.load()
    cols = []
    for x in range(X0, w):
        hit = False
        for y in range(y0, y1):
            if px[x, y] > THR:
                hit = True
                break
        cols.append(hit)
    segs = []
    i = 0
    n = len(cols)
    while i < n:
        if not cols[i]:
            i += 1
            continue
        j = i
        while j < n and cols[j]:
            j += 1
        segs.append((X0 + i, X0 + j))
        i = j
    return segs


def tight(im: Image.Image, x0, x1, y0, y1):
    px = im.load()
    minx, maxx, miny, maxy = x1, x0, y1, y0
    for y in range(y0, y1):
        for x in range(x0, x1):
            if px[x, y] > THR:
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    if minx > maxx:
        return None
    return minx, maxx, miny, maxy


def grid_of(im: Image.Image, box):
    px = im.load()
    minx, maxx, miny, maxy = box
    bw = maxx - minx + 1
    bh = maxy - miny + 1
    g = []
    for gy in range(GH):
        row = []
        for gx in range(GW):
            sx = minx + gx * bw // GW
            sy = miny + gy * bh // GH
            row.append(px[sx, sy] > THR)
        g.append(row)
    return g, bw, bh


def ink(g, x0, x1, y0, y1):
    c = t = 0
    for y in range(max(0, y0), min(GH, y1)):
        for x in range(max(0, x0), min(GW, x1)):
            t += 1
            if g[y][x]:
                c += 1
    return c / t if t else 0.0


def holes(g):
    vis = [[False] * GW for _ in range(GH)]

    def bfs(sx, sy):
        q = [(sx, sy)]
        vis[sy][sx] = True
        cells = [(sx, sy)]
        while q:
            x, y = q.pop()
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < GW and 0 <= ny < GH and not vis[ny][nx] and not g[ny][nx]:
                    vis[ny][nx] = True
                    q.append((nx, ny))
                    cells.append((nx, ny))
        return cells

    for x in range(GW):
        if not g[0][x] and not vis[0][x]:
            bfs(x, 0)
        if not g[GH - 1][x] and not vis[GH - 1][x]:
            bfs(x, GH - 1)
    for y in range(GH):
        if not g[y][0] and not vis[y][0]:
            bfs(0, y)
        if not g[y][GW - 1] and not vis[y][GW - 1]:
            bfs(GW - 1, y)
    interiors = []
    for y in range(GH):
        for x in range(GW):
            if not g[y][x] and not vis[y][x]:
                interiors.append(bfs(x, y))
    return interiors


def feats(g):
    return {
        "A": ink(g, 2, 6, 0, 3),
        "D": ink(g, 2, 6, 9, 12),
        "G": ink(g, 2, 6, 5, 7),
        "F": ink(g, 0, 3, 2, 5),
        "B": ink(g, 5, 8, 2, 5),
        "E": ink(g, 0, 3, 8, 11),
        "C": ink(g, 5, 8, 8, 11),
        "bar4": ink(g, 0, 8, 8, 11),
        "left": ink(g, 0, 3, 0, 12),
        "right": ink(g, 5, 8, 0, 12),
    }


def parse_ascii(s):
    lines = [ln.rstrip() for ln in s.strip().splitlines() if ln.strip() != ""]
    g = []
    for ln in lines[:12]:
        ln = ln.strip()
        row = [(ch == "#") for ch in ln[:8].ljust(8, ".")]
        g.append(row)
    while len(g) < 12:
        g.append([False] * 8)
    return g


def add_t(lab, s, bag):
    bag.append((lab, parse_ascii(s)))


def build_templates():
    t = []
    add_t("0", """
..#####.
.#######
###...##
##.....#
##.....#
##.....#
##.....#
##.....#
##.....#
##.....#
###...##
.#######
""", t)
    add_t("0", """
..#####.
.######.
###...##
##....##
##....##
##....##
##....##
##....##
##....##
##....##
###...##
.######.
""", t)
    add_t("0", """
..#####.
.#######
###...##
###....#
###....#
###....#
###....#
###....#
###....#
###....#
###...##
.#######
""", t)
    add_t("2", """
..#####.
..######
.##...##
###....#
###....#
......##
.....##.
....###.
...###..
..###...
.###....
########
""", t)
    add_t("2", """
..#####.
.#######
###...##
##.....#
##.....#
......##
....###.
....###.
...###..
..##....
###.....
########
""", t)
    add_t("3", """
..#####.
.#######
###...##
##.....#
##.....#
....####
...#####
...#####
##.....#
##.....#
###...##
.#######
""", t)
    add_t("3", """
..#####.
.#######
###...##
###...##
###...##
....####
....####
....####
###...##
###...##
###...##
.#######
""", t)
    add_t("4", """
......##
......##
.....###
....####
...##.##
...##.##
..##..##
.##...##
.##...##
########
......##
......##
""", t)
    add_t("4", """
......#.
.....##.
....###.
....###.
...##.#.
..##..#.
.##...#.
.##...#.
##....#.
########
......#.
......#.
""", t)
    add_t("5", """
########
########
###.....
###.....
###.....
########
###...##
###....#
.......#
###....#
.##...##
..######
""", t)
    add_t("5", """
########
########
##......
##......
##......
#######.
###...##
##.....#
.......#
##.....#
##.....#
########
""", t)
    add_t("6", """
..#####.
.#######
###...##
##.....#
##......
#######.
########
###...##
##.....#
##.....#
###...##
.#######
""", t)
    add_t("6", """
..#####.
.#######
###...##
###...##
###.....
#######.
########
###...##
###...##
###...##
###...##
.#######
""", t)
    add_t("6", """
########
########
###.....
###.....
###.....
########
###...##
###....#
###....#
###....#
.##...##
..######
""", t)
    add_t("7", """
########
########
......##
......##
.....##.
.....##.
....##..
....##..
....##..
...##...
...##...
..##....
""", t)
    add_t("8", """
..#####.
.#######
###...##
##.....#
##.....#
.#######
.#######
########
##.....#
##.....#
###...##
.#######
""", t)
    add_t("8", """
..#####.
..######
.##...##
###....#
.##....#
....####
....####
....####
.##....#
###....#
.##...##
..######
""", t)
    add_t("8", """
..#####.
.#######
###...##
###....#
###....#
.#######
.#######
.#######
###....#
###....#
###...##
.#######
""", t)
    add_t("9", """
..#####.
..######
.##...##
###....#
###....#
###...##
.#######
..######
.......#
###....#
.##...##
..######
""", t)
    add_t("9", """
..#####.
.#######
###...##
##.....#
##.....#
##.....#
########
.#######
.......#
##.....#
###...##
.#######
""", t)
    add_t("9", """
..#####.
.######.
###...##
###...##
###...##
.#######
..######
......##
###...##
###...##
.#######
""", t)
    return t


TEMPLATES = build_templates()


def hamming_grid(a, b):
    n = 0
    for ra, rb in zip(a, b):
        for aa, bb in zip(ra, rb):
            if aa != bb:
                n += 1
    return n


def classify(g, bw):
    if bw <= 5:
        return "."
    if bw <= 11:
        return "1"
    f = feats(g)
    # 4 has almost no top bar
    if f["A"] < 0.28:
        return "4"
    # 7 has almost no left body
    if f["left"] < 0.30 and f["E"] < 0.30 and f["A"] > 0.55:
        return "7"
    best = "0"
    bestd = 10 ** 9
    for lab, tmpl in TEMPLATES:
        d = hamming_grid(g, tmpl)
        if d < bestd:
            bestd = d
            best = lab
    return best


def ascii_grid(g):
    return "\n".join("".join("#" if v else "." for v in row) for row in g)


def fullwidth_line(im, y0, y1):
    px = im.load()
    w, h = im.size
    for y in range(y0, y1):
        c = 0
        for x in range(0, min(220, w)):
            if px[x, y] > THR:
                c += 1
        if c > 70:
            return True
    return False


def parse_chars(chars: str):
    if not chars:
        return None
    try:
        if "." in chars:
            return float(chars)
        return int(chars)
    except ValueError:
        return chars


def ocr_weapon(name: str, debug: bool = True):
    im = load_gray(name)
    rows = []
    if debug:
        print("====", name)
    for bi, (y0, y1) in enumerate(text_bands(im)):
        boxes = glyph_boxes(im, y0, y1)
        expanded = []
        for x0, x1 in boxes:
            box = tight(im, x0, x1, y0, y1)
            if box and (box[1] - box[0] + 1) >= 28:
                mid = (x0 + x1) // 2
                expanded.append((x0, mid))
                expanded.append((mid, x1))
            else:
                expanded.append((x0, x1))
        chars = ""
        details = []
        for x0, x1 in expanded:
            box = tight(im, x0, x1, y0, y1)
            if not box:
                continue
            g, bw, bh = grid_of(im, box)
            ch = classify(g, bw)
            chars += ch
            details.append(f"{ch}:{bw}")
        graph = fullwidth_line(im, y0, y1)
        val = parse_chars(chars)
        skip = False
        if graph and "." not in chars and chars in {
            "200",
            "300",
            "400",
            "500",
            "600",
            "700",
            "800",
            "900",
            "2000",
            "0000",
        }:
            skip = True
        # graph axis often 4 digits / no decimal sitting on the plot
        if graph and chars in {"2000", "200"}:
            skip = True
        if debug:
            mark = "SKIP" if skip else ("GRAPH" if graph else "    ")
            print(f"  {bi:2d} y={y0:4d}-{y1:4d} {chars:10s} {str(val):10s} {mark} {details}")
        if not skip:
            rows.append(val)
    if debug:
        print("  COUNT", len(rows), rows)
    return rows


if __name__ == "__main__":
    out = {}
    for name in WEAPONS:
        out[name] = ocr_weapon(name)
    print("JSON")
    print(json.dumps(out))
