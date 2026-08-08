/**
 * A2 乳品营养品 微信小程序 - 自动签到脚本
 * AppID:        wxabb3b309f0093ec2
 * BrandId:      a2
 * ChannelId:    2
 * CampaignCode: CSignIn20210531  (每日签到)
 * ActionType:   41             (UserSignin 动作)
 *
 * 接口架构:
 *   主站 CRM (KTS): https://crmapi.a2nutrition.cn/KTSApi/api/...
 *     - GetSessionKeyByCode : 用 wx.login code 换 Token / CustomerId / Mobile(加密) / SessionKey
 *     - InterfaceHubs        : 统一网关, 靠请求头 `module` 区分动作
 *         GetThisWeekSigninInfo : 查本周签到状态
 *         UserSignin            : 执行签到 (需 ActionType=41 + Mobile)
 *         CustomerAvailabelPoint: 查积分
 *
 * 签名算法 (已逆向小程序 wxapkg 并对照 HAR 验证):
 *   msg = "Module="+module+"&@#Nonce="+nonce+"&@#PrivateKey="+PRIVATE_KEY
 *         +"&@#RequestTime="+requesttime+"&@#UserName="+USER_NAME
 *   signature = base64( HmacSHA1(msg, PRIVATE_KEY) )
 *   其中 PRIVATE_KEY / USER_NAME 取自 config.password.common[version] / account.common[version]
 *   —— a2 生产环境(pro)这两个值均为空字符串 "", 故签名实质为 HmacSHA1(msg, "") ——
 *   已用 HAR 中 3 条真实请求(InsertTrackingRecord / GetThisWeekSigninInfo /
 *   CustomerAvailabelPoint)逐字节验证通过。
 *
 * 环境变量:
 *   wx_server_url : WCS 地址 (默认 http://host.docker.internal:18788)
 *   wx_auth       : WCS 认证 (新 smallcat-client 优先 /api/client/login, 失败回退此值)
 *   wx_opinion    : 账号 openid, 多账号用 & 分隔
 *   NICK_MAP      : 可选, openid->昵称, 支持 JSON 或 `openid:昵称&openid:昵称` 两种格式
 *   PLUSPLUS_TOKEN: 可选, _push Plus 推送签到结果
 *   A2_APPID      : 可选, 默认 wxabb3b309f0093ec2
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ===================== 配置 =====================
const APPID = process.env.A2_APPID || "wxabb3b309f0093ec2";
const WCS_URL = (process.env.wx_server_url || "http://host.docker.internal:18788").replace(/\/+$/, "");
const WCS_AUTH = process.env.wx_auth || "";
const WX_OPINION = process.env.wx_opinion || "";
const PUSH_TOKEN = process.env.PLUSPLUS_TOKEN || process.env.PUSH_PLUS_TOKEN || "";
// NICK_MAP 兼容两种格式:
//   1) JSON:      {"openid":"昵称", ...}
//   2) 面板惯用:  openid:昵称&openid:昵称   (呆呆面板现有格式)
const NICK_MAP = (() => {
  const raw = (process.env.NICK_MAP || "").trim();
  if (!raw) return {};
  if (raw.startsWith("{")) {
    try { return JSON.parse(raw); } catch { /* fallthrough */ }
  }
  const map = {};
  for (const pair of raw.split("&")) {
    const i = pair.indexOf(":");
    if (i > 0) map[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return map;
})();

const KTS_BASE = "https://crmapi.a2nutrition.cn";
const BRAND_ID = "a2";
const CHANNEL_ID = 2;
const CAMPAIGN_CODE = "CSignIn20210531";
const ACTION_TYPE = "41";

const PRIVATE_KEY = "";   // password.common.pro  -> 空
const USER_NAME = "";     // account.common.pro  -> 空

const CACHE_FILE = path.join(__dirname, "a2_token_cache.json");
const WCS_AUTH_CACHE = path.join(__dirname, "a2_wcs_auth.json");
const TOKEN_TTL = 55 * 60 * 1000; // 缓存 55 分钟

