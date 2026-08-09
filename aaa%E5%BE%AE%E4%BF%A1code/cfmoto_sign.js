/**
 * Cfmoto积分签到 - 凯越摩托车社区
 * API: https://c.cfmoto.com
 *
 * 登录: POST /cfmotoservermall/user/loginByPhone/  (账密)
 * 签到: GET  /cfmotoservermall/app/integral/task/signin
 * 任务: GET  /cfmotoservermall/app/integral/task/list → PUT /app/integral/task/complete
 * 发帖: POST /jv/bbs/post/create-v5/
 * 评论: POST /jv/bbs/article/comment-v1/
 * 点赞: POST /jv/bbs/post/thumbs_up/{postId}
 * 帖子列表: GET /jv/bbs/post/list-v6/
 *
 * 任务机制 (HAR逆向 + 2026-08-09 实测结论):
 *   detail=8  签到任务   → signIn 仅打卡(返回连续天数, 不发分);
 *                          必须再 completeTask(8) 才到账 +2 积分。
 *                          幂等: 重复标记返回 {code:500,"任务已完成!"}, 不重复发分。
 *   detail=11 每日发帖   → 发帖3次后服务端自动推进 state=1
 *   detail=12 每日评论   → 评论3次后服务端自动推进 state=1
 *   detail=13 每日分享   → 仅标记 completeTask 完成 (无需真实行为)
 *   detail=15 每日点赞   → 点赞3次后服务端自动推进 state=1
 *
 * 【风控】c.cfmoto.com 有严格频率限流: 短时间连发(约4次)即被 WAF 黑洞,
 *   不返回任何响应直到客户端超时(HTTP 000 / ECONNABORTED), 冷却约25s恢复。
 *   与 User-Agent / 请求头无关。故全局节流 1.5s + 退避重试 8/16/25s。
 *
 * 环境变量:
 *   CFMOTO_ACCOUNTS  - JSON 数组, 每项 {phone, password}, 如:
 *                      [{"phone":"19315012646","password":"yr123123"}]
 *                      (必填, 不再硬编码)
 *   CFMOTO_SIGN_ONLY - 可选, 设为 "1" 则只做「登录+签到+领签到分+查积分」,
 *                      跳过发帖/评论/点赞/抽奖等会产生社区内容的行为任务。
 */

// 清除容器内常驻坏代理
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy'])
  delete process.env[k];

const axios = require("axios");

const API_BASE = "https://c.cfmoto.com";
const APP_NAME = "Cfmoto积分签到";

// ============= 装饰元素 =============
const ICON = {
  app:    "🏍️",
  acc:    "👤",
  login:  "🔑",
  ok:     "✅",
  warn:   "⚠️",
  fail:   "❌",
  skip:   "⏭️",
  task:   "📋",
  post:   "📝",
  comment:"💬",
  like:   "👍",
  share:  "📤",
  sign:   "🗓️",
  coin:   "💰",
  device: "📱",
  delay:  "⏱",
  done:   "🏁",
  lottery:"🎰",
  prize:  "🎁",
  line:   "━".repeat(48),
};
const L = {
  ok:    (m) => console.log(`  ${ICON.ok} ${m}`),
  fail:  (m) => console.log(`  ${ICON.fail} ${m}`),
  info:  (m) => console.log(`  ℹ️  ${m}`),
  warn:  (m) => console.log(`  ${ICON.warn} ${m}`),
  act:   (m) => console.log(`  🌐 ${m}`),
  line:  ()  => console.log(ICON.line),
};

