/**
 * 阿如玊+ 微信小程序 —— WCS 登录 + 每日积分任务
 * AppID: wx6c6fefac45365d53   API: https://arusu.cn/api/wx
 *
 * 每日动作: 领步数积分 / 团队打卡 / 点赞笔记 / 评论笔记 / 新手任务奖励确认
 *
 * 环境变量(项目统一约定):
 *   wx_opinion      ★账号来源(WCS openid, & 分隔)
 *   wx_server_url   WCS 地址
 *   wx_auth         WCS 认证 key
 *   NICK_MAP        可选 昵称映射 openid:昵称&openid:昵称
 *   PUSH_PLUS_TOKEN PushPlus 推送(可选)
 *   ARUSU_REVIEW    可选 自定义评论文案, 用 | 分隔多条(默认内置鼓励语库)
 *   ARUSU_NO_REVIEW 可选 设为 1 关闭自动评论
 *
 * token 缓存: arusu_token_cache.json (按 openid, 失效自动重登)
 * cron: 30 9 * * *
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ============ 配置 ============
const APP_NAME = "阿如玊+";
const APPID = "wx6c6fefac45365d53";
const HOST = "https://arusu.cn/api/wx";
const WCS = process.env.wx_server_url || "http://host.docker.internal:18788";
const WCS_AUTH = process.env.wx_auth || "";
const PUSH_TOKEN = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN || "";
const ACCOUNTS = (process.env.wx_opinion || "").split("&").map((s) => s.trim()).filter(Boolean);
const CACHE_FILE = path.join(__dirname, "arusu_token_cache.json");

const UA =
  "Mozilla/5.0 (Linux; Android 14; 23127PN0CC Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.107 Mobile Safari/537.36 XWEB/1300233 MMWEBSDK/20241202 MMWEBID/2846 MicroMessenger/8.0.56.2800(0x28003837) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android";

const BASE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": UA,
  Referer: `https://servicewechat.com/${APPID}/289/page-frame.html`,
};

// 任务名(逆向自 NewcomerTaskDialog 的 task_code 映射, ? 用 task_cate_value 替换)
const TASK_NAME = { 1: "完善资料", 2: "加入一个团队", 3: "点赞?条笔记", 4: "完成?天步数兑换" };

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

/** token 是 JWT, 本地解 exp 预判过期(留 5 分钟余量), 省一次探活请求 */
function jwtAlive(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
    return !p.exp || p.exp * 1000 - Date.now() > 5 * 60 * 1000;
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

async function api(pathname, { method = "GET", query = null, body = null, token = "" } = {}) {
  const headers = { ...BASE_HEADERS };
  if (token) headers.Authorization = token;
  let p = pathname;
  // 与小程序 http() 一致: GET 把参数拼进 querystring, 且不发 body
  if (query && Object.keys(query).length) {
    p += (p.includes("?") ? "&" : "?") + Object.keys(query).map((k) => `${k}=${encodeURIComponent(query[k])}`).join("&");
  }
  const opts = { method, headers };
  if (method.toUpperCase() !== "GET" && body != null) opts.body = body;

  // 网络抖动(socket hang up / ECONNRESET / 超时)自动重试一次
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
  if (d.code === 401) throw new TokenExpired("登录态失效");
  throw new Error(d.message || `code=${d.code}`);
}

// ============ 登录 ============
async function login(openid) {
  const code = await getWxCode(openid);
  if (!code) return null;
  const res = await api("/login", { method: "POST", body: { code } });
  if (!res || !res.token) throw new Error("登录未返回 token");
  return res.token;
}

/** 取可用 token: 优先缓存(JWT 本地判活 + 一次轻量探活), 失效则重登 */
async function ensureToken(openid, cache) {
  const c = cache[openid] || {};
  if (c.token && jwtAlive(c.token)) {
    try {
      const info = await api("/mpuser_info", { token: c.token });
      log(`✅ 复用缓存登录态${info && info.nickname ? ` (${info.nickname})` : ""}`);
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
  let info = null;
  try {
    info = await api("/mpuser_info", { token });
  } catch (e) {
    /* 新号可能资料为空 */
  }
  log(`✅ 登录成功${info && info.nickname ? ` (${info.nickname})` : ""}`);
  return { token, info };
}

// ============ 业务: 步数与积分领取 ============
async function claimIntegral(token, summary) {
  let step = null;
  try {
    step = await api("/step_self_info", { token });
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`⚠️ 步数信息获取失败: ${e.message}`);
  }
  if (step) {
    const goal = Number(step.today_step_goal || 0);
    const cur = Number(step.today_step || 0);
    log(`👟 今日步数 ${cur}${goal ? ` / 目标 ${goal}` : ""}  (本月达标 ${step.month_done_goal_count || 0} 天)`);
  }

  let pending;
  try {
    pending = await api("/integral_num", { token });
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`❌ 待领积分查询失败: ${e.message}`);
    summary.push("领分: 查询失败");
    return;
  }
  const num = Number((pending && pending.num) || 0);
  if (num <= 0) {
    // gap = 距离下一个兑换档还差多少步, 便于判断"是没走够"还是"已领完"
    const gap = Number((pending && pending.gap) || 0);
    log(`💤 暂无可领积分${gap > 0 ? ` (还差 ${gap} 步)` : ""}`);
    summary.push("领分: 0");
    return;
  }
  try {
    const r = await api("/integral", { method: "POST", token, body: {} });
    const got = Number((r && r.num) || num);
    log(`🎁 领取步数积分 +${got}`);
    summary.push(`领分: +${got}`);
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`❌ 积分领取失败: ${e.message}`);
    summary.push("领分: 失败");
  }
}

