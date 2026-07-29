/**
 * shanti尊享 - 每日签到3次 + 积分兑换（游戏闯关功能默认关闭）
 * 抓包分析: SunnyNet
 * AppID: wxc59eee06736849e8
 * API: https://net.todaypayforyou.fun/YSKJ/api
 * 
 * 环境变量（统一）:
 *   wx_opinion    - OpenID，多账号用 & 分隔
 *   wx_server_url - WCS 服务地址
 *   wx_auth       - WCS 认证密钥
 */

// 清除容器内常驻坏代理(HTTPS_PROXY=172.23.224.1:7890 不可达; 部分 axios 调用 proxy:false 位置写错在第4参数无效, 靠清环境变量兜底)
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy']) delete process.env[k];

const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ==================== 常量 ====================
const wxOpinion = process.env.wx_opinion || "";
const wxServer = process.env.wx_server_url || "http://host.docker.internal:18788";
const APPID = "wxc59eee06736849e8";
const API_BASE = "https://net.todaypayforyou.fun/YSKJ/api";
const INVITE_CODE = "CBCAFE33";
const MAX_LEVELS_PER_DAY = 10; // 每日最多闯关数（游戏无限关，防止死循环）
const ENABLE_GAME = process.env.SHANTI_GAME_ENABLE === "1"; // 游戏闯关功能开关，默认关闭
const CACHE_FILE = path.join(__dirname, "shanti_token_cache.json");
const WCS_AUTH_CACHE = path.join(__dirname, "shanti_wcs_auth.json");

// 微信小程序请求头
const WX_HEADERS = {
  "Accept": "*/*",
  "Accept-Encoding": "gzip, deflate, br",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Content-Type": "application/json",
  "Referer": `https://servicewechat.com/${APPID}/3/page-frame.html`,
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "cross-site",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541a35) XWEB/19977",
  "xweb_xhr": "1"
};
const WCS_USER = "yr1314";
const WCS_PASS = "yr123123";

// ==================== 日志 ====================
const log = (m) => console.log(m);
const L = {
  ok: (m) => console.log(`  ✅ ${m}`),
  fail: (m) => console.log(`  ❌ ${m}`),
  info: (m) => console.log(`  ℹ️ ${m}`),
  warn: (m) => console.log(`  ⚠️ ${m}`),
  act: (m) => console.log(`  🌐 ${m}`),
};

// ==================== 缓存 ====================
function loadJSON(f) {
  try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f,"utf8"))||{} : {}; } catch(e) { return {}; }
}
function saveJSON(f, d) {
  try { fs.writeFileSync(f, JSON.stringify(d,null,2), "utf8"); } catch(e) {}
}

// ==================== WCS 鉴权 ====================
async function getWcsAuth() {
  const cached = loadJSON(WCS_AUTH_CACHE);
  if (cached.auth && cached.expiresAt > Date.now()) return cached.auth;
  try {
    const res = await axios.post(`${wxServer}/api/client/login`, { username: WCS_USER, password: WCS_PASS }, { timeout: 15000 }, { proxy: false });
    if (res.data?.status && res.data?.data?.auth) {
      const auth = res.data.data.auth;
      saveJSON(WCS_AUTH_CACHE, { auth, expiresAt: Date.now() + 3600000 });
      return auth;
    }
    L.fail(`WCS 登录失败`);
    return null;
  } catch(e) { L.fail(`WCS 登录异常: ${e.message}`); return null; }
}

async function getWxCode(openid) {
  try {
    const auth = await getWcsAuth();
    if (!auth) return null;
    const res = await axios.post(`${wxServer}/wx/code`, { openid, appid: APPID },
      { headers: { auth }, timeout: 15000 }, { proxy: false });
    if (res.data?.status) return res.data.data.code;
    L.fail(`WCS code 失败: ${JSON.stringify(res.data).slice(0,100)}`);
    return null;
  } catch(e) { L.fail(`WCS 异常: ${e.message}`); return null; }
}

// ==================== shanti 尊享 API ====================
function hdrs(token) {
  const h = { ...WX_HEADERS };
  if (token) h["X-Token"] = token;
  return h;
}

