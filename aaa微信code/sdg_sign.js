/**
 * 金至尊珠宝 - 每日签到 + 积分查询
 * 抓包分析: SunnyNet (szextshort.weixin.qq.com HAR)
 * AppID: wxc25c796e48c5fc52
 * API: https://membership.3dg-group.com/service
 * cron: 30 8 * * *
 *
 * 环境变量（统一）:
 *   wx_opinion    - OpenID，多账号用 & 分隔
 *   wx_server_url - WCS 服务地址
 *   wx_auth       - WCS 认证密钥
 *   推送: 已迁移至 std_report 双引擎 (钉钉机器人)
 */

// 清除容器内常驻坏代理
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy']) delete process.env[k];

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const qs = require("querystring");

// ==================== 常量 ====================
const wxOpinion = process.env.wx_opinion || "";
const wxServer  = process.env.wx_server_url || "http://host.docker.internal:18788";
const wxAuthEnv = process.env.wx_auth || "";
const APPID = "wxc25c796e48c5fc52";
const API_BASE = "https://membership.3dg-group.com/service";
const CACHE_FILE = path.join(__dirname, "sdg_token_cache.json");
const WCS_AUTH_CACHE = path.join(__dirname, "sdg_wcs_auth.json");
const WCS_USER = "yr1314";
const WCS_PASS = "yr123123";

const WX_HEADERS = {
  "Accept": "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "Referer": `https://servicewechat.com/${APPID}/103/page-frame.html`,
  "User-Agent": "Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36 XWEB/1500047 MMWEBSDK/20260502 MMWEBID/38 MicroMessenger/8.0.76.3141(0x28004C3A) WeChat/arm64 Weixin NetType/5G Language/zh_CN ABI/arm64 MiniProgramEnv/android",
  "xweb_xhr": "1",
};

// ==================== 日志 ====================
const L = {
  ok:   (m) => console.log(`  ✅ ${m}`),
  fail: (m) => console.log(`  ❌ ${m}`),
  info: (m) => console.log(`  ℹ️ ${m}`),
  warn: (m) => console.log(`  ⚠️ ${m}`),
  act:  (m) => console.log(`  🌐 ${m}`),
};

// ==================== 工具 ====================
function loadJSON(f) { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) || {} : {}; } catch (e) { return {}; } }
function saveJSON(f, d) { try { fs.writeFileSync(f, JSON.stringify(d, null, 2), "utf8"); } catch (e) {} }
function todayBeijing() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ==================== WCS 鉴权 ====================
async function getWcsAuth() {
  const cached = loadJSON(WCS_AUTH_CACHE);
  if (cached.auth && cached.expiresAt > Date.now()) return cached.auth;
  try {
    const res = await axios.post(`${wxServer}/api/client/login`, { username: WCS_USER, password: WCS_PASS }, { timeout: 15000, proxy: false });
    if (res.data?.status && res.data?.data?.auth) {
      const auth = res.data.data.auth;
      saveJSON(WCS_AUTH_CACHE, { auth, expiresAt: Date.now() + 3600000 });
      return auth;
    }
  } catch (e) { /* 回退 */ }
  if (wxAuthEnv) return wxAuthEnv;
  L.fail("WCS 登录失败且无 wx_auth 兜底");
  return null;
}

async function getWxCode(openid) {
  try {
    const auth = await getWcsAuth();
    if (!auth) return null;
    const res = await axios.post(`${wxServer}/wx/code`, { openid, appid: APPID },
      { headers: { auth }, timeout: 15000, proxy: false });
    if (res.data?.status) return res.data.data.code;
    L.fail(`WCS code 失败: ${JSON.stringify(res.data).slice(0, 120)}`);
    return null;
  } catch (e) { L.fail(`WCS 异常: ${e.message}`); return null; }
}

// ==================== 3DG API (form 表单) ====================
async function post(url, form) {
  const res = await axios.post(url, qs.stringify(form),
    { headers: WX_HEADERS, timeout: 15000, proxy: false });
  return res.data;
}

// 登录: code -> token
async function login(code) {
  try {
    const d = await post(`${API_BASE}/userlogin`, {
      code, refer_code: "", store_code: "", source: "", coupon: "",
      package: "", wcrefer: "", store: "", employee: "", eventId: "", accept: 0, token: "",
    });
    if (d && d.token) return d.token;
    L.fail(`登录失败: ${JSON.stringify(d).slice(0, 120)}`);
    return null;
  } catch (e) {
    const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 160) : e.message;
    if (e.response?.status === 500) L.warn(`该账号可能未注册/未绑定会员，登录被拒 (500): ${body}`);
    else L.fail(`登录异常: ${e.message}`);
    return null;
  }
}

async function getUserInfo(token) {
  try { return await post(`${API_BASE}/getUserinfo`, { token }); } catch (e) { return null; }
}

// 查询今日是否已签到（返回今日记录数组）
async function getUserSign(token) {
  try { return await post(`${API_BASE}/getusersign`, { token }); } catch (e) { return null; }
}