// ============ 业务: 团队打卡 ============
async function teamCheckin(token, summary) {
  let cur;
  try {
    cur = await api("/team_current", { token });
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`⚠️ 团队信息获取失败: ${e.message}`);
    return;
  }
  const teamId = Number((cur && cur.team_id) || 0);
  if (teamId <= 0) {
    log("🤝 未加入团队, 跳过团队打卡");
    summary.push("打卡: 无团队");
    return;
  }

  try {
    const r = await api("/team_checkin", { token });
    const sv = r && r.sports_value;
    log(`✅ 团队打卡成功${sv != null ? `, 获得 ${sv} 运动值` : ""}`);
    summary.push(`打卡: 成功${sv != null ? ` +${sv}` : ""}`);
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    // 后端对重复打卡直接返回 message, 属业务成功
    if (/已打卡|已签到|重复/.test(e.message)) {
      log(`ℹ️ ${e.message}`);
      summary.push("打卡: 今日已打卡");
    } else {
      log(`❌ 团队打卡失败: ${e.message}`);
      summary.push(`打卡: 失败(${e.message})`);
    }
  }

  // 团队一键点赞(有待赞名额才调)
  try {
    const detail = await api("/team_detail", { token, query: { team_id: teamId } });
    if (Number((detail && detail.self_star_num) || 0) > 0) {
      await sleep(jitter(1500, 400));
      const r = await api("/team_batch_star", { method: "POST", token, body: {} });
      log(`👍 团队一键点赞完成${r && r.star_num != null ? ` (${r.star_num} 人)` : ""}`);
    }
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`⚠️ 团队点赞跳过: ${e.message}`);
  }
}

// ============ 业务: 社区互动(点赞 / 评论) ============
// 积分规则(GET /integral_dict): say_star 1分/次 上限5, say_review 1分/次 上限4
// 点赞得分不稳定(非固定冷却), 多点几条才凑得满; 评论几乎每条必中, 到 4 分即封顶
const REVIEW_TEXTS = (process.env.ARUSU_REVIEW || "")
  .split("|")
  .map((x) => x.trim())
  .filter(Boolean);
const DEFAULT_REVIEWS = [
  "坚持下来很不容易，加油！",
  "每天进步一点点，很棒",
  "一起运动，互相打气～",
  "看到你的坚持很受鼓舞",
  "保持节奏，慢慢来也很好",
  "今天也是元气满满的一天",
  "运动使人快乐，继续保持",
  "记录得很用心，学习了",
];

