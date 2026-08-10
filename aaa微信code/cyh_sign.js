/**
 * 车友惠出行 微信小程序 —— WCS 登录 + 每日签到 + 分享任务
 * AppID: wx0d7e4af01d0e7986   API: https://operation.rayoservice.com/api
 *
 * 每日动作: 连续签到领 U 点(1~7 天 10/20/30/40/50/60/100) / 分享小程序任务(+20) / 查询 U 点余额
 *
 * 环境变量(项目统一约定):
 *   wx_opinion      ★账号来源(WCS openid, & 分隔)
 *   wx_server_url   WCS 地址
 *   wx_auth         WCS 认证 key
 *   NICK_MAP        可选 昵称映射 openid:昵称&openid:昵称
 *   PUSH_PLUS_TOKEN PushPlus 推送(可选)
 *   CYH_NO_SHARE    可选 设为 1 关闭分享任务上报
 *
 * token 缓存: cyh_token_cache.json (按 openid, JWT 本地判活, 失效自动重登)
 * cron: 25 9 * * *
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ============ 配置 ============
const APP_NAME = "车友惠出行";
const APPID = "wx0d7e4af01d0e7986";
const HOST = "https://operation.rayoservice.com/api";
const WCS = process.env.wx_server_url || "http://host.docker.internal:18788";
const WCS_AUTH = process.env.wx_auth || "";
const PUSH_TOKEN = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN || "";
const ACCOUNTS = (process.env.wx_opinion || "").split("&").map((s) => s.trim()).filter(Boolean);
const NO_SHARE = process.env.CYH_NO_SHARE === "1";
const CACHE_FILE = path.join(__dirname, "cyh_token_cache.json");

// 小程序登录固定参数(页面装修配置下发)
const PAGE_CODE = "MBYM2310029073000013";
const RESOURCES_ID = "trzJiREk9VLpFnGOMc6W4TLhjiFY0BeXcG66lNyLvSQ=";
// 活动/任务标识
const SIGN_ACTIVITY = "2041790369687097344"; // 多天签到组件
const SHARE_TASK = "1980565381282213888"; // 分享小程序任务
const PAY_ACCOUNT = "1823205144156385281"; // U 点(代币)账户

const UA =
  "Mozilla/5.0 (Linux; Android 14; 23127PN0CC Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.107 Mobile Safari/537.36 XWEB/1300233 MMWEBSDK/20241202 MMWEBID/2846 MicroMessenger/8.0.56.2800(0x28003837) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android";

const BASE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": UA,
  Referer: `https://servicewechat.com/${APPID}/41/page-frame.html`,
};

// ============ 昵称映射 ============
const NICK_MAP = {};
(process.env.NICK_MAP || "").split("&").forEach((pair) => {
  const i = pair.indexOf(":");
  if (i > 0) NICK_MAP[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
});
const nickOf = (openid, idx) => NICK_MAP[openid] || `账号${idx + 1}`;

// ============ 工具 ============
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 高斯抖动延迟, 比均匀随机更像真人节奏 */
function jitter(base, spread) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(300, Math.round(base + g * spread));
}

const LOGS = [];
function log(msg) {
  console.log(msg);
  LOGS.push(msg);
}

function request(url, { method = "GET", headers = {}, body = null, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error(`非法URL: ${url}`));
    }
    const lib = u.protocol === "https:" ? https : http;
    const payload = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const h = { ...headers };
    if (payload != null) h["Content-Length"] = Buffer.byteLength(payload);

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: h,
        rejectUnauthorized: false,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          let data = raw;
          try {
            data = JSON.parse(raw);
          } catch (e) {
            /* 保留原始文本 */
          }
          resolve({ status: res.statusCode, data, raw });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("请求超时")));
    if (payload != null) req.write(payload);
    req.end();
  });
}

// ============ 缓存 ============
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}
function saveCache(c) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
  } catch (e) {
    log(`⚠️ 缓存写入失败: ${e.message}`);
  }
}

