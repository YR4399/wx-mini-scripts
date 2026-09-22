/**
 * 大物是也 微信小程序 —— WCS 登录 + 每日签到 + 任务中心
 * AppID: wx9d7354501dec9fe8   版本: 2.1.4
 * API:   https://api.dawushiye.com/api
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 【逆向结论 2026-08-09 · wxapkg(radium V1MMWX) 解密解包】
 *
 *  0) 解包要点(踩坑记录, 供后续同类包复用):
 *     V1MMWX 解密后是**标准 wxapkg**(0xBE ... 0xED 头), 但 AES 段只取前 **1023**
 *     字节有效(第 1024 字节是填充), 即
 *        payload = AES-CBC(raw[6:1030])[:1023] + XOR(raw[1030:], ord(appid[-2]))
 *     少切这 1 字节会让 1023 之后的索引整体错位, 表现为"只解出 21 个文件 / 文件头
 *     偏移 8 字节 / JSON 解不出来", 别被误导去猜什么私有索引格式。
 *
 *  1) 请求封装(services/ajax.js):
 *        baseURL       = https://api.dawushiye.com/api
 *        Content-Type  = application/json; charset=utf-8     ★ JSON, 非 form
 *        Authorization = <token>                             ★ 裸 token, 无 Bearer
 *        成功判定       = resultCode === 0, 业务数据在 body.data
 *        token 失效     = resultCode === 40001 (小程序侧会清 storage 重登)
 *        限流           = resultCode === 503 "当前在线人数过多"
 *        错误文案       = body.errorMessage
 *
 *  2) 登录链(app.js login(), 一步到位, 无需手机号):
 *     a. WCS POST /wx/code {openid, appid}                 -> data.code
 *     b. POST /Wechat/Member/CheckMemberReg  (auth:false)
 *          {appId, jsCode, introId, introOpenId}
 *        -> {token, needReg, regId}
 *        needReg=true 表示未绑手机号。实测 token 照样有效, 签到/任务/积分全部可用,
 *        只有下单等交易流程才会被拦, 所以脚本不因此中断。
 *     c. GET /Wechat/Member/GetMemberDetail                 -> 会员资料(校验 token 用)
 *     另: /Wechat/Member/RefreshSessionKey {jsCode} 仅刷新 sessionKey, 不发 token。
 *
 *  3) 签到(components/decorate/component/item72):
 *     POST /MarketingWechat/Sign/GetMiniUserSignData   (无 body)
 *       -> {isSigned(0/1), isSignRemind, signList:[{day,isSigned,isToday,
 *           isHaveAward,couponList:[{id,logId,isReceive,...}]}]}
 *     POST /MarketingWechat/Sign/MiniUserSign          (无 body)  ★ isSigned=0 才调
 *     POST /MarketingWechat/Sign/ReceiveCoupon {id, logId}  领当天签到券
 *     GET  /MarketingWechat/Sign/GetSignTaskList            签到页任务位
 *
 *  4) 任务中心(components/decorate/component/item71):
 *     POST /MarketingWechat/TaskCenter/GetMiniTaskCenterGroupList  -> 分组任务
 *     POST /MarketingWechat/TaskCenter/ReceiveTask {id}            ★ taskStatus=-1 才调
 *     GET  /MarketingWechat/TaskCenter/GetHomeTask                 首页任务位
 *     taskStatus: -1=未领取(可自动领) / 0=进行中 / 100=已完成 / 其余=不可操作
 *     ⚠️ taskType 6/52(问卷) 1(答题) 7(抽奖) 9~11/101(跳转外链或资料页) 需要真人
 *        交互或上传图片(pages/planTask 是晒单上传), 脚本只做"领取", 不伪造完成。
 *
 *  5) 积分: POST /Wechat/Integral/GetUserIntegralInfo {page,pageSize}
 *       -> {canUseIntegral(可用), freezeIntegral, toExpireIntegral,
 *           integralPageList:{total, dataList:[{note,accValue,directFlag(1=加),sheetTime}]}}
 *       实测签到奖励 note="签到奖励", accValue=2。
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 【环境变量 · 全部走项目统一约定】
 *  wx_opinion      : ★账号来源(WCS openid, & 分隔)
 *  wx_server_url   : WCS 地址
 *  wx_auth         : WCS 认证 key
 *  NICK_MAP        : 可选 昵称映射 openid:昵称&openid:昵称
 *  推送            : 统一走 std_report 双引擎(钉钉 markdown)
 *
 * token 缓存: dawu_token_cache.json (按 openid, 失效自动重登)
 * cron: 10 9 * * *
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ============ 配置 ============
const APP_NAME = "大物是也";
const APPID = "wx9d7354501dec9fe8";
const HOST = "https://api.dawushiye.com/api";
const WCS = process.env.wx_server_url || "http://host.docker.internal:18788";
const WCS_AUTH = process.env.wx_auth || "";
const ACCOUNTS = (process.env.wx_opinion || "").split("&").map((s) => s.trim()).filter(Boolean);
const CACHE_FILE = path.join(__dirname, "dawu_token_cache.json");

const UA =
  "Mozilla/5.0 (Linux; Android 14; 23127PN0CC Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.107 Mobile Safari/537.36 XWEB/1300233 MMWEBSDK/20241202 MMWEBID/2846 MicroMessenger/8.0.56.2800(0x28003837) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android";

// 逆向自 services/ajax.js 的默认请求头
const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "User-Agent": UA,
  Referer: `https://servicewechat.com/${APPID}/26/page-frame.html`,
};

// ============ 昵称映射 ============
const NICK_MAP = {};
(process.env.NICK_MAP || "").split("&").forEach((pair) => {
  const i = pair.indexOf(":");
  if (i > 0) NICK_MAP[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
});
const nickOf = (openid, idx) => NICK_MAP[openid] || `账号${idx + 1}`;
const mask = (s) => (!s ? "" : String(s).length <= 8 ? String(s) : `${String(s).slice(0, 4)}****${String(s).slice(-4)}`);

// ============ 工具 ============
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 高斯抖动延迟, 比均匀随机更像真人节奏
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

async function api(pathname, { method = "POST", body = null, token = "" } = {}) {
  const headers = { ...BASE_HEADERS };
  if (token) headers.Authorization = token;
  const opts = { method, headers };
  // GET 不带 body(与小程序 ajax.js 一致: GET 时 data 为 "null" 字符串, 后端忽略)
  if (method.toUpperCase() !== "GET") opts.body = body == null ? null : body;

  const r = await request(HOST + pathname, opts);
  const d = r.data;
  if (!d || typeof d !== "object") throw new Error(`响应异常(HTTP ${r.status}): ${String(r.raw).slice(0, 120)}`);
  if (d.resultCode === 0) return d.data;
  if (d.resultCode === 40001) throw new TokenExpired("登录态失效");
  if (d.resultCode === 503) throw new Error("当前在线人数过多，请稍后再试");
  throw new Error(d.errorMessage || `resultCode=${d.resultCode}`);
}

// ============ 登录 ============
async function login(openid) {
  const code = await getWxCode(openid);
  if (!code) return null;
  const res = await api("/Wechat/Member/CheckMemberReg", {
    body: { appId: APPID, jsCode: code, introId: null, introOpenId: null },
  });
  if (!res || !res.token) throw new Error("登录未返回 token");
  return { token: res.token, needReg: !!res.needReg };
}

/** 取可用 token: 优先缓存(用 GetMemberDetail 探活), 失效则重登 */
async function ensureToken(openid, cache) {
  const c = cache[openid] || {};
  if (c.token) {
    try {
      const detail = await api("/Wechat/Member/GetMemberDetail", { method: "GET", token: c.token });
      log(`✅ 复用缓存登录态${detail && detail.nickName ? ` (${detail.nickName})` : ""}`);
      return { token: c.token, needReg: !!c.needReg, detail };
    } catch (e) {
      if (e instanceof TokenExpired) log("ℹ️ 缓存登录态已失效, 重新登录");
      else log(`⚠️ 缓存校验异常: ${e.message}, 重新登录`);
    }
  }
  const r = await login(openid);
  if (!r) return null;
  cache[openid] = { token: r.token, needReg: r.needReg, ts: Date.now() };
  saveCache(cache);
  let detail = null;
  try {
    detail = await api("/Wechat/Member/GetMemberDetail", { method: "GET", token: r.token });
  } catch (e) {
    /* 未注册账号可能取不到 */
  }
  log(`✅ 登录成功${detail && detail.nickName ? ` (${detail.nickName})` : ""}`);
  return { token: r.token, needReg: r.needReg, detail };
}

