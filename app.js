/* ============================================================
   2026 台灣地方選舉 · Polymarket 下注監控
   ------------------------------------------------------------
   多縣市版：頂端頁簽切換，每個縣市對應一個 Polymarket event。

   資料來源雙軌：
     1) 直連 Polymarket API（需能連到 polymarket.com，台灣可能被擋 → 需 VPN）
     2) 直連失敗時自動改讀 data-<eventId>.json 快照（由 GitHub Actions 產生）
   ============================================================ */

'use strict';

// 版號跟 index.html 的 ?v= 對應。若 console 印出的版號跟你剛改的不一樣，
// 代表瀏覽器讀的是快取的舊檔，按 Cmd+Shift+R 強制重新載入。
const APP_VERSION = 18;
console.log(`[選舉賭盤監控] app.js v${APP_VERSION}`);

// ── 設定 ────────────────────────────────────────────────────
const GAMMA_API        = 'https://gamma-api.polymarket.com';
const DATA_API         = 'https://data-api.polymarket.com';
const REFRESH_INTERVAL = 300000;  // 5 分鐘。這些盤成交稀疏，刷得再密也只是重複
                                  // 抓同一份資料。想看當下最新可按右上角的 ↻。
const LIVE_TIMEOUT     = 8000;    // 直連逾時（毫秒），逾時就改走快照
const RETRY_ATTEMPTS   = 3;       // 直連失敗時的重試次數（含第一次）
const RETRY_DELAY      = 700;     // 重試間隔（毫秒）
const TRADE_PAGE_SIZE  = 500;     // 每次向 API 要幾筆
const MAX_TRADES       = 10000;   // Data API 的 offset 上限
const EARLY_WINDOW_H   = 24;      // 開盤後幾小時內進場算「早期交易者」

/**
 * 各縣市賭盤設定。要新增縣市就在這裡加一筆，其餘程式碼完全不用動。
 *
 * ⚠️ 中文名一律以這張表為準，不要用 Polymarket 網站上的中文翻譯——
 *    他們的 zh-hant 是機器翻譯且有誤（例如把 Magistrate／縣長 譯成「治安法官」）。
 *    這裡的中文是人工對照 API 回傳的英文拼音（groupItemTitle）而來。
 *
 * ⚠️ party 只填確定的，沒把握的一律留空（顯示為中性灰）。
 *    寧可不標，也不要標錯——標錯會影響判讀。要補就直接改這裡。
 */
const EVENTS = [
  {
    id: 848410, slug: 'keelung', city: '基隆市', office: '市長',
    candidates: {
      'Hsieh Kuo-liang': { zh: '謝國樑', party: 'kmt', partyZh: '國民黨' },
      'Tung Tzu-wei':    { zh: '童子瑋', party: 'dpp', partyZh: '民進黨' },
    },
  },
  {
    id: 848341, slug: 'taipei', city: '臺北市', office: '市長',
    candidates: {
      'Chiang Wan-an': { zh: '蔣萬安', party: 'kmt', partyZh: '國民黨' },
      'Puma Shen':     { zh: '沈伯洋', party: 'dpp', partyZh: '民進黨' },
      'Kuo Hsi':       { zh: '郭錫', party: 'tbd', partyZh: '' },
    },
  },
  {
    id: 848347, slug: 'new-taipei', city: '新北市', office: '市長',
    candidates: {
      'Lee Shu-chuan':  { zh: '李四川', party: 'kmt', partyZh: '國民黨' },
      'Su Chiao-hui':   { zh: '蘇巧慧', party: 'dpp', partyZh: '民進黨' },
      'Huang Kuo-chang':{ zh: '黃國昌', party: 'tpp', partyZh: '民眾黨' },
    },
  },
  {
    id: 848370, slug: 'taoyuan', city: '桃園市', office: '市長',
    candidates: {
      // ⚠️ API 的英文名是 Chang San-cheng（張善政），Polymarket 中文介面顯示「鄭文燦」。
      //    兩者是不同人。此處依 Ches 判斷採用「鄭文燦」；政黨因此存疑，留空不標。
      'Chang San-cheng':  { zh: '鄭文燦', party: 'tbd', partyZh: '' },
      'Huang Shih-chieh': { zh: '黃世傑', party: 'tbd', partyZh: '' },
      'Perng Shaw-jiin':  { zh: '彭紹瑾', party: 'tbd', partyZh: '' },
    },
  },
  {
    id: 848409, slug: 'kaohsiung', city: '高雄市', office: '市長',
    candidates: {
      'Lai Jui-lung':   { zh: '賴瑞隆', party: 'dpp', partyZh: '民進黨' },
      'Ko Chih-en':     { zh: '柯志恩', party: 'kmt', partyZh: '國民黨' },
      'Chang Ching':    { zh: '張清', party: 'tbd', partyZh: '' },
      'Hsu Chih-chieh': { zh: '許智傑', party: 'dpp', partyZh: '民進黨' },
      'Chiu Yi-ying':   { zh: '邱議瑩', party: 'dpp', partyZh: '民進黨' },
      'Lin Tai-hua':    { zh: '林岱樺', party: 'dpp', partyZh: '民進黨' },
    },
  },
  {
    id: 848435, slug: 'hsinchu-city', city: '新竹市', office: '市長',
    candidates: {
      'Ann Kao':            { zh: '高虹安', party: 'tbd', partyZh: '無黨籍' },
      'Chuang Ching-cheng': { zh: '莊競程', party: 'dpp', partyZh: '民進黨' },
      'Ho Chih-yung':       { zh: '何志勇', party: 'tbd', partyZh: '無黨籍' },
    },
  },
  {
    id: 848418, slug: 'hsinchu-county', city: '新竹縣', office: '縣長',
    candidates: {
      'Hsu Hsin-ying':    { zh: '徐欣瑩', party: 'kmt', partyZh: '國民黨' },
      'Cheng Chao-fang':  { zh: '鄭朝方', party: 'dpp', partyZh: '民進黨' },
      'Lin Szu-ming':     { zh: '林思銘', party: 'kmt', partyZh: '國民黨' },
      'Chen Chien-hsien': { zh: '陳見賢', party: 'kmt', partyZh: '國民黨' },
    },
  },
  {
    id: 848417, slug: 'yilan', city: '宜蘭縣', office: '縣長',
    candidates: {
      'Lin Kuo-chang':  { zh: '林國漳', party: 'dpp', partyZh: '民進黨' },
      'Wu Tsung-hsien': { zh: '吳宗憲', party: 'kmt', partyZh: '國民黨' },
      // 以下兩位未見於 2026-09-07 的參選名單，中譯沿用先前對照
      'Chen Wan-hui':   { zh: '陳琬惠', party: 'tbd', partyZh: '' },
      'Chang Sheng-te': { zh: '張勝得', party: 'tbd', partyZh: '' },
    },
  },
  {
    id: 848453, slug: 'chiayi-city', city: '嘉義市', office: '市長',
    candidates: {
      'Wang Mei-hui':     { zh: '王美惠', party: 'dpp', partyZh: '民進黨' },
      'Chang Chi-kai':    { zh: '張啓楷', party: 'tpp', partyZh: '民眾黨' },
      'Huang Hung-cheng': { zh: '黃宏成', party: 'tbd', partyZh: '無黨籍' },
      'Chen Kai-huang':   { zh: '陳愷璜', party: 'tbd', partyZh: '無黨籍' },
      // 以下兩位未見於 2026-09-07 的參選名單，中譯沿用先前對照
      'Weng Shou-liang':  { zh: '翁淑良', party: 'tbd', partyZh: '' },
      'Chen Chia-ping':   { zh: '陳家平', party: 'tbd', partyZh: '' },
    },
  },
  {
    id: 848436, slug: 'miaoli', city: '苗栗縣', office: '縣長',
    candidates: {
      'Chung Tung-chin': { zh: '鍾東錦', party: 'kmt', partyZh: '國民黨' },
      'Chen Pin-an':     { zh: '陳品安', party: 'dpp', partyZh: '民進黨' },
    },
  },
  {
    id: 848407, slug: 'taichung', city: '臺中市', office: '市長',
    candidates: {
      'Johnny Chiang':    { zh: '江啟臣', party: 'kmt', partyZh: '國民黨' },
      'Yang Chiung-ying': { zh: '楊瓊瓔', party: 'kmt', partyZh: '國民黨' },
      'Ho Hsin-chun':     { zh: '何欣純', party: 'dpp', partyZh: '民進黨' },
    },
  },
  {
    id: 848408, slug: 'tainan', city: '臺南市', office: '市長',
    candidates: {
      'Chen Ting-fei':    { zh: '陳亭妃', party: 'dpp', partyZh: '民進黨' },
      'Hsieh Lung-chieh': { zh: '謝龍介', party: 'kmt', partyZh: '國民黨' },
      'Lin Yi-feng':      { zh: '林宜瑾', party: 'dpp', partyZh: '民進黨' },
      'Lin Chun-hsien':   { zh: '林俊憲', party: 'dpp', partyZh: '民進黨' },
    },
  },
  {
    id: 848438, slug: 'changhua', city: '彰化縣', office: '縣長',
    candidates: {
      'Wei Ping-cheng':  { zh: '魏平政', party: 'kmt', partyZh: '國民黨' },
      'Chen Su-yueh':    { zh: '陳素月', party: 'dpp', partyZh: '民進黨' },
      'Chiu Chien-fu':   { zh: '邱建富', party: 'tbd', partyZh: '無黨籍' },
      // 以下未見於 2026-09-07 的參選名單，中譯沿用先前對照
      'Lin Shih-hsien':  { zh: '林世賢', party: 'tbd', partyZh: '' },
      'Huang Hsiu-fang': { zh: '黃秀芳', party: 'tbd', partyZh: '' },
      // ⚠️ Hung Jung-chang 中譯仍未確認，保留英文拼音
    },
  },
  {
    id: 848447, slug: 'nantou', city: '南投縣', office: '縣長',
    candidates: {
      'Hsu Shu-hua':     { zh: '許淑華', party: 'kmt', partyZh: '國民黨' },
      'Wen Shih-cheng':  { zh: '溫世政', party: 'dpp', partyZh: '民進黨' },
    },
  },
  {
    id: 848448, slug: 'yunlin', city: '雲林縣', office: '縣長',
    candidates: {
      'Chang Chia-chun': { zh: '張嘉郡', party: 'kmt', partyZh: '國民黨' },
      'Liu Chien-kuo':   { zh: '劉建國', party: 'dpp', partyZh: '民進黨' },
    },
  },
  {
    id: 848449, slug: 'chiayi-county', city: '嘉義縣', office: '縣長',
    candidates: {
      'Tsai Yi-yu':  { zh: '蔡易餘', party: 'dpp', partyZh: '民進黨' },
      'Wu Pin-jui':  { zh: '吳品叡', party: 'tbd', partyZh: '無黨籍' },
      // ⚠️ Tsai Sung-yi 中譯仍未確認，保留英文拼音
    },
  },
  {
    id: 848479, slug: 'pingtung', city: '屏東縣', office: '縣長',
    candidates: {
      'Chou Chun-mi':   { zh: '周春米', party: 'dpp', partyZh: '民進黨' },
      'Su Ching-chuan': { zh: '蘇清泉', party: 'kmt', partyZh: '國民黨' },
    },
  },
  {
    id: 848480, slug: 'hualien', city: '花蓮縣', office: '縣長',
    candidates: {
      'Yu Shu-chen':    { zh: '游淑貞', party: 'kmt', partyZh: '國民黨' },
      'Chang Chun':     { zh: '張峻', party: 'tbd', partyZh: '無黨籍' },
      'Wei Chia-hsien': { zh: '魏嘉賢', party: 'tbd', partyZh: '無黨籍' },
      'Lo Pei-chin':    { zh: '羅佩秦', party: 'tbd', partyZh: '台灣工黨' },
      // ⚠️ Yeh Yao-hui 中譯仍未確認，保留英文拼音
    },
  },
  {
    id: 848481, slug: 'taitung', city: '臺東縣', office: '縣長',
    candidates: {
      'Wu Hsiu-hua':     { zh: '吳秀華', party: 'kmt', partyZh: '國民黨' },
      'Chen Ying':       { zh: '陳瑩', party: 'dpp', partyZh: '民進黨' },
      'Li Wu Ying-chih': { zh: '李吳穎智', party: 'tbd', partyZh: '無黨籍' },
    },
  },
];

