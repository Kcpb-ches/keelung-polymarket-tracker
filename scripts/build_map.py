#!/usr/bin/env python3
"""
build_map.py — 把台灣縣市界 GeoJSON 轉成前端用的簡化 SVG 路徑。

來源資料：g0v/twgeojson 的 twCounty2010.geo.json（9.3 MB，約 20 萬個座標點）。
原始檔太大不適合放進網頁，這裡做三件事：

  1. Douglas-Peucker 化簡：在容許誤差內大幅減少座標點
  2. 丟掉太小的離島碎塊（保留每個縣市最大的幾塊）
  3. 經緯度投影成 SVG 座標，輸出成 map-data.js

產出的 map-data.js 供 index.html 直接載入，不需要執行期再抓任何資料。

    python3 scripts/build_map.py <來源 geojson> [輸出路徑]
"""

import json
import math
import os
import sys

# 化簡容許誤差（單位：度）。約 0.001 度 ≈ 100 公尺。
TOLERANCE = 0.0018
# 每個縣市最多保留幾塊多邊形（本島 + 主要離島），其餘碎塊丟棄
MAX_RINGS = 6
# 小於這個面積的環直接丟棄（單位：平方度）
MIN_AREA = 0.00035

VIEW_W, VIEW_H = 760, 1000     # SVG 畫布尺寸

# 這三個縣市離本島很遠（金門在福建外海、連江更北），若一起參與範圍計算，
# 會把畫布撐開兩倍、讓本島只剩三分之一大小。改為單獨縮小後放到左下角。
OUTLYING = {"金門縣", "連江縣", "澎湖縣"}
INSET_BOX = (14, 700, 190, 280)   # 離島區塊 (x, y, 寬, 高)

# 資料裡的名稱 → 專案設定表用的名稱（要跟 app.js 的 EVENTS.city 對得上）
NAME_FIX = {
    "台北市": "臺北市", "台中市": "臺中市", "台南市": "臺南市",
    "台東縣": "臺東縣", "桃園縣": "桃園市",   # 2014 升格後改制
}


def perpendicular_distance(pt, a, b):
    (x, y), (x1, y1), (x2, y2) = pt, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def douglas_peucker(pts, tol):
    """遞迴化簡折線：保留形狀轉折，刪除幾乎共線的點"""
    if len(pts) < 3:
        return pts
    dmax, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        d = perpendicular_distance(pts[i], pts[0], pts[-1])
        if d > dmax:
            dmax, idx = d, i
    if dmax > tol:
        left = douglas_peucker(pts[: idx + 1], tol)
        right = douglas_peucker(pts[idx:], tol)
        return left[:-1] + right
    return [pts[0], pts[-1]]


def ring_area(ring):
    """鞋帶公式算多邊形面積，用來判斷碎塊大小"""
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(a) / 2


def polys_of(geom):
    """
    取出多邊形清單，每個是 [外環, 洞1, 洞2...]。

    洞一定要保留：臺北市是新北市包住的飛地、嘉義市是嘉義縣包住的飛地。
    只取外環的話，外圍縣市的幾何中心會落在飛地上，標籤就被飛地的圖形蓋住。
    """
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    return list(geom["coordinates"])


