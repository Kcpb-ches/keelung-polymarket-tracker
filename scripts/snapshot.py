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

import json
import os
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


def write_json_atomic(path: str, payload: dict):
    """先寫 .tmp 再 rename，避免前端讀到寫到一半的檔案"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def main() -> int:
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
    print(f"\n已寫入：{DATA_PATH}")
    print(f"　　　　{os.path.join(SNAPSHOT_DIR, f'{now:%Y-%m-%d}.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