/** 目前選中的縣市。由網址 hash 決定（例如 #taipei），預設基隆。 */
let activeEvent = EVENTS[0];

// ── 狀態 ────────────────────────────────────────────────────
let eventMeta   = null;   // { title, startDate, endDate, volume, liquidity }
let markets     = [];     // 正規化後的候選人盤口
let marketById  = {};     // conditionId → market
let allTrades   = [];     // 正規化後的成交明細（新→舊）
let prevKeys    = new Set();
// 成交明細與盤口賠率的來源分開記錄——Gamma API（賠率）從瀏覽器直連常被 CORS 擋，
// 但 Data API（成交明細）通常是通的，兩者不該互相拖累。
let tradesSource = 'loading';  // 'live' | 'snapshot' | 'error'
let oddsSource   = 'loading';  // 'live' | 'snapshot' | 'error'
let snapshotAt   = null;
// 錢包帳號資訊（加入時間、全站預測次數），由 Actions 抓好存成靜態檔，
// 所以沒有 VPN 也讀得到。整站共用一份，切換縣市不需要重載。
let walletProfiles = null;
let firstLoad   = true;

let viewMode = 'table';        // 'table' | 'feed' | 'wallet'
let filters  = { cands: [], sides: [], outcomes: [], minUsd: null, maxUsd: null, dateStart: '', dateEnd: '', search: '' };
let sortCol  = 'ts';
let sortDir  = 'desc';
let pageSize = 50;
let currentPage = 1;

