#!/usr/bin/env node
/**
 * 芳华未来 v8 - 签到 + 全量抽奖 + 分享健康 + 短视频领币 + 课程学习刷分 + 直播挂机
 * (登录: token缓存 + 短信验证码; WCS 微信登录已于 v8 移除 —— 公众号未授权 48001, 该通道永不成功)
 *
 * v7 变更 (2026-09-17):
 *   1. 【阶段顺序修复】短视频(type1浏览商品+type2浏览视频, 共约+400)提前到课程阶段之前。
 *      原顺序"课程->短视频"下, 命中长视频课程(1700~3000s, 如《张汉臣小儿推拿》)时
 *      课程阶段按真实节奏观看耗尽 maxRuntime, 短视频阶段被跳过, 单号日入账从 ~630 掉到 ~230。
 *   2. 【课程限时】课程阶段独立限时 = 剩余时间 - (FHWL_LIVE_MIN+5)min, 超时自动让位给直播,
 *      直播阶段恢复完整剩余时间。
 *
 * v6 变更 (2026-09-17): 新增直播挂机阶段 (WS + 10s 流量上报, 仅真实直播 status=1 入账)
 *
 * v5 变更 (2026-09-07):
 *   1. 【WCS 登录】新增微信通道: WCS 出 code -> /app/wx/loginByMp?appId=wx7a3715e6f0d22c56
 *      逆向确认 App 内 H5 登录用的是【公众号】appId 网页授权, 不是小程序 appId。
 *      配置了 FH_OPENID/wx_opinion 就优先走 WCS, 失败自动回退密码登录/token 缓存。
 *   2. 【转盘抽奖补全】sendTurntableReward 补上抓包 payload {source:3, appId:...},
 *      并先查 /app/invited/getReward 剩余次数, 循环抽到没有机会为止。
 *   3. 【签到转盘修正】仅当 /app/integral/sign 返回非空 data 才调 claimSignReward
 *      (否则服务端报"非法操作")。
 *   4. 【活动签到】新增 getUserActiveWindow -> userActiveLogSign, isOpen=false 时跳过。
 *   5. 【邀请码】新增 FH_INVITE_CODE -> bindInvForUser, 换 1 次抽奖机会。
 *   6. 【福袋路径修正】/app/luckyBag/receiveLuckyBag -> /course_auto/app/luckyBag/receiveLuckyBag。
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
 *   推送: 经 std_report 走钉钉美化模板 (DINGTALK_ 环境变量由 std_report 读取)
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
// 默认跳过 >10 分钟的小节: 看一节要真实等待相同时长(+50/节), 长视频性价比极低,
// 会把整个课程窗口吃光导致后面的短小节领不到 (2026-09-20 实测)
const COURSE_MAX_SEC = envInt("FHWL_COURSE_MAX_SEC", 600);
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

// 直播挂机阶段 (api.fhhx.runtzh.com, 独立鉴权: AppToken头 = liveToken 值, 无 apiSecurity)
// 链路 (逆向 pages_live/living.vue + liveVideo.vue):
//   WS: wss://im.fhhx.runtzh.com/ws/app/webSocket?userId=&liveId=&userType=0&timestamp=&signature=
//       signature = HMAC-SHA256(liveId+liveUserId+userType+timestamp, key=String(timestamp)).hex
//   每10s POST /app/live/liveTrafficLog/getLiveInternetTraffic {userId, liveId, uuId:YYYYMMDD+rand, internetTraffic}
//   remaining-time: 完成奖励倒计时 (看完直播 hasReceived=true 自动入账)
const ENABLE_LIVE = envBool("FHWL_LIVE", true);
const LIVE_MIN_MINUTES = envInt("FHWL_LIVE_MIN", 12);   // 每个直播间挂机分钟数
const LIVE_BITRATE = 1600;                              // app 内 calculateBitrate() 直播码率 (kbps)
let ws = null;
try { ws = require("ws"); } catch (e) { /* 容器未装 ws 模块时降级: 只做 HTTP 流量上报 */ }

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
    console.log("  ║  🌸 芳华未来 v8  签到·全抽奖·短视频·课程·直播 ║");
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

