#!/usr/bin/env node
/**
 * 芳华未来 v2 - 签到 + 课程视频 + 刷短视频 + 其他任务
 * 
 * 修复项:
 *   1. 登录改用 fetch API + loginType=1 + source=app + token 从根级解析
 *   2. 所有任务积分上限自动停止
 *   3. 新增: invited/getVideoReward, scrollRewards, getVideoRewardRules
 *   4. 指纹风控: 随机延迟, UA轮转, 指纹头, 请求间隔抖动
 * 
 * 环境变量: FHWL=账号1@密码1&账号2@密码2
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── 配置 ──────────────────────────────────────
const BASE = "https://h5api.his.cdwjyyh.com";
const BASE2 = "https://api.cdwjyyh.com";
const BASE_LIVE = "https://api.fhhx.runtzh.com";
const TOKEN_CACHE = path.join(__dirname, "fanghua_token_cache.json");

// 反检测 UA 池
const UA_POOL = [
  "Mozilla/5.0 (Linux; Android 16; M2012K11AC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.207 Mobile Safari/537.36 (Immersed/30.47619) Html5Plus/1.0",
  "Mozilla/5.0 (Linux; Android 14; SM-S908B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.166 Mobile Safari/537.36 (Immersed/30.47619) Html5Plus/1.0",
  "Mozilla/5.0 (Linux; Android 14; V2310 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.166 Mobile Safari/537.36 (Immersed/30.47619) Html5Plus/1.0",
  "Mozilla/5.0 (Linux; Android 15; CPH2601 Build/AP3A.240617.018; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.166 Mobile Safari/537.36 (Immersed/30.47619) Html5Plus/1.0",
  "Mozilla/5.0 (Linux; Android 14; 2403PPN6DC Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.166 Mobile Safari/537.36 (Immersed/30.47619) Html5Plus/1.0",
];

function pickUA() { return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]; }

// ── 日志 ──────────────────────────────────────
const notifyLines = [];
const _origLog = console.log;
console.log = function (...args) {
  try { notifyLines.push(args.map(a => String(a)).join(" ")); } catch (e) {}
  _origLog.apply(console, args);
};
function printBanner() {
  console.log("");
  console.log("  ╔═══════════════════════════════════╗");
  console.log("  ║  🌸  芳华未来 v2  签到·课程·短视频  ║");
  console.log("  ╚═══════════════════════════════════╝");
  console.log("");
}
function log(account, msg) {
  console.log(`  ═══════ ${account} ═══════ ${msg}`);
}
function logInfo(account, msg) { console.log(`  📌 [${account}] ${msg}`); }
function logSuccess(account, msg) { console.log(`  ✅ [${account}] ${msg}`); }
function logWarn(account, msg) { console.log(`  ⚠️  [${account}] ${msg}`); }
function logError(account, msg) { console.log(`  ❌ [${account}] ${msg}`); }

// ── 延迟工具 ──────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function jitter(base) { return base * (0.7 + Math.random() * 0.6); } // ±30% 抖动

// ── 请求封装 (fetch) ──────────────────────────
async function request(opts) {
  const { method = "POST", url, headers = {}, body = null, timeout = 15000 } = opts;
  const fullUrl = url.startsWith("http") ? url : BASE + url;
  const h = {
    "User-Agent": pickUA(),
    "Content-Type": "application/json;charset=UTF-8",
    ...headers,
  };
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeout);
    const init = { method, headers: h, signal: ctrl.signal };
    if (body) init.body = JSON.stringify(body);
    const resp = await fetch(fullUrl, init);
    clearTimeout(tid);
    const text = await resp.text();
    try { return { status: resp.status, data: JSON.parse(text) }; }
    catch { return { status: resp.status, data: { code: resp.status, msg: text } }; }
  } catch (e) {
    if (e.name === "AbortError") throw new Error("请求超时");
    throw e;
  }
}

// ── Token 缓存 ────────────────────────────────
function loadCache() {
  try { return fs.existsSync(TOKEN_CACHE) ? JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8")) : {}; }
  catch { return {}; }
}
function saveCache(cache) { fs.writeFileSync(TOKEN_CACHE, JSON.stringify(cache, null, 2), "utf8"); }

// ── 登录 ──────────────────────────────────────
async function getToken(phone, pwd, cache) {
  const key = phone;
  // 尝试使用缓存 token 验证
  if (cache[key] && cache[key].token) {
    const { token, liveToken } = cache[key];
    try {
      const resp = await request({ method: "GET", url: `${BASE}/app/user/getUserInfo`, headers: { AppToken: token } });
      const d = resp.data;
      if (d && d.code === 200) {
        // 缓存有效
        return { token, liveToken: liveToken || "", userId: cache[key].userId, nickName: cache[key].nickName, integral: cache[key].integral };
      }
    } catch {}
    // 缓存失效，继续用密码登录
  }
  // 登录: plaintext 密码 + loginType=1 + source=app
  const resp = await request({
    method: "POST",
    url: `${BASE}/app/app/login`,
    body: { phone, password: pwd, loginType: 1, source: "app" },
  });
  const d = resp.data;
  if (!d || d.code !== 200 || !d.token) {
    throw new Error(`登录失败: ${(d && d.msg) || "未知错误"}`);
  }
  const userId = d.user ? d.user.userId : null;
  const nickName = d.user ? d.user.nickName : null;
  const liveToken = d.liveToken || "";
  // 写入缓存
  const integral = d.user ? d.user.integral : null;
  cache[key] = { token: d.token, liveToken, userId, nickName, integral };
  saveCache(cache);
  return { token: d.token, liveToken, userId, nickName, integral };
}

// ── 获取余额 ──────────────────────────────────
async function getBalance(token) {
  const resp = await request({ method: "GET", url: `${BASE}/app/user/getUserInfo`, headers: { AppToken: token } });
  return resp.data.user ? resp.data.user.integral : null;
}

// ── 签到 ──────────────────────────────────────
async function sign(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/integral/sign`, headers: { AppToken: token, liveToken }, body: {} });
  return resp.data;
}

// ── 分享健康 ──────────────────────────────────
async function shareHealth(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/integral/shareHealth`, headers: { AppToken: token, liveToken }, body: { logType: 3 } });
  return resp.data;
}

// ── 获取积分 ──────────────────────────────────
async function getIntegral(token, liveToken) {
  // 旧接口已废弃,改用 getUserSign 获取积分
  const resp = await request({ method: "GET", url: `${BASE}/app/integral/getUserSign`, headers: { AppToken: token, liveToken } });
  return resp.data;
}

// ── 获取课程列表 ──────────────────────────────
async function getCourseList(token, liveToken) {
  // 旧 BASE 课程接口已返回 500,尝试 BASE2
  try {
    const resp = await request({ method: "POST", url: `${BASE2}/app/course/getCourseList`, headers: { AppToken: token, liveToken }, body: { pageNum: 1, pageSize: 20, isIntegral: 1 } });
    const d = resp.data;
    if (d && d.code === 200 && d.data && d.data.list) return d.data.list;
    if (d && d.code === 200 && d.data && Array.isArray(d.data)) return d.data;
  } catch (e) {
    console.log("  [课程列表] BASE2 失败:", e.message);
  }
  return [];
}

// ── 获取课程视频列表 ──────────────────────────
async function getCourseVideoList(token, liveToken, courseId) {
  const resp = await request({ method: "POST", url: `${BASE}/app/course/getCourseVideoList`, headers: { AppToken: token, liveToken }, body: { pageNum: 1, courseId } });
  const d = resp.data;
  if (d && d.code === 200 && d.data && d.data.list) return d.data.list;
  if (d && d.code === 200 && d.data && Array.isArray(d.data)) return d.data;
  return [];
}

// ── 添加学习记录 ──────────────────────────────
async function addStudyCourse(token, liveToken, courseId, videoId, duration) {
  try {
    const resp = await request({ method: "POST", url: `${BASE2}/app/course/addStudyCourse`, headers: { AppToken: token, liveToken }, body: { courseId: Number(courseId), duration, videoId: Number(videoId) } });
    return resp.data;
  } catch (e) {
    console.log("  [学习记录] BASE2 失败:", e.message);
    return { code: -1, msg: "BASE2 失败: " + e.message };
  }
}

// ── 领取积分 ──────────────────────────────────
async function addIntegral(token, liveToken, type = 2) {
  const resp = await request({ method: "POST", url: `${BASE}/app/integral/addIntegral`, headers: { AppToken: token, liveToken }, body: { type } });
  return resp.data;
}

// ── 获取视频列表 ──────────────────────────────
async function getVideoList(token, liveToken, pageNum = 1, lastVideoId = "") {
  try {
    const params = new URLSearchParams({ keyword: "", isRandom: 1, videoId: lastVideoId, pageNum: String(pageNum), pageSize: "10" });
    const resp = await request({ method: "GET", url: `${BASE}/app/video/getVideoList-new?${params}`, headers: { AppToken: token, liveToken } });
    const d = resp.data;
    if (d && d.code === 200 && d.data && d.data.list) return d.data.list;
    if (d && d.code === 200 && d.data && Array.isArray(d.data)) return d.data;
  } catch (e) {
    console.log("  [视频列表] 失败:", e.message);
  }
  return [];
}

// ── 视频跟踪 ──────────────────────────────────
async function trackVideo(token, liveToken, videoId, event) {
  // 旧 BASE trackVideo 已返回 404,使用 BASE2
  try {
    await request({ method: "POST", url: `${BASE2}/app/video/track`, headers: { AppToken: token, liveToken }, body: { videoId: String(videoId), event } });
  } catch (e) {
    console.log("  [视频跟踪] BASE2 失败:", e.message);
  }
}

// ── 点赞视频 ──────────────────────────────────
async function doLike(token, liveToken, videoId) {
  try {
    await request({ method: "POST", url: `${BASE2}/app/video/doLike`, headers: { AppToken: token, liveToken }, body: { videoId: String(videoId) } });
  } catch (e) {
    console.log("  [点赞] BASE2 失败:", e.message);
  }
}

// ── 评论文本池 ────────────────────────────────
const COMMENT_TEXTS = ["讲得真好，受益匪浅！", "内容很实用，收藏了~", "通俗易懂，赞一个", "学到了很多健康知识，谢谢分享", "老师讲得很细致，支持！"];

// ── 视频评论 ──────────────────────────────────
async function videoComment(token, liveToken, videoId, content) {
  try {
    const resp = await request({ method: "POST", url: `${BASE2}/app/video/addComment`, headers: { AppToken: token, liveToken }, body: { videoId: String(videoId), content, parentId: "" } });
    return resp.data;
  } catch (e) {
    console.log("  [视频评论] BASE2 失败:", e.message);
    return { code: -1, msg: "BASE2 失败: " + e.message };
  }
}

// ── 课程评论 ──────────────────────────────────
async function courseComment(token, liveToken, courseId, content) {
  const variants = [{ parentId: 0 }, { parentId: "" }, {}];
  for (const v of variants) {
    const resp = await request({ method: "POST", url: `${BASE}/app/course/comment/addComment`, headers: { AppToken: token, liveToken }, body: { courseId: String(courseId), content, ...v } });
    if (resp.data && resp.data.code === 200) return resp.data;
  }
  return { code: -1, msg: "评论失败" };
}

// ── 领取签到奖励 ──────────────────────────────
async function claimSignReward(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/integral/claimSignReward`, headers: { AppToken: token, liveToken }, body: { source: 3, appId: "wx703c4bd07bbd1695" } });
  return resp.data;
}

// ── 新人转盘 ──────────────────────────────────
async function sendTurntableReward(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/newUser/sendTurntableReward`, headers: { AppToken: token, liveToken }, body: {} });
  return resp.data;
}

// ── 领取福袋 ──────────────────────────────────
async function receiveLuckyBag(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/luckyBag/receiveLuckyBag`, headers: { AppToken: token, liveToken }, body: {} });
  return resp.data;
}

// ── 直播列表 ──────────────────────────────────
async function getLiveList(liveToken) {
  const resp = await request({ method: "GET", url: `${BASE_LIVE}/appLive/app/live/liveList?pageNum=1&pageSize=10`, headers: { AppToken: liveToken } });
  const d = resp.data;
  if (d && d.code === 200 && d.data) {
    const list = d.data.list || d.data;
    return Array.isArray(list) ? list : [];
  }
  return [];
}

// ── 直播完成奖励 ──────────────────────────────
async function liveReceivePoints(liveToken, liveId) {
  const resp = await request({ method: "POST", url: `${BASE_LIVE}/appLive/app/live/completion/receive-points?liveId=${liveId}`, headers: { AppToken: liveToken }, body: String(liveId) });
  return resp.data;
}

// ── 邀请视频奖励 (APK 新增) ───────────────────
async function invitedVideoReward(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/invited/getVideoReward`, headers: { AppToken: token, liveToken }, body: {} });
  return resp.data;
}

// ── 滚动奖励 (APK 新增) ───────────────────────
async function scrollRewards(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/course/scrollRewards`, headers: { AppToken: token, liveToken }, body: { pageNum: 1, pageSize: 10 } });
  return resp.data;
}

// ── 视频奖励类型/规则 (APK 新增) ──────────────
async function getVideoRewardTypes(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/course/getVideoRewardTypesApp`, headers: { AppToken: token, liveToken }, body: { source: 3 } });
  return resp.data;
}
async function getVideoRewardRules(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/course/getVideoRewardRulesApp`, headers: { AppToken: token, liveToken }, body: { source: 3 } });
  return resp.data;
}

// ── 阅读资讯 ──────────────────────────────────
async function getDoctorArticleList(token, liveToken) {
  const resp = await request({ method: "GET", url: `${BASE}/app/doctorArticle/getDoctorArticleList?pageNum=1&pageSize=10`, headers: { AppToken: token, liveToken } });
  const d = resp.data;
  if (d && d.code === 200 && d.data) {
    const list = d.data.list || d.data;
    return Array.isArray(list) ? list : [];
  }
  return [];
}

// ── 检查是否达上限 ────────────────────────────
// ── 创建日志 (APK) ──────────────────────────
async function createLog(token, liveToken, userId) {
  try {
    await request({ method: "POST", url: `${BASE}/app/common/createLogs`, headers: { AppToken: token, liveToken }, body: { userId: String(userId) } });
  } catch (e) { /* 忽略 */ }
}