// ── 小工具 ──────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const fmt = (n, d = 2) => (n ?? 0).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtInt = (n) => (n ?? 0).toLocaleString('zh-TW');
const shortAddr = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const shortHash = (h) => h ? h.slice(0, 8) + '…' + h.slice(-6) : '';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** epoch 毫秒 → 台北時間字串 */
function tpeTime(ms, withSec = true) {
  const d = new Date(ms);
  const p = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', ...(withSec ? { second: '2-digit' } : {}), hour12: false,
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` + (withSec ? `:${p.second}` : '');
}

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** YYYY-MM-DD（視為台北時間）→ epoch 毫秒 */
function dateToMs(val, endOfDay = false) {
  if (!val) return null;
  const ms = Date.parse(`${val}T${endOfDay ? '23:59:59' : '00:00:00'}+08:00`);
  return Number.isNaN(ms) ? null : ms;
}

function copyBtn(value, label = '複製') {
  return `<button class="copy-btn" data-copy="${escapeHtml(value)}" title="${label} ${escapeHtml(value)}">⧉</button>`;
}

function candInfo(title) {
  const table = activeEvent.candidates;
  if (table[title]) return table[title];
  if (title === 'Other') return { zh: '其他人選', party: 'tbd', partyZh: '' };
  const m = /^Candidate ([A-Z])$/.exec(title || '');
  if (m) return { zh: `未定人選 ${m[1]}`, party: 'tbd', partyZh: '待定' };
  // 對照表沒有的名字：顯示英文原文，才不會把不認識的候選人吃掉
  return { zh: title || '未知', party: 'tbd', partyZh: '' };
}

function polygonscanTx(h)      { return `https://polygonscan.com/tx/${h}`; }
function polygonscanAddr(a)    { return `https://polygonscan.com/address/${a}`; }
function polymarketProfile(a)  { return `https://polymarket.com/profile/${a}`; }

/** OKLink 的 Polygon 位址頁（繁中介面），另一個鏈上瀏覽器視角 */
function oklinkAddr(a)         { return `https://www.oklink.com/zh-hant/polygon/address/${a}`; }

/**
 * relay.link 的跨鏈轉帳查詢。
 * Polymarket 跑在 Polygon 上，抵押資產多半是橋接生成的 USDC.e 而非原生 USDC，
 * 要回溯資金的原始來源鏈就得查跨鏈橋紀錄。
 */
function relayLinkAddr(a)      { return `https://relay.link/transactions?address=${a}`; }

// ── 資料抓取 ────────────────────────────────────────────────

function fetchJson(url, timeout = LIVE_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .finally(() => clearTimeout(timer));
}

/**
 * 帶重試的 fetchJson。
 * 透過 VPN 連線時，對某個網域的第一個請求偶爾會失敗一次（連線冷啟動），
 * 若不重試就會誤判成「被封鎖」而整頁降級到快照模式。
 */
async function fetchJsonRetry(url, attempts = RETRY_ATTEMPTS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        console.warn(`[重試 ${i + 1}/${attempts - 1}] ${url.split('?')[0]} — ${e.message}`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
  }
  throw lastErr;
}

/**
 * 直連抓成交明細（Data API）。
 * 這是核心資料，實測從瀏覽器直連相當穩定。
 */
async function fetchTradesLive(eventId) {
  const trades = [];
  for (let offset = 0; offset < MAX_TRADES; offset += TRADE_PAGE_SIZE) {
    const batch = await fetchJsonRetry(
      `${DATA_API}/trades?eventId=${eventId}&takerOnly=true&limit=${TRADE_PAGE_SIZE}&offset=${offset}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    trades.push(...batch);
    if (batch.length < TRADE_PAGE_SIZE) break;
  }
  return trades;
}

/**
 * 直連抓盤口賠率（Gamma API）。
 *
 * ⚠️ 這個端點從瀏覽器直連並不可靠：Cloudflare 有時會回傳不含 CORS 標頭的回應，
 * 瀏覽器就會擋下來（用 curl 測反而會成功，因為拿到的是快取版本）。
 * 所以這裡失敗屬於預期內，呼叫端要能改用快照裡的盤口資料，
 * 不可以因此把整頁降級成快照模式。
 */
async function fetchEventLive(eventId) {
  const evArr = await fetchJsonRetry(`${GAMMA_API}/events?id=${eventId}`);
  const ev = Array.isArray(evArr) ? evArr[0] : evArr;
  if (!ev) throw new Error('event 不存在');
  return ev;
}

/**
 * 載入錢包帳號資訊。只在第一次進錢包視圖時抓一次，失敗就當作沒有，
 * 卡片照常顯示其餘欄位，不影響主要功能。
 */
async function loadWalletProfiles() {
  if (walletProfiles) return walletProfiles;
  try {
    const d = await fetchJson(`wallet-profiles.json?t=${Date.now()}`, 15000);
    walletProfiles = d.wallets || {};
  } catch (e) {
    console.warn('[帳號資訊讀取失敗]', e.message);
    walletProfiles = {};
  }
  return walletProfiles;
}

/** 備援：讀 GitHub Actions 產生的快照（每個縣市一支檔） */
async function loadSnapshot(eventId) {
  const d = await fetchJson(`data-${eventId}.json?t=${Date.now()}`, 15000);
  if (!d || !d.event) throw new Error('快照格式不正確');
  return { event: d.event, trades: d.trades || [], fetchedAt: Date.parse(d.fetched_at) || null };
}

/** 把 gamma event 正規化成候選人盤口陣列 */
function normalizeMarkets(ev) {
  eventMeta = {
    title: ev.title,
    slug: ev.slug,
    startMs: Date.parse(ev.startDate) || null,
    endMs: Date.parse(ev.endDate) || null,
    volume: Number(ev.volume) || 0,
    liquidity: Number(ev.liquidity) || 0,
  };

  const parseArr = (v) => {
    if (Array.isArray(v)) return v;
    try { return JSON.parse(v || '[]'); } catch { return []; }
  };

  markets = (ev.markets || []).map((m) => {
    const prices = parseArr(m.outcomePrices).map(Number);
    const info = candInfo(m.groupItemTitle);
    return {
      conditionId: m.conditionId,
      title: m.groupItemTitle,
      zh: info.zh,
      party: info.party,
      partyZh: info.partyZh,
      question: m.question,
      yesPrice: prices[0] ?? null,
      volume: Number(m.volumeNum ?? m.volume) || 0,
      liquidity: Number(m.liquidityNum ?? m.liquidity) || 0,
      tokenIds: parseArr(m.clobTokenIds),
    };
  });

  marketById = {};
  markets.forEach((m) => { marketById[m.conditionId] = m; });
}

/**
 * 取交易者顯示名稱。
 * 部分帳號的 name 欄位是系統自動填的錢包地址字串（例如
 * "0xfBd8C9C22cA76B3662d0e53A4f79719FDC684027-1779347618060"），
 * 那不是真的暱稱，視為未具名處理。
 */
function pickDisplayName(t) {
  const clean = (v) => (v && !/^0x[a-fA-F0-9]{10,}/.test(v)) ? v : '';
  return clean(t.name) || clean(t.pseudonym) || '';
}

/** 把 data-api trade 正規化 */
function normalizeTrades(raw) {
  return raw.map((t) => {
    const m = marketById[t.conditionId];
    // 正常情況下 conditionId 都對得到盤口；對不到時退而從 title 反推候選人名，
    // 例如 "Will Chiang Wan-an win the next Taipei Mayor election?" → "Chiang Wan-an"
    const info = m || candInfo(
      t.title ? t.title.replace(/^Will (.+?) win the next .+? election\?$/, '$1') : '');
    const size = Number(t.size) || 0;
    const price = Number(t.price) || 0;
    const dispName = pickDisplayName(t);
    return {
      ts: (Number(t.timestamp) || 0) * 1000,
      conditionId: t.conditionId,
      cand: info.zh || '未知',
      candEn: (m && m.title) || '',
      party: info.party || 'tbd',
      side: t.side,
      outcome: t.outcome,
      size,
      price,
      total: size * price,
      name: dispName,
      isAnon: !dispName,
      wallet: (t.proxyWallet || '').toLowerCase(),
      hash: t.transactionHash || '',
      key: `${t.transactionHash}|${t.asset}|${t.proxyWallet}|${t.side}|${t.size}`,
    };
  }).sort((a, b) => b.ts - a.ts);
}

async function loadData(manual = false) {
  const btn = $('refreshBtn');
  if (manual) btn.classList.add('spinning');

  // 記下這次請求是為了哪個縣市。使用者若在抓取途中切換頁簽，
  // 回來的舊資料就必須丟棄，否則會把甲縣市的成交畫到乙縣市的畫面上。
  const reqEvent = activeEvent;
  const eventId = reqEvent.id;

  // 兩個 API 各自獨立嘗試，其中一個失敗不影響另一個
  const [tradesRes, eventRes] = await Promise.allSettled([
    fetchTradesLive(eventId), fetchEventLive(eventId),
  ]);
  if (activeEvent !== reqEvent) return;   // 已經切走了，這份結果作廢

  let liveTrades = tradesRes.status === 'fulfilled' ? tradesRes.value : null;
  let liveEvent  = eventRes.status  === 'fulfilled' ? eventRes.value  : null;

  if (!liveTrades) console.warn('[成交明細直連失敗]', tradesRes.reason?.message);
  if (!liveEvent)  console.warn('[盤口直連失敗，改用快照的盤口]', eventRes.reason?.message);

  // 缺哪一塊就從快照補
  let snapshot = null;
  if (!liveTrades || !liveEvent) {
    try {
      snapshot = await loadSnapshot(eventId);
      if (activeEvent !== reqEvent) return;
    } catch (snapErr) {
      if (!liveTrades) {
        console.error('[快照也讀不到]', snapErr.message);
        tradesSource = oddsSource = 'error';
        renderSourceState(tradesRes.reason?.message, snapErr.message);
        if (firstLoad) $('feed').innerHTML = '<div class="empty">目前無法取得任何資料，請見上方說明。</div>';
        btn.classList.remove('spinning');
        return;
      }
    }
  }

  const event     = liveEvent  || snapshot?.event;
  const rawTrades = liveTrades || snapshot?.trades;
  if (!event || !rawTrades) {
    tradesSource = oddsSource = 'error';
    renderSourceState(tradesRes.reason?.message, '快照缺少必要欄位');
    btn.classList.remove('spinning');
    return;
  }

  tradesSource = liveTrades ? 'live' : 'snapshot';
  oddsSource   = liveEvent  ? 'live' : 'snapshot';
  snapshotAt   = snapshot ? snapshot.fetchedAt : null;

  normalizeMarkets(event);
  const fresh = normalizeTrades(rawTrades);

  // 新進來的成交打上高亮
  if (!firstLoad) {
    fresh.forEach((t) => { t.isNew = !prevKeys.has(t.key); });
  }
  prevKeys = new Set(fresh.map((t) => t.key));
  allTrades = fresh;

  renderSourceState();
  renderStats();
  if (firstLoad) buildCandFilter();
  render();

  firstLoad = false;
  setTimeout(() => btn.classList.remove('spinning'), 300);
}

// ── 縣市頁簽 ────────────────────────────────────────────────

/**
 * 依網址 hash 決定要開哪個縣市。
 * 沒有 hash（或 #home）→ 回傳 null，代表顯示地圖首頁。
 */
function eventFromHash() {
  const slug = (location.hash || '').replace(/^#/, '');
  if (!slug || slug === 'home') return null;
  return EVENTS.find((e) => e.slug === slug) || null;
}

// ── 台灣地圖首頁 ────────────────────────────────────────────

/** 地圖上的縣市名 → 設定表裡的 event（沒有盤口的縣市回傳 undefined） */
function eventByCity(name) {
  return EVENTS.find((e) => e.city === name);
}

function renderMap() {
  const svg = $('twMap');
  if (svg.dataset.built) return;          // 只畫一次
  svg.setAttribute('viewBox', `0 0 ${TW_MAP.w} ${TW_MAP.h}`);

  // 圖形與標籤分兩層：所有縣市的圖形先畫完，標籤才畫上去。
  // 否則像嘉義市這種被嘉義縣包住的飛地，標籤會被後畫的鄰縣圖形蓋掉。
  const shapes = TW_MAP.counties.map((c) => {
    const ev = eventByCity(c.name);
    const cls = ev ? 'county has-event' : 'county no-event';
    return `<g class="${cls}" data-city="${escapeHtml(c.name)}"${ev ? ` data-slug="${ev.slug}" role="link" tabindex="0"` : ''}>
      <title>${escapeHtml(c.name)}${ev ? '' : '（未納入監控）'}</title>
      <path d="${c.d}"/>
    </g>`;
  }).join('');

  // 只標有盤口的縣市，避免畫面太雜
  const labels = TW_MAP.counties.filter((c) => eventByCity(c.name)).map((c) =>
    `<text class="county-label" data-city="${escapeHtml(c.name)}"
       x="${c.cx}" y="${c.cy}">${escapeHtml(c.name)}</text>`).join('');

  // 離島是另外縮小擺放的，比例與位置都不是實際的，要標示清楚以免誤讀
  const outly = TW_MAP.counties.filter((c) => c.outlying);
  let inset = '';
  if (outly.length) {
    const xs = [], ys = [];
    outly.forEach((c) => {
      for (const m of c.d.matchAll(/([\d.]+),([\d.]+)/g)) {
        xs.push(+m[1]); ys.push(+m[2]);
      }
    });
    const pad = 14;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    inset = `<g class="inset-note">
      <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="8"/>
      <text x="${x0}" y="${y0 - 8}">離島（非實際比例與位置）</text>
    </g>`;
  }

  svg.innerHTML = inset + shapes + labels;

  const tip = $('mapTip');
  svg.querySelectorAll('.county').forEach((g) => {
    const city = g.dataset.city;
    const slug = g.dataset.slug;

    // 標籤現在畫在圖形層之外，hover 時手動幫它加上 class 才會一起變色
    const label = svg.querySelector(`text.county-label[data-city="${city}"]`);

    g.addEventListener('mouseenter', () => {
      const ev = eventByCity(city);
      if (label) label.classList.add('hot');
      tip.hidden = false;
      tip.innerHTML = ev
        ? `<b>${escapeHtml(ev.city)}${escapeHtml(ev.office)}</b><span>點擊進入</span>`
        : `<b>${escapeHtml(city)}</b><span>尚未納入監控</span>`;
    });
    g.addEventListener('mousemove', (e) => {
      const r = svg.parentElement.getBoundingClientRect();
      tip.style.left = `${e.clientX - r.left + 14}px`;
      tip.style.top = `${e.clientY - r.top + 14}px`;
    });
    g.addEventListener('mouseleave', () => {
      if (label) label.classList.remove('hot');
      tip.hidden = true;
    });

    if (!slug) return;
    g.addEventListener('click', () => { location.hash = slug; });
    g.addEventListener('focus', () => { if (label) label.classList.add('hot'); });
    g.addEventListener('blur', () => { if (label) label.classList.remove('hot'); });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = slug; }
    });
  });

  svg.dataset.built = '1';
}

/** 切到地圖首頁：停掉縣市畫面，顯示地圖 */
function showHome() {
  activeEvent = null;
  document.title = '2026 地方選舉 · Polymarket 下注監控';
  $('pageTitle').textContent = '2026 台灣地方選舉 · Polymarket 下注監控';
  nwMode = false;
  $('metaTail').style.display = '';
  $('cityView').style.display = 'none';
  $('newWalletsView').style.display = 'none';
  $('sourceNotice').style.display = 'none';
  $('mapHome').style.display = '';
  $('sourceBadge').className = 'badge badge-loading';
  $('sourceBadge').textContent = `${EVENTS.length} 個縣市`;
  $('lastUpdate').textContent = '選擇縣市以檢視';
  $('totalCount').textContent = '—';
  renderTabs();
  renderMap();
}

function renderTabs() {
  const home = `<button class="city-tab tab-home ${!activeEvent && !nwMode ? 'active' : ''}"
      data-slug="home" type="button" title="回到地圖首頁">🗺 地圖</button>`;
  // 新進錢包是跨縣市的彙整，排在地圖後面、各縣市前面，跟縣市頁籤同一層
  const nw = `<button class="city-tab tab-nw ${nwMode ? 'active' : ''}"
      data-slug="${NEW_WALLETS_SLUG}" type="button"
      title="所有縣市第一次出現的錢包，跟通知信同一份資料">🔔 新進錢包通知</button>`;
  $('cityTabs').innerHTML = home + nw + EVENTS.map((e) => `
    <button class="city-tab ${e === activeEvent ? 'active' : ''}" data-slug="${e.slug}" type="button">
      ${escapeHtml(e.city)}
    </button>`).join('');

  $('cityTabs').querySelectorAll('.city-tab').forEach((b) => {
    b.addEventListener('click', () => {
      const cur = nwMode ? NEW_WALLETS_SLUG : (activeEvent ? activeEvent.slug : 'home');
      if (b.dataset.slug === cur) return;
      location.hash = b.dataset.slug;   // 交給 hashchange 統一處理
    });
  });
}

/** 切換縣市：把所有跟舊縣市有關的狀態清乾淨，再重新載入 */
function switchEvent(next) {
  // 從新進錢包頁切回來時 activeEvent 是 null，光比 next 會誤判成「沒換頁」
  if (next === activeEvent && !nwMode) return;
  if (!next) { showHome(); return; }      // 回地圖首頁
  nwMode = false;
  activeEvent = next;
  $('metaTail').style.display = '';
  $('mapHome').style.display = 'none';
  $('newWalletsView').style.display = 'none';
  $('cityView').style.display = '';

  markets = [];
  marketById = {};
  allTrades = [];
  prevKeys = new Set();
  eventMeta = null;
  snapshotAt = null;
  tradesSource = oddsSource = 'loading';
  firstLoad = true;   // 讓新縣市的第一批資料不要被標成「新交易」而閃爍

  // 篩選條件裡的候選人是綁在舊縣市的 conditionId 上，一定要清掉；
  // 其餘條件（買賣、金額、日期、搜尋）跨縣市仍然合理，予以保留。
  filters.cands = [];
  currentPage = 1;

  document.title = `2026 ${next.city}${next.office}選舉 · Polymarket 下注監控`;
  $('pageTitle').textContent = `2026 ${next.city}${next.office}選舉 · Polymarket 下注`;
  renderTabs();
  updatePillLabels();

  $('statsCards').innerHTML = '<div class="loading">載入盤口中…</div>';
  $('feed').innerHTML = '<div class="loading">載入中…</div>';
  $('sourceBadge').className = 'badge badge-loading';
  $('sourceBadge').textContent = '連線中…';
  $('sourceNotice').style.display = 'none';

  loadData();
}

// ── 資料來源狀態列 ──────────────────────────────────────────
function renderSourceState(liveErr, snapErr) {
  const badge = $('sourceBadge');
  const notice = $('sourceNotice');
  const snapLabel = snapshotAt ? `${tpeTime(snapshotAt)}（${timeAgo(snapshotAt)}）` : '時間未知';

  if (tradesSource === 'error') {
    badge.className = 'badge badge-error';
    badge.textContent = '● 連線失敗';
    $('lastUpdate').textContent = '無法取得資料';
    notice.className = 'notice notice-error container';
    notice.style.display = '';
    notice.innerHTML =
      `<b>兩種資料來源都失敗。</b><br>` +
      `直連 Polymarket Data API：${escapeHtml(liveErr || '未知錯誤')}　` +
      `（台灣 IP 通常被封鎖，需連 VPN）<br>` +
      `讀取快照 <code>data.json</code>：${escapeHtml(snapErr || '未知錯誤')}`;
  } else if (tradesSource === 'live') {
    // 成交明細是即時的 → 綠燈。賠率若來自快照，另外用一行說明，不影響主要判讀。
    badge.className = 'badge badge-live';
    badge.textContent = '● 即時直連';
    $('lastUpdate').textContent = `更新於 ${tpeTime(Date.now())}`;
    if (oddsSource === 'live') {
      notice.style.display = 'none';
    } else {
      notice.className = 'notice container';
      notice.style.display = '';
      notice.innerHTML =
        `<b>成交明細為即時，但賠率是快照值。</b>` +
        `Polymarket 的盤口 API（Gamma）從瀏覽器直連時常被 CORS 擋掉，這是該服務本身的限制。` +
        `上方候選人卡的機率、成交量、流動性擷取於 <b>${snapLabel}</b>；下方每一筆成交紀錄則是當下最新。`;
    }
  } else {
    badge.className = 'badge badge-snapshot';
    badge.textContent = '● 快照資料';
    $('lastUpdate').textContent = `快照時間 ${snapLabel}`;
    notice.className = 'notice container';
    notice.style.display = '';
    notice.innerHTML =
      `<b>目前為快照模式。</b>連不到 Polymarket API（台灣 IP 可能被封鎖），` +
      `畫面顯示的是排程抓取的存檔資料，非即時。` +
      `快照抓取於 <b>${snapLabel}</b>。　若要看即時資料，請連上 VPN 後重新整理。`;
  }
  $('totalCount').textContent = fmtInt(allTrades.length);
}

// ── 候選人賠率卡 ────────────────────────────────────────────
function renderStats() {
  // 依候選人彙總成交
  const agg = {};
  allTrades.forEach((t) => {
    const a = agg[t.conditionId] || (agg[t.conditionId] = { count: 0, buyUsd: 0, sellUsd: 0, buyShares: 0, sellShares: 0, wallets: new Set() });
    a.count++;
    a.wallets.add(t.wallet);
    if (t.side === 'BUY') { a.buyUsd += t.total; a.buyShares += t.size; }
    else { a.sellUsd += t.total; a.sellShares += t.size; }
  });

  // 只顯示「有成交量、有流動性、或有成交紀錄」的候選人
  const shown = markets.filter((m) => m.volume > 0 || m.liquidity > 0 || agg[m.conditionId]);
  const hiddenCount = markets.length - shown.length;
  shown.sort((a, b) => (b.yesPrice ?? 0) - (a.yesPrice ?? 0));

  const html = shown.map((m) => {
    const a = agg[m.conditionId] || { count: 0, buyUsd: 0, sellUsd: 0, buyShares: 0, sellShares: 0, wallets: new Set() };
    const pct = m.yesPrice != null ? (m.yesPrice * 100) : null;
    return `
      <div class="card ${m.party}">
        <div class="card-head">
          <div>
            <span class="cand-name">${escapeHtml(m.zh)}</span>
            <span class="cand-en">${escapeHtml(m.title)}</span>
          </div>
          ${m.partyZh ? `<span class="party-tag">${escapeHtml(m.partyZh)}</span>` : ''}
        </div>
        <div class="odds-row">
          <span class="odds-val">${pct != null ? pct.toFixed(1) + '%' : '—'}</span>
          <span class="odds-lbl">市場認為的當選機率</span>
        </div>
        <div class="odds-bar"><div class="odds-fill" style="width:${pct != null ? Math.min(100, pct) : 0}%"></div></div>
        <div class="row"><span>盤口總成交量</span><b>$${fmt(m.volume)}</b></div>
        <div class="row"><span>目前流動性</span><b>$${fmt(m.liquidity)}</b></div>
        <div class="row"><span>成交筆數</span><b>${fmtInt(a.count)}</b></div>
        <div class="row"><span>買進 / 賣出 股數</span><b>${fmt(a.buyShares)} / ${fmt(a.sellShares)}</b></div>
        <div class="card-foot">參與錢包 ${fmtInt(a.wallets.size)} 個　｜　買進金額 $${fmt(a.buyUsd)}　賣出金額 $${fmt(a.sellUsd)}</div>
      </div>`;
  }).join('');

  const note = hiddenCount > 0
    ? `<div class="hidden-note">另有 ${hiddenCount} 個尚未有人下注的佔位盤口（Candidate A～Z），已隱藏。</div>`
    : '';

  $('statsCards').innerHTML = html
    ? html + note
    : '<div class="loading">目前沒有盤口資料</div>';
}

// ── 候選人篩選清單 ──────────────────────────────────────────
function buildCandFilter() {
  const counts = {};
  allTrades.forEach((t) => { counts[t.conditionId] = (counts[t.conditionId] || 0) + 1; });
  const list = markets
    .filter((m) => m.volume > 0 || counts[m.conditionId])
    .sort((a, b) => (counts[b.conditionId] || 0) - (counts[a.conditionId] || 0));

  $('candCheckList').innerHTML = list.map((m) => `
    <label class="check-item">
      <input type="checkbox" data-cand-check value="${escapeHtml(m.conditionId)}">
      <span>${escapeHtml(m.zh)}</span>
      <span class="cnt">${fmtInt(counts[m.conditionId] || 0)}</span>
    </label>`).join('') || '<div class="panel-hint">尚無成交資料</div>';

  $('candCheckList').querySelectorAll('[data-cand-check]').forEach((cb) => {
    cb.addEventListener('change', () => {
      filters.cands = [...$('candCheckList').querySelectorAll('[data-cand-check]:checked')].map((x) => x.value);
    });
  });
}

// ── 篩選 / 排序 ─────────────────────────────────────────────
function applyFilters(rows) {
  const q = filters.search.trim().toLowerCase();
  const dStart = dateToMs(filters.dateStart, false);
  const dEnd   = dateToMs(filters.dateEnd, true);

  return rows.filter((t) => {
    if (filters.cands.length && !filters.cands.includes(t.conditionId)) return false;
    if (filters.sides.length && !filters.sides.includes(t.side)) return false;
    if (filters.outcomes.length && !filters.outcomes.includes(t.outcome)) return false;
    if (filters.minUsd != null && t.total < filters.minUsd) return false;
    if (filters.maxUsd != null && t.total > filters.maxUsd) return false;
    if (dStart != null && t.ts < dStart) return false;
    if (dEnd != null && t.ts > dEnd) return false;
    if (q) {
      const hay = `${t.name} ${t.wallet} ${t.hash} ${t.cand}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function applySorting(rows) {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let x = a[sortCol], y = b[sortCol];
    if (typeof x === 'string' || typeof y === 'string') {
      return String(x ?? '').localeCompare(String(y ?? ''), 'zh-TW') * dir;
    }
    return ((x ?? 0) - (y ?? 0)) * dir;
  });
}

function setSort(col) {
  if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  else { sortCol = col; sortDir = (col === 'ts' || col === 'total' || col === 'size') ? 'desc' : 'asc'; }
  currentPage = 1;
  render();
}

function sortIcon(col) {
  if (sortCol !== col) return '<span class="sort-icon">⇅</span>';
  return `<span class="sort-icon">${sortDir === 'asc' ? '↑' : '↓'}</span>`;
}

// ── 主渲染 ──────────────────────────────────────────────────
function render() {
  const filtered = applyFilters(allTrades);
  renderQuerySummary(filtered);

  if (viewMode === 'wallet') {
    renderWallets(filtered);
    // 帳號資訊是額外的靜態檔，第一次進錢包視圖才載入，回來後重畫一次補上欄位
    if (!walletProfiles) {
      loadWalletProfiles().then(() => {
        if (viewMode === 'wallet') renderWallets(applyFilters(allTrades));
      });
    }
    return;
  }

  const sorted = applySorting(filtered);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  const pageRows = pageSize >= 1e9 ? sorted : sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const body = viewMode === 'table' ? renderTable(pageRows) : renderFeed(pageRows);
  $('feed').innerHTML = sorted.length === 0
    ? '<div class="empty">沒有符合條件的成交紀錄</div>'
    : body + buildPagination(sorted.length, totalPages);

  bindRowEvents();
  if (sorted.length) bindPaginationEvents(totalPages);
}

function renderTable(rows) {
  const th = (col, label, cls = '') =>
    `<th class="sortable ${cls} ${sortCol === col ? 'sorted' : ''}" data-sort="${col}">${label}${sortIcon(col)}</th>`;

  return `
  <div class="table-wrap">
    <table>
      <thead><tr>
        ${th('ts', '時間（台北）')}
        ${th('cand', '候選人')}
        ${th('outcome', '押注')}
        ${th('side', '買賣')}
        ${th('size', '股數', 'num')}
        ${th('price', '成交價', 'num')}
        ${th('total', '金額 USD', 'num')}
        ${th('name', '交易者')}
        <th>錢包地址</th>
        <th>交易 Hash</th>
        <th>跨鏈金流</th>
      </tr></thead>
      <tbody>
        ${rows.map((t) => `
          <tr class="${t.isNew ? 'is-new' : ''}">
            <td class="mono" title="${timeAgo(t.ts)}">${tpeTime(t.ts)}</td>
            <td><span class="cand-chip ${t.party}">${escapeHtml(t.cand)}</span></td>
            <td><span class="tag-${t.outcome === 'Yes' ? 'yes' : 'no'}">${t.outcome}</span></td>
            <td><span class="tag-${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side === 'BUY' ? '▲ BUY' : '▼ SELL'}</span></td>
            <td class="num">${fmt(t.size)}</td>
            <td class="num">${fmt(t.price, 3)}</td>
            <td class="num"><b>$${fmt(t.total)}</b></td>
            <td><a class="link ${t.isAnon ? 'trader-anon' : ''}" href="${polymarketProfile(t.wallet)}"
                   target="_blank" rel="noopener"
                   title="${t.isAnon ? '這個錢包沒有設暱稱，但一樣可以看它的 Polymarket 個人頁' : ''}"
                >${t.isAnon ? '未具名' : escapeHtml(t.name)}</a></td>
            <td class="mono">
              <a class="link" href="${polygonscanAddr(t.wallet)}" target="_blank" rel="noopener" title="${t.wallet}">${shortAddr(t.wallet)}</a>
              ${copyBtn(t.wallet, '複製錢包')}
            </td>
            <td class="mono">
              <a class="link" href="${polygonscanTx(t.hash)}" target="_blank" rel="noopener" title="${t.hash}">${shortHash(t.hash)}</a>
              ${copyBtn(t.hash, '複製 Hash')}
            </td>
            <td>
              <a class="link" href="${relayLinkAddr(t.wallet)}" target="_blank" rel="noopener"
                 title="在 relay.link 查這個錢包的跨鏈轉帳紀錄（回溯 USDC.e 的來源鏈）">Relay ↗</a>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function renderFeed(rows) {
  return `<div class="feed-list">${rows.map((t) => `
    <div class="feed-item ${t.party} ${t.isNew ? 'is-new' : ''}">
      <div class="feed-main">
        <div class="feed-line1">
          <span class="tag-${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side === 'BUY' ? '▲ 買進' : '▼ 賣出'}</span>
          <span class="cand-chip ${t.party}">${escapeHtml(t.cand)}</span>
          <span class="tag-${t.outcome === 'Yes' ? 'yes' : 'no'}">${t.outcome === 'Yes' ? 'Yes 會當選' : 'No 不會當選'}</span>
          <a class="link trader-name ${t.isAnon ? 'trader-anon' : ''}" href="${polymarketProfile(t.wallet)}"
             target="_blank" rel="noopener"
             title="${t.isAnon ? '這個錢包沒有設暱稱，但一樣可以看它的 Polymarket 個人頁' : ''}"
            >${t.isAnon ? '未具名交易者' : escapeHtml(t.name)}</a>
        </div>
        <div class="feed-line2">
          <span class="mono">${tpeTime(t.ts)}</span>
          <span class="dot">•</span>
          <span>${timeAgo(t.ts)}</span>
          <span class="dot">•</span>
          <a class="link mono" href="${polygonscanAddr(t.wallet)}" target="_blank" rel="noopener" title="${t.wallet}">${shortAddr(t.wallet)}</a>
          ${copyBtn(t.wallet, '複製錢包')}
          <span class="dot">•</span>
          <a class="link mono" href="${polygonscanTx(t.hash)}" target="_blank" rel="noopener" title="${t.hash}">${shortHash(t.hash)}</a>
          ${copyBtn(t.hash, '複製 Hash')}
        </div>
      </div>
      <div class="feed-amount">
        <div class="big">$${fmt(t.total)}</div>
        <div class="sub">${fmt(t.size)} 股 @ ${fmt(t.price, 3)}</div>
      </div>
    </div>`).join('')}</div>`;
}

// ── 錢包彙總視圖 ────────────────────────────────────────────
function renderWallets(rows) {
  const openMs = eventMeta && eventMeta.startMs;
  const earlyCutoff = openMs ? openMs + EARLY_WINDOW_H * 3600 * 1000 : null;

  const map = {};
  rows.forEach((t) => {
    const w = map[t.wallet] || (map[t.wallet] = {
      wallet: t.wallet, name: t.name, isAnon: t.isAnon,
      count: 0, buyUsd: 0, sellUsd: 0, firstTs: t.ts, lastTs: t.ts, cands: new Set(),
    });
    w.count++;
    w.cands.add(t.cand);
    if (t.side === 'BUY') w.buyUsd += t.total; else w.sellUsd += t.total;
    if (t.ts < w.firstTs) w.firstTs = t.ts;
    if (t.ts > w.lastTs) w.lastTs = t.ts;
    if (!w.name && t.name) { w.name = t.name; w.isAnon = false; }
  });

  const list = Object.values(map)
    .map((w) => ({ ...w, netUsd: w.buyUsd - w.sellUsd, turnover: w.buyUsd + w.sellUsd }))
    .sort((a, b) => b.turnover - a.turnover);

  if (!list.length) {
    $('feed').innerHTML = '<div class="empty">沒有符合條件的錢包</div>';
    return;
  }

  const profiles = walletProfiles || {};

  const html = list.map((w, i) => {
    const isEarly = earlyCutoff && w.firstTs <= earlyCutoff;
    const p = profiles[w.wallet] || {};
    const joinMs = p.created_at ? Date.parse(p.created_at) : null;

    // 帳號建立於本盤開盤之後 → 很可能是為了這場選舉才開的新帳號，值得注意
    const freshAcct = joinMs && openMs && joinMs >= openMs;

    // 同一地址跨多個政治賭盤操作，是值得優先檢視的模式
    const cities = p.cities || [];
    const others = cities.filter((c) => c !== activeEvent.city);

    return `
    <div class="wallet-item ${isEarly ? 'early' : ''}">
      <div class="wallet-head">
        <div class="wallet-rank">${i + 1}</div>
        <span class="wallet-name">${w.isAnon ? '<span class="trader-anon">未具名</span>' : escapeHtml(w.name)}</span>
        <a class="link mono" href="${polygonscanAddr(w.wallet)}" target="_blank" rel="noopener" title="${w.wallet}">${shortAddr(w.wallet)}</a>
        ${copyBtn(w.wallet, '複製錢包')}
        <span class="wallet-links">
          <a class="link" href="${oklinkAddr(w.wallet)}" target="_blank" rel="noopener"
             title="在 OKLink 檢視這個錢包的鏈上紀錄（繁中介面）">OKLink ↗</a>
          <span class="dot">·</span>
          <a class="link" href="${polymarketProfile(w.wallet)}" target="_blank" rel="noopener">Polymarket ↗</a>
          <span class="dot">·</span>
          <a class="link" href="${relayLinkAddr(w.wallet)}" target="_blank" rel="noopener"
             title="在 relay.link 查這個錢包的跨鏈轉帳紀錄（回溯 USDC.e 的來源鏈）">Relay ↗</a>
        </span>
        ${isEarly ? `<span class="wallet-badge">開盤 ${EARLY_WINDOW_H} 小時內進場</span>` : ''}
        ${freshAcct ? '<span class="wallet-badge badge-fresh">開盤後才註冊的帳號</span>' : ''}
        ${others.length ? `<span class="wallet-badge badge-cross">跨 ${cities.length} 個縣市</span>` : ''}
      </div>
      <div class="wallet-grid">
        <div class="wallet-cell">
          <span class="k">帳號加入時間</span>
          <span class="v" style="font-size:12px">${joinMs ? tpeTime(joinMs, false) : '—'}</span>
        </div>
        <div class="wallet-cell">
          <span class="k">全站預測次數</span>
          <span class="v" title="這個帳號在整個 Polymarket 的累計交易次數，不只台灣選舉">${
            p.traded != null ? fmtInt(p.traded) : '—'}</span>
        </div>
        <div class="wallet-cell"><span class="k">本盤成交筆數</span><span class="v">${fmtInt(w.count)}</span></div>
        <div class="wallet-cell"><span class="k">買進金額</span><span class="v pos">$${fmt(w.buyUsd)}</span></div>
        <div class="wallet-cell"><span class="k">賣出金額</span><span class="v neg">$${fmt(w.sellUsd)}</span></div>
        <div class="wallet-cell"><span class="k">淨投入</span><span class="v ${w.netUsd >= 0 ? 'pos' : 'neg'}">$${fmt(w.netUsd)}</span></div>
        <div class="wallet-cell"><span class="k">押注標的</span><span class="v" style="font-size:12.5px">${escapeHtml([...w.cands].join('、'))}</span></div>
        <div class="wallet-cell" ${others.length >= 4 ? 'style="grid-column:1/-1"' : ''}>
          <span class="k">${others.length ? '也出現在' : '參與縣市'}</span>
          <span class="v ${others.length ? 'cross' : ''}" style="font-size:12.5px">${
            others.length ? escapeHtml(others.join('、')) : '僅本縣市'}</span>
        </div>
        <div class="wallet-cell"><span class="k">首次進場</span><span class="v" style="font-size:12px">${tpeTime(w.firstTs, false)}</span></div>
        <div class="wallet-cell"><span class="k">最後動作</span><span class="v" style="font-size:12px">${tpeTime(w.lastTs, false)}</span></div>
      </div>
    </div>`;
  }).join('');

  $('feed').innerHTML =
    `<div class="wallet-list">${html}</div>` +
    `<div class="page-info" style="text-align:center;margin-top:14px">
       共 ${fmtInt(list.length)} 個錢包，依累計成交金額（買+賣）排序
     </div>`;
  bindRowEvents();
}

// ── 查詢摘要 ────────────────────────────────────────────────
function renderQuerySummary(rows) {
  const box = $('querySummary');
  const q = filters.search.trim();
  const hasFilter = q || filters.cands.length || filters.sides.length || filters.outcomes.length
                    || filters.minUsd != null || filters.maxUsd != null || filters.dateStart || filters.dateEnd;
  if (!hasFilter) { box.style.display = 'none'; return; }

  const buyUsd = rows.filter((t) => t.side === 'BUY').reduce((s, t) => s + t.total, 0);
  const sellUsd = rows.filter((t) => t.side === 'SELL').reduce((s, t) => s + t.total, 0);
  const wallets = new Set(rows.map((t) => t.wallet));
  const times = rows.map((t) => t.ts);

  box.style.display = '';
  box.innerHTML = `
    <div class="qs-title">篩選結果${q ? `：<code>${escapeHtml(q)}</code>` : ''}</div>
    <div class="qs-grid">
      <div class="qs-item"><span class="k">成交筆數</span><span class="v">${fmtInt(rows.length)}</span></div>
      <div class="qs-item"><span class="k">涉及錢包</span><span class="v">${fmtInt(wallets.size)}</span></div>
      <div class="qs-item"><span class="k">買進金額</span><span class="v pos">$${fmt(buyUsd)}</span></div>
      <div class="qs-item"><span class="k">賣出金額</span><span class="v neg">$${fmt(sellUsd)}</span></div>
      <div class="qs-item"><span class="k">淨投入</span><span class="v ${buyUsd - sellUsd >= 0 ? 'pos' : 'neg'}">$${fmt(buyUsd - sellUsd)}</span></div>
      ${times.length ? `
      <div class="qs-item"><span class="k">最早</span><span class="v" style="font-size:12.5px">${tpeTime(Math.min(...times), false)}</span></div>
      <div class="qs-item"><span class="k">最晚</span><span class="v" style="font-size:12.5px">${tpeTime(Math.max(...times), false)}</span></div>` : ''}
    </div>`;
}

// ── 分頁 ────────────────────────────────────────────────────
function buildPagination(total, totalPages) {
  const from = pageSize >= 1e9 ? 1 : (currentPage - 1) * pageSize + 1;
  const to = pageSize >= 1e9 ? total : Math.min(currentPage * pageSize, total);
  return `
  <div class="pagination">
    <select class="page-size" id="pageSizeSel">
      ${[25, 50, 100, 200].map((n) => `<option value="${n}" ${pageSize === n ? 'selected' : ''}>每頁 ${n} 筆</option>`).join('')}
      <option value="999999999" ${pageSize >= 1e9 ? 'selected' : ''}>顯示全部</option>
    </select>
    <button class="page-btn" data-page="prev" ${currentPage === 1 ? 'disabled' : ''}>‹ 上一頁</button>
    ${buildPageButtons(totalPages)}
    <button class="page-btn" data-page="next" ${currentPage >= totalPages ? 'disabled' : ''}>下一頁 ›</button>
    <span class="page-info">第 ${fmtInt(from)}–${fmtInt(to)} 筆，共 ${fmtInt(total)} 筆</span>
  </div>`;
}

function buildPageButtons(totalPages) {
  if (pageSize >= 1e9 || totalPages <= 1) return '';
  const out = [];
  const push = (n) => out.push(
    `<button class="page-btn ${n === currentPage ? 'active' : ''}" data-page="${n}">${n}</button>`);
  const gap = () => out.push('<span class="page-ellipsis">…</span>');

  if (totalPages <= 7) { for (let i = 1; i <= totalPages; i++) push(i); }
  else {
    push(1);
    if (currentPage > 3) gap();
    for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) push(i);
    if (currentPage < totalPages - 2) gap();
    push(totalPages);
  }
  return out.join('');
}

function bindPaginationEvents(totalPages) {
  $('feed').querySelectorAll('[data-page]').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.page;
      if (v === 'prev') currentPage = Math.max(1, currentPage - 1);
      else if (v === 'next') currentPage = Math.min(totalPages, currentPage + 1);
      else currentPage = Number(v);
      render();
      window.scrollTo({ top: $('feed').offsetTop - 80, behavior: 'smooth' });
    });
  });
  const sel = $('pageSizeSel');
  if (sel) sel.addEventListener('change', () => { pageSize = Number(sel.value); currentPage = 1; render(); });
}