async function getTotal(token) {
  try {
    const d = await api("/integral_total", { token });
    return d && d.total != null ? Number(d.total) : null;
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    return null;
  }
}

async function getMyId(token) {
  try {
    const d = await api("/mpuser_id", { token });
    return d && d.id ? Number(d.id) : 0;
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    return 0;
  }
}

/** 翻页收集"别人发的、我还没赞过"的笔记, 供点赞和评论共用 */
async function collectSays(token, myId, need) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 8 && out.length < need; page++) {
    let list;
    try {
      const r = await api("/say_list", { token, query: { page, size: 20, say_type: 1 } });
      list = (r && r.list) || [];
    } catch (e) {
      if (e instanceof TokenExpired) throw e;
      break;
    }
    if (!list.length) break;
    for (const x of list) {
      if (!x || !x.id || seen.has(x.id)) continue;
      if (myId && x.mpuser_id === myId) continue; // 自己的笔记点赞不计分
      seen.add(x.id);
      out.push(x);
    }
    await sleep(jitter(600, 200));
  }
  return out;
}

async function interactStar(token, summary, cands) {
  const targets = cands.filter((x) => !x.is_star).slice(0, 10);
  if (!targets.length) {
    log("ℹ️ 无可点赞的新笔记");
    summary.push("点赞: 无目标");
    return;
  }
  let got = 0;
  let done = 0;
  for (const t of targets) {
    try {
      const r = await api("/say_star", { method: "POST", token, body: { say_id: t.id } });
      got += Number((r && r.integral) || 0);
      done++;
      t.is_star = true;
    } catch (e) {
      if (e instanceof TokenExpired) throw e;
      log(`⚠️ 点赞失败(${t.id}): ${e.message}`);
    }
    if (got >= 5) break; // 已到每日上限
    await sleep(jitter(3500, 1200));
  }
  if (got > 0) {
    log(`👍 点赞 ${done} 条, +${got} 积分${got >= 5 ? " (已达每日上限)" : ""}`);
    summary.push(`点赞: +${got}`);
  } else {
    log(`ℹ️ 点赞 ${done} 条, 本次未计分(今日已达上限)`);
    summary.push("点赞: 已满");
  }
}

async function interactReview(token, summary, cands, profileOk) {
  if (process.env.ARUSU_NO_REVIEW === "1") {
    log("ℹ️ 已关闭自动评论(ARUSU_NO_REVIEW=1)");
    return;
  }
  // 实测: 资料未完善的账号评论不计分, 此时评论只会打扰社区, 直接跳过
  if (!profileOk) {
    log("ℹ️ 资料未完善, 评论不计分, 已跳过(请先在 App 内完善资料)");
    summary.push("评论: 待完善资料");
    return;
  }
  const pool = REVIEW_TEXTS.length ? REVIEW_TEXTS : DEFAULT_REVIEWS;
  const targets = cands.slice(0, 6);
  if (!targets.length) {
    log("ℹ️ 无可评论的笔记");
    summary.push("评论: 无目标");
    return;
  }
  let before = await getTotal(token);
  if (before == null) {
    log("⚠️ 积分读取失败, 跳过评论");
    return;
  }
  let got = 0;
  let done = 0;
  let miss = 0;
  const used = new Set();
  for (const t of targets) {
    let text;
    do {
      text = pool[Math.floor(Math.random() * pool.length)];
    } while (used.has(text) && used.size < pool.length);
    used.add(text);
    try {
      const r = await api("/review", { method: "POST", token, body: { say_id: t.id, text } });
      if (r === undefined || r === null) throw new Error("空响应");
      done++;
    } catch (e) {
      if (e instanceof TokenExpired) throw e;
      log(`⚠️ 评论失败(${t.id}): ${e.message}`);
      continue;
    }
    await sleep(jitter(2500, 800));
    const after = await getTotal(token);
    const delta = after != null && before != null ? after - before : 0;
    if (delta > 0) {
      got += delta;
      miss = 0;
    } else {
      miss++;
    }
    if (after != null) before = after;
    if (got >= 4 || miss >= 2) break; // 到上限或连续两条不计分就停
    await sleep(jitter(4000, 1500));
  }
  if (got > 0) {
    log(`💬 评论 ${done} 条, +${got} 积分${got >= 4 ? " (已达每日上限)" : ""}`);
    summary.push(`评论: +${got}`);
  } else {
    log(`ℹ️ 评论 ${done} 条, 本次未计分(今日已达上限)`);
    summary.push("评论: 已满");
  }
}

