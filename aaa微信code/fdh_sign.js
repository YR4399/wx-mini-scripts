// ========== 福东海 (有赞 Youzan) 自动签到 ==========
/**
 * 福东海 有赞小程序 每日签到
 * AppID:   wx6c440c5e4d7f02e3
 * 流程:    WCS 取 wx code -> 有赞 passport 登录换 sessionId -> 查询/执行签到 -> 查积分 -> std_report 推送(钉钉)
 * 环境变量:
 *   wx_server_url : WCS 地址 (默认 http://host.docker.internal:18788)
 *   wx_auth       : WCS auth (优先 /api/client/login 会话, 失败回退此值)
 *   wx_opinion    : 账号 openid, 多账号用 & 分隔
 *   NICK_MAP      : 可选, openid:昵称&openid:昵称 (面板惯用格式)
 *   推送           : 统一走 std_report 双引擎(钉钉 markdown)
 * cron: 30 8 * * *
 */
const fs = require("fs");
const path = require("path");

// 防御: 清掉容器内可能残留的死代理, 避免 axios/fetch 被路由到不可达代理
for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
  process.env[k] = "";
}

const APPID = "wx6c440c5e4d7f02e3";
const KDT_ID = 155212604;
const CHECKIN_ID = 7284594; // 动态 checkinId 兜底值
const WCS_URL = (process.env.wx_server_url || "http://host.docker.internal:18788").replace(/\/+$/, "");
const WCS_AUTH = process.env.wx_auth || "";
const WX_OPINION = process.env.wx_opinion || "";
const { report: stdReport, extractPoints } = require("./std_report");

// NICK_MAP 兼容: JSON {"openid":"昵称"} 或 面板惯用 openid:昵称&openid:昵称
const NICK_MAP = (() => {
  const raw = (process.env.NICK_MAP || "").trim();
  if (!raw) return {};
  if (raw.startsWith("{")) { try { return JSON.parse(raw); } catch (e) {} }
  const m = {};
  for (const p of raw.split("&")) {
    const i = p.indexOf(":");
    if (i > 0) m[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return m;
})();

const UIC_URL = "https://uic.youzan.com";
const API_BASE = "https://h5.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "fdh_token_cache.json");
const CACHE_TTL = 24 * 60 * 60 * 1000; // 令牌缓存 24h

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(msg, emoji = "ℹ️") { console.log(`  ${emoji} ${msg}`); }
function loadJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return def; } }
function saveJSON(p, o) { try { fs.writeFileSync(p, JSON.stringify(o, null, 2)); } catch (e) {} }
function rd(n) { return Math.floor(Math.random() * n); }
async function humanDelay(base = 800, jitter = 1200) { await sleep(base + rd(jitter)); }

