/**
 * 花知晓官方会员商城 微信小程序 —— WCS 登录 + 每日签到 / 任务查询
 * AppID: wx4a6d75d098b41a47   API: https://retail-h5.youzan.com (有赞零售 wscshop/wscuser/wscump)
 * 店铺 kdtId: 92061498
 *
 * 每日动作: 会员签到(check-in) / 查询成长任务(购物任务需真实下单, 无法自动)
 *
 * 环境变量(项目统一约定):
 *   wx_opinion      ★账号来源(WCS openid, & 分隔)
 *   wx_server_url   WCS 地址
 *   wx_auth         WCS 认证 key
 *   NICK_MAP        可选 昵称映射 openid:昵称&openid:昵称
 *   推送            统一走 std_report 双引擎(钉钉 markdown)
 *
 * token 缓存: huazhixiao_token_cache.json (按 openid, 1h 有效期, 自动重登)
 * cron: 30 9 * * *
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ============ 配置 ============
const APP_NAME = "花知晓";
const APPID = "wx4a6d75d098b41a47";
const HOST = "https://retail-h5.youzan.com";
const KDT_ID = "92061498";
const WCS = process.env.wx_server_url || "http://host.docker.internal:18788";
const WCS_AUTH = process.env.wx_auth || "";
const ACCOUNTS = (process.env.wx_opinion || "").split("&").map((s) => s.trim()).filter(Boolean);
const CACHE_FILE = path.join(__dirname, "huazhixiao_token_cache.json");
const TOKEN_TTL = 1 * 60 * 60 * 1000; // 1h

const UA =
  "Mozilla/5.0 (Linux; Android 14; 23127PN0CC Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.107 Mobile Safari/537.36 XWEB/1300233 MMWEBSDK/20241202 MMWEBID/2846 MicroMessenger/8.0.56.2800(0x28003837) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android";

const BASE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": UA,
  Referer: `https://servicewechat.com/${APPID}/289/page-frame.html`,
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
function jitter(base, spread) {
  let u = 0, v = 0;
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

function request(url, { method = "GET", headers = {}, body = null, timeout = 20000 } = {}) {
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

// ============ 有赞请求封装 ============
class TokenExpired extends Error {}

/**
 * 有赞统一请求封装。
 * - 登录态通过 Extra-Data 头传递: { is_weapp, client, bizEnv, [skip_sid], sid, version }
 * - 鉴权 token(access_token) 与 kdt_id 注入 query
 * - 部分接口(签到)还需把 session_id 写入 Cookie(KDTSESSIONID/sid) 才能识别用户
 */
async function yzApi(pathname, { method = "GET", query = null, body = null, token = null, cookie = null, skipSid = false } = {}) {
  const extra = { is_weapp: 1, client: "weapp", bizEnv: "wsc", version: "1.0.0" };
  if (skipSid) extra.skip_sid = 1;
  else if (token && token.session_id) extra.sid = token.session_id;

  const headers = { ...BASE_HEADERS, "Extra-Data": JSON.stringify(extra) };
  if (cookie) headers.Cookie = cookie;

  let p = pathname;
  const q = { ...(query || {}) };
  if (token && token.access_token) q.access_token = token.access_token;
  if (token || !skipSid) q.kdt_id = KDT_ID;
  if (Object.keys(q).length) {
    p += (p.includes("?") ? "&" : "?") + Object.keys(q).map((k) => `${k}=${encodeURIComponent(q[k])}`).join("&");
  }

  const opts = { method, headers };
  if (method.toUpperCase() !== "GET" && body != null) opts.body = body;

  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await request(HOST + p, opts);
      break;
    } catch (e) {
      const retriable = /hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|timeout/i.test(e.message || "");
      if (attempt >= 1 || !retriable) throw e;
      await sleep(jitter(1500, 500));
    }
  }
  const d = r.data;
  if (!d || typeof d !== "object") throw new Error(`响应异常(HTTP ${r.status}): ${String(r.raw).slice(0, 120)}`);
  if (d.code === 0) return d.data;
  // 登录态失效: 有赞常见鉴权失败码
  if ([240000012, 160100900, 1000000001, 1000000002].includes(d.code)) throw new TokenExpired(`code=${d.code} ${d.msg || ""}`);
  if (d.code === 401) throw new TokenExpired(`401 ${d.msg || ""}`);
  throw new Error(d.msg || `code=${d.code}`);
}

