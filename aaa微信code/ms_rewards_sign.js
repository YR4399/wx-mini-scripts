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

function $(msg) { console.log(String(msg)); }

function extractFromCookie(cookie, name) {
    const m = cookie.match(new RegExp(`${name}=([^;]+)`));
    return m ? m[1] : "";
}

// ====== 延迟 ======
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ====== 通用请求 ======
async function apiGet(url, cookie, ua = UA_PC) {
    try {
        const { data, status } = await axios.get(url, {
            headers: { Cookie: cookie, "User-Agent": ua, "Accept": "application/json" },
            timeout: 20000,
            validateStatus: () => true,
        });
        return { status, data };
    } catch (e) { return { status: 0, data: null, error: e.message }; }
}

async function apiPost(url, cookie, body = {}, ua = UA_PC) {
    try {
        const { data, status } = await axios.post(url, body, {
            headers: { Cookie: cookie, "User-Agent": ua, "Content-Type": "application/json" },
            timeout: 20000,
            validateStatus: () => true,
        });
        return { status, data };
    } catch (e) { return { status: 0, data: null, error: e.message }; }
}

async function apiGetHtml(url, cookie, ua = UA_PC) {
    try {
        const { data, status } = await axios.get(url, {
            headers: { Cookie: cookie, "User-Agent": ua, "Accept": "text/html,application/xhtml+xml" },
            timeout: 20000,
            validateStatus: () => true,
        });
        return { status, data: String(data) };
    } catch (e) { return { status: 0, data: null, error: e.message }; }
}

// ====== 1. 查询用户状态 ======
async function getStatus(cookie) {
    return await apiGet(`${REWARDS_BASE}/api/getuserstatus`, cookie);
}

// ====== 2. 搜索 ======
async function searchPC(cookie, keyword) {
    const r = await apiGetHtml(`${BING_BASE}/search?q=${encodeURIComponent(keyword)}&form=QBRE`, cookie, UA_PC);
    return r.status === 200;
}

async function searchMobile(cookie, keyword) {
    const r = await apiGetHtml(`${BING_BASE}/search?q=${encodeURIComponent(keyword)}&form=QBRE`, cookie, UA_MOBILE);
    return r.status === 200;
}

// ====== 3. 每日打卡/签到 (连续打卡) ======
async function dailyCheckin(cookie) {
    // 尝试多种签到端点
    const endpoints = [
        { url: `${REWARDS_BASE}/api/checkin`, method: "POST" },
        { url: `${REWARDS_BASE}/api/DailySignIn/SignIn`, method: "POST" },
        { url: `${REWARDS_BASE}/api/User/Checkin`, method: "POST" },
    ];
    for (const ep of endpoints) {
        const r = await apiPost(ep.url, cookie, {});
        if (r.status === 200) return r;
    }
    return { status: 0, data: null };
}

// ====== 4. 领取连续打卡奖励 (Streak Bonus) ======
async function claimStreak(cookie, streakPromotionId) {
    if (!streakPromotionId) {
        $(`  ⏭️ 无连续打卡奖励可领取`);
        return false;
    }
    const r = await apiPost(`${REWARDS_BASE}/api/streak/claim`, cookie, {
        promotionId: streakPromotionId
    });
    if (r.status === 200 && (r.data?.code === 0 || r.data?.status === "success")) {
        $(`  ✅ 连续打卡奖励已领取`);
        return true;
    }
    // 尝试不同端点
    const r2 = await apiPost(`${REWARDS_BASE}/api/Streak/ClaimPromotion`, cookie, {
        promotionId: streakPromotionId
    });
    if (r2.status === 200 && (r2.data?.code === 0 || r2.data?.status === "success")) {
        $(`  ✅ 连续打卡奖励已领取`);
        return true;
    }
    $(`  ⚠️ 领取连续打卡奖励: ${JSON.stringify(r.data || r2.data).slice(0, 80)}`);
    return false;
}