// ===================== 工具 =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rd(n) { return Math.floor(Math.random() * n); }
async function humanDelay(base = 800, jitter = 1200) { await sleep(base + rd(jitter)); }

function log(msg, emoji = "ℹ️") { console.log(`  ${emoji} ${msg}`); }

function loadJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; } }
function saveJSON(p, o) { try { fs.writeFileSync(p, JSON.stringify(o, null, 2)); } catch {} }

// ===================== 签名 (核心, 已验证) =====================
function buildSignature(module, nonce, requesttime) {
  const msg =
    `Module=${module}&@#Nonce=${nonce}&@#PrivateKey=${PRIVATE_KEY}` +
    `&@#RequestTime=${requesttime}&@#UserName=${USER_NAME}`;
  return crypto.createHmac("sha1", PRIVATE_KEY).update(msg).digest("base64");
}

function makeNonce() {
  // 与小程序一致: parseInt((Math.random()+1) * 1e9) -> 10 位数字
  return String(Math.floor((Math.random() + 1) * 1e9));
}

function makeHeaders(module, token) {
  const now = String(Math.floor(Date.now() / 1000));
  const nonce = makeNonce();
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    UserName: USER_NAME,
    Module: module,
    RequestTime: now,
    Nonce: nonce,
    Signature: buildSignature(module, nonce, now),
  };
  if (token) h["bearer-token-mini"] = token;
  return h;
}

// ===================== HTTP (内置 fetch, 无依赖) =====================
async function req(method, url, { headers = {}, body = null, retries = 3 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return data;
    } catch (e) {
      if (i === retries - 1) throw e;
      log(`请求失败(${i + 1}/${retries}): ${e.message}`, "⚠️");
      await sleep(1500 * (i + 1));
    }
  }
}