// ── 登录 (v8: 仅 token缓存 + 密码(服务端已关闭) + 短信验证码) ──────────────
// WCS 微信登录已移除: 公众号 wx7a3715e6f0d22c56 未开通网页授权接口权限(48001),
// 该通道 100% 失败。token 失效时用 fanghua/sms.js(发码) + sms2.js(验证码登录写缓存) 续命。

// 登录错误分类: 瞬时故障(可重试) vs 永久失败(不可重试)
const LOGIN_RETRY = 4;
const LOGIN_RETRY_MIN = 2000;
const LOGIN_RETRY_MAX = 12000;
function isRetryableLoginError(msg) {
  // "暂不支持密码登录" 是服务器永久关闭密码通道, 不属于瞬时故障, 不应重试
  if (/暂不支持密码登录/.test(msg)) return false;
  // 其余为瞬时故障, 可重试
  return /频繁|稍后|锁定|验证码|风控|图形验证|访问过于|网络|超时|连接/.test(msg);
}
function isPermanentLoginError(msg) {
  return /暂不支持密码登录|密码错误|账号不存在|账号已注销|永久/.test(msg);
}

async function getToken(phone, pwd, cache) {
  // 1. 缓存 token 复用
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

  let lastMsg = "";
  for (let attempt = 1; attempt <= LOGIN_RETRY; attempt++) {
    try {
      const r = await doLogin(phone, pwd);
      cache[phone] = { token: r.token, liveToken: r.liveToken, userId: r.userId, nickName: r.nickName, integral: r.integral };
      saveCache(cache);
      return r;
    } catch (err) {
      lastMsg = err.message;
      // 永久失败直接抛出, 不重试
      if (isPermanentLoginError(lastMsg)) {
        logError(phone, `登录通道已关闭: ${lastMsg}`);
        throw err;
      }
      // 非瞬时错误(密码错等)直接失败
      if (!isRetryableLoginError(lastMsg)) throw err;
      const backoff = attempt < LOGIN_RETRY
        ? LOGIN_RETRY_MIN + attempt * (LOGIN_RETRY_MAX - LOGIN_RETRY_MIN) / LOGIN_RETRY + randInt(-1500, 1500)
        : 0;
      logWarn(phone, `登录失败"${lastMsg}", ${backoff > 0 ? "等待 " + (backoff / 1000).toFixed(1) + "s" : ""} 重试 (${attempt}/${LOGIN_RETRY})`);
      if (backoff > 0) await sleep(backoff);
    }
  }
  throw new Error(`登录失败(重试${LOGIN_RETRY}次耗尽): ${lastMsg}`);
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
async function sendTurntableReward(token, liveToken, extra) {
  // 抓包 payload: {source:3, appId:"wx703c4bd07bbd1695"}
  //  lotteryType=2(填邀请码) 追加 inviterUserId; =4(新App用户) 追加 isNewAppUser:1
  const body = Object.assign({ source: 3, appId: "wx703c4bd07bbd1695" }, extra || {});
  const resp = await request({ method: "POST", url: `${BASE}/app/newUser/sendTurntableReward`, headers: { AppToken: token, liveToken }, body });
  return resp.data;
}
/** 查询剩余抽奖机会 + 奖品池: GET/POST /app/invited/getReward */
async function getLotteryInfo(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/invited/getReward`, headers: { AppToken: token, liveToken }, body: {} });
  return resp.data;
}
/** 活动窗口签到: getUserActiveWindow -> userActiveLogSign */
async function getActiveWindow(token, liveToken) {
  const resp = await request({ method: "GET", url: `${BASE}/app/integral/getUserActiveWindow`, headers: { AppToken: token, liveToken } });
  return resp.data;
}
async function activeLogSign(token, liveToken) {
  const resp = await request({ method: "POST", url: `${BASE}/app/integral/userActiveLogSign`, headers: { AppToken: token, liveToken }, body: {} });
  return resp.data;
}
/** 填邀请码换 1 次抽奖机会: /app/userInvited/bindInvForUser */
async function bindInviteCode(token, liveToken, userId, code) {
  const resp = await request({ method: "POST", url: `${BASE}/app/userInvited/bindInvForUser`, headers: { AppToken: token, liveToken }, body: { fsUserId: userId, invitationCode: code } });
  return resp.data;
}
async function receiveLuckyBag(token, liveToken) {
  // 正确路径在 H5 域 course_auto 下, 且需要 IM 消息里的 recordId; 无条件时跳过
  const resp = await request({ method: "POST", url: `${BASE}/course_auto/app/luckyBag/receiveLuckyBag`, headers: { AppToken: token, liveToken }, body: {} });
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
    if (!ok) {
      // 服务端返回"该小节已兑换" = 该小节其实已拥有, 应继续走看课/领分链路, 不能跳过
      if (/已兑换|已购买|已拥有|已购/.test(msg)) logInfo(phone, `🛒 《${title}》${msg}, 视为已拥有, 继续`);
      else { logInfo(phone, `🔒 《${title}》兑换失败(${msg}), 跳过`); return C_FAIL; }
    } else {
      logSuccess(phone, `🛒 已兑换《${title}》`);
    }
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
      let videos = await getCourseVideoList(token, liveToken, courseId);
      if (!videos.length) continue;
      // 短小节优先: 单位时间收益最高, 且能在课程窗口耗尽前多领几个
      videos = videos.slice().sort((a, b) => parseInt(a.seconds || 0, 10) - parseInt(b.seconds || 0, 10));
      logInfo(phone, `📗 课程《${courseName}》(${videos.length} 小节, 按时长升序)`);

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

// ══════════════ 直播挂机 (api.fhhx.runtzh.com) ══════════════
// 直播 host 请求: 明文 JSON, 无 apiSecurity; 鉴权头 AppToken = liveToken 值
function liveRequest(method, url, body) {
  const h = { "User-Agent": pickUA(), AppToken: st_liveToken, liveToken: st_liveToken };
  const init = { method, headers: h };
  if (method === "POST") { h["Content-Type"] = "application/json;charset=UTF-8"; init.body = JSON.stringify(body || {}); }
  return fetch(BASE_LIVE + url, init).then(r => r.json()).catch(() => null);
}

let st_liveToken = "";   // 当前账号 liveToken (liveRequest 用)

/** 直播侧用户ID (独立账号体系, 缓存进 token_cache) */
async function liveGetUserId(st) {
  if (st.liveUserId) return st.liveUserId;
  try {
    st_liveToken = st.liveToken;
    const r = await liveRequest("GET", "/app/user/getUserInfo");
    const uid = (r && r.user && r.user.userId) || (r && r.data && r.data.user && r.data.user.userId) || null;
    if (uid) {
      st.liveUserId = String(uid);
      if (st.cacheRef && st.cacheRef[st.phone]) { st.cacheRef[st.phone].liveUserId = st.liveUserId; saveCache(st.cacheRef); }
    }
    return st.liveUserId || null;
  } catch (e) { return null; }
}

/** 直播间列表: 优先正在直播 (status=1), 其次回放 */
async function liveGetRooms(st) {
  try {
    st_liveToken = st.liveToken;
    const r = await liveRequest("GET", "/app/live/liveList?pageNum=1&pageSize=20");
    const list = (r && r.data && (r.data.list || r.data.records)) || [];
    return list.filter(x => x && (x.liveId || x.id));
  } catch (e) { return []; }
}

/** 完成奖励倒计时: {remainingTime, watchDuration, videoDuration, hasReceived} */
async function liveRemaining(st, liveId) {
  try {
    st_liveToken = st.liveToken;
    const r = await liveRequest("GET", `/app/live/completion/remaining-time?liveId=${liveId}`);
    return (r && r.code === 200) ? r.data : null;
  } catch (e) { return null; }
}

/** 直播侧芳华币余额 */
async function liveIntegral(st) {
  try {
    st_liveToken = st.liveToken;
    const r = await liveRequest("GET", "/app/live/liveData/getUserIntegralInfo");
    return (r && r.code === 200 && r.data) ? (r.data.integral ?? 0) : null;
  } catch (e) { return null; }
}

/** 10秒流量上报 ("每次浏览10秒可获取1次芳华币" 的服务端入账依据) */
async function liveReportTraffic(st, liveId, liveUserId, uuId, bytes) {
  try {
    st_liveToken = st.liveToken;
    const r = await liveRequest("POST", "/app/live/liveTrafficLog/getLiveInternetTraffic",
      { userId: liveUserId, liveId: String(liveId), uuId, internetTraffic: bytes });
    return r && r.code === 200;
  } catch (e) { return false; }
}

/** WS 挂机连接 (im.fhhx.runtzh.com, HMAC-SHA256 签名, 15s 心跳) */
function liveWSConnect(st, liveId, liveUserId, onMsg) {
  if (!ws) return null;
  try {
    const userType = "0", ts = Date.now();
    const sig = require("crypto").createHmac("sha256", String(ts))
      .update(`${liveId}${liveUserId}${userType}${ts}`).digest("hex");
    const sock = new ws(`wss://im.fhhx.runtzh.com/ws/app/webSocket?userId=${liveUserId}&liveId=${liveId}&userType=${userType}&timestamp=${ts}&signature=${sig}`,
      { headers: { "User-Agent": pickUA() } });
    let alive = false;
    sock.on("open", () => { alive = true; try { sock.send(JSON.stringify({ cmd: "heartbeat" })); } catch (e) {} });
    sock.on("message", (d) => { try { onMsg && onMsg(JSON.parse(d.toString())); } catch (e) {} });
    sock.on("error", () => { alive = false; });
    sock.on("close", () => { alive = false; });
    const hb = setInterval(() => { if (alive) { try { sock.send(JSON.stringify({ cmd: "heartbeat" })); } catch (e) {} } }, 15000);
    return { sock, stop() { clearInterval(hb); try { sock.close(); } catch (e) {} }, isAlive: () => alive };
  } catch (e) { return null; }
}

