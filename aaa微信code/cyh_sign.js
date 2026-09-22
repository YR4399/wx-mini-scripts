/**
 * 车友惠出行 微信小程序 —— WCS 登录 + 每日任务(签到/抽奖/分享/U点广告任务) + U点余额
 * AppID: wx0d7e4af01d0e7986   API: https://operation.rayoservice.com/api
 *
 * 每日任务(2026-09-21 重新逆向 + 实测):
 *   1) 多天签到   activity/index?activityCode=<签到活动>  → activity/join
 *      连续 1~7 天 10/20/30/40/50/60/100 U点; 奖励数值直接取 prizeList[0].quantity
 *   2) 签到抽奖   activity/draw-times 读 validCount(每日通常 1 次) → luckyDraw → getPrize
 *      次数用尽 / 活动下架 一律静默跳过(旧「按钮抽奖」活动已下架, 其接口直接报 SQL 异常)
 *   3) 分享任务   dbo-task-progress/upTask {taskId: 1980565381282213888}; 未绑手机号会被拒
 *   4) U点广告任务(「每日任务」列表) pcmp listPushPlan 拉列表 → advert/upClick {sid, pageCode}
 *      ⚠️ 实测结论(2026-09-21, 含「全新身份首次点击」对照): 卡片上的「+10」和「去完成/已完成」
 *      都是广告位下发的图片素材; upClick 能被广告平台记账(素材立刻从「去完成」翻成「已完成」),
 *      但 **账本里没有任何广告任务入账**、余额不动(老脚本每天刷十几条, 流水里一条都没有)。
 *      → 「触发」能成功(状态翻转), 但「+10」要真人进广告主小程序完成对应动作、由广告平台回传
 *      转化后才结算, 服务端伪造不了。
 *      脚本现在: 只对素材仍为「去完成」的逐条触发(触发后复拉列表核对翻转), 已完成的跳过、
 *      不重复上报; 想只看清单不触发就设 CYH_AD_CLICK=0。
 *   5) 每次运行额外拉一次 U点流水(tokenize/change-orders), 打印今日入账明细,
 *      用来核对到底哪一项在发币(目前只有「签到活动发放」和「完成任务奖励(分享小程序)」)。
 *
 * 环境变量(项目统一约定):
 *   wx_opinion      ★账号来源(WCS openid, & 分隔)
 *   wx_server_url   WCS 地址
 *   wx_auth         WCS 认证 key
 *   NICK_MAP        可选 昵称映射 openid:昵称&openid:昵称
 *   CYH_NO_SHARE    可选 设为 1 关闭分享任务上报
 *   CYH_NO_LOTTERY  可选 设为 1 关闭抽奖
 *   CYH_NO_AD       可选 设为 1 关闭 U点广告任务
 *   CYH_AD_CLICK    可选 设为 0 只列广告清单不触发(默认开启触发「去完成」的那些)
 *   CYH_AD_CLICK_MAX 可选 单次最多触发几条(默认 15)
 *   CYH_LOTTERY_CODES  可选 覆盖抽奖活动, 格式 名称|activityCode,名称|activityCode
 *   CYH_LOTTERY_ROUNDS 可选 每个抽奖位单次最多尝试轮数(默认 3, 上限 6)
 *
 * 缓存: cyh_token_cache.json (登录态) / cyh_state.json (U点快照, 用于算每日净变化)
 * cron: 36 19 * * *
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const { report } = require("./std_report");

// 清掉容器可能注入的死代理, 否则出网请求会被代理拦截
for (const _k of ["http_proxy","https_proxy","HTTP_PROXY","HTTPS_PROXY","all_proxy","ALL_PROXY"]) process.env[_k] = "";

// ============ 配置 ============
const APP_NAME = "车友惠出行";
const APPID = "wx0d7e4af01d0e7986";
const HOST = "https://operation.rayoservice.com/api";
const WCS = process.env.wx_server_url || "http://host.docker.internal:18788";
const WCS_AUTH = process.env.wx_auth || "";
const ACCOUNTS = (process.env.wx_opinion || "").split("&").map((s) => s.trim()).filter(Boolean);
const NO_SHARE = process.env.CYH_NO_SHARE === "1";
const NO_LOTTERY = process.env.CYH_NO_LOTTERY === "1";
const NO_AD = process.env.CYH_NO_AD === "1";
// 是否按客户端行为「触发」广告点击(默认开: 用户要求把「去完成」的触发掉;
// 置 CYH_AD_CLICK=0 可关)。注意: 触发只是把卡片翻成「已完成」, 不产生 U点。
const AD_CLICK = process.env.CYH_AD_CLICK !== "0";
// 单次运行最多触发几条(仅对素材仍是「去完成」的触发, 避免重复上报)
const AD_CLICK_MAX = Math.max(1, parseInt(process.env.CYH_AD_CLICK_MAX || "15", 10) || 15);
// 每个抽奖位单次运行最多尝试几轮(抽到"重复参与"即提前停止)
const LOTTERY_ROUNDS = Math.min(6, Math.max(1, parseInt(process.env.CYH_LOTTERY_ROUNDS || "3", 10) || 3));
const CACHE_FILE = path.join(__dirname, "cyh_token_cache.json");
const STATE_FILE = path.join(__dirname, "cyh_state.json");

// 小程序登录固定参数(页面装修配置下发)
const PAGE_CODE = "MBYM2310029073000013";
const RESOURCES_ID = "trzJiREk9VLpFnGOMc6W4TLhjiFY0BeXcG66lNyLvSQ=";
// 活动/任务标识
const SIGN_ACTIVITY = "2041790369687097344"; // 多天签到组件
const SHARE_TASK = "1980565381282213888"; // 分享小程序任务
const PAY_ACCOUNT = "1823205144156385281"; // U 点(代币)账户
// 免费抽奖位(奖品即 U 点); 会随活动排期上下线, 可用 CYH_LOTTERY_CODES 覆盖
const LOTTERIES = (() => {
  const env = (process.env.CYH_LOTTERY_CODES || "").trim();
  if (env) {
    return env.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const i = s.indexOf("|");
      return i > 0 ? { name: s.slice(0, i).trim(), code: s.slice(i + 1).trim() } : { name: s, code: s };
    });
  }
  return [
    { name: "签到抽奖", code: "1021151902886400000" },
    // 2026-09-21 实测: 该活动已下架, activity/index 报「该场次已结束」、draw-times 直接 SQL 异常 → 自动跳过
    { name: "按钮抽奖", code: "1021415085534482432" },
  ];
})();

// U点广告任务: 客户端只做「点击上报」(base_tokenAdTask 组件 → advert/upClick)
// 广告列表接口在 pcmp.keyunti.com, 无鉴权, 需 Origin/Referer yinlian
const AD_LIST_URL = "https://pcmp.keyunti.com/pcmpapi/pcmp-parking-fee/advert/listPushPlan";
// 点击上报走 yinlian 域(与广告页同域), body { sid, pageCode }
const AD_HOST = "https://yinlian.rayoservice.com/api";
const AD_PAGE_CODE = "MBYM2408029073000002"; // 广告上报 pageCode
const AD_POSITION = "parking0036"; // U点广告位
const AD_MASTER = "RYF0010";
// 「已完成」版卡片素材指纹: 广告位按 userIdent 返回两版图 —— 这 5 个 hash 是「已完成」,
// 另外 5 个(a94ac237/8861ed10/f567f76d/dd8999b6/7d6a9c2f)是「去完成」。用它在触发前判重。
const DONE_IMGS = [
  "aded5fe2f3fbab2682ac88e3de6d185d",
  "7b245d330cda483b764655a5f9d8fd66",
  "fca0cfb7db66538fb6902855154fcd46",
  "3421f44f87caee556966417763a7e7ad",
  "b339214fd3def45260885fe1ecb77bfc",
];
// adv/ret 走 right.rayoservice.com, WAF 要求浏览器 UA + yinlian Referer, 否则返回 SSL EOF/HTTP 000
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

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
    // 默认带浏览器 UA: 直接调用的外部接口(pcmp/upClick/adv/ret)无 UA 会被服务端拒
    if (!h["User-Agent"] && !h["user-agent"]) h["User-Agent"] = BROWSER_UA;
    // 默认 JSON: 外部接口(body 存在时)要求 application/json, 否则返回 415000
    if (payload != null && !h["Content-Type"] && !h["content-type"]) h["Content-Type"] = "application/json";
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

// U点快照(按 openid 记上次累计/可用), 用来算「较上次净变化」, 便于判断广告任务是否真发币
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}
function saveState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    log(`⚠️ 快照写入失败: ${e.message}`);
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

/** 从 JWT 解 userId(广告列表 userIdent / Client-Auth 之外标识用) */
function uidOf(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
    return String(p.userId || "");
  } catch (e) {
    return "";
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
async function balanceDetail(token) {
  try {
    const d = await api(`/rayo-dbo-operate/user-client-api/tokenize/get-by-user-id/${PAY_ACCOUNT}`, { token });
    if (!d) return null;
    return {
      total: typeof d.totalTokenize === "number" ? d.totalTokenize : null,
      surplus: typeof d.surplusTokenize === "number" ? d.surplusTokenize : null,
    };
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    return null;
  }
}

async function balance(token) {
  const b = await balanceDetail(token);
  return b ? b.surplus : null;
}
void balance;

// ============ 业务: 今日 U点流水(账本口径) ============
// 余额只给一个数; 流水才看得出"到底是哪一项在发币"。
// 实测(2026-09-21): 账本里只有「签到活动发放」和「完成任务奖励(分享小程序)」两类,
// 从无广告任务入账 —— 与「advert/upClick 只标记已完成、不发币」的结论互相印证。
async function todayLedger(token) {
  try {
    const d = await api(`/rayo-dbo-operate/user-client-api/tokenize/change-orders/${PAY_ACCOUNT}`, {
      token,
      query: { current: 1, size: 50 },
    });
    const recs = (d && d.records) || [];
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 服务端账本按北京时间
    const all = recs.filter((x) => String(x.changeTime || "").startsWith(day));
    const inc = all.filter((x) => Number(x.changeValue) > 0);
    const sum = inc.reduce((a, x) => a + Number(x.changeValue), 0);
    return { day, all, inc, sum };
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
  // 今日奖励: 优先用服务端下发的 prizeList(实测 activity/index 直接带今日奖品), 缺失再查连续奖励表
  const nowPrize = (st.prizeList || [])[0];
  const rule = (st.rewardRuleList || []).find((x) => x.days === days + 1);
  const willGet =
    (nowPrize && (nowPrize.quantity || 0)) ||
    (rule && rule.rewardList && rule.rewardList[0] ? rule.rewardList[0].prizeNum : null);
  const prizeName = (nowPrize && nowPrize.prizeName) || "U点";

  if (st.signInToday) {
    log(`ℹ️ 今日已签到 (连续 ${days} 天, 今日奖励 ${willGet || "?"} ${prizeName})`);
    summary.push(`签到已完成(连${days}天)`);
    return;
  }

  log(`📅 未签到, 当前连续 ${days} 天, 今日可得 ${willGet || "?"} ${prizeName}`);
  await sleep(jitter(1200, 400));
  try {
    const r = await api("/rayo-dbo-activity/user-client-api/activity/join", {
      method: "POST",
      token,
      body: { activityCode: SIGN_ACTIVITY },
    });
    const prize = r && r.prizeList && r.prizeList[0];
    const got = (prize && (prize.prizeNum || prize.quantity)) || willGet || "?";
    const name = (prize && prize.prizeName) || prizeName;
    log(`✅ 签到成功 +${got} ${name} (连续 ${days + 1} 天)`);
    summary.push(`签到+${got}U点`);
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
  // 注意: U点余额在小程序 H5 个人中心查询, 小程序 JS 不暴露余额接口;
  // 脚本原 balance() 用的是写死固定账户(作者占位账户), 与当前用户无关, 不能用于核对。
  // 改为信任 upTask 服务端返回: 成功即视为上报成功(每日限一次, 重复返回"已领"由服务端处理)。
  try {
    await api("/rayo-dbo-activity/user-client-api/dbo-task-progress/upTask", {
      method: "POST",
      token,
      body: { taskId: SHARE_TASK, sourceTenantId: "" },
    });
    log("✅ 分享任务已上报 (U点以服务端发放为准, 每日限一次)");
    summary.push("分享已上报");
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
  }
}

// ============ 业务: U点广告任务(点击上报, 与客户端行为一致) ============
/**
 * 客户端真实行为(主包解包 + H5 组件 base_tokenAdTask 双向确认, 2026-09-21):
 *   1) pcmp listPushPlan 拉广告列表(positionCode=parking0036, masterCode=RYF0010, pagePlatform=1)
 *   2) 用户点卡片 → 对 spreadType===2 的广告调 yinlian 域 advert/upClick { sid, pageCode }
 *      spreadType===1 是 iframe/外链广告, 客户端不会调 upClick
 *   3) 其余动作(upDeal / subscribeDeal)只属于「激励视频」和「订阅消息」场景, 与广告任务无关
 *
 * 实测结论(2026-09-21, 三账号 + 两个空白身份 + 一次「全新身份首次点击」对照):
 *   · advert/upClick、advert/upDeal 都返回 code:200 success, 但代币 total/surplus 完全不变;
 *     dealAction 枚举只支持 ADV_VIDEO(其它值一律「不支持的成交动作」);
 *     dbo-task-progress/upTask 只认分享任务 id(=1980565381282213888), 传 planId/sid 一律「任务编号错误」。
 *   · 广告卡片上的「+10」和「去完成/已完成」按钮都是**广告位下发的图片素材**: 同一 planId,
 *     换个没点过的 userIdent 拉到的是「去完成」版, 点过的拉到的是「已完成」版 —— 所以
 *     upClick 确实被广告平台记账了, 但账本(tokenize/change-orders)里**从无广告任务入账**:
 *     过去老脚本每天上报十几条(operation 域同样能翻转状态), 流水里一条都没有。
 *   · 用「全新 UUID 身份」（从没点过）做首次点击: 素材翻转成立, 但流水笔数/余额一动没动 → 排除
 *     「重复点击所以不结算」的可能; 该账号也只有唯一一个 U点账户(其它账户类接口全 404)。
 *   · spreadType===1 的外链广告(云闪付/工行)走 adv/ret → 302 到静态落地页, 直接访问落地页同样不发币。
 *   → 「+10」不是点一下就到账, 要真人进广告主小程序按它要求操作、由广告平台回传转化后才结算,
 *     服务端伪造不了。本模块因此只做两件事: 列出当日清单 + 触发仍未「已完成」的那些(默认开启)。
 *
 * 触发(upClick)会把该 userIdent 下这条广告打上「已完成」。脚本用的是 JWT userId(与手机端
 * localStorage.rayo_userId 同源), 所以触发后手机上那条也会显示「已完成」—— 但 U点 不会因此增加。
 * 只想看清单不触发: CYH_AD_CLICK=0。
 */
async function doAdTasks(token, userId, summary) {
  if (NO_AD) {
    log("ℹ️ 已通过 CYH_NO_AD 关闭 U点广告任务");
    return;
  }
  if (!userId) {
    log("⚠️ 无法解析 userId, 跳过 U点广告任务");
    summary.push("广告跳过(无userId)");
    return;
  }
  const adHeaders = {
    "User-Identity": userId,
    "Client-Auth": token,
    "Content-Type": "application/json",
    "User-Agent": UA,
    Origin: "https://yinlian.rayoservice.com",
    Referer: "https://yinlian.rayoservice.com/",
  };

  // 1) 拉广告列表
  let ads = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await request(AD_LIST_URL, {
        method: "POST",
        headers: { Origin: "https://yinlian.rayoservice.com", Referer: "https://yinlian.rayoservice.com/" },
        body: { categoryCode: "parking", pushNum: 5, positionCode: AD_POSITION, adSize: ["3:1"], masterCode: AD_MASTER, pagePlatform: 1, allowPop: true, userIdent: userId, advertiserUserIdent: userId, planIds: [], t: Date.now() / 1000 },
      });
      const d = r.data;
      if (d && d.data && Array.isArray(d.data)) { ads = d.data; break; }
      if (d && Array.isArray(d)) { ads = d; break; }
      throw new Error("列表空: " + JSON.stringify(d).slice(0, 120));
    } catch (err) {
      log(`⚠️ 广告列表获取失败(${attempt + 1}/4): ${err.message}`);
      await sleep(jitter(2500, 800));
    }
  }
  if (!ads.length) {
    log("❌ 广告列表获取失败(网络封锁?), U点广告任务本次跳过");
    summary.push("广告获取失败");
    return;
  }

  const jumpAds = ads.filter((a) => a.spreadType === 2);
  // 状态判定: imgUrl 里那串 hash 就是「去完成/已完成」两版素材的指纹(见文件头说明)
  const doneImg = (a) => DONE_IMGS.some((h) => String(a.imgUrl || "").includes(h));
  const fresh = jumpAds.filter((a) => !doneImg(a));
  const already = jumpAds.length - fresh.length;
  log(`ℹ️ 当日 U点广告任务 ${ads.length} 条 (可触发 ${jumpAds.length} 条; 素材显示「已完成」${already} 条 / 「去完成」${fresh.length} 条)`);
  jumpAds.slice(0, 20).forEach((a, i) => log(`   ${i + 1}. ${doneImg(a) ? "[已完成]" : "[去完成]"} ${String(a.title || "").slice(0, 28)}  sid=${a.sid}`));

  if (!AD_CLICK) {
    log("ℹ️ CYH_AD_CLICK=0: 只列清单不触发; 如需按客户端行为触发点击, 去掉该变量或设为 1");
    summary.push(`广告任务${ads.length}条`);
    return;
  }
  if (!fresh.length) {
    log("ℹ️ 当日可触发的广告都已「已完成」(本账号今天没有未触发的), 跳过");
    summary.push(`广告${ads.length}条(均已触发)`);
    return;
  }

  // 2) 按客户端行为触发点击: 仅对素材仍为「去完成」的(避免重复上报), 上限 CYH_AD_CLICK_MAX 条
  let ok = 0, fail = 0;
  for (const a of fresh.slice(0, AD_CLICK_MAX)) {
    await sleep(jitter(1400, 500));
    const title = (a.title || a.sid || "广告").toString().slice(0, 24);
    let reported = false, lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await request(AD_HOST + "/rayo-dbo-product/user-client-api/advert/upClick", {
          method: "POST",
          headers: adHeaders,
          body: { sid: a.sid, pageCode: AD_PAGE_CODE },
        });
        const d = r.data;
        if (d && d.code === 200) { reported = true; }
        else { lastErr = d ? `${d.code}:${d.msg}` : "无响应"; throw new Error(lastErr); }
        break;
      } catch (err) {
        lastErr = err.message;
        await sleep(jitter(2200, 600));
      }
    }
    if (reported) { ok++; log(`✅ 「${title}」触发成功(卡片会翻成「已完成」; U点由广告主回传转化后才结算)`); }
    else { fail++; log(`⚠️ 「${title}」触发失败: ${lastErr}`); }
  }
  // 3) 触发后复拉一次列表: 把翻转结果写进日志(这是「触发成功」的唯一可见证据)
  await sleep(1500);
  try {
    const r2 = await request(AD_LIST_URL, {
      method: "POST",
      headers: { Origin: "https://yinlian.rayoservice.com", Referer: "https://yinlian.rayoservice.com/" },
      body: { categoryCode: "parking", pushNum: 20, positionCode: AD_POSITION, adSize: ["3:1"], masterCode: AD_MASTER, pagePlatform: 1, allowPop: true, userIdent: userId, advertiserUserIdent: userId, planIds: [], t: Date.now() / 1000 },
    });
    const after = ((r2.data || {}).data) || [];
    if (after.length) {
      const flipped = fresh.filter((a) => { const b = after.find((y) => y.planId === a.planId); return b && b.imgUrl && b.imgUrl !== a.imgUrl; }).length;
      log(`🔁 复拉列表核对: 触发 ${ok} 条, 其中 ${flipped} 条素材已翻转为「已完成」`);
    }
  } catch (e) {
    log(`⚠️ 复拉列表核对失败: ${e.message}`);
  }
  log(`📣 U点广告任务: 触发 ${ok} 条 / 失败 ${fail} 条 / 已完成未重复触发 ${already} 条 (触发=标记已完成, U点不由触发发放)`);
  summary.push(`广告触发${ok}条`);
}

