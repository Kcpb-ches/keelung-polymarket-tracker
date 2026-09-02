#!/usr/bin/env python3
"""
snapshot.py — 抓取各縣市選舉 Polymarket 盤口與成交明細，存成前端可讀的快照。

用途有兩個：
  1. 給 GitHub Actions 定時執行（GitHub 的機器在美國，不受台灣 IP 封鎖影響）
  2. 你自己開 VPN 時在本機執行，讓網頁在沒 VPN 時也看得到資料

產出：
  data-<eventId>.json          ← 各縣市當下全量快照，前端連不到 API 時會讀這個
  snapshots/YYYY-MM-DD.json    ← 當天各縣市的賠率與統計（不含逐筆明細，見下方說明）
  seen_wallets.json            ← 已知錢包名冊，新錢包偵測的依據

只用 Python 標準庫，不需要 pip install。

    python3 scripts/snapshot.py                # 正常抓取
    python3 scripts/snapshot.py --test-email   # 額外產生一封測試通知信
"""

import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

GAMMA_API = "https://gamma-api.polymarket.com"
DATA_API = "https://data-api.polymarket.com"

PAGE_SIZE = 500
MAX_OFFSET = 10000          # Data API 的 offset 上限
TIMEOUT = 30

TZ8 = timezone(timedelta(hours=8))

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)
SNAPSHOT_DIR = os.path.join(ROOT, "snapshots")

# 已知錢包名冊。這是「哪些錢包算看過了」的唯一依據，會 commit 進 repo。
# 不從 data-*.json 反推，因為那些檔有 MAX_OFFSET 上限，
# 將來筆數成長到截斷時，早期錢包會被誤判成新錢包而爆寄通知。
SEEN_WALLETS_PATH = os.path.join(ROOT, "seen_wallets.json")

# 通知信的暫存檔（不 commit）。有新錢包時才產生，workflow 靠它判斷要不要寄信。
NOTIFY_HTML_PATH = os.path.join(ROOT, "new_wallets.html")
NOTIFY_SUBJECT_PATH = os.path.join(ROOT, "new_wallets_subject.txt")

SITE_URL = "https://kcpb-ches.github.io/keelung-polymarket-tracker/"

# ── 縣市設定 ────────────────────────────────────────────────
# 要新增縣市：在這裡加一筆，並在 app.js 的 EVENTS 加對應的一筆。
# 中文名一律人工對照 API 的英文拼音，不要用 Polymarket 網站的機器翻譯。
EVENTS = [
    {"id": 848410, "slug": "keelung", "city": "基隆市", "office": "市長", "zh": {
        "Hsieh Kuo-liang": "謝國樑", "Tung Tzu-wei": "童子瑋"}},
    {"id": 848341, "slug": "taipei", "city": "臺北市", "office": "市長", "zh": {
        "Chiang Wan-an": "蔣萬安", "Puma Shen": "沈伯洋", "Kuo Hsi": "郭錫"}},
    {"id": 848347, "slug": "new-taipei", "city": "新北市", "office": "市長", "zh": {
        "Lee Shu-chuan": "李四川", "Su Chiao-hui": "蘇巧慧", "Huang Kuo-chang": "黃國昌"}},
    # ⚠️ 桃園：API 英文名是 Chang San-cheng（張善政），Polymarket 中文介面顯示「鄭文燦」，
    #    兩者是不同人。此處依 Ches 判斷採用「鄭文燦」。
    {"id": 848370, "slug": "taoyuan", "city": "桃園市", "office": "市長", "zh": {
        "Chang San-cheng": "鄭文燦", "Huang Shih-chieh": "黃世傑", "Perng Shaw-jiin": "彭紹瑾"}},
    {"id": 848409, "slug": "kaohsiung", "city": "高雄市", "office": "市長", "zh": {
        "Lai Jui-lung": "賴瑞隆", "Ko Chih-en": "柯志恩", "Chang Ching": "張清",
        "Hsu Chih-chieh": "許智傑", "Chiu Yi-ying": "邱議瑩", "Lin Tai-hua": "林岱樺"}},
    {"id": 848417, "slug": "yilan", "city": "宜蘭縣", "office": "縣長", "zh": {
        "Lin Kuo-chang": "林國彰", "Wu Tsung-hsien": "吳宗憲",
        "Chen Wan-hui": "陳琬惠", "Chang Sheng-te": "張勝得"}},
    {"id": 848453, "slug": "chiayi-city", "city": "嘉義市", "office": "市長", "zh": {
        "Wang Mei-hui": "王美惠", "Chang Chi-kai": "張其楷", "Weng Shou-liang": "翁淑良",
        "Huang Hung-cheng": "黃宏成", "Chen Chia-ping": "陳家平", "Chen Kai-huang": "陳凱煌"}},
    {"id": 848436, "slug": "miaoli", "city": "苗栗縣", "office": "縣長", "zh": {
        "Chung Tung-chin": "鍾東錦", "Chen Pin-an": "陳品安"}},
]