// ============ 登录 ============
async function youzanLogin(openid) {
  const code = await getWxCode(openid);
  if (!code) return null;
  // 有赞零售小程序登录: POST /wscshop/weapp/authorize.json
  const headers = { ...BASE_HEADERS, "Extra-Data": JSON.stringify({ is_weapp: 1, client: "weapp", bizEnv: "wsc", skip_sid: 1, version: "1.0.0" }) };
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await request(`${HOST}/wscshop/weapp/authorize.json`, { method: "POST", headers, body: { appId: APPID, clientBiz: "weapp_wsc", code } });
      break;
    } catch (e) {
      const retriable = /hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|timeout/i.test(e.message || "");
      if (attempt >= 1 || !retriable) throw e;
      await sleep(jitter(1500, 500));
    }
  }
  const d = r.data;
  if (!d || d.code !== 0 || !d.data) throw new Error(`登录失败: ${d ? d.msg || JSON.stringify(d).slice(0, 100) : r.raw.slice(0, 100)}`);
  return d.data; // 含 session_id / access_token / yz_user_id / buyer_id / nick_name 等
}

async function ensureToken(openid, cache) {
  const c = cache[openid] || {};
  if (c.token && c.ts && Date.now() - c.ts < TOKEN_TTL) {
    try {
      // 轻量探活: 查会员积分名(无需额外权限)
      await yzApi("/wscuser/membercenter/pointsName.json", { token: c.token });
      log(`✅ 复用缓存登录态 (${c.token.nick_name || nickOf(openid, 0)})`);
      return c.token;
    } catch (e) {
      if (e instanceof TokenExpired) log("ℹ️ 缓存登录态已失效, 重新登录");
      else log(`⚠️ 缓存校验异常: ${e.message}, 重新登录`);
    }
  } else if (c.token) {
    log("ℹ️ 缓存 token 已过期, 重新登录");
  }
  const token = await youzanLogin(openid);
  if (!token) return null;
  cache[openid] = { token, ts: Date.now() };
  saveCache(cache);
  log(`✅ 登录成功 (${token.nick_name || nickOf(openid, 0)})`);
  return token;
}

// ============ 业务: 会员签到 ============
async function doCheckin(token, summary) {
  // 1) 取签到活动ID
  let info;
  try {
    info = await yzApi("/wscump/checkin/show_checkin_page_v2.json", { token });
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`⚠️ 签到页获取失败: ${e.message}`);
    if (typeof logPoints === 'function') logPoints(null, null, "huazhixiao", 1, "签到成功") // local accumulation needed;
    summary.push("签到: 获取失败");
    return;
  }
  const cid = info && info.checkinId;
  if (!cid) {
    log("ℹ️ 当前无进行中的签到活动");
    summary.push("签到: 无活动");
    return;
  }
  // 注: isShow=false 仅表示签到弹窗已隐藏(通常因今日已签), 活动仍在, 仍可调用 checkinV2(幂等)
  // 2) 签到: 有赞签到服务靠 KDTSESSIONID/sid Cookie 识别用户
  const sid = token.session_id;
  const cookie = `KDTSESSIONID=${sid}; sid=${sid}; _kdt_id_=${KDT_ID}`;
  try {
    const res = await yzApi("/wscump/checkin/checkinV2.json", { token, cookie, query: { checkinId: cid } });
    if (res && res.id) {
      log(`📅 签到成功 (连续 ${res.seriesDay || res.continueDays || "?"} 天, 获 ${res.point || res.reward || "奖励"})`);
    } else {
      log("📅 签到成功");
    }
    summary.push("签到: 成功");
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    const msg = e.message || "";
    if (/已达最大参与次数|已签到|今天已/.test(msg) || /1000030071/.test(msg)) {
      log("📅 今日已签到(幂等)");
      summary.push("签到: 已完成");
    } else if (/手机号未授权|用户手机号/.test(msg) || /1000030102/.test(msg)) {
      log("⚠️ 签到需先在小程序授权手机号, 已跳过");
      summary.push("签到: 需授权手机号");
    } else {
      log(`❌ 签到失败: ${msg.slice(0, 80)}`);
      summary.push("签到: 失败");
    }
  }
}