/** token 是 JWT, 本地解 exp 预判过期(留 10 分钟余量), 省一次探活请求 */
function jwtAlive(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
    return !p.exp || p.exp * 1000 - Date.now() > 10 * 60 * 1000;
  } catch (e) {
    return false;
  }
}

// ============ WCS ============
async function getWxCode(openid) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await request(`${WCS.replace(/\/$/, "")}/wx/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", auth: WCS_AUTH },
        body: { openid, appid: APPID },
      });
      const code = r.data && r.data.data && r.data.data.code;
      if (code) return code;
      const msg = (r.data && (r.data.message || r.data.msg)) || r.raw;
      log(`⚠️ WCS取code失败(${i}/3): ${String(msg).slice(0, 90)}`);
    } catch (e) {
      log(`⚠️ WCS异常(${i}/3): ${e.message}`);
    }
    if (i < 3) await sleep(jitter(2500 * i, 500));
  }
  return null;
}

// ============ API 封装 ============
class TokenExpired extends Error {}
/** 业务失败但属于"已完成/无需重复"的良性结果 */
class BizFail extends Error {
  constructor(msg, code) {
    super(msg);
    this.code = code;
  }
}

async function api(pathname, { method = "GET", query = null, body = null, token = "" } = {}) {
  const headers = { ...BASE_HEADERS };
  if (token) headers["Client-Auth"] = token;
  let p = pathname;
  // 与小程序 request() 一致: GET 拼 querystring 且不发 body
  if (query && Object.keys(query).length) {
    p +=
      (p.includes("?") ? "&" : "?") +
      Object.keys(query)
        .map((k) => `${k}=${encodeURIComponent(query[k])}`)
        .join("&");
  }
  const opts = { method, headers };
  if (method.toUpperCase() !== "GET" && body != null) opts.body = body;

  // 网络抖动(socket hang up / ECONNRESET / SSL EOF / 超时)自动重试两次
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await request(HOST + p, opts);
      break;
    } catch (e) {
      const retriable = /hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPROTO|socket|timeout|SSL/i.test(e.message || "");
      if (attempt >= 2 || !retriable) throw e;
      await sleep(jitter(1800 * (attempt + 1), 500));
    }
  }
  if (r.status === 401) throw new TokenExpired("登录态失效");
  const d = r.data;
  if (!d || typeof d !== "object") throw new Error(`响应异常(HTTP ${r.status}): ${String(r.raw).slice(0, 120)}`);
  if (d.code === 200 && d.success) return d.data;
  if (d.code === 401) throw new TokenExpired("登录态失效");
  throw new BizFail(d.msg || `code=${d.code}`, d.code);
}

// ============ 登录 ============
async function login(openid) {
  const code = await getWxCode(openid);
  if (!code) return null;
  const res = await api("/rayo-dbo-operate/user-client-api/polymerization/token", {
    method: "POST",
    body: {
      platformSign: "wechat_applets",
      pageCode: PAGE_CODE,
      resourcesId: RESOURCES_ID,
      sourceTenantId: "",
      authType: "third_party",
      evidence: code,
    },
  });
  if (!res || !res.token) throw new Error("登录未返回 token");
  return res.token;
}

async function userInfo(token) {
  try {
    return await api("/rayo-dbo-operate/user-client-api/user/info", { token });
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    return null;
  }
}

/** 取可用 token: 优先缓存(JWT 本地判活 + 一次轻量探活), 失效则重登 */
async function ensureToken(openid, cache) {
  const c = cache[openid] || {};
  if (c.token && jwtAlive(c.token)) {
    try {
      const info = await api("/rayo-dbo-operate/user-client-api/user/info", { token: c.token });
      log(`✅ 复用缓存登录态${info && info.phone ? ` (${maskPhone(info.phone)})` : ""}`);
      return { token: c.token, info };
    } catch (e) {
      if (e instanceof TokenExpired) log("ℹ️ 缓存登录态已失效, 重新登录");
      else log(`⚠️ 缓存校验异常: ${e.message}, 重新登录`);
    }
  } else if (c.token) {
    log("ℹ️ 缓存 token 已过期, 重新登录");
  }

  const token = await login(openid);
  if (!token) return null;
  cache[openid] = { token, ts: Date.now() };
  saveCache(cache);
  const info = await userInfo(token);
  log(`✅ 登录成功${info && info.phone ? ` (${maskPhone(info.phone)})` : ""}`);
  return { token, info };
}

const maskPhone = (p) => (p && p.length === 11 ? `${p.slice(0, 3)}****${p.slice(7)}` : p || "");

// ============ 业务: U 点余额 ============
async function balance(token) {
  try {
    const d = await api(`/rayo-dbo-operate/user-client-api/tokenize/get-by-user-id/${PAY_ACCOUNT}`, { token });
    return d && typeof d.surplusTokenize === "number" ? d.surplusTokenize : null;
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    return null;
  }
}

// ============ 业务: 签到 ============
async function doSign(token, summary) {
  let st;
  try {
    st = await api("/rayo-dbo-activity/user-client-api/activity/index", {
      token,
      query: { activityCode: SIGN_ACTIVITY },
    });
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`❌ 签到状态查询失败: ${e.message}`);
    summary.push("签到查询失败");
    return;
  }

  const days = st.consecutiveDays || 0;
  // 服务端下发的连续奖励表, 用来预告今天能拿多少
  const rule = (st.rewardRuleList || []).find((x) => x.days === days + 1);
  const willGet = rule && rule.rewardList && rule.rewardList[0] ? rule.rewardList[0].prizeNum : null;

  if (st.signInToday) {
    log(`ℹ️ 今日已签到 (连续 ${days} 天)`);
    summary.push(`签到已完成(连${days}天)`);
    return;
  }

  log(`📅 未签到, 当前连续 ${days} 天${willGet ? `, 今日可得 ${willGet} U点` : ""}`);
  await sleep(jitter(1200, 400));
  try {
    const r = await api("/rayo-dbo-activity/user-client-api/activity/join", {
      method: "POST",
      token,
      body: { activityCode: SIGN_ACTIVITY },
    });
    const prize = r && r.prizeList && r.prizeList[0];
    const name = prize ? prize.prizeName : "U点";
    log(`✅ 签到成功 +${willGet || "?"} ${name} (连续 ${days + 1} 天)`);
    summary.push(`签到+${willGet || "?"}U点`);
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    // 服务端幂等: 重复签到返回 50000 "今天已经签到了"
    if (e instanceof BizFail && /已经签到|已签到/.test(e.message)) {
      log(`ℹ️ 今日已签到 (服务端: ${e.message})`);
      summary.push("签到已完成");
      return;
    }
    log(`❌ 签到失败: ${e.message}`);
    summary.push(`签到失败(${e.message})`);
  }
}

// ============ 业务: 分享任务 ============
async function doShareTask(token, summary) {
  if (NO_SHARE) {
    log("ℹ️ 已通过 CYH_NO_SHARE 关闭分享任务");
    return;
  }
  const before = await balance(token);
  await sleep(jitter(1000, 300));
  try {
    await api("/rayo-dbo-activity/user-client-api/dbo-task-progress/upTask", {
      method: "POST",
      token,
      body: { taskId: SHARE_TASK, sourceTenantId: "" },
    });
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    // 未绑手机号的账号会被服务端拒绝, 需在小程序里手动补一次, 不是脚本故障
    if (/补充手机号|绑定手机/.test(e.message)) {
      log(`⚠️ 分享任务被拒: ${e.message} (请在小程序内手动绑定手机号)`);
      summary.push("分享需绑手机号");
      return;
    }
    log(`❌ 分享任务上报失败: ${e.message}`);
    summary.push(`分享任务失败(${e.message})`);
    return;
  }
  await sleep(jitter(1500, 400));
  const after = await balance(token);
  // 服务端对已达上限的任务同样返回"操作成功", 只能用余额差判断是否真到账
  if (before != null && after != null) {
    const diff = Math.round((after - before) * 100) / 100;
    if (diff > 0) {
      log(`✅ 分享任务完成 +${diff} U点`);
      summary.push(`分享+${diff}U点`);
    } else {
      log("ℹ️ 分享任务今日已达上限");
      summary.push("分享已完成");
    }
  } else {
    log("✅ 分享任务已上报(余额查询失败, 无法核对到账)");
    summary.push("分享已上报");
  }
}

// ============ 业务: 余额汇总 ============
async function showBalance(token, summary) {
  const b = await balance(token);
  if (b != null) {
    log(`💰 当前 U点余额: ${b}`);
    summary.push(`余额${b}`);
  }
}

// ============ 推送 ============
async function push(title, content) {
  if (!PUSH_TOKEN) return;
  try {
    const r = await request("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { token: PUSH_TOKEN, title, content, template: "txt" },
    });
    const ok = r.data && (r.data.code === 200 || r.data.code === "200");
    console.log(ok ? "📢 推送成功" : `📢 推送失败: ${JSON.stringify(r.data).slice(0, 120)}`);
  } catch (e) {
    console.log(`📢 推送异常: ${e.message}`);
  }
}

// ============ 单账号流程 ============
async function runOne(openid, idx, cache) {
  const nick = nickOf(openid, idx);
  log(`\n========== 账号[${idx + 1}] ${nick} ==========`);

  const summary = [];
  let auth;
  try {
    auth = await ensureToken(openid, cache);
  } catch (e) {
    log(`❌ 登录异常: ${e.message}`);
    return `${nick}: 登录异常(${e.message})`;
  }
  if (!auth) {
    log("❌ 登录失败, 跳过");
    return `${nick}: 登录失败`;
  }

  const flow = async (token) => {
    await doSign(token, summary);
    await sleep(jitter(1800, 500));
    await doShareTask(token, summary);
    await sleep(jitter(1200, 300));
    await showBalance(token, summary);
  };

  try {
    await flow(auth.token);
  } catch (e) {
    if (e instanceof TokenExpired) {
      // 与小程序一致: 401 时清 token 重登一次后重放剩余流程
      log("ℹ️ 运行中登录态失效, 重新登录后重试");
      delete cache[openid];
      saveCache(cache);
      let again = null;
      try {
        again = await ensureToken(openid, cache);
      } catch (e1) {
        log(`❌ 重登异常: ${e1.message}`);
      }
      if (!again) return `${nick}: 重登失败`;
      try {
        await flow(again.token);
      } catch (e2) {
        log(`❌ 重试仍失败: ${e2.message}`);
        return `${nick}: ${summary.join(" | ") || "失败"}`;
      }
    } else {
      log(`❌ 执行异常: ${e.message}`);
    }
  }
  return `${nick}: ${summary.join(" | ") || "无结果"}`;
}

// ============ 主流程 ============
(async () => {
  log(`🔔 ${APP_NAME},开始`);
  if (!ACCOUNTS.length) {
    log("❌ 未配置 wx_opinion(WCS openid, & 分隔)");
    log(`🔔 ${APP_NAME},结束`);
    process.exit(1);
  }
  if (!WCS_AUTH) log("⚠️ 未配置 wx_auth, WCS 可能拒绝请求");
  log(`📋 共 ${ACCOUNTS.length} 个账号`);

  const cache = loadCache();
  const results = [];
  for (let i = 0; i < ACCOUNTS.length; i++) {
    results.push(await runOne(ACCOUNTS[i], i, cache));
    if (i < ACCOUNTS.length - 1) {
      const w = jitter(4000, 1200);
      log(`⏳ 等待 ${(w / 1000).toFixed(1)}s...`);
      await sleep(w);
    }
  }
  saveCache(cache);

  log(`\n📊 汇总:`);
  results.forEach((r) => log(`  ${r}`));
  log(`🔔 ${APP_NAME},结束`);

  await push(APP_NAME, LOGS.join("\n"));
})().catch((e) => {
  console.log(`❌ 脚本异常: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
