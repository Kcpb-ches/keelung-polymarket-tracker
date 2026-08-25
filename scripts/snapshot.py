#!/usr/bin/env python3
"""
snapshot.py — 抓取基隆市長選舉 Polymarket 盤口與成交明細，存成前端可讀的快照。

用途有兩個：
  1. 給 GitHub Actions 定時執行（GitHub 的機器在美國，不受台灣 IP 封鎖影響）
  2. 你自己開 VPN 時在本機執行，產生 data.json 讓網頁在沒 VPN 時也看得到資料

產出：
  data.json                    ← 當下全量快照，前端連不到 API 時會讀這個
  snapshots/YYYY-MM-DD.json    ← 當天最後一次快照，做歷史留存（每天一個檔）

只用 Python 標準庫，不需要 pip install。

    python3 scripts/snapshot.py
"""

import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

EVENT_ID = 848410
GAMMA_API = "https://gamma-api.polymarket.com"
DATA_API = "https://data-api.polymarket.com"

PAGE_SIZE = 500
MAX_OFFSET = 10000          # Data API 的 offset 上限
TIMEOUT = 30

TZ8 = timezone(timedelta(hours=8))

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)
DATA_PATH = os.path.join(ROOT, "data.json")
SNAPSHOT_DIR = os.path.join(ROOT, "snapshots")

# 已知錢包名冊。這是「哪些錢包算看過了」的唯一依據，會 commit 進 repo。
# 不從 data.json 反推，因為 data.json 有 MAX_OFFSET 上限，
# 將來筆數成長到截斷時，早期錢包會被誤判成新錢包。
SEEN_WALLETS_PATH = os.path.join(ROOT, "seen_wallets.json")

# 通知信的暫存檔（不 commit）。有新錢包時才產生，workflow 靠它判斷要不要寄信。
NOTIFY_HTML_PATH = os.path.join(ROOT, "new_wallets.html")
NOTIFY_SUBJECT_PATH = os.path.join(ROOT, "new_wallets_subject.txt")

SITE_URL = "https://kcpb-ches.github.io/keelung-polymarket-tracker/"

# 候選人英文 → 中文（與 app.js 的 CANDIDATES 對照表保持一致）
CANDIDATES_ZH = {
    "Hsieh Kuo-liang": "謝國樑",
    "Tung Tzu-wei": "童子瑋",
    "Other": "其他人選",
}


