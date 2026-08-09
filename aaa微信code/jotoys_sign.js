/**
 * JOTOYS(集玩具) 微信小程序 —— WCS 登录 + 每日签到 + 分享任务
 * AppID: wx5a842e396784099b
 * API:   https://jotoys.jiouchaole.cn/qiouapi
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 【逆向结论 2026-08-09 · wxapkg(radium V1MMWX 解密解包) 实跑确认】
 *
 *  0) 后端是 PHP(appapi.php / user.php)。鉴权 = `usertoken`(登录返回, 挂在
 *     query/body 上), 会话另有 PHPSESSID cookie。全站默认请求头(见 app-service.js
 *     `u.default.prototype.headers`):
 *        Content-Type: application/x-www-form-urlencoded   ★★★
 *        skappway: "App made in chaoge", os: "weixin_mp", ver: "2.7.17"
 *     ⚠️ 坑: 用 JSON 提交 getweixinphone_code 会返回 41008 "missing code",
 *        必须 form-urlencoded。
 *
 *  1) 登录链(三步, 对应小程序 w_login1 → getPhoneNumber → login):
 *     a. WCS  POST /wx/code {openid,appid}                  -> data.code (wx.login code)
 *     b. POST appapi.php?act=getweixinphone_code
 *          form: {JSCODE:<code>, v:100}                     -> {openid, unionid, session_key}
 *          (同时 Set-Cookie: PHPSESSID, 需带到后续请求)
 *          注: session_key 恒为 "已作废", 不影响流程。
 *     c. WCS  POST /wx/getphonenumber {openid,appid}        -> data.code (手机号 code)
 *             POST appapi.php?act=getweixinphone_new
 *               form: {code:<手机号code>}                    -> phone_info.phoneNumber
 *     d. GET  appapi.php?act=mpweixinphonelogin
 *          headers: skappwayphone=<手机号> ★必需(缺它恒返回 "参数有误")
 *                   skappwayopenid=<openid>, skappwayunionid=<unionid>
 *                                                           -> {status:1, usertoken, userid, userdata}
 *     ⚠️ app-service.js 里的 `xcx/login`(返回 skey/gid/vid) 是企业微信模板死代码, 勿用。
 *
 *  2) 签到(每日1次, 连续奖励):
 *     GET user.php?act=taskdata {usertoken}
 *       -> data.{signed(0/1), signeddata:{t:{zhi:[...7档积分], maxlian:"7"}, lian:"连续天数"},
 *                sharecount1(分享上限=3), shareedcount1(今日已分享)}
 *     GET appapi.php?act=qiandao {usertoken}
 *       -> {status:1, msg:"连续N天签", value:<获得积分>} / {status:0, msg:"今天已签到"}
 *
 *  3) 分享任务(每日3次, 每次 +5 积分):
 *     GET appapi.php?act=addshare {usertoken}
 *       -> {status:1,...} / {status:0, msg:"今天分享获得积分次数一到上限"}
 *     次数以 taskdata 的 shareedcount1/sharecount1 为准。
 *
 *  4) 其它:
 *     GET appapi.php?act=everyday      {usertoken}  每日心跳(空响应, 正常)
 *     GET appapi.php?act=getmyintegral {usertoken}  -> {total:"积分", money:"余额"}
 *     GET user.php?act=getintegral     {usertoken}  -> 积分明细(核对到账用)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 【环境变量 · 全部走项目统一约定】
 *  wx_opinion      : ★账号来源(WCS openid, & 分隔)
 *  wx_server_url   : WCS 地址
 *  wx_auth         : WCS 认证 key
 *  PUSH_PLUS_TOKEN : PushPlus 推送(可选)
 *
 * token 缓存: jotoys_token_cache.json (按 openid, 复用 usertoken+cookie, 失效自动重登)
 * cron: 20 9 * * *
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ============ 配置 ============
const APPID = "wx5a842e396784099b";
const HOST = "https://jotoys.jiouchaole.cn/qiouapi";
const WCS = process.env.wx_server_url || "http://host.docker.internal:18788";
const WCS_AUTH = process.env.wx_auth || "";
const PUSH_TOKEN = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN || "";
const ACCOUNTS = (process.env.wx_opinion || "").split("&").map(s => s.trim()).filter(Boolean);
const CACHE_FILE = path.join(__dirname, "jotoys_token_cache.json");

const UA = "Mozilla/5.0 (Linux; Android 14; 23127PN0CC Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.107 Mobile Safari/537.36 XWEB/1300233 MMWEBSDK/20241202 MMWEBID/2846 MicroMessenger/8.0.56.2800(0x28003837) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android";
// 小程序全局默认请求头(逆向自 app-service.js)
const BASE_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  skappway: "App made in chaoge",
  os: "weixin_mp",
  ver: "2.7.17",
  skappwayfromcode: "",
  "User-Agent": UA,
  Referer: `https://servicewechat.com/${APPID}/153/page-frame.html`,
};

// ============ 工具 ============
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 高斯抖动延迟, 比均匀随机更像真人节奏
function jitter(base, spread) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(300, Math.round(base + g * spread));
}
const mask = s => (!s ? "-" : s.length <= 8 ? s : s.slice(0, 4) + "***" + s.slice(-4));
const maskTel = t => (!t || t.length < 7 ? "-" : t.slice(0, 3) + "****" + t.slice(-4));
const form = o => Object.entries(o || {})
  .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v == null ? "" : v))
  .join("&");

function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (data != null) h["Content-Length"] = Buffer.byteLength(data);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: h,
      timeout: 30000,
    }, res => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", c => (buf += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}

// 网络抖动/TLS 偶发断连 → 退避重试
async function reqRetry(method, url, headers, body, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await request(method, url, headers, body); }
    catch (e) {
      last = e;
      if (i < tries) await sleep(1200 * i);
    }
  }
  throw last;
}

// ============ 缓存 ============
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); } catch (e) { console.log("  ⚠️ 缓存写入失败:", e.message); }
}

// ============ 会话 ============
class Session {
  constructor() { this.cookie = ""; }
  _grab(res) {
    const sc = res.headers["set-cookie"];
    if (sc && sc.length) {
      const jar = {};
      (this.cookie ? this.cookie.split("; ") : []).forEach(kv => {
        const i = kv.indexOf("="); if (i > 0) jar[kv.slice(0, i)] = kv.slice(i + 1);
      });
      sc.forEach(x => {
        const kv = x.split(";")[0]; const i = kv.indexOf("=");
        if (i > 0) jar[kv.slice(0, i)] = kv.slice(i + 1);
      });
      this.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    }
  }
  headers(extra) {
    const h = Object.assign({}, BASE_HEADERS, extra || {});
    if (this.cookie) h.Cookie = this.cookie;
    return h;
  }
  // file: appapi.php / user.php
  async call(file, act, data, method = "GET", extra) {
    let url = `${HOST}/${file}?act=${act}`;
    let bodyStr = null;
    if (method === "GET") { const q = form(data); if (q) url += "&" + q; }
    else bodyStr = form(data);
    const res = await reqRetry(method, url, this.headers(extra), bodyStr);
    this._grab(res);
    return res.json !== null ? res.json : res.body;
  }
}

// ============ WCS ============
// WCS 偶发返回 status:false "获取小程序数据失败"(上游微信会话抖动), 属业务级失败,
// reqRetry 捕获不到 → 这里再包一层退避重试。
async function wcs(pathname, body, tries = 3) {
  let lastMsg = "";
  for (let i = 1; i <= tries; i++) {
    const res = await reqRetry("POST", WCS + pathname,
      { "Content-Type": "application/json", auth: WCS_AUTH, "User-Agent": "node" }, body);
    if (!res.json) lastMsg = `非 JSON: ${String(res.body).slice(0, 120)}`;
    else if (res.json.status !== true) lastMsg = res.json.message || String(res.body).slice(0, 120);
    else return res.json.data || {};
    if (i < tries) {
      console.log(`  ⚠️ WCS ${pathname} 第${i}次失败(${lastMsg}), 重试...`);
      await sleep(2500 * i);
    }
  }
  throw new Error(`WCS ${pathname} 失败: ${lastMsg}`);
}

// ============ 登录 ============
async function login(openid) {
  const s = new Session();

  // a. wx.login code
  const d1 = await wcs("/wx/code", { openid, appid: APPID });
  const jscode = d1.code;
  if (!jscode) throw new Error("WCS 未返回 login code");

  // b. code2Session, 建立 PHPSESSID 会话
  const r2 = await s.call("appapi.php", "getweixinphone_code", { JSCODE: jscode, v: 100 }, "POST");
  if (!r2 || !r2.openid) throw new Error(`getweixinphone_code 失败: ${JSON.stringify(r2).slice(0, 150)}`);
  const wxOpenid = r2.openid, wxUnionid = r2.unionid || "";

  // c. 手机号(mpweixinphonelogin 必需)
  const d2 = await wcs("/wx/getphonenumber", { openid, appid: APPID });
  let tel = "";
  try { tel = JSON.parse(d2.raw.data).mobile || ""; } catch { }
  if (d2.code) {
    const r4 = await s.call("appapi.php", "getweixinphone_new", { code: d2.code }, "POST");
    if (r4 && r4.phone_info && r4.phone_info.phoneNumber) tel = r4.phone_info.phoneNumber;
    else if (!tel) throw new Error(`getweixinphone_new 失败: ${JSON.stringify(r4).slice(0, 150)}`);
  }
  if (!tel) throw new Error("未取得手机号");

  // d. 换 usertoken
  const r5 = await s.call("appapi.php", "mpweixinphonelogin", null, "GET", {
    skappwayphone: tel,
    skappwayopenid: wxOpenid,
    skappwayunionid: wxUnionid,
    skappwayfromuserid: "",
    skappwaygameid: "",
    skappwayfromcode: "",
  });
  if (!r5 || r5.status != 1 || !r5.usertoken) {
    throw new Error(`mpweixinphonelogin 失败: ${JSON.stringify(r5).slice(0, 200)}`);
  }
  const nick = (r5.userdata && r5.userdata.u_nickname) || "";
  console.log(`  ✅ 登录成功 昵称[${nick || "-"}] userid=${r5.userid} 手机=${maskTel(tel)}`);
  return { usertoken: r5.usertoken, userid: r5.userid, nickname: nick, tel, cookie: s.cookie, session: s };
}

// 用缓存的 usertoken 复活会话, 失败返回 null
async function reuse(openid, cache) {
  const c = cache[openid];
  if (!c || !c.usertoken) return null;
  const s = new Session();
  s.cookie = c.cookie || "";
  const r = await s.call("appapi.php", "getuserinfo", { usertoken: c.usertoken });
  if (r && r.status == 1 && r.data) {
    console.log(`  ♻️ 复用缓存登录态 昵称[${(r.data.u_nickname) || c.nickname || "-"}] userid=${c.userid || "-"}`);
    return { usertoken: c.usertoken, userid: c.userid, nickname: c.nickname, tel: c.tel, cookie: s.cookie, session: s };
  }
  console.log("  ⚠️ 缓存 token 已失效, 重新登录");
  return null;
}

// ============ 业务 ============
async function getTaskData(ctx) {
  const r = await ctx.session.call("user.php", "taskdata", { usertoken: ctx.usertoken });
  if (!r || r.status != 1 || !r.data) return null;
  return r.data;
}

async function doSign(ctx, td) {
  if (td && String(td.signed) === "1") {
    const lian = (td.signeddata && td.signeddata.lian) || "-";
    console.log(`  ℹ️ 今日已签到 (连续${lian}天)`);
    return { done: false, already: true, gain: 0, lian };
  }
  console.log("  🌐 请求签到...");
  const r = await ctx.session.call("appapi.php", "qiandao", { usertoken: ctx.usertoken });
  if (r && r.status == 1) {
    const gain = Number(r.value || 0);
    console.log(`  ✅ 签到成功: ${r.msg || "签到成功"}, +${gain}积分`);
    return { done: true, already: false, gain, msg: r.msg || "" };
  }
  const msg = (r && r.msg) || "未知错误";
  if (/已签到|已经签/.test(msg)) {
    console.log(`  ℹ️ 今日已签到 (${msg})`);
    return { done: false, already: true, gain: 0 };
  }
  console.log(`  ❌ 签到失败: ${msg}`);
  return { done: false, already: false, gain: 0, error: msg };
}

async function doShare(ctx, td) {
  const limit = Number((td && td.sharecount1) || 3) || 3;
  let done = Number((td && td.shareedcount1) || 0) || 0;
  if (done >= limit) {
    console.log(`  ℹ️ 今日分享任务已完成 (${done}/${limit})`);
    return { before: done, after: done, limit, newly: 0 };
  }
  console.log(`  🌐 分享任务 (${done}/${limit}), 需再分享 ${limit - done} 次...`);
  let newly = 0;
  for (let i = done; i < limit; i++) {
    const r = await ctx.session.call("appapi.php", "addshare", { usertoken: ctx.usertoken });
    if (r && r.status == 1) {
      newly++;
      console.log(`  ✅ 分享 ${i + 1}/${limit} 成功${r.value ? ", +" + r.value + "积分" : ""}`);
    } else {
      const msg = (r && r.msg) || "未知";
      if (/上限/.test(msg)) { console.log(`  ⚠️ ${msg}`); break; }
      console.log(`  ❌ 分享 ${i + 1}/${limit} 失败: ${msg}`);
      break;
    }
    if (i < limit - 1) {
      const w = jitter(2200, 700);
      console.log(`  ⏳ 等待 ${(w / 1000).toFixed(1)}s...`);
      await sleep(w);
    }
  }
  return { before: done, after: done + newly, limit, newly };
}

async function getIntegral(ctx) {
  const r = await ctx.session.call("appapi.php", "getmyintegral", { usertoken: ctx.usertoken });
  if (r && r.status == 1) return { total: r.total, money: r.money };
  return null;
}

// ============ 单账号流程 ============
async function runAccount(openid, cache, idx) {
  console.log(`\n========== 账号[${idx + 1}] ${mask(openid)} ==========`);
  try {
    let ctx = await reuse(openid, cache);
    if (!ctx) ctx = await login(openid);
    cache[openid] = {
      usertoken: ctx.usertoken, userid: ctx.userid, nickname: ctx.nickname,
      tel: ctx.tel, cookie: ctx.cookie, ts: Date.now(),
    };
    saveCache(cache);

    // 每日心跳(小程序启动时会调, 保持活跃度)
    try { await ctx.session.call("appapi.php", "everyday", { usertoken: ctx.usertoken }); } catch { }
    await sleep(jitter(1200, 400));

    let td = await getTaskData(ctx);
    if (!td) console.log("  ⚠️ 任务数据获取失败, 仍尝试执行");

    const sign = await doSign(ctx, td);
    await sleep(jitter(1800, 500));

    // 签到后刷新一次, 拿最新分享计数
    const td2 = await getTaskData(ctx);
    const share = await doShare(ctx, td2 || td);

    await sleep(jitter(1000, 300));
    const jf = await getIntegral(ctx);
    if (jf) console.log(`  💰 当前积分: ${jf.total}  余额: ¥${jf.money}`);

    const lian = (td2 && td2.signeddata && td2.signeddata.lian) || (sign.lian || "-");
    return {
      ok: true, nickname: ctx.nickname, sign, share, lian,
      integral: jf ? jf.total : "-",
    };
  } catch (e) {
    console.log(`  ❌ 失败: ${e.message}`);
    // 登录类错误清缓存, 下次重登
    if (/登录|token|usertoken|mpweixinphonelogin/i.test(e.message)) delete cache[openid];
    return { ok: false, error: e.message };
  }
}

// ============ 推送 ============
async function push(title, content) {
  if (!PUSH_TOKEN) return;
  try {
    await reqRetry("POST", "http://www.pushplus.plus/send",
      { "Content-Type": "application/json" },
      { token: PUSH_TOKEN, title, content, template: "txt" });
  } catch (e) { console.log("  ⚠️ 推送失败:", e.message); }
}

// ============ 入口 ============
async function main() {
  console.log("🔔 JOTOYS(集玩具),开始");
  console.log(`AppID: ${APPID}  WCS: ${WCS}`);
  if (!ACCOUNTS.length) { console.log("❌ 未配置 wx_opinion"); process.exit(1); }
  if (!WCS_AUTH) console.log("⚠️ 未配置 wx_auth, WCS 可能拒绝请求");
  console.log(`共 ${ACCOUNTS.length} 个账号`);

  const cache = loadCache();
  const lines = [];
  let okN = 0, failN = 0;

  for (let i = 0; i < ACCOUNTS.length; i++) {
    const r = await runAccount(ACCOUNTS[i], cache, i);
    const tag = r.nickname || mask(ACCOUNTS[i]);
    if (r.ok) {
      okN++;
      const s = r.sign.already ? "已签" : (r.sign.done ? `成功+${r.sign.gain}` : `失败(${r.sign.error || "?"})`);
      const sh = `${r.share.after}/${r.share.limit}${r.share.newly ? `(新做${r.share.newly})` : ""}`;
      lines.push(`✅ ${tag}: 签到${s} 连续${r.lian}天 | 分享${sh} | 积分${r.integral}`);
    } else {
      failN++;
      lines.push(`❌ ${tag}: ${r.error}`);
    }
    if (i < ACCOUNTS.length - 1) await sleep(jitter(3000, 900));
  }
  saveCache(cache);

  const summary = `成功 ${okN}, 失败 ${failN}\n` + lines.join("\n");
  console.log(`\n${summary}`);
  await push("JOTOYS集玩具", summary);
  console.log("\n🔔 JOTOYS(集玩具),结束");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
