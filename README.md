# 2026 基隆市長選舉 · Polymarket 下注監控

追蹤 Polymarket 上「Keelung Mayor Election Winner」（Event ID `848410`）這個賭盤的
即時賠率與每一筆成交明細，包含下單錢包地址、顯示名稱、買賣方向、金額與時間。

盤口 2026-08-14 開盤，2026-11-28 到期。

---

## 這個東西為什麼要這樣設計

**Polymarket 封鎖台灣 IP。** 這是整套架構的前提。

直接用瀏覽器打 `polymarket.com` 的 API，在台灣會連不上；掛 VPN 才通。
所以資料來源做成**兩條腿**，網頁會自己選能走的那條。

而且要用到的兩個 API 穩定度差很多，所以它們是**分開判斷**的：

| API | 用途 | 從瀏覽器直連 |
|---|---|---|
| Data API | 每一筆成交明細（核心資料） | 穩定 |
| Gamma API | 盤口賠率、成交量、流動性 | **時好時壞** |

Gamma API 的請求送得到伺服器，但 Cloudflare 有時回傳的內容不帶
`access-control-allow-origin` 標頭，瀏覽器就擋下來了。
（用 `curl` 測反而會成功，因為拿到的是快取版本——所以不要用 curl 判斷瀏覽器能不能連。）

因此實際行為有三種：

```
開啟網頁 → 同時試「成交明細」和「盤口賠率」（各自重試 3 次）
  │
  ├─ 兩個都成功 ─────────→ 🟢 即時直連，無提示
  │
  ├─ 成交成功、盤口失敗 ─→ 🟢 即時直連 ＋ 一行說明：
  │                          「賠率是 X 時間的快照值，成交紀錄是當下最新」
  │
  └─ 成交也失敗 ─────────→ 🟡 快照資料，提示連 VPN
```

關鍵是**成交明細抓得到就算即時**——賠率抓不到只是換個來源，不該讓整頁降級。
中間那種混合狀態一定會在畫面上講清楚哪個是舊的、哪個是新的，
**不會讓人誤把舊資料當成當下行情**。

快照由 `scripts/snapshot.py` 產生。它可以在你自己電腦跑（要開 VPN），
也可以掛在 GitHub Actions 上跑——**GitHub 的機器在美國，不受台灣封鎖影響**，
等於免費幫你顧一台永遠連得到 Polymarket 的機器。

---

## 檔案結構

```
keelung_polymarket/
├── index.html                     前端入口
├── app.js                         全部前端邏輯（抓取、篩選、三種視圖、CSV）
├── style.css                      樣式（深色為主，可切淺色）
├── data.json                      ← 最新快照，前端連不到 API 時讀這個
│
├── scripts/
│   └── snapshot.py                抓取腳本（純標準庫，不用 pip install）
│
├── seen_wallets.json              ← 已知錢包名冊，新錢包偵測的依據
│
├── snapshots/
│   └── YYYY-MM-DD.json            每天一份存檔，做歷史留存
│
└── .github/workflows/snapshot.yml GitHub Actions 排程（每 3 小時）＋ 寄信
```

---

## 怎麼用

### 本機看

```bash
cd keelung_polymarket
python3 -m http.server 8765
```

然後開 <http://localhost:8765/index.html>。

> 不能直接用滑鼠雙擊 `index.html` 開啟。用 `file://` 開的話瀏覽器會擋掉讀取
> `data.json` 的請求，一定要透過上面的小伺服器。

### 手動更新快照（需要 VPN）

```bash
python3 scripts/snapshot.py
```

會同時更新 `data.json` 和 `snapshots/當天日期.json`。

### 上線給別人看

1. 把這個資料夾推到 GitHub，Settings → Pages 選擇從 main 分支的根目錄發布
2. Actions 會自動照 `.github/workflows/snapshot.yml` 每 3 小時抓一次快照並 commit
3. 沒有 VPN 的人打開網站會走快照模式，你自己開 VPN 打開就是即時模式

---

## 三種檢視模式

| 模式 | 用途 |
|---|---|
| **📋 表格** | 每筆成交一列，可依任一欄位排序、分頁，適合逐筆核對 |
| **📰 動態** | 卡片式時間軸，適合快速掃過最近有誰在下注 |
| **👛 錢包** | 依錢包彙總：累計筆數、買進/賣出金額、淨投入、押注標的、首次進場時間 |

錢包視圖會把**開盤 24 小時內就進場**的錢包標記出來——早期交易者可能有資訊優勢，
是值得優先看的對象。這個時間窗可以在 `app.js` 的 `EARLY_WINDOW_H` 調整。

所有錢包地址都可以點擊：連到 Polygonscan 看鏈上紀錄，或連到 Polymarket 個人頁。
滑鼠移到地址上會出現複製按鈕。

---

## 新錢包進場的郵件通知

每次抓完資料後，比對 `seen_wallets.json` 名冊，**出現從未見過的錢包就寄信**。
信裡列出每個新錢包的首筆動作（押哪位候選人、買賣、Yes/No、股數、成交價、金額），
以及 Polygonscan 地址、Polymarket 個人頁、該筆交易三個直達連結。

主旨會標註筆數，首筆金額超過 $50 的會加註「其中 N 筆逾 $50」，
讓人從手機通知欄就能判斷輕重。

### 需要的 GitHub Secret

| 名稱 | 內容 | 必填 |
|---|---|---|
| `MAIL_USERNAME` | 寄件的 Gmail 地址 | 是 |
| `MAIL_PASSWORD` | Google **應用程式密碼**（16 碼，不是登入密碼） | 是 |
| `MAIL_TO` | 收件地址 | 否，預設寄給自己 |