// ============ 业务: 新手任务 ============
async function doTasks(token, summary) {
  let data;
  try {
    data = await api("/mission_task", { token });
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`⚠️ 任务列表获取失败: ${e.message}`);
    return;
  }
  const list = (data && data.list) || [];
  if (!list.length) {
    log("ℹ️ 无新手任务");
    return;
  }

  const nameOf = (t) => (TASK_NAME[t.task_code] || `任务${t.id}`).replace("?", t.task_cate_value);
  // task_status=1(已达成) 且 complete_anim_played=0(奖励未确认) 才需要领
  const claimable = list.filter((t) => Number(t.task_status) === 1 && Number(t.complete_anim_played) === 0);
  const done = list.filter((t) => Number(t.task_status) === 1).length;

  if (!claimable.length) {
    log(`📋 新手任务 ${done}/${list.length} 已完成, 无待领奖励`);
    summary.push(`任务: ${done}/${list.length}`);
  } else {
    let ok = 0;
    for (const t of claimable) {
      await sleep(jitter(1800, 500));
      try {
        await api("/anim_mission_task", { method: "POST", token, body: { task_id: t.id } });
        ok++;
        log(`✅ 领取任务奖励: ${nameOf(t)} +${t.reward}`);
      } catch (e) {
        if (e instanceof TokenExpired) throw e;
        log(`❌ ${nameOf(t)}: ${e.message}`);
      }
    }
    summary.push(`任务: 领取${ok}/${claimable.length}`);
  }

  // 未达成的任务如实提示, 不假装能自动完成
  const pending = list.filter((t) => Number(t.task_status) !== 1);
  if (pending.length) log(`⚠️ ${pending.length} 个任务需 App 内手动完成: ${pending.map(nameOf).join("、")}`);
}

// ============ 业务: 积分汇总 ============
async function showTotal(token, summary) {
  try {
    const d = await api("/integral_total", { token });
    if (d && d.total != null) {
      log(`💰 总积分: ${d.total}`);
      summary.push(`积分: ${d.total}`);
    }
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`⚠️ 积分查询失败: ${e.message}`);
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
  const inf = auth.info || {};
  // 资料完善判定: 有地区且昵称不是系统默认的"用户XXXX"
  const profileOk = !!(inf.district && inf.nickname && !/^用户\d+$/.test(inf.nickname));
  if (inf.district) log(`👤 ${inf.nickname || nick} · ${inf.district}`);
  else log(`👤 ${inf.nickname || nick} (资料未完善)`);

  const flow = async (token) => {
    await claimIntegral(token, summary);
    await sleep(jitter(1500, 400));
    await teamCheckin(token, summary);
    await sleep(jitter(1500, 400));
    const myId = await getMyId(token);
    const cands = await collectSays(token, myId, 16);
    await interactStar(token, summary, cands);
    await sleep(jitter(1500, 400));
    await interactReview(token, summary, cands, profileOk);
    await sleep(jitter(1500, 400));
    await doTasks(token, summary);
    await sleep(jitter(1200, 300));
    await showTotal(token, summary);
  };

  try {
    await flow(auth.token);
  } catch (e) {
    if (e instanceof TokenExpired) {
      // 与小程序一致: 401 时重登一次后重放剩余流程
      log("ℹ️ 运行中登录态失效, 重新登录后重试");
      delete cache[openid];
      const again = await ensureToken(openid, cache);
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