function bindRowEvents() {
  $('feed').querySelectorAll('[data-sort]').forEach((th) => {
    th.addEventListener('click', () => setSort(th.dataset.sort));
  });
  $('feed').querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = '✓'; b.classList.add('copied');
        setTimeout(() => { b.textContent = '⧉'; b.classList.remove('copied'); }, 1400);
      } catch { /* 剪貼簿被擋，忽略 */ }
    });
  });
}

// ── CSV 匯出 ────────────────────────────────────────────────
function downloadCsv() {
  const rows = applySorting(applyFilters(allTrades));
  if (!rows.length) { alert('目前沒有可匯出的資料'); return; }

  // 加上縣市欄，多份 CSV 併在一起時才分得出來源
  const head = ['縣市', '時間(台北)', '候選人', '候選人(英文)', '押注', '買賣', '股數', '成交價', '金額USD',
                '交易者', '錢包地址', '交易Hash', 'conditionId'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(',')];
  rows.forEach((t) => lines.push([
    activeEvent.city, tpeTime(t.ts), t.cand, t.candEn, t.outcome, t.side,
    t.size, t.price, t.total.toFixed(4),
    t.isAnon ? '未具名' : t.name, t.wallet, t.hash, t.conditionId,
  ].map(esc).join(',')));

  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${activeEvent.city}${activeEvent.office}Polymarket下注紀錄_${tpeTime(Date.now()).replace(/[: ]/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── 篩選 UI 綁定 ────────────────────────────────────────────
function closeAllPills(except) {
  document.querySelectorAll('.pill-dropdown').forEach((d) => {
    if (d !== except) d.classList.remove('active');
  });
}

function updatePillLabels() {
  const set = (name, text, active) => {
    const d = document.querySelector(`[data-pill="${name}"]`);
    d.querySelector('.pill-text').textContent = text;
    d.classList.toggle('has-value', !!active);
  };
  const candNames = filters.cands.map((cid) => (marketById[cid] || {}).zh).filter(Boolean);
  set('cand', candNames.length ? (candNames.length <= 2 ? candNames.join('、') : `候選人 ${candNames.length} 位`) : '候選人', candNames.length);
  set('side', filters.sides.length ? filters.sides.join(' / ') : '買賣', filters.sides.length);
  set('outcome', filters.outcomes.length ? filters.outcomes.join(' / ') : '押注', filters.outcomes.length);

  const hasAmt = filters.minUsd != null || filters.maxUsd != null;
  set('amount', hasAmt ? `$${filters.minUsd ?? '0'}–${filters.maxUsd ?? '∞'}` : '金額', hasAmt);

  const hasDate = filters.dateStart || filters.dateEnd;
  set('date', hasDate ? `${filters.dateStart || '起'} ~ ${filters.dateEnd || '今'}` : '日期', hasDate);
}

function initFilterUI() {
  document.querySelectorAll('.pill-trigger').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = btn.closest('.pill-dropdown');
      const willOpen = !d.classList.contains('active');
      closeAllPills(d);
      d.classList.toggle('active', willOpen);
    });
  });
  document.addEventListener('click', () => closeAllPills(null));
  document.querySelectorAll('.pill-panel').forEach((p) => p.addEventListener('click', (e) => e.stopPropagation()));

  document.querySelectorAll('[data-side-check]').forEach((cb) => cb.addEventListener('change', () => {
    filters.sides = [...document.querySelectorAll('[data-side-check]:checked')].map((x) => x.value);
  }));
  document.querySelectorAll('[data-outcome-check]').forEach((cb) => cb.addEventListener('change', () => {
    filters.outcomes = [...document.querySelectorAll('[data-outcome-check]:checked')].map((x) => x.value);
  }));

  document.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('click', () => {
    filters.minUsd = $('minUsd').value === '' ? null : Number($('minUsd').value);
    filters.maxUsd = $('maxUsd').value === '' ? null : Number($('maxUsd').value);
    filters.dateStart = $('dateStart').value;
    filters.dateEnd = $('dateEnd').value;
    closeAllPills(null);
    currentPage = 1;
    updatePillLabels();
    render();
  }));

  document.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.reset;
    if (k === 'cand') { filters.cands = []; document.querySelectorAll('[data-cand-check]').forEach((x) => x.checked = false); }
    if (k === 'side') { filters.sides = []; document.querySelectorAll('[data-side-check]').forEach((x) => x.checked = false); }
    if (k === 'outcome') { filters.outcomes = []; document.querySelectorAll('[data-outcome-check]').forEach((x) => x.checked = false); }
    if (k === 'amount') { filters.minUsd = filters.maxUsd = null; $('minUsd').value = ''; $('maxUsd').value = ''; }
    if (k === 'date') { filters.dateStart = filters.dateEnd = ''; $('dateStart').value = ''; $('dateEnd').value = ''; }
    currentPage = 1;
    updatePillLabels();
    render();
  }));

  // 搜尋
  let timer = null;
  $('search').addEventListener('input', (e) => {
    filters.search = e.target.value;
    $('searchClear').style.display = e.target.value ? '' : 'none';
    clearTimeout(timer);
    timer = setTimeout(() => { currentPage = 1; render(); }, 220);
  });
  $('searchClear').addEventListener('click', () => {
    $('search').value = ''; filters.search = '';
    $('searchClear').style.display = 'none';
    currentPage = 1; render();
  });

  // 視圖切換
  document.querySelectorAll('.view-btn').forEach((b) => b.addEventListener('click', () => {
    viewMode = b.dataset.view;
    document.querySelectorAll('.view-btn').forEach((x) => x.classList.toggle('active', x === b));
    currentPage = 1;
    render();
  }));
  document.querySelector('.view-btn[data-view="table"]').classList.add('active');

  $('downloadCsv').addEventListener('click', downloadCsv);
  $('refreshBtn').addEventListener('click', () => (nwMode ? loadNewWallets(true) : loadData(true)));
}