/** 直播挂机主流程: WS 在线 + 每10s流量上报 + 完成奖励倒计时 */
async function watchLive(st) {
  const phone = st.phone;
  if (!ENABLE_LIVE) return { watched: false, reason: "已禁用(FHWL_LIVE=0)" };
  if (!st.liveToken) return { watched: false, reason: "无 liveToken (短信登录未下发, 需 App 端登录获取)" };
  st_liveToken = st.liveToken;
  const liveUserId = await liveGetUserId(st);
  if (!liveUserId) return { watched: false, reason: "获取直播侧 userId 失败" };
  const rooms = await liveGetRooms(st);
  if (rooms.length === 0) return { watched: false, reason: "直播间列表为空" };
  // 排序: 正在直播(status=1)优先
  rooms.sort((a, b) => (b.status === 1 ? 1 : 0) - (a.status === 1 ? 1 : 0));
  const room = rooms[0];
  const liveId = String(room.liveId || room.id);
  const isLive = room.status === 1;
  logInfo(phone, `📺 直播间 ${liveId} "${String(room.liveName || room.title || "").slice(0, 24)}" (status=${room.status}${isLive ? " 直播中" : " 回放/未开播"})`);

  const balanceBefore = await liveIntegral(st);
  const uuId = new Date().toISOString().slice(0, 10).replace(/-/g, "") + Math.random().toString(36).slice(2, 10);
  let bytes = 0, reported = 0;
  const conn = liveWSConnect(st, liveId, liveUserId, (m) => {
    if (m && m.data && m.data.cmd === "entry_batch") { /* 在线人数播报, 忽略 */ }
  });
  if (conn) logInfo(phone, "🔌 直播 WS 已连接 (在线挂机)");
  else logWarn(phone, "WS 不可用 (缺 ws 模块), 仅 HTTP 流量上报");

  const deadline = Date.now() + LIVE_MIN_MINUTES * 60 * 1000;
  let received = false;
  while (Date.now() < deadline) {
    bytes += LIVE_BITRATE * 10 / 8;   // app 每10s上报一次累计流量
    if (await liveReportTraffic(st, liveId, liveUserId, uuId, Math.round(bytes))) reported++;
    await sleep(jitter(10000));
    // 每 60s 查一次完成奖励状态
    if (reported % 6 === 0) {
      const rm = await liveRemaining(st, liveId);
      if (rm) {
        if (rm.hasReceived) { received = true; logInfo(phone, "直播完成奖励已领取过, 提前结束"); break; }
        if (rm.remainingTime <= 0 && !rm.hasReceived) { logInfo(phone, `完成奖励倒计时结束 (videoDuration=${rm.videoDuration}s), 等待服务端入账`); received = true; break; }
        logInfo(phone, `⏱ 完成奖励剩余 ${Math.ceil(rm.remainingTime / 60)}min | watchDuration=${rm.watchDuration}s`);
      }
      if (Date.now() > st.deadline) { logWarn(phone, "到达最大运行时间, 直播挂机提前结束"); break; }
    }
  }
  if (conn) conn.stop();
  const balanceAfter = await liveIntegral(st);
  const delta = (balanceAfter != null && balanceBefore != null) ? balanceAfter - balanceBefore : "?";
  logInfo(phone, `直播挂机: 上报${reported}次 (${LIVE_MIN_MINUTES}min) | 直播侧芳华币 ${balanceBefore} → ${balanceAfter} (${delta})`);
  return { watched: true, reported, liveId, delta };
}

