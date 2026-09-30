#!/usr/bin/env python3
"""
判斷這一輪抓到的資料值不值得留一個 commit。

背景：外部排程改成每 5 分鐘觸發後，一天會跑 288 次。如果照 git 的原始判斷
（檔案位元組有沒有變）來決定要不要 commit，那答案永遠是「要」——因為
data-*.json 裡的 fetched_at 每輪都不一樣。一天 288 個沒有意義的 commit，
repo 會迅速膨脹，git pull 也會愈來愈慢。

所以改成看「這個監控盤真正關心的東西有沒有變」：

  會觸發 commit
    - 任何縣市的成交明細有變（有新成交）
    - 錢包名冊出現新錢包
    - 新進錢包名單有新項目

  不會單獨觸發，但有 commit 時會一起寫進去
    - 各種時間戳（fetched_at、updated_at）
    - 盤口的賠率、流動性、總成交量
    - 錢包的全站預測次數（traded）

後面那三類為什麼不算數：它們會自己一直跳動，跟「有沒有人在這個盤下注」無關。
盤口賠率會因為做市商調單而變、traded 會因為那個錢包在 Polymarket 其他市場
（跟台灣選舉無關）交易而變。讓這些東西觸發 commit，等於回到每輪都 commit。

代價是：沒有新成交的那段時間，快照裡的賠率會停在最後一次 commit 的數字。
但沒有成交的時候賠率本來就不太會動，而且網頁連得到 API 時是直接讀即時賠率，
快照只是連不上時的備援。

用法（回傳值就是答案）：
    python3 scripts/should_commit.py && echo "要 commit"
    exit 0 = 有實質變動，該 commit
    exit 1 = 只有雜訊，跳過
"""

import glob
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def head_version(path: str):
    """讀 HEAD 版本的檔案；檔案是新增的就回傳 None"""
    r = subprocess.run(["git", "show", f"HEAD:{path}"],
                       capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def working_version(path: str):
    full = os.path.join(ROOT, path)
    if not os.path.exists(full):
        return None
    try:
        with open(full, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


# ── 各檔案要拿哪一部分來比對 ────────────────────────────────

def key_data(d):
    """成交明細：只看逐筆成交，不看 event（賠率／流動性／成交量）"""
    return None if d is None else d.get("trades")


def key_roster(d):
    """錢包名冊：只看有哪些錢包，不看 updated_at 與衍生的 count"""
    if d is None:
        return None
    return {k: sorted(v) for k, v in (d.get("events") or {}).items()}


def key_new_wallets(d):
    """新進錢包名單：只看有哪些項目"""
    if d is None:
        return None
    return sorted(f"{w.get('event_id')}:{w.get('wallet')}"
                  for w in (d.get("wallets") or []))


def key_profiles(d):
    """
    錢包檔案：只看「有沒有新錢包、名字或參與縣市有沒有變」。
    traded（全站預測次數）刻意不算——那個數字會因為錢包在其他市場交易而變動，
    跟台灣選舉盤沒關係。
    """
    if d is None:
        return None
    return {w: {"name": p.get("name"), "pseudonym": p.get("pseudonym"),
                "created_at": p.get("created_at"), "cities": sorted(p.get("cities") or [])}
            for w, p in (d.get("wallets") or {}).items()}


CHECKS = [("seen_wallets.json", key_roster, "錢包名冊"),
          ("new-wallets.json", key_new_wallets, "新進錢包名單"),
          ("wallet-profiles.json", key_profiles, "錢包檔案")]


def main() -> int:
    changed = []

    for path in sorted(glob.glob(os.path.join(ROOT, "data-*.json"))):
        rel = os.path.relpath(path, ROOT)
        if key_data(working_version(rel)) != key_data(head_version(rel)):
            changed.append(f"{rel}（成交明細）")

    for rel, fn, label in CHECKS:
        if fn(working_version(rel)) != fn(head_version(rel)):
            changed.append(f"{rel}（{label}）")

    if changed:
        print(f"  有實質變動（{len(changed)} 項）：")
        for c in changed[:8]:
            print(f"    - {c}")
        if len(changed) > 8:
            print(f"    - …還有 {len(changed) - 8} 項")
        return 0

    print("  只有時間戳／賠率／全站次數在動，沒有新成交也沒有新錢包")
    return 1


if __name__ == "__main__":
    sys.exit(main())
