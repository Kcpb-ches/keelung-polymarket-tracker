/**
 * 每小時叫 GitHub 跑一次 snapshot workflow。
 *
 * 為什麼需要這支東西：
 *   GitHub 的排程（workflow 裡的 cron）對免費／公開 repo 有節流，
 *   2026-09-22 實測寫「每小時」但實際平均 4.3 小時才跑一班，執行率只有 17%。
 *   但「手動觸發」不受這個限制——你按 Run workflow 時都是秒級啟動。
 *   所以這支 Worker 做的事，就是每小時幫你按一次那顆按鈕。
 *
 * 刻意沒有寫 fetch handler：這個 Worker 只接受排程事件，沒有對外網址，
 * 別人就無從呼叫它。唯一的入口是 Cloudflare 的 cron。
 */

const OWNER    = 'Kcpb-ches';
const REPO     = 'keelung-polymarket-tracker';
const WORKFLOW = 'snapshot.yml';
const REF      = 'main';

export default {
  async scheduled(event, env, ctx) {
    if (!env.GITHUB_TOKEN) {
      console.error('❌ 沒有設定 GITHUB_TOKEN，無法觸發。請執行 wrangler secret put GITHUB_TOKEN');
      return;
    }

    const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub API 強制要求 User-Agent，沒帶會直接回 403
        'User-Agent': 'keelung-polymarket-cron',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: REF }),
    });

    // 成功是 204 No Content，不會有回應內容
    if (res.status === 204) {
      console.log(`✅ 已觸發 ${WORKFLOW}（${new Date().toISOString()}）`);
      return;
    }

    // 失敗時把原因印出來，之後可以用 wrangler tail 看
    const body = await res.text().catch(() => '(讀不到回應)');
    console.error(`❌ 觸發失敗 HTTP ${res.status}：${body}`);

    // 401/403 幾乎都是 token 過期或權限不足，特別點出來免得誤判成 GitHub 壞掉
    if (res.status === 401 || res.status === 403) {
      console.error('   多半是 token 過期或權限不足。確認那把細粒度 token 還在有效期內，'
                  + '且對這個 repo 有 Actions: Read and write 權限。');
    }
  },
};