// ── 主題 ────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('kl-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  $('themeToggle').textContent = saved === 'dark' ? '🌙' : '☀️';
  $('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('kl-theme', next);
    $('themeToggle').textContent = next === 'dark' ? '🌙' : '☀️';
  });
}

// ── 新進錢包通知 ────────────────────────────────────────────
/**
 * 這一頁跟縣市頁不一樣：它不打 Polymarket API，而是讀 GitHub Actions 產生的
 * new-wallets.json。兩個理由：
 *
 *   1) 「這個錢包是不是第一次出現」要跟歷史名冊比對才知道，光看當下抓回來的
 *      成交明細算不出來——那是 snapshot.py 的職責，結果存在那支檔案裡。
 *   2) 這樣沒有 VPN 也看得到，而且跟寄出去的通知信是同一份資料，不會對不上。
 *
 * 每筆代表一個錢包在某個縣市的「首航」，同一個錢包在不同縣市會各有一筆。
 */
const NEW_WALLETS_SLUG = 'new-wallets';

let nwMode      = false;   // 是否正在看這一頁
let nwAll       = null;    // 正規化後的完整名單，載入一次就快取
let nwCross     = {};      // 錢包 → 出現過的縣市陣列，用來判斷跨縣市
let nwUpdatedAt = null;
let nwFilters   = { search: '', city: '', start: '', end: '', crossOnly: false };
let nwSortCol   = 'ts';
let nwSortDir   = 'desc';
let nwPage      = 1;
let nwPageSize  = 50;