// 签到: sign_date=YYYY-MM-DD&token=xxx  -> "1"
async function saveUserSign(token) {
  try { return await post(`${API_BASE}/saveusersign`, { sign_date: todayBeijing(), token }); }
  catch (e) { return { err: e.message }; }
}

// ==================== 单账号流程 ====================
async function processAccount(openid, idx) {
  console.log(`\n========== 账号[${idx}] ${openid.slice(0, 10)}... ==========`);
  const cache = loadJSON(CACHE_FILE);
  let token = cache[openid]?.token || null;

  // 校验缓存 token（getUserinfo 有效则复用）
  let user = null;
  if (token) {
    user = await getUserInfo(token);
    if (user && user.id) L.info("使用缓存 token");
    else { token = null; L.info("缓存 token 失效，重新登录"); }
  }

  // 登录
  if (!token) {
    const code = await getWxCode(openid);
    if (!code) { L.fail("获取 code 失败"); return { status: "error", msg: "无code" }; }
    token = await login(code);
    if (!token) return { status: "error", msg: "登录失败" };
    cache[openid] = { token, ts: Date.now() };
    saveJSON(CACHE_FILE, cache);
    L.ok("登录成功");
    user = await getUserInfo(token);
  }

  if (user && user.id) {
    L.info(`会员: ${user.name || user.nick_name || "-"} | 会员号 ${user.vip_no || "-"} | 积分 ${user.total_score} | ${user.level_name || ""}`);
  }

  // 查询今日签到状态
  const today = todayBeijing();
  const signList = await getUserSign(token);
  const signedToday = Array.isArray(signList) && signList.some(s => s.sign_date === today && s.is_enabled === "1");
  if (signedToday) {
    L.info(`今日已签到 (${today})`);
    const u2 = await getUserInfo(token);
    return { status: "ok", msg: "已签到", integral: u2?.total_score };
  }

  // 执行签到
  L.act("执行签到...");
  const r = await saveUserSign(token);
  // 返回 "1"(数字或字符串) 视为成功
  if (r === 1 || r === "1" || (typeof r === "number" && r >= 1)) {
    const u2 = await getUserInfo(token);
    L.ok(`签到成功 (${today}) | 当前积分 ${u2?.total_score ?? "-"}`);
    return { status: "ok", integral: u2?.total_score };
  } else {
    // 再查一次确认是否其实已签
    const again = await getUserSign(token);
    if (Array.isArray(again) && again.some(s => s.sign_date === today)) {
      L.info(`今日已签到`);
      return { status: "ok", msg: "已签到" };
    }
    L.fail(`签到失败: ${JSON.stringify(r).slice(0, 120)}`);
    return { status: "error", msg: "签到失败" };
  }
}

// ==================== 推送 ====================


const { report: _stdReport } = require("./std_report");
let _rpRows = [];
let _rpApp = '金至尊珠宝会员签到';
function _rpGet(idx) {
  if (!_rpRows[idx]) _rpRows[idx] = { idx: idx, name: "", sign: "", earned: "", total: "", streak: "", tasks: [], lottery: "", taskEarned: "" };
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


// ==================== 主入口 ====================
async function main() {
  console.log(`🔔 金至尊珠宝,开始`);
  const accounts = wxOpinion.split("&").filter(Boolean);
  if (accounts.length === 0) { L.fail("未配置 wx_opinion"); console.log(`🔔 金至尊珠宝,结束`); return; }
  L.info(`共 ${accounts.length} 个账号`);

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    const openid = accounts[i].trim();
    if (!openid) continue;
    try {
      const r = await processAccount(openid, i + 1);
      results.push({ i: i + 1, ...r });
    } catch (e) {
      L.fail(`账号${i + 1}异常: ${e.message}`);
      results.push({ i: i + 1, status: "error", msg: e.message });
    }
    if (i < accounts.length - 1) { await new Promise(r => setTimeout(r, 3000)); }
  }

  const ok = results.filter(r => r.status === "ok").length;
  // 经 std_report 双引擎推送 (钉钉)，字段对齐谷雨模板
  for (const r of results) {
    const rp = _rpGet(r.i);
    if (r.status === "error") {
      rp.sign = "失败";
    } else if (r.msg === "已签到") {
      rp.sign = "今日已签到";
    } else {
      rp.sign = "签到成功";
    }
    if (r.integral != null) rp.total = String(r.integral);
    // 金至尊签到接口仅返回 "1" 成功标志，不返回今日获得积分/连签天数，诚实留空
    rp.earned = "";
    rp.streak = "";
    rp.taskEarned = "";
    rp.lottery = "";
  }
  await flushLogPoints("金至尊珠宝签到");

  console.log(`\n📊 完成: ${ok}/${accounts.length} 账号`);
  console.log(`🔔 金至尊珠宝,结束`);
}

main().catch(e => { L.fail(`脚本异常: ${e.message}`); console.log(`🔔 金至尊珠宝,结束`); });