// ============= 设备指纹池 (wxapp_humanize) =============
const DEVICE_POOL = [
  { brand: "Xiaomi",  model: "2201123C", market: "MI 12",         android: "13", build: "TKQ1.220829.002" },
  { brand: "Xiaomi",  model: "2304FPN6DC", market: "MI 13",        android: "14", build: "UKQ1.230804.001" },
  { brand: "Xiaomi",  model: "23116PN5BC", market: "MI 14",        android: "15", build: "AQ3A.240912.001" },
  { brand: "Redmi",   model: "23113RKC6C", market: "Redmi K70",    android: "14", build: "UKQ1.230917.001" },
  { brand: "Redmi",   model: "22101316C",  market: "Redmi Note 12",android: "13", build: "TKQ1.221114.001" },
  { brand: "HUAWEI",  model: "ALN-AL00",   market: "Mate 60",      android: "12", build: "HUAWEIALN-AL00" },
  { brand: "HUAWEI",  model: "BRA-AL00",   market: "P60",          android: "12", build: "HUAWEIBRA-AL00" },
  { brand: "OPPO",    model: "PGFM10",     market: "Find X6",      android: "14", build: "UKQ1.230924.001" },
  { brand: "vivo",    model: "V2309A",     market: "X100",         android: "14", build: "UP1A.231005.007" },
  { brand: "vivo",    model: "V2324A",     market: "X100 Pro",     android: "15", build: "AP3A.240905.015" },
  { brand: "samsung", model: "SM-S9180",   market: "Galaxy S23 Ultra", android: "14", build: "UP1A.231005.007" },
  { brand: "OnePlus", model: "PJE110",     market: "OnePlus 12",   android: "14", build: "UKQ1.230924.001" },
  { brand: "HONOR",   model: "REA-AN00",   market: "Magic6",       android: "14", build: "HONORREA-AN00" },
  { brand: "realme",  model: "RMX3888",    market: "GT5 Pro",      android: "14", build: "UKQ1.230924.001" },
];
const WECHAT_VERSIONS = [
  { ver: "8.0.49.2600", hex: "2800313A", sdk: "20240102" },
  { ver: "8.0.50.2701", hex: "2800321D", sdk: "20240206" },
  { ver: "8.0.51.2720", hex: "28003310", sdk: "20240305" },
  { ver: "8.0.52.2740", hex: "28003414", sdk: "20240402" },
  { ver: "8.0.53.2760", hex: "28003518", sdk: "20240507" },
  { ver: "8.0.54.2780", hex: "2800361C", sdk: "20240604" },
];
const CHROME_VERSIONS = ["108.0.5359.156","114.0.5735.196","119.0.6045.193",
  "120.0.6099.210","121.0.6167.178","122.0.6261.119"];

function rndHex(n) { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16); return s; }

function buildFingerprint() {
  const dev = DEVICE_POOL[Math.floor(Math.random() * DEVICE_POOL.length)];
  const wc  = WECHAT_VERSIONS[Math.floor(Math.random() * WECHAT_VERSIONS.length)];
  const cr  = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
  const net = ["WIFI","WIFI","5G","4G"][Math.floor(Math.random() * 4)];
  const lang= ["zh_CN","zh_CN","zh_TW"][Math.floor(Math.random() * 3)];
  const xweb = String(11700 + Math.floor(Math.random() * 1250));
  const mmw  = String(1800 + Math.floor(Math.random() * 8200));
  const ua = `Mozilla/5.0 (Linux; Android ${dev.android}; ${dev.market} Build/${dev.build}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${cr} Mobile Safari/537.36 XWEB/${xweb} MMWEBSDK/${wc.sdk} MMWEBID/${mmw} MicroMessenger/${wc.ver}(${wc.hex}) WeChat/arm64 Weixin NetType/${net} Language/${lang} ABI/arm64 MiniProgramEnv/android WMPF/1.2.0`;
  return { ua, brand: dev.brand, model: dev.market, android: dev.android, wechat: wc.ver };
}

// ============= 高斯抖动延迟 (Box-Muller) =============
const DELAY_PROFILE = {
  query:   [400, 1200],
  action:  [800, 2400],
  heavy:   [1000, 2800],
  think:   [700, 2000],
  account: [3000, 8000],
  default: [500, 1500],
};

function gaussDelay(mean, std, minv, maxv) {
  let u = 0; while (u === 0) u = Math.random();
  let v = 0; while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(minv, Math.min(maxv, mean + z * std));
}

function humanDelay(kind) {
  const [minv, maxv] = DELAY_PROFILE[kind] || DELAY_PROFILE.default;
  const mean = (minv + maxv) / 2;
  const std  = (maxv - minv) / 4;
  const ms = Math.round(gaussDelay(mean, std, minv, maxv));
  if (process.env.CFMOTO_DEBUG_DELAY === "1") console.log(`  ${ICON.delay} 延迟(${kind}) ~${ms}ms`);
  return new Promise(r => setTimeout(r, ms));
}