// ============ 业务: 签到 ============
/** @returns {Promise<boolean>} 本次是否触发了新签到 */
async function doSign(token, summary) {
  let signedNow = false;
  let data;
  try {
    data = await api("/MarketingWechat/Sign/GetMiniUserSignData", { token });
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`❌ 签到状态获取失败: ${e.message}`);
    summary.push("签到: 状态获取失败");
    return false;
  }
  if (!data) {
    log("⚠️ 未开启签到活动");
    summary.push("签到: 活动未开启");
    return false;
  }

  if (data.isSigned) {
    log("ℹ️ 今日已签到");
  } else {
    signedNow = true;
    await sleep(jitter(1500, 400));
    try {
      log("🌐 请求签到...");
      await api("/MarketingWechat/Sign/MiniUserSign", { token });
      log("✅ 签到成功");
      await sleep(jitter(1200, 300));
      data = (await api("/MarketingWechat/Sign/GetMiniUserSignData", { token })) || data;
    } catch (e) {
      if (e instanceof TokenExpired) throw e;
      // 后端对重复签到直接返回 errorMessage, 视为业务成功
      if (/已签|重复/.test(e.message)) {
        log(`ℹ️ ${e.message}`);
        signedNow = false;
      } else {
        log(`❌ 签到失败: ${e.message}`);
        summary.push(`签到: 失败(${e.message})`);
        return false;
      }
    }
  }

  const list = Array.isArray(data.signList) ? data.signList : [];
  const days = list.filter((x) => x.isSigned).length;
  summary.push(`签到: ${data.isSigned ? "已完成" : "已提交"}${days ? ` 本轮${days}天` : ""}`);

  // 当日若有可领签到券, 顺手领掉
  const today = list.find((x) => x.isToday && x.isSigned && x.isHaveAward);
  if (today && Array.isArray(today.couponList)) {
    for (const cp of today.couponList) {
      if (cp.isReceive) continue;
      await sleep(jitter(1200, 300));
      try {
        await api("/MarketingWechat/Sign/ReceiveCoupon", { token, body: { id: cp.id, logId: cp.logId } });
        log(`🎁 领取签到奖励: ${cp.couponName || cp.name || cp.id}`);
        summary.push(`奖励: ${cp.couponName || cp.name || "签到券"}`);
      } catch (e) {
        if (e instanceof TokenExpired) throw e;
        log(`⚠️ 奖励领取失败: ${e.message}`);
      }
    }
  }
  return signedNow;
}