async function login(openid, code) {
  try {
    const device_id = `dev_${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
    // 登录时带上邀请码，新号自动绑定
    const res = await axios.post(`${API_BASE}/user/login_wx`,
      { code, device_id, invite_code: INVITE_CODE, nickname: "", avatar: "" },
      { headers: hdrs(""), timeout: 15000 });
    if (res.data?.code === 200) return res.data.data;
    L.fail(`登录失败: ${res.data?.msg || "未知"}`);
    return null;
  } catch(e) {
    if (e.response?.status === 401) L.fail(`token 失效`);
    else L.fail(`登录异常: ${e.message}`);
    return null;
  }
}

async function getUserInfo(token) {
  try {
    const res = await axios.get(`${API_BASE}/mining/realtime`, { proxy: false, headers: hdrs(token), timeout: 15000 });
    if (res.data?.code === 200) return res.data.data;
    return null;
  } catch(e) { return null; }
}

async function getSignStatus(token) {
  try {
    const res = await axios.get(`${API_BASE}/sign/status`, { proxy: false, headers: hdrs(token), timeout: 15000 });
    if (res.data?.code === 200) return res.data.data;
    return null;
  } catch(e) { L.fail(`签到状态异常: ${e.message}`); return null; }
}

async function doCheckin(token) {
  try {
    const res = await axios.post(`${API_BASE}/sign/checkin`, {}, { proxy: false, headers: hdrs(token), timeout: 15000 });
    if (res.data?.code === 200) return res.data.data;
    return null;
  } catch(e) { return null; }
}

async function exchangePoints(token) {
  try {
    const res = await axios.post(`${API_BASE}/points/exchange`, {}, { proxy: false, headers: hdrs(token), timeout: 15000 });
    if (res.data?.code === 200) return res.data.data;
    return null;
  } catch(e) { return null; }
}

async function getGameProgress(token) {
  try {
    const res = await axios.get(`${API_BASE}/game/progress`, { proxy: false, headers: hdrs(token), timeout: 15000 });
    if (res.data?.code === 200) return res.data.data;
    return null;
  } catch(e) { return null; }
}

async function completeLevel(token, levelId, stars) {
  try {
    const res = await axios.post(`${API_BASE}/game/level/complete`,
      { level_id: levelId, stars },
      { headers: hdrs(token), timeout: 15000 });
    if (res.data?.code === 200) return res.data.data;
    return null;
  } catch(e) { return null; }
}

// ==================== 账号处理 ====================
const SESSION_NAMES = {
  morning: { label: "早签", time: "06:00-11:59" },
  noon: { label: "午签", time: "12:00-17:59" },
  evening: { label: "晚签", time: "18:00-23:59" },
};

async function processAccount(openid, index) {
  console.log(`\n========== 账号[${index}] ==========`);
  console.log(`🔔 shanti尊享,开始`);

  // 1. 获取 code
  L.act(`获取微信 code...`);
  const code = await getWxCode(openid);
  if (!code) { L.fail(`获取 code 失败`); console.log(`🔔 shanti尊享,结束`); return; }

  // 2. 登录（含邀请码绑定）
  L.act(`登录 shanti尊享...`);
  const loginData = await login(openid, code);
  if (!loginData?.token) { L.fail(`登录失败`); console.log(`🔔 shanti尊享,结束`); return; }
  const token = loginData.token;
  L.ok(`登录成功`);
  L.info(`用户: ${loginData.nickname || "未知"} | ID: ${loginData.user_id}`);
  if (loginData.is_new) L.info(`新用户注册，已绑定邀请码 ${INVITE_CODE}`);

  // 缓存 token
  const cache = loadJSON(CACHE_FILE);
  cache[openid] = { token, userId: loginData.user_id, nickname: loginData.nickname };
  saveJSON(CACHE_FILE, cache);

  // 3. 获取用户信息
  const ui = await getUserInfo(token);
  if (ui) {
    L.info(`积分: ${ui.points || 0} | 算力: ${ui.hashrate || 0} | 币: ${ui.coin_balance || 0}`);
  }

  // 4. 签到（最多3次，根据当前时段）
  L.act(`检查签到状态...`);
  const signStatus = await getSignStatus(token);
  let totalEarned = 0;
  if (!signStatus) {
    L.fail(`获取签到状态失败`);
  } else {
    L.info(`当前已签到: ${signStatus.today_sign_count}/3 次`);
    const sessions = signStatus.sessions || {};
    for (const [key, sess] of Object.entries(sessions)) {
      const info = SESSION_NAMES[key] || { label: key, time: "?" };
      if (sess.active && !sess.signed) {
        L.act(`执行${info.label}(${info.time})...`);
        // 晚签需要模拟看广告（抓包确认: 小程序内播放约40秒广告后调签到）
        if (key === "evening") {
          L.info(`晚签需要看广告，等待 40 秒模拟广告播放...`);
          await new Promise(r => setTimeout(r, 40000));
        }
        const checkinResult = await doCheckin(token);
        if (checkinResult) {
          const earned = checkinResult.points_earned || 0;
          totalEarned += earned;
          L.ok(`${info.label}成功! +${earned}积分`);
        } else {
          L.fail(`${info.label}失败`);
        }
        await new Promise(r => setTimeout(r, 1000));
      } else if (sess.signed) {
        L.info(`${info.label}(${info.time}) ✅ 已签到`);
      } else {
        L.info(`${info.label}(${info.time}) ⏳ 未到时间`);
      }
    }
  }

  // 5. 积分兑换（签到后重新获取积分）
  const uiAfter = await getUserInfo(token);
  const afterPoints = uiAfter?.points || 0;
  if (afterPoints >= 100) {
    L.act(`积分兑换算力 (${afterPoints}积分)...`);
    const exchangeResult = await exchangePoints(token);
    if (exchangeResult) {
      L.ok(`兑换成功! 消耗100积分, 算力+${exchangeResult.hashrate_gained || 1}`);
    } else {
      L.warn(`兑换失败（可能已达上限）`);
    }
  } else {
    L.info(`积分不足100 (当前${afterPoints})，跳过兑换`);
  }

  // 6. 游戏闯关（默认关闭，设置 SHANTI_GAME_ENABLE=1 可开启；避免无限制调用 game/level/complete）
  if (!ENABLE_GAME) {
    L.info(`闯关功能已关闭（如需开启请设置环境变量 SHANTI_GAME_ENABLE=1）`);
  } else {
    L.act(`检查游戏进度...`);
    let gameProgress = await getGameProgress(token);
    if (gameProgress) {
      let maxUnlocked = gameProgress.max_unlocked || 0;
      L.info(`已解锁 ${maxUnlocked} 关 | 总星数: ${gameProgress.total_stars || 0}`);
    
      // 从最高已解锁关+1开始，避免重复遍历已完成关卡
      let level = maxUnlocked + 1;
      let cleared = 0;
      while (cleared < MAX_LEVELS_PER_DAY) {
        L.act(`闯关第 ${level} 关...`);
        const result = await completeLevel(token, level, 3);
        if (result) {
          cleared++;
          L.ok(`第${level}关通关!`);
          // 通关后重新拉取下进度
          const newProgress = await getGameProgress(token);
          if (newProgress && newProgress.max_unlocked > maxUnlocked) {
            maxUnlocked = newProgress.max_unlocked;
            L.info(`新关卡已解锁! 当前解锁至第 ${maxUnlocked} 关`);
            level = maxUnlocked + 1; // 继续闯下一关
          } else {
            // 进度未推进，说明该关可能已通关或无法推进，跳到下一关
            level++;
          }
        } else {
          L.warn(`第${level}关闯关失败`);
          level++;
          if (cleared === 0) {
            L.warn(`闯关失败且无成功记录，退出闯关循环`);
            break;
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }
      const capHit = cleared >= MAX_LEVELS_PER_DAY;
      L.ok(`闯关完成: ${cleared} 关${capHit ? ` (已达每日上限${MAX_LEVELS_PER_DAY}关)` : ""}`);
      
      // 最终进度
      const finalProgress = await getGameProgress(token);
      if (finalProgress) {
        L.info(`最终进度 - ${finalProgress.max_unlocked} 关 | ${finalProgress.total_stars || 0}星`);
      }
    } else {
      L.warn(`获取游戏进度失败`);
    }
  }

  console.log(`🔔 shanti尊享,结束`);
}

// ==================== 推送 ====================
async function sendPush(title, content) {
  const pk = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN || "";
  if (!pk) return;
  try { await axios.post("http://www.pushplus.plus/send", { token: pk, title, content }, { proxy: false }); }
  catch(e) {}
}

// ==================== 主入口 ====================
async function main() {
  console.log(`🔔 shanti尊享,开始`);

  const accounts = wxOpinion.split("&").filter(Boolean);
  if (accounts.length === 0) {
    L.fail("未配置 wx_opinion");
    console.log(`🔔 shanti尊享,结束`);
    return;
  }

  L.info(`共 ${accounts.length} 个账号`);
  const results = [];

  for (let i = 0; i < accounts.length; i++) {
    const openid = accounts[i].trim();
    if (!openid) continue;
    try {
      await processAccount(openid, i + 1);
      results.push({ i: i + 1, status: "ok" });
    } catch(e) {
      L.fail(`账号${i+1}异常: ${e.message}`);
      results.push({ i: i + 1, status: "error", msg: e.message });
    }
    if (i < accounts.length - 1) {
      L.info(`等待 3 秒...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  const ok = results.filter(r => r.status === "ok").length;
  await sendPush("shanti尊享签到",
    `共 ${accounts.length} 账号，成功 ${ok} 个\n` +
    results.map(r => `账号${r.i}: ${r.status === "ok" ? "✅ 成功" : `❌ ${r.msg||"失败"}`}`).join("\n"));

  console.log(`\n📊 完成: ${ok}/${accounts.length} 账号`);
  console.log(`🔔 shanti尊享,结束`);
}

main().catch(e => { L.fail(`脚本异常: ${e.message}`); console.log(`🔔 shanti尊享,结束`); });
