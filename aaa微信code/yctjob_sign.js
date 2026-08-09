/**
 * 衣城通招聘 (yctjob) 招工小程序 —— 签到 + 做任务脚本
 * AppID: wxc4eaf0fd0c97862f
 * API:   https://api.yctjob.com
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 【逆向结论 2026-08-09 · wxapkg(_sub_login_)+HAR 双重确认】
 *  1) 接口【无需签名】(无 signature/timestamp/nonce)。只需
 *     Authorization: Bearer <JWT> + Referer(page-frame)。
 *  2) 登录两种官方途径(均返回 JWT, HS512, payload.login_user_key):
 *     A. 微信一键登录 /client/web/wechatLogin:
 *        {openId, unionId, sessionKey, encryptedData, iv,
 *         pcSn, sourceType, shareId, userUuid, registerType}
 *        —— sessionKey 即 WCS /wx/encryptkey 返回的 encrypt_key(服务端用它解密 encryptedData)。
 *           ⚠️ WCS 需对该 appid 建立有效 js-login 会话, 否则 encryptkey 报
 *              "js-login failed: businessRet=..."(会话失效, 需在 smallcat-client 重扫微信账号恢复)。
 *     B. 手机号登录 /client/web/phoneLogin:
 *        {registerType:1, sourceType:0, shareId:null, userUuid:null, mobile, code}
 *        —— 前置 /client/web/common/sendVerifyCode {mobile}。本脚本作为 WCS 不可用时的兜底。
 *  3) 签到:
 *     GET  /client/user/signHome -> data.{integral,amount,configs:[{id,logId,dayNum,integral,signStatus,signDate}]}
 *     取 signDate==今天 且 signStatus==0 的档位; 已签(signStatus==1)跳过。
 *     POST /client/user/sign {logId} -> data:"签到成功！..."(字符串)
 *  4) 任务:
 *     GET  /client/user/taskHome -> data.{integral,amount,todayTask[],experienceTask[]}
 *     每个任务 {id, name, functionType, integral, num, completeCount, second}
 *     POST /client/user/taskSub {configId:id} -> {code:200,data:1}; functionType=8(邀请工友)跳过
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 【环境变量 · 全部走项目统一约定】
 *  wx_opinion        : ★账号来源(WCS openid, & 分隔)
 *  wx_server_url     : WCS 地址
 *  wx_auth           : WCS 认证 key
 *  YCTJOB_UNIONIDS   : 可选, 微信一键登录用的 unionId(& 分隔, 按位置对应 wx_opinion)
 *  YCTJOB_MOBILES    : 可选, 手机号登录的手机号(& 分隔, 对应 wx_opinion)
 *  YCTJOB_SMS_CODES  : 可选, 对应手机号的短信验证码(& 分隔) —— 仅首次登录用, 之后 token 缓存复用
 *  YCTJOB_TOKENS     : 可选, 直接注入有效 JWT(& 分隔, 跳过登录)
 *  YCTJOB_SKIP_SIGN  : 可选, 这些 openid(末4位或完整)仅做任务不签到
 *  PUSH_PLUS_TOKEN   : PushPlus 推送
 *
 * 登录优先级(每账号): YCTJOB_TOKENS[i] > (MOBILES[i]+SMS_CODES[i] 短信) > WCS 微信一键登录
 * cron: 38 8,18 * * *
 */

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");

// ============ 配置 ============
const APPID = "wxc4eaf0fd0c97862f";
const API = "https://api.yctjob.com";
const REFERER = `https://servicewechat.com/${APPID}/138/page-frame.html`;
const UA = "Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36 XWEB/1500047 MMWEBSDK/20260502 MMWEBID/38 MicroMessenger/8.0.76.3141(0x28004C3C) WeChat/arm64 Weixin NetType/5G Language/zh_CN ABI/arm64 MiniProgramEnv/android";

const WCS = process.env.wx_server_url || "http://host.docker.internal:18788";
const WCS_AUTH = process.env.wx_auth || "";
const ACCOUNTS = (process.env.wx_opinion || "").split(/[&\n]/).map(s => s.trim()).filter(Boolean);

const UNIONIDS = (process.env.YCTJOB_UNIONIDS || "").split(/[&\n]/).map(s => s.trim());
const MOBILES  = (process.env.YCTJOB_MOBILES  || "").split(/[&\n]/).map(s => s.trim());
const SMSCODES = (process.env.YCTJOB_SMS_CODES || "").split(/[&\n]/).map(s => s.trim());
const TOKENS   = (process.env.YCTJOB_TOKENS   || "").split(/[&\n]/).map(s => s.trim());
const SKIP_SIGN = new Set((process.env.YCTJOB_SKIP_SIGN || "").split(/[&\n]/).map(s => s.trim()).filter(Boolean));
const PUSH_TOKEN = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN || "";
const CACHE_FILE = "yctjob_token_cache.json";

