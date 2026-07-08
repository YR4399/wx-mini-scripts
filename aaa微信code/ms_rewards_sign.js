/*
@Description: Microsoft Rewards 签到+搜索+每日活动+打卡+升级任务
cron: 0 8 * * *
环境变量: MS_COOKIES (多账号换行分隔)
可选: MS_PC_SEARCH=10, MS_MB_SEARCH=10
*/

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const UA_PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0";
const UA_MOBILE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Edg/125.0.0.0";
const REWARDS_BASE = "https://rewards.bing.com";
const BING_BASE = "https://www.bing.com";

// ─── 日志工具 ───
const $ = (msg) => console.log(String(msg));
const LOG = {
    head:  (t) => $(`\n╔══════════════════════════════════════════╗\n║  ${t.padEnd(42)}\n╚══════════════════════════════════════════╝`),
    sec:   (t) => $(`\n  ┌─ ${t} ─${'─'.repeat(Math.max(0, 50 - t.length - 4))}┐`),
    sub:   (t) => $(`  │ ${t}`),
    ok:    (t) => $(`  │  ✅ ${t}`),
    fail:  (t) => $(`  │  ❌ ${t}`),
    warn:  (t) => $(`  │  ⚠️  ${t}`),
    skip:  (t) => $(`  │  ⏭️  ${t}`),
    info:  (t) => $(`  │  ℹ️  ${t}`),
    prize: (t) => $(`  │  🏆 ${t}`),
    done:  (t) => $(`  │  ✅ ${t}`),
    end:   () => $(`  └${'─'.repeat(56)}┘`),
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function progressBar(current, total, len = 20) {
    const pct = total > 0 ? (current / total) : 0;
    const filled = Math.round(pct * len);
    const empty = len - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${current}/${total}`;
}

function timeStr() { return new Date().toLocaleString("zh-CN", { hour12: false }); }

function extractFromCookie(cookie, name) {
    const m = cookie.match(new RegExp(`${name}=([^;]+)`));
    return m ? m[1] : "";
}

// ─── 网络请求 ───
async function apiGet(url, cookie, ua = UA_PC) {
    try {
        const { data, status } = await axios.get(url, {
            headers: { Cookie: cookie, "User-Agent": ua, "Accept": "application/json" },
            timeout: 20000, validateStatus: () => true,
        });
        return { status, data };
    } catch (e) { return { status: 0, data: null, error: e.message }; }
}

async function apiPost(url, cookie, body = {}, ua = UA_PC) {
    try {
        const { data, status } = await axios.post(url, body, {
            headers: { Cookie: cookie, "User-Agent": ua, "Content-Type": "application/json" },
            timeout: 20000, validateStatus: () => true,
        });
        return { status, data };
    } catch (e) { return { status: 0, data: null, error: e.message }; }
}

async function apiGetHtml(url, cookie, ua = UA_PC) {
    try {
        const { data, status } = await axios.get(url, {
            headers: { Cookie: cookie, "User-Agent": ua, "Accept": "text/html,application/xhtml+xml" },
            timeout: 20000, validateStatus: () => true,
        });
        return { status, data: String(data) };
    } catch (e) { return { status: 0, data: null, error: e.message }; }
}

// ─── 1. 查询用户状态 ───
async function getStatus(cookie) {
    return await apiGet(`${REWARDS_BASE}/api/getuserstatus`, cookie);
}

// ─── 2. 搜索 ───
async function searchPC(cookie, keyword) {
    const r = await apiGetHtml(`${BING_BASE}/search?q=${encodeURIComponent(keyword)}&form=QBRE`, cookie, UA_PC);
    return r.status === 200;
}

async function searchMobile(cookie, keyword) {
    const r = await apiGetHtml(`${BING_BASE}/search?q=${encodeURIComponent(keyword)}&form=QBRE`, cookie, UA_MOBILE);
    return r.status === 200;
}

// ─── 3. 每日签到 ───
async function dailyCheckin(cookie) {
    const endpoints = [
        `${REWARDS_BASE}/api/checkin`,
        `${REWARDS_BASE}/api/DailySignIn/SignIn`,
        `${REWARDS_BASE}/api/User/Checkin`,
    ];
    for (const url of endpoints) {
        const r = await apiPost(url, cookie, {});
        if (r.status === 200) return r;
    }
    return { status: 0, data: null };
}

// ─── 4. 领取连续打卡奖励 ───
async function claimStreak(cookie, streakPromotionId) {
    if (!streakPromotionId) { LOG.skip(`无连续打卡奖励可领取`); return false; }
    for (const url of [
        `${REWARDS_BASE}/api/streak/claim`,
        `${REWARDS_BASE}/api/Streak/ClaimPromotion`,
    ]) {
        const r = await apiPost(url, cookie, { promotionId: streakPromotionId });
        if (r.status === 200 && (r.data?.code === 0 || r.data?.status === "success")) {
            LOG.prize(`连续打卡奖励已领取`);
            return true;
        }
    }
    LOG.warn(`领取连续打卡奖励失败`);
    return false;
}

// ─── 5. 执行每日活动 ───
async function completeDailySet(dailySetItem, cookie) {
    const offerId = dailySetItem.offerId || "";
    const name = dailySetItem.name || "每日活动";
    const destUrl = dailySetItem.destinationUrl || dailySetItem.destinationUrlUniversal || "";
    const promoType = dailySetItem.promotionType || "";

    if (dailySetItem.complete) { LOG.ok(`${name} 已完成`); return true; }

    LOG.sub(`${name} (${promoType})`);

    // URL 类型
    if (destUrl) {
        const r = await apiGetHtml(destUrl, cookie);
        if (r.status === 200) { LOG.done(`访问页面完成`); await sleep(2000); return true; }
    }

    // quiz/poll
    if (["quiz","poll","activity"].includes(promoType)) {
        const pageUrl = destUrl || `${REWARDS_BASE}/offerwall/${offerId}`;
        const r = await apiGetHtml(pageUrl, cookie);
        if (r.status === 200 && String(r.data).length > 100) { LOG.done(`Quiz页面已访问`); await sleep(2000); return true; }
    }

    // API 完成
    if (offerId) {
        const r = await apiPost(`${REWARDS_BASE}/api/CompletePromotion`, cookie, { offerId, promotionType: promoType });
        if (r.status === 200 && (r.data?.code === 0 || r.data?.status === "success")) { LOG.done(`完成`); return true; }
    }

    if (["urlreward","app","adcampaign","ecosystem"].includes(promoType)) { LOG.skip(`${promoType} 需要浏览器操作，跳过`); return false; }
    LOG.warn(`无法自动完成`);
    return false;
}

// ─── 6. 执行 PunchCard ───
async function completePunchCard(punchCard, cookie) {
    const name = punchCard.name || punchCard.title || "PunchCard";
    if (punchCard.complete) { LOG.ok(`${name} 已完成`); return true; }

    LOG.sub(`${name}`);
    const children = punchCard.childPromotions || [];
    if (children.length === 0) { LOG.skip(`无子任务`); return false; }

    let done = 0;
    for (const child of children) {
        if (child.complete) { LOG.ok(`${child.name || "子任务"} 已完成`); done++; continue; }
        const destUrl = child.destinationUrl || child.destinationUrlUniversal || "";
        if (destUrl) {
            const r = await apiGetHtml(destUrl, cookie);
            if (r.status === 200) { LOG.done(`${child.name || "子任务"} 访问完成`); done++; await sleep(2000 + Math.random() * 2000); continue; }
        }
        if (child.offerId || child.promotionId) {
            const r = await apiPost(`${REWARDS_BASE}/api/CompletePromotion`, cookie, {
                offerId: child.offerId || child.promotionId,
                promotionType: child.promotionType || "punchcard"
            });
            if (r.status === 200) { LOG.done(`${child.name || "子任务"} 完成`); done++; await sleep(1500); continue; }
        }
        LOG.warn(`无法完成 ${child.name || "子任务"}`);
    }
    LOG.info(`子任务进度: ${done}/${children.length}`);
    return done > 0;
}

// ─── 7. 获取热搜关键词 ───
async function fetchHotKeywords() {
    try {
        const { data } = await axios.get("https://weibo.com/ajax/side/hotSearch", { timeout: 5000 });
        if (data?.data?.realtime) return data.data.realtime.slice(0, 10).map(i => i.word).filter(Boolean);
    } catch {}
    try {
        const { data } = await axios.get("https://tenapi.cn/v2/weibohot", { timeout: 5000 });
        if (data?.data) return data.data.slice(0, 10).map(i => typeof i === "string" ? i : i.name).filter(Boolean);
    } catch {}
    return ["天气","新闻","科技","体育","娱乐","财经","教育","健康","旅游","美食",
        "Python","JavaScript","Node.js","React","AI","人工智能","区块链","云计算","大数据","物联网",
        "Visual Studio","GitHub","Docker","Kubernetes","Azure","Windows 11","Office","TypeScript","VS Code","Edge",
        "编程","算法","数据结构","深度学习","机器学习","电影","音乐","游戏","读书","摄影"];
}

// ─── 搜索进度动画 ───
async function doSearchWithProgress(label, count, keywordFn, searchFn, cookie) {
    LOG.sub(`${label} x${count}`);
    let ok = 0;
    for (let i = 0; i < count; i++) {
        const kw = keywordFn(i);
        const res = await searchFn(cookie, kw);
        if (res) ok++;
        // 每 2 次更新进度条
        if ((i + 1) % 2 === 0 || i === count - 1) {
            process.stdout.write(`\r  │  ${progressBar(i + 1, count)} ${Math.round((i + 1) / count * 100)}%`);
        }
        await sleep(2500 + Math.random() * 2500);
    }
    $(``);
    LOG.done(`${ok}/${count} 成功`);
    return ok;
}

// ─── 主逻辑 ───
async function runAccount(cookie, index) {
    const email = extractFromCookie(cookie, "email") || `账号 ${index + 1}`;

    // ═══ 顶部横幅 ═══
    $(`\n╔${'═'.repeat(56)}╗`);
    $(`║  👤  ${String(email).padEnd(48)}║`);
    $(`║  🕐  ${timeStr().padEnd(48)}║`);
    $(`╚${'═'.repeat(56)}╝`);

    // ─── 1. 查询状态 ───
    LOG.sec(`📊 查询用户状态`);
    const statusResp = await getStatus(cookie);
    if (statusResp.status !== 200 || !statusResp.data) {
        LOG.fail(`获取状态失败 (Cookie 可能过期)`);
        LOG.end();
        return { email, error: "Cookie expired or invalid" };
    }

    const statusData = statusResp.data;
    const pointsBefore = statusData.availablePoints || statusData.userStatus?.availablePoints || 0;
    const level = statusData.userStatus?.level || statusData.level || "-";
    const streak = statusData.userStatus?.dailyStreak?.currentStreak || statusData.streakData?.streakCount || 0;
    const streakBonusPoints = statusData.streakData?.bonusPoints || 0;

    // 用户信息卡片
    $(`  │  ┌──────────────────────────────────────┐`);
    $(`  │  │  📍 积分: ${String(pointsBefore).padEnd(10)}  Lv.${String(level).padEnd(5)}  │`);
    $(`  │  │  🔥 连续打卡: ${String(streak).padEnd(3)} 天             │`);
    $(`  │  │  💰 打卡奖励: ${streakBonusPoints > 0 ? `${streakBonusPoints} 分` : "无"}             │`);
    $(`  │  └──────────────────────────────────────┘`);
    LOG.end();

    // ─── 2. 每日签到 ───
    LOG.sec(`📅 每日签到`);
    const checkin = await dailyCheckin(cookie);
    if (checkin.status === 200) { LOG.done(`签到请求成功`); }
    else { LOG.warn(`签到端点不可用 (可能在搜索中自动完成)`); }
    LOG.end();

    // ─── 3. 领取连续打卡奖励 ───
    if (streak > 0 && streakBonusPoints > 0) {
        LOG.sec(`🏆 连续打卡奖励 (${streakBonusPoints} 分)`);
        const streakPromoId = statusData.streakData?.promotionId || statusData.userStatus?.streakData?.promotionId || "";
        if (streakPromoId) await claimStreak(cookie, streakPromoId);
        else LOG.skip(`无待领取的连续打卡奖励`);
        LOG.end();
    }

    // ─── 4. 每日活动 ───
    const dailySet = statusData.userStatus?.dailySetPromotions || statusData.dailySetPromotions || [];
    if (dailySet.length > 0) {
        const pending = dailySet.filter(d => !d.complete);
        LOG.sec(`🎯 每日活动 (共${dailySet.length}个, 待完成${pending.length}个)`);
        for (const item of dailySet) { await completeDailySet(item, cookie); await sleep(1500 + Math.random() * 2000); }
        LOG.end();
    }

    // ─── 5. PunchCard ───
    const punchCards = statusData.userStatus?.punchCards || statusData.punchCards || [];
    if (punchCards.length > 0) {
        const pendingCards = punchCards.filter(p => !p.complete);
        LOG.sec(`💳 升级任务 (共${punchCards.length}个, 待完成${pendingCards.length}个)`);
        for (const card of punchCards) { await completePunchCard(card, cookie); await sleep(2000 + Math.random() * 3000); }
        LOG.end();
    }

    // ─── 6. PC 搜索 ───
    const pcCount = parseInt(process.env.MS_PC_SEARCH) || 10;
    const keywords = await fetchHotKeywords();
    LOG.sec(`🖥️  PC 搜索`);
    const pcOk = await doSearchWithProgress("PC搜索", pcCount, i => keywords[i % keywords.length], searchPC, cookie);
    LOG.end();

    // ─── 7. 移动搜索 ───
    const mbCount = parseInt(process.env.MS_MB_SEARCH) || 10;
    LOG.sec(`📱  移动搜索`);
    const mbOk = await doSearchWithProgress("移动搜索", mbCount, i => keywords[(i + 5) % keywords.length], searchMobile, cookie);
    LOG.end();

    // ─── 8. 最终积分 ───
    const finalStatus = await getStatus(cookie);
    const pointsAfter = finalStatus.data?.availablePoints || finalStatus.data?.userStatus?.availablePoints || 0;
    const earned = Math.max(0, pointsAfter - pointsBefore);

    // 结果卡片
    $(`\n  ┌──────────────────────────────────────┐`);
    $(`  │  📈 积分变化                          │`);
    $(`  │                                      │`);
    $(`  │        ${String(pointsBefore).padStart(8)}  →  ${String(pointsAfter).padStart(8)}        │`);
    const earnedStr = earned > 0 ? `+${earned}` : `+${earned}`;
    $(`  │              ${earned > 0 ? '📈' : '💤'}   ${(earned > 0 ? '+' : '') + earned} 分            │`);
    $(`  │                                      │`);
    if (earned === 0) {
        $(`  │  ⚠️  可能原因:                       │`);
        $(`  │   1. 已达今日上限                    │`);
        $(`  │   2. 系统延迟刷新                    │`);
        $(`  │   3. Cookie 状态异常                 │`);
    }
    $(`  └──────────────────────────────────────┘`);

    return { email, pointsBefore, pointsAfter, earned, level, streak, pcSearch: `${pcOk}/${pcCount}`, mbSearch: `${mbOk}/${mbCount}` };
}

// ─── 入口 ───
async function main() {
    const raw = process.env.MS_COOKIES || "";
    const accounts = raw.split('\n').filter(Boolean);

    if (accounts.length === 0) {
        $(`╔══════════════════════════════════════════╗`);
        $(`║  🎯  Microsoft Rewards 自动任务          ║`);
        $(`╠══════════════════════════════════════════╣`);
        $(`║  ❌ 未配置 MS_COOKIES                    ║`);
        $(`║  获取: rewards.bing.com → F12 → Cookie  ║`);
        $(`╚══════════════════════════════════════════╝`);
        return;
    }

    $(`╔${'═'.repeat(56)}╗`);
    $(`║  🚀  Microsoft Rewards 全自动任务系统        ║`);
    $(`║  🕐  ${timeStr().padEnd(48)}║`);
    $(`║  👥  共 ${String(accounts.length).padStart(2)} 个账号${' '.repeat(38)}║`);
    $(`╚${'═'.repeat(56)}╝`);

    const results = [];

    for (let idx = 0; idx < accounts.length; idx++) {
        try {
            const result = await runAccount(accounts[idx].trim(), idx);
            results.push(result);
        } catch (e) {
            LOG.fail(`账号 ${idx + 1} 异常: ${e.message}`);
            results.push({ email: `账号 ${idx + 1}`, error: e.message });
        }
        if (idx < accounts.length - 1) {
            const wait = 5 + Math.random() * 10;
            $(`\n  ⏳ 等待 ${wait.toFixed(0)} 秒后处理下一个账号...`);
            await sleep(wait * 1000);
        }
    }

    // ═══ 最终汇总 ═══
    $(`\n╔${'═'.repeat(56)}╗`);
    $(`║  📊          执行报告              ${' '.repeat(28)}║`);
    $(`╠${'═'.repeat(56)}╣`);
    let totalEarned = 0, successCount = 0, failCount = 0;
    for (const r of results) {
        if (r.error) {
            $(`║  ❌  ${r.email.padEnd(42)}  ║`);
            $(`║  ${`错误: ${r.error}`.padEnd(54)}║`);
            failCount++;
        } else {
            const line = `✅  ${r.email}`;
            $(`║  ${line.padEnd(54)}║`);
            const detail = `${String(r.pointsBefore).padStart(6)}  →  ${String(r.pointsAfter).padStart(6)}  (${r.earned > 0 ? '+' : ''}${r.earned})  Lv.${r.level}  🔥${r.streak}天`;
            $(`║  ${detail.padEnd(54)}║`);
            const search = `搜索: PC ${r.pcSearch}  移动 ${r.mbSearch}`;
            $(`║  ${search.padEnd(54)}║`);
            totalEarned += r.earned;
            successCount++;
        }
        $(`║  ${'─'.repeat(54)}║`);
    }
    $(`╠${'═'.repeat(56)}╣`);
    $(`║  成功 ${String(successCount).padStart(2)} / 失败 ${String(failCount).padStart(2)}${' '.repeat(40)}║`);
    $(`║  总积分: ${(totalEarned > 0 ? '+' : '') + String(totalEarned)}${' '.repeat(43)}║`);
    $(`╚${'═'.repeat(56)}╝`);
}

main().catch(e => $(`\n❌ 致命错误: ${e.message}`));