// ====== 5. 执行每日活动 (Daily Set / Quiz / Poll) ======
async function completeDailySet(dailySetItem, cookie) {
    const offerId = dailySetItem.offerId || "";
    const name = dailySetItem.name || "每日活动";
    const destUrl = dailySetItem.destinationUrl || dailySetItem.destinationUrlUniversal || "";
    const promoType = dailySetItem.promotionType || "";
    
    $(`    [${name}] type=${promoType}`);
    
    if (dailySetItem.complete) {
        $(`      ✅ 已完成`);
        return true;
    }

    // 1. 如果是 URL 类型活动，访问目标 URL
    if (destUrl) {
        $(`      🔗 访问: ${destUrl.slice(0, 60)}...`);
        const r = await apiGetHtml(destUrl, cookie);
        if (r.status === 200) {
            $(`      ✅ 访问完成`);
            await sleep(2000);
            return true;
        }
    }

    // 2. 如果是 quiz/poll 类型
    if (promoType === "quiz" || promoType === "poll" || promoType === "activity") {
        // 通过获取活动页面并完成
        const pageUrl = destUrl || `${REWARDS_BASE}/offerwall/${offerId}`;
        const r = await apiGetHtml(pageUrl, cookie);
        if (r.status === 200 && String(r.data).length > 100) {
            $(`      ✅ Quiz页面已访问`);
            await sleep(2000);
            return true;
        }
    }

    // 3. 尝试通过官方点选接口完成
    if (offerId) {
        const r2 = await apiPost(`${REWARDS_BASE}/api/CompletePromotion`, cookie, {
            offerId: offerId,
            promotionType: promoType
        });
        if (r2.status === 200 && (r2.data?.code === 0 || r2.data?.status === "success")) {
            $(`      ✅ 完成`);
            return true;
        }
    }

    // 4. 如果是非 Web 活动 (Edge 浏览器活动等), 标记为跳过
    const skipTypes = ["urlreward", "app", "adcampaign", "ecosystem"];
    if (skipTypes.includes(promoType)) {
        $(`      ⏭️ 类型 ${promoType} 需要浏览器操作，跳过`);
        return false;
    }

    $(`      ⚠️ 无法自动完成`);
    return false;
}

// ====== 6. 执行 PunchCard (升级任务) ======
async function completePunchCard(punchCard, cookie) {
    const name = punchCard.name || punchCard.title || "PunchCard";
    $(`    [${name}]`);

    if (punchCard.complete) {
        $(`      ✅ 已完成`);
        return true;
    }

    const children = punchCard.childPromotions || [];
    if (children.length === 0) {
        $(`      ⏭️ 无子任务`);
        return false;
    }

    let done = 0;
    for (const child of children) {
        if (child.complete) {
            $(`      ✅ ${child.name || "子任务"} 已完成`);
            done++;
            continue;
        }
        const destUrl = child.destinationUrl || child.destinationUrlUniversal || "";
        if (destUrl) {
            $(`      🔗 ${child.name || "子任务"}: ${destUrl.slice(0, 50)}...`);
            const r = await apiGetHtml(destUrl, cookie);
            if (r.status === 200) {
                $(`        ✅ 访问完成`);
                done++;
                await sleep(2000 + Math.random() * 2000);
                continue;
            }
        }
        // 尝试 CompletePromotion
        if (child.offerId || child.promotionId) {
            const r2 = await apiPost(`${REWARDS_BASE}/api/CompletePromotion`, cookie, {
                offerId: child.offerId || child.promotionId,
                promotionType: child.promotionType || "punchcard"
            });
            if (r2.status === 200) {
                $(`        ✅ 完成`);
                done++;
                await sleep(1500);
                continue;
            }
        }
        $(`      ⚠️ 无法完成 ${child.name || "子任务"}`);
    }

    $(`  子任务 ${done}/${children.length}`);
    return done > 0;
}