// ── 获取App配置 (APK) ────────────────────────
async function getAppConfig(token, liveToken) {
  try {
    await request({ method: "GET", url: `${BASE}/app/common/getAppPageConfig`, headers: { AppToken: token, liveToken } });
  } catch (e) { /* 忽略 */ }
}


function isAtLimit(msg) {
  if (!msg) return false;
  return /上限|已达|今日.*完成|已完成|领取.*上限|次数.*超过|机会.*用完|没有.*机会|暂无/.test(msg);
}

// ── 观看课程视频 ──────────────────────────────
async function watchCourseVideo(token, liveToken, courseId, videoId) {
  const watchTime = randInt(12, 15);
  await sleep(jitter(watchTime * 1000));
  await addStudyCourse(token, liveToken, courseId, videoId, watchTime);
  for (let retry = 0; retry < 3; retry++) {
    const reward = await addIntegral(token, liveToken);
    const msg = (reward && reward.msg) || "";
    if (isAtLimit(msg)) return { earned: false, stop: true, msg: "积分上限" };
    if (msg.includes("芳华币") || (reward && reward.code === 200)) return { earned: true, msg };
    if (msg.includes("过于频繁")) { await sleep(Math.min(5000 * (retry + 1), 15000)); continue; }
    return { earned: false, msg };
  }
  return { earned: false, msg: "重试超限" };
}

