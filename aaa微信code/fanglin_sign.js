/**
 * 方林会员 - 每日签到 + 积分查询
 * 抓包分析: SunnyNet (szextshort.weixin.qq.com HAR)
 * 框架: CRMEB (authori-zation 头 / api/front)
 * AppID: wx9fd5cf7e1f36206a
 * API: https://front-api.fanglin.vip/api/front
 * cron: 30 8 * * *
 *
 * 环境变量（统一）:
 *   wx_opinion    - OpenID，多账号用 & 分隔
 *   wx_server_url - WCS 服务地址
 *   wx_auth       - WCS 认证密钥
 *   PUSH_PLUS_TOKEN / PLUSPLUS_TOKEN - PushPlus 推送（可选）
 */

// 清除容器内常驻坏代理
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy']) delete process.env[k];

const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ==================== 常量 ====================
const wxOpinion = process.env.wx_opinion || "";
const wxServer  = process.env.wx_server_url || "http://host.docker.internal:18788";
const wxAuthEnv = process.env.wx_auth || "";
const APPID = "wx9fd5cf7e1f36206a";
const API_BASE = "https://front-api.fanglin.vip/api/front";
const CACHE_FILE = path.join(__dirname, "fanglin_token_cache.json");
const WCS_AUTH_CACHE = path.join(__dirname, "fanglin_wcs_auth.json");
const WCS_USER = "yr1314";
const WCS_PASS = "yr123123";

const WX_HEADERS = {
  "Accept": "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Content-Type": "application/json",
  "Referer": `https://servicewechat.com/${APPID}/61/page-frame.html`,
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

// ==================== 缓存 ====================
function loadJSON(f) { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) || {} : {}; } catch (e) { return {}; } }
function saveJSON(f, d) { try { fs.writeFileSync(f, JSON.stringify(d, null, 2), "utf8"); } catch (e) {} }

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
  } catch (e) { /* 回退到 wx_auth */ }
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

// ==================== 方林 API ====================
function hdrs(token) {
  const h = { ...WX_HEADERS };
  if (token) h["authori-zation"] = token;
  return h;
}

// CRMEB 小程序登录：code -> token（code 需同时放 URL query 与 body）
async function login(code) {
  try {
    const res = await axios.post(`${API_BASE}/wechat/authorize/program/login?code=${encodeURIComponent(code)}`,
      { code, spread_spid: 0, avatar: "", nickName: "微信用户", type: "routine" },
      { headers: hdrs(""), timeout: 15000, proxy: false });
    const d = res.data?.data || {};
    if (res.data?.code === 200 && d.token) return { token: d.token, uid: d.uid };
    if (d.key && !d.token) { L.warn("该账号未注册/需手机号绑定，无法自动完成（需手机验证码）"); return null; }
    L.fail(`登录失败: ${res.data?.message || JSON.stringify(res.data).slice(0, 120)}`);
    return null;
  } catch (e) { L.fail(`登录异常: ${e.message}`); return null; }
}

// 校验 token 是否有效并取用户信息
async function getUser(token) {
  try {
    const res = await axios.get(`${API_BASE}/user`, { headers: hdrs(token), timeout: 15000, proxy: false });
    if (res.data?.code === 200) return res.data.data;
    return null;
  } catch (e) {
    if (e.response?.status === 401) return null;
    return null;
  }
}

async function getSignConfig(token) {
  try {
    const res = await axios.get(`${API_BASE}/user/sign/config`, { headers: hdrs(token), timeout: 15000, proxy: false });
    if (res.data?.code === 200) return res.data.data || [];
  } catch (e) {}
  return [];
}

// 签到: POST /user/sign/user  body {all:0,integral:0,sign:1}
async function doSign(token) {
  try {
    const res = await axios.post(`${API_BASE}/user/sign/user`,
      { all: 0, integral: 0, sign: 1 },
      { headers: hdrs(token), timeout: 15000, proxy: false });
    return res.data; // {code, message, data:{signNum,sumSignDay,isDaySign,isYesterdaySign,integral}}
  } catch (e) {
    if (e.response?.data) return e.response.data;
    return { code: -1, message: e.message };
  }
}

// 判定本次签到是否真实生效：接口明确返回 isDaySign=true，或服务端明确提示已签
function isSigned(r) {
  if (r?.code === 200 && r.data && r.data.isDaySign === true) return true;
  if (r && /已签|重复|today|已经签到/i.test(r.message || "")) return true;
  return false;
}

