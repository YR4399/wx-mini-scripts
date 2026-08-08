#!/usr/bin/env node
/**
 * 芳华未来 v3 - 签到 + 日常任务 + 分享健康 + 课程学习刷分 + 短视频领币
 *
 * v3 变更 (移植自 fhb_每日2000币.py, 基于 App v1.8.1 真实抓包):
 *   1. 【课程刷分修正】领分接口改为 /app/course/getIntegral (原误用 /app/integral/addIntegral),
 *      链路: (createIntegralOrder 兑换) -> addStudyCourse 注册会话 -> heartbeat 保活
 *            -> 观看至总时长 90% -> getIntegral 领 +50/小节
 *   2. 【课程全量】遍历课程所有小节(原仅第 1 个), 支持 studyTime 断点续看, duration=1 探测已领
 *   3. 【课程兑换】isBuy!=1 的小节用芳华币兑换解锁, 仅兑换价 < 50 的课程(每小节赚 50, 保本)
 *   4. 【短视频修正】addIntegral 必须带 videoId (原缺失导致恒不发奖), 多 type 重试(1=浏览/2=视频)
 *   5. 【领币节流】最短间隔 25s (低于此值服务端报"访问过于频繁"), 命中"频繁"退避重试,
 *      某 type 达上限后会话级记忆, 后续视频不再浪费请求
 *   6. 【每日目标】默认 2000 芳华币, 达标自动结束; 单账号最长运行时间保护
 *
 * 环境变量:
 *   FHWL              账号, 格式 手机号@密码&手机号@密码   (必填)
 *   FHWL_TARGET       每日目标芳华币, 默认 2000, 0=不限
 *   FHWL_MAX_HOURS    单账号最长运行小时, 默认 3
 *   FHWL_COURSE       1/0 是否启用课程刷分阶段, 默认 1
 *   FHWL_COURSE_BUY   1/0 是否兑换未拥有的课程小节, 默认 1
 *   FHWL_MAX_BUY      课程兑换价上限, 默认 50 (仅兑换低于此价的课程)
 *   FHWL_COURSE_MAX_SEC  跳过时长超过 N 秒的小节, 默认 0=不限 (测试时可设小值)
 *   FHWL_SHARE_MAX    分享健康次数, 默认 100
 *   FHWL_SHORT_MAX    短视频个数上限, 默认 100, 0=不限(启用防刷保护)
 *   PLUSPLUS_TOKEN    PushPlus 推送
 */

const fs = require("fs");
const path = require("path");
// apiSecurity 签名/解密 (逆向自 com.plugin.apisecurity.*, 2026-07-29)
const { buildSign, decryptResponse } = require("./fanghua_crypto.js");

// ── 配置 ──────────────────────────────────────
const BASE = "https://api.cdwjyyh.com";
const BASE_LIVE = "https://api.fhhx.runtzh.com";
const TOKEN_CACHE = path.join(__dirname, "fanghua_token_cache.json");
// 设备指纹: plus.device.uuid (同设备所有账号共用)
const DEVICE_ID = "3463638e6ddd99fc";

const envInt = (name, def) => {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : def;
};
const envBool = (name, def) => {
  const v = (process.env[name] || "").trim();
  return v === "" ? def : !(v === "0" || v.toLowerCase() === "false");
};

// 每日目标 / 运行时长
const DAILY_TARGET = envInt("FHWL_TARGET", 2000);      // 达标提前结束; 0=不限
const MAX_HOURS = envInt("FHWL_MAX_HOURS", 3);
const TARGET_CHECK_EVERY = 2;                          // 每 N 次成功领币查一次余额

// 课程阶段
const ENABLE_COURSE = envBool("FHWL_COURSE", true);
const ENABLE_COURSE_BUY = envBool("FHWL_COURSE_BUY", true);
const COURSE_MAX_BUY = envInt("FHWL_MAX_BUY", 50);     // 只兑换价 < 50 的课程
const COURSE_MAX_SEC = envInt("FHWL_COURSE_MAX_SEC", 0); // 跳过超长小节, 0=不限
const COURSE_INTEGRAL_PER_SECTION = 50;                // 服务端固定每小节 +50
const COURSE_PROGRESS_RATIO = 0.9;                     // 领分门槛: 看满总时长 90%
const COURSE_WATCH_BUFFER = 6;                         // 90% 之上多看的秒数
const COURSE_HEARTBEAT_INTERVAL = 30;                  // 心跳+进度上报间隔(秒)
const COURSE_LIST_PAGE_SIZE = 10;
const COURSE_CLAIM_MAX_RETRY = 3;