// ============ 业务: 免费抽奖 ============
/**
 * 抽奖流程与页面一致: 查活动状态 -> luckyDraw 抽 -> 对 result===1 的奖品 getPrize 领取
 * 安全护栏: in/activity/status 的 hasPay 为 0 表示"需要支付参加费用", 这类活动一律跳过
 */
async function doLottery(token, summary) {
  if (NO_LOTTERY) {
    log("ℹ️ 已通过 CYH_NO_LOTTERY 关闭抽奖");
    return;
  }

  let phone = "";
  try {
    const info = await api("/rayo-dbo-operate/user-client-api/user/info", { token });
    phone = (info && info.phone) || "";
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
  }

  let got = 0;
  let done = 0;
  for (const lot of LOTTERIES) {
    await sleep(jitter(1500, 500));

    // 1) 剩余次数(与客户端「剩余抽奖次数」组件同款接口, 比盲抽到报错更稳)
    let times = null;
    try {
      times = await api("/rayo-dbo-activity/user-client-api/activity/draw-times", {
        token,
        query: { activityCode: lot.code },
      });
    } catch (e) {
      if (e instanceof TokenExpired) throw e;
      // 活动下架/换期属正常现象(旧「按钮抽奖」就是这样: 接口直接 SQL 异常), 静默跳过
      log(`⏭️ ${lot.name}: 活动不可用 / 已下架 (${String(e.message).replace(/\s+/g, " ").slice(0, 40)}), 跳过`);
      continue;
    }
    const valid = times && typeof times.validCount === "number" ? times.validCount : null;
    if (valid === 0) {
      log(`ℹ️ ${lot.name}: 今日免费次数已用完`);
      done++;
      continue;
    }

    // 2) 付费护栏
    try {
      const st = await api("/rayo-dbo-activity/user-client-api/in/activity/status", {
        token,
        query: { activityCode: lot.code },
      });
      if (!st || st.hasPay !== 1) {
        log(`⏭️ ${lot.name}: 需支付参加费用, 跳过`);
        continue;
      }
    } catch (e) {
      if (e instanceof TokenExpired) throw e;
      log(`⏭️ ${lot.name}: 活动状态异常(${String(e.message).replace(/\s+/g, " ").slice(0, 40)}), 跳过`);
      continue;
    }

    // 3) 按剩余次数抽(未知次数时按上限试, 服务端会以「重复参与」兜底)
    const maxTimes = valid == null ? LOTTERY_ROUNDS : Math.min(valid, LOTTERY_ROUNDS);
    log(`🎯 ${lot.name}: ${valid == null ? `次数未知, 最多试 ${maxTimes} 次` : `剩余免费次数 ${valid}`}`);
    let rounds = 0;
    for (let i = 0; i < maxTimes; i++) {
      if (i) await sleep(jitter(1600, 400));
      let wins;
      try {
        const r = await api("/rayo-dbo-activity/user-client-api/luckyDraw", {
          token,
          query: { activityCode: lot.code },
        });
        wins = (r || []).filter((x) => x && x.result === 1);
      } catch (e) {
        if (e instanceof TokenExpired) throw e;
        // 服务端幂等: 机会用尽返回 "重复参与"
        if (e instanceof BizFail && /重复参与|次数|已用完/.test(e.message)) {
          if (!rounds) log(`ℹ️ ${lot.name}: 今日机会已用完`);
          break;
        }
        log(`⚠️ ${lot.name}: ${String(e.message).replace(/\s+/g, " ").slice(0, 60)}`);
        break;
      }
      rounds++;

      if (!wins.length) {
        log(`🎲 ${lot.name}: 第 ${rounds} 次未中奖`);
        continue;
      }

      // 4) 领奖(中奖后必须领取才到账)
      for (const w of wins) {
        await sleep(jitter(900, 300));
        try {
          await api("/rayo-dbo-activity/user-client-api/getPrize", {
            method: "POST",
            token,
            body: { prizeId: w.prizeId, phone },
          });
          log(`🎉 ${lot.name}: 中「${w.prizeName || "奖品"}」已领取`);
          got++;
        } catch (e) {
          if (e instanceof TokenExpired) throw e;
          log(`⚠️ ${lot.name}: 中奖但领取失败(${String(e.message).slice(0, 60)})`);
        }
      }
    }
    done++;
  }

  if (got) summary.push(`抽奖领${got}份`);
  else if (done) summary.push("抽奖已完成");
}