// 节日奖励发放检查 (HAR 2026-08-03: GET /festival/checkAndGrant 无参数, data 非 null 表示有节日奖励发放)
async function checkFestival(token) {
  try {
    const res = await axios.get(`${API_BASE}/festival/checkAndGrant`, { headers: hdrs(token), timeout: 15000, proxy: false });
    if (res.data?.code === 200 && res.data.data) {
      L.ok(`🎉 节日奖励发放: ${JSON.stringify(res.data.data).slice(0, 80)}`);
      return true;
    }
    L.info("节日奖励: 今日无发放");
  } catch (e) {}
  return false;
}

// ==================== 单账号流程 ====================
async function processAccount(openid, idx) {
  console.log(`\n========== 账号[${idx}] ${openid.slice(0, 10)}... ==========`);
  const cache = loadJSON(CACHE_FILE);
  let token = cache[openid]?.token || null;

  // 1) 优先用缓存 token
  let user = null;
  if (token) {
    user = await getUser(token);
    if (user) L.info("使用缓存 token");
    else { token = null; L.info("缓存 token 失效，重新登录"); }
  }

  // 2) 需要登录
  if (!token) {
    const code = await getWxCode(openid);
    if (!code) { L.fail("获取 code 失败"); return { status: "error", msg: "无code" }; }
    const lo = await login(code);
    if (!lo) return { status: "error", msg: "登录失败/需绑定手机号" };
    token = lo.token;
    cache[openid] = { token, uid: lo.uid, ts: Date.now() };
    saveJSON(CACHE_FILE, cache);
    L.ok("登录成功");
    user = await getUser(token);
  }

  if (user) L.info(`用户: ${user.nickname || "-"} | 积分 ${user.integral} | 等级 ${user.vipName || user.level}`);

  // 3) 签到
  L.act("执行签到...");
  const integralBefore = user?.integral ?? null;
  let r = await doSign(token);
  let signed = isSigned(r);

  // 未生效（多为 token 半失效导致 sign 未登记）→ 强制刷新登录态重试一次
  if (!signed) {
    L.warn(`首次签到未生效 (${r?.message || "isDaySign=false"})，刷新登录态重试...`);
    const code = await getWxCode(openid);
    if (code) {
      const lo = await login(code);
      if (lo) {
        token = lo.token;
        cache[openid] = { token, uid: lo.uid, ts: Date.now() };
        saveJSON(CACHE_FILE, cache);
        L.ok("重新登录成功，重试签到");
        r = await doSign(token);
        signed = isSigned(r);
      }
    }
  }

  if (signed) {
    const d = r.data || {};
    const u2 = await getUser(token);
    const integralAfter = u2?.integral ?? integralBefore;
    if (integralBefore != null && integralAfter > integralBefore) {
      L.ok(`签到成功 | 连签 ${d.signNum} 天 | 累计 ${d.sumSignDay} 天 | +${integralAfter - integralBefore}分 (当前 ${integralAfter})`);
    } else {
      L.info(`今日已签到 | 连签 ${d.signNum} 天 | 当前积分 ${integralAfter ?? d.integral}`);
    }

    // ========== 节日奖励发放检查 (HAR 2026-08-03) ==========
    await checkFestival(token);
    await new Promise(r => setTimeout(r, 500));

    // ========== 分享奖励领取 (HAR 2026-08-01 抓包: sharePoster → getRemindListUser → remindRead 领积分) ==========
    try {
      L.act("执行分享 + 领取奖励...");
      // 1) 分享海报（触发奖励登记，每天一次）
      try {
        await axios.post(`${API_BASE}/remind/sharePoster`, {}, { headers: hdrs(token), timeout: 15000, proxy: false });
      } catch (e) {}
      await new Promise(r => setTimeout(r, 800));
      // 2) 查待领提醒列表
      const rl = await axios.get(`${API_BASE}/remind/getRemindListUser`, { headers: hdrs(token), timeout: 15000, proxy: false });
      const remindList = (rl.data?.code === 200 && Array.isArray(rl.data.data)) ? rl.data.data : [];
      const pending = remindList.filter(x => x.status == 0 || x.status === "0");
      if (pending.length === 0) {
        L.info("无待领提醒");
      } else {
        let totalGot = 0;
        for (const item of pending) {
          if (!item.id) continue;
          try {
            const rr = await axios.post(`${API_BASE}/remind/remindRead/${item.id}`, {}, { headers: hdrs(token), timeout: 15000, proxy: false });
            if (rr.data?.code === 200) {
              const pts = item.points || 0;
              totalGot += pts;
              L.ok(`领取提醒[${item.id}] ${item.remark || ""} +${pts}分`);
            } else {
              L.warn(`领取提醒[${item.id}] 失败: ${rr.data?.message || "?"}`);
            }
          } catch (e) {}
          await new Promise(r => setTimeout(r, 500));
        }
        if (totalGot > 0) {
          const u3 = await getUser(token);
          L.ok(`分享奖励共 +${totalGot}分 | 当前积分 ${u3?.integral ?? "?"}`);
        }
      }
    } catch (e) {
      L.warn(`分享奖励流程异常: ${e.message}`);
    }

    const uFinal = await getUser(token);
    return { status: "ok", integral: uFinal?.integral ?? integralAfter ?? d.integral, signNum: d.signNum };
  } else {
    const msg = r?.message || "签到未生效";
    L.fail(`签到失败: ${msg}（可能已签/时区未跨天，继续分享奖励）`);
    // 签到失败也继续分享奖励（分享每天独立可做）
    try {
      L.act("执行节日 + 分享 + 领取奖励...");
      await checkFestival(token);
      await new Promise(r => setTimeout(r, 500));
      try {
        await axios.post(`${API_BASE}/remind/sharePoster`, {}, { headers: hdrs(token), timeout: 15000, proxy: false });
      } catch (e) {}
      await new Promise(r => setTimeout(r, 800));
      const rl = await axios.get(`${API_BASE}/remind/getRemindListUser`, { headers: hdrs(token), timeout: 15000, proxy: false });
      const remindList = (rl.data?.code === 200 && Array.isArray(rl.data.data)) ? rl.data.data : [];
      const pending = remindList.filter(x => x.status == 0 || x.status === "0");
      if (pending.length === 0) {
        L.info("无待领提醒");
      } else {
        let totalGot = 0;
        for (const item of pending) {
          if (!item.id) continue;
          try {
            const rr = await axios.post(`${API_BASE}/remind/remindRead/${item.id}`, {}, { headers: hdrs(token), timeout: 15000, proxy: false });
            if (rr.data?.code === 200) {
              const pts = item.points || 0;
              totalGot += pts;
              L.ok(`领取提醒[${item.id}] ${item.remark || ""} +${pts}分`);
            } else {
              L.warn(`领取提醒[${item.id}] 失败: ${rr.data?.message || "?"}`);
            }
          } catch (e) {}
          await new Promise(r => setTimeout(r, 500));
        }
        if (totalGot > 0) {
          const u3 = await getUser(token);
          L.ok(`分享奖励共 +${totalGot}分 | 当前积分 ${u3?.integral ?? "?"}`);
        }
      }
    } catch (e) {
      L.warn(`分享奖励流程异常: ${e.message}`);
    }
    return { status: "ok", integral: null, signNum: null, msg: "签到未生效(可能已签)但分享已处理" };
  }
}

// ==================== 推送 ====================
async function sendPush(title, content) {
  const pk = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN || "";
  if (!pk) return;
  try { await axios.post("http://www.pushplus.plus/send", { token: pk, title, content }, { proxy: false }); } catch (e) {}
}

// ==================== 主入口 ====================
async function main() {
  console.log(`🔔 方林会员,开始`);
  const accounts = wxOpinion.split("&").filter(Boolean);
  if (accounts.length === 0) { L.fail("未配置 wx_opinion"); console.log(`🔔 方林会员,结束`); return; }
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
  await sendPush("方林会员签到",
    `共 ${accounts.length} 账号，成功 ${ok} 个\n` +
    results.map(r => `账号${r.i}: ${r.status === "ok" ? `✅ ${r.msg || ("积分" + (r.integral ?? "-"))}` : `❌ ${r.msg || "失败"}`}`).join("\n"));

  console.log(`\n📊 完成: ${ok}/${accounts.length} 账号`);
  console.log(`🔔 方林会员,结束`);
}

main().catch(e => { L.fail(`脚本异常: ${e.message}`); console.log(`🔔 方林会员,结束`); });