// ══════════════ 主流程 (processAccount + main) ══════════════
// 任务顺序 (沿用现有 fanghua.js 结构, 课程/短视频逻辑替换为 Python 修正版):

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
      cacheRef: cache,
      deadline: Date.now() + MAX_HOURS * 3600 * 1000,
      lastClaimTs: 0,
      exhaustedTypes: new Set(),
    };

    // 1. 签到
    logInfo(phone, "--- 签到 ---");
    let signOk = false;
    let signRaw = null;
    try {
      const sr = await sign(token, liveToken);
      signRaw = sr;
      signOk = !!(sr && sr.code === 200);
      logInfo(phone, (sr && sr.msg) || JSON.stringify(sr));
    } catch (e) { logWarn(phone, `签到失败: ${e.message}`); }
    await sleep(jitter(2000));

    // 1.5 抽奖/转盘/福袋/滚动奖励等日常任务
    logInfo(phone, "--- 抽奖 & 日常任务 ---");
    const lotteryLogs = [];
    const runOne = async (name, fn) => {
      try {
        const r = await fn();
        const msg = (r && r.msg) || "";
        if (r && r.code === 200) {
          logSuccess(phone, `🎁 ${name}: ${msg || "成功"}`);
          lotteryLogs.push(`${name}: ${msg || "成功"}`);
          return { ok: true, msg };
        }
        if (r && r.code === 500 && !/非法|异常/.test(msg)) logInfo(phone, `${name}: ${msg}`);
        return { ok: false, msg };
      } catch (e) { return { ok: false, msg: e.message }; }
    };

    // 1.5.1 签到转盘: 仅当 /app/integral/sign 返回非空 data 时才可领, 否则服务端报"非法操作"
    const signData = (signRaw && Array.isArray(signRaw.data)) ? signRaw.data : [];
    if (signOk && signData.length > 0) {
      logInfo(phone, `签到返回 ${signData.length} 个转盘奖品, 领取中…`);
      await runOne("签到转盘", () => claimSignReward(token, liveToken));
      await sleep(jitter(randInt(2000, 4000)));
    } else if (signOk) {
      logInfo(phone, "签到无转盘奖品, 跳过 claimSignReward (避免非法操作)");
    }

    // 1.5.2 邀请码 -> 换 1 次抽奖机会 (FH_INVITE_CODE, 可选)
    const INVITE_CODE = (process.env.FH_INVITE_CODE || "").trim();
    if (INVITE_CODE) {
      await runOne("填写邀请码", () => bindInviteCode(token, liveToken, userId, INVITE_CODE));
      await sleep(jitter(randInt(2000, 4000)));
    }

    // 1.5.3 转盘抽奖: 先查剩余次数, 再循环抽到没有机会为止 (上限保护)
    let lotteryLeft = null;
    try {
      const li = await getLotteryInfo(token, liveToken);
      if (li && li.code === 200 && li.data) {
        lotteryLeft = li.data.remainingLotteryCount;
        if (lotteryLeft != null) logInfo(phone, `剩余抽奖机会: ${lotteryLeft}`);
      }
    } catch (e) {}
    const LOTTERY_MAX = envInt("FHWL_LOTTERY_MAX", 10);
    for (let i = 0; i < LOTTERY_MAX; i++) {
      const r = await runOne(`转盘抽奖 #${i + 1}`, () => sendTurntableReward(token, liveToken));
      if (!r.ok && /没有抽奖机会|机会.*用完|暂无|上限|已达/.test(r.msg || "")) {
        logInfo(phone, `转盘抽奖结束: ${r.msg}`);
        break;
      }
      if (!r.ok && /非法|异常|失败/.test(r.msg || "")) break;
      await sleep(jitter(randInt(3000, 6000)));
    }

    // 1.5.4 其余日常任务
    const dailyTasks = [
      { name: "领取福袋", fn: () => receiveLuckyBag(token, liveToken) },
      { name: "邀请视频奖励", fn: () => invitedVideoReward(token, liveToken) },
      { name: "滚动奖励", fn: () => scrollRewards(token, liveToken) },
    ];
    for (const t of dailyTasks) {
      await runOne(t.name, t.fn);
      await sleep(jitter(randInt(2000, 4000)));
    }

    // 1.5.5 活动窗口签到 (isOpen=true 时才签到, 否则服务端报"活动未开启")
    try {
      const aw = await getActiveWindow(token, liveToken);
      if (aw && aw.code === 200 && aw.isOpen) {
        await sleep(jitter(2000));
        await runOne("活动签到", () => activeLogSign(token, liveToken));
      } else {
        logInfo(phone, "活动窗口未开启, 跳过活动签到");
      }
    } catch (e) {}

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

    // 2. 短视频领币 (修正: addIntegral 必须带 videoId, 多 type 重试, 最短间隔节流)
    // [v7 顺序修复] 短视频(type1浏览商品+type2浏览视频, 约+400)放课程之前:
    // 课程长视频(1700~3000s)按真实节奏看会耗尽 maxRuntime, 之前导致短视频阶段被跳过
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
    await sleep(jitter(3000));

    // 3. 课程学习刷分 (修正: /app/course/getIntegral 每小节 +50, 遍历全量小节, 支持兑换+断点续看)
    // [v7 限时] 课程阶段独立限时: 预留直播挂机时间, 防止长视频吃满 maxRuntime 挤掉直播
    logInfo(phone, "--- 课程学习刷分 ---");
    let courseCount = 0;
    if (ENABLE_COURSE) {
      const mainDeadline = st.deadline;
      const courseReserveMs = (LIVE_MIN_MINUTES + 5) * 60 * 1000;
      // 课程窗口 = 总剩余时间 - 直播预留(而非固定 reserve 分钟)。低于 1min 时至少给 1min,
      // 保证总有时间把未领的小节推进起来。
      st.deadline = Math.max(Date.now() + 60 * 1000, mainDeadline - courseReserveMs);
      logInfo(phone, `课程阶段可用时长: ${Math.round((st.deadline - Date.now()) / 60000)}min`);
      try {
        const r = await studyCourses(st);
        courseCount = r.claimed;
        logInfo(phone, `课程阶段: 领 ${courseCount} 小节 (+${courseCount * COURSE_INTEGRAL_PER_SECTION})`);
      } catch (e) { logWarn(phone, `课程阶段出错: ${e.message}`); }
      st.deadline = mainDeadline;   // 恢复, 直播阶段仍可用完整剩余时间
    } else {
      logInfo(phone, "课程阶段已禁用 (FHWL_COURSE=0)");
    }
    await sleep(jitter(3000));

    // 3.5 直播挂机 (WS在线 + 10s流量上报 + 完成奖励, 仅 liveToken 存在时可用)
    let liveResult = { watched: false, reason: "" };
    logInfo(phone, "--- 直播挂机 ---");
    try {
      liveResult = await watchLive(st);
      if (!liveResult.watched) logInfo(phone, "直播跳过: " + liveResult.reason);
    } catch (e) { logWarn(phone, `直播挂机出错: ${e.message}`); }

    // 4. 最终积分
    logInfo(phone, "--- 最终积分 ---");
    const balanceAfter = await getBalance(token);
    const delta = (balanceAfter != null && balanceBefore != null) ? balanceAfter - balanceBefore : "?";
    log(phone, `余额: ${balanceBefore} → ${balanceAfter} (变化 ${delta})`);
    log(phone, `🏁 完成: 分享${shareCount} 课程${courseCount} 短视频${shortCount}(${shortCoins}领币) 直播${liveResult.watched ? "✓" : "✗"}`);
    return { phone, nickName, signOk, balanceBefore, balanceAfter, shareCount, courseCount, shortCount, shortCoins, signRaw, lotteryLogs, liveResult };
  } catch (err) {
    logError(phone, `执行失败: ${err.message}`);
    return { phone, error: err.message };
  }
}