def data_path(event_id: int) -> str:
    return os.path.join(ROOT, f"data-{event_id}.json")


def http_get_json(url: str):
    req = urllib.request.Request(url, headers={
        "User-Agent": "tw-election-polymarket-tracker/2.0",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_event(event_id: int) -> dict:
    """抓 event 元資料（含各候選人 market 的賠率、成交量、流動性）"""
    arr = http_get_json(f"{GAMMA_API}/events?id={event_id}")
    if not arr:
        raise RuntimeError(f"event {event_id} 查不到")
    ev = arr[0] if isinstance(arr, list) else arr

    # 只留前端要用的欄位，避免快照檔塞入大量無用資料
    markets = []
    for m in ev.get("markets", []):
        markets.append({
            "conditionId": m.get("conditionId"),
            "groupItemTitle": m.get("groupItemTitle"),
            "question": m.get("question"),
            "slug": m.get("slug"),
            "outcomePrices": m.get("outcomePrices"),
            "clobTokenIds": m.get("clobTokenIds"),
            "volumeNum": m.get("volumeNum"),
            "liquidityNum": m.get("liquidityNum"),
        })

    return {
        "id": ev.get("id"),
        "title": ev.get("title"),
        "slug": ev.get("slug"),
        "startDate": ev.get("startDate"),
        "endDate": ev.get("endDate"),
        "volume": ev.get("volume"),
        "liquidity": ev.get("liquidity"),
        "active": ev.get("active"),
        "closed": ev.get("closed"),
        "markets": markets,
    }


def fetch_all_trades(event_id: int) -> list:
    """分頁抓完整成交明細，直到回傳空陣列為止"""
    out, offset = [], 0
    while offset < MAX_OFFSET:
        url = (f"{DATA_API}/trades?eventId={event_id}&takerOnly=true"
               f"&limit={PAGE_SIZE}&offset={offset}")
        batch = http_get_json(url)
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    else:
        print(f"    ⚠️ 已達 offset 上限 {MAX_OFFSET}，更早的紀錄需改用 start/end 時間窗查詢")
    return out


def slim_trade(t: dict) -> dict:
    """只保留追查與呈現需要的欄位"""
    return {
        "timestamp": t.get("timestamp"),
        "conditionId": t.get("conditionId"),
        "asset": t.get("asset"),
        "title": t.get("title"),
        "outcome": t.get("outcome"),
        "side": t.get("side"),
        "size": t.get("size"),
        "price": t.get("price"),
        "proxyWallet": t.get("proxyWallet"),
        "name": t.get("name"),
        "pseudonym": t.get("pseudonym"),
        "transactionHash": t.get("transactionHash"),
    }


def write_json_atomic(path: str, payload: dict):
    """先寫 .tmp 再 rename，避免前端讀到寫到一半的檔案"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


# ── 名稱處理 ────────────────────────────────────────────────

def cand_zh(cfg: dict, title: str) -> str:
    """候選人英文名 → 中文顯示名"""
    if title in cfg["zh"]:
        return cfg["zh"][title]
    if title == "Other":
        return "其他人選"
    m = re.match(r"^Candidate ([A-Z])$", title or "")
    if m:
        return f"未定人選 {m.group(1)}"
    return title or "未知"


def display_name(t: dict) -> str:
    """
    取交易者顯示名稱。部分帳號的 name 是系統自動填的錢包地址字串
    （例如 0xfBd8C9C22cA76B3662d0e53A4f79719FDC684027-1779347618060），
    那不是真的暱稱，視為未具名。（與 app.js 的 pickDisplayName 同邏輯）
    """
    def clean(v):
        return v if v and not re.match(r"^0x[a-fA-F0-9]{10,}", v) else ""
    return clean(t.get("name")) or clean(t.get("pseudonym")) or ""


def ts_to_tpe(unix_ts) -> str:
    try:
        return datetime.fromtimestamp(int(unix_ts), TZ8).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "時間不明"


# ── 新錢包偵測 ──────────────────────────────────────────────

def load_roster() -> tuple:
    """
    讀取錢包名冊，回傳 (依 event id 分組的名冊, 是否需要重建)。

    相容舊版格式：v1 是單一縣市的扁平結構 {"wallets": {...}}，
    會被歸到基隆（848410）名下，避免升級後基隆的既有名冊白白丟失
    而重新 bootstrap。
    """
    if not os.path.exists(SEEN_WALLETS_PATH):
        return {}, True
    try:
        with open(SEEN_WALLETS_PATH, encoding="utf-8") as f:
            d = json.load(f)
    except Exception as e:
        print(f"  ⚠️ 名冊讀取失敗（{e}），這次視為重新建立，不寄信")
        return {}, True

    if "events" in d:
        return {str(k): dict(v) for k, v in d["events"].items()}, False
    if "wallets" in d:
        print(f"  [名冊] 偵測到舊版格式，{len(d['wallets'])} 個錢包歸入基隆市（848410）")
        return {"848410": dict(d["wallets"])}, False
    return {}, True


def _wallet_entry(cfg: dict, t: dict, cond_to_cand: dict) -> dict:
    """把一筆交易整理成通知信要用的欄位"""
    size = float(t.get("size") or 0)
    price = float(t.get("price") or 0)
    return {
        "city": cfg["city"],
        "slug": cfg["slug"],
        "wallet": (t.get("proxyWallet") or "").lower(),
        "name": display_name(t),
        "first_seen": ts_to_tpe(t.get("timestamp")),
        "first_timestamp": t.get("timestamp"),
        "candidate": cand_zh(cfg, cond_to_cand.get(t.get("conditionId"), "")),
        "outcome": t.get("outcome"),
        "side": t.get("side"),
        "size": round(size, 4),
        "price": round(price, 6),
        "total": round(size * price, 4),
        "tx": t.get("transactionHash"),
    }


def first_trade_per_wallet(trades: list) -> dict:
    """每個錢包的首筆交易：由舊到新掃過，第一次遇到的就是最早那筆"""
    first = {}
    for t in sorted(trades, key=lambda x: x.get("timestamp") or 0):
        w = (t.get("proxyWallet") or "").lower()
        if w and w not in first:
            first[w] = t
    return first


def detect_new_wallets(cfg: dict, trades: list, cond_to_cand: dict,
                       roster: dict, bootstrap: bool) -> list:
    """
    比對名冊，找出這個縣市這次才第一次出現的錢包，並就地更新 roster。

    bootstrap（名冊不存在或損毀）時把現有錢包全部登記為已知但不回報，
    否則第一次啟用就會一口氣寄出所有歷史錢包，變成騷擾。
    同理，新加入的縣市第一次抓取時也不會回報。
    """
    key = str(cfg["id"])
    known = roster.setdefault(key, {})
    is_new_city = not known           # 這個縣市還沒有任何名冊
    silent = bootstrap or is_new_city

    new_wallets = []
    for wallet, t in first_trade_per_wallet(trades).items():
        if wallet in known:
            continue
        entry = _wallet_entry(cfg, t, cond_to_cand)
        known[wallet] = {"first_seen": entry["first_seen"], "name": entry["name"]}
        if not silent:
            new_wallets.append(entry)

    new_wallets.sort(key=lambda x: x.get("first_timestamp") or 0)
    return new_wallets


def save_roster(roster: dict):
    write_json_atomic(SEEN_WALLETS_PATH, {
        "updated_at": datetime.now(TZ8).isoformat(timespec="seconds"),
        "count": sum(len(v) for v in roster.values()),
        "events": roster,
    })


def cross_city_map(roster: dict) -> dict:
    """錢包 → 有出現過的縣市名稱清單。用來標記跨縣市操作的地址。"""
    id_to_city = {str(e["id"]): e["city"] for e in EVENTS}
    out = {}
    for eid, wallets in roster.items():
        city = id_to_city.get(eid, eid)
        for w in wallets:
            out.setdefault(w, set()).add(city)
    return out


# ── 通知信 ──────────────────────────────────────────────────

def build_test_sample(cfg: dict, trades: list, cond_to_cand: dict, n: int = 2) -> list:
    """
    取最近進場的 n 個錢包當測試信的內容。
    用真實資料而非假資料，這樣測試信長什麼樣，真信就長什麼樣。
    """
    first = first_trade_per_wallet(trades)
    latest = sorted(first.values(), key=lambda x: x.get("timestamp") or 0, reverse=True)[:n]
    out = [_wallet_entry(cfg, t, cond_to_cand) for t in latest]
    out.sort(key=lambda x: x.get("first_timestamp") or 0)
    return out


def _wallet_rows(wallets: list, cross: dict) -> str:
    rows = []
    for w in wallets:
        nm = html.escape(w["name"]) if w["name"] else '<i style="color:#888">未具名</i>'
        side_color = "#1a7f37" if w["side"] == "BUY" else "#cf222e"
        side_text = "▲ 買進" if w["side"] == "BUY" else "▼ 賣出"
        outcome_text = "Yes 會當選" if w["outcome"] == "Yes" else "No 不會當選"

        # 跨縣市標記：這個錢包在其他縣市也下注過，是值得優先看的異常模式
        others = sorted(cross.get(w["wallet"], set()) - {w["city"]})
        cross_tag = ""
        if others:
            cross_tag = (
                f'<div style="margin-top:6px;display:inline-block;background:#fff8e5;'
                f'border:1px solid #d29922;border-radius:5px;padding:1px 7px;'
                f'font-size:11.5px;color:#9a6700;font-weight:600">'
                f'也出現在 {html.escape("、".join(others))}</div>')

        rows.append(f"""
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e6eaef;vertical-align:top">
            <div style="font-weight:600;font-size:15px">{nm}</div>
            <div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#59636e;margin-top:3px">
              {html.escape(w['wallet'])}
            </div>
            <div style="font-size:12px;margin-top:6px">
              <a href="https://polygonscan.com/address/{html.escape(w['wallet'])}"
                 style="color:#0969da;text-decoration:none">Polygonscan ↗</a>
              &nbsp;·&nbsp;
              <a href="https://polymarket.com/profile/{html.escape(w['wallet'])}"
                 style="color:#0969da;text-decoration:none">Polymarket ↗</a>
              &nbsp;·&nbsp;
              <a href="https://relay.link/transactions?address={html.escape(w['wallet'])}"
                 style="color:#0969da;text-decoration:none">Relay ↗</a>
            </div>
            {cross_tag}
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e6eaef;vertical-align:top;font-size:13px">
            <div style="color:{side_color};font-weight:650">{side_text}</div>
            <div style="margin-top:3px">{html.escape(w['candidate'])}</div>
            <div style="color:#59636e;font-size:12px;margin-top:3px">{outcome_text}</div>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e6eaef;vertical-align:top;
                     text-align:right;font-size:13px;white-space:nowrap">
            <div style="font-size:17px;font-weight:680">${w['total']:,.2f}</div>
            <div style="color:#59636e;font-size:12px;margin-top:3px">
              {w['size']:,.2f} 股 @ {w['price']:.3f}
            </div>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e6eaef;vertical-align:top;
                     font-size:12px;color:#59636e;white-space:nowrap">
            {html.escape(w['first_seen'])}
          </td>
        </tr>""")
    return "".join(rows)


def build_notification(by_city: dict, cross: dict, test: bool = False):
    """
    產生通知信的主旨與 HTML 內文，寫成檔案供 workflow 讀取。
    by_city: {縣市名: [新錢包, ...]}，一封信涵蓋所有縣市。
    """
    total = sum(len(v) for v in by_city.values())
    cities = [c for c, v in by_city.items() if v]
    big = [w for v in by_city.values() for w in v if w["total"] >= 50]
    cross_hits = [w for v in by_city.values() for w in v
                  if len(cross.get(w["wallet"], set())) > 1]

    subject = f"[選舉盤] {total} 個新錢包進場"
    if len(cities) > 1:
        subject += f"（{len(cities)} 個縣市）"
    else:
        subject = f"[{cities[0]}] {total} 個新錢包進場" if cities else subject
    if cross_hits:
        subject += f"，{len(cross_hits)} 個跨縣市"
    elif big:
        subject += f"，{len(big)} 筆逾 $50"
    if test:
        subject = "【測試】" + subject

    test_banner = ("""
  <div style="background:#fff8e5;border:1px solid #d29922;border-radius:8px;
              padding:11px 15px;margin-bottom:16px;font-size:13px">
    <b style="color:#9a6700">這是一封測試信。</b>
    下面列的是<b>目前最近進場的錢包</b>，不是新偵測到的。
    收到這封代表郵件通知設定正常，真的有新錢包時就會收到同樣格式的信。
  </div>""" if test else "")

    cross_banner = ""
    if cross_hits and not test:
        cross_banner = f"""
  <div style="background:#fff8e5;border:1px solid #d29922;border-radius:8px;
              padding:11px 15px;margin-bottom:16px;font-size:13px">
    <b style="color:#9a6700">其中 {len(cross_hits)} 個錢包在多個縣市都有下注。</b>
    同一地址跨多個政治賭盤操作屬於值得優先檢視的模式，下方以黃色標籤標出。
  </div>"""

    sections = []
    for city, wallets in by_city.items():
        if not wallets:
            continue
        sections.append(f"""
  <h3 style="margin:22px 0 8px;font-size:15px;padding-bottom:5px;
             border-bottom:2px solid #0969da;display:inline-block">
    {html.escape(city)} · {len(wallets)} 個
  </h3>
  <table style="width:100%;border-collapse:collapse;border:1px solid #d8dee4;border-radius:8px">
    <thead>
      <tr style="background:#f6f8fa">
        <th style="padding:9px 12px;text-align:left;font-size:12px;color:#59636e;
                   border-bottom:1px solid #d8dee4">交易者 / 錢包</th>
        <th style="padding:9px 12px;text-align:left;font-size:12px;color:#59636e;
                   border-bottom:1px solid #d8dee4">首筆動作</th>
        <th style="padding:9px 12px;text-align:right;font-size:12px;color:#59636e;
                   border-bottom:1px solid #d8dee4">金額</th>
        <th style="padding:9px 12px;text-align:left;font-size:12px;color:#59636e;
                   border-bottom:1px solid #d8dee4">時間</th>
      </tr>
    </thead>
    <tbody>{_wallet_rows(wallets, cross)}</tbody>
  </table>""")

    # 必須是完整 HTML 文件並宣告 charset，否則中文在部分郵件用戶端會變亂碼
    body = f"""<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(subject)}</title>
</head>
<body style="margin:0;padding:20px;background:#ffffff">
<div style="font-family:-apple-system,'PingFang TC','Noto Sans TC',sans-serif;
            max-width:820px;margin:0 auto;color:#1f2328;line-height:1.6">
  <h2 style="margin:0 0 4px;font-size:19px">2026 地方選舉賭盤：{total} 個新錢包進場</h2>
  <p style="margin:0 0 18px;color:#59636e;font-size:13px">
    偵測時間 {datetime.now(TZ8).strftime('%Y-%m-%d %H:%M:%S')}（台北時間）
    ｜ {'測試模式，非實際偵測結果' if test else '以下錢包在該縣市賭盤從未出現過'}
  </p>
{test_banner}{cross_banner}
{''.join(sections)}

  <p style="margin:24px 0 0">
    <a href="{SITE_URL}" style="display:inline-block;background:#0969da;color:#fff;
       padding:9px 18px;border-radius:7px;text-decoration:none;font-size:14px;font-weight:600">
      開啟監控頁面
    </a>
  </p>

  <p style="margin:22px 0 0;padding-top:14px;border-top:1px solid #e6eaef;
            font-size:11.5px;color:#818b98">
    顯示名稱為使用者在 Polymarket 上的公開暱稱，非實名；錢包地址為 Polymarket 代管的
    proxy 合約錢包，不等於原始 EOA。本信由 GitHub Actions 自動發送。
  </p>
</div>
</body>
</html>"""

    with open(NOTIFY_HTML_PATH, "w", encoding="utf-8") as f:
        f.write(body)
    with open(NOTIFY_SUBJECT_PATH, "w", encoding="utf-8") as f:
        f.write(subject)
    return subject


# ── 主流程 ──────────────────────────────────────────────────

def main(test_email: bool = False) -> int:
    now = datetime.now(TZ8)
    print("=" * 66)
    print(f"  2026 地方選舉 Polymarket 快照　{now:%Y-%m-%d %H:%M:%S} (UTC+8)")
    print(f"  共 {len(EVENTS)} 個縣市")
    print("=" * 66)

    roster, bootstrap = load_roster()
    if bootstrap:
        print("  [名冊] 不存在或損毀，本次建立基準線，不寄信")

    by_city = {}
    daily = {}
    failures = []
    last_cfg = last_trades = last_cond = None

    for cfg in EVENTS:
        label = f"{cfg['city']}{cfg['office']}"
        try:
            event = fetch_event(cfg["id"])
            raw = fetch_all_trades(cfg["id"])
        except urllib.error.HTTPError as e:
            print(f"  ✗ {label:<12} HTTP {e.code} {e.reason}")
            failures.append((label, f"HTTP {e.code}"))
            continue
        except Exception as e:
            print(f"  ✗ {label:<12} {type(e).__name__}: {e}")
            failures.append((label, f"{type(e).__name__}: {e}"))
            continue

        trades = [slim_trade(t) for t in raw]
        trades.sort(key=lambda x: x.get("timestamp") or 0, reverse=True)
        cond_to_cand = {m["conditionId"]: m["groupItemTitle"] for m in event["markets"]}

        payload = {
            "fetched_at": now.isoformat(timespec="seconds"),
            "event_id": cfg["id"],
            "city": cfg["city"],
            "total_trades": len(trades),
            "event": event,
            "trades": trades,
        }
        write_json_atomic(data_path(cfg["id"]), payload)

        new_wallets = detect_new_wallets(cfg, trades, cond_to_cand, roster, bootstrap)
        if new_wallets:
            by_city[cfg["city"]] = new_wallets

        wallets = {(t.get("proxyWallet") or "").lower() for t in trades if t.get("proxyWallet")}
        active = [m for m in event["markets"] if (m.get("volumeNum") or 0) > 0]
        print(f"  ✓ {label:<12} {len(trades):>4} 筆　{len(wallets):>3} 錢包　"
              f"${float(event.get('volume') or 0):>10,.0f}　"
              f"新錢包 {len(new_wallets)}")

        # 每日快照只留賠率與統計，不含逐筆明細——
        # 逐筆資料在 data-*.json 的 git 歷史裡已經有了，重複存會讓 repo 無謂膨脹。
        daily[str(cfg["id"])] = {
            "city": cfg["city"],
            "total_trades": len(trades),
            "wallets": len(wallets),
            "volume": event.get("volume"),
            "liquidity": event.get("liquidity"),
            "odds": {
                cand_zh(cfg, m["groupItemTitle"]): json.loads(m["outcomePrices"])[0]
                for m in active if m.get("outcomePrices")
            },
        }
        last_cfg, last_trades, last_cond = cfg, trades, cond_to_cand

    if failures and not daily:
        print("\n❌ 所有縣市都抓取失敗，不寫入任何檔案")
        print("   若在台灣直接執行，Polymarket 可能封鎖了你的 IP，請先連 VPN。")
        return 1

    save_roster(roster)
    write_json_atomic(os.path.join(SNAPSHOT_DIR, f"{now:%Y-%m-%d}.json"), {
        "fetched_at": now.isoformat(timespec="seconds"),
        "events": daily,
    })

    # ── 通知 ──────────────────────────────────────────────
    for p in (NOTIFY_HTML_PATH, NOTIFY_SUBJECT_PATH):
        if os.path.exists(p):
            os.remove(p)

    cross = cross_city_map(roster)
    print("-" * 66)
    if by_city:
        subject = build_notification(by_city, cross)
        print(f"[新錢包] 已產生通知信：{subject}")
        for city, ws in by_city.items():
            for w in ws:
                others = sorted(cross.get(w["wallet"], set()) - {city})
                mark = f"  ← 也出現在 {'、'.join(others)}" if others else ""
                print(f"    {city} {(w['name'] or '未具名'):<20} {w['wallet']} "
                      f"${w['total']:,.2f}{mark}")
    else:
        print("[新錢包] 無，不寄信")

    if test_email and not by_city:
        if last_trades:
            sample = build_test_sample(last_cfg, last_trades, last_cond)
            if sample:
                print(f"[測試] 已產生測試信：{build_notification({last_cfg['city']: sample}, cross, test=True)}")
            else:
                print("[測試] 沒有任何交易資料可用來組測試信")
        else:
            print("[測試] 所有縣市都抓取失敗，無法組測試信")
    elif test_email:
        print("[測試] 本輪本來就有新錢包，直接寄真實通知")

    total_wallets = sum(len(v) for v in roster.values())
    multi = sum(1 for v in cross.values() if len(v) > 1)
    print(f"\n名冊共 {total_wallets} 筆（{len(roster)} 個縣市），其中 {multi} 個錢包跨縣市")
    if failures:
        print(f"⚠️ {len(failures)} 個縣市抓取失敗：" +
              "、".join(f"{n}（{e}）" for n, e in failures))
    return 0


if __name__ == "__main__":
    sys.exit(main(test_email="--test-email" in sys.argv))