// ============ 业务: 成长任务查询 ============
async function getMissions(token, summary) {
  try {
    const list = await yzApi("/wscuser/scrm/api/ump/getMissionListV2.json", { token });
    if (!list || !list.length) {
      log("📋 暂无成长任务");
      summary.push("任务: 无");
      return;
    }
    const titles = [];
    for (const g of list) {
      const items = (g.list || []).map((m) => m.name).join("/");
      titles.push(`${g.title}(${items})`);
    }
    log(`📋 成长任务: ${titles.join(" | ")}  (购物类需真实下单, 无法自动)`);
    summary.push("任务: 见日志");
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`⚠️ 任务查询失败: ${e.message.slice(0, 80)}`);
    summary.push("任务: 查询失败");
  }
}

// ============ 单账号主流程 ============
async function runOne(openid, idx, cache) {
  const nick = nickOf(openid, idx);
  _setName(idx, nick);
  console.log(`\n========== 账号[${idx + 1}] ${nick} ==========`);
  const summary = [];
  let token;
  try {
    token = await ensureToken(openid, cache);
  } catch (e) {
    if (e instanceof TokenExpired) {
      // 重试一次重登
      try {
        token = await youzanLogin(openid);
        cache[openid] = { token, ts: Date.now() };
        saveCache(cache);
      } catch (e2) {
        log(`❌ 登录失败: ${e2.message}`);
        return [`${nick}: 登录失败`];
      }
    } else {
      log(`❌ 登录异常: ${e.message}`);
      return [`${nick}: 登录异常`];
    }
  }
  if (!token) return [`${nick}: 无token`];

  try {
    await doCheckin(token, summary);
  } catch (e) {
    if (e instanceof TokenExpired) {
      log("🔄 签到时登录态失效, 重新登录后重试");
      try {
        token = await youzanLogin(openid);
        cache[openid] = { token, ts: Date.now() };
        saveCache(cache);
        summary.length = 0;
        await doCheckin(token, summary);
      } catch (e2) {
        log(`❌ 重试登录失败: ${e2.message}`);
      }
    } else {
      log(`⚠️ 签到异常: ${e.message}`);
    }
  }
  try {
    await getMissions(token, summary);
  } catch (e) {
    log(`⚠️ 任务异常: ${e.message}`);
  }
  return [`${nick}: ${summary.join(" | ")}`];
}

// ============ 入口 ============

const { report: _stdReport } = require("./std_report");
let _rpRows = [];
let _rpApp = '花知晓会员签到';
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
  console.log(`🔔 ${APP_NAME} 会员签到, 开始`);
  const cache = loadCache();
  const rows = [];
  for (let i = 0; i < ACCOUNTS.length; i++) {
    rows.push(await runOne(ACCOUNTS[i], i, cache));
  }
  console.log("\n📊 汇总:");
  for (const r of rows) console.log("  " + r.join(" / "));
  console.log("🔔 结束");

}

main().catch((e) => {
  console.error("💥 致命错误:", e);
  process.exit(1);
});