// ============= 随机内容池 =============
const POST_CONTENTS = [
  "摩旅路上，风景是最好的陪伴 🏍️","周末骑出去，给心灵放个假","凯越品质，值得信任",
  "摩托车就是我的第二个家","骑行是一种生活态度","风和自由，在路上","今天的骑行很愉快",
  "凯越骑士团，出发！","骑士精神，永不止步","周末不骑车，等于白过","凯越带我环游世界",
  "骑行让我自由","每一次出发都是新的开始","凯越品质，一路相伴","骑遇更好的自己",
];

const COMMENT_CONTENTS = [
  "棒","支持","顶","好看","厉害","不错","666","学习了","有意思","凯越不错",
  "喜欢","羡慕了","太帅了","赞一个","支持凯越","很实用","收藏了","期待","加油","摩旅愉快",
  "兄弟威武","这才是生活","凯越YYDS","太酷了","羡慕","一起骑","凯越牛逼","帅爆了","太棒了",
  "支持国货","凯越品质","骑出精彩","一路平安","好帖子","学到了","凯越加油","骑士精神",
];

// ============= 账号加载 =============
function loadAccounts() {
  if (!process.env.CFMOTO_ACCOUNTS) {
    console.log(`${ICON.fail} CFMOTO_ACCOUNTS 环境变量未设置`);
    console.log(`  示例: CFMOTO_ACCOUNTS='[{"phone":"19315012646","password":"yr123123"}]'`);
    process.exit(1);
  }
  try { return JSON.parse(process.env.CFMOTO_ACCOUNTS); }
  catch (e) { console.log(`${ICON.fail} CFMOTO_ACCOUNTS 解析失败: ${e.message}`); process.exit(1); }
}
const accounts = loadAccounts();

// ============= 限流防护：全局节流 + 退避重试 =============
// 【重要】c.cfmoto.com 服务端有严格频率限流：短时间连发请求会被 WAF "黑洞"处理
// —— 不返回任何响应，连接一直挂起直到客户端超时（表现为 ECONNABORTED / HTTP 000）。
// 实测：快速连发 4 次即触发；冷却约 25s 后恢复。与 User-Agent / 请求头无关。
const MIN_GAP_MS = 1500;          // 相邻请求最小间隔
const REQ_TIMEOUT = 12000;        // 单次超时（短超时快速失败，交给重试）
const RETRY_BACKOFF = [8000, 16000, 25000]; // 命中限流后的冷却退避

let _lastReqAt = 0;
async function throttle() {
  const wait = _lastReqAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastReqAt = Date.now();
}

function isThrottled(e) {
  // 限流表现：超时 / 连接被重置 / 无响应
  return e.code === "ECONNABORTED" || e.code === "ETIMEDOUT" ||
         e.code === "ECONNRESET"   || /timeout/i.test(e.message || "") ||
         !e.response;
}

// 统一请求封装：节流 + 限流退避重试
async function req(config, label = "") {
  for (let attempt = 0; attempt <= RETRY_BACKOFF.length; attempt++) {
    await throttle();
    try {
      return await axios({ timeout: REQ_TIMEOUT, ...config });
    } catch (e) {
      if (attempt < RETRY_BACKOFF.length && isThrottled(e)) {
        const cool = RETRY_BACKOFF[attempt];
        L.warn(`${label || config.url} 疑似限流，冷却 ${cool / 1000}s 后重试 (${attempt + 1}/${RETRY_BACKOFF.length})`);
        await new Promise(r => setTimeout(r, cool));
        continue;
      }
      throw e;
    }
  }
}

// 通用请求头（Accept / Origin / Referer 与真机一致，避免额外风控特征）
function commonHeaders(ua, ticket, userId, contentType) {
  const h = {
    "User-Agent": ua,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": contentType || "application/json;charset=utf-8",
    "Origin": API_BASE,
    "Referer": API_BASE + "/",
  };
  if (ticket) h["Cookie"] = `ticket=${ticket};vehicle_id=-1;user_id=${userId || ""}`;
  return h;
}

// ============= HTTP 客户端 =============
// webview 客户端：用于积分/登录/签到接口
function makeWebClient(ticket, userId) {
  const fp = buildFingerprint();
  const headers = commonHeaders(fp.ua, ticket, userId);
  return {
    get:  (path)        => req({ method: "get",  url: API_BASE + path, headers }, path),
    post: (path, data)  => req({ method: "post", url: API_BASE + path, headers, data }, path),
    put:  (path, data)  => req({ method: "put",  url: API_BASE + path, headers, data }, path),
    fp,
  };
}

