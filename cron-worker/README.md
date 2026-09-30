# cron-worker

每 5 分鐘叫 GitHub 跑一次 `snapshot.yml` 的 Cloudflare Worker。

## 為什麼需要它

GitHub 對免費／公開 repo 的**排程**有節流。2026-09-22 實測：

| workflow 裡的 cron | 實際平均間隔 |
|---|---|
| 每 3 小時 | 4.6 小時 |
| 每 1 小時 | 4.3 小時（執行率 17%） |

把 cron 寫得再密都沒用，GitHub 給這個 repo 的排程大約就是一天 5～6 次。

但**手動觸發不受這個限制**——按 Run workflow 都是秒級啟動。
這支 Worker 做的事，就是每 5 分鐘幫忙按一次那顆按鈕（呼叫 GitHub 的
`workflow_dispatch` API）。

`snapshot.yml` 裡原本的排程保留不動，當作這支 Worker 掛掉時的備援。

⚠️ 每 5 分鐘一次代表**一天 288 個 commit**。因為 `data-*.json` 的 `fetched_at`
每輪都會變，workflow 的「有變動才 commit」判斷一定成立，所以每次執行都會產生
commit，GitHub Pages 也會跟著重新部署一次。

## 安裝

需要一個 Cloudflare 帳號（免費方案就夠，不用信用卡）。

```bash
cd cron-worker
npx wrangler login                    # 開瀏覽器授權
npx wrangler secret put GITHUB_TOKEN  # 貼上 GitHub 細粒度 token
npx wrangler deploy
```

### GitHub token 怎麼產

<https://github.com/settings/personal-access-tokens> → Generate new token

- **Repository access**：Only select repositories → 只選 `keelung-polymarket-tracker`
- **Permissions**：Repository permissions → **Actions** 設成 **Read and write**
  （其他全部留 No access）
- **Expiration**：最長可選 1 年。到期前 GitHub 會寄信提醒，過期後這支
  Worker 會開始回 401，`wrangler tail` 看得到。

權限刻意縮到最小：這把 token 外流的話，別人能做的只有「觸發這個 repo 的
workflow」，改不了程式碼，也碰不到其他 repo。

## 驗證

```bash
npx wrangler tail                     # 開著看即時 log
```

最多等 5 分鐘，應該會看到 `✅ 已觸發 snapshot.yml`。
不想等就用 `npx wrangler dev --test-scheduled` 手動打一次排程事件。

GitHub 那邊對應的紀錄會出現在 Actions 頁面，Event 欄位顯示 `workflow_dispatch`。

## 費用

Workers 免費方案每天 10 萬次請求，這支一天 288 次，
用量是上限的千分之三。不會產生費用。