// ============ 业务: 余额汇总(含与上一次快照的净变化) ============
async function showBalance(token, openid, state, summary) {
  const b = await balanceDetail(token);
  if (!b) return;
  const prev = state[openid] || null;
  const prevTotal = prev && typeof prev.total === "number" ? prev.total : null;
  const delta = prevTotal != null && b.total != null ? b.total - prevTotal : null;
  const deltaTxt = delta == null ? "" : delta > 0 ? `, 较上次 +${delta}` : delta < 0 ? `, 较上次 ${delta}` : ", 较上次 ±0";
  log(`💰 U点: 累计 ${b.total} / 可用 ${b.surplus}${deltaTxt}`);
  summary.push(`余额${b.surplus}`);
  if (delta) summary.push(`U点较上次${delta > 0 ? "+" + delta : delta}`);
  state[openid] = { total: b.total, surplus: b.surplus, ts: Date.now() };

  // 今日流水(账本口径): 用来看清到底是哪一项在发币
  const led = await todayLedger(token);
  if (!led) return;
  if (!led.inc.length) {
    log("📒 今日流水: 无入账");
    return;
  }
  const byType = {};
  for (const x of led.inc) {
    const k = String(x.changeTypeName || "入账").slice(0, 12);
    byType[k] = (byType[k] || 0) + Number(x.changeValue);
  }
  const detail = Object.entries(byType)
    .map(([k, v]) => `${k}+${v}`)
    .join(" / ");
  log(`📒 今日流水 ${led.inc.length} 笔 合计 +${led.sum}: ${detail}`);
  summary.push(`今日入账+${led.sum}`);
}