// native app 客户端：用于 bbs 发帖/评论/点赞接口
function makeNativeClient(ticket, userId) {
  const dev = DEVICE_POOL[Math.floor(Math.random() * DEVICE_POOL.length)];
  const nativeUA = `MOBILE|Android|${dev.android}|KLICEN_APP|5.9.8|Dalvik/2.1.0 (Linux; U; Android ${dev.android}; ${dev.market} Build/${dev.build})|1220*2656|${rndHex(16)}|100`;
  const headers = commonHeaders(nativeUA, ticket, userId, "application/json; charset=UTF-8");
  return {
    get:  (path, params) => req({ method: "get",  url: API_BASE + path, headers, params }, path),
    post: (path, data)   => req({ method: "post", url: API_BASE + path, headers, data }, path),
    fp: { brand: dev.brand, model: dev.market, android: dev.android },
    nativeUA,
  };
}

// ============= 接口 =============

// 登录
// 【修复】原实现只带 Content-Type、无 User-Agent（axios 在 Node 下默认发 "axios/1.x"），
// 且无重试；一旦命中限流即挂起超时 → 登录失败 → 整个账号流程被跳过。
async function login(ac) {
  try {
    const res = await req({
      method: "post",
      url: API_BASE + "/cfmotoservermall/user/loginByPhone/",
      headers: commonHeaders(buildFingerprint().ua),
      data: { phone: ac.phone, password: ac.password },
    }, "登录");
    const d = res.data;
    if (d && d.code === 0 && d.data && d.data.ticket) {
      return { ticket: d.data.ticket, user_id: d.data.user_id, nickname: d.data.nickname || d.data.user_name, phone: ac.phone };
    }
    L.fail(`登录失败: ${d.msg || JSON.stringify(d).slice(0, 100)}`);
    return null;
  } catch (e) { L.fail(`登录异常: ${e.message}`); return null; }
}

// 签到
async function signIn(web) {
  try {
    const res = await web.get("/cfmotoservermall/app/integral/task/signin");
    return res.data;
  } catch (e) { return { code: -1, msg: e.message }; }
}

// 任务列表
async function taskList(web) {
  try {
    const res = await web.get("/cfmotoservermall/app/integral/task/list");
    if (res.data && res.data.code === 0) return res.data.data;
    return null;
  } catch (e) { return null; }
}

// 完成任务标记
async function completeTask(web, taskDetail) {
  try {
    const res = await web.put("/cfmotoservermall/app/integral/task/complete",
      { completeStatu: 1, taskDetail }, { timeout: 15000 });
    return res.data;
  } catch (e) { return { code: -1, msg: e.message }; }
}

// 积分信息
async function integralInfo(web) {
  try {
    const res = await web.get("/cfmotoservermall/app/user/integral/current/user/info");
    return res.data?.data || null;
  } catch (e) { return null; }
}

// 发帖
async function createPost(native, content) {
  try {
    const res = await native.post("/jv/bbs/post/create-v5/", {
      content, media_type: "TEXT", resource_list: [], tags: [],
      title: "", topic_list: [], post_vote_list: [], address: "",
      city_code: "0", is_vote: false, latitude: 0, longitude: 0,
      share_content: "", share_image: "", share_product_type: "",
      share_title: "", share_type: "", share_whether_journey: "",
    });
    return res.data;
  } catch (e) { return { code: -1, msg: e.message }; }
}

// 评论
async function commentPost(native, postId, content) {
  try {
    const res = await native.post("/jv/bbs/article/comment-v1/",
      { content, post_id: String(postId) });
    return res.data;
  } catch (e) { return { code: -1, msg: e.message }; }
}

// 点赞
async function likePost(native, postId) {
  try {
    const res = await native.post(`/jv/bbs/post/thumbs_up/${postId}`, {});
    return res.data;
  } catch (e) { return { code: -1, msg: e.message }; }
}

// 获取帖子列表（取帖子ID用于评论/点赞）
async function fetchPosts(native) {
  try {
    const res = await native.get("/jv/bbs/post/list-v6/", {
      page_num: 1, page_size: 20, refresh_time: Date.now(),
      tab_name: "RECOMMEND", version: "v5",
    });
    const list = res.data?.data?.list || [];
    return list.map(p => p.id).filter(Boolean);
  } catch (e) { return []; }
}

// ========== 抽奖接口 (native client) ==========