/** 從 EVENTS 設定表反查政黨，好讓候選人 chip 的顏色跟縣市頁一致 */
function nwPartyOf(slug, zh) {
  const ev = EVENTS.find((e) => e.slug === slug);
  if (!ev) return 'tbd';
  const hit = Object.values(ev.candidates).find((c) => c.zh === zh);
  return hit ? hit.party : 'tbd';
}

function nwNormalize(list) {
  return list.map((w) => ({
    ts:      (w.first_timestamp || 0) * 1000,
    city:    w.city || '',
    slug:    w.slug || '',
    wallet:  (w.wallet || '').toLowerCase(),
    name:    w.name || '',
    isAnon:  !w.name,
    cand:    w.candidate || '',
    party:   nwPartyOf(w.slug, w.candidate),
    outcome: w.outcome === 'Yes' ? 'Yes' : 'No',
    side:    w.side === 'BUY' ? 'BUY' : 'SELL',
    size:    Number(w.size) || 0,
    price:   Number(w.price) || 0,
    total:   Number(w.total) || 0,
    hash:    w.tx || '',
  }));
}

/** 錢包 → 它出現過的縣市。跨兩個以上縣市的錢包通常最值得看。 */
function nwBuildCross(rows) {
  const m = {};
  rows.forEach((r) => {
    if (!m[r.wallet]) m[r.wallet] = new Set();
    m[r.wallet].add(r.city);
  });
  const out = {};
  Object.keys(m).forEach((w) => { out[w] = [...m[w]].sort(); });
  return out;
}