// ── 观看短视频 ────────────────────────────────
async function watchShortVideo(token, liveToken, video) {
  const vid = String(video.id);
  // 发送 PLAY 事件
  await trackVideo(token, liveToken, vid, "PLAY");
  // 等待3-7秒后发 PLAY_3S
  await sleep(jitter(randInt(3000, 7000)));
  await trackVideo(token, liveToken, vid, "PLAY_3S");
  // 完整观看 12-60秒
  const watchSec = randInt(12, 60);
  let elapsed = 0;
  let coinCount = 0;
  while (elapsed < watchSec) {
    await sleep(1000);
    elapsed++;
    // 每10秒领一次积分
    if (elapsed % 10 === 0) {
      try {
        const r = await addIntegral(token, liveToken);
        const msg = (r && r.msg) || "";
        if (r && r.code === 200) {
          coinCount++;
        } else if (isAtLimit(msg)) {
          break; // 积分上限
        }
      } catch (e) {
        // 忽略错误，继续观看
      }
    }
  }
  // 发送 COMPLETE
  await trackVideo(token, liveToken, vid, "COMPLETE");
  return { earned: coinCount > 0, coinCount, watchSec, msg: `观看${watchSec}s,领积分${coinCount}次` };
}

// ── 主流程 ────────────────────────────────────
async function processAccount(phone, pwd, cache) {
  log(phone, "开始执行");
  try {
    const { token, liveToken, userId, nickName, integral } = await getToken(phone, pwd, cache);
    const balanceBefore = integral ?? (await getBalance(token));
    logSuccess(phone, `余额: ${balanceBefore}`);
    logSuccess(phone, `登录成功 ${nickName || phone} (ID: ${userId})`);
    // 初始化日志和配置
    createLog(token, liveToken, userId);
    getAppConfig(token, liveToken);
    await sleep(jitter(2000));

    // 1. 签到
    logInfo(phone, "--- 签到 ---");
    try {
      const sr = await sign(token, liveToken);
      logInfo(phone, sr.msg || JSON.stringify(sr));
    } catch (e) { logWarn(phone, `签到失败: ${e.message}`); }
    await sleep(jitter(2000));

    // 1.5 其他日常任务
    logInfo(phone, "--- 日常任务 ---");
    const dailyTasks = [
      { name: "签到奖励", fn: () => claimSignReward(token, liveToken) },
      { name: "新人转盘", fn: () => sendTurntableReward(token, liveToken) },
      { name: "领取福袋", fn: () => receiveLuckyBag(token, liveToken) },
      { name: "邀请视频奖励", fn: () => invitedVideoReward(token, liveToken) },
      { name: "滚动奖励", fn: () => scrollRewards(token, liveToken) },
    ];
    for (const t of dailyTasks) {
      try {
        const r = await t.fn();
        const msg = (r && r.msg) || "";
        if (r && r.code === 200) {
          logSuccess(phone, `🎁 ${t.name}: ${msg || "成功"}`);
        } else {
          logInfo(phone, `◽ ${t.name}: ${msg || JSON.stringify(r || {}).substring(0, 80)}`);
        }
      } catch (e) { logWarn(phone, `${t.name} 出错: ${e.message}`); }
      await sleep(jitter(randInt(2000, 4000)));
    }

    // 1.6 分享健康 (固定60次, 间隔5秒)
    logInfo(phone, "--- 分享健康 ---");
    const SHARE_MAX = 60;
    let shareCount = 0;
    for (let i = 0; i < SHARE_MAX; i++) {
      try {
        const r = await shareHealth(token, liveToken);
        const msg = (r && r.msg) || "";
        if (r && r.code === 200) {
          shareCount++;
          logSuccess(phone, "🔗 分享健康 #" + shareCount + ": " + msg);
        } else if (isAtLimit(msg)) {
          logWarn(phone, "分享健康停止: " + msg); break;
        } else {
          logInfo(phone, "分享健康停止: " + msg); break;
        }
      } catch (e) { logWarn(phone, "分享健康出错: " + e.message); break; }
      if (i < SHARE_MAX - 1) await sleep(jitter(5000));
    }
    logInfo(phone, "分享健康完成 " + shareCount + " 次");
    await sleep(jitter(2000));

    // 2. 课程视频
    logInfo(phone, "--- 课程视频 ---");
    let courseCount = 0;
    let courseStop = "";
    try {
      const courses = await getCourseList(token, liveToken);
      logInfo(phone, `可积分课程: ${courses.length} 个`);
      if (courses.length === 0) logWarn(phone, "无可积分课程");
      for (const course of courses) {
        if (courseStop) break;
        const videos = await getCourseVideoList(token, liveToken, course.courseId);
        if (videos.length === 0) continue;
        const video = videos[0];
        logInfo(phone, `📺 课程${course.courseId} 视频${video.videoId}`);
        const result = await watchCourseVideo(token, liveToken, course.courseId, video.videoId);
        courseCount++;
        if (result.stop) { courseStop = result.msg; break; }
        if (result.earned) logSuccess(phone, `获得奖励: ${result.msg}`);
        else logWarn(phone, `未获奖励: ${result.msg}`);
        await sleep(jitter(randInt(5000, 10000)));
      }
    } catch (e) { logWarn(phone, `课程列表出错: ${e.message} (可能缺 liveToken)`); }
    if (!courseStop) courseStop = "全部完成";
    logInfo(phone, `课程视频: ${courseCount} 个 | ${courseStop}`);
    await sleep(jitter(3000));

    // 3. 短视频 (挂机模式: 观看期间每10秒领积分)
    logInfo(phone, "--- 刷短视频 ---");
    let shortCount = 0;
    let shortCoins = 0;
    let shortStop = "";
    let pageNum = 1;
    let lastVideoId = "";
    let shortStreak = 0;
    while (true) {
      if (shortStreak >= 8) { shortStop = "连续未获奖,停止"; break; }
      if (pageNum > 15) { shortStop = "翻页过多"; break; }
      try {
        const videos = await getVideoList(token, liveToken, pageNum, lastVideoId);
        if (videos.length === 0) { pageNum++; await sleep(jitter(3000)); continue; }
        const video = videos[randInt(0, videos.length - 1)];
        logInfo(phone, `📺 短视频 ${video.username || video.title || "佚名"}`);
        const result = await watchShortVideo(token, liveToken, video);
        shortCount++;
        shortCoins += result.coinCount || 0;
        if (result.earned) {
          shortStreak = 0;
          logSuccess(phone, `🎬 ${result.msg}`);
        } else {
          shortStreak++;
          logWarn(phone, `未获奖 (${shortStreak}/8): ${result.msg || "无"}`);
        }
        lastVideoId = video.id;
        await sleep(jitter(randInt(3000, 6000)));
      } catch (e) { logError(phone, `短视频出错: ${e.message}`); break; }
    }
    if (!shortStop) shortStop = "全部完成";
    logInfo(phone, `短视频: ${shortCount} 个, 积分${shortCoins}次 | ${shortStop}`);

    // 4. 最终积分
    logInfo(phone, "--- 最终积分 ---");
    try {
      const fi = await getIntegral(token, liveToken);
      logInfo(phone, `当前积分: ${fi.integral || fi}`);
    } catch (e) { logWarn(phone, `获取积分失败: ${e.message}`); }

    try {
      const balanceAfter = await getBalance(token);
      const delta = (balanceAfter !== null && balanceBefore !== null) ? balanceAfter - balanceBefore : "?";
      log(phone, `余额: ${balanceBefore} → ${balanceAfter} (变化 ${delta})`);
    } catch (e) { logWarn(phone, `获取结束余额失败: ${e.message}`); }
    log(phone, `🏁 完成: 分享${shareCount} 课程${courseCount} 短视频${shortCount}(${shortCoins}积分)`);
    return { phone, nickName, shareCount, courseCount, shortCount, shortCoins };
  } catch (err) {
    logError(phone, `执行失败: ${err.message}`);
    return { phone, error: err.message };
  }
}