// 抽奖配置
async function lotteryConfig(native) {
  try {
    const res = await native.get("/jv/bbs/lottery/config/");
    return res.data;
  } catch (e) { return null; }
}

// 获取进行中的抽奖列表
async function lotteryListGoing(native) {
  try {
    const res = await native.get("/jv/bbs/lottery/listgoing/");
    if (res.data?.code === 0 && res.data?.data?.list) return res.data.data.list;
    return [];
  } catch (e) { return []; }
}

// 参与抽奖（获取抽奖码）
async function lotteryApply(native, lotteryId) {
  try {
    const res = await native.get(`/jv/bbs/lottery/${lotteryId}/apply/`);
    return res.data;
  } catch (e) { return { code: -1, msg: e.message }; }
}

// 查询抽奖详情
async function lotteryDetail(native, lotteryId) {
  try {
    const res = await native.get(`/jv/bbs/lottery/${lotteryId}/detail/`);
    return res.data;
  } catch (e) { return null; }
}

// ============= 美观日志 =============
function sectionLine(title, sub) {
  const pad = Math.max(0, 46 - (title.length || 0) - (sub?.length || 0) - (sub ? 3 : 0));
  console.log(`${ICON.line}`);
  console.log(`${ICON.app} ${title}${sub ? `｜${sub}` : ""}${"·".repeat(Math.max(1, pad))}`);
  console.log(`${ICON.line}`);
}