// ====== 7. 获取每日热门搜索词 ======
async function fetchHotKeywords() {
    try {
        const { data } = await axios.get("https://weibo.com/ajax/side/hotSearch", { timeout: 5000 });
        if (data?.data?.realtime) {
            return data.data.realtime.slice(0, 10).map(item => item.word).filter(Boolean);
        }
    } catch (e) {}
    try {
        const { data } = await axios.get("https://tenapi.cn/v2/weibohot", { timeout: 5000 });
        if (data?.data) {
            return data.data.slice(0, 10).map(item => (typeof item === "string" ? item : item.name)).filter(Boolean);
        }
    } catch (e) {}
    return [
        "天气", "新闻", "科技", "体育", "娱乐",
        "财经", "教育", "健康", "旅游", "美食",
        "Python", "JavaScript", "Node.js", "React", "AI",
        "人工智能", "区块链", "云计算", "大数据", "物联网",
        "Visual Studio", "GitHub", "Docker", "Kubernetes", "Azure",
        "Windows 11", "Office", "TypeScript", "VS Code", "Edge",
        "编程", "算法", "数据结构", "深度学习", "机器学习",
        "电影", "音乐", "游戏", "读书", "摄影",
    ];
}

// ====== 主逻辑 ======
async function runAccount(cookie, index) {
    const email = extractFromCookie(cookie, "email") || "Account " + (index + 1);
    $(`\n══════════════════════════════════`);
    $(`  账号 ${index + 1}: ${email}`);
    $(`══════════════════════════════════`);

    let totalEarned = 0;

    // === 1. 获取用户状态 ===
    $(`\n📊 查询用户状态...`);
    const statusResp = await getStatus(cookie);
    if (statusResp.status !== 200 || !statusResp.data) {
        $(`❌ 获取状态失败 (Cookie 可能过期)`);
        return { email, error: "Cookie expired or invalid" };
    }

    const statusData = statusResp.data;
    const pointsBefore = statusData.availablePoints || statusData.userStatus?.availablePoints || 0;
    const level = statusData.userStatus?.level || statusData.level || "-";
    const streak = statusData.userStatus?.dailyStreak?.currentStreak || statusData.streakData?.streakCount || 0;
    const streakBonusPoints = statusData.streakData?.bonusPoints || 0;

    $(`  积分: ${pointsBefore}`);
    $(`  等级: ${level}`);
    $(`  连续打卡: ${streak} 天`);

    // === 2. 每日签到 ===
    $(`\n📅 每日签到...`);
    const checkin = await dailyCheckin(cookie);
    if (checkin.status === 200) {
        $(`  ✅ 签到请求成功`);
    } else {
        $(`  ⚠️ 签到端点不可用 (可能在搜索中自动完成)`);
    }

    // === 3. 领取连续打卡奖励 ===
    if (streak > 0 && streakBonusPoints > 0) {
        $(`\n🏆 领取连续打卡奖励 (${streakBonusPoints} 分)...`);
        const streakPromoId = statusData.streakData?.promotionId || 
                              statusData.userStatus?.streakData?.promotionId || "";
        if (streakPromoId) {
            await claimStreak(cookie, streakPromoId);
        } else {
            $(`  ⏭️ 无待领取的连续打卡奖励`);
        }
    }

    // === 4. 执行每日活动 (Daily Set) ===
    const dailySet = statusData.userStatus?.dailySetPromotions || 
                     statusData.dailySetPromotions || [];
    if (dailySet.length > 0) {
        const pending = dailySet.filter(d => !d.complete);
        $(`\n🎯 每日活动: ${dailySet.length} 个, 待完成: ${pending.length} 个`);
        for (const item of dailySet) {
            await completeDailySet(item, cookie);
            await sleep(1500 + Math.random() * 2000);
        }
    } else {
        $(`\n🎯 每日活动: 无`);
    }

    // === 5. 执行 PunchCard (升级任务) ===
    const punchCards = statusData.userStatus?.punchCards || 
                       statusData.punchCards || [];
    if (punchCards.length > 0) {
        const pendingCards = punchCards.filter(p => !p.complete);
        $(`\n💳 升级任务 (PunchCard): ${punchCards.length} 个, 待完成: ${pendingCards.length} 个`);
        for (const card of punchCards) {
            await completePunchCard(card, cookie);
            await sleep(2000 + Math.random() * 3000);
        }
    } else {
        $(`\n💳 升级任务 (PunchCard): 无`);
    }

    // === 6. PC 搜索 ===
    const pcCount = parseInt(process.env.MS_PC_SEARCH) || 10;
    const keywords = await fetchHotKeywords();
    $(`\n🔍 PC 搜索 x${pcCount}...`);
    let pcOk = 0;
    for (let i = 0; i < pcCount; i++) {
        const kw = keywords[i % keywords.length];
        const ok = await searchPC(cookie, kw);
        if (ok) pcOk++;
        if ((i + 1) % 5 === 0) $(`    ${i + 1}/${pcCount}...`);
        await sleep(2500 + Math.random() * 2500);
    }
    $(`  PC 搜索完成: ${pcOk}/${pcCount}`);

    // === 7. 移动搜索 ===
    const mbCount = parseInt(process.env.MS_MB_SEARCH) || 10;
    $(`\n📱 移动搜索 x${mbCount}...`);
    let mbOk = 0;
    for (let i = 0; i < mbCount; i++) {
        const kw = keywords[(i + 5) % keywords.length];
        const ok = await searchMobile(cookie, kw);
        if (ok) mbOk++;
        if ((i + 1) % 5 === 0) $(`    ${i + 1}/${mbCount}...`);
        await sleep(2500 + Math.random() * 2500);
    }
    $(`  移动搜索完成: ${mbOk}/${mbCount}`);

    // === 8. 查询最终积分 ===
    const finalStatus = await getStatus(cookie);
    const pointsAfter = finalStatus.data?.availablePoints || 
                        finalStatus.data?.userStatus?.availablePoints || 0;
    const earned = pointsAfter - pointsBefore;
    totalEarned = Math.max(0, earned);
    
    $(`\n📈 积分变化: ${pointsBefore} → ${pointsAfter} (+${totalEarned})`);
    if (totalEarned === 0) {
        $(`  ⚠️ 积分未增加，可能: 1) 任务需时间刷新 2) Cookie 异常 3) 已达今日上限`);
    }

    return {
        email,
        pointsBefore,
        pointsAfter,
        earned: totalEarned,
        level,
        streak,
        pcSearch: `${pcOk}/${pcCount}`,
        mbSearch: `${mbOk}/${mbCount}`,
    };
}