// 短视频阶段 (抓包链路: PLAY -> PLAY_3S -> COMPLETE -> 领币一次)
const PLAY_TO_3S_SECONDS = 5;      // PLAY -> PLAY_3S 等待中心值
const WATCH_AFTER_3S_SECONDS = 8;  // PLAY_3S -> 领币 等待中心值
const NEXT_VIDEO_DELAY = 3;        // 视频间隔中心值
const TIMING_JITTER = 2.0;         // 观看等待抖动 (±秒)
const SEND_COMPLETE = true;
const MIN_CLAIM_INTERVAL = 25;     // 两次领币最短间隔(秒), 低于此值服务端报"访问过于频繁"
const INTEGRAL_RETRY_TYPES = [1, 2];  // 1=浏览奖励 2=视频奖励 (日限分别计算)
const INTEGRAL_RETRY_MAX = 3;
const INTEGRAL_BUSY_BACKOFF = [8, 15];
const TYPE_LABELS = { 0: "直播?", 1: "浏览", 2: "视频", 3: "直播?", 4: "直播?" };

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
  console.log("  ╔═══════════════════════════════════════╗");
  console.log("  ║  🌸 芳华未来 v3  签到·课程+50·短视频  ║");
  console.log("  ╚═══════════════════════════════════════╝");
  console.log("");
}
function log(account, msg) { console.log(`  ═══════ ${account} ═══════ ${msg}`); }
function logInfo(account, msg) { console.log(`  📌 [${account}] ${msg}`); }
function logSuccess(account, msg) { console.log(`  ✅ [${account}] ${msg}`); }
function logWarn(account, msg) { console.log(`  ⚠️  [${account}] ${msg}`); }
function logError(account, msg) { console.log(`  ❌ [${account}] ${msg}`); }

// ── 延迟工具 ──────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return min + Math.random() * (max - min); }
function jitter(base) { return base * (0.7 + Math.random() * 0.6); }
/** 在中心值(秒)上叠加 ±TIMING_JITTER 抖动, 最小 0.5s, 模拟真人节奏 */
function jittered(baseSec) { return Math.max(0.5, baseSec + randFloat(-TIMING_JITTER, TIMING_JITTER)); }

// ── 请求封装 (fetch + apiSecurity) ────────────
async function request(opts) {
  const { method = "POST", url, headers = {}, body = null, timeout = 15000 } = opts;
  const fullUrl = url.startsWith("http") ? url : BASE + url;
  const h = { "User-Agent": pickUA(), "Content-Type": "application/json;charset=UTF-8", ...headers };
  let finalUrl = fullUrl;
  let finalBody = body;

  // api.cdwjyyh.com 必须 apiSecurity 签名 + AES 加密体, 否则 401 非法请求
  if (fullUrl.includes("api.cdwjyyh.com")) {
    const payload = (body && typeof body === "object") ? body : {};
    const { ts, aesData, rsaSign } = buildSign(payload);
    h["X-Api-Timestamp"] = ts;
    h["X-Api-Nonce"] = Math.random().toString(36).substring(2, 15);
    h["X-Api-DeviceId"] = DEVICE_ID;
    h["X-Api-Sign"] = rsaSign;
    h["Content-Type"] = "text/plain";
    if (method === "GET" || method === "get") {
      finalUrl = fullUrl + (fullUrl.includes("?") ? "&" : "?") + "data=" + encodeURIComponent(aesData);
      finalBody = null;
    } else {
      finalBody = aesData;
    }
  }

  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), timeout);
      const init = { method, headers: h, signal: ctrl.signal };
      if (finalBody) init.body = (typeof finalBody === "string") ? finalBody : JSON.stringify(finalBody);
      const resp = await fetch(finalUrl, init);
      clearTimeout(tid);
      const text = await resp.text();
      if (/TencentWAF|400 Bad Request/i.test(text) && attempt < 3) continue;
      let data;
      try { data = JSON.parse(text); } catch { data = { code: resp.status, msg: text }; }
      if (data && data.encryptedKey && data.encryptedData) {
        try {
          const plain = decryptResponse(data.encryptedKey, data.encryptedData);
          try {
            const inner = JSON.parse(plain);
            data = inner.dataStr
              ? (() => { try { return JSON.parse(inner.dataStr); } catch { return inner.dataStr; } })()
              : inner;
          } catch { data = plain; }
        } catch (e) { console.log("  [解密失败]", e.message); }
      }
      return { status: resp.status, data };
    } catch (e) {
      if (e.name === "AbortError" && attempt >= 3) throw new Error("请求超时");
      if (attempt < 3) continue;
      throw e;
    }
  }
  return { status: 400, data: { code: 400, msg: "WAF 重试耗尽" } };
}