// ============ 工具 ============
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cnDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); } catch {}
}

function req(method, url, headers, body, retries = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const data = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    const h = { ...headers };
    if (data) h["Content-Length"] = Buffer.byteLength(data);
    const r = mod.request(u, { method, headers: h, timeout: 20000 }, resp => {
      let c = ""; resp.on("data", d => c += d); resp.on("end", () => {
        let json; try { json = JSON.parse(c); } catch { json = c; }
        resolve({ status: resp.statusCode, data: json });
      });
    });
    r.on("timeout", () => r.destroy(new Error("请求超时(20s)")));
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
async function reqRetry(method, url, headers, body, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await req(method, url, headers, body); }
    catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

// WCS 请求 (smallcat-client 标准返回 {status, message, data}, 统一解包一层)
async function wcs(path, body) {
  const r = await reqRetry("POST", `${WCS}${path}`,
    { "Content-Type": "application/json", auth: WCS_AUTH }, body);
  const j = r.data;
  if (j && typeof j === "object" && "data" in j) return { ok: j.status !== false, data: j.data, raw: j };
  return { ok: true, data: j, raw: j };
}
// yctjob 业务请求
async function api(method, path, token, body) {
  const headers = { "Content-Type": "application/json", "Referer": REFERER, "User-Agent": UA };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return reqRetry(method, `${API}${path}`, headers, body);
}

// ============ 登录 ============

// 用 encrypt_key 本地解密 getuserinfo.encryptedData, 提取 unionId
function extractUnionId(encryptedData, iv, encryptKey) {
  try {
    const d = crypto.createDecipheriv("aes-128-cbc", Buffer.from(encryptKey, "base64"), Buffer.from(iv, "base64"));
    let out = Buffer.concat([d.update(Buffer.from(encryptedData, "base64")), d.final()]);
    let obj; try { obj = JSON.parse(out.toString("utf8").trim()); } catch { obj = JSON.parse(out.toString("utf8").trim().replace(/^"|"$/g, "")); }
    if (obj && obj.unionId) return obj.unionId;
    if (obj && obj.openId) return obj.openId;
  } catch {}
  return null;
}

function extractToken(resp) {
  const d = resp.data;
  let t = null;
  if (typeof d === "string") t = d;
  else if (d && d.token) t = d.token;
  else if (d && d.data && typeof d.data === "string") t = d.data;
  else if (d && d.data && d.data.token) t = d.data.token;
  else if (d && d.login_user_key) t = d.login_user_key;
  if (!t || !String(t).includes(".")) throw new Error("未拿到 JWT: " + JSON.stringify(resp).slice(0, 200));
  return t;
}

// A. WCS 微信一键登录
async function wcsLogin(openid, idx) {
  console.log(`  🔐 WCS 微信登录 (openid ${openid.slice(0, 12)}...)`);
  // 1) 建立 js-login 会话
  try { await wcs("/wx/code", { openid, appid: APPID }); }
  catch (e) { console.log(`  ⚠️ /wx/code: ${e.message}`); }

  // 2) encrypt_key (当 sessionKey 用)
  const ekR = await wcs("/wx/encryptkey", { openid, appid: APPID });
  if (!ekR.data || !ekR.data.encrypt_key) {
    const raw = JSON.stringify(ekR.raw || ekR.data).slice(0, 220);
    const expired = /js-login|businessRet|session|expired|失效|过期/.test(raw);
    const msg = expired
      ? `WCS js-login 会话失效(${raw}) → 请在 smallcat-client 重扫该微信账号恢复 wxc4eaf0fd0c97862f 的会话`
      : `WCS encryptkey 失败: ${raw}`;
    throw new Error(msg);
  }
  const encryptKey = ekR.data.encrypt_key;

  // 3) unionId: 优先环境变量, 其次 getuserinfo
  let unionId = UNIONIDS[idx] || "";
  if (!unionId) {
    try {
      const guR = await wcs("/wx/getuserinfo", { openid, appid: APPID });
      const gu = guR.data || {};
      if (gu.encryptedData && gu.iv) unionId = extractUnionId(gu.encryptedData, gu.iv, encryptKey) || "";
    } catch (e) { console.log(`  ⚠️ getuserinfo: ${e.message}`); }
  }
  if (!unionId) unionId = openid;
  console.log(`  🪪 unionId: ${unionId.slice(0, 12)}...`);

  // 4) 自造 16 字节 iv (WCS encryptkey 返回的 iv 常非 16 字节, 故自造)
  const ivBuf = crypto.randomBytes(16);
  const iv = ivBuf.toString("base64");

  // 5) 自造老格式明文 -> AES 加密 (服务端用 encryptKey 作为 sessionKey 解密)
  const now = Math.floor(Date.now() / 1000);
  const plaintext = JSON.stringify({
    openId: openid, unionId, nickName: "微信用户", gender: 0,
    language: "zh_CN", city: "", province: "", country: "", avatarUrl: "",
    watermark: { appid: APPID, timestamp: now },
  });
  const K = Buffer.from(encryptKey, "base64");
  const cipher = crypto.createCipheriv("aes-128-cbc", K, ivBuf);
  const crafted = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]).toString("base64");

  // 6) 真实 wechatLogin 载荷(from wxapkg _sub_login_ 逆向)
  const payload = {
    openId: openid, unionId, sessionKey: encryptKey,
    encryptedData: crafted, iv,
    pcSn: null, sourceType: 0, shareId: null, userUuid: null,
    registerType: 1,
  };
  const r = await api("POST", "/client/web/wechatLogin", null, payload);
  if (r.data && r.data.code === 200) return extractToken(r);
  // 500 通常因为本脚本无法提供 getPhoneNumber(真实手机号)的加密数据 —— WCS 拿不到用户手机号
  const is500 = r.data && r.data.code === 500;
  const hint = is500
    ? "wechatLogin 500: 该接口需 getPhoneNumber(真实手机号)加密数据, WCS 无法提供 → 请改用短信登录(YCTJOB_MOBILES+YCTJOB_SMS_CODES)或注入 YCTJOB_TOKENS"
    : "wechatLogin 失败: " + JSON.stringify(r.data).slice(0, 200);
  throw new Error(hint);
}