// ============= 账号处理 =============
async function processAccount(ac, index, stats) {
  const prefix = `${ICON.acc} 账号${index}｜${ac.phone}`;
  console.log(`\n${prefix}`);

  // 每账号独立结果容器（多账号时不会互相覆盖）
  const acct = { nickname: null, integral: null, sign: null, tasks: {}, lottery: null, failed: false, msg: "" };

  // 1. 登录
  L.act(`登录 ${ac.phone}...`);
  const lr = await login(ac);
  if (!lr) {
    L.fail(`登录失败，跳过`);
    stats.fail++;
    acct.failed = true;
    acct.msg = "登录失败";
    return acct;
  }
  L.ok(`登录成功：${lr.nickname} (userId=${lr.user_id})`);
  acct.nickname = lr.nickname;

  const web    = makeWebClient(lr.ticket, lr.user_id);
  const native = makeNativeClient(lr.ticket, lr.user_id);
  L.info(`${ICON.device} 设备指纹：${web.fp.brand} ${web.fp.model} / Android ${web.fp.android} / 微信 ${web.fp.wechat}`);

  // 2. 签到
  L.act(`${ICON.sign} 签到...`);
  const sign = await signIn(web);
  if (sign?.code === 0) {
    L.ok(`打卡成功 (连续${sign.data ?? "?"}天)`);
    acct.sign = { ok: true, days: sign.data };
  } else {
    L.warn(`打卡: ${sign?.msg || "已签到或失败"}`);
    acct.sign = { ok: false, msg: sign?.msg || "已签到或失败" };
  }
  await humanDelay("think");

  // 【关键】signin 接口仅做打卡记录，不发放积分；
  // 必须再调 completeTask(detail=8) 才真正到账签到积分（实测 +2 分）。
  // 幂等安全：重复标记返回 {code:500,msg:"任务已完成!"}，不会重复发分。
  L.act(`${ICON.coin} 领取签到积分...`);
  const signMark = await completeTask(web, 8);
  if (signMark?.code === 0) {
    L.ok(`签到积分已到账 (+2积分)`);
    acct.sign = { ...(acct.sign || {}), ok: true, award: "+2积分" };
  } else if (/已完成/.test(signMark?.msg || "")) {
    L.info(`今日签到积分已领取过`);
    acct.sign = { ...(acct.sign || {}), ok: true, award: "今日已领" };
  } else {
    L.warn(`签到积分领取失败: ${signMark?.msg || "未知"}`);
    acct.sign = { ...(acct.sign || {}), ok: false, msg: signMark?.msg || "领取失败" };
  }
  await humanDelay("think");

  // 仅签到模式：CFMOTO_SIGN_ONLY=1 时跳过发帖/评论/点赞/抽奖等行为任务
  if (process.env.CFMOTO_SIGN_ONLY === "1") {
    L.info(`${ICON.skip} 仅签到模式，跳过任务与抽奖`);
    const intgOnly = await integralInfo(web);
    if (intgOnly) {
      L.info(`当前积分: ${intgOnly.integralTotal} (可用: ${intgOnly.integralDisposable})`);
      acct.integral = intgOnly.integralTotal;
    }
    L.ok(`${ICON.done} 账号${index} 处理完成`);
    stats.ok++;
    return acct;
  }

  // 3. 任务列表
  L.act(`${ICON.task} 获取任务列表...`);
  const tasks = await taskList(web);
  if (!tasks) {
    L.warn(`任务列表获取失败，跳过后续任务`);
    const intgT = await integralInfo(web);
    if (intgT) acct.integral = intgT.integralTotal;
    stats.ok++;
    return acct;
  }

  const taskMap = {};
  for (const group of tasks) {
    for (const t of group?.appIntegralTaskVOList || []) {
      taskMap[t.taskDetail] = t;
    }
  }

  // 获取帖子列表
  const postIds = await fetchPosts(native);
  if (postIds.length === 0) {
    L.warn(`${ICON.warn} 帖子列表为空，跳过评论/点赞`);
  }

  // 4. 执行任务（每个任务完成3次实际行为）
  // detail=11: 每日发帖 (发帖3次 → 服务端自动推进 state=1)
  // detail=12: 每日评论 (评论3次 → 服务端自动推进 state=1)
  // detail=13: 每日分享 (仅标记 completeTask)
  // detail=15: 每日点赞 (点赞3次 → 服务端自动推进 state=1)
  const TASK_MAP = {
    11: { name: "每日发帖", action: "post",    complete: false },
    12: { name: "每日评论", action: "comment", complete: false },
    13: { name: "每日分享", action: "share",   complete: true  },
    15: { name: "每日点赞", action: "like",    complete: false },
  };

  for (const [detailStr, taskMeta] of Object.entries(TASK_MAP)) {
    const detail = parseInt(detailStr);
    const task   = taskMap[detail];
    if (!task) continue;

    const alreadyDone = task.state === 1;
    if (alreadyDone) {
      L.info(`${taskMeta.name} 已完成，跳过`);
      acct.tasks[detail] = { name: taskMeta.name, success: 3, total: 3, skipped: true };
      continue;
    }

    L.act(`── ${taskMeta.name} (×3) ──`);
    let successCount = 0;

    for (let i = 0; i < 3; i++) {
      const roundLabel = `第${i + 1}次`;

      if (taskMeta.action === "post") {
        const content = POST_CONTENTS[Math.floor(Math.random() * POST_CONTENTS.length)];
        L.act(`${ICON.post} 发帖 ${roundLabel}: "${content.slice(0, 20)}..."`);
        const r = await createPost(native, content);
        if (r?.code === 0) {
          L.ok(`${ICON.post} 发帖成功 ${roundLabel} (postId=${r.data?.id || "?"})`);
          successCount++;
        } else {
          L.warn(`${ICON.post} 发帖失败 ${roundLabel}: ${r?.msg || "未知"}`);
        }
        await humanDelay("heavy");

      } else if (taskMeta.action === "comment") {
        if (postIds.length === 0) { L.warn(`${ICON.comment} 无帖子可评论`); break; }
        const postId  = postIds[Math.floor(Math.random() * postIds.length)];
        const content = COMMENT_CONTENTS[Math.floor(Math.random() * COMMENT_CONTENTS.length)];
        L.act(`${ICON.comment} 评论 ${roundLabel} postId=${postId}: "${content}"`);
        const r = await commentPost(native, postId, content);
        if (r?.code === 0) {
          L.ok(`${ICON.comment} 评论成功 ${roundLabel} (commentId=${r.data?.id})`);
          successCount++;
        } else {
          L.warn(`${ICON.comment} 评论失败 ${roundLabel}: ${r?.msg || "未知"}`);
        }
        await humanDelay("heavy");

      } else if (taskMeta.action === "like") {
        if (postIds.length === 0) { L.warn(`${ICON.like} 无帖子可点赞`); break; }
        const postId = postIds[Math.floor(Math.random() * postIds.length)];
        L.act(`${ICON.like} 点赞 ${roundLabel} postId=${postId}`);
        const r = await likePost(native, postId);
        if (r?.code === 0) {
          L.ok(`${ICON.like} 点赞成功 ${roundLabel}`);
          successCount++;
        } else {
          L.warn(`${ICON.like} 点赞失败 ${roundLabel}: ${r?.msg || "未知"}`);
        }
        await humanDelay("action");

      } else if (taskMeta.action === "share") {
        L.act(`${ICON.share} 标记分享 ${roundLabel}`);
        const r = await completeTask(web, detail);
        if (r?.code === 0) {
          L.ok(`${ICON.share} 分享标记成功 ${roundLabel}`);
          successCount++;
        } else {
          L.warn(`${ICON.share} 分享标记失败 ${roundLabel}: ${r?.msg || "未知"}`);
        }
        await humanDelay("think");
      }

      await humanDelay("think");
    }

    // 对于发帖/评论/点赞，服务端自动推进任务状态，无需标记
    if (!taskMeta.complete && successCount > 0) {
      L.ok(`${taskMeta.name} 实际行为完成 ${successCount}/3 次（服务端自动推进）`);
    }

    acct.tasks[detail] = { name: taskMeta.name, success: successCount, total: 3 };
    await humanDelay("think");
  }

  // 6. 每日限时抽奖
  L.act(`${ICON.lottery} 检查限时抽奖...`);
  const cfg = await lotteryConfig(native);
  if (cfg?.data?.is_turn_on === true) {
    const list = await lotteryListGoing(native);
    const active = list.find(lt => lt.lottery_status === 3); // 进行中
    if (active) {
      L.info(`${ICON.lottery} 发现进行中的抽奖：第${active.lottery_num}期 (截止 ${active.apply_time_end})`);
      // 查询详情确认用户是否已参与
      const detail = await lotteryDetail(native, active.id);
      const alreadyApplied = detail?.data?.lottery_user_info?.is_apply === true;
      if (alreadyApplied) {
        const tickets = detail.data.lottery_user_ticket_list || [];
        const ticketStr = tickets.map(t => t.ticket_code).join(", ");
        L.info(`${ICON.skip} 已参与，当前抽奖码：${ticketStr || "无"}`);
        acct.lottery = { lotteryId: active.id, num: active.lottery_num, applied: true, tickets: ticketStr, alreadyApplied: true };
      } else {
        L.act(`${ICON.lottery} 参与抽奖 ${active.id}...`);
        const apply = await lotteryApply(native, active.id);
        if (apply?.code === 0 && apply?.data?.ticket_code) {
          const openAt = active.open_time || active.lottery_open_time || active.open_prize_time || active.apply_time_end || "未知";
          L.ok(`${ICON.prize} 参与成功！抽奖码：${apply.data.ticket_code} (开奖/截止：${openAt})`);
          acct.lottery = { lotteryId: active.id, num: active.lottery_num, ticket: apply.data.ticket_code, prize: detail?.data?.lottery_prize_list?.[0]?.prize_name || "?" };
        } else {
          L.warn(`${ICON.warn} 参与失败：${apply?.msg || "未知"}`);
          acct.lottery = { lotteryId: active.id, num: active.lottery_num, failed: true, msg: apply?.msg || "未知" };
        }
      }
    } else {
      L.info(`${ICON.skip} 当前无进行中的抽奖`);
    }
  } else {
    L.info(`${ICON.skip} 抽奖功能未开启`);
  }
  await humanDelay("think");

  // 7. 最终积分
  L.act(`${ICON.coin} 查询积分...`);
  const intg = await integralInfo(web);
  if (intg) {
    L.info(`当前积分: ${intg.integralTotal} (可用: ${intg.integralDisposable})`);
    acct.integral = intg.integralTotal;
  }

  L.ok(`${ICON.done} 账号${index} 处理完成`);
  stats.ok++;
  return acct;
}