// ============ 推送 ============
// 推送统一由 std_report.report 处理(钉钉加签), 见主流程内 report(APP_NAME, results)

// ============ 单账号流程 ============
async function runOne(openid, idx, cache, state) {
  const nick = nickOf(openid, idx);
  log(`\n========== 账号[${idx + 1}] ${nick} ==========`);

  const summary = [];
  let sign = "今日已完成";

  let auth;
  try {
    auth = await ensureToken(openid, cache);
  } catch (e) {
    log(`❌ 登录异常: ${e.message}`);
    return { idx, name: nick, sign: "登录异常", earned: null, total: null, tasks: null, lottery: null };
  }
  if (!auth) {
    log("❌ 登录失败, 跳过");
    return { idx, name: nick, sign: "登录失败", earned: null, total: null, tasks: null, lottery: null };
  }

  const flow = async (token) => {
    await doSign(token, summary);
    await sleep(jitter(1800, 500));
    await doShareTask(token, summary);
    await sleep(jitter(1500, 400));
    await doAdTasks(token, uidOf(token), summary);
    await sleep(jitter(1500, 400));
    await doLottery(token, summary);
    await sleep(jitter(1200, 300));
    await showBalance(token, openid, state, summary);
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
      if (!again) {
        return { idx, name: nick, sign: "重登失败", earned: null, total: null, tasks: null, lottery: null };
      }
      try {
        await flow(again.token);
      } catch (e2) {
        log(`❌ 重试仍失败: ${e2.message}`);
        sign = "执行异常";
      }
    } else {
      log(`❌ 执行异常: ${e.message}`);
      sign = "执行异常";
    }
  }

  // 结构化字段回填
  const pick = (p) => summary.find((s) => s.startsWith(p)) || null;
  const signLine = pick("签到");
  let earned = null;
  if (signLine) {
    const m = signLine.match(/\+(\d+)U点/);
    if (m) earned = `+${m[1]}U点`;
  }
  const balLine = pick("余额");
  const total = balLine ? Number(balLine.slice(2)) : null;
  const shareLine = pick("分享");
  const adLine = pick("广告");
  const deltaLine = pick("U点较上次");
  const incLine = pick("今日入账");
  const tasks = [shareLine, adLine, incLine, deltaLine].filter(Boolean).join(" | ") || null;
  const lotteryLine = summary.find((s) => s.startsWith("抽奖")) || null;

  return {
    idx,
    name: nick,
    sign: signLine || sign,
    earned,
    total,
    tasks,
    lottery: lotteryLine,
  };
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
  const state = loadState();
  const results = [];
  for (let i = 0; i < ACCOUNTS.length; i++) {
    results.push(await runOne(ACCOUNTS[i], i, cache, state));
    if (i < ACCOUNTS.length - 1) {
      const w = jitter(4000, 1200);
      log(`⏳ 等待 ${(w / 1000).toFixed(1)}s...`);
      await sleep(w);
    }
  }
  saveCache(cache);
  saveState(state);

  log(`\n📊 汇总:`);
  results.forEach((r) =>
    log(`  ${r.name}: ${r.sign}${r.earned ? " " + r.earned : ""}${r.total != null ? " | 余额:" + r.total : ""}${r.tasks ? " | " + r.tasks : ""}${r.lottery ? " | " + r.lottery : ""}`)
  );
  log(`🔔 ${APP_NAME},结束`);

  report(APP_NAME, results);
})().catch((e) => {
  console.log(`❌ 脚本异常: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