// B. 手机号短信登录(兜底)
async function smsLogin(mobile, code) {
  console.log(`  📱 短信登录 (${mobile.slice(0, 3)}****${mobile.slice(7)})`);
  const s = await api("POST", "/client/web/common/sendVerifyCode", null, { mobile });
  if (!(s.data && s.data.code === 200)) console.log(`  ⚠️ 发送验证码: ${JSON.stringify(s.data).slice(0,120)}`);
  await sleep(1500);
  const r = await api("POST", "/client/web/phoneLogin", null,
    { registerType: 1, sourceType: 0, shareId: null, userUuid: null, mobile, code });
  if (r.data && r.data.code === 200) return extractToken(r);
  throw new Error("phoneLogin 失败: " + JSON.stringify(r.data).slice(0, 220));
}

async function login(openid, idx, cached) {
  // 1) 直接注入 token
  if (TOKENS[idx]) { console.log(`  🔑 使用 YCTJOB_TOKENS[${idx}]`); return TOKENS[idx]; }
  // 2) 缓存
  if (cached) { console.log(`  🔑 使用缓存 token`); return cached; }
  // 3) 优先尝试 WCS 微信一键登录(按需求), 失败且有短信凭据时自动兜底短信登录
  try {
    return await wcsLogin(openid, idx);
  } catch (e) {
    if (MOBILES[idx] && SMSCODES[idx]) {
      console.log(`  ↪️ WCS 登录失败, 转短信登录: ${e.message.slice(0, 80)}`);
      return await smsLogin(MOBILES[idx], SMSCODES[idx]);
    }
    throw e;
  }
}

// ============ 签到 ============
async function doSign(token) {
  const home = await api("GET", "/client/user/signHome", token);
  if (!home.data || home.data.code !== 200) throw new Error("signHome: " + JSON.stringify(home.data).slice(0, 120));
  const d = home.data.data || {};
  const integral = d.integral, amount = d.amount;
  const configs = d.configs || [];
  const today = cnDate();
  const cfg = configs.find(c => c.signDate === today);
  if (!cfg) { console.log(`  ℹ️ 今天(${today})无签到档位`); return { signed: false, integral, amount, reason: "no-config" }; }
  if (cfg.signStatus === 1) { console.log(`  ✅ 今天已签到, 积分 ${integral} / ¥${amount}`); return { signed: false, integral, amount, reason: "already" }; }

  console.log(`  📅 签到 (logId=${cfg.logId}, +${cfg.integral}积分${cfg.amount ? "，奖" + cfg.amount + "元" : ""})`);
  const r = await api("POST", "/client/user/sign", token, { logId: cfg.logId });
  const ok = r.data && r.data.code === 200;
  const msg = (r.data && (r.data.msg || (typeof r.data.data === "string" ? r.data.data : ""))) || "";
  if (!ok) {
    console.log(`  ❌ 签到失败: ${JSON.stringify(r.data).slice(0,160)}`);
    return { signed: false, integral, amount, reason: "fail:" + msg };
  }
  // 防假阳性: 复查确认 signStatus==1
  await sleep(1200);
  const re = await api("GET", "/client/user/signHome", token);
  const reCfg = ((re.data && re.data.data && re.data.data.configs) || []).find(c => c.signDate === today);
  const verified = reCfg && reCfg.signStatus === 1;
  console.log(`  ${verified ? "✅" : "⚠️"} 签到结果: ${msg || "成功"}${verified ? " (已复查确认)" : " (复查未确认)"}`);
  const afterHome = re.data && re.data.data ? re.data.data : d;
  return { signed: true, integral: afterHome.integral, amount: afterHome.amount, reason: "ok", verified };
}