// ============= 推送 =============
function buildReport(results, stats) {
  let report = `${ICON.app} ${APP_NAME}\n`;
  report += `${ICON.line}\n`;
  report += `${ICON.acc} 账号 ${results.length} 个｜成功 ${stats.ok}｜失败 ${stats.fail}\n`;

  const multi = results.length > 1;

  // 签到（按账号，多账号时不再互相覆盖）
  const signItems = results.filter(r => r.sign);
  if (signItems.length) {
    report += `\n${ICON.sign} 签到:\n`;
    for (const r of signItems) {
      const s = r.sign;
      const daysTxt = s.days ? ` 连续${s.days}天` : "";
      const txt = s.ok ? `${ICON.ok} 成功${daysTxt}${s.award ? ` ${s.award}` : ""}` : `${ICON.warn} ${s.msg}`;
      report += `  账号${r.i}: ${txt}\n`;
    }
  }

  const intgItems = results.filter(r => r.integral !== undefined && r.integral !== null);
  if (intgItems.length) {
    report += `\n${ICON.coin} 积分统计:\n`;
    for (const r of intgItems) {
      report += `  账号${r.i}(${r.nickname || r.phone}): ${r.integral}分\n`;
    }
  }

  // 任务（按账号）
  const taskItems = results.filter(r => r.tasks && Object.keys(r.tasks).length);
  if (taskItems.length) {
    report += `\n${ICON.task} 任务完成情况:\n`;
    for (const r of taskItems) {
      if (multi) report += `  账号${r.i}:\n`;
      for (const tk of Object.keys(r.tasks)) {
        const t = r.tasks[tk];
        report += `${multi ? "    " : "  "}${t.name}: ${t.skipped ? "已完成" : `${t.success}/${t.total}次`}\n`;
      }
    }
  }

  const lotteryItems = results.filter(r => r.lottery);
  if (lotteryItems.length) {
    report += `\n${ICON.lottery} 限时抽奖:\n`;
    for (const r of lotteryItems) {
      const lt = r.lottery;
      if (lt.alreadyApplied) {
        report += `  账号${r.i}: 已参与 第${lt.num}期 抽奖码:${lt.tickets || "无"}\n`;
      } else if (lt.ticket) {
        report += `  账号${r.i}: ✅ 参与成功 第${lt.num}期 抽奖码:${lt.ticket} 奖品:${lt.prize || "?"}\n`;
      } else if (lt.lotteryId) {
        report += `  账号${r.i}: ${ICON.warn} 参与失败 第${lt.num}期${lt.msg ? ` (${lt.msg})` : ""}\n`;
      }
    }
  }

  report += `\n${ICON.line}\n`;
  for (const r of results) {
    const st = r.status === "ok" ? ICON.ok : ICON.fail;
    const nickname = r.nickname || "";
    report += `  ${st} 账号${r.i}(${r.phone})${nickname ? ` ${nickname}` : ""} ${st === ICON.ok ? "成功" : r.msg || "失败"}`;
    if (r.err) report += ` (${r.err})`;
    report += "\n";
  }
  report += `${ICON.line}`;
  return report;
}