應用程式密碼在 <https://myaccount.google.com/apppasswords> 產生（需先開兩步驟驗證），
只能用來寄信，隨時可撤銷。設定方式：

```bash
gh secret set MAIL_USERNAME --body "你的信箱@gmail.com"
gh secret set MAIL_PASSWORD          # 執行後貼上 16 碼
```

### 寄測試信

到 Actions → snapshot → **Run workflow**，勾選「寄一封測試信」。

它會拿**最近進場的錢包**組一封標示為測試的信寄出，內容格式與真實通知完全相同——
測試信長什麼樣，真信就長什麼樣。**不會動到名冊**，可以放心重複測試。
換信箱、或懷疑通知壞掉時都用這個驗證。

### 為什麼名冊要獨立成一個檔

不從 `data.json` 反推「看過哪些錢包」，是因為 `data.json` 有 `MAX_OFFSET`（10000 筆）上限。
將來筆數成長到會截斷時，早期的錢包會從資料裡消失，被誤判成新錢包而爆寄一整批信。

名冊不存在或內容損毀時，程式會**重建基準線並跳過寄信**。
否則第一次啟用這個功能就會一口氣寄出所有歷史錢包，變成騷擾。

要重新建立基準線（例如想把現況全部視為「已知」），刪掉 `seen_wallets.json`
再跑一次即可，該次不會寄信。

---

## 候選人中文對照

Polymarket 只提供英文拼音，中文是人工對照的。改 `app.js` 最上面這段即可：

```js
const CANDIDATES = {
  'Hsieh Kuo-liang': { zh: '謝國樑', party: 'kmt', partyZh: '國民黨' },
  'Tung Tzu-wei':    { zh: '童子瑋', party: 'dpp', partyZh: '民進黨' },
  'Other':           { zh: '其他人選', party: 'tbd', partyZh: '' },
};
```

這個 event 底下有 **29 個 market**，但只有上面兩位是真的候選人，
其餘 27 個是 `Candidate A` ～ `Candidate Z` 的佔位盤口（成交量 0、賠率固定 0.5）。
前端預設把沒人下注的佔位盤口隱藏起來，只在下方標註還有幾個。
之後若有新人參選、佔位盤口被改成真名，把新名字加進上面的對照表就會自動顯示。

---

## 資料來源與欄位

| API | 用途 | 認證 |
|---|---|---|
| `gamma-api.polymarket.com/events?id=848410` | 盤口賠率、成交量、流動性 | 不需要 |
| `data-api.polymarket.com/trades?eventId=848410&takerOnly=true` | 每一筆成交明細 | 不需要 |

`takerOnly=true` 很重要：鏈上每筆撮合都有 maker、taker 兩方，
不加這個參數會把同一筆交易算成兩筆，成交數直接膨脹一倍。

**資料判讀要注意的兩件事：**

- `name` / `pseudonym` 是使用者在 Polymarket 上的公開暱稱，**不是實名**。
  部分帳號的 `name` 是系統自動填的錢包地址字串（例如 `0xfBd8...-1779347618060`），
  程式會辨識出來並改用 pseudonym 或標示為「未具名」。
- 錢包地址是 Polymarket 幫每個帳號部署的 **proxy 合約錢包**，
  不是使用者自己持有私鑰的 EOA。要往上游追資金來源，還要看這個 proxy 錢包
  是從哪個地址存入、由哪個 Relayer 代付 gas。

---

## 已知限制

- **Data API 的 `offset` 上限是 10000**。這個盤目前才 40 筆，短期內不會碰到；
  真的成長到那個量級時，`snapshot.py` 要改用 `start`/`end` 時間窗分段抓。
- **GitHub Actions 的 cron 常有數分鐘到十幾分鐘延遲**，這是 GitHub 的正常現象，
  不是腳本壞掉。要真正即時就用直連模式（開 VPN）。
- **改完 `app.js` 或 `style.css` 要記得把 `index.html` 裡的 `?v=` 數字加一**，
  否則瀏覽器會一直用快取的舊版本。
  網頁載入時 console 會印出 `[基隆選舉監控] app.js v5`，
  版號跟你剛改的對不上就是中了快取，按 `Cmd+Shift+R` 強制重新載入。

## 更新頻率

| 什麼 | 多久一次 | 改哪裡 |
|---|---|---|
| 網頁自動重抓 | 5 分鐘 | `app.js` 的 `REFRESH_INTERVAL` |
| Actions 抓快照＋檢查新錢包 | 3 小時 | `.github/workflows/snapshot.yml` 的 `cron` |

也就是說**新錢包通知最慢會延遲 3 小時**。選前想更即時就把 cron 調密一點。

這個盤十天才約 40 筆成交，抓太密只是重複拿同一份資料，
還會讓 repo 累積大量內容相同、只有時間戳不同的 commit。
想看當下最新，隨時可以按網頁右上角的 **↻** 手動更新。

---

## 架構參考來源

概念參考自 [tw-election-2026-tracker](https://github.com/waynelord0628-beep/tw-election-2026-tracker-)
（全國地方選舉政黨盤），沿用了它的深色介面風格與雙視圖設計，
但抓取邏輯、分組維度（政黨 → 候選人）、資料來源策略均為重寫。

主要差異：原專案靠一台 VPS 常駐 Python 程式抓資料再 git push，
單點故障且需要自行維運（其線上資料已停更）；這裡改為前端直連優先、
GitHub Actions 快照備援，不需要任何伺服器。