// ============ 业务: 任务中心 ============
// taskStatus 语义(逆向 + 实测): -1=未领取 0=进行中 1=可完成 100=已完成
const TASK_STATUS = { "-1": "未领取", 0: "进行中", 1: "待完成", 100: "已完成" };

/** 正常结构是 [{groupName, taskList:[...]}], 递归兜底防后端换壳 */
function flattenTasks(node, out = [], depth = 0) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    node.forEach((n) => flattenTasks(n, out, depth + 1));
    return out;
  }
  if (typeof node !== "object") return out;
  if (node.id != null && node.taskStatus !== undefined && node.name !== undefined) {
    if (!out.some((t) => t.id === node.id)) out.push(node);
    return out; // 命中任务对象后不再深挖其子字段(taskMedal/taskSchedule 会误伤)
  }
  Object.values(node).forEach((v) => {
    if (v && typeof v === "object") flattenTasks(v, out, depth + 1);
  });
  return out;
}

async function doTasks(token, summary) {
  let groups;
  try {
    groups = await api("/MarketingWechat/TaskCenter/GetMiniTaskCenterGroupList", { token });
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`⚠️ 任务列表获取失败: ${e.message}`);
    summary.push("任务: 列表获取失败");
    return;
  }

  const tasks = flattenTasks(groups);
  if (!tasks.length) {
    log("ℹ️ 暂无可用任务");
    summary.push("任务: 无");
    return;
  }
  log(`📋 任务共 ${tasks.length} 个`);
  tasks.forEach((t) => {
    const st = TASK_STATUS[String(t.taskStatus)] || `状态${t.taskStatus}`;
    log(`   · ${t.name || t.id} [${st}]${t.integral ? ` +${t.integral}积分` : ""}`);
  });

  const pending = tasks.filter((t) => Number(t.taskStatus) === -1);
  const done = tasks.filter((t) => Number(t.taskStatus) === 100).length;
  if (!pending.length) {
    log(`ℹ️ 无待领取任务${done ? ` (已完成 ${done} 个)` : ""}`);
    summary.push(`任务: 待领取0/${tasks.length}`);
  } else {
    let ok = 0;
    for (const t of pending) {
      const name = t.name || t.taskName || t.title || `任务${t.id}`;
      await sleep(jitter(1800, 500));
      try {
        await api("/MarketingWechat/TaskCenter/ReceiveTask", { token, body: { id: t.id } });
        ok++;
        log(`✅ 领取任务: ${name}`);
      } catch (e) {
        if (e instanceof TokenExpired) throw e;
        if (/已领|重复|已完成/.test(e.message)) log(`ℹ️ ${name}: ${e.message}`);
        else log(`❌ ${name}: ${e.message}`);
      }
    }
    summary.push(`任务: 领取${ok}/${pending.length}`);
  }

  // 需要真人交互(下单/问卷/答题/抽奖/上传晒单)的任务, 脚本不伪造完成, 仅提示
  const manual = tasks.filter((t) => Number(t.taskStatus) !== 100 && [1, 2, 6, 7, 15, 52].includes(Number(t.taskType)));
  if (manual.length) log(`⚠️ ${manual.length} 个任务需 App 内手动完成(下单/问卷/答题/晒单)`);

  // 首页答题 / 抽奖入口, 开启时提示(需真人交互, 不自动参与)
  try {
    const home = await api("/MarketingWechat/TaskCenter/GetHomeTask", { method: "GET", token });
    if (home && home.homeAnswer && home.homeAnswer.isShow && !home.homeAnswer.isDone) {
      log(`🎯 首页答题活动开放中 (id=${home.homeAnswer.id}), 需在 App 内完成`);
      summary.push("答题:待完成");
    }
    if (home && home.homeDraw && home.homeDraw.isShow) {
      log(`🎁 首页抽奖活动开放中 (drawId=${home.homeDraw.drawId}), 需在 App 内参与`);
      summary.push("抽奖:可参与");
    }
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
  }
}