def http_get_json(url: str):
    req = urllib.request.Request(url, headers={
        "User-Agent": "keelung-polymarket-tracker/1.0",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_event() -> dict:
    """抓 event 元資料（含 29 個候選人 market 的賠率、成交量、流動性）"""
    arr = http_get_json(f"{GAMMA_API}/events?id={EVENT_ID}")
    if not arr:
        raise RuntimeError(f"event {EVENT_ID} 查不到")
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


def fetch_all_trades() -> list:
    """分頁抓完整成交明細，直到回傳空陣列為止"""
    out, offset = [], 0
    while offset < MAX_OFFSET:
        url = (f"{DATA_API}/trades?eventId={EVENT_ID}&takerOnly=true"
               f"&limit={PAGE_SIZE}&offset={offset}")
        batch = http_get_json(url)
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        print(f"  offset={offset:<6} 取得 {len(batch)} 筆（累計 {len(out)}）")
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    else:
        print(f"  ⚠️ 已達 offset 上限 {MAX_OFFSET}，更早的紀錄需改用 start/end 時間窗查詢")
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


def cand_zh(title: str) -> str:
    """候選人英文名 → 中文顯示名"""
    if title in CANDIDATES_ZH:
        return CANDIDATES_ZH[title]
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


def _wallet_entry(t: dict, cond_to_cand: dict) -> dict:
    """把一筆交易整理成通知信要用的欄位"""
    size = float(t.get("size") or 0)
    price = float(t.get("price") or 0)
    return {
        "wallet": (t.get("proxyWallet") or "").lower(),
        "name": display_name(t),
        "first_seen": ts_to_tpe(t.get("timestamp")),
        "first_timestamp": t.get("timestamp"),
        "candidate": cand_zh(cond_to_cand.get(t.get("conditionId"), "")),
        "outcome": t.get("outcome"),
        "side": t.get("side"),
        "size": round(size, 4),
        "price": round(price, 6),
        "total": round(size * price, 4),
        "tx": t.get("transactionHash"),
    }


def _first_trade_per_wallet(trades: list) -> dict:
    """每個錢包的首筆交易：由舊到新掃過，第一次遇到的就是最早那筆"""
    first = {}
    for t in sorted(trades, key=lambda x: x.get("timestamp") or 0):
        w = (t.get("proxyWallet") or "").lower()
        if w and w not in first:
            first[w] = t
    return first


def build_test_sample(trades: list, cond_to_cand: dict, n: int = 2) -> list:
    """
    取最近進場的 n 個錢包當測試信的內容。
    用真實資料而非假資料，這樣測試信長什麼樣，真信就長什麼樣。
    """
    first = _first_trade_per_wallet(trades)
    latest = sorted(first.values(), key=lambda x: x.get("timestamp") or 0, reverse=True)[:n]
    out = [_wallet_entry(t, cond_to_cand) for t in latest]
    out.sort(key=lambda x: x.get("first_timestamp") or 0)
    return out


def detect_new_wallets(trades: list, cond_to_cand: dict):
    """
    比對名冊，找出這次才第一次出現的錢包。

    回傳 (新錢包清單, 是否為首次建立名冊)。
    首次建立名冊時會把現有錢包全部登記為已知，且不視為「新錢包」——
    否則第一次啟用這個功能就會一口氣寄出所有歷史錢包，變成騷擾。
    """
    prev = None
    if os.path.exists(SEEN_WALLETS_PATH):
        try:
            with open(SEEN_WALLETS_PATH, encoding="utf-8") as f:
                prev = json.load(f)
        except Exception as e:
            print(f"  ⚠️ 名冊讀取失敗（{e}），這次視為重新建立，不寄信")
            prev = None

    bootstrap = prev is None
    seen = dict(prev.get("wallets", {})) if prev else {}

    first_trade = _first_trade_per_wallet(trades)

    new_wallets = []
    for wallet, t in first_trade.items():
        if wallet in seen:
            continue
        entry = _wallet_entry(t, cond_to_cand)
        seen[wallet] = {
            "first_seen": entry["first_seen"],
            "name": entry["name"],
        }
        if not bootstrap:
            new_wallets.append(entry)

    new_wallets.sort(key=lambda x: x.get("first_timestamp") or 0)

    write_json_atomic(SEEN_WALLETS_PATH, {
        "updated_at": datetime.now(TZ8).isoformat(timespec="seconds"),
        "count": len(seen),
        "wallets": seen,
    })
    return new_wallets, bootstrap


def build_notification(new_wallets: list, test: bool = False):
    """產生通知信的主旨與 HTML 內文，寫成檔案供 workflow 讀取。"""
    n = len(new_wallets)
    big = [w for w in new_wallets if w["total"] >= 50]
    subject = f"[基隆盤] {n} 個新錢包進場" + (f"，其中 {len(big)} 筆逾 $50" if big else "")
    if test:
        subject = "【測試】" + subject

    test_banner = ("""
  <div style="background:#fff8e5;border:1px solid #d29922;border-radius:8px;
              padding:11px 15px;margin-bottom:16px;font-size:13px">
    <b style="color:#9a6700">這是一封測試信。</b>
    下面列的是<b>目前最近進場的錢包</b>，不是新偵測到的。
    收到這封代表郵件通知設定正常，真的有新錢包時就會收到同樣格式的信。
  </div>""" if test else "")

    rows = []
    for w in new_wallets:
        nm = html.escape(w["name"]) if w["name"] else '<i style="color:#888">未具名</i>'
        side_color = "#1a7f37" if w["side"] == "BUY" else "#cf222e"
        side_text = "▲ 買進" if w["side"] == "BUY" else "▼ 賣出"
        outcome_text = "Yes 會當選" if w["outcome"] == "Yes" else "No 不會當選"
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
              <a href="https://polygonscan.com/tx/{html.escape(w['tx'] or '')}"
                 style="color:#0969da;text-decoration:none">交易紀錄 ↗</a>
            </div>
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
  <h2 style="margin:0 0 4px;font-size:19px">基隆市長選舉賭盤：{n} 個新錢包進場</h2>
  <p style="margin:0 0 18px;color:#59636e;font-size:13px">
    偵測時間 {datetime.now(TZ8).strftime('%Y-%m-%d %H:%M:%S')}（台北時間）
    ｜ {'測試模式，非實際偵測結果' if test else '以下錢包在此賭盤從未出現過'}
  </p>
{test_banner}

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
    <tbody>{''.join(rows)}</tbody>
  </table>

  <p style="margin:20px 0 0">
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


def write_json_atomic(path: str, payload: dict):
    """先寫 .tmp 再 rename，避免前端讀到寫到一半的檔案"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def main(test_email: bool = False) -> int:
    now = datetime.now(TZ8)
    print("=" * 62)
    print(f"  基隆市長選舉 Polymarket 快照　{now:%Y-%m-%d %H:%M:%S} (UTC+8)")
    print("=" * 62)

    try:
        print("[1/2] 抓取盤口 (Gamma API)…")
        event = fetch_event()
        active_markets = [m for m in event["markets"]
                          if (m.get("volumeNum") or 0) > 0 or (m.get("liquidityNum") or 0) > 0]
        print(f"      {event['title']}：{len(event['markets'])} 個 market"
              f"（其中 {len(active_markets)} 個有量）")

        print("[2/2] 抓取成交明細 (Data API)…")
        raw_trades = fetch_all_trades()
    except urllib.error.HTTPError as e:
        print(f"\n❌ HTTP {e.code}：{e.reason}")
        print("   若在台灣直接執行，Polymarket 可能封鎖了你的 IP，請先連 VPN。")
        return 1
    except Exception as e:
        print(f"\n❌ 抓取失敗：{type(e).__name__}: {e}")
        print("   若在台灣直接執行，Polymarket 可能封鎖了你的 IP，請先連 VPN。")
        return 1

    trades = [slim_trade(t) for t in raw_trades]
    trades.sort(key=lambda x: x.get("timestamp") or 0, reverse=True)

    # 各候選人成交筆數，方便在 Actions log 上一眼看出變化
    by_cand: dict = {}
    cond_to_name = {m["conditionId"]: m["groupItemTitle"] for m in event["markets"]}
    for t in trades:
        key = cond_to_name.get(t["conditionId"], "?")
        by_cand[key] = by_cand.get(key, 0) + 1

    payload = {
        "fetched_at": now.isoformat(timespec="seconds"),
        "event_id": EVENT_ID,
        "total_trades": len(trades),
        "trades_by_candidate": by_cand,
        "event": event,
        "trades": trades,
    }

    # 前一次的筆數，用來判斷是否有新成交
    prev_count = None
    if os.path.exists(DATA_PATH):
        try:
            with open(DATA_PATH, encoding="utf-8") as f:
                prev_count = json.load(f).get("total_trades")
        except Exception:
            pass

    write_json_atomic(DATA_PATH, payload)
    # 當天最後一次快照（同一天重複執行會覆蓋，避免 repo 被大量重複檔案撐爆）
    write_json_atomic(os.path.join(SNAPSHOT_DIR, f"{now:%Y-%m-%d}.json"), payload)

    print("-" * 62)
    print(f"總成交筆數：{len(trades)}" +
          (f"（上次 {prev_count}，新增 {len(trades) - prev_count} 筆）"
           if prev_count is not None else ""))
    for k, v in sorted(by_cand.items(), key=lambda x: -x[1]):
        print(f"    {k:<20} {v:>5} 筆")

    # ── 新錢包偵測 ────────────────────────────────────────────
    # 舊的通知檔先清掉，避免上一輪殘留導致重複寄信
    for p in (NOTIFY_HTML_PATH, NOTIFY_SUBJECT_PATH):
        if os.path.exists(p):
            os.remove(p)

    new_wallets, bootstrap = detect_new_wallets(trades, cond_to_name)
    print()
    if bootstrap:
        wallet_count = len({(t.get("proxyWallet") or "").lower()
                            for t in trades if t.get("proxyWallet")})
        print(f"[名冊] 首次建立，已登記 {wallet_count} 個既有錢包為基準線（不寄信）")
    elif new_wallets:
        subject = build_notification(new_wallets)
        print(f"[新錢包] 偵測到 {len(new_wallets)} 個，已產生通知信：{subject}")
        for w in new_wallets:
            nm = w["name"] or "未具名"
            print(f"    {nm:<22} {w['wallet']}  ${w['total']:,.2f}  {w['first_seen']}")
    else:
        print("[新錢包] 無，不寄信")

    # 測試模式：沒有真的新錢包時，改用最近進場的錢包產生一封測試信，
    # 用來驗證郵件設定是否正常。不會動到名冊。
    if test_email and not new_wallets:
        sample = build_test_sample(trades, cond_to_name)
        if sample:
            subject = build_notification(sample, test=True)
            print(f"[測試] 已產生測試信：{subject}")
        else:
            print("[測試] 沒有任何交易資料可用來組測試信")
    elif test_email:
        print("[測試] 本輪本來就有新錢包，直接寄真實通知")

    print(f"\n已寫入：{DATA_PATH}")
    print(f"　　　　{os.path.join(SNAPSHOT_DIR, f'{now:%Y-%m-%d}.json')}")
    print(f"　　　　{SEEN_WALLETS_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main(test_email="--test-email" in sys.argv))