async function sendPush(title, content) {
  const pk = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN || "";
  if (!pk) return;
  try { await axios.post("http://www.pushplus.plus/send", { token: pk, title, content }, { timeout: 10000 }); }
  catch (e) { L.warn(`${ICON.warn} 通知发送失败（不影响执行结果）: ${e.message}`); }
}

// ============= 主入口 =============
async function main() {
  console.log(`${ICON.app} ${APP_NAME}`);
  console.log(`${ICON.acc} 共 ${accounts.length} 个账号`);
  sectionLine(APP_NAME, `${accounts.length}账号`);

  const stats = { ok: 0, fail: 0, tasks: {} };
  const results = [];

  for (let i = 0; i < accounts.length; i++) {
    const ac = accounts[i];
    try {
      const acct = (await processAccount(ac, i + 1, stats)) || {};
      results.push({
        i: i + 1,
        phone: ac.phone,
        status: acct.failed ? "error" : "ok",
        msg: acct.msg || "",
        nickname: acct.nickname || "",
        integral: acct.integral,
        sign: acct.sign,
        tasks: acct.tasks || {},
        lottery: acct.lottery || null,
      });
    } catch (e) {
      L.fail(`${ICON.acc} 账号${i + 1}(${ac.phone})异常: ${e.message}`);
      results.push({ i: i + 1, phone: ac.phone, status: "error", msg: e.message });
      stats.fail++;
    }
    if (i < accounts.length - 1) {
      L.info(`${ICON.acc} 等待账号间隔...`);
      await humanDelay("account");
    }
  }

  sectionLine("执行完成", `${stats.ok}/${accounts.length}成功`);
  L.info(`成功 ${stats.ok} 个｜失败 ${stats.fail} 个`);

  const report = buildReport(results, stats);
  console.log(`\n${report}`);
  await sendPush(APP_NAME, report);

  console.log(`\n${ICON.app} ${APP_NAME},结束`);
}

main().catch(e => {
  L.fail(`脚本异常: ${e.message}`);
  console.log(`${ICON.app} ${APP_NAME},结束`);
});