// ── 推送 ──────────────────────────────────────
async function sendToPushPlus(title, content) {
  const token = process.env.PLUSPLUS_TOKEN || process.env.PUSH_PLUS_TOKEN || "";
  if (!token || !content.trim()) return;
  if (content.length > 6000) content = content.slice(-6000);
  try {
    await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, title, content, template: "txt" }),
    });
    _origLog("✅ PushPlus推送成功");
  } catch (e) { _origLog("❌ PushPlus推送失败: " + (e.message || e)); }
}

// ── 入口 ──────────────────────────────────────
async function main() {
  const fhwl = process.env.FHWL || "";
  if (!fhwl) {
    console.error("\n❌ 请设置环境变量: FHWL");
    console.error("   格式: 账号1@密码1&账号2@密码2\n");
    process.exit(1);
  }
  printBanner();
  const accounts = fhwl.split("&").map(p => {
    const t = p.trim();
    if (!t.includes("@")) return null;
    const [phone, pwd] = t.split("@").map(s => s.trim());
    return phone && pwd ? { phone, pwd } : null;
  }).filter(Boolean);
  if (accounts.length === 0) { console.error("❌ 未解析到有效账号\n"); process.exit(1); }

  console.log(`   账号数量: ${accounts.length}`);
  console.log(`   开始并发执行...\n`);

  const cache = loadCache();
  const results = await Promise.all(accounts.map(acc => processAccount(acc.phone, acc.pwd, cache)));

  console.log("");
  console.log("  ╔═══════════════════════════════════╗");
  console.log("  ║           📊   执 行 汇 总         ║");
  console.log("  ╠═══════════════════════════════════╣");
  let totalShare = 0, totalCourse = 0, totalShort = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`  ❌ [${r.phone}] 失败: ${r.error}`);
    } else {
      totalShare += r.shareCount || 0;
      totalCourse += r.courseCount || 0;
      totalShort += r.shortCount || 0;
      console.log(`  ✅ [${r.phone || r.nickName}] 分享${r.shareCount} 课程${r.courseCount} 短视频${r.shortCount}`);
    }
  }
  console.log("  ╠═══════════════════════════════════╣");
  console.log(`  🔗 分享健康: ${totalShare} 次`);
  console.log(`  📺 课程视频: ${totalCourse} 个`);
  console.log(`  🎬 短视频: ${totalShort} 个`);
  console.log("  ╚═══════════════════════════════════╝");
  console.log("");
  await sendToPushPlus("芳华未来", notifyLines.join("\n"));
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