// ── 入口 ──────────────────────────────────────

const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = '芳华';
function _rpGet(idx) {
  if (!_rpRows[idx]) _rpRows[idx] = { idx: idx, name: "", sign: "", earned: "", total: "", tasks: [], lottery: "" };
  return _rpRows[idx];
}
function logPoints(todayPoints, totalPoints, app, idx, status) {
  _rpApp = app || _rpApp;
  const r = _rpGet(idx);
  if (status != null && status !== "") r.sign = String(status);
  if (totalPoints != null && totalPoints !== "" && !isNaN(Number(totalPoints))) r.total = String(totalPoints);
  if (todayPoints != null && todayPoints !== "" && !isNaN(Number(todayPoints)) && Number(todayPoints) !== 0) r.earned = "今日+" + todayPoints + "积分";
}
function _setName(idx, name) { if (name != null) _rpGet(idx).name = String(name); }
function _setSign(idx, sign, earned, total) {
  const r = _rpGet(idx);
  if (sign != null) r.sign = String(sign);
  if (earned != null && earned !== "") r.earned = String(earned);
  if (total != null && total !== "") r.total = String(total);
}
function _addTask(idx, name, status) { _rpGet(idx).tasks.push({ name: String(name), status: String(status) }); }
function _setLottery(idx, text) { if (text != null && text !== "") _rpGet(idx).lottery = String(text); }
function _digLottery(obj) {
  if (obj == null) return "";
  const flat = (function _f(o, pre, acc) {
    acc = acc || {};
    if (Array.isArray(o)) { o.forEach((v, i) => _f(v, pre ? pre + "." + i : "" + i, acc)); return acc; }
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) {
        const nv = o[k];
        const nk = pre ? pre + "." + k : k;
        if (nv && typeof nv === "object") _f(nv, nk, acc);
        else acc[nk.toLowerCase()] = nv;
      }
      return acc;
    }
    if (pre) acc[pre] = obj;
    return acc;
  })(obj, "", {});
  const keys = Object.keys(flat);
  const hit = (re) => keys.filter(k => re.test(k));
  const lotteryKeys = hit(/lottery|draw|prize|转盘|turntable|raffle|lucky|福袋|reward|rewards|gift/);
  const out = [];
  for (const k of lotteryKeys) {
    let v = flat[k];
    if (v == null) continue;
    if (typeof v === "object") v = JSON.stringify(v);
    const s = String(v);
    if (s && s !== "{}" && s !== "[]") out.push(s);
  }
  return out.join("｜");
}
async function doPush() { /* 由 flushLogPoints 统一经 std_report 推送 */ }
let _rpFlushed = false;
async function flushLogPoints(app) {
  if (_rpFlushed) return;
  _rpApp = app || _rpApp;
  const rows = _rpRows.filter(Boolean);
  if (!rows.length) return;
  _rpFlushed = true;
  await _stdReport(_rpApp, rows);
}
{
  const _oe = process.exit.bind(process);
  process.exit = function (code) {
    const p = flushLogPoints(_rpApp);
    if (p && typeof p.then === 'function') p.then(() => _oe(code)).catch(() => _oe(code));
    else _oe(code);
  };
}
process.on('beforeExit', () => { flushLogPoints(_rpApp); });