// ====== 入口 ======
async function main() {
    const raw = process.env.MS_COOKIES || "";
    const accounts = raw.split('\n').filter(Boolean);

    if (accounts.length === 0) {
        $(`[MS Rewards] 未配置 MS_COOKIES`);
        $(`获取方式: 登录 https://rewards.bing.com → F12 → Network → 复制 Cookie`);
        return;
    }

    $(`🚀 Microsoft Rewards 全自动任务开始`);
    $(`📋 共 ${accounts.length} 个账号\n`);

    const results = [];

    for (let idx = 0; idx < accounts.length; idx++) {
        try {
            const result = await runAccount(accounts[idx].trim(), idx);
            results.push(result);
        } catch (e) {
            $(`\n❌ 账号 ${idx + 1} 异常: ${e.message}`);
            results.push({ email: `Account ${idx + 1}`, error: e.message });
        }
        if (idx < accounts.length - 1) {
            await sleep(5000 + Math.random() * 10000);
        }
    }

    // 汇总
    $(`\n══════════════════════════════════`);
    $(`             📊 汇总报告`);
    $(`══════════════════════════════════`);
    let totalEarned = 0;
    let successCount = 0;
    let failCount = 0;
    
    for (const r of results) {
        if (r.error) {
            $(`  ❌ ${r.email}: ${r.error}`);
            failCount++;
        } else {
            $(`  ✅ ${r.email}: ${r.pointsBefore} → ${r.pointsAfter} (+${r.earned}) | Lv.${r.level} | 搜索 PC:${r.pcSearch} MB:${r.mbSearch}`);
            totalEarned += r.earned;
            successCount++;
        }
    }
    $(`──────────────────────────────────`);
    $(`  成功 ${successCount} / 失败 ${failCount} | 共获得 +${totalEarned} 积分`);
}

main().catch(e => $(`Fatal: ${e.message}`));