// ===================== WCS =====================
async function getWcsAuth() {
  try {
    const res = await fetch(`${WCS_URL}/api/client/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "yr1314", password: "yr123123" }),
    });
    const j = await res.json().catch(() => ({}));
    if (j?.data?.auth) return j.data.auth;
  } catch (e) { /* 回退 */ }
  if (WCS_AUTH) return WCS_AUTH;
  throw new Error("WCS 登录失败且无 wx_auth 兜底");
}

async function getWxCode(openid, auth) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${WCS_URL}/wx/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", auth },
      body: JSON.stringify({ openid, appid: APPID }),
    });
    const j = await res.json().catch(() => ({}));
    const code =
      typeof j?.data?.code === "string" ? j.data.code :
      typeof j?.code === "string" ? j.code :
      typeof j?.data === "string" ? j.data : null;
    if (code) return code;
    const d = String(j?.data?.error || j?.message || JSON.stringify(j)).slice(0, 180);
    if (/account not found/i.test(d)) {
      throw new Error(`WCS 取 code 失败: ${d} (该微信在协议端掉线, 需重新扫码上线)`);
    }
    if (attempt < 3) {
      log(`WCS 取 code 瞬时故障(第${attempt}次): ${d.slice(0, 80)}`, "🔁");
      await sleep(2000 * attempt);
    } else {
      throw new Error(`WCS 取 code 失败: ${d}`);
    }
  }
}

// ===================== 有赞登录 / 接口 =====================
function readCache() { return loadJSON(TOKEN_CACHE_FILE, {}); }
function writeCache(openid, obj) { const c = readCache(); c[openid] = obj; saveJSON(TOKEN_CACHE_FILE, c); }

async function youzanLogin(openid, auth) {
  const code = await getWxCode(openid, auth);
  const resp = await fetch(`${UIC_URL}/passport/general/auth.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ appId: APPID, code, platformName: "weapp", signature: "Windows" }),
  });
  const data = await resp.json().catch(() => ({}));
  if (data?.code !== 0 || !data?.data?.sessionId) {
    throw new Error(`有赞登录失败: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const d = data.data;
  return { token: d.sessionId || "", userId: d.userId || 0, mobile: d.mobile || "" };
}

async function youzanGet(urlPath, params, token) {
  const q = new URLSearchParams({ app_id: APPID, kdt_id: String(KDT_ID), access_token: token, ...params });
  const resp = await fetch(`${API_BASE}${urlPath}?${q.toString()}`, {
    headers: { "Cookie": `KDTSESSIONID=${token}` },
  });
  return await resp.json().catch(() => ({}));
}

// 动态获取签到活动ID（活动ID可能轮换），失败回落到 CHECKIN_ID
async function resolveCheckinId(token) {
  const probes = [
    ["/wscump/checkin/show_checkin_page_v2.json", ["checkinId"]],
    ["/wscump/checkin/check-in-info.json", ["checkInId", "checkinId", "check_in_id"]],
  ];
  for (const [p, keys] of probes) {
    try {
      const j = await youzanGet(p, {}, token);
      const d = j?.data || {};
      for (const k of keys) {
        if (d[k]) { log(`动态 checkinId=${d[k]} (${p})`, "🔎"); return String(d[k]); }
      }
    } catch (e) { /* 试下一个 */ }
  }
  log(`动态取 checkinId 失败，回落到 ${CHECKIN_ID}`, "⚠️");
  return CHECKIN_ID;
}

// ===================== 单账号签到 =====================
async function signInOnce(openid, auth, idx) {
  const rawEntry = String(openid).trim();
  const _hp = rawEntry.split("#");
  const realOpenid = _hp[0].trim();
  const remark = (_hp[1] || "").trim();
  const nick = remark || NICK_MAP[realOpenid] || realOpenid.slice(0, 12) + "…";
  console.log(`\n=== [${nick}] 账号#${idx} 开始 ===`);
  const result = { nick, success: false };

  let info = null;
  const cached = readCache()[realOpenid];
  if (cached?.token && cached?.userId && (Date.now() - cached.ts) < CACHE_TTL) {
    info = cached;
    log("使用缓存登录", "🍪");
  } else {
    info = await youzanLogin(realOpenid, auth);
    writeCache(realOpenid, { token: info.token, userId: info.userId, mobile: info.mobile, ts: Date.now() });
    log(`登录成功 uid=${info.userId} ${info.mobile}`, "🔑");
  }
  const { token, userId } = info;

  // 动态获取签到活动ID
  const checkinId = await resolveCheckinId(token);

  // 查询签到状态
  const status = await youzanGet("/wscump/checkin/get_activity_by_yzuid_v2.json", { checkinId: String(checkinId) }, token);
  if (status?.continuesDay != null) result.streak = status.continuesDay;
  result.lottery = _digLottery(status) || "";
  if (status?.isCheckin) {
    log(`今日已签到 (连续 ${status.continuesDay} 天)`, "✅");
    result.success = true;
    result.alreadySigned = true;
  } else {
    const url = `${API_BASE}/wscump/checkin/checkinV2.json?app_id=${APPID}&kdt_id=${KDT_ID}&access_token=${token}&checkinId=${checkinId}&userId=${userId}`;
    const resp = await fetch(url, { headers: { "Cookie": `KDTSESSIONID=${token}` } });
    const r = await resp.json().catch(() => ({}));
    if (r?.code === 0 || r?.success) {
      log("签到成功: +10积分", "🎁");
      result.success = true;
    } else if (/已达最大参与|已签到|已签|already|limit/i.test(r?.msg || "")) {
      log("今日已签到", "✅");
      result.success = true;
      result.alreadySigned = true;
    } else {
      throw new Error(`签到失败: ${r?.msg || JSON.stringify(r).slice(0, 160)}`);
    }
  }

  // 查询积分
  try {
    const stats = await youzanGet("/wscuser/membercenter/stats.json", { currentKdtId: String(KDT_ID) }, token);
    const points = stats?.stats?.points;
    if (points != null) { log(`当前积分: ${points}`, "💰"); result.points = points; }
  } catch (e) {
    log(`查积分失败: ${e.message}`, "⚠️");
  }

  return result;
}

// ===================== 推送 =====================
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

// ===================== 主流程 =====================
async function main() {
  console.log("=== 福东海 (有赞) 自动签到 ===");
  const accounts = WX_OPINION.split("&").map((s) => s.trim()).filter(Boolean);
  if (!accounts.length) { console.log("[!] 未配置 wx_opinion, 跳过"); process.exit(1); }
  console.log(`共 ${accounts.length} 个账号\n`);

  const auth = await getWcsAuth();
  const results = [];
  let idx = 0;
  for (const openid of accounts) {
    idx++;
    try {
      await humanDelay(600, 1200);
      results.push(await signInOnce(openid, auth, idx));
    } catch (e) {
      results.push({ nick: (openid.split("#")[1] || "").trim() || NICK_MAP[openid] || openid.slice(0, 12), success: false, error: e.message });
    }
  }

  const ok = results.filter((r) => r.success).length;
  console.log(`\n=== 完成: 成功 ${ok}, 失败 ${results.length - ok} ===`);

  // ============= 标准推送 (std_report) =============
  const stdAccounts = results.map((r, i) => ({
    idx: i + 1,
    name: r.nick,
    sign: r.success ? (r.alreadySigned ? "今日已签到" : "签到成功") : `失败: ${r.error || ""}`,
    earned: (r.success && !r.alreadySigned) ? "今日+10积分" : "",
    total: r.points != null ? String(r.points) : "",
    streak: r.streak != null ? String(r.streak) : "",
    tasks: [],
    lottery: r.lottery || "",
  }));
  await stdReport("福东海签到", stdAccounts);
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