async function main() {
  const fhwl = process.env.FHWL || "";
  if (!fhwl) {
    console.error("\n❌ 请设置环境变量: FHWL");
    console.error("   格式: 账号1@密码1&账号2@密码2\n");
    process.exit(1);
  }
  printBanner();
  const accounts = fhwl.split("&").map((p) => {
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
  const results = [];
  // 账号串行执行 + 错峰延迟，避免并发同时登录触发服务端反欺诈("暂不支持密码登录")
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0) {
      const gap = randInt(3000, 6000);
      console.log(`   账号 ${i + 1}/${accounts.length} 前错峰等待 ${gap / 1000}s (规避并发登录风控)`);
      await sleep(gap);
    }
    results.push(await processAccount(accounts[i].phone, accounts[i].pwd, cache));
  }

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

  // 构建钉钉美化推送 row（今日获得 / 总积分 / 任务）
  _rpApp = "芳华未来小程序任务";
  results.forEach((r, i) => {
    const idx = i + 1;
    if (r.error) {
      _setName(idx, r.phone);
      _setSign(idx, "执行失败", null, null);
      _addTask(idx, "错误", r.error);
      return;
    }
    const before = r.balanceBefore, after = r.balanceAfter;
    const earned = (typeof after === "number" && typeof before === "number" && (after - before) > 0)
      ? `今日+${after - before}芳华币` : null;
    const total = (typeof after === "number") ? String(after) : null;
    _setName(idx, r.nickName || r.phone);
    _setSign(idx, r.signOk ? "签到成功" : "签到完成", earned, total);
    const _st = extractPoints(r.signRaw);
    if (_st && _st.streak != null) _rpGet(idx).streak = String(_st.streak);
    if (r.lotteryLogs && r.lotteryLogs.length) _setLottery(idx, r.lotteryLogs.join("｜"));
    _addTask(idx, "分享健康", `完成${r.shareCount}次`);
    _addTask(idx, "课程学习", `领${r.courseCount}小节`);
    _addTask(idx, "短视频领币", `领币${r.shortCoins}次`);
  });
  await flushLogPoints(_rpApp);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