// ============ 业务: 积分 ============
async function showIntegral(token, summary, signedNow) {
  try {
    const d = await api("/Wechat/Integral/GetUserIntegralInfo", { token, body: { page: 1, pageSize: 5 } });
    if (!d) return;
    const total = d.canUseIntegral;
    if (total != null) {
      const extra = [];
      if (d.freezeIntegral) extra.push(`冻结${d.freezeIntegral}`);
      if (d.toExpireIntegral) extra.push(`将过期${d.toExpireIntegral}`);
      log(`💰 可用积分: ${total}${extra.length ? ` (${extra.join(" ")})` : ""}`);
      summary.push(`积分: ${total}`);
    }
    const first = d.integralPageList && d.integralPageList.dataList && d.integralPageList.dataList[0];
    if (first) {
      const sign = Number(first.directFlag) === 1 ? "+" : "-";
      log(`   最近: ${first.note || first.sheetTypeStr || ""} ${sign}${first.accValue} (${first.sheetTime || ""})`);
      // 本次确实新签到 & 最近一条正是签到奖励 -> 汇总里带上到账积分
      // (不按日期比对: 实测服务端时间与本机存在数小时时差, 比日期会误判)
      if (signedNow && /签到/.test(first.note || "")) {
        const i = summary.findIndex((s) => s.startsWith("签到:"));
        if (i >= 0) summary[i] += ` ${sign}${first.accValue}积分`;
      }
    }
  } catch (e) {
    if (e instanceof TokenExpired) throw e;
    log(`⚠️ 积分查询失败: ${e.message}`);
  }
}

