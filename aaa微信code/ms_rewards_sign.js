/*
@Description: Microsoft Rewards Bing搜索赚积分 (PC+移动)
cron: 0 8 * * *
环境变量: MS_COOKIES (多账号用换行分隔)
可选: MS_PC_SEARCH=30, MS_MB_SEARCH=20

注意: 微软Rewards的/api/getuserstatus等API已移除。
当前脚本仅通过Bing搜索赚取积分，搜索是Rewards最基本可靠的积分来源。
*/

const axios = require("axios");
const BING_BASE = "https://www.bing.com";
const REWARDS_BASE = "https://rewards.bing.com";

// ─── 常量 ───
const UA_PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0";
const UA_MOBILE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Edg/125.0.0.0";

// ─── 日志工具 ───
const $ = (msg) => console.log(String(msg));
const LOG = {
    head: (t) => $(`╔══════════════════════════════════════╗\n║  ${t.padEnd(38)}\n╚══════════════════════════════════════╝`),
    sec:  (t) => $(`  ┌─ ${t}`),
    ok:   (t) => $(`  │  ✅ ${t}`),
    fail: (t) => $(`  │  ❌ ${t}`),
    warn: (t) => $(`  │  ⚠️  ${t}`),
    skip: (t) => $(`  │  ⏭️  ${t}`),
    info: (t) => $(`  │  ℹ️  ${t}`),
    end:  () => $(`  └${'─'.repeat(50)}┘`),
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function progressBar(cur, total, len = 18) {
    const pct = total > 0 ? cur / total : 0;
    return `[${'█'.repeat(Math.round(pct * len))}${'░'.repeat(len - Math.round(pct * len))}] ${cur}/${total} ${(pct * 100).toFixed(0)}%`;
}

function timeStr() { return new Date().toLocaleString("zh-CN", { hour12: false }); }

// ─── 热搜关键词 ───
async function fetchKeywords() {
    try {
        const { data } = await axios.get("https://weibo.com/ajax/side/hotSearch", { timeout: 5000 });
        if (data?.data?.realtime) return data.data.realtime.slice(0, 20).map(i => i.word).filter(Boolean);
    } catch {}
    return [
        "天气","新闻","科技","体育","娱乐","财经","教育","健康","旅游","美食",
        "Python","JavaScript","Node.js","React","AI","人工智能","区块链","云计算","大数据","物联网",
        "Visual Studio","GitHub","Docker","Kubernetes","Azure","Windows 11","Office","TypeScript","VS Code","Edge",
        "编程","算法","数据","深度学习","机器学习","电影","音乐","游戏","读书","摄影",
        "中国","北京","上海","深圳","杭州","成都","武汉","南京","西安","重庆",
    ];
}

// ─── Bing搜索 ───
async function search(cookie, keyword, ua) {
    try {
        const { status } = await axios.get(`${BING_BASE}/search?q=${encodeURIComponent(keyword)}&form=QBRE`, {
            headers: { Cookie: cookie, "User-Agent": ua, "Accept": "text/html" },
            timeout: 15000,
            validateStatus: () => true,
        });
        return status === 200;
    } catch {
        return false;
    }
}

// ─── 获取用户名 ───
function extractEmail(cookie) {
    const m = cookie.match(/email=([^;]+)/) || cookie.match(/MSPTC=([^;]{8})/);
    return m ? m[1] : "未知账号";
}

// ─── 搜索执行（带进度条） ───
async function doSearches(label, count, keywordFn, cookie, ua) {
    LOG.sec(`${label} x${count}`);
    let ok = 0;
    for (let i = 0; i < count; i++) {
        const kw = keywordFn(i);
        const res = await search(cookie, kw, ua);
        if (res) ok++;
        process.stdout.write(`\r  │  ${progressBar(i + 1, count)}`);
        await sleep(3500 + Math.random() * 3000);
    }
    $(``);
    LOG.ok(`${ok}/${count} 搜索成功`);
    LOG.end();
    return ok;
}

// ─── 处理单个账号 ───
async function runAccount(cookie, index) {
    const email = extractEmail(cookie);
    const pcCount = parseInt(process.env.MS_PC_SEARCH) || 30;
    const mbCount = parseInt(process.env.MS_MB_SEARCH) || 20;

    $(`╔${'═'.repeat(50)}╗`);
    $(`║  👤 ${String(index + 1).padStart(2)}. ${String(email).padEnd(43)}║`);
    $(`║  🕐 ${timeStr().padEnd(46)}║`);
    $(`╚${'═'.repeat(50)}╝`);

    // 获取关键词
    const keywords = await fetchKeywords();

    // PC搜索
    const pcOk = await doSearches("🖥️  PC 搜索", pcCount, i => keywords[i % keywords.length], cookie, UA_PC);

    // 账号间延迟
    await sleep(3000 + Math.random() * 5000);

    // 移动搜索
    const mbOk = await doSearches("📱  移动搜索", mbCount, i => keywords[(i + 7) % keywords.length], cookie, UA_MOBILE);

    // 结果摘要
    $(`\n  ┌──────────────────────────────────────┐`);
    $(`  │  📊  搜索结果汇总                      │`);
    $(`  │                                      │`);
    $(`  │  🖥️  PC搜索:  ${String(pcOk).padStart(2)}/${String(pcCount).padStart(2)}                        │`);
    $(`  │  📱  移动搜索: ${String(mbOk).padStart(2)}/${String(mbCount).padStart(2)}                        │`);
    $(`  │                                      │`);
    $(`  │  💡 搜索完成后积分通常在几分钟内到账    │`);
    $(`  │     可登录 rewards.bing.com 查看       │`);
    $(`  └──────────────────────────────────────┘`);

    return { email, pcSearch: `${pcOk}/${pcCount}`, mbSearch: `${mbOk}/${mbCount}` };
}

// ─── 入口 ───
async function main() {
    const raw = process.env.MS_COOKIES || "";
    const accounts = raw.split('\n').filter(Boolean);

    if (accounts.length === 0) {
        $(`╔══════════════════════════════════════╗`);
        $(`║  🎯 Microsoft Rewards 搜索任务        ║`);
        $(`╠══════════════════════════════════════╣`);
        $(`║  ❌ 未配置 MS_COOKIES                ║`);
        $(`║  获取: rewards.bing.com → F12 →     ║`);
        $(`║  任意请求 → 复制 Cookie 头           ║`);
        $(`╚══════════════════════════════════════╝`);
        return;
    }

    $(`╔${'═'.repeat(50)}╗`);
    $(`║  🚀 Microsoft Rewards Bing搜索         ║`);
    $(`║  🕐 ${timeStr().padEnd(46)}║`);
    $(`║  👥 ${String(accounts.length).padStart(2)} 个账号                               ║`);
    $(`╚${'═'.repeat(50)}╝`);

    // 提示信息
    $(`\n  ℹ️  微软Rewards旧版API已移除`);
    $(`  ℹ️  当前仅执行Bing搜索（最可靠的积分来源）`);
    $((`  ℹ️  PC搜索 ${process.env.MS_PC_SEARCH || 30} 次 + 移动搜索 ${process.env.MS_MB_SEARCH || 20} 次`));
    
    const results = [];
    for (let idx = 0; idx < accounts.length; idx++) {
        try {
            const r = await runAccount(accounts[idx].trim(), idx);
            results.push(r);
        } catch (e) {
            $(`\n  ❌ 账号 ${idx + 1} 异常: ${e.message}`);
            results.push({ email: `账号 ${idx + 1}`, error: e.message });
        }
        if (idx < accounts.length - 1) {
            const wait = 5 + Math.random() * 10;
            $(`\n  ⏳ 等待 ${wait.toFixed(0)} 秒后处理下一个...`);
            await sleep(wait * 1000);
        }
    }

    // 汇总
    $(`\n╔${'═'.repeat(50)}╗`);
    $(`║  📊          执行报告              ║`);
    $(`╠${'═'.repeat(50)}╣`);
    let ok = 0, fail = 0;
    for (const r of results) {
        if (r.error) {
            $(`║  ❌ ${String(r.email).padEnd(44)}║`);
            fail++;
        } else {
            $(`║  ✅ ${String(r.email).padEnd(44)}║`);
            $((`║     PC: ${String(r.pcSearch).padStart(5)}  移动: ${String(r.mbSearch).padStart(5)}${' '.repeat(30)}║`));
            ok++;
        }
        $(`║  ${'─'.repeat(48)}║`);
    }
    $(`╠${'═'.repeat(50)}╣`);
    $(`║  成功 ${String(ok).padStart(2)} / 失败 ${String(fail).padStart(2)}${' '.repeat(35)}║`);
    $(`╚${'═'.repeat(50)}╝`);
}

main().catch(e => $(`\n❌ 致命: ${e.message}`));