// ── Token 缓存 ────────────────────────────────
function loadCache() {
  try { return fs.existsSync(TOKEN_CACHE) ? JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8")) : {}; }
  catch { return {}; }
}
function saveCache(cache) {
  try { fs.writeFileSync(TOKEN_CACHE, JSON.stringify(cache, null, 2), "utf8"); } catch (e) {}
}

// ── 登录 ──────────────────────────────────────
async function doLogin(phone, pwd) {
  const resp = await request({
    method: "POST", url: `${BASE}/app/app/login`,
    body: { phone, password: pwd, loginType: 1, source: "app" },
  });
  const d = resp.data;
  if (!d || d.code !== 200 || !d.token) throw new Error(`登录失败: ${(d && d.msg) || "未知错误"}`);
  return {
    token: d.token,
    liveToken: d.liveToken || "",
    userId: d.user ? d.user.userId : null,
    nickName: d.user ? d.user.nickName : null,
    integral: d.user ? d.user.integral : null,
  };
}

async function getToken(phone, pwd, cache) {
  if (cache[phone] && cache[phone].token) {
    const { token, liveToken } = cache[phone];
    try {
      const resp = await request({ method: "GET", url: `${BASE}/app/user/getUserInfo`, headers: { AppToken: token } });
      const d = resp.data;
      if (d && d.code === 200) {
        return {
          token, liveToken: liveToken || "",
          userId: cache[phone].userId, nickName: cache[phone].nickName,
          integral: (d.user && d.user.integral != null) ? d.user.integral : cache[phone].integral,
        };
      }
    } catch (e) {}
  }
  const r = await doLogin(phone, pwd);
  cache[phone] = { token: r.token, liveToken: r.liveToken, userId: r.userId, nickName: r.nickName, integral: r.integral };
  saveCache(cache);
  return r;
}

// ── 余额 ──────────────────────────────────────
async function getBalance(token) {
  try {
    const resp = await request({ method: "GET", url: `${BASE}/app/user/getUserInfo`, headers: { AppToken: token } });
    return (resp.data && resp.data.user) ? resp.data.user.integral : null;
  } catch (e) { return null; }
}

// ── 判断是否达上限 ────────────────────────────
function isAtLimit(msg) {
  if (!msg) return false;
  return /上限|已达|今日.*完成|已完成|领取.*上限|次数.*超过|机会.*用完|没有.*机会|暂无/.test(msg);
}
function isBusy(msg) { return !!msg && /频繁|稍后|请勿|过快/.test(msg); }
function isAlready(msg) { return !!msg && /已领取|已获取|已经/.test(msg); }

// ── 基础日常任务 ──────────────────────────────
async function sign(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/integral/sign`, headers: { AppToken: token, liveToken }, body: {} });
  return resp.data;
}
async function shareHealth(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/integral/shareHealth`, headers: { AppToken: token, liveToken }, body: { logType: 3 } });
  return resp.data;
}
async function claimSignReward(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/integral/claimSignReward`, headers: { AppToken: token, liveToken }, body: { source: 3, appId: "wx703c4bd07bbd1695" } });
  return resp.data;
}
async function sendTurntableReward(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/newUser/sendTurntableReward`, headers: { AppToken: token, liveToken }, body: {} });
  return resp.data;
}
async function receiveLuckyBag(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/luckyBag/receiveLuckyBag`, headers: { AppToken: token, liveToken }, body: {} });
  return resp.data;
}
async function invitedVideoReward(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/invited/getVideoReward`, headers: { AppToken: token, liveToken }, body: {} });
  return resp.data;
}
async function scrollRewards(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/course/scrollRewards`, headers: { AppToken: token, liveToken }, body: { pageNum: 1, pageSize: 10 } });
  return resp.data;
}
async function createLog(token, liveToken, userId) {
  try { await request({ method: "POST", url: `${BASE}/app/common/createLogs`, headers: { AppToken: token, liveToken }, body: { userId: String(userId) } }); } catch (e) {}
}
async function getAppConfig(token, liveToken) {
  try { await request({ method: "GET", url: `${BASE}/app/common/getAppPageConfig`, headers: { AppToken: token, liveToken } }); } catch (e) {}
}

// ══════════════ 课程学习刷分 (每小节 +50 芳华币) ══════════════
// 链路: (createIntegralOrder 兑换) -> addStudyCourse 注册会话 -> heartbeat 保活
//       -> 观看至 90% 时长 -> /app/course/getIntegral 领 +50
const C_OK = "success", C_ALREADY = "already", C_LIMIT = "limit", C_FAIL = "failed";

async function getCourseList(token, liveToken, pageNum) {
  try {
    const resp = await request({
      method: "GET", url: `${BASE}/app/course/getCourseList`,
      headers: { AppToken: token, liveToken },
      body: { cateId: "", pageSize: COURSE_LIST_PAGE_SIZE, pageNum },
    });
    const d = resp.data;
    if (d && d.code === 200 && d.data) return [d.data.list || [], d.data.total || 0];
  } catch (e) {}
  return [[], 0];
}

async function getCourseVideoList(token, liveToken, courseId) {
  try {
    const resp = await request({
      method: "GET", url: `${BASE}/app/course/getCourseVideoList`,
      headers: { AppToken: token, liveToken },
      body: { pageSize: 50, courseId: String(courseId), pageNum: 1 },
    });
    const d = resp.data;
    if (d && d.code === 200 && d.data) return d.data.list || [];
  } catch (e) {}
  return [];
}

/** 课程芳华币兑换价 (null 视为免费) */
async function getCoursePrice(token, liveToken, courseId) {
  try {
    const resp = await request({
      method: "GET", url: `${BASE}/app/course/getCourseById?courseId=${courseId}`,
      headers: { AppToken: token, liveToken }, body: {},
    });
    const d = resp.data;
    if (d && d.code === 200 && d.data) return d.data.integral;
  } catch (e) {}
  return null;
}

/** 用芳华币兑换(解锁)单个课程小节 */
async function buyCourseVideo(token, liveToken, courseId, videoId) {
  try {
    const resp = await request({
      method: "POST", url: `${BASE}/app/courseOrder/createIntegralOrder`,
      headers: { AppToken: token, liveToken },
      body: { videoId: Number(videoId), courseId: String(courseId) },
    });
    const d = resp.data || {};
    return [d.code === 200, String(d.msg || "")];
  } catch (e) { return [false, e.message]; }
}

/** 注册/上报学习会话 (getIntegral 前置, 缺失会报"您还未看课") */
async function addStudyCourse(token, liveToken, courseId, videoId, duration) {
  try {
    const resp = await request({
      method: "POST", url: `${BASE}/app/course/addStudyCourse`,
      headers: { AppToken: token, liveToken },
      body: { duration: Number(duration), videoId: Number(videoId), courseId: Number(courseId) },
    });
    return !!(resp.data && resp.data.code === 200);
  } catch (e) { return false; }
}

async function courseHeartbeat(token, liveToken) {
  try {
    await request({ method: "POST", url: `${BASE}/app/portrait/heartbeat`, headers: { AppToken: token, liveToken }, body: { action: "HEARTBEAT" } });
  } catch (e) {}
}

/** 领取小节课程积分 (+50) */
async function claimCourseIntegral(token, liveToken, videoId, duration) {
  try {
    const resp = await request({
      method: "POST", url: `${BASE}/app/course/getIntegral`,
      headers: { AppToken: token, liveToken },
      body: { duration: Number(duration), videoId: Number(videoId) },
    });
    const d = resp.data;
    if (!d) return [C_FAIL, "无响应"];
    const msg = String(d.msg || "");
    if (d.code === 200) return [C_OK, msg];
    if (/已获取此小节|已领取/.test(msg)) return [C_ALREADY, msg];
    if (/上限/.test(msg)) return [C_LIMIT, msg];
    return [C_FAIL, msg];
  } catch (e) { return [C_FAIL, e.message]; }
}

/** 兑换 + 断点续看 + 领分 单个小节 */
async function studyOneCourseVideo(st, courseId, video) {
  const { phone, token, liveToken } = st;
  const videoId = video.videoId;
  const seconds = parseInt(video.seconds || 0, 10);
  if (!videoId || seconds <= 0) return C_FAIL;
  const title = String(video.title || "").trim().slice(0, 18);

  if (COURSE_MAX_SEC > 0 && seconds > COURSE_MAX_SEC) {
    logInfo(phone, `⏭️  《${title}》时长 ${seconds}s > ${COURSE_MAX_SEC}s 上限, 跳过`);
    return C_FAIL;
  }

  const need = Math.floor(seconds * COURSE_PROGRESS_RATIO) + COURSE_WATCH_BUFFER;
  const already = Math.min(parseInt(video.studyTime || 0, 10), seconds); // 服务端断点

  // 1) 未拥有先兑换解锁
  if (ENABLE_COURSE_BUY && video.isBuy !== 1) {
    const [ok, msg] = await buyCourseVideo(token, liveToken, courseId, videoId);
    if (!ok) { logInfo(phone, `🔒 《${title}》兑换失败(${msg}), 跳过`); return C_FAIL; }
    logSuccess(phone, `🛒 已兑换《${title}》`);
  }

  // 2) 注册学习会话 (用断点做初始 duration)
  await addStudyCourse(token, liveToken, courseId, videoId, Math.min(Math.max(already, 10), seconds));

  // 3) 断点已够 -> 直接领
  if (already >= need) {
    const [r, msg] = await claimCourseIntegral(token, liveToken, videoId, Math.max(already, need));
    if (r === C_OK) { logSuccess(phone, `💰 《${title}》${msg}(断点续领 +${COURSE_INTEGRAL_PER_SECTION})`); return C_OK; }
    if (r === C_ALREADY) { return C_ALREADY; }
    if (r === C_LIMIT) return C_LIMIT;
  } else {
    // 4) duration=1 探测是否已领 (不满 90% 不会误领)
    const [r] = await claimCourseIntegral(token, liveToken, videoId, 1);
    if (r === C_ALREADY) return C_ALREADY;
    if (r === C_LIMIT) return C_LIMIT;
  }

  // 5) 拟真续看: 只补看未看部分
  const remain = Math.max(0, need - already);
  logInfo(phone, `📖 学习《${title}》时长${seconds}s, 已看${already}s, 续看约${remain}s…`);
  let watched = already;
  while (watched < need) {
    if (Date.now() > st.deadline) return C_FAIL;
    const chunk = Math.min(COURSE_HEARTBEAT_INTERVAL, need - watched);
    await sleep(jittered(chunk) * 1000);
    watched += chunk;
    await courseHeartbeat(token, liveToken);
    await addStudyCourse(token, liveToken, courseId, videoId, watched);
  }

  // 6) 领分, 报"不满90%/未看课"则补看再试
  for (let i = 0; i < COURSE_CLAIM_MAX_RETRY; i++) {
    const [r, msg] = await claimCourseIntegral(token, liveToken, videoId, watched);
    if (r === C_OK) { logSuccess(phone, `💰 《${title}》${msg} (+${COURSE_INTEGRAL_PER_SECTION})`); return C_OK; }
    if (r === C_ALREADY || r === C_LIMIT) return r;
    if (/不满|未看课/.test(msg)) {
      if (Date.now() > st.deadline) return C_FAIL;
      await addStudyCourse(token, liveToken, courseId, videoId, watched);
      await sleep(jittered(COURSE_HEARTBEAT_INTERVAL) * 1000);
      watched += COURSE_HEARTBEAT_INTERVAL;
      await courseHeartbeat(token, liveToken);
      continue;
    }
    logWarn(phone, `《${title}》领分失败: ${msg}`);
    return C_FAIL;
  }
  return C_FAIL;
}

/** 课程刷分阶段: 遍历课程分页 -> 逐小节领分。返回 {claimed, limit} */
async function studyCourses(st) {
  const { phone, token, liveToken } = st;
  let claimed = 0, pageNum = 1;
  logInfo(phone, `--- 课程学习刷分 (每小节 +${COURSE_INTEGRAL_PER_SECTION}) ---`);

  while (true) {
    if (Date.now() > st.deadline) break;
    const [courses, total] = await getCourseList(token, liveToken, pageNum);
    if (!courses.length) break;

    for (const course of courses) {
      if (Date.now() > st.deadline) return { claimed, limit: false };
      if (course.isIntegral !== 1) continue;   // 非积分课程跳过
      const courseId = course.courseId;
      const courseName = String(course.courseName || "").trim().slice(0, 20);

      // 仅兑换价 < COURSE_MAX_BUY 的课程 (每小节赚 50, 保本)
      if (ENABLE_COURSE_BUY) {
        const price = await getCoursePrice(token, liveToken, courseId);
        if (price != null && price >= COURSE_MAX_BUY) {
          logInfo(phone, `⏭️  《${courseName}》兑换价 ${price} ≥ ${COURSE_MAX_BUY}, 跳过`);
          continue;
        }
      }
      const videos = await getCourseVideoList(token, liveToken, courseId);
      if (!videos.length) continue;
      logInfo(phone, `📗 课程《${courseName}》(${videos.length} 小节)`);

      for (const video of videos) {
        if (Date.now() > st.deadline) return { claimed, limit: false };
        const r = await studyOneCourseVideo(st, courseId, video);
        if (r === C_OK) {
          claimed++;
          logSuccess(phone, `课程累计领分: ${claimed} 小节 (+${claimed * COURSE_INTEGRAL_PER_SECTION})`);
          if (DAILY_TARGET > 0 && claimed * COURSE_INTEGRAL_PER_SECTION >= DAILY_TARGET) {
            logSuccess(phone, `🎯 课程阶段已达每日目标 (+${DAILY_TARGET}), 停止刷课`);
            return { claimed, limit: false };
          }
        } else if (r === C_LIMIT) {
          logWarn(phone, "🛑 课程积分已达每日上限, 结束课程阶段");
          return { claimed, limit: true };
        }
        await sleep(jittered(4) * 1000);
      }
    }
    pageNum++;
    if (total && pageNum > Math.ceil(total / COURSE_LIST_PAGE_SIZE)) break;
  }
  logInfo(phone, `课程阶段结束, 共领 ${claimed} 小节 (+${claimed * COURSE_INTEGRAL_PER_SECTION})`);
  return { claimed, limit: false };
}

// ══════════════ 短视频领币 ══════════════
const I_OK = "success", I_LIMIT = "limit", I_FAIL = "failed", I_BUSY = "busy", I_ALREADY = "already";

async function getVideoList(token, liveToken, pageNum) {
  try {
    const resp = await request({
      method: "GET", url: `${BASE}/app/video/getVideoList-new`,
      headers: { AppToken: token, liveToken },
      body: { isRandom: 1, pageSize: 10, keyword: "", pageNum },
    });
    const d = resp.data;
    if (d && d.code === 200 && d.data) return d.data.list || [];
  } catch (e) {}
  return [];
}

async function trackVideo(token, liveToken, videoId, event) {
  try {
    await request({ method: "POST", url: `${BASE}/app/video/track`, headers: { AppToken: token, liveToken }, body: { videoId: String(videoId), event } });
  } catch (e) {}
}

/** 单次领币: 必须带 videoId, 否则服务端恒不发奖 */
async function addIntegral(token, liveToken, videoId, type) {
  try {
    const resp = await request({
      method: "POST", url: `${BASE}/app/integral/addIntegral`,
      headers: { AppToken: token, liveToken },
      body: { videoId: String(videoId), type },
    });
    const d = resp.data;
    if (!d) return [I_FAIL, "无响应"];
    const msg = String(d.msg || "");
    if (d.code === 200) return [I_OK, msg];
    if (isBusy(msg)) return [I_BUSY, msg];
    if (isAlready(msg)) return [I_ALREADY, msg];
    if (isAtLimit(msg)) return [I_LIMIT, msg];
    return [I_FAIL, msg];
  } catch (e) { return [I_FAIL, e.message]; }
}

/** 多 type 反复领币: 命中"频繁"退避重试, "已领"换 type, 达上限会话级记忆 */
async function claimIntegralWithRetry(st, videoId) {
  const { phone, token, liveToken } = st;
  let claimedCount = 0, limitCount = 0;

  for (const type of INTEGRAL_RETRY_TYPES) {
    const label = TYPE_LABELS[type] || `type${type}`;
    if (st.exhaustedTypes.has(type)) { limitCount++; continue; }  // 已达上限, 不再浪费请求

    for (let attempt = 1; attempt <= INTEGRAL_RETRY_MAX; attempt++) {
      // 控制最短领币间隔, 避免"访问过于频繁"
      const deficit = MIN_CLAIM_INTERVAL * 1000 - (Date.now() - st.lastClaimTs);
      if (deficit > 0) await sleep(deficit);

      const [r, msg] = await addIntegral(token, liveToken, videoId, type);
      st.lastClaimTs = Date.now();

      if (r === I_OK) { claimedCount++; logSuccess(phone, `💰 [${label}type${type}] ${msg || "领取成功"}`); break; }
      if (r === I_ALREADY) break;                       // 本视频该 type 已领, 换下个 type
      if (r === I_LIMIT) {
        st.exhaustedTypes.add(type);
        logWarn(phone, `🛑 [${label}type${type}] 达每日上限: ${msg}`);
        limitCount++; break;
      }
      if (r === I_BUSY) {
        if (attempt < INTEGRAL_RETRY_MAX) {
          const backoff = randFloat(...INTEGRAL_BUSY_BACKOFF);
          logInfo(phone, `⏳ [${label}type${type}] 访问频繁, 退避 ${backoff.toFixed(1)}s (${attempt}/${INTEGRAL_RETRY_MAX})`);
          await sleep(backoff * 1000);
          continue;
        }
        break;
      }
      await sleep(randFloat(3, 6) * 1000);
      break;
    }
  }
  if (limitCount === INTEGRAL_RETRY_TYPES.length) return I_LIMIT;
  return claimedCount > 0 ? I_OK : I_FAIL;
}

/** 抓包链路: PLAY -> PLAY_3S -> (COMPLETE) -> 领币一次 */
async function watchShortVideo(st, video) {
  const vid = String(video.id);
  await trackVideo(st.token, st.liveToken, vid, "PLAY");
  await sleep(jittered(PLAY_TO_3S_SECONDS) * 1000);
  await trackVideo(st.token, st.liveToken, vid, "PLAY_3S");
  await sleep(jittered(WATCH_AFTER_3S_SECONDS) * 1000);
  if (SEND_COMPLETE) await trackVideo(st.token, st.liveToken, vid, "COMPLETE");
  return await claimIntegralWithRetry(st, vid);
}

// ══════════════ 主流程 (processAccount + main) ══════════════
// 任务顺序 (沿用现有 fanghua.js 结构, 课程/短视频逻辑替换为 Python 修正版):
//   登录 -> 签到 -> 日常任务 -> 分享健康(循环) -> 课程学习刷分 -> 短视频领币 -> 最终余额 -> 汇总 -> PushPlus

async function processAccount(phone, pwd, cache) {
  log(phone, "开始执行");
  try {
    const { token, liveToken, userId, nickName, integral } = await getToken(phone, pwd, cache);
    const balanceBefore = (integral != null) ? integral : (await getBalance(token));
    logSuccess(phone, `余额: ${balanceBefore}`);
    logSuccess(phone, `登录成功 ${nickName || phone} (ID: ${userId})`);
    // 初始化日志和配置
    createLog(token, liveToken, userId);
    getAppConfig(token, liveToken);
    await sleep(jitter(2000));

    // 会话状态: 课程/短视频阶段共享 上限type记忆 + 领币节流时间戳 + 最长运行时间
    const st = {
      phone, token, liveToken, userId, nickName,
      deadline: Date.now() + MAX_HOURS * 3600 * 1000,
      lastClaimTs: 0,
      exhaustedTypes: new Set(),
    };

    // 1. 签到
    logInfo(phone, "--- 签到 ---");
    try {
      const sr = await sign(token, liveToken);
      logInfo(phone, (sr && sr.msg) || JSON.stringify(sr));
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
        if (r && r.code === 200) logSuccess(phone, `🎁 ${t.name}: ${msg || "成功"}`);
        // 失败/未达成(新人转盘已参加过等)静默, 不刷屏
      } catch (e) { /* 任务报错静默 */ }
      await sleep(jitter(randInt(2000, 4000)));
    }

    // 1.6 分享健康 (固定100次, 间隔5秒; FHWL_SHARE_MAX 可覆盖)
    logInfo(phone, "--- 分享健康 ---");
    const SHARE_MAX = envInt("FHWL_SHARE_MAX", 100);
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

    // 2. 课程学习刷分 (修正: /app/course/getIntegral 每小节 +50, 遍历全量小节, 支持兑换+断点续看)
    logInfo(phone, "--- 课程学习刷分 ---");
    let courseCount = 0;
    if (ENABLE_COURSE) {
      try {
        const r = await studyCourses(st);
        courseCount = r.claimed;
        logInfo(phone, `课程阶段: 领 ${courseCount} 小节 (+${courseCount * COURSE_INTEGRAL_PER_SECTION})`);
      } catch (e) { logWarn(phone, `课程阶段出错: ${e.message}`); }
    } else {
      logInfo(phone, "课程阶段已禁用 (FHWL_COURSE=0)");
    }
    await sleep(jitter(3000));

    // 3. 短视频领币 (修正: addIntegral 必须带 videoId, 多 type 重试, 最短间隔节流)
    logInfo(phone, "--- 刷短视频 ---");
    const SHORT_MAX = envInt("FHWL_SHORT_MAX", 100); // 默认100; >0 纯按次数跑(忽略防刷停止)
    let shortCount = 0, shortCoins = 0, shortStop = "";
    let pageNum = 1;
    const initialIntegral = balanceBefore;
    while (true) {
      // 上限 / 超时 / 每日目标 检查 (目标检测放最前, 省一次取视频请求)
      if (SHORT_MAX > 0 && shortCount >= SHORT_MAX) { shortStop = `达上限FHWL_SHORT_MAX(${SHORT_MAX})`; break; }
      if (Date.now() > st.deadline) { shortStop = "到达最大运行时间"; break; }
      if (DAILY_TARGET > 0 && shortCount > 0 && shortCount % TARGET_CHECK_EVERY === 0) {
        const cur = await getBalance(token);
        if (cur != null && initialIntegral != null && (cur - initialIntegral) >= DAILY_TARGET) {
          logSuccess(phone, `🎯 已达每日目标 (+${DAILY_TARGET} 芳华币), 提前结束`);
          shortStop = `达到每日目标(+${DAILY_TARGET})`; break;
        }
      }
      try {
        const videos = await getVideoList(token, liveToken, pageNum);
        if (videos.length === 0) {
          if (pageNum > 1) { pageNum = 1; continue; }   // 翻到底, 回到第1页重新随机取
          logInfo(phone, "无视频, 等待30s重试");
          await sleep(30000); continue;
        }
        const video = videos[randInt(0, videos.length - 1)];
        logInfo(phone, `📺 短视频 ${video.username || video.title || "佚名"}`);
        const result = await watchShortVideo(st, video);
        shortCount++;
        if (result === I_OK) shortCoins++;
        else if (result === I_LIMIT) { shortStop = "所有领币type达每日上限"; break; }
        await sleep(jitter(randInt(3000, 6000)));
      } catch (e) { logError(phone, `短视频出错: ${e.message}`); break; }
    }
    if (!shortStop) shortStop = "全部完成";
    logInfo(phone, `短视频: ${shortCount} 个, 领币${shortCoins}次 | ${shortStop}`);

    // 4. 最终积分
    logInfo(phone, "--- 最终积分 ---");
    const balanceAfter = await getBalance(token);
    const delta = (balanceAfter != null && balanceBefore != null) ? balanceAfter - balanceBefore : "?";
    log(phone, `余额: ${balanceBefore} → ${balanceAfter} (变化 ${delta})`);
    log(phone, `🏁 完成: 分享${shareCount} 课程${courseCount} 短视频${shortCount}(${shortCoins}领币)`);
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
  console.log(`   每日目标: ${DAILY_TARGET > 0 ? DAILY_TARGET + " 芳华币" : "不限"}`);
  console.log(`   课程阶段: ${ENABLE_COURSE ? "启用" : "禁用"} | 分享健康: ${envInt("FHWL_SHARE_MAX", 100)} 短视频: ${envInt("FHWL_SHORT_MAX", 100)}`);
  console.log(`   开始并发执行...\n`);

  const cache = loadCache();
  const results = await Promise.all(accounts.map(acc => processAccount(acc.phone, acc.pwd, cache)));

  console.log("");
  console.log("  ╔═══════════════════════════════════╗");
  console.log("  ║           📊   执 行 汇 总         ║");
  console.log("  ╠═══════════════════════════════════╣");
  let totalShare = 0, totalCourse = 0, totalShort = 0, totalCoins = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`  ❌ [${r.phone}] 失败: ${r.error}`);
    } else {
      totalShare += r.shareCount || 0;
      totalCourse += r.courseCount || 0;
      totalShort += r.shortCount || 0;
      totalCoins += r.shortCoins || 0;
      console.log(`  ✅ [${r.phone || r.nickName}] 分享${r.shareCount} 课程${r.courseCount} 短视频${r.shortCount}(${r.shortCoins}领币)`);
    }
  }
  console.log("  ╠═══════════════════════════════════╣");
  console.log(`  🔗 分享健康: ${totalShare} 次`);
  console.log(`  📺 课程视频: ${totalCourse} 小节 (+${totalCourse * COURSE_INTEGRAL_PER_SECTION})`);
  console.log(`  🎬 短视频: ${totalShort} 个 (领币 ${totalCoins} 次)`);
  console.log("  ╚═══════════════════════════════════╝");
  console.log("");
  await sendToPushPlus("芳华未来", notifyLines.join("\n"));
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
