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

VIEW_W, VIEW_H = 800, 1000     # SVG 畫布尺寸

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


def rings_of(geom):
    """取出所有外環（忽略內環／洞，縣市界用不到）"""
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    return [poly[0] for poly in geom["coordinates"]]


def main(src, out=None):
    out = out or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "map-data.js")
    with open(src, encoding="utf-8") as f:
        gj = json.load(f)

    print(f"讀入 {len(gj['features'])} 個縣市")

    # 第一輪：化簡並蒐集所有座標，順便求整體範圍
    counties, raw_pts, kept_pts = [], 0, 0
    for feat in gj["features"]:
        name = feat["properties"].get("COUNTYNAME") or feat["properties"].get("name")
        name = NAME_FIX.get(name, name)

        rings = []
        for ring in rings_of(feat["geometry"]):
            raw_pts += len(ring)
            if ring_area(ring) < MIN_AREA:
                continue
            simp = douglas_peucker([tuple(p) for p in ring], TOLERANCE)
            if len(simp) >= 4:
                rings.append(simp)

        rings.sort(key=ring_area, reverse=True)
        rings = rings[:MAX_RINGS]
        kept_pts += sum(len(r) for r in rings)
        counties.append({"name": name, "rings": rings})

    all_pts = [p for c in counties for r in c["rings"] for p in r]
    lons = [p[0] for p in all_pts]
    lats = [p[1] for p in all_pts]
    lon0, lon1 = min(lons), max(lons)
    lat0, lat1 = min(lats), max(lats)

    # 等距圓柱投影，依緯度修正 x 方向的壓縮（台灣約在北緯 23.5 度）
    mid_lat = math.radians((lat0 + lat1) / 2)
    kx = math.cos(mid_lat)
    span_x = (lon1 - lon0) * kx
    span_y = lat1 - lat0
    scale = min(VIEW_W / span_x, VIEW_H / span_y) * 0.96
    off_x = (VIEW_W - span_x * scale) / 2
    off_y = (VIEW_H - span_y * scale) / 2

    def project(lon, lat):
        x = (lon - lon0) * kx * scale + off_x
        y = (lat1 - lat) * scale + off_y      # 緯度往上，SVG y 往下
        return round(x, 1), round(y, 1)

    # 產生路徑字串
    out_data = []
    for c in counties:
        d = []
        for ring in c["rings"]:
            pts = [project(*p) for p in ring]
            d.append("M" + "L".join(f"{x},{y}" for x, y in pts) + "Z")
        # 標籤放在最大一塊的中心
        big = c["rings"][0]
        cx = sum(p[0] for p in big) / len(big)
        cy = sum(p[1] for p in big) / len(big)
        lx, ly = project(cx, cy)
        out_data.append({"name": c["name"], "d": "".join(d), "cx": lx, "cy": ly})

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