// ============ 单账号 ============
async function runAccount(openid, idx, cache) {
  const nick = nickOf(openid, idx);
  _setName(idx, nick);
  log(`\n========== 账号[${idx + 1}] ${nick} (${mask(openid)}) ==========`);
  const summary = [];

  let auth;
  try {
    auth = await ensureToken(openid, cache);
  } catch (e) {
    log(`❌ 登录失败: ${e.message}`);
    return `${nick}: 登录失败(${e.message})`;
  }
  if (!auth) {
    log("❌ 登录失败: 无法获取 code");
    return `${nick}: 登录失败(无法获取code)`;
  }

  if (auth.needReg) {
    // 实测: needReg 仅表示未绑手机号, 签到/任务/积分照常可用, 只影响下单等交易流程
    log("ℹ️ 该微信号未绑定手机号(不影响签到, 仅影响下单)");
  }

  const flow = async () => {
    const signedNow = await doSign(auth.token, summary);
    await sleep(jitter(2000, 600));
    await doTasks(auth.token, summary);
    await sleep(jitter(1500, 400));
    await showIntegral(auth.token, summary, signedNow);
  };

  try {
    await flow();
  } catch (e) {
    if (e instanceof TokenExpired) {
      log("ℹ️ 运行中登录态失效, 重登后重试一次");
      delete cache[openid];
      saveCache(cache);
      try {
        auth = await ensureToken(openid, cache);
        if (!auth) throw new Error("重登失败");
        summary.length = 0;
        await flow();
      } catch (e2) {
        log(`❌ 重试失败: ${e2.message}`);
        summary.push(`异常(${e2.message})`);
      }
    } else {
      log(`❌ 执行异常: ${e.message}`);
      summary.push(`异常(${e.message})`);
    }
  }

  return `${nick}: ${summary.join(" | ") || "无结果"}`;
}

// ============ 推送 ============


const { report: _stdReport } = require("./std_report");
let _rpRows = [];
let _rpApp = '大物是也签到+任务';
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


// ============ 主流程 ============
(async () => {
  log(`🔔 ${APP_NAME},开始`);

  if (!ACCOUNTS.length) {
    log("❌ 未配置环境变量 wx_opinion");
    log(`🔔 ${APP_NAME},结束`);
    return;
  }
  if (!WCS_AUTH) log("⚠️ 未配置 wx_auth, WCS 可能拒绝请求");
  log(`👥 共 ${ACCOUNTS.length} 个账号`);

  const cache = loadCache();
  const results = [];
  for (let i = 0; i < ACCOUNTS.length; i++) {
    results.push(await runAccount(ACCOUNTS[i], i, cache));
    if (i < ACCOUNTS.length - 1) {
      const w = jitter(5000, 1500);
      log(`⏳ 等待 ${(w / 1000).toFixed(1)} 秒...`);
      await sleep(w);
    }
  }
  saveCache(cache);

  log(`\n========== 汇总 ==========`);
  results.forEach((r) => log(r));
  log(`🔔 ${APP_NAME},结束`);
})();