async function loadNewWallets(manual = false) {
  const btn = $('refreshBtn');
  if (manual) { btn.classList.add('spinning'); nwAll = null; }

  if (!nwAll) {
    try {
      const d = await fetchJson(`new-wallets.json?t=${Date.now()}`, 20000);
      nwAll = nwNormalize(d.wallets || []);
      nwCross = nwBuildCross(nwAll);
      nwUpdatedAt = d.updated_at || null;
    } catch (e) {
      console.error('[新進錢包名單讀取失敗]', e.message);
      $('nwBody').innerHTML = `<div class="empty">
        讀不到 new-wallets.json（${escapeHtml(e.message)}）。<br>
        這份名單由 GitHub Actions 每 3 小時產生一次，若是剛部署完請稍等一輪再試。
      </div>`;
      $('lastUpdate').textContent = '名單讀取失敗';
      setTimeout(() => btn.classList.remove('spinning'), 300);
      return;
    }
  }

  if (!nwMode) return;      // 載入途中已經切走，結果作廢
  nwFillCityOptions();
  nwRender();
  setTimeout(() => btn.classList.remove('spinning'), 300);
}

/** 縣市下拉：只列名單裡真的有資料的縣市，並附上筆數 */
function nwFillCityOptions() {
  const sel = $('nwCity');
  if (!sel || !nwAll) return;
  const count = {};
  nwAll.forEach((r) => { count[r.city] = (count[r.city] || 0) + 1; });
  const cities = EVENTS.map((e) => e.city).filter((c) => count[c]);
  sel.innerHTML = `<option value="">全部縣市（${fmtInt(nwAll.length)}）</option>` +
    cities.map((c) => `<option value="${escapeHtml(c)}" ${nwFilters.city === c ? 'selected' : ''}>
      ${escapeHtml(c)}（${fmtInt(count[c])}）</option>`).join('');
}

function nwApplyFilters() {
  const f = nwFilters;
  const kw = f.search.trim().toLowerCase();
  const a = dateToMs(f.start);
  const b = dateToMs(f.end, true);
  return (nwAll || []).filter((r) => {
    if (f.city && r.city !== f.city) return false;
    if (f.crossOnly && (nwCross[r.wallet] || []).length < 2) return false;
    if (a !== null && r.ts < a) return false;
    if (b !== null && r.ts > b) return false;
    if (kw && !(r.name.toLowerCase().includes(kw) || r.wallet.includes(kw))) return false;
    return true;
  });
}

function nwSortRows(rows) {
  const dir = nwSortDir === 'asc' ? 1 : -1;
  const pick = (r) => ({
    ts: r.ts, city: r.city, cand: r.cand, total: r.total,
    name: r.isAnon ? '' : r.name,
  })[nwSortCol];
  return rows.slice().sort((x, y) => {
    const a = pick(x), b = pick(y);
    if (typeof a === 'string' || typeof b === 'string') {
      return String(a).localeCompare(String(b), 'zh-TW') * dir;
    }
    return ((a || 0) - (b || 0)) * dir;
  });
}

function nwSetSort(col) {
  if (nwSortCol === col) nwSortDir = nwSortDir === 'asc' ? 'desc' : 'asc';
  else { nwSortCol = col; nwSortDir = col === 'ts' ? 'desc' : 'asc'; }
  nwRender();
}

function nwSortIcon(col) {
  if (nwSortCol !== col) return '<span class="sort-icon">⇅</span>';
  return `<span class="sort-icon">${nwSortDir === 'asc' ? '↑' : '↓'}</span>`;
}

