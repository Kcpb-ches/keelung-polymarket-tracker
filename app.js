/* ============================================================
   2026 基隆市長選舉 · Polymarket 下注監控
   ------------------------------------------------------------
   資料來源雙軌：
     1) 直連 Polymarket API（需能連到 polymarket.com，台灣可能被擋 → 需 VPN）
     2) 直連失敗時自動改讀同目錄的 data.json 快照（由 GitHub Actions 產生）
   ============================================================ */

'use strict';

// 版號跟 index.html 的 ?v= 對應。若 console 印出的版號跟你剛改的不一樣，
// 代表瀏覽器讀的是快取的舊檔，按 Cmd+Shift+R 強制重新載入。
const APP_VERSION = 2;
console.log(`[基隆選舉監控] app.js v${APP_VERSION}`);

// ── 設定 ────────────────────────────────────────────────────
const EVENT_ID         = 848410;
const GAMMA_API        = 'https://gamma-api.polymarket.com';
const DATA_API         = 'https://data-api.polymarket.com';
const SNAPSHOT_URL     = 'data.json';
const REFRESH_INTERVAL = 30000;   // 30 秒
const LIVE_TIMEOUT     = 8000;    // 直連逾時（毫秒），逾時就改走快照
const TRADE_PAGE_SIZE  = 500;     // 每次向 API 要幾筆
const MAX_TRADES       = 10000;   // Data API 的 offset 上限
const EARLY_WINDOW_H   = 24;      // 開盤後幾小時內進場算「早期交易者」

// 候選人英文 → 中文 / 政黨對照
// ⚠️ Polymarket 只給英文拼音，中文為人工對照，如有誤請直接改這裡
const CANDIDATES = {
  'Hsieh Kuo-liang': { zh: '謝國樑', party: 'kmt', partyZh: '國民黨' },
  'Tung Tzu-wei':    { zh: '童子瑋', party: 'dpp', partyZh: '民進黨' },
  'Other':           { zh: '其他人選', party: 'tbd', partyZh: '' },
};

// ── 狀態 ────────────────────────────────────────────────────
let eventMeta   = null;   // { title, startDate, endDate, volume, liquidity }
let markets     = [];     // 正規化後的候選人盤口
let marketById  = {};     // conditionId → market
let allTrades   = [];     // 正規化後的成交明細（新→舊）
let prevKeys    = new Set();
let dataSource  = 'loading';   // 'live' | 'snapshot' | 'error'
let snapshotAt  = null;
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
  if (CANDIDATES[title]) return CANDIDATES[title];
  const m = /^Candidate ([A-Z])$/.exec(title || '');
  if (m) return { zh: `未定人選 ${m[1]}`, party: 'tbd', partyZh: '待定' };
  return { zh: title || '未知', party: 'tbd', partyZh: '' };
}

function polygonscanTx(h)      { return `https://polygonscan.com/tx/${h}`; }
function polygonscanAddr(a)    { return `https://polygonscan.com/address/${a}`; }
function polymarketProfile(a)  { return `https://polymarket.com/profile/${a}`; }

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