// ============ 做任务 ============
async function doTasks(token) {
  const home = await api("GET", "/client/user/taskHome", token);
  if (!home.data || home.data.code !== 200) throw new Error("taskHome: " + JSON.stringify(home.data).slice(0, 120));
  const d = home.data.data || {};
  const today = d.todayTask || [];
  const exp = d.experienceTask || [];
  const all = [...today, ...exp];
  let done = 0, skip = 0, fail = 0;
  for (const t of all) {
    if (t.functionType === 8) { console.log(`  ⏭️ 跳过[${t.name}] (邀请工友, 需真实邀请)`); skip++; continue; }
    // 部分任务需浏览N秒(second字段); 纯 API 提交即可计入, 这里加短延时拟人
    const left = (t.num || 1) - (t.completeCount || 0);
    if (left <= 0) { console.log(`  ✔️ [${t.name}] 已完成`); skip++; continue; }
    const times = Math.min(left, 10);
    console.log(`  🎯 [${t.name}] 提交 ${times}/${left} 次 (+${t.integral}积/次, 需浏览${t.second || 0}s)`);
    let okN = 0;
    for (let k = 0; k < times; k++) {
      const r = await api("POST", "/client/user/taskSub", token, { configId: t.id });
      if (r.data && r.data.code === 200) okN++;
      else if (/频繁|频繁/.test(r.data?.msg || "")) { await sleep(3000); }
      else { console.log(`    ❌ ${r.data?.msg}`); break; }
      await sleep(800);
    }
    if (okN > 0) { console.log(`    ✅ 成功 ${okN} 次`); done += okN; }
    else fail++;
  }
  return { done, skip, fail, total: all.length, integral: d.integral, amount: d.amount };
}

// ============ 单账号主流程 ============
async function runAccount(openid, cache, idx) {
  console.log(`\n========== 账号[${openid.slice(0, 12)}] ==========`);
  let token;
  try { token = await login(openid, idx, cache[openid]); }
  catch (e) {
    console.log(`  ❌ 登录失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
  cache[openid] = token; saveCache(cache);

  const skipSign = SKIP_SIGN.has(openid) || SKIP_SIGN.has(openid.slice(-4));
  let sign = null, tasks = null;
  try {
    if (skipSign) console.log("  ⏭️ 本账号配置为仅做任务(跳过签到)");
    else sign = await doSign(token);
    tasks = await doTasks(token);
    return { ok: true, sign, tasks };
  } catch (e) {
    if (/401|认证|登录|token/i.test(e.message)) { delete cache[openid]; saveCache(cache); }
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
  console.log("=== 衣城通招聘(yctjob) 签到+任务 ===");
  console.log(`AppID: ${APPID}  WCS: ${WCS}`);
  if (!ACCOUNTS.length) { console.log("❌ 未配置 wx_opinion"); process.exit(1); }
  console.log(`共 ${ACCOUNTS.length} 个账号\n`);

  const cache = loadCache();
  let okN = 0, failN = 0;
  const lines = [];
  for (let i = 0; i < ACCOUNTS.length; i++) {
    const a = ACCOUNTS[i];
    const r = await runAccount(a, cache, i);
    if (r.ok) {
      okN++;
      const s = r.sign || {};
      const t = r.tasks || {};
      const signStr = r.sign
        ? (s.signed ? `成功(${s.verified ? "已确认" : "未确认"})` : (s.reason === "already" ? "已签" : (s.reason === "no-config" ? "无档" : (String(s.reason).startsWith("fail") ? "失败" : "?"))))
        : "仅任务";
      const taskStr = t.total ? `任务完成${t.done || 0}/${t.total}` : "无任务";
      lines.push(`✅ ${a.slice(0, 12)}: 签到${signStr} 积分${s.integral ?? t.integral ?? "-"}/¥${s.amount ?? t.amount ?? "-"} | ${taskStr}`);
    } else {
      failN++;
      lines.push(`❌ ${a.slice(0, 12)}: ${r.error}`);
    }
    await sleep(2000);
  }
  const summary = `完成: 成功 ${okN}, 失败 ${failN}\n` + lines.join("\n");
  console.log(`\n=== ${summary} ===`);
  await push("衣城通签到", summary);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