function nwRender() {
  if (!nwAll) return;

  const rows = nwSortRows(nwApplyFilters());
  const totalPages = Math.max(1, Math.ceil(rows.length / nwPageSize));
  if (nwPage > totalPages) nwPage = totalPages;
  const page = nwPageSize >= 1e9 ? rows
    : rows.slice((nwPage - 1) * nwPageSize, nwPage * nwPageSize);

  // 頂端摘要：這三個數字是這一頁真正要回答的問題
  const dayAgo = Date.now() - 86400000;
  const last24 = rows.filter((r) => r.ts >= dayAgo).length;
  const crossN = new Set(rows.filter((r) => (nwCross[r.wallet] || []).length > 1)
    .map((r) => r.wallet)).size;

  $('lastUpdate').textContent = nwUpdatedAt
    ? `名單更新於 ${nwUpdatedAt.slice(0, 16).replace('T', ' ')}`
    : '名單時間不明';

  const summary = `
    <div class="nw-summary">
      <div class="nw-stat"><span class="nw-stat-n">${fmtInt(rows.length)}</span><span class="nw-stat-l">符合條件的新進錢包</span></div>
      <div class="nw-stat"><span class="nw-stat-n">${fmtInt(last24)}</span><span class="nw-stat-l">最近 24 小時</span></div>
      <div class="nw-stat"><span class="nw-stat-n">${fmtInt(crossN)}</span><span class="nw-stat-l">跨縣市錢包</span></div>
    </div>`;

  if (!rows.length) {
    $('nwBody').innerHTML = summary + '<div class="empty">沒有符合條件的新進錢包，試著放寬篩選條件。</div>';
    return;
  }

  const th = (col, label, cls = '') =>
    `<th class="sortable ${cls} ${nwSortCol === col ? 'sorted' : ''}" data-nwsort="${col}">${label}${nwSortIcon(col)}</th>`;

  const table = `
  <div class="table-wrap">
    <table>
      <thead><tr>
        ${th('ts', '首次出現（台北）')}
        ${th('city', '縣市')}
        ${th('name', '交易者')}
        ${th('cand', '候選人')}
        <th>押注</th>
        <th>買賣</th>
        <th class="num">股數</th>
        <th class="num">成交價</th>
        ${th('total', '金額 USD', 'num')}
        <th>錢包地址</th>
        <th>交易 Hash</th>
        <th>跨鏈金流</th>
      </tr></thead>
      <tbody>
        ${page.map((r) => {
          const others = (nwCross[r.wallet] || []).filter((c) => c !== r.city);
          return `
          <tr>
            <td class="mono" title="${timeAgo(r.ts)}">${tpeTime(r.ts)}</td>
            <td>
              <a class="link" href="#${r.slug}" title="前往 ${escapeHtml(r.city)}監控頁">${escapeHtml(r.city)}</a>
              ${others.length ? `<span class="wallet-badge badge-cross" title="這個錢包也出現在：${escapeHtml(others.join('、'))}">跨 ${others.length + 1} 縣市</span>` : ''}
            </td>
            <td><a class="link ${r.isAnon ? 'trader-anon' : ''}" href="${polymarketProfile(r.wallet)}"
                   target="_blank" rel="noopener"
                   title="${r.isAnon ? '這個錢包沒有設暱稱，但一樣可以看它的 Polymarket 個人頁' : ''}"
                >${r.isAnon ? '未具名' : escapeHtml(r.name)}</a></td>
            <td><span class="cand-chip ${r.party}">${escapeHtml(r.cand)}</span></td>
            <td><span class="tag-${r.outcome === 'Yes' ? 'yes' : 'no'}">${r.outcome}</span></td>
            <td><span class="tag-${r.side === 'BUY' ? 'buy' : 'sell'}">${r.side === 'BUY' ? '▲ BUY' : '▼ SELL'}</span></td>
            <td class="num">${fmt(r.size)}</td>
            <td class="num">${fmt(r.price, 3)}</td>
            <td class="num"><b>$${fmt(r.total)}</b></td>
            <td class="mono">
              <a class="link" href="${polygonscanAddr(r.wallet)}" target="_blank" rel="noopener" title="${r.wallet}">${shortAddr(r.wallet)}</a>
              ${copyBtn(r.wallet, '複製錢包')}
            </td>
            <td class="mono">
              ${r.hash
                ? `<a class="link" href="${polygonscanTx(r.hash)}" target="_blank" rel="noopener" title="${r.hash}">${shortHash(r.hash)}</a>${copyBtn(r.hash, '複製 Hash')}`
                : '<span class="trader-anon">—</span>'}
            </td>
            <td>
              <a class="link" href="${relayLinkAddr(r.wallet)}" target="_blank" rel="noopener"
                 title="在 relay.link 查這個錢包的跨鏈轉帳紀錄">Relay ↗</a>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;

  $('nwBody').innerHTML = summary + table + nwPagination(rows.length, totalPages);
  nwBindBodyEvents(totalPages);
}

function nwPagination(total, totalPages) {
  const from = nwPageSize >= 1e9 ? 1 : (nwPage - 1) * nwPageSize + 1;
  const to = nwPageSize >= 1e9 ? total : Math.min(nwPage * nwPageSize, total);
  const btns = [];
  if (nwPageSize < 1e9 && totalPages > 1) {
    const push = (n) => btns.push(
      `<button class="page-btn ${n === nwPage ? 'active' : ''}" data-nwpage="${n}">${n}</button>`);
    if (totalPages <= 7) { for (let i = 1; i <= totalPages; i++) push(i); }
    else {
      push(1);
      if (nwPage > 3) btns.push('<span class="page-ellipsis">…</span>');
      for (let i = Math.max(2, nwPage - 1); i <= Math.min(totalPages - 1, nwPage + 1); i++) push(i);
      if (nwPage < totalPages - 2) btns.push('<span class="page-ellipsis">…</span>');
      push(totalPages);
    }
  }
  return `
  <div class="pagination">
    <select class="page-size" id="nwPageSizeSel">
      ${[25, 50, 100, 200].map((n) => `<option value="${n}" ${nwPageSize === n ? 'selected' : ''}>每頁 ${n} 筆</option>`).join('')}
      <option value="999999999" ${nwPageSize >= 1e9 ? 'selected' : ''}>顯示全部</option>
    </select>
    <button class="page-btn" data-nwpage="prev" ${nwPage === 1 ? 'disabled' : ''}>‹ 上一頁</button>
    ${btns.join('')}
    <button class="page-btn" data-nwpage="next" ${nwPage >= totalPages ? 'disabled' : ''}>下一頁 ›</button>
    <span class="page-info">第 ${fmtInt(from)}–${fmtInt(to)} 筆，共 ${fmtInt(total)} 筆</span>
  </div>`;
}

function nwBindBodyEvents(totalPages) {
  const body = $('nwBody');

  body.querySelectorAll('[data-nwsort]').forEach((el) => {
    el.addEventListener('click', () => nwSetSort(el.dataset.nwsort));
  });

  body.querySelectorAll('[data-nwpage]').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.nwpage;
      if (v === 'prev') nwPage = Math.max(1, nwPage - 1);
      else if (v === 'next') nwPage = Math.min(totalPages, nwPage + 1);
      else nwPage = Number(v);
      nwRender();
      window.scrollTo({ top: body.offsetTop - 80, behavior: 'smooth' });
    });
  });

  const sel = $('nwPageSizeSel');
  if (sel) sel.addEventListener('change', () => {
    nwPageSize = Number(sel.value); nwPage = 1; nwRender();
  });

  body.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = '✓'; b.classList.add('copied');
        setTimeout(() => { b.textContent = '⧉'; b.classList.remove('copied'); }, 1400);
      } catch { /* 剪貼簿被擋，忽略 */ }
    });
  });
}

function nwDownloadCsv() {
  const rows = nwSortRows(nwApplyFilters());
  if (!rows.length) { alert('目前沒有可匯出的資料'); return; }
  const head = ['首次出現(台北)', '縣市', '交易者', '候選人', '押注', '買賣',
                '股數', '成交價', '金額USD', '錢包地址', '交易Hash', '跨縣市'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(',')];
  rows.forEach((r) => lines.push([
    tpeTime(r.ts), r.city, r.isAnon ? '未具名' : r.name, r.cand, r.outcome, r.side,
    r.size, r.price, r.total.toFixed(4), r.wallet, r.hash,
    (nwCross[r.wallet] || []).join('、'),
  ].map(esc).join(',')));

  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `新進錢包通知_${tpeTime(Date.now()).replace(/[: ]/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 切到新進錢包頁 */
function showNewWallets() {
  nwMode = true;
  activeEvent = null;
  document.title = '新進錢包通知 · Polymarket 下注監控';
  $('pageTitle').textContent = '新進錢包通知 · 跨縣市彙整';
  $('cityView').style.display = 'none';
  $('mapHome').style.display = 'none';
  $('sourceNotice').style.display = 'none';
  $('newWalletsView').style.display = '';
  $('sourceBadge').className = 'badge badge-snapshot';
  $('sourceBadge').textContent = '名冊快照';
  $('lastUpdate').textContent = '載入中…';
  $('metaTail').style.display = 'none';   // 這頁沒有「成交筆數」也不自動更新
  renderTabs();
  loadNewWallets();
}

function initNewWalletsUI() {
  const search = $('nwSearch');
  const clear = $('nwSearchClear');
  let timer = null;
  search.addEventListener('input', () => {
    clear.style.display = search.value ? '' : 'none';
    clearTimeout(timer);
    timer = setTimeout(() => { nwFilters.search = search.value; nwPage = 1; nwRender(); }, 250);
  });
  clear.addEventListener('click', () => {
    search.value = ''; clear.style.display = 'none';
    nwFilters.search = ''; nwPage = 1; nwRender();
  });

  $('nwCity').addEventListener('change', (e) => {
    nwFilters.city = e.target.value; nwPage = 1; nwRender();
  });
  $('nwStart').addEventListener('change', (e) => {
    nwFilters.start = e.target.value; nwPage = 1; nwRender();
  });
  $('nwEnd').addEventListener('change', (e) => {
    nwFilters.end = e.target.value; nwPage = 1; nwRender();
  });
  $('nwCrossOnly').addEventListener('change', (e) => {
    nwFilters.crossOnly = e.target.checked; nwPage = 1; nwRender();
  });

  $('nwReset').addEventListener('click', () => {
    nwFilters = { search: '', city: '', start: '', end: '', crossOnly: false };
    search.value = ''; clear.style.display = 'none';
    $('nwStart').value = ''; $('nwEnd').value = '';
    $('nwCrossOnly').checked = false;
    nwPage = 1;
    nwFillCityOptions();
    nwRender();
  });

  $('nwCsv').addEventListener('click', nwDownloadCsv);
}

/** 網址 hash → 要開哪一頁。新進錢包是縣市以外的第三種去處。 */
function routeFromHash() {
  const slug = (location.hash || '').replace(/^#/, '');
  if (slug === NEW_WALLETS_SLUG) return NEW_WALLETS_SLUG;
  return eventFromHash();
}

function goRoute(route) {
  if (route === NEW_WALLETS_SLUG) {
    if (!nwMode) showNewWallets();
    return;
  }
  switchEvent(route);
}

// ── 啟動 ────────────────────────────────────────────────────
initTheme();
initFilterUI();
initNewWalletsUI();
updatePillLabels();

// 支援上一頁／下一頁與直接貼帶 hash 的網址
window.addEventListener('hashchange', () => goRoute(routeFromHash()));

const startRoute = routeFromHash();
if (startRoute === NEW_WALLETS_SLUG) {
  showNewWallets();
} else if (startRoute) {
  activeEvent = startRoute;
  document.title = `2026 ${activeEvent.city}${activeEvent.office}選舉 · Polymarket 下注監控`;
  $('pageTitle').textContent = `2026 ${activeEvent.city}${activeEvent.office}選舉 · Polymarket 下注`;
  $('cityView').style.display = '';
  renderTabs();
  loadData();
} else {
  showHome();   // 沒指定縣市 → 地圖首頁
}

// 首頁不需要輪詢，切到縣市後才有意義
setInterval(() => { if (activeEvent) loadData(); }, REFRESH_INTERVAL);