// ===================== WCS =====================
async function getWcsAuth() {
  const cached = loadJSON(WCS_AUTH_CACHE, {});
  if (cached.auth && cached.expiresAt > Date.now()) return cached.auth;
  try {
    const res = await fetch(`${WCS_URL}/api/client/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "yr1314", password: "yr123123" }),
    });
    const j = await res.json().catch(() => ({}));
    if (j?.data?.auth) {
      saveJSON(WCS_AUTH_CACHE, { auth: j.data.auth, expiresAt: Date.now() + 3600000 });
      return j.data.auth;
    }
  } catch (e) { /* 回退 */ }
  if (WCS_AUTH) return WCS_AUTH;
  throw new Error("WCS 登录失败且无 wx_auth 兜底");
}

async function getWxCode(openid) {
  const auth = await getWcsAuth();
  let lastDetail = "";

  // 上游 WX 协议服务(47.94.122.154:18789)会间歇性返回 EOF / 超时,
  // 这类是瞬时故障, 需退避重试; 而 "account not found" 是确定性失败, 立即放弃。
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await req("POST", `${WCS_URL}/wx/code`, {
      headers: { "Content-Type": "application/json", auth },
      body: { openid, appid: APPID },
    });
    // 只接受字符串 code, 避免把错误对象当 code 用 (会报 code.slice is not a function)
    const code =
      typeof res === "string" ? res :
      typeof res?.data?.code === "string" ? res.data.code :
      typeof res?.code === "string" ? res.code :
      typeof res?.data === "string" ? res.data : null;
    if (code) return code;

    lastDetail = res?.data?.error || res?.message || JSON.stringify(res).slice(0, 180);
    const d = String(lastDetail);

    // 确定性失败: 该微信号在上游协议端未登录/掉线, 重试无意义
    if (/account not found/i.test(d)) {
      throw new Error(`WCS 取 code 失败: ${lastDetail} (该微信在协议端掉线, 需重新扫码上线)`);
    }
    // 瞬时故障: EOF / timeout / connection reset / 502-504
    const transient = /EOF|timeout|timed out|reset|refused|502|503|504|unexpected/i.test(d);
    if (!transient || attempt === 3) break;

    const wait = 2000 * attempt;
    log(`WCS 取 code 瞬时故障(第${attempt}次): ${d.slice(0, 80)} — ${wait / 1000}s 后重试`, "🔁");
    await sleep(wait);
  }
  throw new Error(`WCS 取 code 失败: ${lastDetail}`);
}

// ===================== KTS API =====================
async function getSessionKeyByCode(code) {
  const headers = makeHeaders("GetSessionKeyByCode");
  const body = { Code: code, BrandId: BRAND_ID, ChannelId: CHANNEL_ID };
  const resp = await req("POST", `${KTS_BASE}/KTSApi/api/GetSessionKeyByCode`, { headers, body });
  if (!resp || !resp.ReturnObject) throw new Error(`GetSessionKeyByCode 失败: ${JSON.stringify(resp).slice(0, 200)}`);
  return resp.ReturnObject;
}

async function interfaceHubs(module, bodyObj, token) {
  const headers = makeHeaders(module, token);
  const resp = await req("POST", `${KTS_BASE}/KTSApi/api/InterfaceHubs`, { headers, body: bodyObj });
  if (!resp || resp.IsSucceed !== true) throw new Error(`[${module}] 失败: ${JSON.stringify(resp).slice(0, 200)}`);
  return resp;
}

// ===================== 业务: 单账号签到 =====================
async function signInOnce(openid) {
  const nick = NICK_MAP[openid] || openid.slice(0, 12) + "…";
  console.log(`\n=== [${nick}] 开始 ===`);

  try {
    // 1) 取 wx code
    const code = await getWxCode(openid);
    log(`拿到 wx code: ${code.slice(0, 10)}…`, "🔑");

    // 2) 登录换 Token
    const ro = await getSessionKeyByCode(code);
    const { CustomerId, Token, Mobile } = ro;
    log(`CustomerId=${CustomerId} 绑定=${ro.IsBinding} Mobile=${Mobile || "(空)"}`, "👤");

    // 3) 查本周签到
    const week = await interfaceHubs("GetThisWeekSigninInfo", {
      CustomerId, CampaignCode: CAMPAIGN_CODE, BrandId: BRAND_ID, ChannelId: CHANNEL_ID,
    }, Token);

    const rows = week.ReturnObject || [];
    const now = new Date();
    const today = rows.find((r) => r.Year === now.getFullYear() && r.Month === now.getMonth() + 1 && r.Day === now.getDate());
    const signedCount = rows.filter((r) => r.IsSign).length;
    log(`本周已签 ${signedCount}/7${today ? `, 今日${today.IsSign ? "已签" : "未签"}` : ""}`, "📅");

    let alreadySigned = today?.IsSign || false;
    let signMsg = "";
    let verified = alreadySigned; // 服务端确认今日已签

    if (!alreadySigned) {
      // 4) 执行签到 (需要 Mobile; 未绑定手机号时为空, 与 HAR 一致)
      const sign = await interfaceHubs("UserSignin", {
        CustomerId, CampaignCode: CAMPAIGN_CODE, ActionType: ACTION_TYPE,
        Mobile: Mobile || "", BrandId: BRAND_ID, ChannelId: CHANNEL_ID,
      }, Token);
      signMsg = sign.ErrorMessage || JSON.stringify(sign).slice(0, 80);
      log(`签到返回: ${signMsg}`, "✅");

      // 4.1) 复查确认 —— 防「接口说成功但实际没登记」的假阳性
      await sleep(1200);
      try {
        const recheck = await interfaceHubs("GetThisWeekSigninInfo", {
          CustomerId, CampaignCode: CAMPAIGN_CODE, BrandId: BRAND_ID, ChannelId: CHANNEL_ID,
        }, Token);
        const rows2 = recheck.ReturnObject || [];
        const today2 = rows2.find((r) => r.Year === now.getFullYear() && r.Month === now.getMonth() + 1 && r.Day === now.getDate());
        verified = !!today2?.IsSign;
        log(verified ? "复查: 今日 IsSign=true, 签到已登记" : "复查: IsSign 仍为 false, 签到未真正登记!", verified ? "🔎" : "⚠️");
      } catch (e) { log(`复查失败(不影响签到): ${e.message}`, "⚠️"); }
    } else {
      log("今日已签到, 跳过", "✅");
    }

    // 5) 查积分
    let points = null;
    try {
      const pt = await interfaceHubs("CustomerAvailabelPoint", {
        CustomerId, PointTypeIds: [1, 2], BrandId: BRAND_ID, ChannelId: CHANNEL_ID,
      }, Token);
      points = pt.ReturnObject || [];
      if (Array.isArray(points) && points.length === 0) {
        log(`积分: 无记录${ro.IsBinding ? "" : " (账号未绑定手机号, 积分可能不发放)"}`, "💰");
      } else {
        const total = points.reduce((s, p) => s + (p.AvailablePoints || 0), 0);
        log(`可用积分: ${total}`, "💰");
      }
    } catch (e) { log(`积分查询跳过: ${e.message}`, "⚠️"); }

    return {
      success: true, nick, alreadySigned, verified, signMsg,
      isBinding: !!ro.IsBinding,
      points: Array.isArray(points) ? points.reduce((s, p) => s + (p.AvailablePoints || 0), 0) : null,
    };
  } catch (e) {
    log(`失败: ${e.message}`, "❌");
    return { success: false, nick, error: e.message };
  }
}

// ===================== 签名自检 (对照 HAR) =====================
function selfTestSignature() {
  const cases = [
    // [module, nonce, requesttime, expectedSignature]
    ["GetThisWeekSigninInfo", "1848119608", "1786082396", "sHyyp+8HeyJydjQ6u8HyFxL5qC8="],
    ["CustomerAvailabelPoint", "1187733849", "1786082396", "gxsxBdGisKlpGGYPqBt7SPZ7QHU="],
    ["InsertTrackingRecord", "1263058747", "1786082409", "ZQ2Zslla0bQAmko91bPH98JHerQ="],
  ];
  console.log("=== 签名自检 (对照 HAR) ===");
  let allOk = true;
  for (const [mod, nonce, rt, exp] of cases) {
    const got = buildSignature(mod, nonce, rt);
    const ok = got === exp;
    allOk = allOk && ok;
    console.log(`  [${ok ? "OK" : "FAIL"}] ${mod}: ${got}`);
    if (!ok) console.log(`       期望: ${exp}`);
  }
  return allOk;
}

// ===================== 推送 =====================
async function pushPlus(title, content) {
  if (!PUSH_TOKEN) return;
  try {
    await fetch("http://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: PUSH_TOKEN, title, content, template: "txt" }),
    });
  } catch {}
}

// ===================== 主流程 =====================
async function main() {
  console.log("=== A2 乳品营养品 自动签到 ===");
  if (!selfTestSignature()) {
    console.log("[!] 签名自检未通过, 终止运行");
    process.exit(1);
  }
  const accounts = WX_OPINION.split("&").map((s) => s.trim()).filter(Boolean);
  if (!accounts.length) { console.log("[!] 未配置 wx_opinion"); process.exit(1); }
  console.log(`共 ${accounts.length} 个账号\n`);

  const results = [];
  for (const openid of accounts) {
    await humanDelay(600, 1200);
    results.push(await signInOnce(openid));
  }

  const ok = results.filter((r) => r.success && r.verified).length;
  const fail = results.length - ok;
  console.log(`\n=== 完成: 已签到 ${ok}, 未成功 ${fail} ===`);

  const content = results.map((r) => {
    if (!r.success) return `${r.nick}: 失败❌ ${r.error || ""}`;
    const state = r.alreadySigned ? "今日已签✅" : (r.verified ? "签到成功✅" : "签到未登记⚠️");
    const pt = r.points != null ? ` 积分${r.points}` : "";
    const bind = r.isBinding ? "" : " (未绑手机)";
    return `${r.nick}: ${state}${pt}${bind}`;
  }).join("\n");
  await pushPlus("A2 签到结果", content);
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
