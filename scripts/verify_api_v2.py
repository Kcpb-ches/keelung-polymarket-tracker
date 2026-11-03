#!/usr/bin/env python3
"""
Data API v2 遷移驗證。只讀不寫、不寄信。

直接載入 snapshot.py 裡真正在用的那幾支函式，對幾個縣市跑一遍，
檢查抓回來的筆數、欄位有沒有缺、分頁有沒有翻完。
確認遷移成功後這支就可以刪掉。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import snapshot as S            # noqa: E402

SAMPLE = ["基隆市", "臺北市", "新北市", "臺中市", "高雄市"]

def main() -> int:
    bad = 0
    for cfg in S.EVENTS:
        if cfg["city"] not in SAMPLE:
            continue
        label = f'{cfg["city"]}{cfg["office"]}'
        try:
            ev = S.fetch_event(cfg["id"])
            raw = S.fetch_all_trades(cfg["id"])
        except Exception as e:
            print(f"✗ {label:<12} {type(e).__name__}: {e}")
            bad += 1
            continue

        trades = [S.slim_trade(t) for t in raw]
        # 每個必填欄位各算一次有幾筆是空的
        holes = {}
        for k in ("timestamp", "conditionId", "asset", "side",
                  "size", "price", "proxyWallet", "transactionHash"):
            n = sum(1 for t in trades if t.get(k) in (None, "")) 
            if n:
                holes[k] = n

        wallets = {t["proxyWallet"] for t in trades if t.get("proxyWallet")}
        conds = {m["conditionId"] for m in ev["markets"]}
        orphan = sum(1 for t in trades if t.get("conditionId") not in conds)

        ok = not holes and orphan == 0 and len(trades) > 0
        print(f'{"✓" if ok else "✗"} {label:<12} '
              f'{len(trades):>6} 筆　{len(wallets):>5} 個錢包　'
              f'盤口 {len(ev["markets"])} 個　對不到盤口 {orphan} 筆'
              + (f'　空欄位 {holes}' if holes else ''))
        if not ok:
            bad += 1

        if trades and cfg["city"] == "基隆市":
            print("  範例一筆：")
            for k, v in trades[0].items():
                print(f"    {k:<16} {v}")

    print()
    print("全部通過" if bad == 0 else f"有 {bad} 個縣市不合格")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