def point_in_ring(pt, ring):
    """射線法判斷點是否在多邊形內"""
    x, y = pt
    inside = False
    n = len(ring)
    for i in range(n - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xi:
                inside = not inside
    return inside


def dist_to_rings(pt, rings):
    """點到所有環邊界的最短距離"""
    best = float("inf")
    for ring in rings:
        for i in range(len(ring) - 1):
            d = perpendicular_distance(pt, ring[i], ring[i + 1])
            if d < best:
                best = d
    return best


def label_point(outer, holes, steps=44):
    """
    找「離邊界最遠的內部點」（pole of inaccessibility）當標籤位置。

    比幾何中心可靠：狹長或凹形的縣市（例如屏東、新北）中心可能落在
    範圍外或飛地上，這個做法保證落在實心區域內。
    """
    xs = [p[0] for p in outer]
    ys = [p[1] for p in outer]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    rings = [outer] + holes
    best, best_d = None, -1.0
    for i in range(steps):
        for j in range(steps):
            px = x0 + (x1 - x0) * (i + 0.5) / steps
            py = y0 + (y1 - y0) * (j + 0.5) / steps
            if not point_in_ring((px, py), outer):
                continue
            if any(point_in_ring((px, py), h) for h in holes):
                continue
            d = dist_to_rings((px, py), rings)
            if d > best_d:
                best, best_d = (px, py), d
    if best:
        return best
    # 極端情況（化簡後太細）退回幾何中心
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def main(src, out=None):
    out = out or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "map-data.js")
    with open(src, encoding="utf-8") as f:
        gj = json.load(f)

    print(f"讀入 {len(gj['features'])} 個縣市")

    # 第一輪：化簡。每個縣市保留 [外環, 洞...] 的結構
    counties, raw_pts, kept_pts = [], 0, 0
    for feat in gj["features"]:
        name = feat["properties"].get("COUNTYNAME") or feat["properties"].get("name")
        name = NAME_FIX.get(name, name)

        polys = []
        for poly in polys_of(feat["geometry"]):
            simp_rings = []
            for k, ring in enumerate(poly):
                raw_pts += len(ring)
                # 外環太小就整塊丟掉；洞用較寬鬆的門檻，免得飛地被誤刪
                if ring_area(ring) < (MIN_AREA if k == 0 else MIN_AREA / 4):
                    if k == 0:
                        simp_rings = []
                        break
                    continue
                simp = douglas_peucker([tuple(p) for p in ring], TOLERANCE)
                if len(simp) >= 4:
                    simp_rings.append(simp)
            if simp_rings:
                polys.append(simp_rings)

        polys.sort(key=lambda p: ring_area(p[0]), reverse=True)
        polys = polys[:MAX_RINGS]
        kept_pts += sum(len(r) for p in polys for r in p)
        # rings：投影與範圍計算用的所有座標；polys：保留洞的結構
        counties.append({"name": name, "polys": polys,
                         "rings": [r for p in polys for r in p]})

    def make_projection(subset, box):
        """把一群縣市投影到指定的方框內，回傳 project 函式"""
        pts = [p for c in subset for r in c["rings"] for p in r]
        lons = [p[0] for p in pts]
        lats = [p[1] for p in pts]
        lon0, lon1 = min(lons), max(lons)
        lat0, lat1 = min(lats), max(lats)
        # 等距圓柱投影，依緯度修正 x 方向的壓縮（台灣約在北緯 23.5 度）
        kx = math.cos(math.radians((lat0 + lat1) / 2))
        span_x = max((lon1 - lon0) * kx, 1e-9)
        span_y = max(lat1 - lat0, 1e-9)
        bx, by, bw, bh = box
        scale = min(bw / span_x, bh / span_y)
        off_x = bx + (bw - span_x * scale) / 2
        off_y = by + (bh - span_y * scale) / 2

        def project(lon, lat):
            x = (lon - lon0) * kx * scale + off_x
            y = (lat1 - lat) * scale + off_y   # 緯度往上，SVG y 往下
            return round(x, 1), round(y, 1)
        return project

    main_isl = [c for c in counties if c["name"] not in OUTLYING]
    outly = [c for c in counties if c["name"] in OUTLYING]

    # 本島用整張畫布（留一點邊），離島另外縮小放左下角
    proj_main = make_projection(main_isl, (10, 12, VIEW_W - 20, VIEW_H - 24))
    proj_out = make_projection(outly, INSET_BOX) if outly else None

    out_data = []
    for c in counties:
        project = proj_out if c["name"] in OUTLYING else proj_main
        d = []
        for poly in c["polys"]:
            for ring in poly:           # 外環與洞都寫進同一個 path
                pts = [project(*p) for p in ring]
                d.append("M" + "L".join(f"{x},{y}" for x, y in pts) + "Z")

        # 標籤放在最大一塊的「離邊界最遠內部點」，先在經緯度空間算再投影
        big = c["polys"][0]
        lx, ly = project(*label_point(big[0], big[1:]))
        out_data.append({"name": c["name"], "d": "".join(d), "cx": lx, "cy": ly,
                         "outlying": c["name"] in OUTLYING})

    out_data.sort(key=lambda c: c["name"])

    with open(out, "w", encoding="utf-8") as f:
        f.write("/* 台灣縣市界 SVG 路徑。由 scripts/build_map.py 從\n")
        f.write("   g0v/twgeojson 的 twCounty2010.geo.json 化簡而來，勿手動編輯。\n")
        f.write(f"   viewBox: 0 0 {VIEW_W} {VIEW_H} */\n")
        f.write(f"const TW_MAP = {{ w: {VIEW_W}, h: {VIEW_H}, counties: ")
        json.dump(out_data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(" };\n")

    size = os.path.getsize(out)
    print(f"座標點 {raw_pts:,} → {kept_pts:,}（{100*kept_pts//raw_pts}%）")
    print(f"輸出 {out}（{size/1024:.0f} KB）")
    print()
    for c in out_data:
        print(f"  {c['name']:<8} {len(c['d']):>6} 字元")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    sys.exit(main(*sys.argv[1:3]))