/** 直連：抓 event 盤口 + 全部成交明細 */
async function loadLive() {
  const evArr = await fetchJson(`${GAMMA_API}/events?id=${EVENT_ID}`);
  const ev = Array.isArray(evArr) ? evArr[0] : evArr;
  if (!ev) throw new Error('event 不存在');

  const trades = [];
  for (let offset = 0; offset < MAX_TRADES; offset += TRADE_PAGE_SIZE) {
    const batch = await fetchJson(
      `${DATA_API}/trades?eventId=${EVENT_ID}&takerOnly=true&limit=${TRADE_PAGE_SIZE}&offset=${offset}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    trades.push(...batch);
    if (batch.length < TRADE_PAGE_SIZE) break;
  }
  return { event: ev, trades, fetchedAt: Date.now() };
}

/** 備援：讀 GitHub Actions 產生的快照 */
async function loadSnapshot() {
  const d = await fetchJson(`${SNAPSHOT_URL}?t=${Date.now()}`, 15000);
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
    const info = m || candInfo(t.title ? t.title.replace(/^Will (.+?) win the next Keelung Mayor election\?$/, '$1') : '');
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

  let payload = null;
  try {
    payload = await loadLive();
    dataSource = 'live';
    snapshotAt = null;
  } catch (liveErr) {
    console.warn('[直連失敗，改讀快照]', liveErr.message);
    try {
      payload = await loadSnapshot();
      dataSource = 'snapshot';
      snapshotAt = payload.fetchedAt;
    } catch (snapErr) {
      console.error('[快照也讀不到]', snapErr.message);
      dataSource = 'error';
      renderSourceState(liveErr.message, snapErr.message);
      if (firstLoad) $('feed').innerHTML = '<div class="empty">目前無法取得任何資料，請見上方說明。</div>';
      btn.classList.remove('spinning');
      return;
    }
  }

  normalizeMarkets(payload.event);
  const fresh = normalizeTrades(payload.trades);

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

// ── 資料來源狀態列 ──────────────────────────────────────────
function renderSourceState(liveErr, snapErr) {
  const badge = $('sourceBadge');
  const notice = $('sourceNotice');

  if (dataSource === 'live') {
    badge.className = 'badge badge-live';
    badge.textContent = '● 即時直連';
    $('lastUpdate').textContent = `更新於 ${tpeTime(Date.now())}`;
    notice.style.display = 'none';
  } else if (dataSource === 'snapshot') {
    badge.className = 'badge badge-snapshot';
    badge.textContent = '● 快照資料';
    $('lastUpdate').textContent = snapshotAt
      ? `快照時間 ${tpeTime(snapshotAt)}（${timeAgo(snapshotAt)}）`
      : '快照時間未知';
    notice.className = 'notice container';
    notice.style.display = '';
    notice.innerHTML =
      `<b>目前為快照模式。</b>連不到 Polymarket API（台灣 IP 可能被封鎖），` +
      `畫面顯示的是排程抓取的存檔資料，非即時。` +
      (snapshotAt ? `快照抓取於 <b>${tpeTime(snapshotAt)}</b>（${timeAgo(snapshotAt)}）。` : '') +
      `　若要看即時資料，請連上 VPN 後重新整理。`;
  } else {
    badge.className = 'badge badge-error';
    badge.textContent = '● 連線失敗';
    $('lastUpdate').textContent = '無法取得資料';
    notice.className = 'notice notice-error container';
    notice.style.display = '';
    notice.innerHTML =
      `<b>兩種資料來源都失敗。</b><br>` +
      `直連 Polymarket API：${escapeHtml(liveErr || '未知錯誤')}　` +
      `（台灣 IP 通常被封鎖，需連 VPN）<br>` +
      `讀取本地快照 <code>data.json</code>：${escapeHtml(snapErr || '未知錯誤')}　` +
      `（尚未產生快照，可執行 <code>python3 scripts/snapshot.py</code> 建立）`;
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
            <td>${t.isAnon
                  ? '<span class="trader-anon">未具名</span>'
                  : `<a class="link" href="${polymarketProfile(t.wallet)}" target="_blank" rel="noopener">${escapeHtml(t.name)}</a>`}</td>
            <td class="mono">
              <a class="link" href="${polygonscanAddr(t.wallet)}" target="_blank" rel="noopener" title="${t.wallet}">${shortAddr(t.wallet)}</a>
              ${copyBtn(t.wallet, '複製錢包')}
            </td>
            <td class="mono">
              <a class="link" href="${polygonscanTx(t.hash)}" target="_blank" rel="noopener" title="${t.hash}">${shortHash(t.hash)}</a>
              ${copyBtn(t.hash, '複製 Hash')}
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
          ${t.isAnon
            ? '<span class="trader-anon">未具名交易者</span>'
            : `<a class="link trader-name" href="${polymarketProfile(t.wallet)}" target="_blank" rel="noopener">${escapeHtml(t.name)}</a>`}
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

  const html = list.map((w, i) => {
    const isEarly = earlyCutoff && w.firstTs <= earlyCutoff;
    return `
    <div class="wallet-item ${isEarly ? 'early' : ''}">
      <div class="wallet-head">
        <div class="wallet-rank">${i + 1}</div>
        <span class="wallet-name">${w.isAnon ? '<span class="trader-anon">未具名</span>' : escapeHtml(w.name)}</span>
        <a class="link mono" href="${polygonscanAddr(w.wallet)}" target="_blank" rel="noopener" title="${w.wallet}">${shortAddr(w.wallet)}</a>
        ${copyBtn(w.wallet, '複製錢包')}
        <a class="link" href="${polymarketProfile(w.wallet)}" target="_blank" rel="noopener" style="font-size:12px">Polymarket ↗</a>
        ${isEarly ? `<span class="wallet-badge">開盤 ${EARLY_WINDOW_H} 小時內進場</span>` : ''}
      </div>
      <div class="wallet-grid">
        <div class="wallet-cell"><span class="k">成交筆數</span><span class="v">${fmtInt(w.count)}</span></div>
        <div class="wallet-cell"><span class="k">買進金額</span><span class="v pos">$${fmt(w.buyUsd)}</span></div>
        <div class="wallet-cell"><span class="k">賣出金額</span><span class="v neg">$${fmt(w.sellUsd)}</span></div>
        <div class="wallet-cell"><span class="k">淨投入</span><span class="v ${w.netUsd >= 0 ? 'pos' : 'neg'}">$${fmt(w.netUsd)}</span></div>
        <div class="wallet-cell"><span class="k">押注標的</span><span class="v" style="font-size:12.5px">${escapeHtml([...w.cands].join('、'))}</span></div>
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

  const head = ['時間(台北)', '候選人', '候選人(英文)', '押注', '買賣', '股數', '成交價', '金額USD',
                '交易者', '錢包地址', '交易Hash', 'conditionId'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(',')];
  rows.forEach((t) => lines.push([
    tpeTime(t.ts), t.cand, t.candEn, t.outcome, t.side,
    t.size, t.price, t.total.toFixed(4),
    t.isAnon ? '未具名' : t.name, t.wallet, t.hash, t.conditionId,
  ].map(esc).join(',')));

  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `基隆市長Polymarket下注紀錄_${tpeTime(Date.now()).replace(/[: ]/g, '-')}.csv`;
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
  $('refreshBtn').addEventListener('click', () => loadData(true));
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

// ── 啟動 ────────────────────────────────────────────────────
initTheme();
initFilterUI();
updatePillLabels();
loadData();
setInterval(() => loadData(), REFRESH_INTERVAL);
