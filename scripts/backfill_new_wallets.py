#!/usr/bin/env python3
"""
一次性回填 new-wallets.json。

「新進錢包通知」頁籤上線前，歷史上那些已經被記進名冊、但從來沒有存過
首筆交易明細的錢包（2026-08 起約 1,400 個），需要補一份完整資料，
否則頁面上線後會是空的，要等新錢包慢慢出現才長得出來。

資料來源是現成的 data-*.json（每個縣市的成交明細快照），
從裡面把每個錢包最早的那筆交易撈出來，組成跟 snapshot.py 完全相同的格式。

跑法：
    python3 scripts/backfill_new_wallets.py          # 實際寫入
    python3 scripts/backfill_new_wallets.py --dry    # 只看結果不寫檔

這支腳本設計成可以重複執行：寫入走 merge_new_wallets()，只補沒有的，
不會覆蓋或弄亂已經記錄的資料。跑完之後日常維護就交給 snapshot.py，
正常情況下不需要再跑第二次。
"""

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

from snapshot import (                                   # noqa: E402
    EVENTS, NEW_WALLETS_PATH, ROOT,
    _wallet_entry, data_path, first_trade_per_wallet,
    load_roster, merge_new_wallets,
)


def main(dry: bool = False) -> int:
    roster, bootstrap = load_roster()
    if bootstrap:
        print("⚠️ 讀不到 seen_wallets.json，無法比對名冊；仍會依 data-*.json 回填")

    records = []
    missing_total = 0

    for cfg in EVENTS:
        path = data_path(cfg["id"])
        if not os.path.exists(path):
            print(f"  – {cfg['city']}{cfg['office']:<3} 沒有 data 檔，略過")
            continue

        with open(path, encoding="utf-8") as f:
            d = json.load(f)

        cond_to_cand = {m["conditionId"]: m["groupItemTitle"]
                        for m in d.get("event", {}).get("markets", [])}
        firsts = first_trade_per_wallet(d.get("trades", []))

        for wallet, t in firsts.items():
            records.append(_wallet_entry(cfg, t, cond_to_cand))

        # 名冊裡有、但 data 檔撈不到的錢包：多半代表該縣市的成交明細已經被
        # MAX_OFFSET 截斷。這種的首筆交易再也撈不回來，只能放棄，但要講出來。
        known = set(roster.get(str(cfg["id"]), {}))
        missing = known - set(firsts)
        missing_total += len(missing)
        flag = f"　⚠️ 名冊有 {len(missing)} 個撈不到首筆交易" if missing else ""
        print(f"  ✓ {cfg['city']}{cfg['office']:<3} {len(firsts):>4} 個錢包{flag}")

    records.sort(key=lambda x: x.get("first_timestamp") or 0)
    print("-" * 60)
    print(f"共整理出 {len(records)} 筆新進錢包紀錄")
    if missing_total:
        print(f"⚠️ 另有 {missing_total} 個名冊錢包因成交明細已截斷而無法回填")

    if dry:
        print("\n[--dry] 不寫檔。最新 5 筆預覽：")
        for w in records[-5:]:
            print(f"  {w['first_seen']}  {w['city']:<4} {(w['name'] or '未具名'):<20} "
                  f"{w['candidate']} {w['outcome']} {w['side']} ${w['total']:,.2f}")
        return 0

    total = merge_new_wallets(records)
    size_kb = os.path.getsize(NEW_WALLETS_PATH) / 1024
    print(f"✅ 已寫入 {os.path.relpath(NEW_WALLETS_PATH, ROOT)}"
          f"（{total} 筆，{size_kb:,.0f} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main(dry="--dry" in sys.argv))
